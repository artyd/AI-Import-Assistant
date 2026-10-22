import { sameCompany } from '../shipments/contextDerive.js';
import { docGoods, isInternalCompany, isManifest, sameGoods, transportDocKind, type AssignFields } from '../shipments/lotAssign.js';
import { isLikelyDraft } from './reconcile.js';
import type { WorkspaceStatus } from '../shipments/workspaceAccess.js';
import type { ChecklistItem } from './checklist.js';
import type { Discrepancy, DiscrepancyCitation, FlagKind } from './reconcile.js';
import { fieldLabel, type Risk } from './risks.js';
import { invoiceLines, reconcileManifest, type ManifestLine, type ManifestReconciliation } from './manifest.js';

/**
 * FCL-level verdicts (Збірник, spec 006 #04) — pure, no I/O. The lots are judged
 * one by one with the shipment verdicts; this module judges what only the whole
 * container shows:
 *   1. FCL completeness — master bill, a house bill per lot (sea), T1/NCTS + CMR
 *      when the cargo transits the EU, the manifest, and a customs declaration
 *      per consignee (needed only for «Готово до митниці»);
 *   2. transport as a whole — one container everywhere, Σ house bills = master
 *      bill (weight, packages), transit = master bill, lot packing list = its HBL;
 *   3. consignees — who receives which lot, and whose МД is missing;
 *   4. the FCL status — the worst of the lots and the FCL level.
 * Same ranking as the shipment: 🔴 confirmed needs two citations, the rest 🟡.
 */

export interface FclFile {
  file_id: string;
  file_name: string;
  file_type: string;
  folder_name: string | null;
  lot_id: string | null;
  fields: Record<string, unknown> | null;
}

export interface FclLot {
  id: string;
  name: string;
  supplier_name: string;
  /** Consignee set on the lot by hand. */
  consignee: string | null;
  /** The lot's recipient party (read from its documents), when known. */
  recipient?: string | null;
  derivedStatus: WorkspaceStatus;
}

/** An FCL checklist item; `label` names the lot / consignee of a per-lot requirement. */
export interface FclChecklistItem extends ChecklistItem {
  label: string;
  /** 'customs' items are only required for «Готово до митниці». */
  stage: 'docs' | 'customs';
}

export interface FclLevelInput {
  transport_mode: string | null;
  /** Explicit EU-transit flag; null = derive from the documents. */
  eu_transit: boolean | null;
  /** The FCL's own consignee (our company), when known. */
  consignee: string | null;
  files: FclFile[];
  lots: FclLot[];
  /** Lines of the manifest file (parsed by the analysis sheet parser), when there is one. */
  manifest?: { file_id: string; file_name: string; lines: ManifestLine[] } | null;
}

export interface ConsigneeCoverage {
  name: string;
  lots: string[];
  customs_declaration_file_id: string | null;
}

export interface FclLevelVerdicts {
  checklist: FclChecklistItem[];
  discrepancies: Discrepancy[];
  risks: Risk[];
  consignees: ConsigneeCoverage[];
  /** House bill → lot, matched by shipper / goods. */
  hblLot: Record<string, string>;
  /** The consignee of each lot (by hand, HBL, resale invoice, recipient, FCL). */
  lotConsignees: Record<string, string | null>;
  containers: string[];
  euTransit: boolean | null;
  /** Files in no lot and no FCL folder (the inbox and unknown folders). */
  unassigned: number;
  /** Manifest ↔ invoices; null when there is no manifest and no invoice line. */
  manifest: ManifestReconciliation | null;
  /** Status of the FCL level alone. */
  levelStatus: WorkspaceStatus;
  /** The FCL status: the worst of the lots and the FCL level. */
  derivedStatus: WorkspaceStatus;
}

const PIPELINE: WorkspaceStatus[] = ['draft', 'docs_in_progress', 'docs_complete', 'customs_ready'];
const WEIGHT_TOLERANCE = 0.01;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The worst (earliest) pipeline status of the list. */
export function worstStatus(statuses: WorkspaceStatus[]): WorkspaceStatus {
  let rank = PIPELINE.length - 1;
  for (const s of statuses) {
    const r = PIPELINE.indexOf(s);
    rank = Math.min(rank, r < 0 ? 0 : r);
  }
  return PIPELINE[rank]!;
}

