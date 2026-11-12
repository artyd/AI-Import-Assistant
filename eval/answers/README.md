# Answer eval

`npm run eval:answers` asks Штурман real questions on real shipments through the
chat API and scores each answer against known findings (see the header of
`scripts/eval-answers.mjs`). Run it after every change to the prompt, the tools or
the model, and compare the average score.

- Cases reference real shipments and live in `.local/answer-cases.json`
  (gitignored). `cases.example.json` shows the format with fictional data.
- `--from-feedback` prints the answers users marked «Не так» as draft cases: add
  the expected findings and append them, so every reported mistake becomes a
  regression test.
- Auth: `TOKEN` (the browser's `localStorage.aia_token`) or `EMAIL` + `PASSWORD`.

## Scoring, runs and comparison

Per answer: correctness (share of `expect` items found), word count (`maxWords` in a
case adds a length check), verdict-first (first line is bold, no preamble), `forbid`
hits, and **figures without a source** — a number of 2+ digits (not a date, year or list
index) must have a file name (`*.pdf`, `*.xlsx`…) in the same sentence / table row.

- `--out <file>` saves the run (answers, scores, words, seconds, tool calls); default
  `.local/eval-runs/<ISO date>.json`. `--no-out` skips it.
- `--compare <old.json>` prints old → new per case and in total (correctness, words,
  figures without a source, seconds); exit code 1 if total correctness dropped.
- More than 15 cases per run is refused (cost) unless `--force`; use `--only` to narrow.
- `--help` prints usage. Pure logic: `scripts/eval-answers-lib.mjs`
  (tests: `scripts/__tests__/eval-answers-lib.spec.mjs`).
