import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/pool.js';
import { authenticate } from '../auth/hook.js';
import { getOwnedCollection } from '../services/collectionAccess.js';
import {
  isAllowedUpload,
  storeFile,
  readStoredFile,
  deleteStoredFile,
  diskPathFor,
  contentHashOf,
} from '../services/storage.js';
import { inferFileType } from '../domain/folders.js';

/**
 * Collection (Збірник) file management — a deliberate divergence from the
 * workspace file pipeline. Collection files are panel documents / certificates
 * plus a manifest that the Phase-B analysis engine parses DIRECTLY. They do NOT
 * go through RAG: no embedding index job, no Qdrant, no live indexing status.
 * Uploaded files land as `status = 'ready'` immediately.
 *
 * The storage layer, allow-list, size checks and content-hash dedup are the same
 * as the workspace upload path — only the entity namespace (collection id) and
 * the "no indexing" behaviour differ.
 */

/** MIME type for inline preview / download, derived from the stored file type. */
function contentType(type: string, name: string): string {
  switch (type) {
    case 'pdf':
      return 'application/pdf';
    case 'csv':
      return 'text/csv; charset=utf-8';
    case 'md':
      return 'text/markdown; charset=utf-8';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'image': {
      const n = name.toLowerCase();
      if (n.endsWith('.png')) return 'image/png';
      if (n.endsWith('.gif')) return 'image/gif';
      if (n.endsWith('.webp')) return 'image/webp';
      return 'image/jpeg';
    }
    default:
      return 'application/octet-stream';
  }
}

async function folderBelongs(collectionId: string, folderId: string): Promise<boolean> {
  const { rows } = await query('SELECT 1 FROM folders WHERE id = $1 AND collection_id = $2', [
    folderId,
    collectionId,
  ]);
  return rows.length > 0;
}

