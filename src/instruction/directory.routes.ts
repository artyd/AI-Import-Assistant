import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { query } from '../db/pool.js';

/**
 * Team-shared directory for the instruction builder: our group companies
 * (letterhead + signer), suppliers / consignees with addresses, contacts for
 * originals. Shared by design (TZ §1) — every authenticated user sees and edits it.
 */
const entry = z.object({
  kind: z.enum(['own_company', 'supplier', 'consignee', 'contact']),
  name: z.string().trim().min(1).max(300),
  address: z.string().max(1000).default(''),
  country: z.string().max(100).default(''),
  signer: z.string().max(200).default(''),
  email: z.string().max(200).default(''),
  phone: z.string().max(100).default(''),
});
const COLS = 'id, kind, name, address, country, signer, email, phone, updated_at';

export async function directoryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get<{ Querystring: { kind?: string } }>('/api/directory', async (req, reply) => {
    const kind = entry.shape.kind.safeParse(req.query.kind);
    const { rows } = kind.success
      ? await query(`SELECT ${COLS} FROM org_directory WHERE kind = $1 ORDER BY lower(name)`, [kind.data])
      : await query(`SELECT ${COLS} FROM org_directory ORDER BY kind, lower(name)`);
    return reply.send({ entries: rows });
  });

  app.post('/api/directory', async (req, reply) => {
    const parsed = entry.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    const e = parsed.data;
    const { rows } = await query(
      `INSERT INTO org_directory (kind, name, address, country, signer, email, phone, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
      [e.kind, e.name, e.address, e.country, e.signer, e.email, e.phone, req.user!.sub],
    );
    return reply.code(201).send({ entry: rows[0] });
  });

  app.patch<{ Params: { entryId: string } }>('/api/directory/:entryId', async (req, reply) => {
    const id = z.string().uuid().safeParse(req.params.entryId);
    const parsed = entry.partial().safeParse(req.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const sets: string[] = ['updated_at = now()'];
    const vals: unknown[] = [id.data];
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v === undefined) continue;
      vals.push(v);
      sets.push(`${k} = $${vals.length}`); // keys come from the zod schema whitelist
    }
    const { rows } = await query(`UPDATE org_directory SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLS}`, vals);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ entry: rows[0] });
  });

  app.delete<{ Params: { entryId: string } }>('/api/directory/:entryId', async (req, reply) => {
    const id = z.string().uuid().safeParse(req.params.entryId);
    if (!id.success) return reply.code(404).send({ error: 'not_found' });
    const { rowCount } = await query('DELETE FROM org_directory WHERE id = $1', [id.data]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ ok: true });
  });
}
