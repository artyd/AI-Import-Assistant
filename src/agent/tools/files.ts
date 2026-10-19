import { query } from '../../db/pool.js';
import { readStoredFile, contentHashOf } from '../../lib/storage.js';
import { enqueueIndexJob } from '../../lib/queue/index.js';
import { publishFileStatus } from '../../lib/events/fileStatus.js';
import { classifyAndFile, sortInbox } from '../../documents/classify.js';
import { previousVersionId, compareFileVersions } from '../../documents/versions.js';
import { type ToolContext, type ToolOutcome, requireWorkspace } from './shared.js';

export async function runClassifyAndFile(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const fileId = String((input as { file_id?: unknown })?.file_id ?? '').trim();
  if (!fileId) return { result: 'Не вказано file_id.', summary: 'Класифікація: помилка', citations: [] };
  const res = await classifyAndFile(requireWorkspace(ctx), fileId);
  if (!res) return { result: 'Файл не знайдено.', summary: 'Класифікація: не знайдено', citations: [] };
  if (!res.to) {
    // Low-confidence guess left in inbox with a suggestion, or truly unclassified.
    const suggestion = res.suggested
      ? ` Схоже на теку ${res.suggested} (${res.reason}) — підтвердіть вручну.`
      : '';
    return {
      result: `Не вдалося впевнено визначити теку для «${res.name}» — залишено в інбоксі.${suggestion}`,
      summary: 'Класифікація: потрібне підтвердження',
      citations: [],
    };
  }
  return {
    result: `Файл «${res.name}» переміщено до теки ${res.to}. Причина: ${res.reason}.`,
    summary: `Переміщено: ${res.name} → ${res.to}`,
    citations: [],
  };
}

export async function runCompareVersions(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const fileId = String((input as { file_id?: unknown })?.file_id ?? '').trim();
  if (!fileId) return { result: 'Не вказано file_id.', summary: 'Порівняння: помилка', citations: [] };
  const prev = await previousVersionId(requireWorkspace(ctx), fileId);
  if (!prev) {
    return {
      result: 'У цього файлу немає попередньої версії для порівняння.',
      summary: 'Порівняння: немає попередньої версії',
      citations: [],
    };
  }
  const cmp = await compareFileVersions(requireWorkspace(ctx), fileId, prev);
  if (!cmp) return { result: 'Файл не знайдено в постачанні.', summary: 'Порівняння: не знайдено', citations: [] };
  if (cmp.differences.length === 0) {
    return {
      result: 'Структуровані поля нової та попередньої версії збігаються — змін немає.',
      summary: 'Порівняння: без змін',
      citations: [],
    };
  }
  const lines = cmp.differences.map(
    (d) => `- ${d.field}: було «${fmt(d.b)}» → стало «${fmt(d.a)}»`,
  );
  return {
    result: `Зміни щодо попередньої версії:\n${lines.join('\n')}`,
    summary: `Порівняння: ${cmp.differences.length} змін`,
    citations: [],
  };
}

function fmt(v: unknown): string {
  return v === null || v === undefined || v === '' ? '—' : String(v);
}

export async function runSortInbox(ctx: ToolContext): Promise<ToolOutcome> {
  const { moved, unclassified } = await sortInbox(requireWorkspace(ctx));
  if (moved.length === 0 && unclassified.length === 0) {
    return { result: 'Інбокс порожній — нема чого сортувати.', summary: 'Сортування: 0', citations: [] };
  }
  const lines = moved.map((m) => `- «${m.name}» → ${m.to}${m.reason ? ` (${m.reason})` : ''}`);
  for (const u of unclassified) {
    lines.push(
      u.suggested
        ? `- «${u.name}» — залишено в інбоксі, схоже на ${u.suggested} (${u.reason}) — підтвердіть вручну`
        : `- «${u.name}» — не визначено, залишено в інбоксі`,
    );
  }
  return {
    result: lines.join('\n'),
    summary: `Розкладено: ${moved.length}, не визначено: ${unclassified.length}`,
    citations: [],
  };
}

export async function runNormalizeShipmentFiles(ctx: ToolContext): Promise<ToolOutcome> {
  // 1. Backfill content_hash for files that predate this feature.
  const { rows: unhashed } = await query<{ id: string; disk_path: string }>(
    `SELECT id, disk_path FROM files
     WHERE workspace_id = $1 AND is_latest = true AND content_hash IS NULL`,
    [requireWorkspace(ctx)],
  );
  let backfilled = 0;
  for (const f of unhashed) {
    try {
      const buf = await readStoredFile(f.disk_path);
      await query('UPDATE files SET content_hash = $2 WHERE id = $1', [f.id, contentHashOf(buf)]);
      backfilled++;
    } catch {
      // Stored bytes missing/unreadable — skip; not fatal for the rest of the sweep.
    }
  }

  // 2. Report (never delete) duplicate groups among is_latest files.
  const { rows: dupGroups } = await query<{ content_hash: string; names: string[]; ids: string[] }>(
    `SELECT content_hash, array_agg(name ORDER BY created_at) AS names, array_agg(id ORDER BY created_at) AS ids
     FROM files
     WHERE workspace_id = $1 AND is_latest = true AND content_hash IS NOT NULL
     GROUP BY content_hash HAVING COUNT(*) > 1`,
    [requireWorkspace(ctx)],
  );

  // 3. Bulk-retry currently-errored files (same primitive as POST …/reindex).
  const { rows: errored } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM files WHERE workspace_id = $1 AND status = 'error'`,
    [requireWorkspace(ctx)],
  );
  for (const f of errored) {
    await query(`UPDATE files SET status = 'queued', error_reason = NULL WHERE id = $1`, [f.id]);
    await enqueueIndexJob(f.id);
    await publishFileStatus(requireWorkspace(ctx), { fileId: f.id, status: 'queued', name: f.name });
  }

  const lines: string[] = [];
  lines.push(`Донараховано хешів: ${backfilled}.`);
  if (dupGroups.length === 0) {
    lines.push('Дублікатів за вмістом не знайдено.');
  } else {
    lines.push(`Знайдено груп дублікатів: ${dupGroups.length} (файли НЕ видалено, це лише звіт):`);
    for (const g of dupGroups) lines.push(`- ${g.names.map((n) => `«${n}»`).join(' = ')}`);
  }
  lines.push(`Поставлено на повторну індексацію (були в статусі «Помилка»): ${errored.length}.`);

  return {
    result: lines.join('\n'),
    summary: `Нормалізація: хешів +${backfilled}, дублікатів ${dupGroups.length}, повторно проіндексовано ${errored.length}`,
    citations: [],
  };
}