export async function collectionFileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // POST /api/collections/:id/files?folderId=<uuid>  (multipart)
  // No indexing: files are stored + inserted as 'ready'. NO Qdrant / embeddings.
  app.post<{
    Params: { id: string };
    Querystring: { folderId?: string };
  }>('/api/collections/:id/files', async (req, reply) => {
    const col = await getOwnedCollection(req.user!.sub, req.params.id);
    if (!col) return reply.code(404).send({ error: 'not_found' });

    const folderId = req.query.folderId;
    if (folderId && !(await folderBelongs(col.id, folderId))) {
      return reply.code(400).send({ error: 'invalid_folder' });
    }

    if (!req.isMultipart()) {
      return reply.code(400).send({ error: 'expected_multipart' });
    }

    const created: unknown[] = [];
    const rejected: { name: string; reason: string }[] = [];
    // Exact-content dedup within this upload batch (hash -> first name seen).
    const seenHashes = new Map<string, string>();

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

      // Exact-content dedup — within this batch and against existing latest files.
      const hash = contentHashOf(buf);
      const inBatch = seenHashes.get(hash);
      if (inBatch) {
        rejected.push({ name, reason: `duplicate_of:${inBatch}` });
        continue;
      }
      const { rows: dup } = await query<{ name: string }>(
        `SELECT name FROM files
         WHERE collection_id = $1 AND content_hash = $2 AND is_latest = true LIMIT 1`,
        [col.id, hash],
      );
      if (dup[0]) {
        rejected.push({ name, reason: `duplicate_of:${dup[0].name}` });
        continue;
      }

      const fileId = uuidv4();
      const type = inferFileType(name);
      const diskPath = diskPathFor(col.id, fileId, name);
      await storeFile(col.id, fileId, name, buf);

      // No indexing for collection files: insert as 'ready' directly.
      await query(
        `INSERT INTO files (id, collection_id, folder_id, name, type, disk_path, size_bytes, status, version, is_latest, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready', 1, true, $8)`,
        [fileId, col.id, folderId ?? null, name, type, diskPath, buf.length, hash],
      );
      seenHashes.set(hash, name);
      created.push({
        id: fileId,
        name,
        type,
        status: 'ready',
        folderId: folderId ?? null,
        version: 1,
        replacesFileId: null,
      });
    }

    if (created.length === 0 && rejected.length > 0) {
      return reply.code(415).send({ error: 'no_valid_files', rejected });
    }
    return reply.code(201).send({ files: created, rejected });
  });

  // GET /api/collections/:id/files — list this collection's files.
  app.get<{ Params: { id: string } }>('/api/collections/:id/files', async (req, reply) => {
    const col = await getOwnedCollection(req.user!.sub, req.params.id);
    if (!col) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await query(
      `SELECT id, folder_id AS "folderId", name, type, status,
              error_reason AS "errorReason", size_bytes AS "sizeBytes", created_at AS "createdAt",
              version, is_latest AS "isLatest", replaces_file_id AS "replacesFileId"
       FROM files WHERE collection_id = $1 ORDER BY created_at`,
      [col.id],
    );
    return reply.send({ files: rows });
  });

  // DELETE /api/collections/:id/files/:fileId — remove DB row + on-disk file. No Qdrant.
  app.delete<{ Params: { id: string; fileId: string } }>(
    '/api/collections/:id/files/:fileId',
    async (req, reply) => {
      const col = await getOwnedCollection(req.user!.sub, req.params.id);
      if (!col) return reply.code(404).send({ error: 'not_found' });

      const { rows } = await query<{ disk_path: string }>(
        'SELECT disk_path FROM files WHERE id = $1 AND collection_id = $2',
        [req.params.fileId, col.id],
      );
      const file = rows[0];
      if (!file) return reply.code(404).send({ error: 'not_found' });

      await deleteStoredFile(file.disk_path);
      await query('DELETE FROM files WHERE id = $1', [req.params.fileId]);
      return reply.send({ ok: true });
    },
  );

  // POST /api/collections/:id/folders — create a folder in the collection.
  const folderSchema = z.object({ name: z.string().min(1) });
  app.post<{ Params: { id: string } }>('/api/collections/:id/folders', async (req, reply) => {
    const col = await getOwnedCollection(req.user!.sub, req.params.id);
    if (!col) return reply.code(404).send({ error: 'not_found' });
    const parsed = folderSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rows } = await query(
      `INSERT INTO folders (collection_id, name, position)
       VALUES ($1, $2, COALESCE((SELECT MAX(position) + 1 FROM folders WHERE collection_id = $1), 0))
       RETURNING id, name, position`,
      [col.id, parsed.data.name],
    );
    return reply.code(201).send({ folder: rows[0] });
  });

  // PATCH /api/collections/:id/files/:fileId — rename / move a file.
  const patchSchema = z.object({
    name: z.string().min(1).optional(),
    folderId: z.string().uuid().nullable().optional(),
  });
  app.patch<{ Params: { id: string; fileId: string } }>(
    '/api/collections/:id/files/:fileId',
    async (req, reply) => {
      const col = await getOwnedCollection(req.user!.sub, req.params.id);
      if (!col) return reply.code(404).send({ error: 'not_found' });
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
      const { name, folderId } = parsed.data;
      if (folderId && !(await folderBelongs(col.id, folderId))) {
        return reply.code(400).send({ error: 'invalid_folder' });
      }
      const { rows } = await query(
        `UPDATE files SET
           name = COALESCE($3, name),
           folder_id = CASE WHEN $4::boolean THEN $5 ELSE folder_id END
         WHERE id = $1 AND collection_id = $2
         RETURNING id, name, folder_id AS "folderId", type, status`,
        [req.params.fileId, col.id, name ?? null, folderId !== undefined, folderId ?? null],
      );
      if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ file: rows[0] });
    },
  );

  // GET /api/collections/:id/files/:fileId/content — stream the stored bytes.
  app.get<{ Params: { id: string; fileId: string } }>(
    '/api/collections/:id/files/:fileId/content',
    async (req, reply) => {
      const col = await getOwnedCollection(req.user!.sub, req.params.id);
      if (!col) return reply.code(404).send({ error: 'not_found' });
      const { rows } = await query<{ name: string; type: string; disk_path: string }>(
        'SELECT name, type, disk_path FROM files WHERE id = $1 AND collection_id = $2',
        [req.params.fileId, col.id],
      );
      const file = rows[0];
      if (!file) return reply.code(404).send({ error: 'not_found' });
      let buf: Buffer;
      try {
        buf = await readStoredFile(file.disk_path);
      } catch {
        return reply.code(404).send({ error: 'not_found' });
      }
      reply.header('Content-Type', contentType(file.type, file.name));
      reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      return reply.send(buf);
    },
  );
}
