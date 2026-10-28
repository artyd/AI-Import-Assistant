# AI Import Assistant

A workspace for a Ukrainian import specialist: one Claude agent (Штурман) reads a
shipment's documents, checks them against each other, and tracks cargo on its way.
Ukrainian UI names are in parentheses.

## People

**Declarant** (декларант):
The main user of shipment reconciliation. A trading-company import specialist who
prepares the documents for customs, most often for chemical or pharma substances.
_Avoid_: Broker, operator, user (when the role matters)

**Logist** (логіст):
The team member who moves the cargo and owns sheet rows, the calendar and hub
tracks. Matched to a user by name.
_Avoid_: Manager, owner

## Shipments and documents

**Shipment** (Постачання):
One import deal handled as a unit: its documents, parties, context and chat.
_Avoid_: Workspace (in prose), order, deal, cargo

**Collection** (Збірник):
A full container (FCL) we ship to ourselves from several suppliers. It is a kind
of shipment (`kind = 'fcl'`), so it gets everything a shipment gets, and it holds
lots. It is checked per lot and as a whole (transport, manifest, consignees), and
its status is the worst lot's.
_Avoid_: Сборник, batch, group

**Lot** (Партія):
One supplier's part of a collection: that supplier's documents, its own context
(Incoterms, product category, contract mode, parties) and its own verdicts. A lot
can hold several goods. A file belongs to a lot through its folder.
_Avoid_: Batch (that is a production batch), sub-shipment, order

**Product folder** (Папка товару):
One good of a lot, as a sub-folder of the lot's folder: every document about that
good (CoA, MSDS, specification, photos). Created from the lot's invoice, packing list
or contract lines. A document about several goods sits in one folder and is *linked*
into the others.
_Avoid_: SKU folder, item folder

**Customs folder of a lot** (Митниця / постачальник):
The lot's sub-folder under the collection's «Митниця»: its invoices, packing lists,
contract, certificates of origin and marking.
_Avoid_: Docs folder

**Reading journal** (Журнал читання):
What Штурман did with each file — «Читаю…», «Прочитано…», «Кладу → …» — shown live in
the chat and kept in the Журнал tab. A collection's batch is filed only after all of
it is read.
_Avoid_: Ingest log (in UI text)

**Folder skeleton**:
The fixed set of folders that every new shipment or collection starts with.
_Avoid_: Template, directory tree

**Inbox** (Інбокс):
Files that have no folder yet. After a file is read, it is filed automatically
when its document type is recognised confidently (a collection: once the whole
upload batch is read); unrecognised files stay in the inbox. The user can always move a file by hand.
_Avoid_: Unsorted, root

**Document type**:
The commercial role of a file: invoice, packing list, contract, CoO, quality
certificate (CoA), MSDS and others. One file can contain several types ("2-in-1").
_Avoid_: Category, kind

**Commercial document set**:
Invoice, packing list, contract, certificate of origin and quality certificate.
This is the set that reconciliation compares. Transport and customs papers are
outside it.
_Avoid_: Doc package, paperwork

**Document version** (Версії):
Several files that are the same document at different revisions, grouped so that
they can be compared.
_Avoid_: Duplicate, copy

## Reading documents

**File status**:
The state a file passes through: in the queue → being read → ready, or error with
a reason.
_Avoid_: State, progress

**File Markdown**:
The single text transcription of a file, made once when the file is read. Every
later step works from it.
_Avoid_: OCR text, parsed text, embedding

**Extraction**:
The structured fields taken from one file (parties, totals, Incoterms, line
items…), each with its own confidence. Extraction is the only input to every
verdict.
_Avoid_: Parse result, metadata

**Unreadable file**:
A file whose extraction found nothing usable. It is shown and flagged, never
silently skipped.
_Avoid_: Failed file, empty file

## Reconciliation

**Verdicts**:
Everything the app concludes about a shipment from its documents — completeness,
discrepancies, risks and the pipeline status. They are always derived together,
from the same documents, never reasoned out by the agent.
_Avoid_: Checks, results, analysis (that is consolidated analysis)

**Pipeline status** (Чернетка → Документи в роботі → Документи повні → Готово до митниці):
How far a shipment's paperwork is. It only moves forward on its own; a person can
set it by hand, including the final «Готово».
_Avoid_: State, stage

**Completeness** (Комплектність):
Which required document types a shipment has and which are missing.
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
context (e.g. a registry mismatch, a missing licence).
_Avoid_: Issue, warning

**Verification** (Верифікація):
A human confirming or correcting extracted fields. It is mandatory only for fields
that are low-confidence or that decide a verdict.
_Avoid_: Review, approval

**Parties** — **Хто (виробник)**, **Через кого (посередник)**, **Кому (одержувач)**:
The manufacturer, the intermediary/trader and the final recipient of a shipment.
They are filled from extractions, never guessed.
_Avoid_: Sender/seller/buyer (as slot names)

**Contract mode** (двостороння / тристороння):
Bilateral (the manufacturer sells directly) or trilateral (a trader sits between
the manufacturer and the recipient).
_Avoid_: Deal type, scheme

**Shipment context**:
The facts the agent needs before giving advice (regime, product form,
destination…). **Missing context** is what is still unset; the agent asks for it
instead of assuming.
_Avoid_: Settings, profile

