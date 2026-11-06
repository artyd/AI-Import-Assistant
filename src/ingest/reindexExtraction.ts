import { pool, query } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { shipmentChanged } from '../shipments/state.js';
import type { MarkdownPage } from './markdown/format.js';
import { extractFromPages, extractionIsSubstantive, upsertExtraction } from './extraction/store.js';

/**
 * Re-run the field extraction of already-read files from their STORED Markdown
 * (no repeat OCR), so older extractions gain fields added since — bank details,
 * dangerous goods, signature / stamp, blank form fields. Dry run unless --apply.
 * Files whose fields a human confirmed on the verification screen are skipped —
 * a re-extraction would overwrite those corrections. A new extraction that
 * comes back empty keeps the old one. Every affected shipment is then
 * recomputed once (shipmentChanged 'documents'). Run in the container:
 *   node dist/ingest/reindexExtraction.js                       # what would be re-extracted
 *   node dist/ingest/reindexExtraction.js --apply               # re-extract all
 *   node dist/ingest/reindexExtraction.js --workspace <id> --apply
 */

interface Row {
  id: string;
  name: string;
  workspace_id: string;
  number: string;
  verified: boolean;
}

export interface ReindexExtractionResult {
  candidates: number;
  skippedVerified: number;
  updated: number;
  unchanged: number;
  failed: number;
  workspaces: number;
}

export async function reindexExtraction(
  apply: boolean,
  workspaceId: string | null = null,
): Promise<ReindexExtractionResult> {
  const { rows } = await query<Row>(
    `SELECT f.id, f.name, f.workspace_id, w.number,
            COALESCE((de.extracted_fields->>'verified')::boolean, false) AS verified
     FROM files f
     JOIN workspaces w ON w.id = f.workspace_id
     JOIN file_markdown m ON m.file_id = f.id
     JOIN document_extractions de ON de.file_id = f.id
     WHERE f.is_latest = true AND m.char_count > 0
       AND ($1::uuid IS NULL OR f.workspace_id = $1::uuid)
     ORDER BY w.number, f.name`,
    [workspaceId],
  );
  const todo = rows.filter((r) => !r.verified);
  const skippedVerified = rows.length - todo.length;
  /* eslint-disable no-console */
  for (const r of rows.filter((x) => x.verified)) console.log(`= пропуск (поля підтверджено вручну) ${r.number}: ${r.name}`);
  if (!apply) {
    for (const r of todo) console.log(`+ ${r.number}: ${r.name}`);
    console.log(`Файлів з витягнутими полями: ${rows.length}; до перечитування: ${todo.length}; пропущено: ${skippedVerified}.`);
    return { candidates: todo.length, skippedVerified, updated: 0, unchanged: 0, failed: 0, workspaces: 0 };
  }

  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  const touched = new Set<string>();
  for (const r of todo) {
    try {
      const { rows: md } = await query<{ pages: MarkdownPage[] }>('SELECT pages FROM file_markdown WHERE file_id = $1', [r.id]);
      const pages = md[0]?.pages ?? [];
      const meta = await extractFromPages(pages, r.name);
      if (!meta.fields || !extractionIsSubstantive(meta.fields)) {
        unchanged += 1;
        console.log(`· без змін (нових полів не витягнуто) ${r.number}: ${r.name}`);
        continue;
      }
      await upsertExtraction(r.id, r.workspace_id, meta.fields);
      await query('UPDATE files SET extraction_status = $2 WHERE id = $1', [r.id, meta.truncated ? 'partial' : 'ok']);
      touched.add(r.workspace_id);
      updated += 1;
      console.log(`+ ${r.number}: ${r.name}${meta.truncated ? ' (частково)' : ''}`);
    } catch (err) {
      failed += 1;
      console.error(`! помилка ${r.number}: ${r.name} — ${(err as Error).message.slice(0, 200)}`);
    }
  }
  // The extractions changed: autopilot → intake → verdicts, once per shipment.
  for (const ws of touched) {
    try {
      await shipmentChanged(ws, 'documents');
    } catch (err) {
      console.error(`! перерахунок постачання ${ws} не вдався — ${(err as Error).message.slice(0, 200)}`);
    }
  }
  console.log(
    `Перечитано: ${updated}; без змін: ${unchanged}; помилок: ${failed}; пропущено (підтверджено): ${skippedVerified}; ` +
      `перераховано постачань: ${touched.size}.`,
  );
  /* eslint-enable no-console */
  return { candidates: todo.length, skippedVerified, updated, unchanged, failed, workspaces: touched.size };
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

if (process.argv[1]?.endsWith('reindexExtraction.js')) {
  const apply = process.argv.includes('--apply');
  const workspace = argValue('--workspace');
  if (workspace !== null && !/^[0-9a-f-]{36}$/i.test(workspace)) {
    // eslint-disable-next-line no-console
    console.error('--workspace очікує UUID постачання.');
    process.exit(1);
  }
  runMigrations()
    .then(() => reindexExtraction(apply, workspace))
    .then(() => {
      // eslint-disable-next-line no-console
      if (!apply) console.log('Це перевірка — нічого не змінено. Щоб перечитати, додайте --apply.');
    })
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err: Error) => {
      // eslint-disable-next-line no-console
      console.error('Reindex failed:', err.message);
      process.exit(1);
    });
}
