import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../shipments/workspaceAccess.js';
import { shipmentChanged } from '../shipments/state.js';
import { loadFclVerdicts } from '../shipments/fclState.js';
import { shipmentVerdicts } from './verdicts.js';
import { deleteTriage, upsertTriage } from './triage.js';
import { toFindingTriage } from './fingerprint.js';
import { collectProblems, renderProblemsReport, type ProblemEntry } from './problemsReport.js';

/**
 * Finding triage (spec 011): decide a discrepancy / risk («Не проблема» /
 * «Вирішено»), bring it back, and the printable «Звіт про проблеми». A decision
 * is shared by everyone who can open the shipment; both writes end with
 * `shipmentChanged(id, 'triage')` so counts, status and the agent follow.
 */

const fingerprintSchema = z.string().regex(/^[0-9a-f]{40}$/);

export const triageBodySchema = z
  .object({
    status: z.enum(['not_problem', 'resolved']),
    reason: z.enum(['legs', 'version', 'lots', 'agreed', 'other']).optional(),
    note: z.string().max(1000).optional(),
    title: z.string().max(300),
    lot: z.string().max(300).nullable().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.status !== 'not_problem') return;
    if (!b.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'reason is required for not_problem' });
    else if (b.reason === 'other' && !b.note?.trim()) ctx.addIssue({ code: 'custom', path: ['note'], message: 'note is required for reason other' });
  });

export async function triageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // PUT /api/workspaces/:id/findings/:fingerprint/triage — decide a finding.
  app.put<{ Params: { id: string; fingerprint: string } }>('/api/workspaces/:id/findings/:fingerprint/triage', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const fp = fingerprintSchema.safeParse(req.params.fingerprint);
    const body = triageBodySchema.safeParse(req.body);
    if (!fp.success || !body.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: [...(fp.success ? [] : fp.error.issues), ...(body.success ? [] : body.error.issues)] });
    }
    const b = body.data;
    const row = await upsertTriage(ws.id, req.user!.sub, fp.data, {
      status: b.status,
      reason: b.status === 'not_problem' ? (b.reason ?? null) : null,
      note: b.note?.trim() ?? '',
      title: b.title,
      lot: b.lot ?? null,
    });
    await shipmentChanged(ws.id, 'triage');
    return reply.send({ triage: toFindingTriage(row) });
  });

  // DELETE /api/workspaces/:id/findings/:fingerprint/triage — «Повернути».
  app.delete<{ Params: { id: string; fingerprint: string } }>('/api/workspaces/:id/findings/:fingerprint/triage', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const fp = fingerprintSchema.safeParse(req.params.fingerprint);
    if (!fp.success) return reply.code(400).send({ error: 'invalid_request', issues: fp.error.issues });
    await deleteTriage(ws.id, fp.data);
    await shipmentChanged(ws.id, 'triage');
    return reply.code(204).send();
  });

  // GET /api/workspaces/:id/problems-report — { html }: open / solved / excluded.
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/problems-report', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const entries: ProblemEntry[] = [];
    if (ws.kind === 'fcl') {
      const v = await loadFclVerdicts(ws);
      entries.push(...collectProblems(v.level.discrepancies, v.level.risks, null));
      for (const l of v.lots) entries.push(...collectProblems(l.verdicts.discrepancies, l.verdicts.risks, l.lot.name));
    } else {
      const { discrepancies, risks } = await shipmentVerdicts(ws);
      entries.push(...collectProblems(discrepancies, risks, null));
    }
    const html = renderProblemsReport({ number: ws.number, fcl: ws.kind === 'fcl', generatedAt: new Date(), entries });
    return reply.send({ html });
  });
}
