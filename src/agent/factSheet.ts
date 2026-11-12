import { baseNameKey, versionHints } from '../documents/fileHints.js';
import { incotermCode } from '../reconciliation/reconcile.js';

/**
 * «ФАКТИ ПОСТАВКИ» — a cross-document fact sheet of the shipment, built only from
 * the fields already extracted at ingest. Pure and deterministic: no SQL, no LLM.
 *
 * - For each fact the authoritative document is chosen (not a copy / draft /
 *   translation, newest version, the document type that normally owns the fact).
 * - Values that differ in other documents are SHOWN as «конфлікт: X (файл A) vs
 *   Y (файл B)» and never decided: verdicts stay with get_discrepancies (ADR-0003).
 * - A key fact no document gives is listed under «немає даних».
 */

export interface FactDoc {
  name: string;
  fields: Record<string, unknown>;
  version?: number | null;
  /** ISO timestamp; breaks ties between equal versions (newer wins). */
  createdAt?: string | null;
  /** FCL: the lot the file sits in. */
  lotId?: string | null;
}

export interface FactContext {
  /** Declared on the shipment card (workspaces / lots). */
  incotermIn?: string | null;
  incotermOut?: string | null;
}

export interface FactLot extends FactContext {
  id: string;
  name: string;
  supplier?: string | null;
}

interface Candidate {
  value: string;
  /** Comparison key — equal keys are the same value. */
  key: string;
  source: string;
}

export interface Fact {
  label: string;
  chosen: Candidate;
  conflicts: Candidate[];
}

export interface FactSheet {
  facts: Fact[];
  /** Pre-rendered lines: incoterms, documents, containers, goods. */
  incoterms: string[];
  documents: string[];
  containers: string[];
  goods: string[];
  missing: string[];
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v.replace(',', '.')))) return Number(v.replace(',', '.'));
  return null;
};
const clip = (s: string, n = 90): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const recordOf = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// ── authority ───────────────────────────────────────────────────────────────

/** Name-based hints that make a file a weaker source than an original. */
const WEAK: { hint: string; tag: string }[] = [
  { hint: 'копія (COPY)', tag: 'копія' },
  { hint: 'чернетка/draft', tag: 'чернетка' },
  { hint: 'переклад (не оригінал)', tag: 'переклад' },
  { hint: 'шаблон/бланк', tag: 'шаблон' },
  { hint: 'ймовірно повторне завантаження (у назві «(N)»)', tag: 'дублікат' },
];

/** Lower = weaker-source penalty; 0 for an original / unmarked file. */
function weakness(doc: FactDoc): { penalty: number; tags: string[] } {
  const hints = versionHints(doc.name);
  const tags = WEAK.filter((w) => hints.includes(w.hint)).map((w) => w.tag);
  return { penalty: tags.length, tags };
}

/** Of several versions of the same document (same base name) only the newest is a source. */
export function currentVersions(docs: FactDoc[]): FactDoc[] {
  const best = new Map<string, FactDoc>();
  for (const d of docs) {
    const k = `${baseNameKey(d.name)}|${str(d.fields.doc_type) ?? ''}`;
    const cur = best.get(k);
    if (!cur || (d.version ?? 1) > (cur.version ?? 1)) best.set(k, d);
  }
  return docs.filter((d) => [...best.values()].includes(d));
}

const typeOf = (d: FactDoc): string => str(d.fields.doc_type) ?? 'other';

