import { mkdir, writeFile, readFile, unlink, rm } from 'node:fs/promises';
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

function workspaceDir(workspaceId: string): string {
  return resolve(config.STORAGE_DIR, workspaceId);
}

/** Absolute on-disk path for a stored file. */
export function diskPathFor(workspaceId: string, fileId: string, name: string): string {
  return join(workspaceDir(workspaceId), `${fileId}-${safeName(name)}`);
}

export async function storeFile(
  workspaceId: string,
  fileId: string,
  name: string,
  data: Buffer,
): Promise<string> {
  const dir = workspaceDir(workspaceId);
  await mkdir(dir, { recursive: true });
  const path = diskPathFor(workspaceId, fileId, name);
  await writeFile(path, data);
  return path;
}

export async function readStoredFile(path: string): Promise<Buffer> {
  return readFile(path);
}

export async function deleteStoredFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Already gone — ignore.
  }
}

/** Removes a workspace's entire on-disk file directory (used on workspace delete). */
export async function deleteWorkspaceStorage(workspaceId: string): Promise<void> {
  try {
    await rm(workspaceDir(workspaceId), { recursive: true, force: true });
  } catch {
    // Nothing stored yet / already gone — ignore.
  }
}

export type { FileType };
