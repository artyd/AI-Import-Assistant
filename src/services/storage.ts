import { mkdir, writeFile, readFile, unlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { config } from '../config.js';
import type { FileType } from '../domain/folders.js';

/**
 * Allow-list of accepted upload extensions (brief: pdf, docx, xlsx, csv, png,
 * jpg). Everything else — including executables — is rejected before anything
 * touches disk.
 */
const ALLOWED_EXT = new Set(['pdf', 'docx', 'xlsx', 'csv', 'png', 'jpg', 'jpeg']);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isAllowedUpload(name: string): boolean {
  return ALLOWED_EXT.has(extensionOf(name));
}

function safeName(name: string): string {
  // Strip any path components and keep it filesystem-safe.
  const base = name.replace(/[/\\]/g, '_');
  return base.replace(/[^\w.\-() +]/g, '_').slice(0, 200);
}

// The storage namespace is just a directory keyed by an entity id. Both
// workspaces (Постачання) and collections (Збірник) own files, so the param is
// a neutral `entityId` rather than a workspace-specific name.
function entityDir(entityId: string): string {
  return resolve(config.STORAGE_DIR, entityId);
}

/** Absolute on-disk path for a stored file. */
export function diskPathFor(entityId: string, fileId: string, name: string): string {
  return join(entityDir(entityId), `${fileId}-${safeName(name)}`);
}

export async function storeFile(
  entityId: string,
  fileId: string,
  name: string,
  data: Buffer,
): Promise<string> {
  const dir = entityDir(entityId);
  await mkdir(dir, { recursive: true });
  const path = diskPathFor(entityId, fileId, name);
  await writeFile(path, data);
  return path;
}

export async function readStoredFile(path: string): Promise<Buffer> {
  return readFile(path);
}

/** SHA-256 of a file's bytes, used for exact-content dedup. */
export function contentHashOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function deleteStoredFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Already gone — ignore.
  }
}

/** Removes an entity's entire on-disk file directory (workspace or collection delete). */
export async function deleteEntityStorage(entityId: string): Promise<void> {
  try {
    await rm(entityDir(entityId), { recursive: true, force: true });
  } catch {
    // Nothing stored yet / already gone — ignore.
  }
}

/** @deprecated Use {@link deleteEntityStorage}. Kept for the workspace-delete caller. */
export const deleteWorkspaceStorage = deleteEntityStorage;

export type { FileType };
