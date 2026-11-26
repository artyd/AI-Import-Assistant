import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/pool.js';
import { contentHashOf, diskPathFor, storeFile } from '../lib/storage.js';
import { inferFileType } from '../shipments/folders.js';
import { enqueueIndexJob } from '../lib/queue/index.js';
import { publishFileStatus } from '../lib/events/fileStatus.js';
import { contractDataSchema, invoiceDataSchema, partySchema, type ContractData, type InvoiceData, type Party, type Unit } from './schema.js';

/**
 * The document builder ↔ a Штурман shipment (Постачання).
 * - draftFromShipment: what the shipment's own papers already say (extracted
 *   fields of its contract / invoice) → a contract and an invoice draft. Only
 *   stated values; anything missing stays empty for the logist.
 * - saveToShipment: the generated .docx goes into the shipment's files like an
 *   upload, so the worker reads, files and reconciles it with the rest.
 * Callers check ownership (getOwnedWorkspace) first.
 */
interface Extracted {
  doc_type?: string;
  also_contains?: string[];
  contract_number?: string | null;
  invoice_number?: string | null;
  currency?: string | null;
  incoterm?: string | null;
  buyer?: string | null;
  seller?: string | null;
  manufacturer?: string | null;
  registration_number?: string | null;
  country_of_origin?: string | null;
  document_date?: string | null;
  parties?: { name: string; role: string | null; country: string | null; address: string | null }[];
  line_items?: { description: string | null; quantity: number | null; unit: string | null; unit_price: number | null; hs_code: string | null; batch_no: string | null; product_name?: string | null }[];
}

