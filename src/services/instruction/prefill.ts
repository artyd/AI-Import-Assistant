import { query } from '../../db/pool.js';
import type { WorkspaceRow } from '../workspaceAccess.js';
import { listParties } from '../parties.js';
import { sameCompany } from '../contextDerive.js';
import { countryToUk } from '../../domain/countries.js';
import { incotermCode } from '../reconcile.js';
import { logistEnabled, uktzedFlags } from '../logist/index.js';
import { baseDocs, baseLabels, emptyDraft, qdproDocs } from './defaults.js';
import type { CheckItem, FieldSource, InstructionDraft } from './types.js';
import { formatDate, formatHs, latinPart } from './format.js';

/**
 * Pre-fills a new instruction draft from what the shipment already knows — no
 * LLM. An instruction is written BEFORE shipment, so usually only the contract
 * (and parties) exist; the team directory and previous shipments of the same
 * supplier fill the rest. Every filled field records its source (badge).
 */
interface DocRow {
  file_name: string;
  doc_type: string | null;
  fields: Record<string, unknown>;
}
export interface DirectoryRow {
  id: string;
  kind: 'own_company' | 'supplier' | 'consignee' | 'contact';
  name: string;
  address: string;
  country: string;
  signer: string;
  email: string;
  phone: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

function categoryOf(productCategory: string | null): InstructionDraft['category'] {
  const c = (productCategory ?? '').toLowerCase();
  if (/готов|finished|препарат/.test(c)) return 'finished';
  if (/хім|chem/.test(c)) return 'chemical';
  if (/харч|food|вет/.test(c)) return 'food';
  if (/обладн|equip|інше|other/.test(c)) return 'other';
  return 'substance'; // user portrait: substances (APIs) by default
}

const TRANSPORT: Record<string, InstructionDraft['terms']['transport']> = {
  air: 'air',
  sea: 'sea',
  inland_waterway: 'sea',
  road: 'road',
  rail: 'multimodal',
  multimodal: 'multimodal',
  courier: 'air',
};

/** Address of a company as stated in any document's parties[] (first hit). */
function addressFromDocs(docs: DocRow[], name: string): { address: string; country: string } | null {
  for (const d of docs) {
    const parties = Array.isArray(d.fields.parties) ? (d.fields.parties as { name?: string; address?: string; country?: string }[]) : [];
    const hit = parties.find((p) => p.name && sameCompany(p.name, name) && p.address);
    if (hit) return { address: str(hit.address), country: str(hit.country) };
  }
  return null;
}

const CONSIGNOR_ROLE = /consignor|shipper|вантажовідправ|грузоотправ|відправник|отправитель/i;
const CONSIGNEE_ROLE = /consignee|вантажоодерж|грузополуч|одержувач|получатель/i;

/**
 * A party the contract names for a role (its parties[] entry), e.g. the
 * consignor of clause 4.2 / the consignee of 4.3 — the contract's own words beat
 * any slot inference.
 */
export function contractParty(
  doc: DocRow | undefined,
  kind: 'consignor' | 'consignee',
): { name: string; address: string; country: string } | null {
  if (!doc) return null;
  const role = kind === 'consignor' ? CONSIGNOR_ROLE : CONSIGNEE_ROLE;
  // Dedicated fields first: the extraction fills them from the shipment clause
  // itself (4.2 «The Consignor … Address: …»), with the address for that role.
  const dedicatedName = str(doc.fields[`${kind}_name`]);
  if (dedicatedName) {
    const address = str(doc.fields[`${kind}_address`]);
    return { name: dedicatedName, address, country: countryInAddress(address) };
  }
  const parties = Array.isArray(doc.fields.parties)
    ? (doc.fields.parties as { name?: string; role?: string; address?: string; country?: string }[])
    : [];
  const hit = parties.find((p) => p.name && p.role && role.test(p.role));
  return hit ? { name: str(hit.name), address: str(hit.address), country: str(hit.country) } : null;
}

/**
 * The country an address line names at its start or end ("…, Tianjin 300462,
 * China" / "Ukraine, 61001, Kharkiv, …"), recognised against the country list —
 * a street name is never taken for a country. '' if none.
 */
export function countryInAddress(address: string): string {
  const parts = address.split(',').map((x) => x.trim()).filter(Boolean);
  for (const part of [parts[parts.length - 1], parts[0]]) {
    if (part && !/\d/.test(part) && countryToUk(part)) return part;
  }
  return '';
}

/** "CPT - Bila Tserkva, Ukraine (INCOTERMS 2010)" → "Bila Tserkva, Ukraine" */
function incotermPlace(term: string): string {
  return term
    .replace(/\b(EXW|FCA|FAS|FOB|CFR|CNF|CIF|CPT|CIP|DAP|DPU|DAT|DDP|DDU)\b/i, '')
    .replace(/\(?\s*incoterms?\s*\d{4}\s*\)?/i, '')
    .replace(/^[\s\-–,:]+|[\s\-–,:]+$/g, '')
    .replace(/^by\s+(air|sea|road)\s+/i, '')
    .trim();
}

export async function prefillDraft(ws: WorkspaceRow, user?: { name: string } | null): Promise<InstructionDraft> {
  const d = emptyDraft();
  const src: Record<string, FieldSource> = {};
  const set = (path: string, value: string, source: FieldSource): void => {
    if (!value) return;
    const keys = path.split('.');
    let cur = d as unknown as Record<string, unknown>;
    for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
    cur[keys[keys.length - 1]!] = value;
    src[path] = source;
  };

  const [{ rows: docs }, parties, { rows: dir }] = await Promise.all([
    query<DocRow>(
      `SELECT f.name AS file_name, de.extracted_fields->>'doc_type' AS doc_type, de.extracted_fields AS fields
       FROM document_extractions de JOIN files f ON f.id = de.file_id
       WHERE de.workspace_id = $1 AND f.is_latest = true
       ORDER BY f.created_at, f.name, f.id`,
      [ws.id],
    ),
    listParties(ws.id),
    query<DirectoryRow>('SELECT id, kind, name, address, country, signer, email, phone FROM org_directory ORDER BY name'),
  ]);
  const party = (role: string) => parties.find((p) => p.role === role && p.company_name.trim())?.company_name ?? '';
  const sender = party('sender');
  const intermediary = party('intermediary');
  const recipient = party('recipient');
  const trilateral = ws.contract_type === 'trilateral' && !!intermediary;
  const dirFind = (kinds: DirectoryRow['kind'][], name: string) =>
    name ? dir.find((r) => kinds.includes(r.kind) && sameCompany(r.name, name)) : undefined;

  d.category = categoryOf(ws.product_category);
  d.docs = baseDocs(d.category);
  d.labels = baseLabels(d.category);
  d.hints.contractType = ws.contract_type;
  d.hints.intermediary = latinPart(intermediary);
  d.hints.recipient = latinPart(recipient);

  // ── from (letterhead) ─────────────────────────────────────────────────────
  const own = dirFind(['own_company'], recipient) ?? dir.find((r) => r.kind === 'own_company');
  if (own) {
    d.from = { directoryId: own.id, name: own.name, address: own.address, signer: own.signer, email: own.email, phone: own.phone };
    src['from.name'] = 'template';
  } else {
    // First use (empty directory): our company = the buyer, address from its documents.
    set('from.name', latinPart(recipient), 'parties');
    const a = recipient ? addressFromDocs(docs, recipient) : null;
    if (a?.address) set('from.address', [a.address, a.country].filter(Boolean).join(', '), 'documents');
    if (user?.name) set('from.signer', user.name, 'parties');
  }

  // ── the contract the letter refers to: the one with the SUPPLIER ─────────
  const contracts = docs.filter((x) => x.doc_type === 'contract');
  const supplierContract =
    contracts.find((x) => sender && sameCompany(str(x.fields.seller), sender)) ??
    (trilateral ? contracts.find((x) => sameCompany(str(x.fields.buyer), intermediary)) : undefined) ??
    contracts[0];
  if (supplierContract) {
    set('contract.number', str(supplierContract.fields.contract_number), 'contract');
    set('contract.date', formatDate(str(supplierContract.fields.document_date)), 'contract');
    const inc = str(supplierContract.fields.incoterm);
    set('terms.incoterm', incotermCode(inc) ?? '', 'contract');
    set('terms.place', incotermPlace(inc), 'contract');
    set('terms.finalDestination', str(supplierContract.fields.final_destination), 'contract');
  }

  // ── product ───────────────────────────────────────────────────────────────
  const productDoc = supplierContract ?? docs.find((x) => x.doc_type === 'invoice');
  const productSrc: FieldSource = productDoc?.doc_type === 'contract' ? 'contract' : 'invoice';
  const line = (productDoc?.fields.line_items as { description?: string; quantity?: number; unit?: string }[] | undefined)?.[0];
  set('product.name', latinPart(str(productDoc?.fields.product_name) || str(line?.description)), productSrc);
  set('product.quantity', line?.quantity !== undefined ? str(line.quantity) : str(productDoc?.fields.net_weight_kg), productSrc);
  if (line?.unit) d.product.unit = /кг|kgs?/i.test(line.unit) ? 'kg' : line.unit;
  // Only this cargo's documents — `other` is where unrelated files land (e.g. the
  // registration certificate of a different finished product).
  const productDocs = docs.filter((x) => x.doc_type && x.doc_type !== 'other');
  const anyField = (k: string) => productDocs.map((x) => str(x.fields[k])).find(Boolean) ?? '';
  set('product.cas', anyField('cas_number'), 'documents');
  set('product.hsCode', formatHs(anyField('hs_code')), 'documents');
  const reg = productDocs.map((x) => str(x.fields.registration_number)).find((v) => /^(UA\/|[AА][BВ]-)/i.test(v));
  if (reg) set('product.regNumber', reg, 'documents');

  // ── previous shipment of the same supplier: HS code + package choices ─────
  if (sender) {
    // Same owner only (shipments are owner-scoped); candidates narrowed in SQL by
    // the supplier's first word, the fuzzy company match finishes in JS.
    const firstWord = sender.replace(/[«»"']/g, '').trim().split(/\s+/)[0] ?? '';
    const { rows: prev } = await query<{ draft: InstructionDraft }>(
      `SELECT si.draft FROM supplier_instructions si
       JOIN workspaces w ON w.id = si.workspace_id
       WHERE w.owner_id = $2 AND si.workspace_id <> $1 AND si.status IN ('approved', 'sent')
         AND si.draft->'consignor'->>'name' ILIKE $3
       ORDER BY si.created_at DESC LIMIT 20`,
      [ws.id, ws.owner_id, `%${firstWord.replace(/[%_\\]/g, '')}%`],
    );
    const p = prev.map((r) => r.draft).find((x) => sameCompany(x.consignor?.name ?? '', sender));
    if (p) {
      if (!d.product.hsCode && p.product?.hsCode) set('product.hsCode', p.product.hsCode, 'previous');
      const merge = (base: CheckItem[], old: CheckItem[] | undefined): CheckItem[] => {
        if (!old) return base;
        const out = base.map((b) => {
          const o = old.find((x) => x.key === b.key);
          return o ? { ...b, checked: o.checked } : b;
        });
        for (const o of old) if (o.source === 'custom' && !out.some((x) => x.key === o.key)) out.push({ ...o, source: 'previous' });
        return out;
      };
      d.docs = merge(d.docs, p.docs);
      d.labels = merge(d.labels, p.labels);
      if (p.labelNotes) d.labelNotes = p.labelNotes;
      d.hints.lessons.push('Перелік документів і поля етикетки взято з попередньої інструкції цьому постачальнику.');
    }
  }

  // ── consignor / consignee ─────────────────────────────────────────────────
  // The supply contract's own consignor / consignee clauses win (e.g. 4.2 / 4.3);
  // otherwise the supplier slot and the importer. The consignee defaults to the
  // IMPORTER even in a trilateral deal — goods ship straight to Ukraine; the
  // intermediary is the consignee only when the contract says so.
  const cConsignor = contractParty(supplierContract, 'consignor');
  const consignorName = cConsignor?.name || sender;
  if (consignorName) {
    const t = dirFind(['supplier'], consignorName);
    const a = cConsignor?.address
      ? { address: cConsignor.address, country: cConsignor.country }
      : (t ?? addressFromDocs(docs, consignorName));
    d.consignor = {
      name: latinPart(consignorName),
      address: a?.address ?? '',
      country: a?.country || (parties.find((x) => x.role === 'sender')?.country ?? ''),
    };
    src['consignor.name'] = cConsignor ? 'contract' : 'parties';
    if (a?.address) src['consignor.address'] = cConsignor?.address ? 'contract' : t ? 'template' : 'documents';
    if (t?.email) set('supplierEmail', t.email, 'template');
  }
  const cConsignee = contractParty(supplierContract, 'consignee');
  const consigneeIsIntermediary =
    trilateral && !!cConsignee && sameCompany(cConsignee.name, intermediary) && !sameCompany(cConsignee.name, recipient);
  const consigneeName = cConsignee?.name || recipient || (trilateral ? intermediary : '');
  if (consigneeName) {
    d.consigneeChoice = consigneeIsIntermediary || (!recipient && trilateral) ? 'intermediary' : 'recipient';
    const t = dirFind(['consignee', 'own_company'], consigneeName);
    const a = cConsignee?.address
      ? { address: cConsignee.address, country: cConsignee.country }
      : (t ?? addressFromDocs(docs, consigneeName));
    d.consignee = { name: latinPart(consigneeName), address: a?.address ?? '', country: a?.country ?? '' };
    src['consignee.name'] = cConsignee ? 'contract' : 'parties';
    if (a?.address) src['consignee.address'] = cConsignee?.address ? 'contract' : t ? 'template' : 'documents';
  }
  // The end buyer is a separate line only when the goods are consigned to the intermediary.
  if (d.consigneeChoice === 'intermediary' && recipient) {
    const a = dirFind(['own_company', 'consignee'], recipient) ?? addressFromDocs(docs, recipient);
    set('finalConsignee', [latinPart(recipient), a?.address].filter(Boolean).join(', '), 'parties');
  }

  // ── transport ─────────────────────────────────────────────────────────────
  if (ws.transport_mode && TRANSPORT[ws.transport_mode]) {
    d.terms.transport = TRANSPORT[ws.transport_mode]!;
    src['terms.transport'] = 'documents';
  }
  if (/^(CIF|CIP)$/.test(d.terms.incoterm)) {
    const ins = d.docs.find((x) => x.key === 'insurance');
    if (ins) ins.checked = true;
  }

  // ── originals: the team's contact template ────────────────────────────────
  const contact = dir.find((r) => r.kind === 'contact');
  if (contact) {
    d.originals = { contact: contact.signer || contact.name, phone: contact.phone, address: contact.address };
    for (const k of ['contact', 'phone', 'address'] as const) if (d.originals[k]) src[`originals.${k}`] = 'template';
  } else {
    // No contact template yet: originals go to our company (the letterhead), to
    // the person preparing the letter. The phone stays for the user (saved to a
    // template after the first time).
    set('originals.contact', d.from.signer || user?.name || '', 'parties');
    set('originals.phone', d.from.phone, 'template');
    set('originals.address', d.from.address, d.sources['from.address'] ?? 'documents');
  }

  // ── qdpro: code-specific requirements for the supplier ────────────────────
  const code = d.product.hsCode.replace(/\D/g, '');
  if (code.length === 10 && logistEnabled()) {
    try {
      const q = await uktzedFlags(code);
      for (const item of qdproDocs(q.flags)) {
        const i = d.docs.findIndex((x) => x.key === item.key);
        if (i >= 0) d.docs[i] = { ...d.docs[i]!, checked: true, source: 'qdpro' };
        else d.docs.push(item);
      }
      const controls = [
        q.flags.vet_control && 'ветконтроль',
        q.flags.phyto && 'фітоконтроль',
        q.flags.license && 'ліцензування',
        q.flags.dual_use && 'подвійне призначення',
      ].filter(Boolean);
      d.hints.qdproSummary = `qdpro: мито ${q.duty_full || '—'}${controls.length ? ` · ${controls.join(', ')}` : ' · без спецконтролю'}`;
      src['product.hsCode'] = src['product.hsCode'] ?? 'qdpro';
    } catch {
      d.hints.qdproSummary = 'qdpro недоступний — перелік документів базовий для категорії.';
    }
  }

  d.sources = src;
  return d;
}