// EU sea ports and countries a Ukraine-bound container is usually discharged in.
const EU_RX =
  /gda[nń]sk|gdynia|hamburg|rotterdam|antwerp|bremerhaven|koper|constan[tţ]a|klaip[eė]da|riga|tallinn|trieste|piraeus|valencia|genoa|le havre|poland|germany|netherlands|belgium|lithuania|latvia|estonia|romania|slovenia|italy|greece|spain|польщ|німеччин|нідерланд|литв|латві|румун/i;
const UA_RX = /odesa|odessa|chornomorsk|pivdennyi|yuzhny|izmail|reni|ukraine|одеса|чорноморськ|ізмаїл|україн/i;

function transportOf(files: FclFile[]): FclFile[] {
  return files.filter((f) => str(f.fields?.doc_type) === 'transport');
}

function kindOf(f: FclFile) {
  return transportDocKind(f.file_name, f.fields as AssignFields | null);
}

function cite(f: FclFile, docType: string, value: unknown): DiscrepancyCitation {
  return { file_id: f.file_id, file_name: f.file_name, doc_type: docType, value: value === null || value === undefined ? '—' : String(value) };
}

function lowConfidence(f: FclFile, field: string): boolean {
  const fc = f.fields?.field_confidence as Record<string, string> | undefined;
  return fc?.[field] === 'low';
}

/** Names that sell/ship on a document (seller, consignor/shipper, parties with those roles). */
function shipperNames(fields: Record<string, unknown> | null): string[] {
  if (!fields) return [];
  const out = [str(fields.consignor_name), str(fields.seller)];
  if (Array.isArray(fields.parties)) {
    for (const p of fields.parties as { name?: unknown; role?: unknown }[]) {
      if (/shipper|consignor|seller|exporter|відправник|продав/i.test(str(p?.role) ?? '')) out.push(str(p?.name));
    }
  }
  return out.filter((n): n is string => !!n);
}

/**
 * House bills → lots: by shipper (the lot's supplier), else by the goods the bill
 * describes against the goods of the lot's documents. Unmatched bills stay unmatched.
 */
export function matchHblsToLots(files: FclFile[], lots: FclLot[]): Record<string, string> {
  const out: Record<string, string> = {};
  const lotGoods = new Map(lots.map((l) => [l.id, files.filter((f) => f.lot_id === l.id).flatMap((f) => docGoods(f.fields as AssignFields | null))]));
  for (const f of transportOf(files)) {
    if (kindOf(f) !== 'hbl') continue;
    const names = shipperNames(f.fields);
    const bySupplier = lots.filter((l) => names.some((n) => sameCompany(n, l.supplier_name)));
    if (bySupplier.length === 1) {
      out[f.file_id] = bySupplier[0]!.id;
      continue;
    }
    const goods = docGoods(f.fields as AssignFields | null);
    const byGoods = lots.filter((l) => (lotGoods.get(l.id) ?? []).some((g) => goods.some((d) => sameGoods(g, d))));
    if (byGoods.length === 1) out[f.file_id] = byGoods[0]!.id;
  }
  return out;
}

/** EU transit: explicit, else derived from where the master bill discharges. */
export function deriveEuTransit(explicit: boolean | null, files: FclFile[]): boolean | null {
  if (explicit !== null) return explicit;
  const transport = transportOf(files);
  if (transport.some((f) => kindOf(f) === 'transit')) return true;
  const master = transport.find((f) => kindOf(f) === 'mbl') ?? transport.find((f) => kindOf(f) === 'hbl');
  const discharge = `${str(master?.fields?.place_of_discharge) ?? ''} ${str(master?.fields?.final_destination) ?? ''}`;
  if (!discharge.trim()) return null;
  if (UA_RX.test(str(master?.fields?.place_of_discharge) ?? '')) return false;
  return EU_RX.test(discharge) ? true : null;
}

