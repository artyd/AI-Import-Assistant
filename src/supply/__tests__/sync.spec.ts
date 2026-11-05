import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/config.js', () => ({ config: { JWT_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://x' } }));
vi.mock('../../db/pool.js', () => ({ pool: {}, query: vi.fn() }));

const { mapLegacy, planSync } = await import('../importLegacy.js');
const { planEdit } = await import('../applyText.js');

const legacy = (shipments: unknown[], history: unknown[] = []) =>
  mapLegacy({ data: { shipments, stages: ['Готовность'], categories: ['Международные'], fields: [], templates: [], history } });
const raw = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'Товар', category: 'Международные', action: '', note: 'нота', archived: false,
  steps: [{ id: 's1', name: 'Готовность', plan: '2026-11-06', actual: '', state: 'active', note: '' }], custom: { qty: '1 т' }, ...o,
});
const oursOf = (m: ReturnType<typeof legacy>['shipments'][number], id = 'u1') => ({
  id, legacyId: m.legacyId, name: m.name, category: m.category, action: m.action, note: m.note, archived: m.archived,
  // jsonb hands objects back with keys in its own order
  steps: m.steps.map((s) => ({ note: s.note, state: s.state, actual: s.actual, plan: s.plan, name: s.name, id: s.id })),
  custom: { ...m.custom },
});

describe('sync with the old site', () => {
  it('a text date goes into the step note, not lost', () => {
    const m = legacy([raw({ steps: [{ id: 's1', name: 'Букинг', plan: 'около 17.11', state: 'active' }] })]);
    expect(m.shipments[0]!.steps[0]).toMatchObject({ name: 'Букінг', plan: '', note: 'план: около 17.11' });
  });

  it('unchanged rows (even with re-ordered jsonb keys) are left alone', () => {
    const m = legacy([raw()]);
    const plan = planSync(m, [oursOf(m.shipments[0]!)], new Set(), ['Готовність'], new Set());
    expect(plan.update).toEqual([]);
    expect(plan.insert).toEqual([]);
  });

  it('a change there updates ours; a new one is inserted; ours edited here wins', () => {
    const before = legacy([raw()]).shipments[0]!;
    const now = legacy([raw({ note: 'нова нота' }), raw({ id: 'p2', name: 'Новий' })]);
    const plan = planSync(now, [oursOf(before)], new Set(), ['Готовність'], new Set());
    expect(plan.update.map((u) => u.fields)).toEqual([['note']]);
    expect(plan.insert.map((x) => x.name)).toEqual(['Новий']);
    const kept = planSync(now, [oursOf(before)], new Set(['u1']), ['Готовність'], new Set());
    expect(kept.update).toEqual([]);
    expect(kept.keptOurs).toEqual(['Товар']);
  });

  it('only history lines we do not have yet', () => {
    const at = '2026-11-05T13:22:12.184Z';
    const m = legacy([], [{ at, user: 'Logist', text: 'А' }, { at: '2026-11-05T14:00:00.000Z', user: 'Logist', text: 'Б' }]);
    expect(planSync(m, [], new Set(), [], new Set([`${at}|А`])).history.map((h) => h.text)).toEqual(['Б']);
  });
});

describe('text edits', () => {
  const row = { name: 'Сорбитол 2', action: 'Уточнить', note: '03.11 в порт', steps: [{ id: 's1', name: 'Букінг', plan: '', actual: '', state: 'active' as const, note: 'план: около 17.11' }] };
  it('changes only what still reads the same', () => {
    const r = planEdit(row, { id: 'p2', name: ['Сорбитол 2', 'Сорбітол 2'], action: ['Другое', 'Інше'], note: ['03.11  в порт', '03.11 у порт'], steps: { s1: ['план: около 17.11', 'план: близько 17.11'] } });
    expect(r.next).toMatchObject({ name: 'Сорбітол 2', action: 'Уточнить', note: '03.11 у порт' });
    expect(r.next.steps[0]!.note).toBe('план: близько 17.11');
    expect(r.changed).toEqual(['name', 'note', 'етап «Букінг»']);
    expect(r.skipped).toEqual(['action: зараз «Уточнить»']);
  });
  it('already translated is not reported as skipped', () => {
    expect(planEdit({ ...row, name: 'Сорбітол 2' }, { id: 'p2', name: ['Сорбитол 2', 'Сорбітол 2'] }).skipped).toEqual([]);
  });
});
