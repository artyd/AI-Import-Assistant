import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';

vi.mock('../../lib/config.js', () => ({
  config: { JWT_SECRET: 'test-secret-that-is-long-enough-1234567890', JWT_EXPIRES_IN: '12h', ACCESS_CODE: '482913', ACCESS_CODE_MAX_FAILURES: 20 },
}));

const created: unknown[] = [];
vi.mock('../store.js', async () => {
  class SupplyConflict extends Error {}
  class SupplyNotFound extends Error {}
  class SupplyNotUndoable extends Error {}
  return {
    SupplyConflict,
    SupplyNotFound,
    SupplyNotUndoable,
    listShipments: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({ stages: [], categories: ['A'], fields: [], templates: [] })),
    revision: vi.fn(async () => '7'),
    listHistory: vi.fn(async () => []),
    createShipment: vi.fn(async (input: unknown, actor: string) => {
      created.push({ input, actor });
      return { id: 'x', ...(input as object) };
    }),
    updateShipment: vi.fn(),
    setArchived: vi.fn(),
    putSettings: vi.fn(),
    undoHistory: vi.fn(),
  };
});

const { currentStep, deadline, describeChange, shipmentLine } = await import('../logic.js');
const { mapLegacy } = await import('../importLegacy.js');
const { signSupplyToken, verifySupplyToken } = await import('../access.js');
const { signToken, verifyToken } = await import('../../auth/jwt.js');
const { supplyRoutes } = await import('../supply.routes.js');

type Step = { id: string; name: string; plan: string; actual: string; state: 'active' | 'done' | 'pending'; note: string };
const step = (o: Partial<Step>): Step => ({ id: 's', name: 'Етап', plan: '', actual: '', state: 'pending', note: '', ...o });
const ship = (o: Record<string, unknown> = {}) => ({
  id: 'a', name: 'Сорбітол', category: 'Міжнародні', action: '', note: '', archived: false, steps: [] as Step[], custom: {}, position: 1,
  createdAt: '', updatedAt: '', ...o,
});

describe('register logic', () => {
  it('the current step is the active one, else the next pending', () => {
    expect(currentStep([step({ id: '1', state: 'done' }), step({ id: '2', state: 'active' })])?.id).toBe('2');
    expect(currentStep([step({ id: '1', state: 'done' }), step({ id: '2' })])?.id).toBe('2');
    expect(currentStep([])).toBeNull();
  });

  it('deadline: overdue, soon, later, none', () => {
    const at = (plan: string) => deadline({ steps: [step({ state: 'active', plan })] }, '2026-11-05').kind;
    expect(at('2026-11-04')).toBe('overdue');
    expect(at('2026-11-12')).toBe('soon');
    expect(at('2026-11-20')).toBe('later');
    expect(at('')).toBe('none');
    expect(deadline({ steps: [step({ state: 'active', plan: '2026-11-01', actual: '2026-11-02' })] }, '2026-11-05').kind).toBe('done');
  });

  it('describes a finished step and a moved plan', () => {
    const before = ship({ steps: [step({ id: '1', name: 'Порт', state: 'active', plan: '2026-11-03' }), step({ id: '2', name: 'ЖД', plan: '2026-11-07' })] });
    const after = ship({ steps: [step({ id: '1', name: 'Порт', state: 'done', plan: '2026-11-03', actual: '2026-11-03' }), step({ id: '2', name: 'ЖД', state: 'active', plan: '2026-11-09' })] });
    expect(describeChange(before, after)).toBe('Сорбітол: «Порт» виконано 03.11; «ЖД» план 07.11 → 09.11');
    expect(describeChange(before, { ...before, archived: true })).toBe('В архів: Сорбітол');
    expect(describeChange(before, before)).toBe('Змінено поставку: Сорбітол');
  });

  it('one plain line per shipment for the agent', () => {
    const line = shipmentLine(ship({ action: 'Уточнити дату', steps: [step({ name: 'Прибуття', state: 'active', plan: '2026-11-01' })] }), '2026-11-05');
    expect(line).toBe('Сорбітол [Міжнародні] — етап: Прибуття (план 01.11, прострочено 4 дн.); наступна дія: Уточнити дату');
  });
});