function rankDocs(docs: FactDoc[], prefer: string[]): FactDoc[] {
  const idx = (d: FactDoc): number => {
    const i = prefer.indexOf(typeOf(d));
    return i === -1 ? prefer.length : i;
  };
  return [...docs].sort(
    (a, b) =>
      weakness(a).penalty - weakness(b).penalty ||
      idx(a) - idx(b) ||
      (b.version ?? 1) - (a.version ?? 1) ||
      (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
  );
}

function sourceOf(doc: FactDoc, field: string): string {
  const { tags } = weakness(doc);
  const page = num(recordOf(doc.fields.field_pages)[field]);
  return `${doc.name}${page ? `, стор. ${page}` : ''}${tags.length ? `, ${tags.join('/')}` : ''}`;
}

// ── scalar facts ────────────────────────────────────────────────────────────

type Kind = 'text' | 'num' | 'incoterm';
interface Def {
  label: string;
  field: string;
  kind: Kind;
  prefer: string[];
  unit?: string;
}

const DEFS: Def[] = [
  { label: 'продавець', field: 'seller', kind: 'text', prefer: ['invoice', 'contract', 'packing_list'] },
  { label: 'покупець', field: 'buyer', kind: 'text', prefer: ['invoice', 'contract', 'packing_list'] },
  { label: 'одержувач', field: 'consignee_name', kind: 'text', prefer: ['contract', 'transport'] },
  { label: 'вага нетто', field: 'net_weight_kg', kind: 'num', unit: 'кг', prefer: ['packing_list', 'invoice'] },
  { label: 'вага брутто', field: 'gross_weight_kg', kind: 'num', unit: 'кг', prefer: ['packing_list', 'transport', 'invoice'] },
  { label: 'місць', field: 'packages_count', kind: 'num', prefer: ['packing_list', 'transport', 'invoice'] },
  { label: 'країна походження', field: 'country_of_origin', kind: 'text', prefer: ['certificate_of_origin', 'invoice', 'contract'] },
];

function candidate(doc: FactDoc, def: Def): Candidate | null {
  const raw = doc.fields[def.field];
  if (def.kind === 'num') {
    const n = num(raw);
    if (n === null) return null;
    return { value: `${n}${def.unit ? ` ${def.unit}` : ''}`, key: String(Math.round(n * 1000) / 1000), source: sourceOf(doc, def.field) };
  }
  const s = str(raw);
  if (!s) return null;
  const key = def.kind === 'incoterm' ? (incotermCode(s) ?? s.toLowerCase()) : s.toLowerCase().replace(/[\s.,"«»'’]+/g, ' ').trim();
  return { value: clip(s), key, source: sourceOf(doc, def.field) };
}

/** First candidate in authority order is chosen; other distinct values are conflicts. */
function pickFact(label: string, cands: Candidate[]): Fact | null {
  const first = cands[0];
  if (!first) return null;
  const conflicts: Candidate[] = [];
  for (const c of cands.slice(1)) {
    if (c.key !== first.key && !conflicts.some((x) => x.key === c.key)) conflicts.push(c);
  }
  return { label, chosen: first, conflicts };
}

function intermediaryOf(docs: FactDoc[]): Candidate[] {
  const out: Candidate[] = [];
  for (const d of docs) {
    const parties = Array.isArray(d.fields.parties) ? d.fields.parties : [];
    for (const p of parties) {
      const r = recordOf(p);
      const name = str(r.name);
      if (name && /посередн|intermediar|trader|broker|agent|агент/i.test(str(r.role) ?? '')) {
        out.push({ value: clip(name), key: name.toLowerCase(), source: sourceOf(d, 'parties') });
      }
    }
  }
  return out;
}

// ── documents, containers, goods ────────────────────────────────────────────

const TRANSPORT_LABEL: Record<string, string> = {
  awb: 'AWB',
  cmr: 'CMR',
  hbl: 'B/L (HBL)',
  mbl: 'B/L (MBL)',
  transit: 'T1/транзит',
  manifest: 'маніфест',
};
const TYPE_LABEL: Record<string, string> = {
  invoice: 'інвойс',
  packing_list: 'пакувальний лист',
  contract: 'контракт',
  certificate_of_origin: 'сертифікат походження',
  quality_certificate: 'сертифікат якості',
  customs_declaration: 'МД',
};

function documentLine(d: FactDoc): string | null {
  const t = typeOf(d);
  const f = d.fields;
  const label = t === 'transport' ? (TRANSPORT_LABEL[str(f.transport_doc_kind) ?? ''] ?? 'транспортний документ') : TYPE_LABEL[t];
  if (!label) return null;
  const number =
    t === 'transport' ? str(f.transport_doc_number) : t === 'contract' ? (str(f.contract_number) ?? str(f.invoice_number)) : str(f.invoice_number);
  const date = str(f.document_date) ?? str(f.shipment_date);
  const total = t === 'invoice' ? num(f.total_value) : null;
  const money = total !== null ? `${total}${str(f.currency) ? ` ${str(f.currency)}` : ''}` : null;
  const tags = weakness(d).tags;
  const head = [label, number].filter(Boolean).join(' ');
  return `- ${head}${date ? ` від ${date}` : ''}${money ? `, ${money}` : ''} (${d.name}${tags.length ? `, ${tags.join('/')}` : ''})`;
}

function containersOf(docs: FactDoc[]): string[] {
  const seen = new Map<string, string>();
  for (const d of docs) {
    const list = Array.isArray(d.fields.container_numbers) ? d.fields.container_numbers : [];
    for (const c of list) {
      const n = str(c);
      if (n && !seen.has(n.toUpperCase())) seen.set(n.toUpperCase(), d.name);
    }
  }
  if (seen.size === 0) return [];
  const names = [...seen.keys()];
  const sources = [...new Set(seen.values())];
  return [`контейнери: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` +${names.length - 8}` : ''} (${sources.slice(0, 3).join(', ')})`];
}

interface Item {
  name: string | null;
  hs_code: string | null;
  quantity: number | null;
  unit: string | null;
  batch_no: string | null;
}

function itemsOf(d: FactDoc): Item[] {
  const raw = d.fields.line_items_brief ?? d.fields.line_items;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => recordOf(x))
    .map((r) => ({
      name: str(r.name) ?? str(r.product_name) ?? str(r.description),
      hs_code: str(r.hs_code),
      quantity: num(r.quantity),
      unit: str(r.unit),
      batch_no: str(r.batch_no),
    }))
    .filter((i) => i.name || i.quantity !== null);
}

const MAX_GOODS = 8;
function goodsOf(docs: FactDoc[]): string[] {
  const holder = rankDocs(docs, ['invoice', 'packing_list']).find((d) => itemsOf(d).length > 0);
  if (!holder) return [];
  const items = itemsOf(holder);
  const total = num(holder.fields.line_items_count) ?? items.length;
  const out = [`позиції (${sourceOf(holder, 'line_items')}, ${total}):`];
  for (const [i, it] of items.slice(0, MAX_GOODS).entries()) {
    const qty = it.quantity !== null ? `${it.quantity}${it.unit ? ` ${it.unit}` : ''}` : null;
    out.push(
      `${i + 1}) ${[clip(it.name ?? '—', 60), it.hs_code ? `HS ${it.hs_code}` : null, qty, it.batch_no ? `партія ${it.batch_no}` : null]
        .filter(Boolean)
        .join('; ')}`,
    );
  }
  if (total > MAX_GOODS) out.push(`… ще ${total - MAX_GOODS} поз.`);
  return out;
}

// ── build ───────────────────────────────────────────────────────────────────

export function buildFactSheet(allDocs: FactDoc[], ctx: FactContext = {}): FactSheet {
  const docs = currentVersions(allDocs);
  const facts: Fact[] = [];

  for (const def of DEFS) {
    const cands = rankDocs(docs, def.prefer)
      .map((d) => candidate(d, def))
      .filter((c): c is Candidate => !!c);
    const f = pickFact(def.label, cands);
    if (f) facts.push(f);
  }
  const inter = pickFact('посередник', intermediaryOf(rankDocs(docs, ['contract', 'invoice'])));
  if (inter) facts.push(inter);

  // Incoterms: trilateral shipments legitimately carry two (in / out) — show both
  // and the document values; bilateral: documents + the card, conflicts shown.
  const inDecl = str(ctx.incotermIn);
  const outDecl = str(ctx.incotermOut);
  const incoDef: Def = { label: 'Incoterms', field: 'incoterm', kind: 'incoterm', prefer: ['contract', 'invoice'] };
  const incoCands = rankDocs(docs, incoDef.prefer)
    .map((d) => candidate(d, incoDef))
    .filter((c): c is Candidate => !!c);
  const incoterms: string[] = [];
  if (inDecl && outDecl) {
    incoterms.push(`Incoterms: вхідні ${inDecl}, вихідні ${outDecl} (картка поставки; трьохсторонній)`);
    const seen = new Set<string>();
    const docVals = incoCands.filter((c) => !seen.has(c.key) && !!seen.add(c.key));
    if (docVals.length) incoterms.push(`Incoterms у документах: ${docVals.map((c) => `${c.value} (${c.source})`).join('; ')}`);
  } else {
    const decl = inDecl ?? outDecl;
    if (decl) incoCands.push({ value: decl, key: incotermCode(decl) ?? decl.toLowerCase(), source: 'картка поставки' });
    const f = pickFact('Incoterms', incoCands);
    if (f) facts.push(f);
  }

  const documents = rankDocs(docs, [])
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
    .map(documentLine)
    .filter((l): l is string => !!l);

  const has = (label: string): boolean => facts.some((f) => f.label === label);
  const hasDoc = (pred: (d: FactDoc) => boolean): boolean => docs.some(pred);
  const missing: string[] = [];
  if (!has('продавець')) missing.push('продавець');
  if (!has('покупець')) missing.push('покупець');
  if (!has('Incoterms') && !(inDecl && outDecl)) missing.push('Incoterms');
  if (!has('вага нетто')) missing.push('вага нетто');
  if (!has('вага брутто')) missing.push('вага брутто');
  if (!has('місць')) missing.push('кількість місць');
  if (!has('країна походження')) missing.push('країна походження');
  if (!hasDoc((d) => typeOf(d) === 'invoice' && !!str(d.fields.invoice_number))) missing.push('№ інвойсу');
  if (!hasDoc((d) => !!str(d.fields.contract_number))) missing.push('№ контракту');
  if (!hasDoc((d) => !!str(d.fields.transport_doc_number))) missing.push('№ транспортного документа (AWB/CMR/B/L)');
  const goods = goodsOf(docs);
  if (goods.length === 0) missing.push('позиції товару');

  return { facts, incoterms, documents, containers: containersOf(docs), goods, missing };
}

// ── render ──────────────────────────────────────────────────────────────────

function factLine(f: Fact): string {
  const base = `${f.label}: ${f.chosen.value} (${f.chosen.source})`;
  if (f.conflicts.length === 0) return base;
  const vs = [f.chosen, ...f.conflicts.slice(0, 2)].map((c) => `${c.value} (${c.source})`).join(' vs ');
  return `${base}; конфлікт: ${vs}`;
}

/**
 * The sheet as lines within `maxChars`. When over, the long lists go first (goods,
 * documents, containers) and the parties / weights / conflicts / «немає даних» stay.
 */
export function renderFactSheet(sheet: FactSheet, maxChars: number): string[] {
  const core = [...sheet.facts.map(factLine), ...sheet.incoterms];
  const tail = sheet.missing.length ? [`немає даних: ${sheet.missing.join(', ')}`] : [];
  // [lines, droppable]
  const lists: { lines: string[]; head: string }[] = [
    { lines: sheet.containers, head: '' },
    { lines: sheet.documents, head: 'документи:' },
    { lines: sheet.goods, head: '' },
  ];
  const build = (): string[] => [
    ...core,
    ...lists.flatMap((l) => (l.lines.length ? [...(l.head ? [l.head] : []), ...l.lines] : [])),
    ...tail,
  ];
  const size = (ls: string[]): number => ls.join('\n').length;
  let out = build();
  // Drop from the end of the lists in order: goods → documents → containers.
  for (const idx of [2, 1, 0]) {
    const l = lists[idx]!;
    while (size(out) > maxChars && l.lines.length > 1) {
      l.lines.pop();
      if (l.lines.length > 1) l.lines[l.lines.length - 1] = `${l.lines[l.lines.length - 1]!.replace(/ …$/, '')} …`;
      out = build();
    }
    if (size(out) > maxChars && l.lines.length) {
      l.lines.length = 0;
      out = build();
    }
  }
  return out;
}

const HEADER =
  'ФАКТИ ПОСТАВКИ (з витягнутих полів, чинні версії; оригінал важливіший за копію; «конфлікт» лише показано — вердикт дає get_discrepancies):';

/**
 * The whole «ФАКТИ ПОСТАВКИ» block. With `lots` (FCL / consolidated) the facts are
 * grouped per lot, files outside any lot come under «Без партії».
 * Empty string when there are no documents.
 */
export function buildFactBlock(
  docs: FactDoc[],
  ctx: FactContext = {},
  maxChars = 3200,
  lots: FactLot[] = [],
): string {
  if (docs.length === 0) return '';
  if (lots.length === 0) {
    const lines = renderFactSheet(buildFactSheet(docs, ctx), Math.max(200, maxChars - HEADER.length - 1));
    return [HEADER, ...lines].join('\n');
  }
  const groups: { title: string; docs: FactDoc[]; ctx: FactContext }[] = lots.map((l) => ({
    title: `Партія «${l.name}»${l.supplier ? ` (${l.supplier})` : ''}`,
    docs: docs.filter((d) => d.lotId === l.id),
    ctx: l,
  }));
  const known = new Set(lots.map((l) => l.id));
  const loose = docs.filter((d) => !d.lotId || !known.has(d.lotId));
  if (loose.length) groups.push({ title: 'Без партії', docs: loose, ctx: {} });
  const active = groups.filter((g) => g.docs.length > 0);
  const per = Math.max(350, Math.floor((maxChars - HEADER.length) / Math.max(1, active.length)) - 1);
  const parts = active.map((g) => [`[${g.title}]`, ...renderFactSheet(buildFactSheet(g.docs, g.ctx), per - g.title.length - 4)].join('\n'));
  let block = [HEADER, ...parts].join('\n');
  if (block.length > maxChars) block = `${block.slice(0, maxChars)}\n…(факти скорочено)`;
  return block;
}
