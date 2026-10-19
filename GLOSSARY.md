# AI Import Assistant

A workspace for a Ukrainian import specialist: one Claude agent (Штурман) reads a
shipment's documents, checks them against each other, and tracks cargo on its way.
Ukrainian UI names are in parentheses.

## Shipments and documents

**Shipment** (Постачання):
One import deal handled as a unit: its documents, parties, context and chat. Stored
as `workspaces`; REST paths say `/api/workspaces`.
_Avoid_: Workspace (in prose), order, deal

**Collection** (Збірник):
A consolidated multi-supplier cargo with its own folder skeleton (manifest,
invoices, CoO, MSDS…). Collections are analysed as a whole, not reconciled.
_Avoid_: Сборник, batch, group

**Folder skeleton**:
The fixed folder set every new shipment or collection starts with
(`01_Contract_Invoice_PackingList` … `07_Final`).
_Avoid_: Template, directory tree

**Inbox** (Інбокс):
Files that have no folder yet. Sorting files out of the inbox only suggests a
folder; the user confirms it.
_Avoid_: Unsorted, root

**Document type**:
The commercial role of a file: invoice, packing list, contract, CoO, quality
certificate (CoA), MSDS and others. One file can contain several types ("2-in-1").
_Avoid_: Category, kind

**Commercial document set**:
Invoice, packing list, contract, certificate of origin and quality certificate.
This is the set that reconciliation compares. Transport and customs papers are outside it.
_Avoid_: Doc package, paperwork

**Document version** (Версії):
Several files that are the same document at different revisions, grouped so that
they can be compared.
_Avoid_: Duplicate, copy

## Ingest

**File status**:
`queued → indexing → ready | error` on the backend. The frontend shows `ready` as
`done`. An `error` status carries an `errorReason`.
_Avoid_: State, progress

**File Markdown**:
The single Markdown transcription of a file, made once at ingest (Claude vision
for PDFs/scans/photos in 5-page windows, local converters for office files). All
later reading works from it.
_Avoid_: OCR text, parsed text, embedding

**Document section**:
A slice of File Markdown indexed for Postgres full-text search. It backs `search_documents`.
_Avoid_: Chunk, vector

**Extraction**:
The structured fields pulled from one file (parties, totals, Incoterms, line
items…), each with its own confidence. It is stored in `document_extractions` and
is the only input to every verdict.
_Avoid_: Parse result, metadata

**Unreadable file**:
A file whose extraction found nothing usable. It is shown and flagged, never
silently skipped.
_Avoid_: Failed file, empty file

## Reconciliation

**Completeness** (Комплектність):
Which required document types a shipment has and which are missing, computed by
`get_checklist`.
_Avoid_: Checklist status, coverage

**Discrepancy** (Розбіжності):
A field that disagrees between documents (invoice vs contract vs packing list).
_Avoid_: Mismatch, diff, error

**Confirmed flag** / **Suspected flag** (🔴 / 🟡):
A confirmed flag is a deterministic discrepancy backed by two source citations. A
suspected flag is uncertain and needs a human to look.
_Avoid_: Red/yellow warning, alert

**Risk** (Ризики):
A shipment-level concern derived from extractions, the drug registry and the
context (e.g. registry mismatch, missing licence).
_Avoid_: Issue, warning

**Verification** (Верифікація):
A human confirming or correcting extracted fields. It is mandatory only for fields
that are low-confidence or that decide a verdict.
_Avoid_: Review, approval

**Parties** — **Хто (виробник)**, **Через кого (посередник)**, **Кому (одержувач)**:
The manufacturer, the intermediary/trader and the final recipient of a shipment.
They are auto-filled from extractions without guessing.
_Avoid_: Sender/seller/buyer (as slot names)

**Contract mode** (двостороння / тристороння):
Bilateral (the manufacturer sells directly) or trilateral (a trader sits between
the manufacturer and the recipient).
_Avoid_: Deal type, scheme

**Shipment context**:
The facts the agent needs before giving advice (regime, product form, destination…).
**Missing context** is what is still unset; the agent asks for it instead of
assuming.
_Avoid_: Settings, profile

## Actions

**Supplier instruction** (Інструкція постачальнику):
A versioned document telling the supplier how to prepare documents for this
shipment, built in the instruction constructor.
_Avoid_: Letter, template

**Report** (Звіт для керівництва):
A one-page A4 PDF summary of a shipment for management.
_Avoid_: Summary, export

**Export**:
A ZIP of a shipment's files, put into folders by confirmed document type at the
moment of export.
_Avoid_: Download, archive

## Agent

**Штурман** (Shturman):
The single Claude agent. One conversation per chat; it works only through tools.
_Avoid_: Bot, assistant, agents (plural)

**Chat kind** (Звичайний / Постачання / Збірник):
`normal`, `supply` or `consolidated`. It decides which shipment or collection the
chat is bound to, and which tools and prompt the agent gets.
_Avoid_: Mode, channel

