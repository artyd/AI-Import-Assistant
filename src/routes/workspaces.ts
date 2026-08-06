import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, query } from '../db/pool.js';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import { FOLDER_SKELETON } from '../domain/folders.js';

const createSchema = z.object({
  number: z.string().min(1).optional(),
  supplier: z.string().default(''),
  status: z.enum(['active', 'draft', 'done']).default('draft'),
});

function defaultNumber(): string {
  // Mirrors the prototype's "2026-####" scheme; the real UI can override.
  const year = new Date().getUTCFullYear();
  const seq = Math.floor(1000 + Math.random() * 8999);
  return `${year}-${seq}`;
}

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // POST /api/workspaces — creates a workspace + the folder skeleton.
  app.post('/api/workspaces', async (req, reply) => {
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
        `INSERT INTO workspaces (owner_id, number, supplier, status)
         VALUES ($1, $2, $3, $4) RETURNING id, number, supplier, status, created_at`,
        [req.user!.sub, number, supplier, status],
      );
      const ws = rows[0];
      for (let i = 0; i < FOLDER_SKELETON.length; i++) {
        await client.query(
          'INSERT INTO folders (workspace_id, name, position) VALUES ($1, $2, $3)',
          [ws.id, FOLDER_SKELETON[i], i],
        );
      }
      await client.query('COMMIT');
      return reply.code(201).send({ workspace: ws });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // GET /api/workspaces — list current user's workspaces.
  app.get('/api/workspaces', async (req, reply) => {
    const { rows } = await query(
      `SELECT id, number, supplier, status, created_at
       FROM workspaces WHERE owner_id = $1 ORDER BY created_at DESC`,
      [req.user!.sub],
    );
    return reply.send({ workspaces: rows });
  });

  // GET /api/workspaces/:id — workspace with folders.
  app.get<{ Params: { id: string } }>('/api/workspaces/:id', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const { rows: folders } = await query(
      'SELECT id, name, position FROM folders WHERE workspace_id = $1 ORDER BY position',
      [ws.id],
    );
    return reply.send({
      workspace: {
        id: ws.id,
        number: ws.number,
        supplier: ws.supplier,
        status: ws.status,
        created_at: ws.created_at,
      },
      folders,
    });
  });
}
