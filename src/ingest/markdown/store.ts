import { pool, query } from "../../db/pool.js";
import { chunkPages } from "../extract/chunk.js";
import type { ConversionResult } from "./convert.js";
import type { MarkdownPage } from "./format.js";
import {
  buildTsQuery,
  diversifyByDocument,
  substringPatterns,
  type SearchHit,
} from "./searchQuery.js";

export type { SearchHit } from "./searchQuery.js";

/**
 * Persistence + retrieval for ingest-time Markdown.
 *
 * - `file_markdown`      — the whole document as Markdown pages (what read_file,
 *                          extraction and classification read — no re-extraction,
 *                          no repeat OCR per read).
 * - `document_sections`  — the same Markdown split into ~800-token sections with
 *                          a Postgres `tsvector`, backing `search_documents`
 *                          (keyword/full-text search — no embedding vendor).
 */

export interface StoredMarkdown {
  pages: MarkdownPage[];
  converter: string;
  partial: boolean;
  pageCount: number | null;
  note: string | null;
  charCount: number;
}

/** Replaces the stored Markdown + search sections for a file. */
export async function saveFileMarkdown(
  fileId: string,
  workspaceId: string,
  conv: ConversionResult,
): Promise<void> {
  const charCount = conv.pages.reduce((n, p) => n + p.markdown.length, 0);
  const sections = chunkPages(
    conv.pages.map((p) => ({ page: p.page, text: p.markdown })),
  );
  // One transaction + a row lock on the file, so a concurrent save (worker vs a
  // lazy read_file conversion) can't interleave/duplicate sections.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT 1 FROM files WHERE id = $1 FOR UPDATE", [
      fileId,
    ]);
    await client.query(
      `INSERT INTO file_markdown (file_id, workspace_id, pages, char_count, page_count, converter, partial, note)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
     ON CONFLICT (file_id) DO UPDATE SET
       pages = EXCLUDED.pages, char_count = EXCLUDED.char_count, page_count = EXCLUDED.page_count,
       converter = EXCLUDED.converter, partial = EXCLUDED.partial, note = EXCLUDED.note, created_at = now()`,
      [
        fileId,
        workspaceId,
        JSON.stringify(conv.pages),
        charCount,
        conv.pageCount,
        conv.converter,
        conv.partial,
        conv.note,
      ],
    );

    await client.query("DELETE FROM document_sections WHERE file_id = $1", [
      fileId,
    ]);
    // Batched multi-row insert (a 100-page document is a few hundred sections).
    for (let i = 0; i < sections.length; i += 200) {
      const batch = sections.slice(i, i + 200);
      const values: unknown[] = [];
      const rows = batch.map((s, j) => {
        values.push(fileId, workspaceId, s.index, s.page, s.text);
        const b = j * 5;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
      });
      await client.query(
        `INSERT INTO document_sections (file_id, workspace_id, seq, page, text) VALUES ${rows.join(", ")}`,
        values,
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function loadFileMarkdown(
  fileId: string,
): Promise<StoredMarkdown | null> {
  const { rows } = await query<{
    pages: MarkdownPage[];
    converter: string;
    partial: boolean;
    page_count: number | null;
    note: string | null;
    char_count: number;
  }>(
    "SELECT pages, converter, partial, page_count, note, char_count FROM file_markdown WHERE file_id = $1",
    [fileId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    pages: r.pages,
    converter: r.converter,
    partial: r.partial,
    pageCount: r.page_count,
    note: r.note,
    charCount: r.char_count,
  };
}

// ── Full-text search ─────────────────────────────────────────────────────────

/** Full-text search over a workspace's current (is_latest) documents. */
export async function searchWorkspace(
  workspaceId: string,
  q: string,
  limit = 24,
): Promise<SearchHit[]> {
  const tsq = buildTsQuery(q);
  const patterns = substringPatterns(q);
  if (!tsq && patterns.length === 0) return [];

  const params: unknown[] = [workspaceId];
  const conds: string[] = [];
  let rank = "0";
  if (tsq) {
    params.push(tsq);
    conds.push(`s.tsv @@ to_tsquery('simple', $${params.length})`);
    rank = `ts_rank_cd(s.tsv, to_tsquery('simple', $${params.length}))`;
  }
  let boost = "0";
  if (patterns.length) {
    params.push(patterns);
    conds.push(`s.text ILIKE ANY($${params.length})`);
    boost = `CASE WHEN s.text ILIKE ANY($${params.length}) THEN 1 ELSE 0 END`;
  }
  const { rows } = await query<{
    file_id: string;
    name: string;
    folder: string | null;
    page: number | null;
    text: string;
    score: number;
  }>(
    `SELECT s.file_id, f.name, fo.name AS folder, s.page, s.text, (${rank} + ${boost})::float AS score
     FROM document_sections s
     JOIN files f ON f.id = s.file_id AND f.is_latest = true
     LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE s.workspace_id = $1 AND (${conds.join(" OR ")})
     ORDER BY score DESC, s.seq
     LIMIT ${Math.max(limit * 4, 96)}`,
    params,
  );
  const hits: SearchHit[] = rows.map((r) => ({
    file: r.name,
    fileId: r.file_id,
    page: r.page,
    folder: r.folder,
    text: r.text,
    score: r.score,
  }));
  return diversifyByDocument(hits, limit, 6);
}

/** Search coverage: how many sections exist and how many current files have no Markdown yet. */
export async function workspaceCoverage(
  workspaceId: string,
): Promise<{ sections: number; files: number; unconverted: number }> {
  const { rows } = await query<{
    sections: number;
    files: number;
    unconverted: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM document_sections s JOIN files f ON f.id = s.file_id AND f.is_latest
         WHERE s.workspace_id = $1) AS sections,
       (SELECT count(*)::int FROM files WHERE workspace_id = $1 AND is_latest) AS files,
       (SELECT count(*)::int FROM files f WHERE f.workspace_id = $1 AND f.is_latest
         AND NOT EXISTS (SELECT 1 FROM file_markdown m WHERE m.file_id = f.id)) AS unconverted`,
    [workspaceId],
  );
  return rows[0] ?? { sections: 0, files: 0, unconverted: 0 };
}
