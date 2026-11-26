import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { query } from '../db/pool.js';
import {
  DOC_KINDS,
  directoryPartySchema,
  parseData,
  productSchema,
  type ContractData,
  type DocKind,
  type InvoiceData,
} from './schema.js';
import { downloadName, renderDocx, renderPreviewHtml } from './render.js';
import { documentTitle, invoiceFromContract } from './fromContract.js';
import { contractTotal, invoiceTotal } from './templateData.js';

/**
 * Document builder (spec 012): a team-shared directory of companies and goods,
 * saved trade documents, and Word output from the team's own templates.
 * Not shipment-scoped — every authenticated Штурман user works in one space,
 * like the instruction directory.
 */
const uuid = z.string().uuid();
const kindSchema = z.enum(DOC_KINDS);

function disposition(kind: DocKind, number: string): string {
  const { ascii, utf8 } = downloadName(kind, number);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`;
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function sendDocx(reply: FastifyReply, kind: DocKind, number: string, buf: Buffer): FastifyReply {
  return reply.header('content-type', DOCX).header('content-disposition', disposition(kind, number)).send(buf);
}

function total(kind: DocKind, data: ContractData | InvoiceData): number {
  return kind === 'contract' ? contractTotal(data as ContractData) : invoiceTotal(data as InvoiceData);
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

interface DocRow {
  id: string;
  kind: DocKind;
  number: string;
  title: string;
  data: unknown;
  contract_id: string | null;
  created_at: string;
  updated_at: string;
}

function docOut(r: DocRow) {
  return { id: r.id, kind: r.kind, number: r.number, title: r.title, data: r.data, contractId: r.contract_id, createdAt: r.created_at, updatedAt: r.updated_at };
}

export async function docBuilderRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // ---------- directory: parties ----------
  app.get('/api/docbuilder/parties', async (_req, reply) => {
    const { rows } = await query<{ id: string; role: string; data: Record<string, unknown> }>(
      'SELECT id, role, data FROM doc_parties ORDER BY role, lower(name)',
    );
    return reply.send({ parties: rows.map((r) => ({ ...r.data, id: r.id, role: r.role })) });
  });

  app.post('/api/docbuilder/parties', async (req, reply) => {
    const parsed = directoryPartySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    const p = parsed.data;
    if (!p.nameEn && !p.nameUk) return reply.code(400).send({ error: 'invalid_request', message: 'name required' });
    const { rows } = await query<{ id: string }>(
      'INSERT INTO doc_parties (role, name, data, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [p.role, p.nameEn || p.nameUk, p, req.user!.sub],
    );
    return reply.code(201).send({ party: { ...p, id: rows[0]!.id } });
  });

  app.put<{ Params: { id: string } }>('/api/docbuilder/parties/:id', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    const parsed = directoryPartySchema.safeParse(req.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const p = parsed.data;
    const { rowCount } = await query(
      'UPDATE doc_parties SET role = $2, name = $3, data = $4, updated_at = now() WHERE id = $1',
      [id.data, p.role, p.nameEn || p.nameUk, p],
    );
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
    const { rows } = await query<{ id: string; data: Record<string, unknown> }>(
      'SELECT id, data FROM doc_products ORDER BY lower(name)',
    );
    return reply.send({ products: rows.map((r) => ({ ...r.data, id: r.id })) });
  });

  app.post('/api/docbuilder/products', async (req, reply) => {
    const parsed = productSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    const p = parsed.data;
    if (!p.nameEn && !p.nameUk) return reply.code(400).send({ error: 'invalid_request', message: 'name required' });
    const { rows } = await query<{ id: string }>(
      'INSERT INTO doc_products (name, data, created_by) VALUES ($1, $2, $3) RETURNING id',
      [p.nameEn || p.nameUk, p, req.user!.sub],
    );
    return reply.code(201).send({ product: { ...p, id: rows[0]!.id } });
  });

  app.put<{ Params: { id: string } }>('/api/docbuilder/products/:id', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    const parsed = productSchema.safeParse(req.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const p = parsed.data;
    const { rowCount } = await query('UPDATE doc_products SET name = $2, data = $3, updated_at = now() WHERE id = $1', [
      id.data,
      p.nameEn || p.nameUk,
      p,
    ]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ product: { ...p, id: id.data } });
  });

  app.delete<{ Params: { id: string } }>('/api/docbuilder/products/:id', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rowCount } = await query('DELETE FROM doc_products WHERE id = $1', [id.data]);
    return rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
  });

  // ---------- documents ----------
  app.get<{ Querystring: { kind?: string } }>('/api/docbuilder/documents', async (req, reply) => {
    const kind = kindSchema.safeParse(req.query.kind);
    const cols = 'id, kind, number, title, data, contract_id, created_at, updated_at';
    const { rows } = kind.success
      ? await query<DocRow>(`SELECT ${cols} FROM doc_documents WHERE kind = $1 ORDER BY updated_at DESC LIMIT 500`, [kind.data])
      : await query<DocRow>(`SELECT ${cols} FROM doc_documents ORDER BY updated_at DESC LIMIT 500`);
    return reply.send({
      documents: rows.map((r) => {
        const data = parseData(r.kind, r.data);
        return {
          id: r.id,
          kind: r.kind,
          number: r.number,
          title: r.title,
          contractId: r.contract_id,
          date: data.date,
          currency: data.currency,
          total: total(r.kind, data),
          updatedAt: r.updated_at,
        };
      }),
    });
  });

  app.get<{ Params: { id: string } }>('/api/docbuilder/documents/:id', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rows } = await query<DocRow>('SELECT * FROM doc_documents WHERE id = $1', [id.data]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ document: docOut(rows[0]) });
  });

  const createBody = z.object({ kind: kindSchema, data: z.unknown(), contractId: uuid.nullable().optional() });

  app.post('/api/docbuilder/documents', async (req, reply) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', issues: body.error.issues });
    const data = safeData(body.data.kind, body.data.data);
    if (!data.ok) return reply.code(400).send({ error: 'invalid_request', issues: data.issues });
    const { rows } = await query<DocRow>(
      `INSERT INTO doc_documents (kind, number, title, data, contract_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [body.data.kind, data.value.number, documentTitle(body.data.kind, data.value), data.value, body.data.contractId ?? null, req.user!.sub],
    );
    return reply.code(201).send({ document: docOut(rows[0]!) });
  });

  app.put<{ Params: { id: string } }>('/api/docbuilder/documents/:id', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rows: found } = await query<{ kind: DocKind }>('SELECT kind FROM doc_documents WHERE id = $1', [id.data]);
    if (!found[0]) return reply.code(404).send({ error: 'not_found' });
    const kind = found[0].kind;
    const data = safeData(kind, (req.body as { data?: unknown } | undefined)?.data);
    if (!data.ok) return reply.code(400).send({ error: 'invalid_request', issues: data.issues });
    const { rows } = await query<DocRow>(
      'UPDATE doc_documents SET number = $2, title = $3, data = $4, updated_at = now() WHERE id = $1 RETURNING *',
      [id.data, data.value.number, documentTitle(kind, data.value), data.value],
    );
    return reply.send({ document: docOut(rows[0]!) });
  });

  app.delete<{ Params: { id: string } }>('/api/docbuilder/documents/:id', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rowCount } = await query('DELETE FROM doc_documents WHERE id = $1', [id.data]);
    return rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
  });

  /** A new invoice + packing list draft from a saved contract. */
  app.post<{ Params: { id: string } }>('/api/docbuilder/documents/:id/invoice', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rows } = await query<DocRow>("SELECT * FROM doc_documents WHERE id = $1 AND kind = 'contract'", [id.data]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    const invoice = invoiceFromContract(parseData('contract', rows[0].data) as ContractData, todayIso());
    const { rows: created } = await query<DocRow>(
      `INSERT INTO doc_documents (kind, number, title, data, contract_id, created_by)
       VALUES ('invoice', '', $1, $2, $3, $4) RETURNING *`,
      [documentTitle('invoice', invoice), invoice, id.data, req.user!.sub],
    );
    return reply.code(201).send({ document: docOut(created[0]!) });
  });

  app.get<{ Params: { id: string } }>('/api/docbuilder/documents/:id/docx', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rows } = await query<DocRow>('SELECT * FROM doc_documents WHERE id = $1', [id.data]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    const data = parseData(rows[0].kind, rows[0].data);
    return sendDocx(reply, rows[0].kind, data.number, await renderDocx(rows[0].kind, data));
  });

  // ---------- stateless render: live preview + download of an unsaved draft ----------
  const renderBody = z.object({ kind: kindSchema, data: z.unknown(), format: z.enum(['docx', 'html']).default('html') });

  app.post('/api/docbuilder/render', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = renderBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', issues: body.error.issues });
    const data = safeData(body.data.kind, body.data.data);
    if (!data.ok) return reply.code(400).send({ error: 'invalid_request', issues: data.issues });
    if (body.data.format === 'docx') return sendDocx(reply, body.data.kind, data.value.number, await renderDocx(body.data.kind, data.value));
    return reply.send({ html: await renderPreviewHtml(body.data.kind, data.value), total: total(body.data.kind, data.value) });
  });
}

function safeData(
  kind: DocKind,
  raw: unknown,
): { ok: true; value: ContractData | InvoiceData } | { ok: false; issues: unknown } {
  try {
    return { ok: true, value: parseData(kind, raw) };
  } catch (err) {
    return { ok: false, issues: err instanceof z.ZodError ? err.issues : String(err) };
  }
}
