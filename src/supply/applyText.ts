import { pool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import type { SupplyStep } from './types.js';

/**
 * Apply reviewed text edits to Поставки records (spec 008) — e.g. translating
 * names, notes and next actions to Ukrainian. The edits come on stdin, so no
 * register data lives in the (public) repo:
 *
 *   docker compose exec -T backend node dist/supply/applyText.js [--apply] < edits.json
 *
 * edits.json: [{ "id": "<old-site id>", "name": ["було", "стало"], "action": [..], "note": [..],
 *               "steps": { "<step id>": ["було", "стало"] },   (step notes)
 *               "custom": { "<field id>": ["було", "стало"] } }]   (extra fields)
 * A field changes only while it still reads exactly "було" (trimmed), so a text
 * someone edited meanwhile is left alone and reported. Dry run unless --apply;
 * every change is an undoable history entry.
 */

type Pair = [string, string];
export interface TextEdit {
  id: string;
  name?: Pair;
  action?: Pair;
  note?: Pair;
  steps?: Record<string, Pair>;
  custom?: Record<string, Pair>;
}

interface Row {
  id: string;
  legacy_id: string;
  name: string;
  category: string;
  action: string;
  note: string;
  archived: boolean;
  steps: SupplyStep[];
  custom: Record<string, string>;
}

const eq = (a: string, b: string) => a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ');

/** Pure: the record after the edits that still match, plus what was skipped. */
type Editable = Pick<Row, 'name' | 'action' | 'note' | 'steps'> & { custom?: Record<string, string> };
export function planEdit(row: Editable, e: TextEdit): { next: Required<Editable>; changed: string[]; skipped: string[] } {
  const next = { name: row.name, action: row.action, note: row.note, steps: row.steps.map((s) => ({ ...s })), custom: { ...(row.custom ?? {}) } };
  const changed: string[] = [];
  const skipped: string[] = [];
  for (const k of ['name', 'action', 'note'] as const) {
    const p = e[k];
    if (!p) continue;
    if (eq(next[k], p[0])) {
      if (next[k] !== p[1]) {
        next[k] = p[1];
        changed.push(k);
      }
    } else if (!eq(next[k], p[1])) skipped.push(`${k}: зараз «${next[k]}»`);
  }
  for (const [sid, p] of Object.entries(e.steps ?? {})) {
    const st = next.steps.find((s) => s.id === sid);
    if (!st) {
      skipped.push(`етап ${sid}: немає`);
      continue;
    }
    if (eq(st.note, p[0])) {
      if (st.note !== p[1]) {
        st.note = p[1];
        changed.push(`етап «${st.name}»`);
      }
    } else if (!eq(st.note, p[1])) skipped.push(`етап «${st.name}»: зараз «${st.note}»`);
  }
  for (const [fid, p] of Object.entries(e.custom ?? {})) {
    const cur = next.custom[fid] ?? '';
    if (eq(cur, p[0])) {
      if (cur !== p[1]) {
        next.custom[fid] = p[1];
        changed.push(`поле ${fid}`);
      }
    } else if (!eq(cur, p[1])) skipped.push(`поле ${fid}: зараз «${cur}»`);
  }
  return { next, changed, skipped };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function applyText(edits: TextEdit[], apply: boolean): Promise<{ changed: number; skipped: number }> {
  const c = await pool.connect();
  let changedRows = 0;
  let skippedRows = 0;
  try {
    await c.query('BEGIN');
    for (const e of edits) {
      const { rows } = await c.query<Row>(
        'SELECT id, legacy_id, name, category, action, note, archived, steps, custom FROM supply_shipments WHERE legacy_id = $1 FOR UPDATE',
        [e.id],
      );
      const row = rows[0];
      /* eslint-disable no-console */
      if (!row) {
        console.log(`? ${e.name?.[0] ?? e.id}: такої поставки немає`);
        skippedRows += 1;
        continue;
      }
      const { next, changed, skipped } = planEdit(row, e);
      if (skipped.length) {
        console.log(`= ${row.name}: пропущено (текст уже інший) — ${skipped.join('; ')}`);
        skippedRows += 1;
      }
      if (!changed.length) continue;
      console.log(`~ ${row.name} → ${next.name}: ${changed.join(', ')}`);
      /* eslint-enable no-console */
      changedRows += 1;
      if (!apply) continue;
      await c.query('UPDATE supply_shipments SET name = $2, action = $3, note = $4, steps = $5, custom = $6, updated_at = now() WHERE id = $1', [
        row.id, next.name, next.action, next.note, JSON.stringify(next.steps), JSON.stringify(next.custom),
      ]);
      const snap = (r: Editable) => ({ id: row.id, name: r.name, category: row.category, action: r.action, note: r.note, archived: row.archived, steps: r.steps, custom: r.custom ?? row.custom });
      await c.query(
        "INSERT INTO supply_history (actor, kind, text, shipment_id, before, after) VALUES ('переклад', 'shipment', $1, $2, $3, $4)",
        [`${next.name}: переклад українською`, row.id, JSON.stringify(snap(row)), JSON.stringify(snap(next))],
      );
    }
    await c.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { changed: changedRows, skipped: skippedRows };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

if (process.argv[1]?.endsWith('applyText.js')) {
  const apply = process.argv.includes('--apply');
  runMigrations()
    .then(readStdin)
    .then((raw) => applyText(JSON.parse(raw) as TextEdit[], apply))
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log(`${apply ? 'Змінено' : 'Буде змінено'}: ${r.changed}; пропущено: ${r.skipped}.${apply ? '' : ' Це перевірка — щоб записати, додайте --apply.'}`);
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err: Error) => {
      // eslint-disable-next-line no-console
      console.error('applyText failed:', err.message);
      process.exit(1);
    });
}
