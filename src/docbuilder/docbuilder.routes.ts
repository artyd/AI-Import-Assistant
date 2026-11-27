import { createRequire } from 'node:module';
import type { Archiver } from 'archiver';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { query } from '../db/pool.js';
import { getOwnedWorkspace } from '../shipments/workspaceAccess.js';
import {
  DOC_KINDS,
  DOC_STATUSES,
  directoryPartySchema,
  parseData,
  productSchema,
  type AppendixData,
  type ContractData,
  type DocData,
  type DocKind,
  type DocStatus,
  type UaInvoiceData,
} from './schema.js';
import { TemplateError, bundledTemplate, docxToPdf, downloadName, fillTemplate, renderDocx, renderPreviewHtml } from './render.js';
import { appendixFromContract, documentTitle, invoiceFromAppendix, invoiceFromContract } from './fromContract.js';
import { docOut, insertDoc, loadRow, logEvent, type DocRow } from './store.js';
import { documentTotal, tagsFor } from './templateData.js';
import { checkDocument, suggestNumber } from './checks.js';
import { extractCompanies } from './extractParties.js';
import { draftFromShipment, saveToShipment } from './shipment.js';
import { sampleData } from './sample.js';

const require = createRequire(import.meta.url);
const { ZipArchive } = require('archiver') as { ZipArchive: new (options?: { zlib?: { level?: number } }) => Archiver };

/**
 * Document builder (spec 012): a team-shared directory of companies and goods,
 * saved trade documents with a draft → checked → sent workflow and versions,
 * Word / PDF output from the team's own templates, checks before sending, and
 * the bridge to Штурман shipments. Not shipment-scoped — every authenticated
 * user works in one space, like the instruction directory; the shipment bridge
 * checks ownership of the shipment it touches.
 */
const uuid = z.string().uuid();
const kindSchema = z.enum(DOC_KINDS);
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function disposition(name: { ascii: string; utf8: string }): string {
  return `attachment; filename="${name.ascii}"; filename*=UTF-8''${encodeURIComponent(name.utf8)}`;
}

function nameFor(kind: DocKind, data: DocData, ext: 'docx' | 'pdf') {
  const label = kind === 'ua_invoice' ? ((data as UaInvoiceData).docType === 'rahunok' ? 'Рахунок' : 'Накладна') : kind === 'appendix' ? `Додаток ${data.number} до` : undefined;
  const number = kind === 'appendix' ? (data as AppendixData).contractNumber : data.number;
  return downloadName(kind, number, ext, label);
}

async function sendFile(reply: FastifyReply, kind: DocKind, data: DocData, format: 'docx' | 'pdf'): Promise<FastifyReply> {
  const docx = await renderDocx(kind, data);
  if (format === 'docx') return reply.header('content-type', DOCX).header('content-disposition', disposition(nameFor(kind, data, 'docx'))).send(docx);
  const pdf = await docxToPdf(docx);
  return reply.header('content-type', 'application/pdf').header('content-disposition', disposition(nameFor(kind, data, 'pdf'))).send(pdf);
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** A seller's own invoice letterhead, if the directory card names one. */
async function sellerInvoiceTemplate(sellerName: string): Promise<string | null> {
  if (!sellerName.trim()) return null;
  const { rows } = await query<{ data: { invoiceTemplateId?: string | null } }>(
    "SELECT data FROM doc_parties WHERE role = 'seller' AND lower(name) = lower($1) LIMIT 1",
    [sellerName.trim()],
  );
  return rows[0]?.data.invoiceTemplateId ?? null;
}

function safeData(kind: DocKind, raw: unknown): { ok: true; value: DocData } | { ok: false; issues: unknown } {
  try {
    return { ok: true, value: parseData(kind, raw) };
  } catch (err) {
    return { ok: false, issues: err instanceof z.ZodError ? err.issues : String(err) };
  }
}

function templateFail(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof TemplateError) return reply.code(422).send({ error: 'template_error', message: err.message, details: err.details });
  return null;
}

