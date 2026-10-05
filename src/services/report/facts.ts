import { parseFlexibleDate } from '../../domain/dates.js';
import { isLikelyDraft, incotermCode } from '../reconcile.js';
import { sameCompany } from '../contextDerive.js';
import { formatHs } from '../instruction/format.js';

/**
 * Pure assembly of the one-page management report from already-computed inputs
 * (extractions, parties, checklist, risks). No I/O, no LLM — `collect.ts` loads
 * the inputs, `html.ts` renders the result. Every figure carries where it came
 * from so the page never shows a number we can't trace back to a document.
 */

export interface FactsDoc {
  file_name: string | null;
  doc_type: string | null;
  fields: Record<string, unknown>;
}
export interface FactsParty {
  role: string;
  company_name: string;
  country: string | null;
}
export interface FactsRisk {
  severity: 'error' | 'warning' | 'info';
  category: string;
  title: string;
  detail: string;
}
export interface FactsChecklistItem {
  requirement_key: string;
  status: 'missing' | 'received' | 'verified';
}
export interface FactsQdpro {
  code: string;
  duty: string | null;
  controls: string[];
}

export interface FactsInput {
  workspace: {
    number: string;
    status: string;
    contract_type: 'bilateral' | 'trilateral' | null;
    product_category: string | null;
    transport_mode: string | null;
  };
  responsible: string | null;
  docs: FactsDoc[];
  parties: FactsParty[];
  checklist: FactsChecklistItem[];
  risks: FactsRisk[];
  filesCount: number;
  qdpro: FactsQdpro | null;
  now: Date;
}

export interface Money {
  value: number;
  currency: string;
}

export interface ReportFacts {
  generatedAt: string; // dd.mm.yyyy
  number: string;
  responsible: string | null;
  product: {
    name: string | null;
    cas: string | null;
    form: string | null;
    quantity: number | null;
    unit: string | null;
    batch: string | null;
    manufactured: string | null;
    expiry: string | null;
  };
  chain: { role: 'sender' | 'intermediary' | 'recipient'; name: string; country: string | null }[];
  contractType: 'bilateral' | 'trilateral' | null;
  contractNumber: string | null;
  cleared: { date: string | null; declaration: string | null } | null;
  money: {
    outbound: (Money & { incoterm: string | null; place: string | null }) | null;
    inbound: Money | null;
    markupPct: number | null; // negative = sold below purchase
    customsValueUah: number | null;
    dutyUah: number | null;
    vatUah: number | null;
    dutyRatePct: number | null;
    rate: number | null;
    servicesUah: { kind: string; amountUah: number }[];
    costPerKgUah: number | null; // excl. VAT
    freightInPrice: boolean;
  };
  durations: { contractToDeclaration: number | null; shipmentToDeclaration: number | null };
  route: { stops: { name: string; note: string | null; date: string | null }[]; legs: { mode: string; ref: string | null }[] };
  shipment: { packages: number | null; grossKg: number | null };
  timeline: { date: string; label: string }[];
  classification: {
    hsCode: string | null;
    hsSource: 'qdpro' | 'МД' | 'інвойс' | null;
    duty: string | null;
    vatPct: number | null;
    controls: string[];
    controlsSource: 'qdpro' | null;
  };
  risksTop: FactsRisk[];
  counts: { errors: number; warnings: number };
  docs: { required: number; present: number; items: { label: string; ok: boolean }[]; files: number };
}

// ── helpers ────────────────────────────────────────────────────────────────
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const DAY = 24 * 60 * 60 * 1000;

function ts(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const ym = /^(\d{4})-(\d{2})$/.exec(s);
  if (ym) return Date.UTC(Number(ym[1]), Number(ym[2]) - 1, 1);
  return parseFlexibleDate(s);
}
export function fmtDate(t: number | null, withYear = true): string | null {
  if (t === null) return null;
  const d = new Date(t);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return withYear ? `${dd}.${mm}.${d.getUTCFullYear()}` : `${dd}.${mm}`;
}
function monthYear(v: unknown): string | null {
  const t = ts(v);
  if (t === null) return str(v);
  const d = new Date(t);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
}

