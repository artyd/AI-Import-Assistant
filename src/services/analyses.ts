import { pool, query } from '../db/pool.js';
import type { AnalysisResult } from './analysis/run.js';

/**
 * Persistence for B-2 consolidated analyses. One `analyses` row holds the full
 * result the FE card reads back; one `archive_records` row is the durable, capped
 * "Архів" index. The archive is FIFO-capped per owner (newest 50 kept).
 */

const ARCHIVE_CAP = 50;

/** The stored `checks` jsonb payload (everything not in meta/rows/totals). */
interface ChecksBlob {
  criticalAlert: string;
  nctsList: string[];
  warnings: string[];
  hasHigh: boolean;
  aiDegraded: boolean;
  sourceChecked?: boolean;
  costDataAvailable?: boolean;
  fx?: AnalysisResult['fx'];
}

export interface ArchiveRecord {
  id: string;
  collectionId: string | null;
  /** The full analysis this record points to; null once the analysis is gone. */
  analysisId: string | null;
  source: string;
  sheet: string;
  itemCount: number;
  payable: number;
  hasHigh: boolean;
  createdAt: string;
}

/**
 * Persists an analysis + its archive record, then FIFO-caps this owner's archive.
 * Mutates `result.id` to the new analysis id and returns it.
 */
export async function persistAnalysis(
  ownerId: string,
  collectionId: string,
  result: AnalysisResult,
  messageId: string | null = null,
): Promise<string> {
  const checks: ChecksBlob = {
    criticalAlert: result.criticalAlert,
    nctsList: result.nctsList,
    warnings: result.warnings,
    hasHigh: result.hasHigh,
    aiDegraded: result.aiDegraded,
    sourceChecked: result.sourceChecked,
    costDataAvailable: result.costDataAvailable,
    fx: result.fx,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO analyses (collection_id, message_id, source, sheet, meta, rows, totals, checks)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)
       RETURNING id`,
      [
        collectionId,
        messageId,
        result.source,
        result.sheet,
        JSON.stringify(result.meta),
        JSON.stringify(result.rows),
        JSON.stringify(result.totals),
        JSON.stringify(checks),
      ],
    );
    const analysisId = rows[0]!.id;

    await client.query(
      `INSERT INTO archive_records (owner_id, collection_id, analysis_id, source, sheet, item_count, payable, has_high)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ownerId, collectionId, analysisId, result.source, result.sheet, result.totals.count, result.totals.payable, result.hasHigh],
    );

    // FIFO cap: drop this owner's oldest archive rows beyond ARCHIVE_CAP.
    await client.query(
      `DELETE FROM archive_records
       WHERE owner_id = $1 AND id NOT IN (
         SELECT id FROM archive_records WHERE owner_id = $1
         ORDER BY created_at DESC LIMIT $2
       )`,
      [ownerId, ARCHIVE_CAP],
    );

    await client.query('COMMIT');
    result.id = analysisId;
    return analysisId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listArchive(ownerId: string): Promise<ArchiveRecord[]> {
  const { rows } = await query<{
    id: string;
    collection_id: string | null;
    analysis_id: string | null;
    source: string;
    sheet: string;
    item_count: number;
    payable: string;
    has_high: boolean;
    created_at: string;
  }>(
    `SELECT id, collection_id, analysis_id, source, sheet, item_count, payable, has_high, created_at
     FROM archive_records WHERE owner_id = $1 ORDER BY created_at DESC`,
    [ownerId],
  );
  return rows.map((r) => ({
    id: r.id,
    collectionId: r.collection_id,
    analysisId: r.analysis_id,
    source: r.source,
    sheet: r.sheet,
    itemCount: r.item_count,
    payable: Number(r.payable),
    hasHigh: r.has_high,
    createdAt: r.created_at,
  }));
}

/** The most recent analysis for a collection (owner-scoped), or null. */
export async function getLatestAnalysisForCollection(
  ownerId: string,
  collectionId: string,
): Promise<AnalysisResult | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT a.id FROM analyses a
     JOIN collections c ON c.id = a.collection_id
     WHERE a.collection_id = $1 AND c.owner_id = $2
     ORDER BY a.created_at DESC LIMIT 1`,
    [collectionId, ownerId],
  );
  const id = rows[0]?.id;
  return id ? getAnalysisForOwner(ownerId, id) : null;
}

/** Owner-scoped delete of one archive record. Returns false when not found. */
export async function deleteArchiveRecord(ownerId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    'DELETE FROM archive_records WHERE id = $1 AND owner_id = $2',
    [id, ownerId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Loads a persisted analysis, owner-scoped via its collection. Returns the full
 * AnalysisResult (reconstructed from the jsonb columns) or null on miss.
 */
export async function getAnalysisForOwner(
  ownerId: string,
  analysisId: string,
): Promise<AnalysisResult | null> {
  const { rows } = await query<{
    id: string;
    source: string;
    sheet: string;
    meta: AnalysisResult['meta'];
    rows: AnalysisResult['rows'];
    totals: AnalysisResult['totals'];
    checks: ChecksBlob;
  }>(
    `SELECT a.id, a.source, a.sheet, a.meta, a.rows, a.totals, a.checks
     FROM analyses a
     JOIN collections c ON c.id = a.collection_id
     WHERE a.id = $1 AND c.owner_id = $2`,
    [analysisId, ownerId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    meta: row.meta,
    rows: row.rows,
    totals: row.totals,
    source: row.source,
    sheet: row.sheet,
    criticalAlert: row.checks?.criticalAlert ?? '',
    nctsList: row.checks?.nctsList ?? [],
    warnings: row.checks?.warnings ?? [],
    hasHigh: row.checks?.hasHigh ?? false,
    aiDegraded: row.checks?.aiDegraded ?? false,
    sourceChecked: row.checks?.sourceChecked ?? false,
    // Default true for records saved before this flag existed (keep money shown).
    costDataAvailable: row.checks?.costDataAvailable ?? true,
    fx: row.checks?.fx ?? null,
  };
}
