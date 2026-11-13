# 010 — Short, exact, correct answers (Штурман answer quality)

Status: parts A–E merged and deployed (2026-11-12/13); live eval on prod pending

## Goal

Штурман answers a declarant's question **briefly, exactly and correctly**: the
verdict in the first line, every figure traceable to a file and page, nothing
that was not asked. "Better" is measured against the previous Штурман on a fixed
answer eval, not by impression.

## Decisions (from the 2026-11-12 interview)

- Model comparison (option F) is out of scope; the chat stays on `ANTHROPIC_MODEL`.
- No ChatGPT comparison; the baseline is today's Штурман on the same cases.
- Live eval runs on prod against the TEST-* shipments, **10–15 cases max** per run
  (cost). Cases hold customer data and live only in `.local/answer-cases.json`.
- An agent drafts the cases from real chats and documents; the user approves them
  before the baseline run.
- One push to `main` at the end, after the user's OK; the user deploys.

## Parts

| Part | What | Owns |
|---|---|---|
| A — Eval | `scripts/eval-answers.mjs` scores correctness, length (words), verdict-first, a source per claim; saves a run and diffs it against the previous run. 10–15 approved cases. | `scripts/eval-answers.mjs`, `eval/answers/` |
| B — Prompt | «ЯК ВІДПОВІДАТИ» becomes short-by-default (details on request); the prompt loses repeats and contradictions, target ≤ 60 % of today's 58 KB, every grounding rule kept. | `src/agent/systemPrompt.ts` |
| C — Fact check | Before an answer reaches the user, figures/numbers/codes it states are checked deterministically against the source text the turn read; unsupported ones are fixed or marked «(висновок)». | `src/agent/loop.ts`, `src/agent/answerCheck.ts`, `src/agent/tools.ts` |
| D — Fact sheet | The documents digest gains a cross-document fact sheet: key shipment facts with file + page, the authoritative version, conflicts flagged — so simple questions are answered in one step. | `src/agent/documentsDigest.ts`, new `src/agent/factSheet.ts` |
| E — False alarms | Raise precision of the deterministic checks (golden eval) and stop repeating findings that the documents refute. | `src/reconciliation/**`, `eval/golden/**` |

Invariants from `CLAUDE.md` hold: one agent, tools only; grounding rules 1–4;
never force `tool_choice`; frozen wire contract; `shipmentChanged` on writes.

## Done

- Backend `npm run typecheck && npm test && npm run build` green; `npm run eval:golden` not worse.
- Eval on prod after deploy: correctness ≥ baseline, median answer length clearly
  shorter, zero unsupported figures on the approved cases.

## Status 2026-11-13

- A–E merged and deployed. Part E grew into a system-wide false-alarm audit:
  `docs/audits/2026-11-13-false-alarms.md` (errors 25 → 6 over 19 production
  workspaces).
- Answer rules tightened after live answers: open the files of every finding
  before «що не так», no internal keys, a repeated «навіщо?» is not an objection.
- Eval: normal chat and follow-up turns supported (`followUps`); new case
  «tulathromycin-repeat-why». The prod eval run is still to do.
