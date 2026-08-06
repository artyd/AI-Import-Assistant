import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db/pool.js';
import { readStoredFile } from '../services/storage.js';
import { extractText } from '../services/extract/index.js';
import { searchWorkspace } from '../services/qdrant.js';
import type { Citation } from '../services/conversations.js';
import type { FileType } from '../domain/folders.js';

export interface ToolContext {
  workspaceId: string;
}

export interface ToolOutcome {
  /** Text returned to the model as the tool_result content. */
  result: string;
  /** Short human-readable summary for the tool_result SSE event / agent log. */
  summary: string;
  /** Sources surfaced by this tool call, for inline citation chips. */
  citations: Citation[];
}

/** Tool definitions advertised to Claude. The model decides which to call. */
export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'search_documents',
    description:
      'Семантичний пошук по проіндексованих документах поточного постачання. ' +
      'Використовуй для широких/асоціативних запитів, коли не знаєш точного файлу. ' +
      'Повертає найрелевантніші фрагменти з назвою файлу та сторінкою.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Пошуковий запит українською або мовою документа.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_file',
    description:
      'Читає повний або частковий вміст конкретного файлу постачання. ' +
      'Використовуй, коли потрібне точне формулювання пункту, конкретна цифра чи назва файлу відома.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Назва файлу (напр. "invoice_draft_v2.pdf").' },
        range: {
          type: 'string',
          description: 'Необовʼязково: діапазон сторінок "1-2" (для PDF) або символів "0-2000".',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description:
      'Повертає дерево файлів поточного постачання (теки, файли, статус індексації). ' +
      'Використовуй, щоб зорієнтуватися, які документи взагалі є.',
    input_schema: { type: 'object', properties: {} },
  },
];

interface FileRow {
  id: string;
  name: string;
  type: FileType;
  disk_path: string;
  status: string;
  folder_name: string | null;
}

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  switch (name) {
    case 'search_documents':
      return runSearch(input, ctx);
    case 'read_file':
      return runReadFile(input, ctx);
    case 'list_files':
      return runListFiles(ctx);
    default:
      return { result: `Невідомий інструмент: ${name}`, summary: `Невідомий інструмент`, citations: [] };
  }
}

async function runSearch(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const q = String((input as { query?: unknown })?.query ?? '').trim();
  if (!q) return { result: 'Порожній запит.', summary: 'Пошук: порожній запит', citations: [] };

  const hits = await searchWorkspace(ctx.workspaceId, q, 6);
  if (hits.length === 0) {
    return { result: 'Нічого не знайдено серед проіндексованих документів.', summary: 'Пошук: 0 результатів', citations: [] };
  }

  const citations = dedupeCitations(hits.map((h) => ({ file: h.file, page: h.page })));
  const result = hits
    .map((h, i) => {
      const loc = h.page ? `, стор. ${h.page}` : '';
      return `[${i + 1}] ${h.file}${loc}\n${h.text}`;
    })
    .join('\n\n');
  const files = [...new Set(hits.map((h) => h.file))].join(', ');
  return { result, summary: `Знайдено ${hits.length} фрагм. у: ${files}`, citations };
}

async function runReadFile(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const path = String((input as { path?: unknown })?.path ?? '').trim();
  const range = (input as { range?: unknown })?.range;
  if (!path) return { result: 'Не вказано файл.', summary: 'Читання: не вказано файл', citations: [] };

  const file = await findFile(ctx.workspaceId, path);
  if (!file) {
    return { result: `Файл "${path}" не знайдено в постачанні.`, summary: `Файл не знайдено: ${path}`, citations: [] };
  }

  const buf = await readStoredFile(file.disk_path);
  let pages = await extractText(buf, file.type);
  if (pages.length === 0) {
    return {
      result: `Файл "${file.name}" не містить текстового шару (можливо, скан-зображення).`,
      summary: `Читання: ${file.name} (без тексту)`,
      citations: [{ file: file.name, page: null }],
    };
  }

  // Optional page range "N-M" for paged formats.
  if (typeof range === 'string' && /^\d+-\d+$/.test(range) && pages.some((p) => p.page)) {
    const [from, to] = range.split('-').map(Number) as [number, number];
    pages = pages.filter((p) => p.page !== null && p.page >= from && p.page <= to);
  }

  let text = pages.map((p) => (p.page ? `--- стор. ${p.page} ---\n${p.text}` : p.text)).join('\n\n');

  // Optional char range "0-2000".
  if (typeof range === 'string' && /^\d+-\d+$/.test(range) && !pages.some((p) => p.page)) {
    const [from, to] = range.split('-').map(Number) as [number, number];
    text = text.slice(from, to);
  }

  const MAX = 12000;
  const truncated = text.length > MAX;
  if (truncated) text = `${text.slice(0, MAX)}\n…[обрізано]`;

  const citations = dedupeCitations(pages.map((p) => ({ file: file.name, page: p.page })));
  return {
    result: `Файл: ${file.name}\n${text}`,
    summary: `Прочитано: ${file.name}${truncated ? ' (частково)' : ''}`,
    citations: citations.length ? citations : [{ file: file.name, page: null }],
  };
}

async function runListFiles(ctx: ToolContext): Promise<ToolOutcome> {
  const files = await listFiles(ctx.workspaceId);
  if (files.length === 0) {
    return { result: 'У постачанні поки немає файлів.', summary: 'Список файлів: порожньо', citations: [] };
  }
  const byFolder = new Map<string, FileRow[]>();
  for (const f of files) {
    const key = f.folder_name ?? '(корінь)';
    (byFolder.get(key) ?? byFolder.set(key, []).get(key)!).push(f);
  }
  const lines: string[] = [];
  for (const [folder, group] of byFolder) {
    lines.push(`${folder}:`);
    for (const f of group) lines.push(`  - ${f.name} [${statusLabel(f.status)}]`);
  }
  return { result: lines.join('\n'), summary: `Список файлів: ${files.length}`, citations: [] };
}

function statusLabel(status: string): string {
  return status === 'ready'
    ? 'проіндексовано'
    : status === 'indexing'
      ? 'індексується'
      : status === 'error'
        ? 'помилка'
        : 'у черзі';
}

async function findFile(workspaceId: string, path: string): Promise<FileRow | null> {
  const name = path.split(/[/\\]/).pop() ?? path;
  const { rows } = await query<FileRow>(
    `SELECT f.id, f.name, f.type, f.disk_path, f.status, fo.name AS folder_name
     FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE f.workspace_id = $1 AND lower(f.name) = lower($2)
     LIMIT 1`,
    [workspaceId, name],
  );
  return rows[0] ?? null;
}

async function listFiles(workspaceId: string): Promise<FileRow[]> {
  const { rows } = await query<FileRow>(
    `SELECT f.id, f.name, f.type, f.disk_path, f.status, fo.name AS folder_name
     FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE f.workspace_id = $1
     ORDER BY fo.position NULLS LAST, f.created_at`,
    [workspaceId],
  );
  return rows;
}

function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    const key = `${c.file}#${c.page ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}
