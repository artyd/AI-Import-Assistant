import { copyFile, link, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from './config.js';
import { query } from '../db/pool.js';
import { folderPaths } from '../shipments/folderPath.js';

/**
 * The human folder of a shipment / FCL on the server's disk (spec 007):
 *
 *   <STORAGE_DIR>/_tree/<Збірник 2026-0815 — Китай 15> (<id8>)/
 *     Партія — Shandong X/Paracetamol/CoA.pdf
 *     Митниця/Shandong X/Invoice.pdf
 *     Інбокс/…
 *
 * It mirrors the app's folder tree with HARD LINKS to the stored files (no second
 * copy of the bytes; a copy only where the filesystem refuses links). A file
 * linked into several product folders appears in each. Rebuilt whole after the
 * tree changes — debounced, so a batch of 200 filings is one rebuild.
 */

const TREE_DIR = '_tree';
const DEBOUNCE_MS = 3000;
const timers = new Map<string, NodeJS.Timeout>();

/** A filesystem-safe single path segment (Cyrillic kept). */
export function safeSegment(name: string): string {
  const s = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|[. ]+$/g, '');
  return (s || '_').slice(0, 120);
}

/** Rebuilds the workspace's disk folder shortly after the last change. Never throws. */
export function scheduleDiskTree(workspaceId: string): void {
  const prev = timers.get(workspaceId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(workspaceId);
    syncDiskTree(workspaceId).catch((err: Error) => {
      // eslint-disable-next-line no-console
      console.error(`Disk tree sync failed for workspace ${workspaceId}:`, err.message);
    });
  }, DEBOUNCE_MS);
  t.unref?.();
  timers.set(workspaceId, t);
}

export async function syncDiskTree(workspaceId: string): Promise<string | null> {
  const { rows: wsRows } = await query<{ number: string; supplier: string; kind: string }>(
    'SELECT number, supplier, kind FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  const ws = wsRows[0];
  const base = resolve(config.STORAGE_DIR, TREE_DIR);
  const tag = `(${workspaceId.slice(0, 8)})`;
  await mkdir(base, { recursive: true });
  // Drop this workspace's previous folder (its label may have been renamed).
  for (const entry of await readdir(base).catch(() => [] as string[])) {
    if (entry.endsWith(tag)) await rm(join(base, entry), { recursive: true, force: true });
  }
  if (!ws) return null; // workspace deleted → folder removed

  const label = `${ws.kind === 'fcl' ? 'Збірник' : 'Постачання'} ${ws.number}${ws.supplier ? ` — ${ws.supplier}` : ''}`;
  const root = join(base, `${safeSegment(label)} ${tag}`);
  const tmp = `${root}.tmp-${process.pid}-${Date.now()}`;

  const paths = await folderPaths(workspaceId);
  for (const p of paths.values()) await mkdir(join(tmp, ...p.map(safeSegment)), { recursive: true });

  const { rows: files } = await query<{ id: string; name: string; disk_path: string; folder_id: string | null; links: string[] }>(
    `SELECT f.id, f.name, f.disk_path, f.folder_id,
            COALESCE((SELECT array_agg(l.folder_id) FROM file_links l WHERE l.file_id = f.id), '{}') AS links
     FROM files f WHERE f.workspace_id = $1 AND f.is_latest = true ORDER BY f.created_at`,
    [workspaceId],
  );
  const taken = new Set<string>();
  const place = async (dirParts: string[], name: string, src: string): Promise<void> => {
    const dir = join(tmp, ...dirParts.map(safeSegment));
    await mkdir(dir, { recursive: true });
    const clean = safeSegment(name);
    let target = join(dir, clean);
    for (let i = 2; taken.has(target); i++) {
      const dot = clean.lastIndexOf('.');
      target = join(dir, dot > 0 ? `${clean.slice(0, dot)} (${i})${clean.slice(dot)}` : `${clean} (${i})`);
    }
    taken.add(target);
    try {
      await link(src, target);
    } catch {
      await copyFile(src, target).catch(() => undefined); // missing source → skip
    }
  };
  for (const f of files) {
    const own = f.folder_id ? paths.get(f.folder_id) : undefined;
    await place(own ?? ['Інбокс'], f.name, f.disk_path);
    for (const l of f.links) {
      const p = paths.get(l);
      if (p) await place(p, f.name, f.disk_path);
    }
  }
  await rm(root, { recursive: true, force: true });
  await rename(tmp, root);
  return root;
}