/** The manifest: a file the extraction / name marks as one, or a spreadsheet in the manifest folder. */
export function findManifestFile(files: FclFile[]): FclFile | null {
  const sheet = (f: FclFile) => f.file_type === 'xlsx' || f.file_type === 'csv';
  return (
    files.find((f) => isManifest({ file_name: f.file_name, file_type: f.file_type, fields: f.fields as AssignFields | null })) ??
    files.find((f) => sheet(f) && /маніфест|manifest/i.test(f.folder_name ?? '')) ??
    null
  );
}

/** Master bill kinds, in priority order. A consolidation with house bills always has a sea MBL. */
function masterKinds(mode: string | null, hasHbl: boolean): string[] {
  if (hasHbl || mode === 'sea') return ['mbl'];
  if (mode === 'air') return ['awb'];
  if (mode === 'road') return ['cmr'];
  return ['mbl', 'awb', 'cmr'];
}

const MASTER_LABEL: Record<string, string> = {
  mbl: 'Морський коносамент (MBL)',
  awb: 'Авіанакладна (MAWB)',
  cmr: 'CMR',
};

// Ukrainian/Russian → Latin, so «ТОВ "НОВАЛАЙТ"» in the МД matches «"NOVALAIT" LLC» in the HBL.
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ye', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'yu', я: 'ya', ы: 'y', э: 'e', ё: 'e', ъ: '',
};
const ORG_FORMS = /\b(tov|pat|prat|tdv|pp|fop|pjsc|ojsc|jsc|llc|ltd|limited|co|plc|ooo|zao|oao)\b/g;

function latinKey(name: string): string {
  const t = name.toLowerCase().replace(/[а-яіїєґёыэъ]/g, (c) => TRANSLIT[c] ?? c);
  return t.replace(/[^a-z0-9 ]+/g, ' ').replace(ORG_FORMS, ' ').replace(/\s+/g, '').replace(/kh/g, 'h').replace(/y/g, 'i');
}

/** Same company across scripts and legal-form spellings. */
export function sameParty(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (sameCompany(a, b)) return true;
  const ka = latinKey(a);
  const kb = latinKey(b);
  return !!ka && !!kb && (ka === kb || (Math.min(ka.length, kb.length) >= 5 && (ka.includes(kb) || kb.includes(ka))));
}

/** Consignee of a document: the consignee field, else the buyer. */
function consigneeOf(fields: Record<string, unknown> | null): string | null {
  return str(fields?.consignee_name) ?? str(fields?.buyer);
}

const normDocNo = (s: string | null): string => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** One house bill, however many copies of it were uploaded (original, TELEX, re-downloads). */
export interface HblGroup {
  key: string;
  files: FclFile[];
  /** The copy the checks use: the figures most copies carry, then TELEX / original, then issued over drafts. */
  canonical: FclFile;
  /** Copies disagree on weight / packages — sums built on this bill are only suspected. */
  conflicting: boolean;
}

