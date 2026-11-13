import { query } from '../db/pool.js';
import { buildFactBlock } from './factSheet.js';
import { sameCompany } from '../shipments/contextDerive.js';
import {
  bankAccountsOf,
  dangerousGoodsOf,
  declaresDanger,
  emptyFieldsOf,
  normIban,
  normUn,
} from '../reconciliation/documentChecks.js';
import { isLikelyDraft } from '../reconciliation/reconcile.js';

/**
 * A compact, always-present digest of a shipment's already-extracted documents,
 * injected into the system prompt so the agent has DURABLE document memory every
 * turn without a tool round-trip — and independent of what it read on prior turns
 * (which mitigates conversation-history loss). Deterministic, read-only, cheap.
 *
 * Each line is the document's «card»: headline fields plus its integrity flags
 * in words (blank fields, no signature / stamp, dangerous goods, bank details).
 */

// Bound the size so a huge shipment can't bloat the (cacheable) system prompt.
// The fact sheet (≤ FACTS_MAX) comes first; the per-document cards fill the rest.
const MAX = 6000;
const FACTS_MAX = 3200;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;

const DRAFT_NAME_RX = /draft|чернет|черновик|проект/i;
const SDS_NAME_RX = /(^|[^a-z])m?sds([^a-z]|$)|safety[\s_-]*data/i;
// «X_Страница_1.jpg», «X_page-0002.png», «X_Page_3.pdf»: one scanned page of a bigger document.
const PER_PAGE_RX = /[_\s-](?:страница|сторінка|page)[_\s-]*0*\d+/i;
const FILLED_RX = /заповнен|заполнен|filled/i;
const TRANSPORT_FIELD_RX = /container|контейнер|seal|пломб|desp?atch|vessel|судно|b\/l|bill of lading|коносамент/i;
const SIGNED_TYPES = new Set(['invoice', 'packing_list', 'contract', 'certificate_of_origin']);
const EMPTY_TYPES = new Set(['invoice', 'packing_list', 'contract', 'certificate_of_origin', 'quality_certificate']);

/**
 * The document's warning flags in words, e.g. «порожні поля Consignee, Batch No.;
 * без підпису; без печатки; небезпечний вантаж UN 1940 клас 8». Empty when none
 * (old extractions without the integrity fields have none). Follows the same
 * exemptions as the verdict checks: no integrity flags on drafts, safety data
 * sheets and per-page scans; signature / stamp only on invoice, packing list,
 * contract and certificates (a CoA is not flagged for them).
 */
export function documentFlags(f: Record<string, unknown>, fileName?: string | null): string[] {
  const flags: string[] = [];
  const nm = fileName ?? '';
  const docType = str(f.doc_type);
  const isVet = !!f.vet_certificate;
  const exempt = isLikelyDraft(nm) || DRAFT_NAME_RX.test(nm) || SDS_NAME_RX.test(nm);
  const perPage = PER_PAGE_RX.test(nm);
  const integrity = !exempt && !perPage;
  const isCoa = docType === 'quality_certificate';

  if (integrity && (EMPTY_TYPES.has(docType ?? '') || isVet)) {
    const empty = emptyFieldsOf(f).filter((e) => !FILLED_RX.test(e) && !(isCoa && TRANSPORT_FIELD_RX.test(e)));
    if (empty.length) flags.push(`порожні поля ${empty.slice(0, 6).join(', ')}${empty.length > 6 ? ' …' : ''}`);
  }
  if (integrity && !isCoa && (SIGNED_TYPES.has(docType ?? '') || isVet)) {
    if (f.signed === false) flags.push('без підпису');
    if (f.stamped === false) flags.push('без печатки');
  }
  const dg = dangerousGoodsOf(f);
  if (dg && declaresDanger(dg)) {
    flags.push(
      ['небезпечний вантаж', normUn(dg.un_number), dg.adr_class ? `клас ${dg.adr_class}` : null]
        .filter(Boolean)
        .join(' '),
    );
  }
  const buyer = str(f.buyer);
  const seller = str(f.seller);
  // A contract lists both parties' requisites; only a payment document's bank block matters.
  if (integrity && docType !== 'contract') {
    const toBuyer = bankAccountsOf(f).find(
      (a) => a.beneficiary && sameCompany(a.beneficiary, buyer) && !sameCompany(a.beneficiary, seller),
    );
    if (toBuyer) flags.push(`реквізити на ім’я покупця «${toBuyer.beneficiary}»`);
  }
  return flags;
}

