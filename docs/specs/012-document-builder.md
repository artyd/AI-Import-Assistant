# 012 — Document builder: contracts and invoices to Word

Status: built (2026-11-26). Not deployed yet. The directory has to be filled on prod.

## Goal

Logists put together the trade documents they send every week from parts, inside
Штурман, and download them as Word: a **bilingual contract with its specification**
(Annex No. 1) and an **invoice with its packing list**. The output has to look
exactly like the documents the team sends today, so the templates were made from
real ones, not redrawn.

## Terms (GLOSSARY)

- **Конструктор документів** (document builder): the «Документи» section of the
  sidebar.
- **Довідник** (directory): the team's companies (role seller / buyer / consignor /
  other) and goods. It is filled once and every document picks from it.
- **Знімок** (snapshot): a document keeps a copy of its parties and goods. Editing
  the directory later never rewrites a document that was already sent.

## What the user does

1. «＋ Контракт». The seller is prefilled from the directory. The user picks the
   buyer, and the number fills itself as `DDMMYYYY/<buyer suffix>` (e.g.
   `31072026/PNS`), the team's convention. The number stays editable, and «Авто»
   restores it.
2. Goods come from the catalogue («＋ Товар з каталогу») or go in as an empty row
   («＋ У каталог» saves a new one). The user types the quantity and price. Line
   totals, the contract total and the **amount in words in EN and UA** are computed.
3. Options that change the text: the goods kind in clause 1.1 (substances /
   pharmaceutical substances / custom); the consignee (the buyer or another
   company); the consignor (named, or "will be informed additionally"); Incoterms
   term, edition and place; delivery and payment days; currency USD/EUR; Ukrainian
   registration (adds a marking line in 6.4 and the reg. number in the
   specification).
4. On the right, a live preview of the filled document (mammoth HTML of the real
   .docx; header and footer omitted). Autosave runs 0.8 s after each edit.
5. «Завантажити Word» builds the .docx from the current data.
6. «Інвойс до контракту» creates the invoice + packing list from the contract:
   buyer, terms, goods, quantities, prices, the `"<No> dated <date>"` reference and
   one batch per product. The user adds the invoice number, batch numbers, gross
   weight and packages. Warnings, which never block the download, list empty
   fields and a packing-list net weight that differs from the invoiced quantity.
7. «Дублювати» copies a document with today's date (the "same as last time" case).

## Decisions (assumed 2026-11-26; the owner may change them)

- **Fill templates instead of generating documents** (docxtemplater + pizzip). The
  templates `src/docbuilder/templates/*.docx` are the team's own documents
  (eucalyptus contract 31072026/PNS, invoice AI/2026-27/081) with `{tags}` in
  place of the variable text. Fonts, the two-column EN|UA table, the header with
  place and date, the signature footer, the letterhead and the seal stay
  identical. Clauses 1–13 are fixed template text. A clause change is a template
  edit, not a code change.
- The FK variant drops clause 3.2 and renumbers 3.3→3.2. We keep one numbering:
  3.2 is always the consignor clause, which either names the consignor or says
  "will be informed additionally".
- Units are kg (the user portrait is substances).
- The invoice template carries the **PRIME FORCE letterhead and seal**, as in the
  originals. The seal can be switched off for a draft. A seller with another
  letterhead needs its own template.
- One team-wide space, not tied to a shipment, like the instruction directory.
  Shipment-scoped access rules do not apply.
- No real counterparties in git: tests use fictional companies, and the directory
  is filled on prod (UI or API).

## Not in scope (next)

- An agent tool «склади контракт/інвойс» (Штурман fills the builder from a
  shipment's documents).
- Saving the generated .docx into a shipment's files (would go through
  `shipmentChanged`).
- PDF export (needs LibreOffice on the server), templates uploaded by users,
  more document types (CMR, specification-only appendix, supplier POs).

## Code

- Backend `src/docbuilder/`: `schema.ts` (zod), `words.ts` (amount in words
  EN/UA), `format.ts`, `templateData.ts` (data → tags), `render.ts` (docx +
  preview), `fromContract.ts`, `docbuilder.routes.ts`. Tables `doc_parties`,
  `doc_products`, `doc_documents` (`schema.sql`).
- Frontend: `components/docbuilder/*`, `lib/docbuilder/{model,api}.ts`, view
  `docs` in `lib/store.ts`.
- Tests: `src/docbuilder/__tests__/*`, `frontend/lib/docbuilder/__tests__/*`,
  `frontend/e2e/docbuilder.spec.ts`.
- Rebuilding a template: open it in Word and edit the text around the tags. Keep
  each `{tag}` typed in one go (docxtemplater tolerates split runs, but typing it
  whole keeps the XML clean).
