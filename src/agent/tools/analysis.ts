import { query } from '../../db/pool.js';
import { readStoredFile } from '../../lib/storage.js';
import { type AnalysisInput, runAnalysis } from '../../analysis/run.js';
import { formatAnalysisMarkdown } from '../../analysis/format.js';
import { persistAnalysis } from '../../analysis/analyses.js';
import { type ToolContext, type ToolOutcome } from './shared.js';

export async function runConsolidatedAnalysis(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.collectionId) {
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
    const { rows } = await query<{ id: string; name: string; type: string; disk_path: string }>(
      `SELECT id, name, type, disk_path FROM files
       WHERE collection_id = $1 AND is_latest = true AND type IN ('xlsx', 'csv')
       ORDER BY created_at DESC LIMIT 1`,
      [ctx.collectionId],
    );
    const file = rows[0];
    if (!file) {
      return {
        result:
          'Немає джерела для аналізу: дайте посилання на Google Sheets, вставте таблицю, ' +
          'або завантажте файл-маніфест (xlsx/csv) у збірник.',
        summary: 'Аналіз: немає маніфесту',
        citations: [],
      };
    }
    try {
      const buf = await readStoredFile(file.disk_path);
      analysisInput = { kind: 'file', buffer: buf, filename: file.name };
    } catch {
      return { result: `Не вдалося прочитати файл «${file.name}».`, summary: 'Аналіз: помилка читання', citations: [] };
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
      await persistAnalysis(ctx.ownerId, ctx.collectionId, result);
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
