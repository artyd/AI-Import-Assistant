import { query } from '../../db/pool.js';
import { getCarrier } from './carriers.js';
import { scanTrackingNumbers } from './detect.js';
import { listTracked } from './track.js';

export interface TrackingSuggestion {
  number: string;
  carrier: string;
  carrierName: string;
  kind: string;
  mode: string;
  files: string[];
}

/**
 * Container / AWB / B/L numbers found in a shipment's documents (stored
 * Markdown) that the user is not tracking yet. Only check-digit-valid or
 * carrier-prefixed hits (see scanTrackingNumbers) — never noise.
 */
export async function trackingSuggestions(userId: string, workspaceId: string): Promise<TrackingSuggestion[]> {
  const { rows } = await query<{ name: string; pages: Array<{ markdown?: string }> }>(
    `SELECT f.name, m.pages FROM file_markdown m JOIN files f ON f.id = m.file_id
     WHERE m.workspace_id = $1`,
    [workspaceId],
  );
  const tracked = new Set((await listTracked(userId, { includeArchived: true })).map((t) => t.number));
  const found = new Map<string, TrackingSuggestion>();
  for (const r of rows) {
    const text = (Array.isArray(r.pages) ? r.pages : []).map((pg) => pg?.markdown ?? '').join('\n');
    for (const hit of scanTrackingNumbers(text)) {
      if (tracked.has(hit.number)) continue;
      const cur = found.get(hit.number) ?? {
        number: hit.number,
        carrier: hit.carrier,
        carrierName: getCarrier(hit.carrier)?.name ?? hit.carrier,
        kind: hit.kind,
        mode: hit.mode,
        files: [],
      };
      if (!cur.files.includes(r.name)) cur.files.push(r.name);
      found.set(hit.number, cur);
    }
  }
  return [...found.values()].slice(0, 30);
}
