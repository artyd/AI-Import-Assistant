import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/pool.js';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import {
  isAllowedUpload,
  storeFile,
  deleteStoredFile,
  diskPathFor,
} from '../services/storage.js';
import { inferFileType } from '../domain/folders.js';
import { enqueueIndexJob } from '../queue/index.js';
import { publishFileStatus } from '../events/fileStatus.js';
import { deleteFileChunks } from '../services/qdrant.js';
import { classifyAndFile, sortInbox } from '../services/classify.js';

async function folderBelongs(workspaceId: string, folderId: string): Promise<boolean> {
  const { rows } = await query('SELECT 1 FROM folders WHERE id = $1 AND workspace_id = $2', [
    folderId,
    workspaceId,
  ]);
  return rows.length > 0;
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // POST /api/workspaces/:id/files?folderId=<uuid>&replacesFileId=<uuid>  (multipart)
  app.post<{
    Params: { id: string };
    Querystring: { folderId?: string; replacesFileId?: string };
  }>(
    '/api/workspaces/:id/files',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });

      const folderId = req.query.folderId;
      if (folderId && !(await folderBelongs(ws.id, folderId))) {
        return reply.code(400).send({ error: 'invalid_folder' });
      }

      // Optional: this upload replaces an existing file (new version).
      const replacesFileId = req.query.replacesFileId;
      let replaced: { id: string; version: number } | null = null;
      if (replacesFileId) {
        const { rows } = await query<{ id: string; version: number }>(
          'SELECT id, version FROM files WHERE id = $1 AND workspace_id = $2',
          [replacesFileId, ws.id],
        );
        if (!rows[0]) return reply.code(400).send({ error: 'invalid_replaces' });
        replaced = rows[0];
      }

      if (!req.isMultipart()) {
        return reply.code(400).send({ error: 'expected_multipart' });
      }

      const created: unknown[] = [];
      const rejected: { name: string; reason: string }[] = [];
      // A single replacement target applies to the first accepted file only.
      let replaceConsumed = false;

      for await (const part of req.files()) {
        const name = part.filename;
        if (!isAllowedUpload(name)) {
          rejected.push({ name, reason: 'unsupported_type' });
          // Drain the stream so parsing can continue.
          part.file.resume();
          continue;
        }
        let buf: Buffer;
        try {
          buf = await part.toBuffer();
        } catch {
          rejected.push({ name, reason: 'too_large' });
          continue;
        }
        if (part.file.truncated) {
          rejected.push({ name, reason: 'too_large' });
          continue;
        }

        const fileId = uuidv4();
        const type = inferFileType(name);
        const diskPath = diskPathFor(ws.id, fileId, name);
        await storeFile(ws.id, fileId, name, buf);

        // Versioning: if this upload replaces an existing file, chain it and
        // demote the previous version from is_latest.
        const applyReplace = replaced && !replaceConsumed;
        const version = applyReplace ? replaced!.version + 1 : 1;
        const replacesId = applyReplace ? replaced!.id : null;

        await query(
          `INSERT INTO files (id, workspace_id, folder_id, name, type, disk_path, size_bytes, status, version, replaces_file_id, is_latest)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, true)`,
          [fileId, ws.id, folderId ?? null, name, type, diskPath, buf.length, version, replacesId],
        );
        if (applyReplace) {
          await query('UPDATE files SET is_latest = false WHERE id = $1', [replaced!.id]);
          replaceConsumed = true;
        }

        await enqueueIndexJob(fileId);
        await publishFileStatus(ws.id, { fileId, status: 'queued', name });
        created.push({
          id: fileId,
          name,
          type,
          status: 'queued',
          folderId: folderId ?? null,
          version,
          replacesFileId: replacesId,
        });
      }

      if (created.length === 0 && rejected.length > 0) {
        return reply.code(415).send({ error: 'no_valid_files', rejected });
      }
      return reply.code(201).send({ files: created, rejected });
    },
  );

  // GET /api/workspaces/:id/files  — list + status (feeds the file tree).
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/files', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await query(
      `SELECT id, folder_id AS "folderId", name, type, status,
              error_reason AS "errorReason", size_bytes AS "sizeBytes", created_at AS "createdAt",
              version, is_latest AS "isLatest", replaces_file_id AS "replacesFileId"
       FROM files WHERE workspace_id = $1 ORDER BY created_at`,
      [ws.id],
    );
    return reply.send({ files: rows });
  });

  // DELETE /api/workspaces/:id/files/:fileId
  app.delete<{ Params: { id: string; fileId: string } }>(
    '/api/workspaces/:id/files/:fileId',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });

      const { rows } = await query<{ disk_path: string }>(
        'SELECT disk_path FROM files WHERE id = $1 AND workspace_id = $2',
        [req.params.fileId, ws.id],
      );
      const file = rows[0];
      if (!file) return reply.code(404).send({ error: 'not_found' });

      await deleteFileChunks(req.params.fileId);
      await deleteStoredFile(file.disk_path);
      await query('DELETE FROM files WHERE id = $1', [req.params.fileId]);
      await publishFileStatus(ws.id, { fileId: req.params.fileId, status: 'deleted' });
      return reply.send({ ok: true });
    },
  );

  // --- Extensions to support the prototype's file tree ---

  // POST /api/workspaces/:id/folders — create a folder.
  const folderSchema = z.object({ name: z.string().min(1) });
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/folders', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const parsed = folderSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rows } = await query(
      `INSERT INTO folders (workspace_id, name, position)
       VALUES ($1, $2, COALESCE((SELECT MAX(position) + 1 FROM folders WHERE workspace_id = $1), 0))
       RETURNING id, name, position`,
      [ws.id, parsed.data.name],
    );
    return reply.code(201).send({ folder: rows[0] });
  });

  // POST /api/workspaces/:id/sort-inbox — classify & file every inbox file
  // (folder_id IS NULL) into its skeleton folder. Uses stored extractions, so a
  // scan that the worker OCR'd + extracted gets sorted here too. Same service as
  // the agent's sort_inbox tool; exposed for the file-tree "Розкласти інбокс" button.
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/sort-inbox', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const result = await sortInbox(ws.id);
    return reply.send(result);
  });

  // PATCH /api/workspaces/:id/files/:fileId — rename / move a file.
  const patchSchema = z.object({
    name: z.string().min(1).optional(),
    folderId: z.string().uuid().nullable().optional(),
  });
  app.patch<{ Params: { id: string; fileId: string } }>(
    '/api/workspaces/:id/files/:fileId',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
      const { name, folderId } = parsed.data;
      if (folderId && !(await folderBelongs(ws.id, folderId))) {
        return reply.code(400).send({ error: 'invalid_folder' });
      }
      const { rows } = await query(
        `UPDATE files SET
           name = COALESCE($3, name),
           folder_id = CASE WHEN $4::boolean THEN $5 ELSE folder_id END
         WHERE id = $1 AND workspace_id = $2
         RETURNING id, name, folder_id AS "folderId", type, status`,
        [req.params.fileId, ws.id, name ?? null, folderId !== undefined, folderId ?? null],
      );
      if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ file: rows[0] });
    },
  );

  // POST /api/workspaces/:id/files/:fileId/classify — auto-sort a single file into
  // its skeleton folder (move-only). Reuses the same classifier as the agent's
  // classify_and_file tool. Called by the chat right after a paperclip upload.
  // Note: immediately after upload the indexing worker's structured extraction may
  // not exist yet, so classifyAndFile → resolveDocType runs its own forced-tool LLM
  // call; the worker's later extraction is idempotent, so this is a harmless duplicate.
  app.post<{ Params: { id: string; fileId: string } }>(
    '/api/workspaces/:id/files/:fileId/classify',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });

      const res = await classifyAndFile(ws.id, req.params.fileId);
      if (!res) return reply.code(404).send({ error: 'not_found' });

      // res.to === null → left in inbox (unmapped / 'other' / folder missing) → the
      // chat asks the user to pick. Otherwise the file was moved into res.to.
      return reply.send({ fileId: res.fileId, folderName: res.to });
    },
  );

  // GET /api/workspaces/:id/files/:fileId/history — full version chain.
  app.get<{ Params: { id: string; fileId: string } }>(
    '/api/workspaces/:id/files/:fileId/history',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });
      const { rows } = await query(
        `WITH RECURSIVE chain AS (
           SELECT id, name, version, replaces_file_id, is_latest, created_at
           FROM files WHERE id = $1 AND workspace_id = $2
           UNION
           SELECT f.id, f.name, f.version, f.replaces_file_id, f.is_latest, f.created_at
           FROM files f
           JOIN chain c ON (f.id = c.replaces_file_id OR f.replaces_file_id = c.id)
           WHERE f.workspace_id = $2
         )
         SELECT id, name, version, replaces_file_id AS "replacesFileId",
                is_latest AS "isLatest", created_at AS "createdAt"
         FROM chain ORDER BY version`,
        [req.params.fileId, ws.id],
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ versions: rows });
    },
  );
}
