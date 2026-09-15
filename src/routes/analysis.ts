import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { getOwnedCollection } from '../services/collectionAccess.js';
import { runAnalysis, type AnalysisInput } from '../services/analysis/run.js';
import {
  persistAnalysis,
  listArchive,
  deleteArchiveRecord,
  getAnalysisForOwner,
  getLatestAnalysisForCollection,
} from '../services/analyses.js';
import { buildConsolidatedReportXlsx } from '../services/analysis/export/xlsx.js';
import { SseStream } from '../sse/sse.js';
import { exportXlsx as logistExportXlsx, logistEnabled } from '../services/logist/index.js';

/**
 * B-2 consolidated analysis endpoints. `POST /api/collections/:id/analyze` runs
 * the engine on an uploaded manifest / Google Sheets link / pasted table and
 * persists the result + an archive record. The archive list/delete and the
 * .xlsx rebuild are owner-scoped.
 */

const jsonBodySchema = z
  .object({
    sheetUrl: z.string().url().optional(),
    text: z.string().min(1).optional(),
  })
  .refine((b) => Boolean(b.sheetUrl) !== Boolean(b.text), {
    message: 'Provide exactly one of sheetUrl or text.',
  });

const MANIFEST_EXT = /\.(xlsx|xls|csv|txt)$/i;

function safeFilePart(name: string): string {
  return name.replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'manifest';
}

export async function analysisRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // POST /api/collections/:id/analyze — multipart (file) OR JSON { sheetUrl | text }.
  app.post<{ Params: { id: string } }>(
    '/api/collections/:id/analyze',
    async (req, reply) => {
      const col = await getOwnedCollection(req.user!.sub, req.params.id);
      if (!col) return reply.code(404).send({ error: 'not_found' });

      let input: AnalysisInput;
      if (req.isMultipart()) {
        const part = await req.file();
        if (!part) return reply.code(400).send({ error: 'no_file' });
        if (!MANIFEST_EXT.test(part.filename)) {
          part.file.resume();
          return reply.code(415).send({ error: 'unsupported_type' });
        }
        let buf: Buffer;
        try {
          buf = await part.toBuffer();
        } catch {
          return reply.code(413).send({ error: 'too_large' });
        }
        if (part.file.truncated) return reply.code(413).send({ error: 'too_large' });
        input = { kind: 'file', buffer: buf, filename: part.filename };
      } else {
        const parsed = jsonBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
        }
        input = parsed.data.sheetUrl
          ? { kind: 'sheetUrl', url: parsed.data.sheetUrl }
          : { kind: 'text', text: parsed.data.text! };
      }

      // Stream real progress over SSE. Input is already fully read above (the
      // file buffer / JSON body), so it is safe to hijack the reply now. Events:
      //   progress { pct, step } · done { analysis } · error { message }
      const sse = new SseStream(req, reply);
      const heartbeat = setInterval(() => sse.ping(), 15_000);
      try {
        const result = await runAnalysis(input, req.user!.sub, (p) => sse.send('progress', p));
        await persistAnalysis(req.user!.sub, col.id, result);
        sse.send('progress', { pct: 100, step: 'Готово' });
        sse.send('done', { analysis: result });
      } catch (err) {
        req.log.error({ err }, 'consolidated analysis failed');
        sse.send('error', { message: (err as Error).message || 'Не вдалося виконати аналіз.' });
      } finally {
        clearInterval(heartbeat);
        sse.close();
      }
    },
  );

  // GET /api/collections/:id/analysis/latest — the collection's most recent
  // analysis (so the сборник reloads its analysis instead of losing it). null ok.
  app.get<{ Params: { id: string } }>(
    '/api/collections/:id/analysis/latest',
    async (req, reply) => {
      const col = await getOwnedCollection(req.user!.sub, req.params.id);
      if (!col) return reply.code(404).send({ error: 'not_found' });
      const analysis = await getLatestAnalysisForCollection(req.user!.sub, col.id);
      return reply.send({ analysis });
    },
  );

  // GET /api/analyses/archive — owner-scoped archive list (newest first).
  app.get('/api/analyses/archive', async (req, reply) => {
    const records = await listArchive(req.user!.sub);
    return reply.send({ records });
  });

  // DELETE /api/analyses/archive/:id — owner-scoped delete.
  app.delete<{ Params: { id: string } }>(
    '/api/analyses/archive/:id',
    async (req, reply) => {
      const ok = await deleteArchiveRecord(req.user!.sub, req.params.id);
      if (!ok) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ ok: true });
    },
  );

  // GET /api/analyses/:id/xlsx — rebuild the .xlsx from the stored analysis.
  app.get<{ Params: { id: string } }>(
    '/api/analyses/:id/xlsx',
    async (req, reply) => {
      const analysis = await getAnalysisForOwner(req.user!.sub, req.params.id);
      if (!analysis) return reply.code(404).send({ error: 'not_found' });
      // Prefer the styled Python (xlsxwriter) report via logist-mcp; fall back to
      // the built-in TS builder if the service is off or errors.
      let buf: Buffer;
      try {
        buf = logistEnabled()
          ? await logistExportXlsx(analysis)
          : buildConsolidatedReportXlsx(analysis);
      } catch (err) {
        req.log.warn({ err }, 'logist xlsx export failed — falling back to TS builder');
        buf = buildConsolidatedReportXlsx(analysis);
      }
      const filename = `analysis-${safeFilePart(analysis.sheet || 'report')}.xlsx`;
      reply.header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(buf);
    },
  );
}
