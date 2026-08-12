import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { query } from '../db/pool.js';

/**
 * Persists an agent/user-generated artifact (supplier instruction, discrepancy
 * report, etc.) to disk and records it in `generated_artifacts`. `content_ref`
 * holds the on-disk path, mirroring how `services/storage.ts` stores uploads.
 */

export type ArtifactType =
  | 'supplier_instruction'
  | 'discrepancy_report'
  | 'shipment_report_html'
  | 'checklist_snapshot';

export async function saveArtifact(
  workspaceId: string,
  type: ArtifactType,
  content: string,
  ext: string,
  generatedBy: 'agent' | 'user' = 'agent',
): Promise<{ id: string; content_ref: string }> {
  const dir = resolve(config.STORAGE_DIR, workspaceId, 'artifacts');
  await mkdir(dir, { recursive: true });
  const id = uuidv4();
  const contentRef = join(dir, `${id}.${ext}`);
  await writeFile(contentRef, content, 'utf8');

  await query(
    `INSERT INTO generated_artifacts (id, workspace_id, type, content_ref, generated_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, workspaceId, type, contentRef, generatedBy],
  );

  return { id, content_ref: contentRef };
}

export interface ArtifactRow {
  id: string;
  type: ArtifactType;
  content_ref: string;
  generated_at: string;
  generated_by: 'agent' | 'user';
}

/** Latest artifact of a given type for a workspace, or null. */
export async function getLatestArtifact(
  workspaceId: string,
  type: ArtifactType,
): Promise<ArtifactRow | null> {
  const { rows } = await query<ArtifactRow>(
    `SELECT id, type, content_ref, generated_at, generated_by
     FROM generated_artifacts
     WHERE workspace_id = $1 AND type = $2
     ORDER BY generated_at DESC LIMIT 1`,
    [workspaceId, type],
  );
  return rows[0] ?? null;
}

/** Latest artifact of each type for a workspace, keyed by type. */
export async function getLatestArtifacts(
  workspaceId: string,
): Promise<Partial<Record<ArtifactType, ArtifactRow>>> {
  const { rows } = await query<ArtifactRow>(
    `SELECT DISTINCT ON (type) id, type, content_ref, generated_at, generated_by
     FROM generated_artifacts
     WHERE workspace_id = $1
     ORDER BY type, generated_at DESC`,
    [workspaceId],
  );
  const out: Partial<Record<ArtifactType, ArtifactRow>> = {};
  for (const r of rows) out[r.type] = r;
  return out;
}
