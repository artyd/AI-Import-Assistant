import { readFile } from 'node:fs/promises';
import { pool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { settingsSchema, stepSchema, type SupplySettings, type SupplyStep } from './types.js';
import { toUa } from './ua.js';

/**
 * One-time import of the old «Поставки» site (spec 008). Its `GET /api/workspace`
 * returns `{ data: { shipments, stages, categories, fields, templates, history } }`.
 *
 *   node dist/supply/importLegacy.js [url|file] [--force]
 *
 * Refuses to run when the register already has shipments, unless --force
 * (then legacy rows are matched by `legacy_id` and updated in place).
 */

export const LEGACY_URL = 'https://supply-desk-nov26.mauveriver35.chatgpt.site/api/workspace';

export interface LegacyShipmentRow {
  legacyId: string;
  name: string;
  category: string;
  action: string;
  note: string;
  archived: boolean;
  steps: SupplyStep[];
  custom: Record<string, string>;
  updated: string | null;
}

export interface LegacyImport {
  shipments: LegacyShipmentRow[];
  settings: SupplySettings;
  history: { at: string; actor: string; text: string }[];
}

const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
/** Dictionary words of the old (Russian) site, in Ukrainian. */
const category = (v: unknown): string => toUa(str(v, 60).trim());
const day = (v: unknown): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');

/** Pure: the old site's JSON → rows for our tables. Bad steps are dropped, not guessed. */
export function mapLegacy(json: unknown): LegacyImport {
  const data = ((json as { data?: unknown })?.data ?? json) as Record<string, unknown>;
  const rawShipments = Array.isArray(data.shipments) ? data.shipments : [];
  const shipments: LegacyShipmentRow[] = [];
  for (const raw of rawShipments as Record<string, unknown>[]) {
    const name = str(raw.name, 200).trim();
    if (!name) continue;
    const steps: SupplyStep[] = [];
    for (const st of Array.isArray(raw.steps) ? (raw.steps as Record<string, unknown>[]) : []) {
      // A date typed as text («около 17.11», «декабрь 2026») is not a date: keep it in the step's note.
      const loose = (v: unknown, label: string) => (typeof v === 'string' && v.trim() && !day(v) ? `${label}: ${v.trim()}` : '');
      const parsed = stepSchema.safeParse({
        id: str(st.id, 64) || `s${steps.length}`,
        name: toUa(str(st.name, 120).trim()) || 'Етап',
        plan: day(st.plan),
        actual: day(st.actual),
        state: ['active', 'done', 'pending'].includes(st.state as string) ? st.state : 'pending',
        note: [str(st.note, 900).trim(), loose(st.plan, 'план'), loose(st.actual, 'факт')].filter(Boolean).join(' · '),
      });
      if (parsed.success) steps.push(parsed.data);
    }
    const custom: Record<string, string> = {};
    if (raw.custom && typeof raw.custom === 'object') {
      for (const [k, v] of Object.entries(raw.custom as Record<string, unknown>)) if (str(v).trim()) custom[k.slice(0, 60)] = str(v, 300);
    }
    shipments.push({
      legacyId: str(raw.id, 120) || name,
      name,
      category: category(raw.category) || 'Без категорії',
      action: str(raw.action, 300).trim(),
      note: str(raw.note, 4000),
      archived: raw.archived === true,
      steps,
      custom,
      updated: day(raw.updated) || null,
    });
  }

  const categories = Array.isArray(data.categories) ? (data.categories as unknown[]).map(category).filter(Boolean) : [];
  for (const s of shipments) if (!categories.includes(s.category)) categories.push(s.category);
  const settings = settingsSchema.parse({
    stages: Array.isArray(data.stages) ? (data.stages as unknown[]).map((s) => toUa(str(s, 80).trim())).filter(Boolean) : [],
    categories: categories.length ? categories : ['Без категорії'],
    fields: (Array.isArray(data.fields) ? (data.fields as Record<string, unknown>[]) : [])
      .map((f) => ({ id: str(f.id, 60), name: toUa(str(f.name, 80).trim()), type: f.type === 'number' ? 'number' : 'text' }))
      .filter((f) => f.id && f.name),
    templates: (Array.isArray(data.templates) ? (data.templates as Record<string, unknown>[]) : [])
      .map((t) => ({ id: str(t.id, 64), name: toUa(str(t.name, 80).trim()), stages: (Array.isArray(t.stages) ? (t.stages as unknown[]) : []).map((x) => toUa(str(x, 80).trim())).filter(Boolean) }))
      .filter((t) => t.id && t.name && t.stages.length),
  });

  const history = (Array.isArray(data.history) ? (data.history as Record<string, unknown>[]) : [])
    .map((h) => ({ at: str(h.at, 40), actor: str(h.user, 80), text: str(h.text, 500) }))
    .filter((h) => h.text && !Number.isNaN(Date.parse(h.at)));

  return { shipments, settings, history };
}

async function load(source: string): Promise<unknown> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${source} → HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(await readFile(source, 'utf8'));
}

