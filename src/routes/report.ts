import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { query } from '../db/pool.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import { buildAndSaveReport, reportPdf } from '../services/report.js';

const bodySchema = z.object({ summary: z.boolean().optional() }).optional();

/** ASCII-safe attachment name + RFC 5987 UTF-8 name (Cyrillic shipment numbers). */
function disposition(base: string, ext: string): string {
  const ascii = base.replace(/[^\w.-]+/g, '_') || 'report';
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`;
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // POST /api/workspaces/:id/report — build the one-page report, persist the HTML.
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/report', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const parsed = bodySchema.safeParse(req.body ?? undefined);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { id, html } = await buildAndSaveReport(ws, { summary: parsed.data?.summary });
    return reply.send({ artifactId: id, html });
  });

  // GET /api/workspaces/:id/report/:artifactId.(pdf|html) — download a saved report.
  app.get<{ Params: { id: string; artifactId: string; ext: string } }>(
    '/api/workspaces/:id/report/:artifactId/:ext',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });
      const { ext } = req.params;
      if (ext !== 'pdf' && ext !== 'html') return reply.code(404).send({ error: 'not_found' });
      if (!z.string().uuid().safeParse(req.params.artifactId).success) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const { rows } = await query<{ content_ref: string }>(
        `SELECT content_ref FROM generated_artifacts
         WHERE id = $1 AND workspace_id = $2 AND type = 'shipment_report_html'`,
        [req.params.artifactId, ws.id],
      );
      if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
      const html = await readFile(rows[0].content_ref, 'utf8');
      const name = `zvit-${ws.number}`;
      if (ext === 'html') {
        return reply
          .header('content-type', 'text/html; charset=utf-8')
          .header('content-disposition', disposition(name, 'html'))
          .send(html);
      }
      const pdf = await reportPdf(html);
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', disposition(name, 'pdf'))
        .send(pdf);
    },
  );
}
