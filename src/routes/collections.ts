import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, query } from '../db/pool.js';
import { authenticate } from '../auth/hook.js';
import { getOwnedCollection } from '../services/collectionAccess.js';
import { COLLECTION_FOLDER_SKELETON } from '../domain/folders.js';
import { deleteEntityStorage } from '../services/storage.js';

const createSchema = z.object({
  number: z.string().min(1).optional(),
  supplier: z.string().default(''),
  status: z.enum(['active', 'draft', 'done']).default('draft'),
});

function defaultNumber(): string {
  // "Збірник <DD.MM>" using today's UTC date (e.g. "Збірник 14.09").
  const now = new Date();
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `Збірник ${dd}.${mm}`;
}

export async function collectionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // POST /api/collections — creates a collection + the folder skeleton.
  app.post('/api/collections', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const { supplier, status } = parsed.data;
    const number = parsed.data.number ?? defaultNumber();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO collections (owner_id, number, supplier, status)
         VALUES ($1, $2, $3, $4) RETURNING id, number, supplier, status, created_at`,
        [req.user!.sub, number, supplier, status],
      );
      const col = rows[0];
      for (let i = 0; i < COLLECTION_FOLDER_SKELETON.length; i++) {
        await client.query(
          'INSERT INTO folders (collection_id, name, position) VALUES ($1, $2, $3)',
          [col.id, COLLECTION_FOLDER_SKELETON[i], i],
        );
      }
      await client.query('COMMIT');
      return reply.code(201).send({ collection: col });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // GET /api/collections — list current user's collections.
  app.get('/api/collections', async (req, reply) => {
    const { rows } = await query(
      `SELECT id, number, supplier, status, created_at
       FROM collections WHERE owner_id = $1 ORDER BY created_at DESC`,
      [req.user!.sub],
    );
    return reply.send({ collections: rows });
  });

  // GET /api/collections/:id — collection with folders.
  app.get<{ Params: { id: string } }>('/api/collections/:id', async (req, reply) => {
    const col = await getOwnedCollection(req.user!.sub, req.params.id);
    if (!col) return reply.code(404).send({ error: 'not_found' });
    const { rows: folders } = await query(
      'SELECT id, name, position FROM folders WHERE collection_id = $1 ORDER BY position',
      [col.id],
    );
    return reply.send({
      collection: {
        id: col.id,
        number: col.number,
        supplier: col.supplier,
        status: col.status,
        created_at: col.created_at,
      },
      folders,
    });
  });

  // DELETE /api/collections/:id — remove a collection and everything it owns.
  // The DB cascade (folders, files, conversations) handles relational rows; the
  // on-disk storage dir (STORAGE_DIR/<collectionId>) is purged here. Collection
  // files are never embedded, so there is no Qdrant purge (unlike workspaces).
  app.delete<{ Params: { id: string } }>('/api/collections/:id', async (req, reply) => {
    const col = await getOwnedCollection(req.user!.sub, req.params.id);
    if (!col) return reply.code(404).send({ error: 'not_found' });
    await query('DELETE FROM collections WHERE id = $1', [col.id]);
    await deleteEntityStorage(col.id);
    return reply.send({ ok: true });
  });

  // PATCH /api/collections/:id — update number/supplier/status.
  const patchSchema = z.object({
    number: z.string().min(1).optional(),
    supplier: z.string().optional(),
    status: z.enum(['active', 'draft', 'done']).optional(),
  });
  app.patch<{ Params: { id: string } }>('/api/collections/:id', async (req, reply) => {
    const col = await getOwnedCollection(req.user!.sub, req.params.id);
    if (!col) return reply.code(404).send({ error: 'not_found' });
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    // Whitelisted columns from the zod schema — safe to interpolate the names.
    const sets: string[] = [];
    const vals: unknown[] = [col.id];
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === undefined) continue;
      sets.push(`${key} = $${vals.length + 1}`);
      vals.push(value);
    }
    if (sets.length > 0) {
      await query(`UPDATE collections SET ${sets.join(', ')} WHERE id = $1`, vals);
    }

    const { rows } = await query(
      'SELECT id, number, supplier, status, created_at FROM collections WHERE id = $1',
      [col.id],
    );
    return reply.send({ collection: rows[0] });
  });
}
