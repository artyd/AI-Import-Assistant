# Golden-set eval (Phase 0)

An objective, repeatable gauge of the one thing that matters: **the product never
lies.** It scores, against a labeled set of real shipments:

1. **Extraction accuracy** — per field, the pipeline's extraction vs. the values a
   pilot declarant hand-verified.
2. **Discrepancy detection** — precision / recall / F1 of the deterministic
   reconciliation (`reconcile()`) vs. the discrepancies the pilot expects.

One command, hard numbers, non-zero exit when below threshold — see MVP_PLAN.md
§"Фаза 0".

## Layout

```
eval/
  run.ts                       the runner (npm run eval:golden)
  tsconfig.json                optional strict typecheck of the runner
  golden/
    _TEMPLATE.json             documented template — copy it per shipment
    metopren.json              filled reference example (Метопрен)
  fixtures/
    metopren/invoice-packing.json   recorded extraction, used in dry-run
  samples/                     (you add) real source files for --real mode
```

Files in `golden/` starting with `_` (like `_TEMPLATE.json`) are ignored by the
runner. Every `"_comment*"` key inside a golden file is documentation, ignored too.

## Run it

```bash
npm run eval:golden                 # DRY-RUN (default) — scores against fixtures, no tokens, no DB
npm run eval:golden -- --real       # REAL extraction — calls Claude, needs ANTHROPIC_API_KEY (costs money)
npm run eval:golden -- --only metopren   # run a single shipment
```

Thresholds (exit non-zero if missed) and tolerances via env:

```bash
EVAL_EXTRACTION_MIN=0.9    # min overall extraction accuracy (default 0.9)
EVAL_F1_MIN=0.8            # min discrepancy F1 (default 0.8)
EVAL_NUM_TOLERANCE=0.01    # relative tolerance for numeric fields (default 1%)
```

**Gating:** the runner is DRY-RUN unless you pass `--real`. Without
`ANTHROPIC_API_KEY` it can only dry-run. This keeps the harness free to run in CI
and never spends tokens by accident.

## How a pilot fills in golden data

For each of 5–10 real past shipments (mix single-/multi-item, digital/scans,
bi-/tri-party — start with Метопрен):

1. Copy `golden/_TEMPLATE.json` to `golden/<shipment>.json` (no leading `_`).
2. Set `shipment_id` (unique slug), `title`, `notes`.
3. Add one entry to `documents` per document. For each:
   - `id` — a stable slug for the document.
   - `source` — for `--real` mode: `{ "file": "eval/samples/.../doc.pdf" }`
     (path relative to the repo root, or absolute) **or** `{ "text": "…" }`.
   - `fixture` — for dry-run: a recorded extraction JSON under `eval/fixtures/`.
     Easiest is to run `--real` once, eyeball the printed extraction, and save a
     trusted copy here; or hand-write it (a full `ExtractedFields` object — see
     `fixtures/metopren/invoice-packing.json`).
   - `expected` — **only the fields you verified.** Omit anything you didn't check.
     A 2-in-1 file (invoice + packing list) sets
     `"also_contains": ["packing_list"]`.
4. Fill `expected_discrepancies` — the findings `reconcile()` *should* report
   (ground truth). Each needs a `field`; `kind` (`confirmed`=🔴 / `suspected`=🟡)
   and `severity` are optional (omit to match on field alone). `[]` = clean.

### Field matching rules

| Field group | Match rule |
|---|---|
| `doc_type`, ids, names, dates, `country_of_origin`, `incoterm` | trimmed, case-insensitive equality |
| `currency` | case-insensitive |
| `hs_code` | compared on digits only |
| `total_value`, weights, `packages_count` | numeric within `EVAL_NUM_TOLERANCE` |
| `also_contains` | set equality |

Only fields present in `expected` are scored, so partial labeling is fine.

## Notes on discrepancy scoring

- Uses `reconcile()` (the pure, DB-free core of `computeDiscrepancies`) directly —
  **no Postgres required.** Documents from a shipment are fed as in-memory
  extraction objects.
- Scoring runs only when *every* document in a shipment has an extraction
  (fixture in dry-run, or a real call). If any is missing, that shipment's
  discrepancy scoring is skipped (so a missing fixture can't inflate false
  negatives) and reported as skipped.
- The Метопрен example is deliberately "clean" except for one 🟡: the HS code is
  absent from the invoice (it lives only in the customs declaration). That is the
  one deterministic finding `reconcile()` emits, so it is encoded as the single
  `expected_discrepancy` — the example passes green in dry-run.

## Typechecking the runner

`npm run typecheck` covers `src/**` only. To strict-typecheck the runner itself:

```bash
npm run typecheck:eval
```