const norm = (v: string) => v.toLowerCase().replace(/[«»"'“”.,()]/g, ' ').replace(/\b(llc|ltd|limited|тов|пат|private|pvt|co)\b/g, ' ').replace(/\s+/g, ' ').trim();

/** A directory company whose name matches, else just the name as printed. */
async function partyByName(name: string | null | undefined, address?: string | null): Promise<Party | null> {
  const n = (name ?? '').trim();
  if (!n) return null;
  const { rows } = await query<{ data: Party }>('SELECT data FROM doc_parties');
  const hit = rows.find((r) => {
    const a = norm(r.data.nameEn || '');
    const b = norm(r.data.nameUk || '');
    const x = norm(n);
    return (a && (a === x || a.includes(x) || x.includes(a))) || (b && (b === x || b.includes(x) || x.includes(b)));
  });
  return partySchema.parse(hit ? hit.data : { nameEn: n, addressEn: address ?? '' });
}

function unitOf(u: string | null): Unit {
  const v = (u ?? '').toLowerCase();
  if (/^(t|mt|tn|ton|тонн?|т)$/.test(v)) return 't';
  if (/pc|шт|pcs|piece/.test(v)) return 'pcs';
  if (/^(l|л|ltr|litre|liter)/.test(v)) return 'l';
  return 'kg';
}

export async function draftFromShipment(workspaceId: string): Promise<{ contract: ContractData; invoice: InvoiceData; sources: string[] }> {
  const { rows } = await query<{ name: string; fields: Extracted }>(
    `SELECT f.name, e.extracted_fields AS fields
       FROM document_extractions e JOIN files f ON f.id = e.file_id
      WHERE e.workspace_id = $1 AND f.is_latest = true
      ORDER BY e.extracted_at DESC`,
    [workspaceId],
  );
  const has = (r: { fields: Extracted }, t: string) => r.fields.doc_type === t || (r.fields.also_contains ?? []).includes(t);
  const contractDoc = rows.find((r) => has(r, 'contract'));
  const invoiceDoc = rows.find((r) => has(r, 'invoice') || has(r, 'proforma_invoice'));
  const main = contractDoc?.fields ?? invoiceDoc?.fields ?? {};
  const lines = (invoiceDoc?.fields.line_items?.length ? invoiceDoc.fields.line_items : main.line_items) ?? [];

  const seller = (await partyByName(main.seller ?? main.parties?.find((p) => /seller|продав|shipper|exporter/i.test(p.role ?? ''))?.name)) ?? undefined;
  const buyerName = main.buyer ?? main.parties?.find((p) => /buyer|покуп|consignee|importer/i.test(p.role ?? ''))?.name;
  const buyer = (await partyByName(buyerName)) ?? undefined;
  const cur = (main.currency ?? '').toUpperCase() === 'EUR' ? 'EUR' : 'USD';
  const items = lines
    .filter((l) => (l.description ?? l.product_name ?? '').trim())
    .map((l) => ({
      nameEn: (l.description ?? l.product_name ?? '').trim(),
      hs: (l.hs_code ?? main.line_items?.[0]?.hs_code ?? '').replace(/\s+/g, ''),
      reg: main.registration_number ?? '',
      manufacturer: main.manufacturer ?? '',
      countryEn: main.country_of_origin ?? '',
      unit: unitOf(l.unit),
      qty: l.quantity ?? 0,
      price: l.unit_price ?? 0,
    }));

  const contract = contractDataSchema.parse({
    number: main.contract_number ?? '',
    date: /^\d{4}-\d{2}-\d{2}$/.test(contractDoc?.fields.document_date ?? '') ? contractDoc!.fields.document_date : '',
    seller,
    buyer,
    currency: cur,
    incoterm: (main.incoterm ?? '').split(/\s+/)[0]?.toUpperCase() || 'CPT',
    incoPlaceEn: (main.incoterm ?? '').split(/\s+/).slice(1).join(' '),
    items,
  });
  const invoice = invoiceDataSchema.parse({
    number: '',
    contractRef: main.contract_number ?? '',
    toName: buyer?.nameEn ?? '',
    toAddress: buyer?.addressEn ?? '',
    consignorName: seller?.nameEn ?? '',
    consignorAddress: seller?.addressEn ?? '',
    currency: cur,
    incoterm: contract.incoterm,
    incoPlaceEn: contract.incoPlaceEn,
    originEn: main.country_of_origin ?? '',
    items: items.map((i) => ({ nameEn: i.nameEn, reg: i.reg, manufacturer: i.manufacturer, countryEn: i.countryEn, unit: i.unit, qty: i.qty, price: i.price })),
    batches: lines
      .filter((l) => (l.description ?? l.product_name ?? '').trim())
      .map((l) => ({ nameEn: (l.description ?? l.product_name ?? '').trim(), batch: l.batch_no ?? '', net: unitOf(l.unit) === 'kg' ? l.quantity ?? 0 : 0 })),
  });
  return { contract, invoice, sources: [contractDoc?.name, invoiceDoc?.name].filter((v): v is string => Boolean(v)) };
}

/** Puts a generated file into the shipment exactly like an upload (dedup by content). */
export async function saveToShipment(workspaceId: string, fileName: string, buf: Buffer): Promise<{ fileId: string; duplicateOf: string | null }> {
  const hash = contentHashOf(buf);
  const { rows: dup } = await query<{ id: string; name: string }>(
    'SELECT id, name FROM files WHERE workspace_id = $1 AND content_hash = $2 AND is_latest = true LIMIT 1',
    [workspaceId, hash],
  );
  if (dup[0]) return { fileId: dup[0].id, duplicateOf: dup[0].name };
  const fileId = uuidv4();
  const type = inferFileType(fileName);
  const diskPath = diskPathFor(workspaceId, fileId, fileName);
  await storeFile(workspaceId, fileId, fileName, buf);
  await query(
    `INSERT INTO files (id, workspace_id, folder_id, name, type, disk_path, size_bytes, status, version, is_latest, content_hash)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, 'queued', 1, true, $7)`,
    [fileId, workspaceId, fileName, type, diskPath, buf.length, hash],
  );
  await enqueueIndexJob(fileId);
  await publishFileStatus(workspaceId, { fileId, status: 'queued', name: fileName });
  return { fileId, duplicateOf: null };
}
