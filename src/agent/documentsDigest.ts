import { query } from '../db/pool.js';
import { sameCompany } from '../shipments/contextDerive.js';
import {
  bankAccountsOf,
  dangerousGoodsOf,
  declaresDanger,
  emptyFieldsOf,
  normIban,
  normUn,
} from '../reconciliation/documentChecks.js';

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
const MAX = 4000;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;

/**
 * The document's warning flags in words, e.g. «порожні поля Consignee, Batch No.;
 * без підпису; без печатки; небезпечний вантаж UN 1940 клас 8». Empty when none
 * (old extractions without the integrity fields have none).
 */
export function documentFlags(f: Record<string, unknown>): string[] {
  const flags: string[] = [];
  const empty = emptyFieldsOf(f);
  if (empty.length) flags.push(`порожні поля ${empty.slice(0, 6).join(', ')}${empty.length > 6 ? ' …' : ''}`);
  if (f.signed === false) flags.push('без підпису');
  if (f.stamped === false) flags.push('без печатки');
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
  const toBuyer = bankAccountsOf(f).find(
    (a) => a.beneficiary && sameCompany(a.beneficiary, buyer) && !sameCompany(a.beneficiary, seller),
  );
  if (toBuyer) flags.push(`реквізити на ім’я покупця «${toBuyer.beneficiary}»`);
  return flags;
}

/** Bank accounts of the document as «IBAN=…» (at most two, then «+N»). */
function ibans(f: Record<string, unknown>): string | null {
  const list = [...new Set(bankAccountsOf(f).map((a) => normIban(a.iban)).filter((x): x is string => !!x))];
  if (list.length === 0) return null;
  return `IBAN=${list.slice(0, 2).join(', ')}${list.length > 2 ? ` +${list.length - 2}` : ''}`;
}

export async function buildDocumentsDigest(workspaceId: string): Promise<string> {
  // Only the headline keys + a line count — not the whole extraction JSONB (a
  // packing list's line_items can be hundreds of rows), on every chat turn.
  const { rows } = await query<{ name: string; fields: Record<string, unknown> }>(
    `SELECT f.name AS name,
            jsonb_build_object(
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
     WHERE f.workspace_id = $1 AND f.is_latest = true
     ORDER BY f.created_at`,
    [workspaceId],
  );
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
    const flags = documentFlags(f);
    const head = `- ${r.name}${docType ? ` (${docType})` : ''}`;
    const warn = flags.length ? `; увага: ${flags.join('; ')}` : '';
    return {
      full: `${head}: ${parts.length ? parts.join(', ') : '(без ключових полів)'}${warn}`,
      // Over budget, a document without flags keeps just its name — the flags
      // are what the agent must not lose to the cut.
      short: flags.length ? null : head,
    };
  });

  let digest = cards.map((c) => c.full).join('\n');
  if (digest.length > MAX) digest = cards.map((c) => c.short ?? c.full).join('\n');
  if (digest.length > MAX) digest = `${digest.slice(0, MAX)}\n…(перелік скорочено)`;
  return pendingNote ? `${pendingNote}\n${digest}` : digest;
}
