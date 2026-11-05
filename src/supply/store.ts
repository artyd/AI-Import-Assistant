import type pg from 'pg';
import { pool, query } from '../db/pool.js';
import { describeChange } from './logic.js';
import type {
  ShipmentInput,
  ShipmentPatch,
  SupplyHistoryEntry,
  SupplySettings,
  SupplyShipment,
  SupplyStep,
} from './types.js';

interface ShipmentRow {
  id: string;
  name: string;
  category: string;
  action: string;
  note: string;
  archived: boolean;
  steps: SupplyStep[];
  custom: Record<string, string>;
  position: number;
  created_at: Date;
  updated_at: Date;
}

const COLS = 'id, name, category, action, note, archived, steps, custom, position, created_at, updated_at';

function toShipment(r: ShipmentRow): SupplyShipment {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    action: r.action,
    note: r.note,
    archived: r.archived,
    steps: Array.isArray(r.steps) ? r.steps : [],
    custom: r.custom && typeof r.custom === 'object' ? r.custom : {},
    position: r.position,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Thrown when an edit started from an older version of the shipment. */
export class SupplyConflict extends Error {
  constructor(public current: SupplyShipment) {
    super('conflict');
  }
}
export class SupplyNotFound extends Error {}
export class SupplyNotUndoable extends Error {}

async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

async function logHistory(
  c: pg.PoolClient,
  e: { actor: string; kind: 'shipment' | 'settings'; text: string; shipmentId: string | null; before: unknown; after: unknown },
): Promise<void> {
  await c.query(
    'INSERT INTO supply_history (actor, kind, text, shipment_id, before, after) VALUES ($1, $2, $3, $4, $5, $6)',
    [e.actor, e.kind, e.text.slice(0, 500), e.shipmentId, e.before === null ? null : JSON.stringify(e.before), e.after === null ? null : JSON.stringify(e.after)],
  );
}

export async function listShipments(): Promise<SupplyShipment[]> {
  const { rows } = await query<ShipmentRow>(`SELECT ${COLS} FROM supply_shipments ORDER BY position, created_at`);
  return rows.map(toShipment);
}

export async function getSettings(): Promise<SupplySettings> {
  const { rows } = await query<SupplySettings>('SELECT stages, categories, fields, templates FROM supply_settings WHERE id = 1');
  return rows[0] ?? { stages: [], categories: ['Міжнародні'], fields: [], templates: [] };
}

/** Changes whenever anything is written (every write logs history). */
export async function revision(): Promise<string> {
  const { rows } = await query<{ r: string | null }>('SELECT max(id)::text AS r FROM supply_history');
  return rows[0]?.r ?? '0';
}

export async function createShipment(input: ShipmentInput, actor: string): Promise<SupplyShipment> {
  return tx(async (c) => {
    const { rows } = await c.query<ShipmentRow>(
      `INSERT INTO supply_shipments (name, category, action, note, steps, custom, position)
       VALUES ($1, $2, $3, $4, $5, $6, (SELECT COALESCE(max(position), 0) + 1 FROM supply_shipments))
       RETURNING ${COLS}`,
      [input.name, input.category, input.action, input.note, JSON.stringify(input.steps), JSON.stringify(input.custom)],
    );
    const created = toShipment(rows[0]!);
    await logHistory(c, { actor, kind: 'shipment', text: `Додано поставку: ${created.name}`, shipmentId: created.id, before: null, after: created });
    return created;
  });
}

async function lockShipment(c: pg.PoolClient, id: string): Promise<SupplyShipment> {
  const { rows } = await c.query<ShipmentRow>(`SELECT ${COLS} FROM supply_shipments WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows[0]) throw new SupplyNotFound();
  return toShipment(rows[0]);
}

async function writeShipment(c: pg.PoolClient, s: SupplyShipment): Promise<SupplyShipment> {
  const { rows } = await c.query<ShipmentRow>(
    `UPDATE supply_shipments SET name = $2, category = $3, action = $4, note = $5, archived = $6, steps = $7, custom = $8, updated_at = now()
     WHERE id = $1 RETURNING ${COLS}`,
    [s.id, s.name, s.category, s.action, s.note, s.archived, JSON.stringify(s.steps), JSON.stringify(s.custom)],
  );
  return toShipment(rows[0]!);
}

export async function updateShipment(id: string, patch: ShipmentPatch, actor: string): Promise<SupplyShipment> {
  return tx(async (c) => {
    const before = await lockShipment(c, id);
    if (patch.expectedUpdatedAt && patch.expectedUpdatedAt !== before.updatedAt) throw new SupplyConflict(before);
    const { expectedUpdatedAt: _ignored, ...fields } = patch;
    const next: SupplyShipment = { ...before, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
    const after = await writeShipment(c, next);
    await logHistory(c, { actor, kind: 'shipment', text: describeChange(before, after), shipmentId: id, before, after });
    return after;
  });
}

export async function setArchived(id: string, archived: boolean, actor: string): Promise<SupplyShipment> {
  return tx(async (c) => {
    const before = await lockShipment(c, id);
    if (before.archived === archived) return before;
    const after = await writeShipment(c, { ...before, archived });
    await logHistory(c, { actor, kind: 'shipment', text: describeChange(before, after), shipmentId: id, before, after });
    return after;
  });
}

export async function putSettings(next: SupplySettings, actor: string): Promise<SupplySettings> {
  return tx(async (c) => {
    const { rows } = await c.query<SupplySettings>('SELECT stages, categories, fields, templates FROM supply_settings WHERE id = 1 FOR UPDATE');
    await c.query(
      `INSERT INTO supply_settings (id, stages, categories, fields, templates, updated_at) VALUES (1, $1, $2, $3, $4, now())
       ON CONFLICT (id) DO UPDATE SET stages = $1, categories = $2, fields = $3, templates = $4, updated_at = now()`,
      [JSON.stringify(next.stages), JSON.stringify(next.categories), JSON.stringify(next.fields), JSON.stringify(next.templates)],
    );
    await logHistory(c, { actor, kind: 'settings', text: 'Змінено довідники', shipmentId: null, before: rows[0] ?? null, after: next });
    return next;
  });
}

interface HistoryRow {
  id: string;
  at: Date;
  actor: string;
  kind: SupplyHistoryEntry['kind'];
  text: string;
  shipment_id: string | null;
  undoable: boolean;
}

export async function listHistory(limit: number, shipmentId?: string): Promise<SupplyHistoryEntry[]> {
  const { rows } = await query<HistoryRow>(
    `SELECT id::text, at, actor, kind, text, shipment_id,
            (kind <> 'legacy' AND undone_at IS NULL AND (before IS NOT NULL OR after IS NOT NULL)) AS undoable
     FROM supply_history WHERE ($2::uuid IS NULL OR shipment_id = $2) ORDER BY id DESC LIMIT $1`,
    [limit, shipmentId ?? null],
  );
  return rows.map((r) => ({ id: Number(r.id), at: r.at.toISOString(), actor: r.actor, kind: r.kind, text: r.text, shipmentId: r.shipment_id, undoable: r.undoable }));
}

/**
 * Undo one history entry: put back the snapshot from before it. Undoing a
 * creation archives the shipment (nothing is ever deleted).
 */
export async function undoHistory(historyId: number, actor: string): Promise<void> {
  await tx(async (c) => {
    const { rows } = await c.query<{ kind: string; text: string; shipment_id: string | null; before: unknown; after: unknown; undone_at: Date | null }>(
      'SELECT kind, text, shipment_id, before, after, undone_at FROM supply_history WHERE id = $1 FOR UPDATE',
      [historyId],
    );
    const h = rows[0];
    if (!h) throw new SupplyNotFound();
    if (h.undone_at || h.kind === 'legacy' || (h.before === null && h.after === null)) throw new SupplyNotUndoable();

    if (h.kind === 'settings') {
      const prev = h.before as SupplySettings | null;
      if (!prev) throw new SupplyNotUndoable();
      await c.query(
        'UPDATE supply_settings SET stages = $1, categories = $2, fields = $3, templates = $4, updated_at = now() WHERE id = 1',
        [JSON.stringify(prev.stages), JSON.stringify(prev.categories), JSON.stringify(prev.fields), JSON.stringify(prev.templates)],
      );
      await logHistory(c, { actor, kind: 'settings', text: `Відкочено: ${h.text}`, shipmentId: null, before: h.after, after: prev });
    } else {
      if (!h.shipment_id) throw new SupplyNotUndoable();
      const now = await lockShipment(c, h.shipment_id);
      const prev = h.before as SupplyShipment | null;
      const restored: SupplyShipment = prev
        ? { ...now, name: prev.name, category: prev.category, action: prev.action, note: prev.note, archived: prev.archived, steps: prev.steps, custom: prev.custom }
        : { ...now, archived: true };
      const after = await writeShipment(c, restored);
      await logHistory(c, { actor, kind: 'shipment', text: `Відкочено: ${h.text}`, shipmentId: now.id, before: now, after });
    }
    await c.query('UPDATE supply_history SET undone_at = now() WHERE id = $1', [historyId]);
  });
}
