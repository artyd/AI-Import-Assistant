import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import { buildSupplierInstruction } from '../services/supplierInstruction.js';
import { prefillDraft } from '../services/instruction/prefill.js';
import { createVersion, getVersion, listVersions, updateVersion } from '../services/instruction/store.js';
import { draftSchema, missingFields } from '../services/instruction/types.js';
import { renderText, letterSubject } from '../services/instruction/render.js';
import { instructionDocx, instructionPdf } from '../services/instruction/exportFormats.js';
import { proposeRefinement } from '../services/instruction/refine.js';

const verParam = z.coerce.number().int().positive();

function disposition(base: string, ext: string): string {
  const ascii = base.replace(/[^\w.-]+/g, '_') || 'instruction';
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`;
}

export async function supplierInstructionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // Legacy: POST /api/workspaces/:id/supplier-instruction → EN letter (template, no LLM).
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/supplier-instruction', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const result = await buildSupplierInstruction(ws);
    if ('missing' in result) return reply.code(400).send({ error: 'missing_context', missing: result.missing });
    return reply.send(result);
  });

  // GET …/instruction/prefill — a fresh draft from the shipment (not saved).
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/instruction/prefill', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const draft = await prefillDraft(ws);
    return reply.send({ draft, missing: missingFields(draft) });
  });

  // POST …/instruction/preview { draft } — live letter text for the screen (no LLM, not saved).
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/instruction/preview', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const parsed = z.object({ draft: draftSchema }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    const d = parsed.data.draft;
    return reply.send({ en: renderText(d, 'en'), uk: renderText(d, 'uk'), subject: letterSubject(d), missing: missingFields(d) });
  });

  // GET …/instructions — all versions (newest first).
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/instructions', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const versions = await listVersions(ws.id);
    return reply.send({ versions: versions.map((v) => ({ ...v, missing: missingFields(v.draft) })) });
  });

  // POST …/instructions { draft } — save as a new version.
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/instructions', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const parsed = z.object({ draft: draftSchema }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    const v = await createVersion(ws.id, parsed.data.draft, req.user!.sub);
    return reply.code(201).send({ version: { ...v, missing: missingFields(v.draft) } });
  });

  // PATCH …/instructions/:ver { draft?, status? } — save / approve / mark sent.
  app.patch<{ Params: { id: string; ver: string } }>('/api/workspaces/:id/instructions/:ver', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const ver = verParam.safeParse(req.params.ver);
    const parsed = z
      .object({ draft: draftSchema.optional(), status: z.enum(['draft', 'approved', 'sent']).optional() })
      .safeParse(req.body);
    if (!ver.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const cur = await getVersion(ws.id, ver.data);
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    const draft = parsed.data.draft ?? cur.draft;
    if (parsed.data.status && parsed.data.status !== 'draft') {
      const missing = missingFields(draft);
      if (missing.length) return reply.code(400).send({ error: 'missing_fields', missing });
    }
    const v = await updateVersion(ws.id, ver.data, { draft: parsed.data.draft, status: parsed.data.status });
    return reply.send({ version: { ...v!, missing: missingFields(v!.draft) } });
  });

  // GET …/instructions/:ver/render?lang=en|uk&format=txt|docx|pdf
  app.get<{ Params: { id: string; ver: string }; Querystring: { lang?: string; format?: string } }>(
    '/api/workspaces/:id/instructions/:ver/render',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });
      const ver = verParam.safeParse(req.params.ver);
      const lang = req.query.lang === 'uk' ? 'uk' : 'en';
      const format = req.query.format ?? 'txt';
      if (!ver.success || !['txt', 'docx', 'pdf'].includes(format)) return reply.code(400).send({ error: 'invalid_request' });
      const v = await getVersion(ws.id, ver.data);
      if (!v) return reply.code(404).send({ error: 'not_found' });
      const name = `instruction-${ws.number}-v${v.version}-${lang}`;
      if (format === 'txt') {
        return reply.send({ text: renderText(v.draft, lang), subject: letterSubject(v.draft) });
      }
      if (format === 'docx') {
        return reply
          .header('content-type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
          .header('content-disposition', disposition(name, 'docx'))
          .send(await instructionDocx(v.draft, lang));
      }
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', disposition(name, 'pdf'))
        .send(await instructionPdf(v.draft, lang));
    },
  );

  // POST …/instructions/:ver/refine { request } — AI proposes extra clauses (not saved).
  app.post<{ Params: { id: string; ver: string } }>('/api/workspaces/:id/instructions/:ver/refine', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const ver = verParam.safeParse(req.params.ver);
    const body = z.object({ request: z.string().trim().min(3).max(2000), draft: draftSchema.optional() }).safeParse(req.body);
    if (!ver.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const v = await getVersion(ws.id, ver.data);
    if (!v) return reply.code(404).send({ error: 'not_found' });
    // Refine against the screen's current (possibly unsaved) state when sent.
    const proposal = await proposeRefinement(body.data.draft ?? v.draft, body.data.request);
    return reply.send(proposal);
  });
}