/** Issued documents first, then input order — the same preference as reconcile. */
function ordered(docs: FactsDoc[]): FactsDoc[] {
  return docs
    .map((d, i) => ({ d, i }))
    .sort((a, b) => Number(isLikelyDraft(a.d.file_name)) - Number(isLikelyDraft(b.d.file_name)) || a.i - b.i)
    .map((x) => x.d);
}
function firstOf(docs: FactsDoc[], types: string[], key: string): unknown {
  for (const t of types) {
    for (const d of docs) if (d.doc_type === t && d.fields[key] !== null && d.fields[key] !== undefined && d.fields[key] !== '') return d.fields[key];
  }
  return null;
}

const DOC_LABEL: Record<string, string> = {
  invoice: 'Інвойс',
  packing_list: 'Пакувальний лист',
  contract: 'Контракт',
  certificate_of_origin: 'Сертифікат походження',
  quality_certificate: 'Сертифікат якості',
  customs_declaration: 'Митна декларація',
  transport: 'Транспортні документи',
  intermediary_agreement: 'Договір з посередником',
};

const MODE_ICON: Record<string, string> = { air: 'air', road: 'road', sea: 'sea', rail: 'rail', courier: 'road' };

export function buildFacts(input: FactsInput): ReportFacts {
  const docs = ordered(input.docs);
  const party = (role: string) => input.parties.find((p) => p.role === role && p.company_name.trim()) ?? null;
  const recipient = party('recipient');
  const intermediary = party('intermediary');

  // ── invoices / legs ───────────────────────────────────────────────────────
  const invoices = docs.filter((d) => d.doc_type === 'invoice');
  const outboundInv =
    (intermediary && invoices.find((d) => sameCompany(str(d.fields.seller), intermediary.company_name))) ||
    (recipient && invoices.find((d) => sameCompany(str(d.fields.buyer), recipient.company_name))) ||
    invoices[0] ||
    null;
  const inboundInv =
    input.workspace.contract_type === 'trilateral' && intermediary
      ? invoices.find((d) => d !== outboundInv && sameCompany(str(d.fields.buyer), intermediary.company_name)) ?? null
      : null;
  const moneyOf = (d: FactsDoc | null): Money | null => {
    const v = num(d?.fields.total_value);
    const c = str(d?.fields.currency);
    return v !== null && c ? { value: v, currency: c.toUpperCase() } : null;
  };
  const out = moneyOf(outboundInv);
  const inb = moneyOf(inboundInv);
  const outIncoterm = str(outboundInv?.fields.incoterm);
  const outCode = incotermCode(outIncoterm);

  // ── customs declaration ───────────────────────────────────────────────────
  const decl = docs.find((d) => d.doc_type === 'customs_declaration') ?? null;
  const customsValueUah = num(decl?.fields.customs_value_uah);
  const dutyUah = num(decl?.fields.duty_uah);
  const vatUah = num(decl?.fields.vat_uah);
  const rate = num(decl?.fields.exchange_rate);
  const declTs = ts(decl?.fields.document_date);

  // ── services billed to the importer (broker, storage; freight only if the
  //    importer pays it — under C*/D* terms it is in the seller's price) ────
  const servicesUah: { kind: string; amountUah: number }[] = [];
  for (const d of docs) {
    const kind = str(d.fields.service_kind);
    const v = num(d.fields.total_value);
    if (!kind || v === null) continue;
    const buyer = str(d.fields.buyer);
    if (recipient && buyer && !sameCompany(buyer, recipient.company_name)) continue; // billed to someone else
    const cur = (str(d.fields.currency) ?? 'UAH').toUpperCase();
    const amountUah = cur === 'UAH' || cur === 'ГРН' ? v : rate !== null && cur === out?.currency ? v * rate : null;
    if (amountUah === null) continue;
    const amt = Math.round(amountUah * 100) / 100;
    // A bill and its act of completed works describe the SAME service — count once.
    if (!servicesUah.some((x) => x.kind === kind && Math.abs(x.amountUah - amt) < 0.01)) servicesUah.push({ kind, amountUah: amt });
  }
  const freightInPrice = !!outCode && /^(C|D)/.test(outCode);

  // ── product ───────────────────────────────────────────────────────────────
  const productDocs = ['invoice', 'contract', 'packing_list', 'quality_certificate', 'customs_declaration'];
  const line0 = (outboundInv?.fields.line_items as { description?: string; quantity?: number; unit?: string }[] | undefined)?.[0];
  const quantity = num(line0?.quantity) ?? num(firstOf(docs, ['invoice', 'packing_list', 'customs_declaration'], 'net_weight_kg'));
  const unit = str(line0?.unit) ?? (quantity !== null ? 'кг' : null);
  const qtyKg = unit && /^(kg|kgs|кг)$/i.test(unit) ? quantity : num(firstOf(docs, ['customs_declaration', 'packing_list', 'invoice'], 'net_weight_kg'));

  const costBase =
    customsValueUah !== null ? customsValueUah + (dutyUah ?? 0) + servicesUah.reduce((s, x) => s + x.amountUah, 0) : null;

  // ── timeline ──────────────────────────────────────────────────────────────
  const events: { t: number; label: string }[] = [];
  const push = (t: number | null, label: string) => {
    if (t !== null && !events.some((e) => e.t === t && e.label === label)) events.push({ t, label });
  };
  const contractDoc =
    (intermediary && docs.find((d) => d.doc_type === 'contract' && sameCompany(str(d.fields.seller), intermediary.company_name))) ||
    docs.find((d) => d.doc_type === 'contract') ||
    null;
  const contractTs = ts(contractDoc?.fields.document_date);
  push(contractTs, 'контракт');
  push(ts(firstOf(docs, ['quality_certificate'], 'document_date')), 'COA, партія');
  push(ts(outboundInv?.fields.document_date ?? inboundInv?.fields.document_date), 'інвойс');
  const transportDocs = docs
    .filter((d) => d.doc_type === 'transport' && str(d.fields.transport_mode) !== 'courier')
    .map((d) => ({ d, t: ts(d.fields.shipment_date) ?? ts(d.fields.document_date) }))
    .sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity));
  for (const { d, t } of transportDocs) {
    const m = str(d.fields.transport_mode);
    push(t, m === 'air' ? 'AWB, виліт' : m === 'road' ? 'CMR' : m === 'sea' ? 'B/L' : 'перевезення');
  }
  push(declTs, 'МД');
  const courier = docs.find((d) => d.doc_type === 'transport' && str(d.fields.transport_mode) === 'courier');
  push(ts(courier?.fields.delivery_deadline ?? courier?.fields.document_date), 'доставка');
  events.sort((a, b) => a.t - b.t);
  // Merge same-day labels, keep at most 8 points.
  const timeline: { date: string; label: string }[] = [];
  for (const e of events) {
    const date = fmtDate(e.t, false)!;
    const last = timeline[timeline.length - 1];
    if (last && last.date === date) last.label = `${last.label}, ${e.label}`;
    else timeline.push({ date, label: e.label });
  }
  const firstShip = transportDocs.find((x) => x.t !== null)?.t ?? null;

  // ── route ─────────────────────────────────────────────────────────────────
  const { stops, legs } = buildRoute(
    transportDocs.map(({ d, t }) => ({
      from: str(d.fields.place_of_loading),
      to: str(d.fields.place_of_discharge),
      mode: MODE_ICON[str(d.fields.transport_mode) ?? ''] ?? 'road',
      ref: str(d.fields.transport_doc_number),
      t,
    })),
    str(courier?.fields.place_of_discharge) ?? str(firstOf(docs, ['transport', 'invoice'], 'final_destination')),
    courier ? { ref: str(courier.fields.transport_doc_number), t: ts(courier.fields.document_date) } : null,
  );

  // ── classification ───────────────────────────────────────────────────────
  const declHs = str(decl?.fields.hs_code);
  const invHs = str(firstOf(docs, ['invoice', 'packing_list'], 'hs_code'));
  const hsRaw = input.qdpro?.code ?? declHs ?? invHs;
  const hsCode = hsRaw ? formatHs(hsRaw) : null;
  const hsSource = input.qdpro ? 'qdpro' : declHs ? 'МД' : invHs ? 'інвойс' : null;
  const dutyRatePct =
    customsValueUah && dutyUah !== null ? Math.round((dutyUah / customsValueUah) * 1000) / 10 : null;
  const vatPct =
    customsValueUah && vatUah !== null ? Math.round((vatUah / (customsValueUah + (dutyUah ?? 0))) * 100) : null;

  // ── risks & documents ─────────────────────────────────────────────────────
  const rank = { error: 0, warning: 1, info: 2 } as const;
  const meaningful = input.risks.filter((r) => r.severity !== 'info' && !/документи —/.test(r.title + ' ' + r.detail) && r.category !== 'registry');
  const risksTop = [...meaningful]
    .sort((a, b) => rank[a.severity] - rank[b.severity])
    .slice(0, 3)
    .map((r) => ({ ...r, detail: compactDetail(r.detail) }));
  const items = input.checklist.map((c) => ({ label: DOC_LABEL[c.requirement_key] ?? c.requirement_key, ok: c.status !== 'missing' }));

  const chain = (['sender', 'intermediary', 'recipient'] as const)
    .map((role) => {
      const p = party(role);
      return p ? { role, name: p.company_name, country: p.country } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  return {
    generatedAt: fmtDate(input.now.getTime())!,
    number: input.workspace.number,
    responsible: input.responsible,
    product: {
      name: str(firstOf(docs, productDocs, 'product_name')) ?? str(line0?.description),
      cas: str(firstOf(docs, [...productDocs, 'other'], 'cas_number')),
      form: input.workspace.product_category,
      quantity,
      unit,
      batch: str(firstOf(docs, ['quality_certificate', 'packing_list', 'invoice'], 'batch_number')),
      manufactured: monthYear(firstOf(docs, ['quality_certificate', 'packing_list', 'invoice'], 'manufacture_date')),
      expiry: monthYear(firstOf(docs, ['quality_certificate', 'packing_list', 'invoice'], 'expiry_date')),
    },
    chain,
    contractType: input.workspace.contract_type,
    contractNumber: str(contractDoc?.fields.contract_number),
    cleared: decl ? { date: fmtDate(declTs), declaration: str(decl.fields.registration_number) ?? decl.file_name } : null,
    money: {
      outbound: out ? { ...out, incoterm: outCode, place: outIncoterm } : null,
      inbound: inb,
      markupPct: out && inb && out.currency === inb.currency && inb.value > 0 ? Math.round(((out.value - inb.value) / inb.value) * 100) : null,
      customsValueUah,
      dutyUah,
      vatUah,
      dutyRatePct,
      rate,
      servicesUah,
      costPerKgUah: costBase !== null && qtyKg ? Math.round(costBase / qtyKg) : null,
      freightInPrice,
    },
    durations: {
      contractToDeclaration: contractTs !== null && declTs !== null ? Math.round((declTs - contractTs) / DAY) : null,
      shipmentToDeclaration: firstShip !== null && declTs !== null ? Math.round((declTs - firstShip) / DAY) : null,
    },
    route: { stops, legs },
    shipment: {
      packages: num(firstOf(docs, ['customs_declaration', 'packing_list', 'invoice', 'transport'], 'packages_count')),
      grossKg: num(firstOf(docs, ['customs_declaration', 'transport', 'packing_list', 'invoice'], 'gross_weight_kg')),
    },
    // ≤ 8 points: keep the first (contract) and the most recent — МД/delivery matter most.
    timeline: timeline.length > 8 ? [timeline[0]!, ...timeline.slice(-7)] : timeline,
    classification: {
      hsCode,
      hsSource,
      duty: input.qdpro?.duty ?? (dutyRatePct !== null ? `${String(dutyRatePct).replace('.', ',')}%` : null),
      vatPct,
      controls: input.qdpro?.controls ?? [],
      controlsSource: input.qdpro ? 'qdpro' : null,
    },
    risksTop,
    counts: {
      errors: input.risks.filter((r) => r.severity === 'error').length,
      warnings: input.risks.filter((r) => r.severity === 'warning').length,
    },
    docs: {
      required: items.length,
      present: items.filter((i) => i.ok).length,
      items,
      files: input.filesCount,
    },
  };
}

/**
 * "вага нетто, кг: 25 (a.pdf, b.pdf) → 32 (DEP-1-….pdf)" → "вага нетто, кг: 25 → 32".
 * File lists are for the Штурман screen, not the management page.
 */
export function compactDetail(detail: string): string {
  return detail.replace(/\s*\([^()]*\.(pdf|jpe?g|png|docx?|xlsx?)[^()]*\)/gi, '').replace(/\s{2,}/g, ' ').trim();
}

/** "MUMBAI (EX BOMBAY)", "Frankfurt Airport", "Kiev Int'l Airport, Ukraine" → a comparable city key. */
function placeKey(name: string): string {
  return name
    .split(',')[0]!
    .replace(/\(.*?\)/g, '')
    .replace(/^\s*(м|г|смт|с|city of)\.?\s+/i, '') // "м. Біла Церква"
    .replace(/^\s*[A-Z]{2}\s+(?=\p{L}{3,})/u, '') // "UA Kiev" (country prefix)
    .replace(/\b(int'?l|international|airport|apt|port|terminal|hub)\b/gi, '')
    .trim()
    .toLowerCase()
    .replace(/^kiev$/, 'kyiv');
}
function placeLabel(name: string): string {
  const k = placeKey(name);
  return k.replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase());
}

type RouteLeg = { from: string | null; to: string | null; mode: string; ref: string | null; t: number | null };

/**
 * One chain of stops from the transport documents. Copies of the same document
 * (AWB + HAWB original, CMR + its photo) collapse into one leg; a door-to-door
 * AWB "Mumbai → Kyiv" plus a CMR "Frankfurt → Kyiv" becomes Mumbai ✈ Frankfurt
 * 🚚 Kyiv — the later leg into the same destination reveals the transshipment.
 */
export function buildRoute(
  raw: RouteLeg[],
  finalDest: string | null,
  lastMile: { ref: string | null; t: number | null } | null,
): { stops: { name: string; note: string | null; date: string | null }[]; legs: { mode: string; ref: string | null }[] } {
  const seen = new Set<string>();
  // Customs-office codes (T1: "DE DA04", "UA100100") are not places on the route.
  const isCode = (v: string | null) => !!v && /^[A-Z]{2}\s?[A-Z0-9]*\d[A-Z0-9]*$/i.test(v.split(',')[0]!.trim());
  const legsIn = raw
    .map((l) => ({ ...l, from: isCode(l.from) ? null : l.from, to: isCode(l.to) ? null : l.to }))
    .filter((l) => l.from || l.to)
    .filter((l) => {
      const key = `${l.mode}|${l.from ? placeKey(l.from) : ''}|${l.to ? placeKey(l.to) : ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity));

  const stops: { key: string; name: string; t: number | null }[] = [];
  const legs: { mode: string; ref: string | null }[] = [];
  const idx = (k: string) => stops.findIndex((s) => s.key === k);
  for (const l of legsIn) {
    const from = l.from ? { key: placeKey(l.from), name: placeLabel(l.from) } : null;
    const to = l.to ? { key: placeKey(l.to), name: placeLabel(l.to) } : null;
    if (!stops.length) {
      if (from) stops.push({ ...from, t: l.t });
      if (to) {
        if (from) legs.push({ mode: l.mode, ref: l.ref });
        stops.push({ ...to, t: null });
      }
      continue;
    }
    const last = stops[stops.length - 1]!;
    if (from && to && to.key === last.key && idx(from.key) < 0) {
      // Transshipment: insert `from` before the shared destination.
      stops.splice(stops.length - 1, 0, { ...from, t: l.t });
      legs.push({ mode: l.mode, ref: l.ref });
      continue;
    }
    if (from && idx(from.key) < 0) {
      legs.push({ mode: 'road', ref: null });
      stops.push({ ...from, t: l.t });
    } else if (from) {
      const f = stops[idx(from.key)]!;
      if (f.t === null) f.t = l.t;
    }
    if (to && idx(to.key) < 0) {
      legs.push({ mode: l.mode, ref: l.ref });
      stops.push({ ...to, t: null });
    }
  }
  if (finalDest && stops.length && idx(placeKey(finalDest)) < 0) {
    legs.push({ mode: 'road', ref: lastMile?.ref ?? null });
    stops.push({ key: placeKey(finalDest), name: placeLabel(finalDest), t: lastMile?.t ?? null });
  }
  while (legs.length > Math.max(0, stops.length - 1)) legs.pop();
  return { stops: stops.map((s) => ({ name: s.name, note: null, date: fmtDate(s.t, false) })), legs };
}
