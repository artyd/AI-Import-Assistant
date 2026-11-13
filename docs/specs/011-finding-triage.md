# 011 — Finding triage: decide, resolve, report

Status: built (2026-11-13) — deploy and acceptance on prod pending

## Goal

Штурман is a professional tool when every problem it shows can be **decided**
by the declarant and stays decided: marked «Не проблема» (excluded, with a
reason) or «Вирішено», never shown again as a problem, respected by the agent,
and counted. Next to each problem there is a way to **solve** it, and one page
reports what is open, solved and excluded, by whom and why. CI is green again.

## Terms (GLOSSARY)

- **Знахідка** (finding) — one discrepancy or risk of a shipment or lot.
- **Розбір** (triage) — the user's decision on a finding: `not_problem`
  («Не проблема», excluded) or `resolved` («Вирішено»). Absent = open.
- **Відбиток** (fingerprint) — a stable id of a finding: same finding on the same
  evidence → same fingerprint across recomputes; changed evidence (another file
  or value) → a new fingerprint, so the finding comes back.

## Decisions (assumed 2026-11-13, owner may change)

- «Не проблема» needs a reason code — `legs` «Різні плечі угоди», `version`
  «Інша версія / копія», `lots` «Різні партії / товари», `agreed` «Погоджено з
  брокером / митницею», `other` «Інше» — plus an optional note (required for
  `other`). «Вирішено» takes an optional note. «Повернути» undoes a decision.
- Decisions are shared by everyone who can open the shipment; each records who and
  when (`user_id`, `user_name`, `decided_at`).
- A triaged finding leaves every count, the status derivation (no longer an error
  that blocks «Документи повні»/«Готово до митниці») and the agent's problem list;
  it stays visible in a collapsed «Розібрано (N)» block with the reason.
- The fingerprint is
  `sha1(kind | field-or-code | lot | sorted(file_id=value of each citation))`
  (`kind` = `d` discrepancy / `r` risk; a risk uses `code | source_file_id | title`).
  The display texts (`expected`/`actual`/`detail`) are NOT part of it, so a reworded
  message keeps the decision.
- Writes go through `shipmentChanged(id, { kind: 'triage' })` (invariant).

## Data

```sql
CREATE TABLE IF NOT EXISTS finding_triage (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fingerprint  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('not_problem', 'resolved')),
  reason       TEXT CHECK (reason IN ('legs', 'version', 'lots', 'agreed', 'other')),
  note         TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',   -- what the finding said, for the report
  lot          TEXT,                       -- lot name in an FCL, else null
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, fingerprint)
);
```

## API (additive; `API_CONTRACT.md` updated with it)

- Every `Discrepancy` and `Risk` in `GET /api/workspaces/:id/discrepancies`,
  `GET /api/workspaces/:id/risks`, `GET /api/workspaces/:id/fcl` and
  `GET /api/workspaces/:id/lots/:lotId` gains
  `fingerprint: string` and `triage?: { status: 'not_problem'|'resolved', reason: string|null, note: string, user_name: string, decided_at: string }`.
- `PUT /api/workspaces/:id/findings/:fingerprint/triage` body
  `{ status: 'not_problem'|'resolved', reason?: 'legs'|'version'|'lots'|'agreed'|'other', note?: string (≤ 1000), title: string (≤ 300), lot?: string|null }`
  → `{ triage }`. 400 on `not_problem` without reason, or `other` without note.
  Works for an FCL id too (lot findings carry `lot`).
- `DELETE /api/workspaces/:id/findings/:fingerprint/triage` → 204 («Повернути»).
- `GET /api/workspaces/:id/problems-report` → `{ html: string }` — one printable
  page: open problems (with «перевірити»), solved, excluded (reason, who, when),
  notes count; FCL ids group by lot.
- Every route: `getOwnedWorkspace` → 404 on a miss; zod-validated bodies.

## Behaviour

- Verdicts: the snapshot loads the workspace's triage rows; `computeVerdicts`
  (and every lot of an FCL) sets `fingerprint` on each finding and `triage` on the
  decided ones; `deriveWorkspaceStatus` ignores triaged errors; risks built from
  triaged discrepancies inherit the triage.
- Agent: `get_discrepancies` / `get_risks` list triaged findings in a separate
  block «Розібрано користувачем» (status, reason, note); the prompt says they are
  decided — never report them as problems; mention only if asked.
- Sidebar: under every problem / «перевірити» row — «Не проблема» (reason picker +
  note), «Вирішено», «Як вирішити?», «Запитати»; under a missing checklist item —
  «Запросити» (asks in the chat for a request letter). A «Розібрано (N)» collapsed
  block lists decisions with «Повернути». Counts, lot traffic lights and the status
  caveat ignore triaged findings. «Звіт про проблеми» opens the report in a new tab
  (shipment and Збірник).
- «Як вирішити?» sends a chat question: concrete steps for this finding and, when
  the supplier must act, the text of a letter (Ukrainian + English).

## Tickets

1. Backend: table + migration, fingerprint (pure, tested), triage store, verdict
   integration (shipment + FCL lots), routes, `shipmentChanged` kind, agent tool
   output + prompt line, problems report, `API_CONTRACT.md`.
2. Frontend: types, triage actions on findings/risks, reason picker, «Розібрано»
   block, «Як вирішити?», «Запросити», counts ignore triaged, «Звіт про проблеми».
3. CI: the 4 calendar Playwright tests that fail since 2026-11-13 because of the date.

## Done

- Backend: `npm run typecheck && npm test && npm run build`, `npm run eval:golden`.
- Frontend: `npm run typecheck && npm test && npm run build`; Playwright desktop on
  a production build green (calendar included).
- On prod: decide a finding in TEST-Збірник 18 FCL → it leaves the counts and the
  agent's answer; «Повернути» brings it back; the report shows it.
