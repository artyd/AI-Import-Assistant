import { query } from '../../db/pool.js';
import { readStoredFile } from '../../lib/storage.js';
import { type AnalysisInput, runAnalysis } from '../../analysis/run.js';
import { formatAnalysisMarkdown } from '../../analysis/format.js';
import { persistAnalysis } from '../../analysis/analyses.js';
import { type ToolContext, type ToolOutcome } from './shared.js';
import { listLots, loadFclFiles } from '../../shipments/lots.js';
import { findManifestFile } from '../../reconciliation/fcl.js';
import { buildManifestCsv, invoiceLines } from '../../reconciliation/manifest.js';

async function isFcl(workspaceId: string): Promise<boolean> {
  const { rows } = await query<{ kind: string }>('SELECT kind FROM workspaces WHERE id = $1', [workspaceId]);
  return rows[0]?.kind === 'fcl';
}

export async function runConsolidatedAnalysis(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  // An FCL chat scopes by workspaceId (spec 006); the legacy collection scope is the same id.
  const fclId = ctx.collectionId ?? (ctx.workspaceId && (await isFcl(ctx.workspaceId)) ? ctx.workspaceId : undefined);
  if (!fclId) {
    return { result: 'Аналіз доступний лише в межах збірника.', summary: 'Аналіз: помилка', citations: [] };
  }
  const sourceUrl = String((input as { source_url?: unknown })?.source_url ?? '').trim();
  const manifestText = String((input as { manifest_text?: unknown })?.manifest_text ?? '').trim();

  // Source: an explicit Google Sheets link / pasted table, else the collection's
  // latest uploaded manifest file.
  let analysisInput: AnalysisInput;
  if (sourceUrl) {
    analysisInput = { kind: 'sheetUrl', url: sourceUrl };
  } else if (manifestText) {
    analysisInput = { kind: 'text', text: manifestText };
  } else {
    // The FCL manifest (spec 006): the manifest file, else the latest spreadsheet,
    // else a manifest built from the lots' invoices.
    const files = await loadFclFiles(fclId);
    const manifest = findManifestFile(files);
    const lots = await listLots(fclId);
    const lines = invoiceLines(files, Object.fromEntries(lots.map((l) => [l.id, l.name])));
    // Without a manifest, the invoices are a better source than any spreadsheet.
    type SheetFile = { id: string; name: string; type: string; disk_path: string };
    const { rows } =
      !manifest && lines.length > 0
        ? { rows: [] as SheetFile[] }
        : await query<SheetFile>(
            `SELECT id, name, type, disk_path FROM files
             WHERE workspace_id = $1 AND is_latest = true AND type IN ('xlsx', 'csv')
               AND ($2::uuid IS NULL OR id = $2)
             ORDER BY created_at DESC LIMIT 1`,
            [fclId, manifest?.file_id ?? null],
          );
    const file = rows[0];
    if (file) {
      try {
        const buf = await readStoredFile(file.disk_path);
        analysisInput = { kind: 'file', buffer: buf, filename: file.name };
      } catch {
        return { result: `Не вдалося прочитати файл «${file.name}».`, summary: 'Аналіз: помилка читання', citations: [] };
      }
    } else {
      if (lines.length === 0) {
        return {
          result:
            'Немає джерела для аналізу: дайте посилання на Google Sheets, вставте таблицю, ' +
            'завантажте файл-маніфест (xlsx/csv) у збірник, або дочекайтеся, поки інвойси партій буде прочитано.',
          summary: 'Аналіз: немає маніфесту',
          citations: [],
        };
      }
      analysisInput = {
        kind: 'file',
        buffer: Buffer.from(buildManifestCsv(lines), 'utf8'),
        filename: 'Маніфест (зібрано з інвойсів).csv',
      };
    }
  }

  let result;
  try {
    result = await runAnalysis(analysisInput, ctx.ownerId);
  } catch (err) {
    return { result: `Аналіз не вдався: ${(err as Error).message}`, summary: 'Аналіз: помилка', citations: [] };
  }

  // Persist (best-effort — still return the computed result on failure).
  if (ctx.ownerId) {
    try {
      await persistAnalysis(ctx.ownerId, fclId, result);
    } catch {
      /* persistence failed — the analysis text is still useful this turn */
    }
  }

  // Return the ready per-product answer; the agent presents it to the user as-is.
  return {
    result: formatAnalysisMarkdown(result),
    summary: `Аналіз збірника: ${result.totals.count} позицій`,
    citations: [],
  };
}
