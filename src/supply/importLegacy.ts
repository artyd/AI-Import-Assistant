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
      const parsed = stepSchema.safeParse({
        id: str(st.id, 64) || `s${steps.length}`,
        name: toUa(str(st.name, 120).trim()) || 'Етап',
        plan: day(st.plan),
        actual: day(st.actual),
        state: ['active', 'done', 'pending'].includes(st.state as string) ? st.state : 'pending',
        note: str(st.note, 1000),
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

if (process.argv[1]?.endsWith('importLegacy.js')) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const source = args.find((a) => !a.startsWith('--')) ?? LEGACY_URL;
  runMigrations()
    .then(() => importLegacy(source, force))
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log(`Imported ${r.shipments} shipments and ${r.history} history lines from ${source}`);
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err: Error) => {
      // eslint-disable-next-line no-console
      console.error('Supply import failed:', err.message);
      process.exit(1);
    });
}