export async function docBuilderRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // ---------- directory: parties ----------
  app.get('/api/docbuilder/parties', async (_req, reply) => {
    const { rows } = await query<{ id: string; role: string; data: Record<string, unknown> }>('SELECT id, role, data FROM doc_parties ORDER BY role, lower(name)');
    return reply.send({ parties: rows.map((r) => ({ ...directoryPartySchema.parse(r.data), id: r.id, role: r.role })) });
  });

  app.post('/api/docbuilder/parties', async (req, reply) => {
    const parsed = directoryPartySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    const p = parsed.data;
    if (!p.nameEn && !p.nameUk) return reply.code(400).send({ error: 'invalid_request', message: 'name required' });
    const { rows } = await query<{ id: string }>('INSERT INTO doc_parties (role, name, data, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [p.role, p.nameEn || p.nameUk, p, req.user!.sub]);
    return reply.code(201).send({ party: { ...p, id: rows[0]!.id } });
  });

  app.put<{ Params: { id: string } }>('/api/docbuilder/parties/:id', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    const parsed = directoryPartySchema.safeParse(req.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const p = parsed.data;
    const { rowCount } = await query('UPDATE doc_parties SET role = $2, name = $3, data = $4, updated_at = now() WHERE id = $1', [id.data, p.role, p.nameEn || p.nameUk, p]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ party: { ...p, id: id.data } });
  });

  app.delete<{ Params: { id: string } }>('/api/docbuilder/parties/:id', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rowCount } = await query('DELETE FROM doc_parties WHERE id = $1', [id.data]);
    return rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
  });

  // ---------- directory: products ----------
  app.get('/api/docbuilder/products', async (_req, reply) => {
    const { rows } = await query<{ id: string; data: Record<string, unknown> }>('SELECT id, data FROM doc_products ORDER BY lower(name)');
    return reply.send({ products: rows.map((r) => ({ ...productSchema.parse(r.data), id: r.id })) });
  });

  app.post('/api/docbuilder/products', async (req, reply) => {
    const parsed = productSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    const p = parsed.data;
    if (!p.nameEn && !p.nameUk) return reply.code(400).send({ error: 'invalid_request', message: 'name required' });
    const { rows } = await query<{ id: string }>('INSERT INTO doc_products (name, data, created_by) VALUES ($1, $2, $3) RETURNING id', [p.nameEn || p.nameUk, p, req.user!.sub]);
    return reply.code(201).send({ product: { ...p, id: rows[0]!.id } });
  });

  app.put<{ Params: { id: string } }>('/api/docbuilder/products/:id', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    const parsed = productSchema.safeParse(req.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const p = parsed.data;
    const { rowCount } = await query('UPDATE doc_products SET name = $2, data = $3, updated_at = now() WHERE id = $1', [id.data, p.nameEn || p.nameUk, p]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ product: { ...p, id: id.data } });
  });

  app.delete<{ Params: { id: string } }>('/api/docbuilder/products/:id', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rowCount } = await query('DELETE FROM doc_products WHERE id = $1', [id.data]);
    return rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
  });

  /** «Додати з документа»: candidates for the directory from an uploaded contract / invoice. */
  app.post('/api/docbuilder/extract', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: 'no_file' });
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'no_file' });
    if (!/\.(pdf|docx?|xlsx?|png|jpe?g)$/i.test(part.filename)) {
      part.file.resume();
      return reply.code(415).send({ error: 'unsupported_type', message: 'PDF, Word, Excel або фото' });
    }
    let buf: Buffer;
    try {
      buf = await part.toBuffer();
    } catch {
      return reply.code(413).send({ error: 'too_large' });
    }
    const result = await extractCompanies(buf, part.filename);
    return reply.send(result);
  });

  // ---------- documents ----------
  app.get<{ Querystring: { kind?: string } }>('/api/docbuilder/documents', async (req, reply) => {
    const kind = kindSchema.safeParse(req.query.kind);
    const { rows } = kind.success
      ? await query<DocRow>('SELECT * FROM doc_documents WHERE kind = $1 ORDER BY updated_at DESC LIMIT 500', [kind.data])
      : await query<DocRow>('SELECT * FROM doc_documents ORDER BY updated_at DESC LIMIT 500');
    return reply.send({
      documents: rows.map((r) => {
        const data = parseData(r.kind, r.data);
        return {
          id: r.id,
          kind: r.kind,
          number: r.number,
          title: r.title,
          contractId: r.contract_id,
          status: r.status,
          version: r.version,
          parentId: r.parent_id,
          date: data.date,
          currency: r.kind === 'ua_invoice' ? 'UAH' : (data as ContractData).currency,
          total: documentTotal(r.kind, data),
          updatedAt: r.updated_at,
        };
      }),
    });
  });

  app.get<{ Params: { id: string } }>('/api/docbuilder/documents/:id', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await loadRow(id.data);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ document: docOut(row) });
  });

  const createBody = z.object({ kind: kindSchema, data: z.unknown(), contractId: uuid.nullable().optional(), workspaceId: uuid.nullable().optional() });

  app.post('/api/docbuilder/documents', async (req, reply) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', issues: body.error.issues });
    const data = safeData(body.data.kind, body.data.data);
    if (!data.ok) return reply.code(400).send({ error: 'invalid_request', issues: data.issues });
    if (body.data.workspaceId && !(await getOwnedWorkspace(req.user!.sub, body.data.workspaceId))) return reply.code(404).send({ error: 'not_found' });
    const row = await insertDoc(body.data.kind, data.value, { contractId: body.data.contractId, workspaceId: body.data.workspaceId, userId: req.user!.sub });
    await logEvent(row.id, req.user!.sub, 'created');
    return reply.code(201).send({ document: docOut(row) });
  });

  app.put<{ Params: { id: string } }>('/api/docbuilder/documents/:id', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await loadRow(id.data);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    // A checked or sent document is frozen: back to draft first, or a new version.
    if (row.status !== 'draft') return reply.code(409).send({ error: 'locked', message: 'Документ перевірено або відправлено — поверніть у чернетку чи створіть нову версію.' });
    const data = safeData(row.kind, (req.body as { data?: unknown } | undefined)?.data);
    if (!data.ok) return reply.code(400).send({ error: 'invalid_request', issues: data.issues });
    const { rows } = await query<DocRow>('UPDATE doc_documents SET number = $2, title = $3, data = $4, updated_at = now() WHERE id = $1 RETURNING *', [
      id.data,
      data.value.number,
      documentTitle(row.kind, data.value),
      data.value,
    ]);
    // One «edited» line per user per 10 minutes, not one per keystroke-save.
    await query(
      `INSERT INTO doc_document_events (document_id, user_id, action)
       SELECT $1, $2, 'edited' WHERE NOT EXISTS (
         SELECT 1 FROM doc_document_events WHERE document_id = $1 AND user_id = $2 AND action = 'edited' AND at > now() - interval '10 minutes')`,
      [id.data, req.user!.sub],
    ).catch(() => undefined);
    return reply.send({ document: docOut(rows[0]!) });
  });

  app.delete<{ Params: { id: string } }>('/api/docbuilder/documents/:id', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rowCount } = await query('DELETE FROM doc_documents WHERE id = $1', [id.data]);
    return rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
  });

  /** draft → checked → sent (and back to draft from checked). */
  app.post<{ Params: { id: string } }>('/api/docbuilder/documents/:id/status', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    const body = z.object({ status: z.enum(DOC_STATUSES) }).safeParse(req.body);
    if (!id.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await loadRow(id.data);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const to = body.data.status;
    const allowed: Record<DocStatus, DocStatus[]> = { draft: ['checked', 'sent'], checked: ['draft', 'sent'], sent: [] };
    if (!allowed[row.status].includes(to)) return reply.code(409).send({ error: 'bad_transition', message: 'Відправлений документ не змінюється — створіть нову версію.' });
    const { rows } = await query<DocRow>('UPDATE doc_documents SET status = $2, updated_at = now() WHERE id = $1 RETURNING *', [id.data, to]);
    await logEvent(id.data, req.user!.sub, `status:${to}`);
    return reply.send({ document: docOut(rows[0]!) });
  });

  /** A new editable version of a checked / sent document (the old one stays as it was). */
  app.post<{ Params: { id: string } }>('/api/docbuilder/documents/:id/version', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await loadRow(id.data);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const created = await insertDoc(row.kind, parseData(row.kind, row.data), { contractId: row.contract_id, parentId: row.id, version: row.version + 1, workspaceId: row.workspace_id, userId: req.user!.sub });
    await logEvent(created.id, req.user!.sub, 'version', `з версії ${row.version}`);
    await logEvent(row.id, req.user!.sub, 'version', `створено версію ${row.version + 1}`);
    return reply.code(201).send({ document: docOut(created) });
  });

  app.get<{ Params: { id: string } }>('/api/docbuilder/documents/:id/events', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rows } = await query<{ action: string; note: string; at: string; user_name: string | null }>(
      `SELECT e.action, e.note, e.at, COALESCE(NULLIF(u.name, ''), u.email) AS user_name
         FROM doc_document_events e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.document_id = $1 ORDER BY e.at DESC LIMIT 100`,
      [id.data],
    );
    return reply.send({ events: rows.map((r) => ({ action: r.action, note: r.note, at: r.at, user: r.user_name ?? '' })) });
  });

  /** A new invoice + packing list draft from a saved contract or annex. */
  app.post<{ Params: { id: string } }>('/api/docbuilder/documents/:id/invoice', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await loadRow(id.data);
    if (!row || (row.kind !== 'contract' && row.kind !== 'appendix')) return reply.code(404).send({ error: 'not_found' });
    const invoice = row.kind === 'contract' ? invoiceFromContract(parseData('contract', row.data), todayIso()) : invoiceFromAppendix(parseData('appendix', row.data), todayIso());
    invoice.number = await suggestNumber('invoice', null);
    invoice.templateId = await sellerInvoiceTemplate((parseData(row.kind, row.data) as ContractData).seller.nameEn);
    const created = await insertDoc('invoice', invoice, { contractId: row.id, workspaceId: row.workspace_id, userId: req.user!.sub });
    await logEvent(created.id, req.user!.sub, 'created', `з ${row.kind === 'contract' ? 'контракту' : 'додатку'} ${row.title}`);
    return reply.code(201).send({ document: docOut(created) });
  });

  /** The next annex to a saved contract. */
  app.post<{ Params: { id: string } }>('/api/docbuilder/documents/:id/appendix', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await loadRow(id.data);
    if (!row || row.kind !== 'contract') return reply.code(404).send({ error: 'not_found' });
    const n = await suggestNumber('appendix', row.id);
    const annex = appendixFromContract(parseData('contract', row.data), n, todayIso());
    const created = await insertDoc('appendix', annex, { contractId: row.id, workspaceId: row.workspace_id, userId: req.user!.sub });
    await logEvent(created.id, req.user!.sub, 'created', `додаток № ${n} до ${row.number}`);
    return reply.code(201).send({ document: docOut(created) });
  });

  for (const fmt of ['docx', 'pdf'] as const) {
    app.get<{ Params: { id: string } }>(`/api/docbuilder/documents/:id/${fmt}`, async (req, reply) => {
      const id = uuid.safeParse(req.params.id);
      if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
      const row = await loadRow(id.data);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      try {
        return await sendFile(reply, row.kind, parseData(row.kind, row.data), fmt);
      } catch (err) {
        return templateFail(reply, err) ?? reply.code(500).send({ error: 'render_failed' });
      }
    });
  }

  /** Everything that belongs together, in one ZIP: a contract with its annexes and invoices, or an invoice with its contract. */
  app.get<{ Params: { id: string }; Querystring: { pdf?: string } }>('/api/docbuilder/documents/:id/bundle.zip', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await loadRow(id.data);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const rootId = row.kind === 'contract' ? row.id : row.contract_id;
    const { rows } = rootId
      ? await query<DocRow>(
          `SELECT * FROM doc_documents WHERE id = $1 OR contract_id = $1
              OR contract_id IN (SELECT id FROM doc_documents WHERE contract_id = $1)
              OR id = $2 ORDER BY created_at`,
          [rootId, row.id],
        )
      : { rows: [row] };
    const withPdf = req.query.pdf === '1';
    const files: { name: string; buf: Buffer }[] = [];
    for (const r of rows) {
      const data = parseData(r.kind, r.data);
      try {
        const docx = await renderDocx(r.kind, data);
        files.push({ name: nameFor(r.kind, data, 'docx').utf8, buf: docx });
        if (withPdf) files.push({ name: nameFor(r.kind, data, 'pdf').utf8, buf: await docxToPdf(docx) });
      } catch (err) {
        return templateFail(reply, err) ?? reply.code(500).send({ error: 'render_failed', message: `Не вдалося сформувати ${r.title}` });
      }
    }
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const seen = new Map<string, number>();
    for (const f of files) {
      const n = seen.get(f.name) ?? 0;
      seen.set(f.name, n + 1);
      archive.append(f.buf, { name: n ? f.name.replace(/(\.\w+)$/, ` (${n + 1})$1`) : f.name });
    }
    const zipName = downloadName(row.kind, (row.kind === 'contract' ? row.number : row.title.split(' · ')[0]) || 'documents', 'docx');
    reply
      .header('content-type', 'application/zip')
      .header('content-disposition', disposition({ ascii: zipName.ascii.replace(/\.docx$/, '.zip'), utf8: `Пакет ${zipName.utf8.replace(/\.docx$/, '.zip')}` }));
    void archive.finalize();
    return reply.send(archive);
  });

  /** The generated .docx into a Штурман shipment's files (read, filed and reconciled by the worker). */
  app.post<{ Params: { id: string } }>('/api/docbuilder/documents/:id/to-shipment', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    const body = z.object({ workspaceId: uuid }).safeParse(req.body);
    if (!id.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = await getOwnedWorkspace(req.user!.sub, body.data.workspaceId);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const row = await loadRow(id.data);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const data = parseData(row.kind, row.data);
    let docx: Buffer;
    try {
      docx = await renderDocx(row.kind, data);
    } catch (err) {
      return templateFail(reply, err) ?? reply.code(500).send({ error: 'render_failed' });
    }
    const res = await saveToShipment(ws.id, nameFor(row.kind, data, 'docx').utf8, docx);
    await query('UPDATE doc_documents SET workspace_id = $2 WHERE id = $1', [row.id, ws.id]);
    await logEvent(row.id, req.user!.sub, 'to_shipment', `№${ws.number ?? ''}`);
    return reply.send({ fileId: res.fileId, duplicateOf: res.duplicateOf, workspaceId: ws.id });
  });

  /** Drafts of a contract and an invoice from what a shipment's own papers already say. */
  app.get<{ Params: { workspaceId: string } }>('/api/docbuilder/from-shipment/:workspaceId', async (req, reply) => {
    const wid = uuid.safeParse(req.params.workspaceId);
    if (!wid.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = await getOwnedWorkspace(req.user!.sub, wid.data);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    return reply.send(await draftFromShipment(ws.id));
  });

  // ---------- checks & numbers ----------
  const checkBody = z.object({ kind: kindSchema, data: z.unknown(), id: uuid.nullable().optional(), contractId: uuid.nullable().optional() });
  app.post('/api/docbuilder/check', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = checkBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', issues: body.error.issues });
    const data = safeData(body.data.kind, body.data.data);
    if (!data.ok) return reply.code(400).send({ error: 'invalid_request', issues: data.issues });
    const findings = await checkDocument(body.data.kind, data.value, { id: body.data.id ?? null, contractId: body.data.contractId ?? null });
    return reply.send({ findings });
  });

  app.get<{ Querystring: { kind?: string; contractId?: string } }>('/api/docbuilder/next-number', async (req, reply) => {
    const kind = kindSchema.safeParse(req.query.kind);
    if (!kind.success) return reply.code(400).send({ error: 'invalid_request' });
    const cid = uuid.safeParse(req.query.contractId);
    return reply.send({ number: await suggestNumber(kind.data, cid.success ? cid.data : null) });
  });

  // ---------- stateless render: live preview + download of an unsaved draft ----------
  const renderBody = z.object({ kind: kindSchema, data: z.unknown(), format: z.enum(['docx', 'html', 'pdf']).default('html') });

  app.post('/api/docbuilder/render', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = renderBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', issues: body.error.issues });
    const data = safeData(body.data.kind, body.data.data);
    if (!data.ok) return reply.code(400).send({ error: 'invalid_request', issues: data.issues });
    try {
      if (body.data.format !== 'html') return await sendFile(reply, body.data.kind, data.value, body.data.format);
      return reply.send({ html: await renderPreviewHtml(body.data.kind, data.value), total: documentTotal(body.data.kind, data.value) });
    } catch (err) {
      return templateFail(reply, err) ?? reply.code(500).send({ error: 'render_failed' });
    }
  });

  // ---------- templates ----------
  app.get('/api/docbuilder/templates', async (_req, reply) => {
    const { rows } = await query<{ id: string; kind: DocKind; name: string; created_at: string }>('SELECT id, kind, name, created_at FROM doc_templates ORDER BY kind, lower(name)');
    return reply.send({ templates: rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, createdAt: r.created_at })) });
  });

  /** The tags a template of this kind can use (for people who make their own .docx). */
  app.get<{ Querystring: { kind?: string } }>('/api/docbuilder/templates/tags', async (req, reply) => {
    const kind = kindSchema.safeParse(req.query.kind);
    if (!kind.success) return reply.code(400).send({ error: 'invalid_request' });
    const tags = tagsFor(kind.data, sampleData(kind.data));
    const out: { tag: string; example: string }[] = [];
    for (const [k, v] of Object.entries(tags)) {
      if (Array.isArray(v)) {
        const first = (v[0] ?? {}) as Record<string, unknown>;
        out.push({ tag: `{#${k}} … {/${k}}`, example: `цикл по рядках: ${Object.keys(first).map((x) => `{${x}}`).join(' ')}` });
      } else if (typeof v === 'boolean') out.push({ tag: `{#${k}} … {/${k}}`, example: 'показати, якщо так' });
      else out.push({ tag: `{${k}}`, example: String(v).slice(0, 80) });
    }
    return reply.send({ tags: out });
  });

  app.get<{ Params: { kind: string } }>('/api/docbuilder/templates/default/:kind', async (req, reply) => {
    const kind = kindSchema.safeParse(req.params.kind);
    if (!kind.success) return reply.code(400).send({ error: 'invalid_request' });
    const buf = await bundledTemplate(kind.data);
    return reply.header('content-type', DOCX).header('content-disposition', disposition({ ascii: `template_${kind.data}.docx`, utf8: `Шаблон ${kind.data}.docx` })).send(buf);
  });

  app.post('/api/docbuilder/templates', async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: 'no_file' });
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'no_file' });
    const fields = part.fields as Record<string, { value?: unknown } | undefined>;
    const kind = kindSchema.safeParse(fields.kind?.value);
    const name = z.string().trim().min(1).max(200).safeParse(fields.name?.value ?? part.filename);
    if (!kind.success || !name.success || !/\.docx$/i.test(part.filename)) {
      part.file.resume();
      return reply.code(400).send({ error: 'invalid_request', message: 'Потрібен .docx, тип документа і назва' });
    }
    const buf = await part.toBuffer();
    // Prove it fills before it is stored.
    try {
      fillTemplate(buf, tagsFor(kind.data, sampleData(kind.data)));
    } catch (err) {
      return templateFail(reply, err) ?? reply.code(422).send({ error: 'template_error', message: 'Файл не є шаблоном Word' });
    }
    const { rows } = await query<{ id: string; created_at: string }>('INSERT INTO doc_templates (kind, name, file, created_by) VALUES ($1, $2, $3, $4) RETURNING id, created_at', [kind.data, name.data, buf, req.user!.sub]);
    return reply.code(201).send({ template: { id: rows[0]!.id, kind: kind.data, name: name.data, createdAt: rows[0]!.created_at } });
  });

  app.get<{ Params: { id: string } }>('/api/docbuilder/templates/:id/file', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rows } = await query<{ file: Buffer; name: string }>('SELECT file, name FROM doc_templates WHERE id = $1', [id.data]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    return reply.header('content-type', DOCX).header('content-disposition', disposition({ ascii: 'template.docx', utf8: `${rows[0].name}.docx` })).send(rows[0].file);
  });

  app.delete<{ Params: { id: string } }>('/api/docbuilder/templates/:id', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rowCount } = await query('DELETE FROM doc_templates WHERE id = $1', [id.data]);
    return rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
  });
}
