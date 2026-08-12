import { createRequire } from 'node:module';
import type { Archiver } from 'archiver';
import type { FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';

// @types/archiver@8 exposes only named type exports (no callable default), while
// the runtime module IS the factory function. Load it via require and type it.
const require = createRequire(import.meta.url);
const archiver = require('archiver') as (
  format: string,
  options?: { zlib?: { level?: number } },
) => Archiver;
import { query } from '../db/pool.js';
import type { WorkspaceRow } from './workspaceAccess.js';
import { readStoredFile } from './storage.js';
import { computeChecklist } from './checklist.js';
import { computeDiscrepancies } from './discrepancies.js';
import { buildAndSaveReport } from './report.js';
import { saveArtifact, getLatestArtifacts, type ArtifactType } from './artifacts.js';

/**
 * Streams a workspace as a zip: files under their current folders (inbox →
 * `_Inbox/`, superseded versions → `_OldVersions/` so nothing is orphaned), plus
 * a `_Generated/` folder with the latest artifacts. `_Generated/` content is
 * regenerated if it's older than the newest uploaded file.
 */

const GENERATED: { type: ArtifactType; filename: string }[] = [
  { type: 'supplier_instruction', filename: 'supplier_instruction.md' },
  { type: 'discrepancy_report', filename: 'discrepancy_report.json' },
  { type: 'checklist_snapshot', filename: 'checklist_snapshot.json' },
  { type: 'shipment_report_html', filename: 'shipment_report.html' },
];

function sanitize(name: string): string {
  return (name || 'export').replace(/[^\w.\-]+/g, '_').slice(0, 80);
}

async function regenerateStaleArtifacts(ws: WorkspaceRow): Promise<void> {
  const { rows } = await query<{ newest: Date | null }>(
    'SELECT max(created_at) AS newest FROM files WHERE workspace_id = $1',
    [ws.id],
  );
  const newest = rows[0]?.newest ? new Date(rows[0].newest).getTime() : 0;
  const latest = await getLatestArtifacts(ws.id);
  const isStale = (t: ArtifactType): boolean => {
    const a = latest[t];
    return !a || new Date(a.generated_at).getTime() < newest;
  };

  // supplier_instruction is intentionally not force-generated here (it can fail
  // on missing intake context) — the latest existing one is included as-is.
  if (isStale('shipment_report_html')) await buildAndSaveReport(ws);
  if (isStale('discrepancy_report')) {
    const d = await computeDiscrepancies(ws.id);
    await saveArtifact(ws.id, 'discrepancy_report', JSON.stringify(d, null, 2), 'json');
  }
  if (isStale('checklist_snapshot')) {
    const c = await computeChecklist(ws);
    await saveArtifact(ws.id, 'checklist_snapshot', JSON.stringify(c, null, 2), 'json');
  }
}

export async function streamWorkspaceZip(ws: WorkspaceRow, reply: FastifyReply): Promise<void> {
  await regenerateStaleArtifacts(ws);
  const latest = await getLatestArtifacts(ws.id);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('Export archive error:', err.message);
  });

  reply.header('Content-Type', 'application/zip');
  reply.header('Content-Disposition', `attachment; filename="${sanitize(ws.number)}.zip"`);
  reply.send(archive);

  // De-dupe colliding entry names.
  const used = new Set<string>();
  const uniqueName = (path: string): string => {
    if (!used.has(path)) {
      used.add(path);
      return path;
    }
    const dot = path.lastIndexOf('.');
    const base = dot > 0 ? path.slice(0, dot) : path;
    const ext = dot > 0 ? path.slice(dot) : '';
    let i = 2;
    let candidate = `${base}_${i}${ext}`;
    while (used.has(candidate)) candidate = `${base}_${++i}${ext}`;
    used.add(candidate);
    return candidate;
  };

  const { rows: files } = await query<{
    name: string;
    disk_path: string;
    is_latest: boolean;
    version: number;
    folder_name: string | null;
  }>(
    `SELECT f.name, f.disk_path, f.is_latest, f.version, fo.name AS folder_name
     FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE f.workspace_id = $1
     ORDER BY fo.position NULLS LAST, f.created_at`,
    [ws.id],
  );

  for (const f of files) {
    let buf: Buffer;
    try {
      buf = await readStoredFile(f.disk_path);
    } catch {
      continue; // Skip files missing on disk rather than aborting the whole zip.
    }
    const entry = !f.is_latest
      ? `_OldVersions/v${f.version}_${f.name}`
      : f.folder_name
        ? `${f.folder_name}/${f.name}`
        : `_Inbox/${f.name}`;
    archive.append(buf, { name: uniqueName(entry) });
  }

  for (const g of GENERATED) {
    const a = latest[g.type];
    if (!a) continue;
    try {
      const buf = await readFile(a.content_ref);
      archive.append(buf, { name: uniqueName(`_Generated/${g.filename}`) });
    } catch {
      // Artifact file missing on disk — skip.
    }
  }

  await archive.finalize();
}
