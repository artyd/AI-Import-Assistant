import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import {
  isAllowedUpload,
  storeFile,
  readStoredFile,
  deleteStoredFile,
  diskPathFor,
  contentHashOf,
} from '../services/storage.js';
import { inferFileType } from '../domain/folders.js';
import { enqueueIndexJob } from '../queue/index.js';
import { publishFileStatus } from '../events/fileStatus.js';
import { deleteFileChunks } from '../services/qdrant.js';
import { classifyAndFile, sortInbox } from '../services/classify.js';
import { isZipUpload, unpackZip, ZipGuardError } from '../services/zip.js';

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

      // One ingest batch per upload request — groups these files for "X of Y"
      // read-progress and the auto-reconcile-when-complete trigger. Created up
      // front; its `total` is set from created.length after the loop, and an
      // all-rejected request deletes the empty batch so no orphan rows accrue.
      const { rows: batchRows } = await query<{ id: string }>(
        `INSERT INTO ingest_batches (workspace_id, source) VALUES ($1, 'upload') RETURNING id`,
        [ws.id],
      );
      const batchId = batchRows[0]!.id;

      // A single replacement target applies to the first accepted file only.
      let replaceConsumed = false;
      // Exact-content dedup within this upload batch (hash -> first name seen).
      const seenHashes = new Map<string, string>();
      // Find-or-create cache for folders derived from zip paths (name -> id).
      const folderCache = new Map<string, string>();

      // Maps a zip entry's parent-dir name to a workspace folder (flat model:
      // one folder per name, created on demand). Root-level entries fall back to
      // the request's target folder.
      const resolveEntryFolder = async (entryFolderName: string | null): Promise<string | null> => {
        if (!entryFolderName) return folderId ?? null;
        const cached = folderCache.get(entryFolderName);
        if (cached) return cached;
        const { rows } = await query<{ id: string }>(
          'SELECT id FROM folders WHERE workspace_id = $1 AND name = $2 LIMIT 1',
          [ws.id, entryFolderName],
        );
        let id = rows[0]?.id;
        if (!id) {
          const ins = await query<{ id: string }>(
            `INSERT INTO folders (workspace_id, name, position)
             VALUES ($1, $2, COALESCE((SELECT MAX(position) + 1 FROM folders WHERE workspace_id = $1), 0))
             RETURNING id`,
            [ws.id, entryFolderName],
          );
          id = ins.rows[0]!.id;
        }
        folderCache.set(entryFolderName, id);
        return id;
      };

      // Persist one accepted file (dedup → store → insert → enqueue). Shared by
      // the direct-upload path and each zip entry. `label` is what we show in
      // rejections (the zip-relative path for entries), `allowReplace` gates the
      // version-replace behaviour (never applied to zip entries).
      const persist = async (
        fileName: string,
        fileBuf: Buffer,
        targetFolderId: string | null,
        label: string,
        allowReplace: boolean,
      ): Promise<void> => {
        const hash = contentHashOf(fileBuf);
        // Exact-content dedup — skip for an explicit version-replace (deliberate).
        if (!replacesFileId) {
          const inBatch = seenHashes.get(hash);
          if (inBatch) {
            rejected.push({ name: label, reason: `duplicate_of:${inBatch}` });
            return;
          }
          const { rows: dup } = await query<{ name: string }>(
            `SELECT name FROM files
             WHERE workspace_id = $1 AND content_hash = $2 AND is_latest = true LIMIT 1`,
            [ws.id, hash],
          );
          if (dup[0]) {
            rejected.push({ name: label, reason: `duplicate_of:${dup[0].name}` });
            return;
          }
        }

        const fileId = uuidv4();
        const type = inferFileType(fileName);
        const diskPath = diskPathFor(ws.id, fileId, fileName);
        await storeFile(ws.id, fileId, fileName, fileBuf);

        const applyReplace = allowReplace && replaced && !replaceConsumed;
        const version = applyReplace ? replaced!.version + 1 : 1;
        const replacesId = applyReplace ? replaced!.id : null;

        await query(
          `INSERT INTO files (id, workspace_id, folder_id, name, type, disk_path, size_bytes, status, version, replaces_file_id, is_latest, content_hash, batch_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, true, $10, $11)`,
          [fileId, ws.id, targetFolderId, fileName, type, diskPath, fileBuf.length, version, replacesId, hash, batchId],
        );
        seenHashes.set(hash, label);
        if (applyReplace) {
          await query('UPDATE files SET is_latest = false WHERE id = $1', [replaced!.id]);
          replaceConsumed = true;
        }

        await enqueueIndexJob(fileId);
        await publishFileStatus(ws.id, { fileId, status: 'queued', name: fileName });
        created.push({
          id: fileId,
          name: fileName,
          type,
          status: 'queued',
          folderId: targetFolderId,
          version,
          replacesFileId: replacesId,
        });
      };

      // If the request exceeds the multipart `files` limit, @fastify/multipart
      // throws from the async iterator mid-loop. Catch it so any files accepted
      // before the limit are still saved + enqueued and the caller gets a
      // partial-success summary, instead of a 500 that loses the whole batch.
      // (The frontend sends large selections in sub-limit batches; this is the
      // safety net for a batch that still slips over MAX_UPLOAD_FILES.)
      let limitHit = false;
      try {
        for await (const part of req.files()) {
          const name = part.filename;
          const zip = isZipUpload(name);

          // A .zip is a container, not a stored file type — it bypasses the
          // normal allow-list and is unpacked below.
          if (!zip && !isAllowedUpload(name)) {
            rejected.push({ name, reason: 'unsupported_type' });
            part.file.resume(); // drain so parsing can continue
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

          if (zip) {
            // Unpack in memory (zip-bomb guarded) and persist each entry into a
            // folder mirroring the archive's structure (flat model — see zip.ts).
            let entries;
            try {
              entries = await unpackZip(buf);
            } catch (e) {
              rejected.push({
                name,
                reason: e instanceof ZipGuardError ? `zip_${e.reason}` : 'zip_invalid',
              });
              continue;
            }
            for (const entry of entries) {
              if (!isAllowedUpload(entry.name)) {
                rejected.push({ name: entry.path, reason: 'unsupported_type' });
                continue;
              }
              if (entry.buffer.length > config.MAX_UPLOAD_BYTES) {
                rejected.push({ name: entry.path, reason: 'too_large' });
                continue;
              }
              const entryFolderId = await resolveEntryFolder(entry.folderName);
              await persist(entry.name, entry.buffer, entryFolderId, entry.path, false);
            }
            continue;
          }

          // Direct (non-zip) upload. Multipart accepts up to MAX_ZIP_BYTES, so a
          // large non-zip file must be rejected against the smaller doc limit here.
          if (buf.length > config.MAX_UPLOAD_BYTES) {
            rejected.push({ name, reason: 'too_large' });
            continue;
          }
          await persist(name, buf, folderId ?? null, name, true);
        }
      } catch (err) {
        // Too many files in one request: stop consuming, report the overflow,
        // and fall through to the normal summary response for what we did save.
        if ((err as { code?: string }).code === 'FST_FILES_LIMIT') {
          limitHit = true;
          rejected.push({
            name: '(додаткові файли)',
            reason: `too_many_files_per_request:${config.MAX_UPLOAD_FILES}`,
          });
        } else {
          throw err;
        }
      }

      // Finalise the batch: record how many files it actually holds, or drop it
      // if nothing was accepted (all rejected/duplicate) so no empty batch lingers.
      if (created.length > 0) {
        await query('UPDATE ingest_batches SET total = $2 WHERE id = $1', [batchId, created.length]);
      } else {
        await query('DELETE FROM ingest_batches WHERE id = $1', [batchId]);
      }

      if (created.length === 0 && rejected.length > 0) {
        return reply.code(415).send({ error: 'no_valid_files', rejected });
      }
      // 201 with a `limitHit` flag so the frontend can resend the overflow in a
      // follow-up batch rather than treating the upload as fully done, plus the
      // batchId so it can poll read-progress for this batch.
      return reply.code(201).send({ files: created, rejected, limitHit, batchId });
    },
  );

  // GET /api/workspaces/:id/files  — list + status (feeds the file tree).
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/files', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await query(
      `SELECT id, folder_id AS "folderId", name, type, status,
              error_reason AS "errorReason", size_bytes AS "sizeBytes", created_at AS "createdAt",
              version, is_latest AS "isLatest", replaces_file_id AS "replacesFileId",
              folder_reason AS "folderReason", folder_confidence AS "folderConfidence",
              suggested_folder_id AS "suggestedFolderId"
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

  // GET /api/workspaces/:id/files/:fileId/content — stream the stored bytes
  // (inline) for in-app preview / download. Auth via the normal Bearer header;
  // the browser fetches it with JS and shows it from a blob URL.
  app.get<{ Params: { id: string; fileId: string } }>(
    '/api/workspaces/:id/files/:fileId/content',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });
      const { rows } = await query<{ name: string; type: string; disk_path: string }>(
        'SELECT name, type, disk_path FROM files WHERE id = $1 AND workspace_id = $2',
        [req.params.fileId, ws.id],
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

  // POST /api/workspaces/:id/files/:fileId/reindex — requeue indexing for a file
  // whose previous run errored (or to re-run it). Resets status to 'queued' and
  // enqueues a fresh index job; the worker re-extracts/OCRs → embeds → 'ready'.
  app.post<{ Params: { id: string; fileId: string } }>(
    '/api/workspaces/:id/files/:fileId/reindex',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });

      const { rows } = await query<{ id: string; name: string }>(
        'SELECT id, name FROM files WHERE id = $1 AND workspace_id = $2',
        [req.params.fileId, ws.id],
      );
      const file = rows[0];
      if (!file) return reply.code(404).send({ error: 'not_found' });

      // A manual reindex is a deliberate fresh attempt: reset the sweep counter
      // and clear any 'unreadable' flag so the auto-retry budget starts over.
      await query(
        `UPDATE files SET status = 'queued', error_reason = NULL, index_attempts = 0,
           extraction_status = CASE WHEN extraction_status = 'unreadable' THEN NULL ELSE extraction_status END
         WHERE id = $1`,
        [file.id],
      );
      await enqueueIndexJob(file.id);
      await publishFileStatus(ws.id, { fileId: file.id, status: 'queued', name: file.name });
      return reply.send({ ok: true });
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

  // GET /api/workspaces/:id/ingest-status[?batchId=<uuid>] — read-progress for a
  // shipment (or one upload batch): counts by status + the list of files that
  // need attention (error / flagged unreadable). Backs the "прочитано X з Y"
  // indicator and the per-shipment problem list. Poll this alongside the live
  // `file_status` SSE stream.
  app.get<{ Params: { id: string }; Querystring: { batchId?: string } }>(
    '/api/workspaces/:id/ingest-status',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });
      const batchId = req.query.batchId ?? null;

      const params: unknown[] = [ws.id];
      let batchFilter = '';
      if (batchId) {
        params.push(batchId);
        batchFilter = ' AND batch_id = $2';
      }

      const { rows: agg } = await query<{
        total: string;
        queued: string;
        indexing: string;
        ready: string;
        error: string;
        unreadable: string;
      }>(
        `SELECT
           COUNT(*)                                             AS total,
           COUNT(*) FILTER (WHERE status = 'queued')            AS queued,
           COUNT(*) FILTER (WHERE status = 'indexing')          AS indexing,
           COUNT(*) FILTER (WHERE status = 'ready')             AS ready,
           COUNT(*) FILTER (WHERE status = 'error')             AS error,
           COUNT(*) FILTER (WHERE extraction_status = 'unreadable') AS unreadable
         FROM files
         WHERE workspace_id = $1 AND is_latest = true${batchFilter}`,
        params,
      );
      const c = agg[0]!;
      const n = (v: string): number => Number(v);
      const total = n(c.total);
      const ready = n(c.ready);
      const pending = n(c.queued) + n(c.indexing);

      const { rows: problems } = await query(
        `SELECT id, name, status,
                extraction_status AS "extractionStatus",
                error_reason AS "errorReason",
                folder_id AS "folderId"
         FROM files
         WHERE workspace_id = $1 AND is_latest = true${batchFilter}
           AND (status = 'error' OR extraction_status = 'unreadable')
         ORDER BY created_at`,
        params,
      );

      return reply.send({
        batchId,
        total,
        read: ready,
        pending,
        counts: {
          queued: n(c.queued),
          indexing: n(c.indexing),
          ready,
          error: n(c.error),
          unreadable: n(c.unreadable),
        },
        // "Done reading" = nothing still queued/indexing (files may still be
        // flagged for manual entry, but no further auto-reading is pending).
        done: pending === 0,
        problems,
      });
    },
  );

  // GET /api/problem-files — cross-shipment list of files that need a human:
  // failed indexing or flagged unreadable, across every workspace the user owns.
  // Backs the global "проблемні файли" screen.
  app.get('/api/problem-files', async (req, reply) => {
    const { rows } = await query(
      `SELECT f.id, f.name, f.status,
              f.extraction_status AS "extractionStatus",
              f.error_reason AS "errorReason",
              f.workspace_id AS "workspaceId",
              w.number AS "workspaceNumber",
              f.created_at AS "createdAt"
       FROM files f
       JOIN workspaces w ON w.id = f.workspace_id
       WHERE w.owner_id = $1
         AND f.is_latest = true
         AND (f.status = 'error' OR f.extraction_status = 'unreadable')
       ORDER BY f.created_at DESC`,
      [req.user!.sub],
    );
    return reply.send({ files: rows });
  });
}
