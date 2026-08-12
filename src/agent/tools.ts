import { z } from 'zod';
import type { ChatTool } from '../anthropic/client.js';
import { query } from '../db/pool.js';
import { readStoredFile } from '../services/storage.js';
import { extractText } from '../services/extract/index.js';
import { searchWorkspace } from '../services/qdrant.js';
import { getWorkspaceById } from '../services/workspaceAccess.js';
import { buildSupplierInstruction } from '../services/supplierInstruction.js';
import { computeDiscrepancies } from '../services/discrepancies.js';
import { refreshWorkspaceState } from '../services/status.js';
import { getMissingContext, upsertParties, type PartyInput } from '../services/parties.js';
import { classifyAndFile, sortInbox } from '../services/classify.js';
import { buildAndSaveReport } from '../services/report.js';
import { compareFileVersions, previousVersionId } from '../services/versions.js';
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
export const toolDefinitions: ChatTool[] = [
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
  {
    name: 'get_checklist',
    description:
      'Повертає розрахований чек-лист комплектності документів постачання та поточний ' +
      'статус (дані з бази, не з перечитування тексту). Використовуй для питань про ' +
      'комплектність — «що є / чого бракує».',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_discrepancies',
    description:
      'Повертає розрахований звіт розбіжностей між інвойсом, PO та пакувальним листом ' +
      '(детермінована звірка структурованих полів). Використовуй для питань про ' +
      'невідповідності — не звіряй текст вручну.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'generate_supplier_instruction',
    description:
      'Генерує інструкцію (лист) для постачальника на основі параметрів постачання та ' +
      'сторін. Якщо бракує вхідних даних — поверне їх перелік замість вигаданого листа.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_missing_context',
    description:
      'Повертає, які параметри постачання ще не задані (contract_type, parties, ' +
      'product_category, incoterm, transport_mode, origin_country). Використовуй, щоб ' +
      'зрозуміти, чого бракує, перш ніж генерувати документи.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'save_workspace_context',
    description:
      'Зберігає параметри постачання, зібрані в розмові (контракт, категорія товару, ' +
      'інкотермс, транспорт, країна походження) та за потреби сторони (parties). ' +
      'Використовуй, коли користувач повідомив ці дані.',
    input_schema: {
      type: 'object',
      properties: {
        contract_type: { type: 'string', enum: ['bilateral', 'trilateral'] },
        product_category: { type: 'string' },
        incoterm: { type: 'string' },
        transport_mode: { type: 'string' },
        origin_country: { type: 'string' },
        parties: {
          type: 'array',
          description: 'Опційно: перелік сторін для перезапису.',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['our_company', 'supplier', 'intermediary'] },
              company_name: { type: 'string' },
              is_internal: { type: 'boolean' },
              country: { type: 'string' },
            },
            required: ['role', 'company_name'],
          },
        },
      },
    },
  },
  {
    name: 'classify_and_file',
    description:
      'Класифікує один файл із інбоксу та переміщує його у відповідну теку скелета. ' +
      'Лише переміщує файл, нічого не видаляє.',
    input_schema: {
      type: 'object',
      properties: { file_id: { type: 'string', description: 'ID файлу.' } },
      required: ['file_id'],
    },
  },
  {
    name: 'sort_inbox',
    description:
      'Розкладає всі файли з інбоксу (без теки) по відповідних теках. Лише переміщує ' +
      'файли; повертає перелік «файл → тека», щоб показати користувачу.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'generate_report',
    description:
      'Генерує та зберігає HTML-звіт по постачанню (огляд, комплектність, розбіжності, ' +
      'ключові показники, висновки). Використовуй замість того, щоб складати звіт вручну.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'compare_document_versions',
    description:
      'Порівнює вказаний файл із його попередньою версією (тим, який він замінив) за ' +
      'структурованими полями. Використовуй для «порівняння нового драфту з попереднім».',
    input_schema: {
      type: 'object',
      properties: { file_id: { type: 'string', description: 'ID файлу (нова версія).' } },
      required: ['file_id'],
    },
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
    case 'get_checklist':
      return runChecklist(ctx);
    case 'get_discrepancies':
      return runDiscrepancies(ctx);
    case 'generate_supplier_instruction':
      return runSupplierInstruction(ctx);
    case 'get_missing_context':
      return runMissingContext(ctx);
    case 'save_workspace_context':
      return runSaveContext(input, ctx);
    case 'classify_and_file':
      return runClassifyAndFile(input, ctx);
    case 'sort_inbox':
      return runSortInbox(ctx);
    case 'generate_report':
      return runGenerateReport(ctx);
    case 'compare_document_versions':
      return runCompareVersions(input, ctx);
    default:
      return { result: `Невідомий інструмент: ${name}`, summary: `Невідомий інструмент`, citations: [] };
  }
}

