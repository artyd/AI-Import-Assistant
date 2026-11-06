import { query } from '../db/pool.js';
import { logistEnabled, uktzedLookup } from './logist/index.js';
import {
  HS_REQUIREMENT_KEYS,
  hsCodesOf,
  importSectionOf,
  qdproMeasures,
  type CachedHsRequirements,
  type HsRequirement,
} from './qdproRequirements.js';

/**
 * Cache of the documents each УКТ ЗЕД code requires on import (qdpro), in
 * `hs_requirements`. The verdicts only READ it (no network in a snapshot);
 * `refreshShipmentHsRequirements` fills it, best-effort, from the shipment
 * pipeline (`shipmentChanged`) just before the verdicts are computed.
 */

const FRESH_DAYS = 7;
/** How long the pipeline waits for qdpro before computing the verdicts anyway. */
const WAIT_MS = 8_000;
/** Codes fetched per refresh (a big FCL fills the cache over several changes). */
const MAX_CODES_PER_REFRESH = 10;
/** After a failed fetch, the code is not retried for this long (per process). */
const FAILURE_BACKOFF_MS = 10 * 60 * 1000;

const failedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();

function isRequirement(v: unknown): v is HsRequirement {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.key === 'string' && (HS_REQUIREMENT_KEYS as readonly string[]).includes(r.key) && typeof r.evidence === 'string';
}

/** Cached requirements for these codes (whatever their age; stale beats none). */
export async function loadCachedRequirements(codes: string[]): Promise<CachedHsRequirements[]> {
  if (codes.length === 0) return [];
  const { rows } = await query<{ hs_code: string; requirements: unknown }>(
    'SELECT hs_code, requirements FROM hs_requirements WHERE hs_code = ANY($1::text[]) ORDER BY hs_code',
    [codes],
  );
  return rows.map((r) => ({
    hs_code: r.hs_code,
    requirements: Array.isArray(r.requirements) ? r.requirements.filter(isRequirement) : [],
  }));
}

/** Fetch one code from qdpro and store its import requirements. Throws on failure. */
async function fetchAndStore(code: string): Promise<void> {
  const r = await uktzedLookup(code);
  const section = importSectionOf(r);
  // A page without an import regime is not evidence of "no requirements".
  if (!section.trim()) throw new Error('qdpro: немає розділу ІМПОРТ');
  const requirements = qdproMeasures(section);
  await query(
    `INSERT INTO hs_requirements (hs_code, requirements, source, fetched_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (hs_code) DO UPDATE
       SET requirements = EXCLUDED.requirements, source = EXCLUDED.source, fetched_at = EXCLUDED.fetched_at`,
    [code, JSON.stringify(requirements), r.source ?? 'qdpro'],
  );
}

function refreshCode(code: string): Promise<void> {
  const running = inFlight.get(code);
  if (running) return running;
  const p = fetchAndStore(code)
    .then(() => {
      failedAt.delete(code);
    })
    .catch((err: Error) => {
      failedAt.set(code, Date.now());
      // eslint-disable-next-line no-console
      console.error(`qdpro requirements for ${code} failed:`, err.message);
    })
    .finally(() => inFlight.delete(code));
  inFlight.set(code, p);
  return p;
}

/** The codes of a shipment's latest extracted files. */
async function shipmentHsCodes(workspaceId: string): Promise<string[]> {
  const { rows } = await query<{ fields: Record<string, unknown> | null }>(
    `SELECT de.extracted_fields AS fields
     FROM files f JOIN document_extractions de ON de.file_id = f.id
     WHERE f.workspace_id = $1 AND f.is_latest = true`,
    [workspaceId],
  );
  return [...new Set(rows.flatMap((r) => hsCodesOf(r.fields)))].sort();
}

/**
 * Best-effort: fetch qdpro requirements for every code of the shipment that is
 * missing from the cache or older than 7 days. Waits at most ~8 s (a slower
 * fetch still lands in the cache for the next recompute), never throws, and
 * does nothing when the reference service is off (LOGIST_MCP_URL empty).
 */
export async function refreshShipmentHsRequirements(workspaceId: string, waitMs: number = WAIT_MS): Promise<void> {
  if (!logistEnabled()) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = (async () => {
      const codes = await shipmentHsCodes(workspaceId);
      if (codes.length === 0) return;
      const { rows: fresh } = await query<{ hs_code: string }>(
        `SELECT hs_code FROM hs_requirements
         WHERE hs_code = ANY($1::text[]) AND fetched_at > now() - make_interval(days => $2)`,
        [codes, FRESH_DAYS],
      );
      const have = new Set(fresh.map((r) => r.hs_code));
      const now = Date.now();
      const due = codes
        .filter((c) => !have.has(c) && now - (failedAt.get(c) ?? 0) > FAILURE_BACKOFF_MS)
        .slice(0, MAX_CODES_PER_REFRESH);
      await Promise.all(due.map(refreshCode));
    })();
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    });
    await Promise.race([work.catch((err: Error) => {
      // eslint-disable-next-line no-console
      console.error(`qdpro requirements refresh failed for workspace ${workspaceId}:`, err.message);
    }), timeout]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`qdpro requirements refresh failed for workspace ${workspaceId}:`, (err as Error).message);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