describe('legacy import mapping', () => {
  const legacy = {
    data: {
      shipments: [
        { id: 'p1', name: 'Тестовий товар', category: 'Зразки', action: 'Дзвінок', note: 'n', archived: false, updated: '2026-11-05',
          steps: [{ id: 'x', name: 'Прибытие', plan: '2026-11-10', actual: '', state: 'active', note: '' }, { id: 'y', name: 'Доставка', plan: 'около 17.11', state: 'weird' }],
          custom: { qty: '10 т', supplier: '' } },
        { id: 'p2', name: '   ' },
      ],
      stages: ['Прибуття'], categories: ['Международные'], fields: [{ id: 'qty', name: 'Количество', type: 'text' }],
      templates: [{ id: 't', name: 'Авиа', stages: ['Вылет', 'Прибытие'] }, { id: 'e', name: 'Порожній', stages: [] }],
      history: [{ at: '2026-11-05T08:12:14.473Z', user: 'Logist', text: 'Змінено' }, { at: 'bad', text: 'x' }],
    },
  };

  it('keeps good rows, drops blanks, never guesses dates', () => {
    const m = mapLegacy(legacy);
    expect(m.shipments).toHaveLength(1);
    const s = m.shipments[0]!;
    expect(s.legacyId).toBe('p1');
    expect(s.steps[1]).toMatchObject({ name: 'Доставка', plan: '', state: 'pending' });
    expect(s.custom).toEqual({ qty: '10 т' });
    expect(m.settings.categories).toEqual(['Міжнародні', 'Зразки']); // Russian names come in Ukrainian
    expect(m.settings.templates).toEqual([{ id: 't', name: 'Авіа', stages: ['Виліт', 'Прибуття'] }]);
    expect(m.settings.fields[0]?.name).toBe('Кількість');
    expect(s.steps[0]?.name).toBe('Прибуття');
    expect(m.history).toEqual([{ at: '2026-11-05T08:12:14.473Z', actor: 'Logist', text: 'Змінено' }]);
  });
});

describe('supply access', () => {
  it('a supply token is not a Штурман token and the other way round', () => {
    const { token } = signSupplyToken();
    expect(verifySupplyToken(token)).toBe(true);
    expect(() => verifyToken(token)).toThrow();
    expect(verifySupplyToken(signToken({ sub: 'u', email: 'a@b.c' }))).toBe(false);
  });
});

describe('supply routes', () => {
  async function app() {
    const a = Fastify();
    await a.register(rateLimit, { global: false });
    await a.register(supplyRoutes);
    return a;
  }

  it('reads are open', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/api/supply' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ revision: '7', canEdit: false });
  });

  it('writes need the code', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/api/supply/shipments', payload: { name: 'X', category: 'A' } });
    expect(res.statusCode).toBe(401);
  });

  it('wrong code → 401, right code → token that can write', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: '/api/supply/unlock', payload: { code: '000000' } })).statusCode).toBe(401);
    const ok = await a.inject({ method: 'POST', url: '/api/supply/unlock', payload: { code: '482913' } });
    expect(ok.statusCode).toBe(200);
    const { token } = ok.json() as { token: string };
    const res = await a.inject({ method: 'POST', url: '/api/supply/shipments', headers: { authorization: `Bearer ${token}` }, payload: { name: 'X', category: 'A' } });
    expect(res.statusCode).toBe(201);
    expect(created.at(-1)).toMatchObject({ actor: 'Код Штурмана', input: { name: 'X', category: 'A', steps: [], custom: {} } });
  });

  it('a Штурман session can edit too', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/api/supply/session', headers: { authorization: `Bearer ${signToken({ sub: 'u', email: 'log@a.ua' })}` } });
    expect(res.json()).toMatchObject({ canEdit: true, codeLogin: true, codeLength: 6 });
  });
});