async function runChecklist(ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await getWorkspaceById(ctx.workspaceId);
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Чек-лист: помилка', citations: [] };
  const { checklist, status } = await refreshWorkspaceState(ws);
  if (checklist.length === 0) {
    return {
      result: 'Чек-лист порожній — не задано параметри постачання (категорія/інкотермс/транспорт).',
      summary: 'Чек-лист: порожньо',
      citations: [],
    };
  }
  const lines = checklist.map((i) => `- ${i.requirement_key}: ${statusUa(i.status)}`);
  return {
    result: `Статус постачання: ${status}\n${lines.join('\n')}`,
    summary: `Чек-лист: ${checklist.length} пунктів`,
    citations: [],
  };
}

function statusUa(s: string): string {
  return s === 'verified' ? 'підтверджено' : s === 'received' ? 'отримано' : 'бракує';
}

async function runDiscrepancies(ctx: ToolContext): Promise<ToolOutcome> {
  const findings = await computeDiscrepancies(ctx.workspaceId);
  if (findings.length === 0) {
    return {
      result: 'Розбіжностей між інвойсом / PO / пакувальним листом не виявлено (за наявними даними).',
      summary: 'Розбіжності: 0',
      citations: [],
    };
  }
  const result = findings
    .map((f) => `- [${f.severity}] ${f.field}: очікується ${f.expected}; факт ${f.actual}`)
    .join('\n');
  return { result, summary: `Розбіжності: ${findings.length}`, citations: [] };
}

async function runSupplierInstruction(ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await getWorkspaceById(ctx.workspaceId);
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Інструкція: помилка', citations: [] };
  const res = await buildSupplierInstruction(ws);
  if ('missing' in res) {
    return {
      result: `Бракує даних для інструкції: ${res.missing.join(', ')}. Заповни їх у картці постачання.`,
      summary: 'Інструкція: бракує даних',
      citations: [],
    };
  }
  return { result: res.instruction, summary: 'Згенеровано інструкцію постачальнику', citations: [] };
}

async function runMissingContext(ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await getWorkspaceById(ctx.workspaceId);
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Контекст: помилка', citations: [] };
  const missing = await getMissingContext(ws);
  if (missing.length === 0) {
    return { result: 'Усі параметри постачання задані.', summary: 'Контекст: повний', citations: [] };
  }
  return {
    result: `Не задано: ${missing.join(', ')}.`,
    summary: `Бракує параметрів: ${missing.length}`,
    citations: [],
  };
}

