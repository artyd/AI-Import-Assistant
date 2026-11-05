import type { SupplyShipment, SupplyStep } from './types.js';

/** The step the shipment is on: the active one, else the next pending, else the last. */
export function currentStep(steps: SupplyStep[]): SupplyStep | null {
  return steps.find((s) => s.state === 'active') ?? steps.find((s) => s.state === 'pending') ?? steps[steps.length - 1] ?? null;
}

/** `2026-11-07` → `07.11` (the register's short date). */
export function shortDate(d: string): string {
  return d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : '';
}

export type DeadlineKind = 'none' | 'done' | 'overdue' | 'soon' | 'later';

/** Where the current step's plan date stands against `today` (YYYY-MM-DD). */
export function deadline(s: Pick<SupplyShipment, 'steps'>, today: string): { kind: DeadlineKind; step: SupplyStep | null; days: number | null } {
  const step = currentStep(s.steps);
  if (!step || !step.plan) return { kind: 'none', step, days: null };
  if (step.actual || step.state === 'done') return { kind: 'done', step, days: null };
  const days = Math.round((Date.parse(step.plan) - Date.parse(today)) / 86_400_000);
  return { kind: days < 0 ? 'overdue' : days <= 7 ? 'soon' : 'later', step, days };
}

/** One line for the change history, worked out from what actually changed. */
export function describeChange(before: SupplyShipment, after: SupplyShipment): string {
  const name = after.name;
  if (before.archived !== after.archived) return after.archived ? `В архів: ${name}` : `Відновлено з архіву: ${name}`;
  const parts: string[] = [];
  const old = new Map(before.steps.map((s) => [s.id, s]));
  for (const s of after.steps) {
    const was = old.get(s.id);
    if (!was) {
      parts.push(`додано етап «${s.name}»`);
      continue;
    }
    if (was.state !== 'done' && s.state === 'done') parts.push(`«${s.name}» виконано${s.actual ? ' ' + shortDate(s.actual) : ''}`);
    else if (was.plan !== s.plan) parts.push(`«${s.name}» план ${shortDate(was.plan) || '—'} → ${shortDate(s.plan) || '—'}`);
    else if (was.actual !== s.actual) parts.push(`«${s.name}» факт ${shortDate(s.actual) || '—'}`);
  }
  const kept = new Set(after.steps.map((s) => s.id));
  for (const s of before.steps) if (!kept.has(s.id)) parts.push(`прибрано етап «${s.name}»`);
  if (before.name !== after.name) parts.push(`назва «${before.name}» → «${after.name}»`);
  if (before.action !== after.action) parts.push(after.action ? `наступна дія: ${after.action}` : 'наступну дію знято');
  if (before.category !== after.category) parts.push(`категорія: ${after.category}`);
  if (parts.length === 0) return `Змінено поставку: ${name}`;
  return `${name}: ${parts.slice(0, 3).join('; ')}${parts.length > 3 ? ` і ще ${parts.length - 3}` : ''}`;
}

/** A plain-text line about one shipment, for the agent and the Excel export. */
export function shipmentLine(s: SupplyShipment, today: string): string {
  const d = deadline(s, today);
  const st = d.step;
  const when = !st ? '' : st.actual ? ` (факт ${shortDate(st.actual)})` : st.plan ? ` (план ${shortDate(st.plan)}${d.kind === 'overdue' ? `, прострочено ${-(d.days ?? 0)} дн.` : ''})` : ' (без дати)';
  const extra = Object.values(s.custom).filter(Boolean).join(', ');
  return `${s.name} [${s.category}] — етап: ${st ? st.name : 'не задано'}${when}${s.action ? `; наступна дія: ${s.action}` : ''}${extra ? `; ${extra}` : ''}${s.note ? `; примітка: ${s.note.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`;
}