export function groupHbls(hbls: FclFile[]): HblGroup[] {
  const groups = new Map<string, FclFile[]>();
  for (const f of hbls) {
    const letter = /\bHBL[\s_-]*([A-Z])\b/i.exec(f.file_name.replace(/[_.]/g, ' '))?.[1];
    const key = normDocNo(str(f.fields?.transport_doc_number)) || (letter ? `HBL-${letter.toUpperCase()}` : f.file_id);
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const rank = (f: FclFile): number =>
    (/telex|original|released|оригінал|оригинал/i.test(f.file_name) ? 0 : 2) + (isLikelyDraft(f.file_name) ? 1 : 0);
  // Copies that disagree: the figures most copies carry win (a single edited copy
  // must not decide the sums), then TELEX / original, then issued over drafts.
  const signature = (f: FclFile): string => `${num(f.fields?.gross_weight_kg) ?? ''}|${num(f.fields?.packages_count) ?? ''}`;
  return [...groups.entries()].map(([key, files]) => {
    const votes = new Map<string, number>();
    for (const f of files) votes.set(signature(f), (votes.get(signature(f)) ?? 0) + 1);
    const canonical = [...files].sort(
      (a, b) => (votes.get(signature(b)) ?? 0) - (votes.get(signature(a)) ?? 0) || rank(a) - rank(b),
    )[0]!;
    return { key, files, canonical, conflicting: votes.size > 1 };
  });
}

/**
 * A Ukrainian import declaration (МД), not the Chinese export declaration or a
 * statistics spreadsheet that the extraction also files as a customs paper.
 */
export function isImportDeclaration(f: FclFile): boolean {
  if (str(f.fields?.doc_type) !== 'customs_declaration') return false;
  const no = str(f.fields?.transport_doc_number) ?? str(f.fields?.registration_number) ?? '';
  const hay = `${f.file_name} ${no}`;
  if (/export|експорт|экспорт|报关|出口|\bCHN\d/i.test(hay)) return false;
  if (/\d{2}UA\d{6}/i.test(hay) || /(^|[^а-яіїєґ])(в?мд)([^а-яіїєґ]|$)|\bMD\b|IM\s?40|імпорт/i.test(hay)) return true;
  return num(f.fields?.customs_value_uah) !== null || num(f.fields?.duty_uah) !== null || num(f.fields?.vat_uah) !== null;
}

/**
 * Who receives a lot: set by hand, else the consignee of its house bill, else the
 * buyer of our resale invoice in the lot, else the lot's recipient — never one of
 * our own companies (they are the intermediary, not the consignee); else the FCL's.
 */
function lotConsignee(lot: FclLot, lotHbls: FclFile[], lotFiles: FclFile[], fallback: string | null): string | null {
  if (lot.consignee) return lot.consignee;
  const outside = (n: string | null): string | null => (n && !isInternalCompany(n) ? n : null);
  for (const h of lotHbls) {
    const c = outside(str(h.fields?.consignee_name));
    if (c) return c;
  }
  for (const f of lotFiles) {
    if (str(f.fields?.doc_type) === 'invoice' && isInternalCompany(str(f.fields?.seller))) {
      const c = outside(consigneeOf(f.fields));
      if (c) return c;
    }
  }
  return outside(lot.recipient ?? null) ?? fallback;
}

export function computeFclLevel(input: FclLevelInput): FclLevelVerdicts {
  const { files, lots } = input;
  const transport = transportOf(files);
  const hblLot = matchHblsToLots(files, lots);
  const euTransit = deriveEuTransit(input.eu_transit, files);
  const discrepancies: Discrepancy[] = [];
  const checklist: FclChecklistItem[] = [];

  const hbls = transport.filter((f) => kindOf(f) === 'hbl');
  const hblGroups = groupHbls(hbls);
  const groupLot = (g: HblGroup): string | null => g.files.map((f) => hblLot[f.file_id]).find(Boolean) ?? null;

  // ── 1. FCL completeness ────────────────────────────────────────────────────
  const kinds = masterKinds(input.transport_mode, hbls.length > 0);
  let master: FclFile | undefined;
  for (const k of kinds) {
    master = transport.find((f) => kindOf(f) === k);
    if (master) break;
  }
  checklist.push({
    requirement_key: 'master_transport',
    label: kinds.length === 1 ? MASTER_LABEL[kinds[0]!]! : 'Основний транспортний документ (MBL / MAWB / CMR)',
    stage: 'docs',
    status: master ? 'verified' : 'missing',
    source_file_id: master?.file_id ?? null,
  });
  if (input.transport_mode === 'sea' || hbls.length > 0) {
    for (const lot of lots) {
      const g = hblGroups.find((x) => groupLot(x) === lot.id);
      checklist.push({
        requirement_key: `hbl:${lot.id}`,
        label: `HBL — ${lot.name}`,
        stage: 'docs',
        status: g ? 'verified' : 'missing',
        source_file_id: g?.canonical.file_id ?? null,
      });
    }
  }
  if (euTransit) {
    const transit = transport.find((f) => kindOf(f) === 'transit');
    const cmr = transport.find((f) => kindOf(f) === 'cmr');
    checklist.push({ requirement_key: 'transit', label: 'Транзитна декларація T1 / NCTS', stage: 'docs', status: transit ? 'verified' : 'missing', source_file_id: transit?.file_id ?? null });
    if (input.transport_mode !== 'road') {
      checklist.push({ requirement_key: 'cmr', label: 'CMR (автоплече до України)', stage: 'docs', status: cmr ? 'verified' : 'missing', source_file_id: cmr?.file_id ?? null });
    }
  }
  const manifest = findManifestFile(files);
  checklist.push({ requirement_key: 'manifest', label: 'Маніфест збірника', stage: 'docs', status: manifest ? 'verified' : 'missing', source_file_id: manifest?.file_id ?? null });

  // ── 3. Consignees and their customs declarations ──────────────────────────
  const consignees: Record<string, string | null> = {};
  const consigneeMap = new Map<string, ConsigneeCoverage>();
  for (const lot of lots) {
    const lotHbls = hblGroups.filter((g) => groupLot(g) === lot.id).flatMap((g) => [g.canonical, ...g.files]);
    const name = lotConsignee(lot, lotHbls, files.filter((f) => f.lot_id === lot.id), input.consignee);
    consignees[lot.id] = name;
    if (!name) continue;
    const key = [...consigneeMap.keys()].find((k) => sameParty(k, name)) ?? name;
    const entry = consigneeMap.get(key) ?? { name: key, lots: [], customs_declaration_file_id: null };
    entry.lots.push(lot.name);
    consigneeMap.set(key, entry);
  }
  const declarations = files.filter(isImportDeclaration);
  for (const c of consigneeMap.values()) {
    const md = declarations.find((d) => sameParty(consigneeOf(d.fields), c.name) || sameParty(str(d.fields?.buyer), c.name));
    c.customs_declaration_file_id = md?.file_id ?? null;
    checklist.push({
      requirement_key: `customs_declaration:${c.name}`,
      label: `МД — ${c.name}`,
      stage: 'customs',
      status: md ? 'verified' : 'missing',
      source_file_id: md?.file_id ?? null,
    });
  }

  // ── 2. Transport as a whole ────────────────────────────────────────────────
  const containerSet = new Set<string>();
  for (const f of transport) for (const c of (f.fields?.container_numbers as string[] | undefined) ?? []) containerSet.add(c);
  // The reference container: the master bill's, else the one most transport papers name.
  const counts = new Map<string, number>();
  for (const f of transport) for (const c of (f.fields?.container_numbers as string[] | undefined) ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
  const refContainers = ((master?.fields?.container_numbers as string[] | undefined) ?? []).length
    ? ((master!.fields!.container_numbers as string[]))
    : [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1).map(([c]) => c);
  const refDoc = master ?? transport.find((f) => ((f.fields?.container_numbers as string[] | undefined) ?? []).some((c) => refContainers.includes(c)));
  if (refDoc && refContainers.length > 0) {
    for (const f of transport) {
      if (f === refDoc) continue;
      const theirs = (f.fields?.container_numbers as string[] | undefined) ?? [];
      if (theirs.length > 0 && !theirs.some((c) => refContainers.includes(c))) {
        discrepancies.push({
          field: 'container_numbers',
          expected: refContainers.join(', '),
          actual: theirs.join(', '),
          severity: 'error',
          kind: 'confirmed',
          citations: [cite(refDoc, 'transport', refContainers.join(', ')), cite(f, 'transport', theirs.join(', '))],
        });
      }
    }
  }

  // Copies of one house bill that disagree (a re-issued or edited copy).
  for (const g of hblGroups) {
    for (const field of ['gross_weight_kg', 'packages_count', 'consignee_name'] as const) {
      const values = g.files.map((f) => f.fields?.[field]).filter((v) => v !== null && v !== undefined && v !== '');
      const distinct = [...new Set(values.map((v) => String(v).trim().toUpperCase()))];
      if (distinct.length > 1 && !(field === 'consignee_name' && values.every((v, _, all) => sameCompany(String(v), String(all[0]))))) {
        discrepancies.push({
          field: `hbl_versions_${field}`,
          expected: `${g.key}: ${String(g.canonical.fields?.[field] ?? '—')}`,
          actual: distinct.join(' / '),
          severity: 'warning',
          kind: 'suspected',
          citations: g.files.map((f) => cite(f, 'transport', f.fields?.[field])),
        });
      }
    }
  }

  const canon = hblGroups.map((g) => g.canonical);
  const shaky = hblGroups.some((g) => g.conflicting);
  if (master && canon.length > 0) {
    for (const field of ['gross_weight_kg', 'packages_count'] as const) {
      const masterValue = num(master.fields?.[field]);
      if (masterValue === null) continue;
      const values = canon.map((h) => num(h.fields?.[field]));
      if (values.some((v) => v === null)) {
        discrepancies.push({
          field: `hbl_sum_${field}`,
          expected: String(masterValue),
          actual: 'не всі HBL мають значення',
          severity: 'warning',
          kind: 'suspected',
          citations: [cite(master, 'transport', masterValue)],
        });
        continue;
      }
      const sum = values.reduce<number>((a, v) => a + (v ?? 0), 0);
      const off = field === 'packages_count' ? sum !== masterValue : Math.abs(sum - masterValue) > masterValue * WEIGHT_TOLERANCE;
      if (off) {
        const low = shaky || lowConfidence(master, field) || canon.some((h) => lowConfidence(h, field));
        discrepancies.push({
          field: `hbl_sum_${field}`,
          expected: String(masterValue),
          actual: String(Math.round(sum * 1000) / 1000),
          severity: low ? 'warning' : 'error',
          kind: low ? 'suspected' : 'confirmed',
          citations: [cite(master, 'transport', masterValue), ...canon.map((h) => cite(h, 'transport', h.fields?.[field]))],
        });
      }
    }
  }

  // Transit (T1) against the master bill, else against Σ house bills.
  const transit = transport.find((f) => kindOf(f) === 'transit');
  const tGross = num(transit?.fields?.gross_weight_kg);
  const canonGross = canon.map((h) => num(h.fields?.gross_weight_kg));
  const refGross = master
    ? num(master.fields?.gross_weight_kg)
    : canon.length > 0 && canonGross.every((v) => v !== null)
      ? Math.round(canonGross.reduce<number>((a, v) => a + (v ?? 0), 0) * 1000) / 1000
      : null;
  if (transit && tGross !== null && refGross !== null && Math.abs(refGross - tGross) > refGross * WEIGHT_TOLERANCE) {
    const refDocs = master ? [master] : canon;
    const kind: FlagKind =
      (!master && shaky) || lowConfidence(transit, 'gross_weight_kg') || refDocs.some((d) => lowConfidence(d, 'gross_weight_kg')) ? 'suspected' : 'confirmed';
    discrepancies.push({
      field: master ? 'transit_gross_weight_kg' : 'transit_vs_hbl_gross_weight_kg',
      expected: String(refGross),
      actual: String(tGross),
      severity: kind === 'confirmed' ? 'error' : 'warning',
      kind,
      citations: [...refDocs.map((d) => cite(d, 'transport', d.fields?.gross_weight_kg)), cite(transit, 'transport', tGross)],
    });
  }

  for (const lot of lots) {
    const lotGroups = hblGroups.filter((g) => groupLot(g) === lot.id);
    const lotHbls = lotGroups.map((g) => g.canonical);
    const pl = files.find((f) => f.lot_id === lot.id && str(f.fields?.doc_type) === 'packing_list');
    const plGross = num(pl?.fields?.gross_weight_kg);
    const hGross = lotHbls.map((h) => num(h.fields?.gross_weight_kg));
    if (!pl || plGross === null || lotHbls.length === 0 || hGross.some((v) => v === null)) continue;
    const sum = hGross.reduce<number>((a, v) => a + (v ?? 0), 0);
    if (Math.abs(sum - plGross) > plGross * WEIGHT_TOLERANCE) {
      const kind: FlagKind =
        lotGroups.some((g) => g.conflicting) || lowConfidence(pl, 'gross_weight_kg') || lotHbls.some((h) => lowConfidence(h, 'gross_weight_kg')) ? 'suspected' : 'confirmed';
      discrepancies.push({
        field: 'lot_gross_weight_kg',
        expected: `${lot.name}: ${plGross}`,
        actual: String(Math.round(sum * 1000) / 1000),
        severity: kind === 'confirmed' ? 'error' : 'warning',
        kind,
        citations: [cite(pl, 'packing_list', plGross), ...lotHbls.map((h) => cite(h, 'transport', h.fields?.gross_weight_kg))],
      });
    }
  }

  // ── Manifest ↔ the lots' invoices (#05) ────────────────────────────────────
  const lines = invoiceLines(files, Object.fromEntries(lots.map((l) => [l.id, l.name])));
  let manifestRecon: ManifestReconciliation | null = null;
  if (input.manifest) {
    manifestRecon = reconcileManifest({ ...input.manifest, built: false }, lines);
    discrepancies.push(...manifestRecon.discrepancies);
  } else if (lines.length > 0) {
    manifestRecon = reconcileManifest({ file_id: null, file_name: 'зібрано з інвойсів', built: true, lines: [] }, lines);
  }

  // ── Risks of the FCL level ─────────────────────────────────────────────────
  const risks: Risk[] = [];
  const unassigned = files.filter((f) => f.lot_id === null && !/маніфест|транспорт|митниц/i.test(f.folder_name ?? '')).length;
  if (unassigned > 0) {
    risks.push({
      code: 'fcl_unassigned_files',
      category: 'missing_docs',
      severity: 'warning',
      title: `Файли без партії: ${unassigned}`,
      detail: 'Ці файли не враховуються в перевірках партій. Розкладіть їх по партіях.',
      source_file_id: null,
    });
  }
  const missingDocs = checklist.filter((i) => i.stage === 'docs' && i.status === 'missing');
  if (missingDocs.length > 0) {
    risks.push({
      code: 'fcl_missing_docs',
      category: 'missing_docs',
      severity: 'warning',
      title: `Бракує документів FCL: ${missingDocs.length}`,
      detail: missingDocs.map((i) => i.label).join(', '),
      source_file_id: null,
    });
  }
  for (const d of discrepancies.filter((x) => x.severity === 'error')) {
    risks.push({
      code: `fcl_discrepancy_${d.field}`,
      category: 'discrepancy',
      severity: 'error',
      title: `Розбіжність FCL: ${fieldLabel(d.field)}`,
      detail: `очікувалось ${d.expected}, фактично ${d.actual}`,
      source_file_id: d.citations[1]?.file_id ?? null,
    });
  }

  // ── 4. Status ──────────────────────────────────────────────────────────────
  const docsItems = checklist.filter((i) => i.stage === 'docs');
  const hasErrors = discrepancies.some((d) => d.severity === 'error');
  let levelStatus: WorkspaceStatus;
  if (lots.length === 0 && files.length === 0) levelStatus = 'draft';
  else if (docsItems.some((i) => i.status === 'missing') || hasErrors || unassigned > 0) levelStatus = 'docs_in_progress';
  else if (checklist.some((i) => i.stage === 'customs' && i.status === 'missing') || consigneeMap.size === 0) levelStatus = 'docs_complete';
  else levelStatus = 'customs_ready';

  const derivedStatus = lots.length === 0
    ? worstStatus([levelStatus, 'docs_in_progress'])
    : worstStatus([levelStatus, ...lots.map((l) => l.derivedStatus)]);

  return {
    checklist,
    discrepancies,
    risks,
    consignees: [...consigneeMap.values()],
    hblLot,
    lotConsignees: consignees,
    containers: [...containerSet],
    euTransit,
    unassigned,
    manifest: manifestRecon,
    levelStatus,
    derivedStatus,
  };
}
