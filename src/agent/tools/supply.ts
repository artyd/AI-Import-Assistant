import type { ChatTool } from '../../lib/anthropic/client.js';
import { kyivToday } from '../../sheet/sync.js';
import { deadline, shipmentLine } from '../../supply/logic.js';
import { listShipments } from '../../supply/store.js';

/**
 * Read-only access to the Поставки register (spec 008) for Штурман. The register
 * is written by people in /supply; the agent only reads it.
 */
export const supplyToolDefinitions: ChatTool[] = [
  {
    name: 'supply_register',
    description:
      'Реєстр «Поставки» (окремий застосунок команди на /supply): по кожній поставці — категорія, поточний етап, ' +
      'планова / фактична дата, наступна дія, примітка, кількість, постачальник, маршрут. Викликай, коли питають, ' +
      'на якому етапі поставка, що прострочено, що відбудеться найближчими днями або що треба зробити. ' +
      'Лише читання: змінювати реєстр можуть тільки люди в /supply.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Пошук за назвою товару, постачальником, етапом або приміткою.' },
        filter: {
          type: 'string',
          enum: ['all', 'overdue', 'week', 'action', 'no_date', 'archived'],
          description: 'overdue — прострочені; week — план на найближчі 7 днів; action — є наступна дія; no_date — без дати; archived — архів. За замовчуванням all (активні).',
        },
        category: { type: 'string', description: 'Лише одна категорія (як у реєстрі).' },
      },
    },
  },
];

const NAMES = new Set(supplyToolDefinitions.map((t) => (t as { name: string }).name));
export function isSupplyTool(name: string): boolean {
  return NAMES.has(name);
}

const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

export async function executeSupplyTool(_name: string, input: unknown): Promise<{ result: string; summary: string }> {
  const args = (input ?? {}) as Record<string, unknown>;
  const today = kyivToday();
  const filter = typeof args.filter === 'string' ? args.filter : 'all';
  const q = typeof args.query === 'string' ? fold(args.query.trim()) : '';
  const category = typeof args.category === 'string' ? fold(args.category.trim()) : '';

  const all = await listShipments();
  const list = all.filter((s) => {
    if (filter === 'archived' ? !s.archived : s.archived) return false;
    if (category && fold(s.category) !== category) return false;
    const d = deadline(s, today);
    if (filter === 'overdue' && d.kind !== 'overdue') return false;
    if (filter === 'week' && d.kind !== 'soon') return false;
    if (filter === 'action' && !s.action) return false;
    if (filter === 'no_date' && d.kind !== 'none') return false;
    if (q && !fold([s.name, s.note, s.action, s.category, ...s.steps.map((x) => x.name), ...Object.values(s.custom)].join(' ')).includes(q)) return false;
    return true;
  });

  if (!all.length) return { result: 'Реєстр «Поставки» порожній — даних немає.', summary: 'Поставки: порожньо' };
  if (!list.length) return { result: `У реєстрі «Поставки» нічого не знайдено (фільтр: ${filter}${q ? `, пошук «${args.query}»` : ''}). Даних немає.`, summary: 'Поставки: нічого' };

  const lines = list.slice(0, 60).map((s) => `- ${shipmentLine(s, today)}`);
  const more = list.length > 60 ? `\n…і ще ${list.length - 60}.` : '';
  return {
    result: `Реєстр «Поставки» (станом на зараз, сьогодні ${today}; джерело — /supply, дані вносять логісти):\n${lines.join('\n')}${more}`,
    summary: `Поставки: ${list.length}`,
  };
}