const saveContextSchema = z.object({
  contract_type: z.enum(['bilateral', 'trilateral']).optional(),
  product_category: z.string().optional(),
  incoterm: z.string().optional(),
  transport_mode: z.string().optional(),
  origin_country: z.string().optional(),
  parties: z
    .array(
      z.object({
        role: z.enum(['our_company', 'supplier', 'intermediary']),
        company_name: z.string().min(1),
        is_internal: z.boolean().optional(),
        country: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

async function runSaveContext(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const parsed = saveContextSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return { result: 'Некоректні дані для збереження контексту.', summary: 'Контекст: помилка', citations: [] };
  }
  const ws = await getWorkspaceById(ctx.workspaceId);
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Контекст: помилка', citations: [] };

  const scalarKeys = [
    'contract_type',
    'product_category',
    'incoterm',
    'transport_mode',
    'origin_country',
  ] as const;
  const sets: string[] = [];
  const vals: unknown[] = [ws.id];
  for (const key of scalarKeys) {
    const value = parsed.data[key];
    if (value === undefined) continue;
    sets.push(`${key} = $${vals.length + 1}`);
    vals.push(value);
  }
  if (sets.length > 0) {
    await query(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = $1`, vals);
  }
  if (parsed.data.parties) {
    await upsertParties(ws.id, parsed.data.parties as PartyInput[]);
  }

  // Recompute intake_complete and refresh derived state.
  const merged = (await getWorkspaceById(ctx.workspaceId))!;
  const complete = Boolean(
    merged.contract_type &&
      merged.product_category &&
      merged.incoterm &&
      merged.transport_mode &&
      merged.origin_country,
  );
  if (complete !== merged.intake_complete) {
    await query('UPDATE workspaces SET intake_complete = $2 WHERE id = $1', [ws.id, complete]);
  }
  const finalWs = (await getWorkspaceById(ctx.workspaceId))!;
  if (finalWs.intake_complete) await refreshWorkspaceState(finalWs);

  const missing = await getMissingContext(finalWs);
  return {
    result:
      'Контекст збережено.' +
      (missing.length ? ` Ще бракує: ${missing.join(', ')}.` : ' Усі параметри задані.'),
    summary: 'Збережено контекст постачання',
    citations: [],
  };
}

async function runClassifyAndFile(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const fileId = String((input as { file_id?: unknown })?.file_id ?? '').trim();
  if (!fileId) return { result: 'Не вказано file_id.', summary: 'Класифікація: помилка', citations: [] };
  const res = await classifyAndFile(ctx.workspaceId, fileId);
  if (!res) return { result: 'Файл не знайдено.', summary: 'Класифікація: не знайдено', citations: [] };
  if (!res.to) {
    return {
      result: `Не вдалося визначити теку для «${res.name}» — залишено в інбоксі.`,
      summary: 'Класифікація: не визначено',
      citations: [],
    };
  }
  return {
    result: `Файл «${res.name}» переміщено до теки ${res.to}.`,
    summary: `Переміщено: ${res.name} → ${res.to}`,
    citations: [],
  };
}

async function runCompareVersions(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const fileId = String((input as { file_id?: unknown })?.file_id ?? '').trim();
  if (!fileId) return { result: 'Не вказано file_id.', summary: 'Порівняння: помилка', citations: [] };
  const prev = await previousVersionId(ctx.workspaceId, fileId);
  if (!prev) {
    return {
      result: 'У цього файлу немає попередньої версії для порівняння.',
      summary: 'Порівняння: немає попередньої версії',
      citations: [],
    };
  }
  const cmp = await compareFileVersions(ctx.workspaceId, fileId, prev);
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

async function runGenerateReport(ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await getWorkspaceById(ctx.workspaceId);
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Звіт: помилка', citations: [] };
  const { id } = await buildAndSaveReport(ws);
  return {
    // Do not return the full HTML — just confirm; it's saved and exportable.
    result: `HTML-звіт по постачанню згенеровано та збережено (artifact ${id}). Його можна завантажити через експорт постачання.`,
    summary: 'Згенеровано звіт постачання',
    citations: [],
  };
}

async function runSortInbox(ctx: ToolContext): Promise<ToolOutcome> {
  const { moved, unclassified } = await sortInbox(ctx.workspaceId);
  if (moved.length === 0 && unclassified.length === 0) {
    return { result: 'Інбокс порожній — нема чого сортувати.', summary: 'Сортування: 0', citations: [] };
  }
  const lines = moved.map((m) => `- «${m.name}» → ${m.to}`);
  if (unclassified.length) {
    lines.push(`Не визначено (залишено в інбоксі): ${unclassified.map((u) => `«${u.name}»`).join(', ')}`);
  }
  return {
    result: lines.join('\n'),
    summary: `Розкладено: ${moved.length}, не визначено: ${unclassified.length}`,
    citations: [],
  };
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
