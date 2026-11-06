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