**Agent tool**:
A server-side function the agent may call. It returns `{ result, summary, citations }`.
_Avoid_: Function, skill, plugin

**Grounding rules**:
The four hard rules in the system prompt: check context first, use tools instead of
free reasoning, treat HS codes as advisory, never fabricate on empty data.
_Avoid_: Guardrails, policy

## Customs reference

**УКТ ЗЕД code**:
The Ukrainian customs (HS-based) commodity code. The agent proposes several
candidates. A customs specialist confirms the final one.
_Avoid_: HS code (in UI), ТН ВЭД, tariff code

**qdpro**:
The official online reference (qdpro.com.ua) for duties, VAT, restrictions and
required documents per УКТ ЗЕД code. It is the source of truth.
_Avoid_: Tariff site, customs DB

**logist-mcp**:
The internal Python service that wraps qdpro, the dual-use classifier, NBU rates
and PubChem as plain REST.
_Avoid_: MCP server (ambiguous with the public MCP)

**Static tariff base**:
The bundled JSON snapshots (`uktzed_code_db`, `hs_duty_table`, `ua_mfn`…). They are
a fallback, used only when qdpro is unreachable.
_Avoid_: Local DB, cache

**Drug registry**:
A local mirror of the Ukrainian State register of medicines (МОЗ), used to check
a registration number, manufacturer and MAH.
_Avoid_: Держреєстр (in code), drlz

**Substance**:
The default product form (an API / chemical substance). Any other form (finished
product, in-bulk, equipment) must be confirmed with the user, because it changes
the code, the regime and the required documents.
_Avoid_: Product, goods

## Consolidated analysis

**Consolidated analysis** (Аналіз збірного вантажу):
The analysis that turns a collection's spreadsheet into per-line customs value,
duty, VAT, origin checks and an XLSX. Previously LOGI-ANALYZER.
_Avoid_: LOGI-ANALYZER, calculation

**Customs value**:
The value that duty is computed on, derived from price and Incoterms.
_Avoid_: CIF (unless the term really is CIF), cost

**Needs review**:
A line marked when an estimate was used or the static base disagrees with qdpro.
_Avoid_: Warning, uncertain

**BYOK**:
A user's own AI provider key, stored encrypted. It is used only by consolidated
analysis; Штурман always runs on the server's Claude.
_Avoid_: API key (bare), custom model

## Logistics hub

**Hub** (Хаб / Карта):
The live map of cargo, ports, sea lines and routes.
_Avoid_: Map page, tracker

**Track** (Вантаж):
One tracked consignment, identified by container, B/L, AWB or parcel number. It
can stand alone or be attached to a shipment.
_Avoid_: Shipment (that is a Постачання), parcel (only one kind)

**Manual sea tracking**:
Logists update sea containers by hand. Parcels and express are tracked through
17TRACK and Нова Пошта.
_Avoid_: Auto-tracking (for sea)

**Port status**:
`ok | congested | disrupted | closed` for a port or airport, set by AI from news
and overridable by a logist.
_Avoid_: Port health

**Sea line** (Лінії):
A carrier service or corridor shown with its status and reliability.
_Avoid_: Route (that is a Маршрут)

**Route** (Маршрут):
A planned multimodal path of legs with cost, free time and plan-vs-actual.
_Avoid_: Path, itinerary

## Team sheet and calendar

**Team sheet**:
The team's Google Sheet of shipments. It is the read-only source of truth, synced
hourly through its public CSV export and never written back.
_Avoid_: Spreadsheet, Excel

**Sheet row**:
One shipment line from the team sheet. Active rows become hub tracks.
_Avoid_: Record, entry

**Calendar event** (Календар):
A planned departure, planned arrival, customs or delivery date taken from a sheet
row.
_Avoid_: Appointment

**Logist**:
The team member responsible for a sheet row, matched by name to a user.
_Avoid_: Manager, owner

**Forwarder**:
The company moving the cargo (the sheet's «Кто везет» column). It sets the
calendar colour.
_Avoid_: Carrier (that is the line/courier)

**Free time**:
The days a container may stay at port before demurrage starts (default 7).
_Avoid_: Grace period

**Attention list** (Увага):
Sheet rows that need a human: overdue, unparsed dates, odd container values.
_Avoid_: Alerts, errors

**Team note**:
A note on a sheet row that is kept in Штурман and never written to the sheet.
_Avoid_: Comment (the sheet has its own)

## Other surfaces

**News** (Новини):
RSS items in fixed rubrics. Only the newest items are kept, for 10–14 days.
_Avoid_: Feed, digest

**Notification**:
An in-app bell message (no email or push).
_Avoid_: Alert, reminder

**Public MCP**:
The open MCP endpoint at `/api/mcp`. It exposes read-only reference tools, sheet
tools and hub tools to external Claude clients.
_Avoid_: MCP (bare), API
