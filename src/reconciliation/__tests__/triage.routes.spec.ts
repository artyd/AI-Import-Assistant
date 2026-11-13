import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../lib/config.js', () => ({
  config: { JWT_SECRET: 'test-secret-that-is-long-enough-1234567890', JWT_EXPIRES_IN: '12h' },
}));

const USER = '11111111-1111-4111-8111-111111111111';
const WS = '33333333-3333-4333-8333-333333333333';
const FP = 'a'.repeat(40);

const store = vi.hoisted(() => ({ upsertTriage: vi.fn(), deleteTriage: vi.fn(), loadTriage: vi.fn() }));
vi.mock('../triage.js', () => store);
const state = vi.hoisted(() => ({ shipmentChanged: vi.fn(async () => null) }));
vi.mock('../../shipments/state.js', () => state);
const verdicts = vi.hoisted(() => ({ shipmentVerdicts: vi.fn() }));
vi.mock('../verdicts.js', () => verdicts);
const fcl = vi.hoisted(() => ({ loadFclVerdicts: vi.fn() }));
vi.mock('../../shipments/fclState.js', () => fcl);
const access = vi.hoisted(() => ({ getOwnedWorkspace: vi.fn() }));
vi.mock('../../shipments/workspaceAccess.js', () => access);

const { signToken } = await import('../../auth/jwt.js');
const { triageRoutes } = await import('../triage.routes.js');

const auth = { authorization: `Bearer ${signToken({ sub: USER, email: 'u@example.test' })}` };
async function call(method: 'PUT' | 'DELETE' | 'GET', url: string, payload?: object) {
  const a = Fastify();
  await a.register(triageRoutes);
  return a.inject({ method, url, headers: auth, payload });
}
const put = (body: object, fp = FP, id = WS) => call('PUT', `/api/workspaces/${id}/findings/${fp}/triage`, body);

const row = { fingerprint: FP, status: 'not_problem', reason: 'legs', note: '', title: 'Вага', lot: null, user_name: 'Артем', decided_at: '2026-11-13T10:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  access.getOwnedWorkspace.mockImplementation(async (userId: string, id: string) => (userId === USER && id === WS ? { id: WS, number: '7', kind: 'shipment' } : null));
  store.upsertTriage.mockResolvedValue(row);
  store.deleteTriage.mockResolvedValue(true);
});

