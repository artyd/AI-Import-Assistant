# 012 — Document builder: contracts and invoices to Word

Status: phase 1 deployed 2026-11-26 and the prod directory is filled; phase 2 (below) built 2026-11-26.

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

## Phase 2 (2026-11-26): all three tiers from the review

**Tier 1, the MVP core**
1. **Annex to a contract** (`appendix`): «＋ Додаток» on a contract numbers itself (the highest annex
   number of that contract + 1) and copies the parties and terms. The specification starts empty. It
   prints «ANNEX No. N dated … TO THE CONTRACT No. … dated …» with five bilingual clauses (total, delivery,
   payment with the seller's bank details, consignor, «integral part»). An invoice to an annex refers to
   it as «APPENDIX No. N … TO THE CONTRACT …», which is what the MONPHARM invoice uses.
2. **Units**: kg, t, pcs, l, m² per line. One unit for the whole table goes into the headers («Q-TY, KG»,
   «PRICE PER PCS, USD»); mixed units go into each quantity cell («5 000 pcs»). The packing-list net check
   converts tonnes and skips pieces.
3. **«Перевірити»**: IBAN mod 97, SWIFT format, ЄДРПОУ control digit, УКТ ЗЕД codes (10 digits plus a
   qdpro lookup), Ukrainian registrations against the Держреєстр mirror (expired, expiring within 90
   days, not found), and duplicate numbers. Errors, warnings and passes are listed and never block.
4. **Invoice vs its contract or annex**: unknown goods, a different price, a quantity over what is left
   after the other invoices, a different buyer, currency or terms.
5. **Numbers**: «+1» suggests the next number after the latest one, keeping its series and padding
   (`2627X/0044` → `0045`). A new invoice starts with that number. A duplicate is an error in the check.

**Tier 2, time savers**
6. **«Додати з документа»**: an old contract or invoice (PDF, Word, Excel, photo) is converted to Markdown
   like an ingest, then `EXTRACTION_MODEL` copies the companies and goods it states through a tool call.
   The user ticks what to keep and sets each role. Saved entries get a note «перевірте реквізити».
7. **Shipment bridge**: «З постачання» builds a contract or invoice draft from the shipment's extracted
   fields. A party that matches a directory company is used as the snapshot. «Зберегти в постачання» puts
   the .docx into the shipment's files exactly like an upload, so the worker reads, files and reconciles it.
8. **Workflow**: draft → checked → sent. A non-draft document is locked: the form is disabled and the PUT
   returns 409. «Нова версія» copies a sent document into version + 1. Every action goes into
   `doc_document_events`, with edits collapsed to one entry per user per 10 minutes.
9. **Payment wordings** for clause 4.1 / annex clause 3: deferred N days after delivery, 100%
   prepayment, X% prepayment plus the rest after delivery, or a letter of credit.
10. **Downloads**: Word, PDF (headless LibreOffice; `fonts-liberation` keeps the Times layout), and a ZIP of
    the document with everything linked to it, in Word only or Word + PDF.

**Tier 3**
11. **Custom templates** (`doc_templates`): download the standard .docx, edit the wording or letterhead in
    Word keeping the `{tags}`, and upload it back. It is test-filled before it is stored, and the list of
    tags comes with examples. A document picks a template, and a seller's directory card names its
    invoice letterhead, which is used for invoices made from its contracts.
12. **Ukrainian видаткова накладна / рахунок на оплату** (`ua_invoice`): UAH, VAT 20 / 7 / 0 %, the amount
    in words with feminine hryvnias, basis contract, signatures. A domestic **договір поставки** needs the
    team's own text and is meant to come in as a custom template.
13. **Штурман tools**: `trade_documents_list` and `trade_document_draft` (an invoice or annex draft from a
    saved contract, only on a direct request). They are available in all three chat kinds.

## Phase 3 (2026-11-27): design pass, dropdowns

- **No stamps by the builder.** A stamp library with placement was built and withdrawn the same day: documents are stamped by a separate person, not by the logist's tool. (`doc_stamps` is dropped by `schema.sql`.) The invoice letterhead's own seal (`stamp`) predates this and is unchanged.
- **Design pass**: header with the document's stage (Чернетка → Перевірено → Відправлено) and next actions; a sticky table of contents of the form's sections with «не заповнено: N»; missing fields as chips; empty state with a card per kind; «Точно (PDF)» preview from the server.
- **Dropdowns everywhere**: `components/ui/Dropdown.tsx` (colour dot / icon / hint / count, single or multi) replaces chip rows and plain selects in the calendar, news, map and chat.

## Not in scope (next)

- PDF of a custom template laid out differently from Word (LibreOffice renders it).
- E-signature / sending by email from the builder.
- A domestic договір поставки template (needs the team's text; upload it as a custom template).

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
