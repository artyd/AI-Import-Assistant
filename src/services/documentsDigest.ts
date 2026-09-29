import { query } from '../db/pool.js';

/**
 * A compact, always-present digest of a shipment's already-extracted documents,
 * injected into the system prompt so the agent has DURABLE document memory every
 * turn without a tool round-trip — and independent of what it read on prior turns
 * (which mitigates conversation-history loss). Deterministic, read-only, cheap.
 */
export async function buildDocumentsDigest(workspaceId: string): Promise<string> {
  const { rows } = await query<{ name: string; fields: Record<string, unknown> }>(
    `SELECT f.name AS name, de.extracted_fields AS fields
     FROM files f
     JOIN LATERAL (
       SELECT extracted_fields FROM document_extractions
       WHERE file_id = f.id ORDER BY extracted_at DESC LIMIT 1
     ) de ON true
     WHERE f.workspace_id = $1 AND f.is_latest = true
     ORDER BY f.created_at`,
    [workspaceId],
  );
  if (rows.length === 0) return '';

  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;

  const lines: string[] = [];
  for (const r of rows) {
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
    const items = Array.isArray(f.line_items) ? f.line_items.length : 0;
    if (items) parts.push(`${items} позицій`);
    const head = `- ${r.name}${docType ? ` (${docType})` : ''}`;
    lines.push(parts.length ? `${head}: ${parts.join(', ')}` : `${head}: (без ключових полів)`);
  }

  let digest = lines.join('\n');
  // Bound the size so a huge shipment can't bloat the (cacheable) system prompt.
  const MAX = 4000;
  if (digest.length > MAX) digest = `${digest.slice(0, MAX)}\n…(перелік скорочено)`;
  return digest;
}