describe('PUT /api/workspaces/:id/findings/:fingerprint/triage', () => {
  it('requires auth', async () => {
    const a = Fastify();
    await a.register(triageRoutes);
    const res = await a.inject({ method: 'PUT', url: `/api/workspaces/${WS}/findings/${FP}/triage`, payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('404 on a foreign workspace — before anything is validated or written', async () => {
    const res = await put({ status: 'resolved', title: 'x' }, FP, '99999999-9999-4999-8999-999999999999');
    expect(res.statusCode).toBe(404);
    expect(store.upsertTriage).not.toHaveBeenCalled();
  });

  it('400: not_problem needs a reason, "other" needs a note, bounded lengths, bad fingerprint', async () => {
    expect((await put({ status: 'not_problem', title: 'x' })).statusCode).toBe(400);
    expect((await put({ status: 'not_problem', reason: 'other', title: 'x' })).statusCode).toBe(400);
    expect((await put({ status: 'not_problem', reason: 'other', note: '   ', title: 'x' })).statusCode).toBe(400);
    expect((await put({ status: 'resolved', note: 'x'.repeat(1001), title: 'x' })).statusCode).toBe(400);
    expect((await put({ status: 'resolved', title: 'x'.repeat(301) })).statusCode).toBe(400);
    expect((await put({ status: 'resolved' })).statusCode).toBe(400);
    expect((await put({ status: 'maybe', title: 'x' })).statusCode).toBe(400);
    expect((await put({ status: 'resolved', title: 'x' }, 'not-a-fingerprint')).statusCode).toBe(400);
    expect(store.upsertTriage).not.toHaveBeenCalled();
    expect(state.shipmentChanged).not.toHaveBeenCalled();
  });

  it('stores the decision, reports shipmentChanged and returns the triage', async () => {
    const res = await put({ status: 'not_problem', reason: 'legs', title: 'Вага', lot: 'Hebei' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ triage: { status: 'not_problem', reason: 'legs', note: '', user_name: 'Артем', decided_at: '2026-11-13T10:00:00.000Z' } });
    expect(store.upsertTriage).toHaveBeenCalledWith(WS, USER, FP, { status: 'not_problem', reason: 'legs', note: '', title: 'Вага', lot: 'Hebei' });
    expect(state.shipmentChanged).toHaveBeenCalledWith(WS, 'triage');
  });

  it('«Вирішено» keeps no reason', async () => {
    await put({ status: 'resolved', reason: 'legs', note: ' готово ', title: 'Вага' });
    expect(store.upsertTriage).toHaveBeenCalledWith(WS, USER, FP, { status: 'resolved', reason: null, note: 'готово', title: 'Вага', lot: null });
  });
});

describe('DELETE /api/workspaces/:id/findings/:fingerprint/triage', () => {
  it('204 and shipmentChanged', async () => {
    const res = await call('DELETE', `/api/workspaces/${WS}/findings/${FP}/triage`);
    expect(res.statusCode).toBe(204);
    expect(store.deleteTriage).toHaveBeenCalledWith(WS, FP);
    expect(state.shipmentChanged).toHaveBeenCalledWith(WS, 'triage');
  });

  it('404 on a foreign workspace', async () => {
    const res = await call('DELETE', `/api/workspaces/99999999-9999-4999-8999-999999999999/findings/${FP}/triage`);
    expect(res.statusCode).toBe(404);
    expect(store.deleteTriage).not.toHaveBeenCalled();
  });
});

describe('GET /api/workspaces/:id/problems-report', () => {
  it('404 on a foreign workspace', async () => {
    expect((await call('GET', '/api/workspaces/99999999-9999-4999-8999-999999999999/problems-report')).statusCode).toBe(404);
  });

  it('a shipment: { html } with the open and the decided finding', async () => {
    verdicts.shipmentVerdicts.mockResolvedValue({
      discrepancies: [
        { field: 'gross_weight_kg', expected: '100', actual: '120', severity: 'error', kind: 'confirmed', citations: [{ file_id: 'f1', file_name: 'inv.pdf', doc_type: 'invoice', value: '100' }] },
        { field: 'bank_account', expected: 'a', actual: 'b', severity: 'error', kind: 'confirmed', citations: [], triage: { status: 'resolved', reason: null, note: 'уточнили', user_name: 'Артем', decided_at: '2026-11-13T10:00:00.000Z' } },
      ],
      risks: [],
    });
    const res = await call('GET', `/api/workspaces/${WS}/problems-report`);
    expect(res.statusCode).toBe(200);
    const { html } = res.json() as { html: string };
    expect(html).toContain('Відкриті проблеми');
    expect(html).toContain('inv.pdf');
    expect(html).toContain('Вирішено');
    expect(html).toContain('уточнили');
  });

  it('an FCL: grouped by lot', async () => {
    access.getOwnedWorkspace.mockResolvedValue({ id: WS, number: '18', kind: 'fcl' });
    fcl.loadFclVerdicts.mockResolvedValue({
      level: { discrepancies: [], risks: [] },
      lots: [{ lot: { name: 'Hebei' }, verdicts: { discrepancies: [{ field: 'net_weight_kg', expected: '1', actual: '2', severity: 'warning', kind: 'suspected', citations: [] }], risks: [] } }],
    });
    const { html } = (await call('GET', `/api/workspaces/${WS}/problems-report`)).json() as { html: string };
    expect(html).toContain('<h3>Hebei</h3>');
    expect(html).toContain('перевірити');
  });
});