export async function importLegacy(source: string, force: boolean): Promise<{ shipments: number; history: number }> {
  const mapped = mapLegacy(await load(source));
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM supply_shipments');
    if (Number(rows[0]?.n ?? 0) > 0 && !force) throw new Error('The register already has shipments. Re-run with --force to update legacy rows in place.');

    let position = 0;
    for (const s of mapped.shipments) {
      position += 1;
      await c.query(
        `INSERT INTO supply_shipments (legacy_id, name, category, action, note, archived, steps, custom, position, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::date::timestamptz, now()))
         ON CONFLICT (legacy_id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, action = EXCLUDED.action,
           note = EXCLUDED.note, archived = EXCLUDED.archived, steps = EXCLUDED.steps, custom = EXCLUDED.custom, updated_at = now()`,
        [s.legacyId, s.name, s.category, s.action, s.note, s.archived, JSON.stringify(s.steps), JSON.stringify(s.custom), position, s.updated],
      );
    }
    const st = mapped.settings;
    await c.query(
      `INSERT INTO supply_settings (id, stages, categories, fields, templates, updated_at) VALUES (1, $1, $2, $3, $4, now())
       ON CONFLICT (id) DO UPDATE SET stages = $1, categories = $2, fields = $3, templates = $4, updated_at = now()`,
      [JSON.stringify(st.stages), JSON.stringify(st.categories), JSON.stringify(st.fields), JSON.stringify(st.templates)],
    );
    // Old history, oldest first so ids follow time; not undoable (kind legacy).
    for (const h of [...mapped.history].reverse()) {
      await c.query("INSERT INTO supply_history (at, actor, kind, text) VALUES ($1, $2, 'legacy', $3)", [h.at, h.actor, h.text]);
    }
    await c.query("INSERT INTO supply_history (actor, kind, text) VALUES ('імпорт', 'legacy', $1)", [`Імпортовано ${mapped.shipments.length} поставок зі старого сайту`]);
    await c.query('COMMIT');
    return { shipments: mapped.shipments.length, history: mapped.history.length };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** Fields compared between the old site and ours. */
type Synced = Pick<LegacyShipmentRow, 'name' | 'category' | 'action' | 'note' | 'archived' | 'steps' | 'custom'>;
const pick = (r: Synced): Synced => ({ name: r.name, category: r.category, action: r.action, note: r.note, archived: r.archived, steps: r.steps, custom: r.custom });
const FIELDS = ['name', 'category', 'action', 'note', 'archived', 'steps', 'custom'] as const;
/** Order-proof form for comparing (jsonb re-orders object keys). */
function canon(field: (typeof FIELDS)[number], v: unknown): string {
  if (field === 'steps') return JSON.stringify(((v as SupplyStep[]) ?? []).map((s) => [s.id, s.name, s.plan, s.actual, s.state, s.note ?? '']));
  if (field === 'custom') return JSON.stringify(Object.entries((v as Record<string, string>) ?? {}).filter(([, x]) => x).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(v ?? '');
}
const FIELD_UA: Record<string, string> = { name: 'назва', category: 'категорія', action: 'наступна дія', note: 'примітка', archived: 'архів', steps: 'етапи', custom: 'поля' };

export interface SyncPlan {
  insert: LegacyShipmentRow[];
  update: { id: string; before: Synced & { id: string }; after: LegacyShipmentRow; fields: string[] }[];
  /** Changed on the old site AND edited here: ours wins, the old change is reported. */
  keptOurs: string[];
  newStages: string[];
  history: { at: string; actor: string; text: string }[];
}

/** Pure: what a sync would do. A shipment edited in our app is never overwritten. */
export function planSync(
  mapped: LegacyImport,
  ours: (Synced & { id: string; legacyId: string })[],
  editedHere: Set<string>,
  stages: string[],
  knownHistory: Set<string>,
): SyncPlan {
  const byLegacy = new Map(ours.map((r) => [r.legacyId, r]));
  const plan: SyncPlan = { insert: [], update: [], keptOurs: [], newStages: [], history: [] };
  for (const m of mapped.shipments) {
    const o = byLegacy.get(m.legacyId);
    if (!o) {
      plan.insert.push(m);
      continue;
    }
    const fields = FIELDS.filter((k) => canon(k, o[k]) !== canon(k, m[k]));
    if (!fields.length) continue;
    if (editedHere.has(o.id)) plan.keptOurs.push(o.name);
    else plan.update.push({ id: o.id, before: { id: o.id, ...pick(o) }, after: m, fields });
  }
  const have = new Set(stages);
  for (const st of [...mapped.settings.stages, ...mapped.shipments.flatMap((x) => x.steps.map((y) => y.name))]) {
    if (have.has(st) || st === 'Новий етап') continue; // a placeholder, not a stage
    have.add(st);
    plan.newStages.push(st);
  }
  plan.history = mapped.history.filter((h) => !knownHistory.has(`${new Date(h.at).toISOString()}|${h.text}`));
  return plan;
}

/**
 * Pull what changed on the old site since the import. Dry run unless `apply`.
 * Matches by the old site's id, never overwrites a shipment edited here, and
 * every write is an undoable history entry by «старий сайт».
 */
export async function syncLegacy(source: string, apply: boolean): Promise<SyncPlan> {
  const ACTOR = 'старий сайт';
  const mapped = mapLegacy(await load(source));
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: ours } = await c.query<Synced & { id: string; legacy_id: string }>(
      'SELECT id, legacy_id, name, category, action, note, archived, steps, custom FROM supply_shipments WHERE legacy_id IS NOT NULL FOR UPDATE',
    );
    const { rows: edited } = await c.query<{ shipment_id: string }>(
      "SELECT DISTINCT shipment_id FROM supply_history WHERE kind = 'shipment' AND shipment_id IS NOT NULL AND actor <> $1",
      [ACTOR],
    );
    const { rows: st } = await c.query<{ stages: string[] }>('SELECT stages FROM supply_settings WHERE id = 1');
    const { rows: hist } = await c.query<{ at: Date; text: string }>("SELECT at, text FROM supply_history WHERE kind = 'legacy'");
    const plan = planSync(
      mapped,
      ours.map((r) => ({ ...r, legacyId: r.legacy_id })),
      new Set(edited.map((r) => r.shipment_id)),
      st[0]?.stages ?? [],
      new Set(hist.map((r) => `${r.at.toISOString()}|${r.text}`)),
    );

    /* eslint-disable no-console */
    for (const m of plan.insert) console.log(`+ нова: ${m.name} [${m.category}]`);
    for (const u of plan.update) console.log(`~ ${u.after.name}: ${u.fields.map((k) => FIELD_UA[k] ?? k).join(', ')}`);
    for (const n of plan.keptOurs) console.log(`= лишаю нашу версію (її вже змінили тут): ${n}`);
    if (plan.newStages.length) console.log(`+ етапи в довідник: ${plan.newStages.join(', ')}`);
    console.log(`+ рядків історії зі старого сайту: ${plan.history.length}`);
    if (!plan.insert.length && !plan.update.length) console.log('Нових змін на старому сайті немає.');
    /* eslint-enable no-console */

    if (!apply) {
      await c.query('ROLLBACK');
      return plan;
    }
    const { rows: pos } = await c.query<{ p: string }>('SELECT COALESCE(max(position), 0)::text AS p FROM supply_shipments');
    let position = Number(pos[0]?.p ?? 0);
    for (const m of plan.insert) {
      position += 1;
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO supply_shipments (legacy_id, name, category, action, note, archived, steps, custom, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [m.legacyId, m.name, m.category, m.action, m.note, m.archived, JSON.stringify(m.steps), JSON.stringify(m.custom), position],
      );
      const id = rows[0]!.id;
      await c.query(
        "INSERT INTO supply_history (actor, kind, text, shipment_id, before, after) VALUES ($1, 'shipment', $2, $3, NULL, $4)",
        [ACTOR, `Додано зі старого сайту: ${m.name}`, id, JSON.stringify({ id, ...pick(m) })],
      );
    }
    for (const u of plan.update) {
      const a = u.after;
      await c.query(
        'UPDATE supply_shipments SET name = $2, category = $3, action = $4, note = $5, archived = $6, steps = $7, custom = $8, updated_at = now() WHERE id = $1',
        [u.id, a.name, a.category, a.action, a.note, a.archived, JSON.stringify(a.steps), JSON.stringify(a.custom)],
      );
      await c.query(
        "INSERT INTO supply_history (actor, kind, text, shipment_id, before, after) VALUES ($1, 'shipment', $2, $3, $4, $5)",
        [ACTOR, `${a.name}: оновлено зі старого сайту (${u.fields.map((k) => FIELD_UA[k] ?? k).join(', ')})`, u.id, JSON.stringify(u.before), JSON.stringify({ id: u.id, ...pick(a) })],
      );
    }
    if (plan.newStages.length) {
      await c.query('UPDATE supply_settings SET stages = stages || $1::jsonb, updated_at = now() WHERE id = 1', [JSON.stringify(plan.newStages)]);
    }
    for (const h of [...plan.history].reverse()) {
      await c.query("INSERT INTO supply_history (at, actor, kind, text) VALUES ($1, $2, 'legacy', $3)", [h.at, h.actor, h.text]);
    }
    await c.query('COMMIT');
    return plan;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

if (process.argv[1]?.endsWith('importLegacy.js')) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const apply = args.includes('--apply');
  const source = args.find((a) => !a.startsWith('--')) ?? LEGACY_URL;
  const run = (): Promise<void> =>
    args.includes('--sync')
      ? syncLegacy(source, apply).then(() => {
          // eslint-disable-next-line no-console
          console.log(apply ? 'Записано.' : 'Це перевірка — нічого не записано. Щоб записати, додайте --apply.');
        })
      : importLegacy(source, force).then((r) => {
          // eslint-disable-next-line no-console
          console.log(`Imported ${r.shipments} shipments and ${r.history} history lines from ${source}`);
        });
  runMigrations()
    .then(run)
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err: Error) => {
      // eslint-disable-next-line no-console
      console.error('Supply import failed:', err.message);
      process.exit(1);
    });
}