/** Bank accounts of the document as «IBAN=…» (at most two, then «+N»). */
function ibans(f: Record<string, unknown>): string | null {
  const list = [...new Set(bankAccountsOf(f).map((a) => normIban(a.iban)).filter((x): x is string => !!x))];
  if (list.length === 0) return null;
  return `IBAN=${list.slice(0, 2).join(', ')}${list.length > 2 ? ` +${list.length - 2}` : ''}`;
}

interface DigestRow {
  name: string;
  fields: Record<string, unknown>;
  version?: number | null;
  created_at?: string | Date | null;
  lot_id?: string | null;
  head?: string | null;
}

export async function buildDocumentsDigest(workspaceId: string): Promise<string> {
  // Only the headline keys + a line count — not the whole extraction JSONB (a
  // packing list's line_items can be hundreds of rows), on every chat turn.
  const { rows } = await query<DigestRow>(
    `SELECT f.name AS name, f.version AS version, f.created_at AS created_at, fo.lot_id AS lot_id,
            (SELECT left(m.pages->0->>'markdown', 1500) FROM file_markdown m WHERE m.file_id = f.id) AS head,
            jsonb_build_object(
              'net_weight_kg', de.extracted_fields->'net_weight_kg',
              'gross_weight_kg', de.extracted_fields->'gross_weight_kg',
              'packages_count', de.extracted_fields->'packages_count',
              'contract_number', de.extracted_fields->'contract_number',
              'document_date', de.extracted_fields->'document_date',
              'shipment_date', de.extracted_fields->'shipment_date',
              'consignee_name', de.extracted_fields->'consignee_name',
              'transport_doc_number', de.extracted_fields->'transport_doc_number',
              'transport_doc_kind', de.extracted_fields->'transport_doc_kind',
              'container_numbers', de.extracted_fields->'container_numbers',
              'parties', de.extracted_fields->'parties',
              'field_pages', de.extracted_fields->'field_pages',
              'line_items_brief',
                CASE WHEN jsonb_typeof(de.extracted_fields->'line_items') = 'array'
                     THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                    'name', COALESCE(e.li->>'product_name', e.li->>'description'),
                                    'hs_code', e.li->'hs_code', 'quantity', e.li->'quantity',
                                    'unit', e.li->'unit', 'batch_no', e.li->'batch_no')), '[]'::jsonb)
                           FROM (SELECT li FROM jsonb_array_elements(de.extracted_fields->'line_items') AS li LIMIT 30) e)
                     ELSE '[]'::jsonb END,
              'doc_type', de.extracted_fields->'doc_type',
              'seller', de.extracted_fields->'seller',
              'buyer', de.extracted_fields->'buyer',
              'manufacturer', de.extracted_fields->'manufacturer',
              'invoice_number', de.extracted_fields->'invoice_number',
              'total_value', de.extracted_fields->'total_value',
              'currency', de.extracted_fields->'currency',
              'incoterm', de.extracted_fields->'incoterm',
              'country_of_origin', de.extracted_fields->'country_of_origin',
              'hs_code', de.extracted_fields->'hs_code',
              'registration_number', de.extracted_fields->'registration_number',
              'bank_accounts', de.extracted_fields->'bank_accounts',
              'dangerous_goods', de.extracted_fields->'dangerous_goods',
              'signed', de.extracted_fields->'signed',
              'stamped', de.extracted_fields->'stamped',
              'empty_fields', de.extracted_fields->'empty_fields',
              'line_items_count',
                CASE WHEN jsonb_typeof(de.extracted_fields->'line_items') = 'array'
                     THEN jsonb_array_length(de.extracted_fields->'line_items') ELSE 0 END
            ) AS fields
     FROM files f
     JOIN document_extractions de ON de.file_id = f.id
     LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE f.workspace_id = $1 AND f.is_latest = true
     ORDER BY f.created_at`,
    [workspaceId],
  );
  // Declared incoterms of the shipment and, for an FCL collection, its lots — one
  // small read for the fact sheet's trilateral in / out and per-lot grouping.
  const { rows: metaRows } = await query<{
    incoterm_in: string | null;
    incoterm_out: string | null;
    lots: { id: string; name: string; supplier: string | null; incoterm_in: string | null; incoterm_out: string | null }[] | null;
  }>(
    `SELECT w.incoterm_in, w.incoterm_out,
            (SELECT jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'supplier', NULLIF(l.supplier_name, ''),
                                                 'incoterm_in', l.incoterm_in, 'incoterm_out', l.incoterm_out)
                              ORDER BY l.position, l.created_at)
             FROM lots l WHERE l.workspace_id = w.id) AS lots
     FROM workspaces w WHERE w.id = $1`,
    [workspaceId],
  ).catch(() => ({ rows: [] }));
  const meta = metaRows[0];
  // Files not yet readable: the agent must not present an answer as covering
  // "all documents" while some are still being converted / extracted.
  const { rows: pending } = await query<{ name: string; status: string }>(
    `SELECT name, status FROM files
     WHERE workspace_id = $1 AND is_latest = true AND status IN ('queued', 'indexing', 'error')
     ORDER BY created_at, name`,
    [workspaceId],
  );
  const pendingNote = pending.length
    ? `⏳ Ще НЕ оброблено ${pending.length} файл(ів): ${pending
        .slice(0, 15)
        .map((p) => `${p.name}${p.status === 'error' ? ' (помилка)' : ''}`)
        .join(', ')}${pending.length > 15 ? ', …' : ''}. Їх дані поки недоступні — якщо питання ` +
      'стосується цих файлів, прямо скажи, що відповідь неповна, доки обробка не завершиться.'
    : '';
  if (rows.length === 0) return pendingNote;

  const cards = rows.map((r) => {
    const f = r.fields ?? {};
    const parts: string[] = [];
    const docType = str(f.doc_type);
    const add = (label: string, key: string): void => {
      const v = str(f[key]);
      if (v) parts.push(`${label}=${v}`);
    };
    add('продавець', 'seller');
    add('покупець', 'buyer');
    add('виробник', 'manufacturer');
    add('інвойс№', 'invoice_number');
    add('сума', 'total_value');
    add('валюта', 'currency');
    add('Incoterms', 'incoterm');
    add('походження', 'country_of_origin');
    add('HS', 'hs_code');
    add('реєстр№', 'registration_number');
    const bank = ibans(f);
    if (bank) parts.push(bank);
    const items = typeof f.line_items_count === 'number' ? f.line_items_count : 0;
    if (items) parts.push(`${items} позицій`);
    const flags = documentFlags(f, r.name);
    const head = `- ${r.name}${docType ? ` (${docType})` : ''}`;
    const warn = flags.length ? `; увага: ${flags.join('; ')}` : '';
    return {
      full: `${head}: ${parts.length ? parts.join(', ') : '(без ключових полів)'}${warn}`,
      // Over budget, a document without flags keeps just its name — the flags
      // are what the agent must not lose to the cut.
      short: flags.length ? null : head,
    };
  });

  // Fact sheet first; the cards get what is left of the budget and shrink first.
  const factBlock = buildFactBlock(
    rows.map((r) => ({
      name: r.name,
      fields: r.fields ?? {},
      version: r.version ?? null,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      lotId: r.lot_id ?? null,
      head: r.head ?? null,
    })),
    { incotermIn: meta?.incoterm_in ?? null, incotermOut: meta?.incoterm_out ?? null },
    FACTS_MAX,
    (meta?.lots ?? []).map((l) => ({ id: l.id, name: l.name, supplier: l.supplier, incotermIn: l.incoterm_in, incotermOut: l.incoterm_out })),
  );
  const prefix = [pendingNote, factBlock, factBlock ? 'КАРТКИ ДОКУМЕНТІВ:' : ''].filter(Boolean).join('\n');
  const budget = Math.max(800, MAX - prefix.length - 1);

  let digest = cards.map((c) => c.full).join('\n');
  if (digest.length > budget) digest = cards.map((c) => c.short ?? c.full).join('\n');
  if (digest.length > budget) digest = `${digest.slice(0, budget)}\n…(перелік скорочено)`;
  return prefix ? `${prefix}\n${digest}` : digest;
}