## Actions

**Supplier instruction** (Інструкція постачальнику):
A versioned document telling the supplier how to prepare the documents for this
shipment, built in the instruction constructor.
_Avoid_: Letter, template

**Report** (Звіт для керівництва):
A one-page A4 summary of a shipment for management.
_Avoid_: Summary, export

**Export**:
A ZIP of a shipment's files, arranged into folders by their confirmed document
type at the moment of export.
_Avoid_: Download, archive

## Agent

**Штурман** (Shturman):
The single Claude agent. It runs one conversation per chat and acts only through
tools.
_Avoid_: Bot, assistant, agents (plural)

**Chat kind** (Звичайний / Постачання / Збірник):
A normal chat, a chat bound to a shipment, or a chat bound to a collection. The
kind decides what the agent can see and do.
_Avoid_: Mode, channel

**Agent tool**:
A server-side action the agent may call; it answers with a result, a short
summary and source citations.
_Avoid_: Function, skill, plugin

**Grounding rules**:
The four hard rules the agent follows: check context first, use tools instead of
free reasoning, treat HS codes as advisory, never invent anything on empty data.
_Avoid_: Guardrails, policy

## Customs reference

**УКТ ЗЕД code**:
The Ukrainian customs commodity code (based on HS). The agent proposes several
candidates; a customs specialist confirms the final one.
_Avoid_: HS code (in UI), ТН ВЭД, tariff code

**qdpro**:
The official online reference for duties, VAT, restrictions and required
documents per УКТ ЗЕД code. It is the source of truth.
_Avoid_: Tariff site, customs DB

**Static tariff base**:
The bundled snapshot of codes, duties and origin data. It is a fallback, used only
when qdpro is unreachable, and the agent must say so when it falls back.
_Avoid_: Local DB, cache

**Drug registry**:
A local mirror of the Ukrainian State register of medicines (МОЗ), used to check a
registration number, the manufacturer and the MAH.
_Avoid_: Держреєстр (in code), drlz

**Substance**:
The default product form (an API / chemical substance). Any other form (finished
product, in-bulk, equipment) must be confirmed with the user, because it changes
the code, the regime and the required documents.
_Avoid_: Product, goods

## Consolidated analysis

**Consolidated analysis** (Аналіз збірного вантажу):
Turning a collection's manifest into per-line customs value, duty, VAT, origin
checks and a spreadsheet. Previously called LOGI-ANALYZER.
_Avoid_: LOGI-ANALYZER, calculation

**Customs value**:
The value that duty is computed on, derived from the price and the Incoterms.
_Avoid_: CIF (unless the term really is CIF), cost

**Needs review**:
A line where an estimate was used, or where the static tariff base disagrees with
qdpro.
_Avoid_: Warning, uncertain

**BYOK**:
A user's own AI provider key, stored encrypted. Only consolidated analysis uses
it; Штурман always runs on the server's own Claude.
_Avoid_: API key (bare), custom model

## Logistics hub

**Hub** (Хаб / Карта):
The live map of tracks, ports, sea lines and routes.
_Avoid_: Map page, tracker

**Track** (Вантаж):
One physical consignment followed by its container, B/L, AWB or parcel number. A
track can stand alone or be attached to a shipment.
_Avoid_: Shipment (that is a Постачання), cargo, parcel (only one kind)

**Manual sea tracking**:
Logists update sea containers by hand. Parcels and express shipments are tracked
automatically through carrier services.
_Avoid_: Auto-tracking (for sea)

**Port status**:
Ok, congested, disrupted or closed, for a port or an airport. It is set from the
news and can be overridden by a logist.
_Avoid_: Port health

**Sea line** (Лінії):
A carrier service or corridor, shown with its status and reliability.
_Avoid_: Route (that is a Маршрут)

**Route** (Маршрут):
A planned multimodal path of legs, with cost, free time and plan-vs-actual.
_Avoid_: Path, itinerary

## Team sheet and calendar

**Team sheet**:
The team's Google Sheet of shipments. It is the read-only source of truth, synced
hourly and never written back.
_Avoid_: Spreadsheet, Excel

**Sheet row**:
One shipment line in the team sheet. Active rows become hub tracks.
_Avoid_: Record, entry

**Calendar event** (Календар):
A planned departure, planned arrival, customs date or delivery date taken from a
sheet row.
_Avoid_: Appointment

**Forwarder**:
The company moving the cargo (the sheet's «Кто везет» column). It sets the
calendar colour.
_Avoid_: Carrier (that is the line or the courier)

**Free time**:
The days a container may stay at port before demurrage starts.
_Avoid_: Grace period

**Attention list** (Увага):
Sheet rows that need a human: overdue, with unparsed dates, or with odd container
values.
_Avoid_: Alerts, errors

**Team note**:
A note on a sheet row that is kept in Штурман and never written to the sheet.
_Avoid_: Comment (the sheet has its own)

## Other surfaces

**News** (Новини):
RSS items in fixed rubrics. Only the newest items are kept, for about two weeks.
_Avoid_: Feed, digest

**Notification**:
An in-app bell message. There is no email or push.
_Avoid_: Alert, reminder

**Public MCP**:
The open endpoint through which external Claude clients use Штурман's read-only
reference, sheet and hub tools.
_Avoid_: MCP (bare), API
