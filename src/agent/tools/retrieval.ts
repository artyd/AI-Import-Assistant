import { query } from '../../db/pool.js';
import { config } from '../../lib/config.js';
import { versionHints, formatProvenance, pdfProvenance, baseNameKey } from '../../documents/fileHints.js';
import { readStoredFile } from '../../lib/storage.js';
import { convertToMarkdown } from '../../ingest/markdown/convert.js';
import { joinPages } from '../../ingest/markdown/format.js';
import { searchWorkspace, workspaceCoverage, loadFileMarkdown, saveFileMarkdown } from '../../ingest/markdown/store.js';
import type { Citation } from '../../chat/conversations.js';
import type { FileType } from '../../shipments/folders.js';
import { type ToolContext, type ToolOutcome, requireWorkspace } from './shared.js';

interface FileRow {
  id: string;
  name: string;
  type: FileType;
  disk_path: string;
  status: string;
  folder_name: string | null;
  doc_type?: string | null;
  /** First page of the stored Markdown (for version hints). */
  md_head?: string | null;
}

/**
 * Recompute intake_complete from the required-five fields and refresh the derived
 * status/checklist. Single source of the completeness formula for the agent-side
 * writes (save_workspace_context, set_contract_mode) so it can't drift.
 */
/**
 * Marks uploaded-document text as DATA for the model (prompt-injection guard; the
 * system prompt tells it never to follow instructions found inside these tags).
 * Closing tags inside the document are neutralised so it can't break out.
 */
function wrapDoc(name: string, text: string): string {
  const safe = text.replace(/<\/?документ/gi, '‹документ');
  return `<документ файл="${name.replace(/"/g, "'")}">\n${safe}\n</документ>`;
}

export async function runSearch(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const q = String((input as { query?: unknown })?.query ?? '').trim();
  if (!q) return { result: 'Порожній запит.', summary: 'Пошук: порожній запит', citations: [] };

  const wsId = requireWorkspace(ctx);
  const hits = await searchWorkspace(wsId, q); // top-K 24, diversified per doc
  const cov = await workspaceCoverage(wsId).catch(() => ({ sections: 0, files: 0, unconverted: 0 }));
  const pending =
    cov.unconverted > 0
      ? `\n\n(${cov.unconverted} файл(ів) ще обробляються і в пошук не потрапили — за потреби прочитай їх через read_file.)`
      : '';

  if (hits.length === 0) {
    return {
      result:
        'Пошук за ключовими словами нічого не знайшов. Це пошук по словах (не за змістом): ' +
        'спробуй інші формулювання/синоніми/номери, або виклич list_files і прочитай потрібний файл ' +
        'повністю через read_file.' +
        pending,
      summary: 'Пошук: 0 результатів',
      citations: [],
    };
  }

  const citations = dedupeCitations(hits.map((h) => ({ file: h.file, page: h.page })));
  const result = hits
    .map((h, i) => {
      const loc = h.page ? `, стор. ${h.page}` : '';
      const fold = h.folder ? ` (${h.folder})` : '';
      return `[${i + 1}] ${h.file}${loc}${fold}\n${wrapDoc(h.file, h.text)}`;
    })
    .join('\n\n');
  const files = [...new Set(hits.map((h) => h.file))];
  // Tell the agent this is a partial top-matches view, not the whole corpus.
  const scale =
    cov.sections > hits.length
      ? `\n\n(Показано ${hits.length} з ${cov.sections} фрагментів — це топ-збіги, не повний перегляд. ` +
        'Для аналізу документа прочитай його повністю через read_file.)'
      : '';
  return {
    result: result + scale + pending,
    summary: `Знайдено ${hits.length} фрагм. у: ${files.join(', ')}`,
    citations,
  };
}

export async function runReadFile(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const path = String((input as { path?: unknown })?.path ?? '').trim();
  const fileId = String((input as { file_id?: unknown })?.file_id ?? '').trim();
  const range = (input as { range?: unknown })?.range;
  if (!path && !fileId) {
    return { result: 'Не вказано файл (path або file_id).', summary: 'Читання: не вказано файл', citations: [] };
  }

  const file = await findFile(requireWorkspace(ctx), path, fileId);
  if (!file) {
    return {
      result: `Файл "${path || fileId}" не знайдено в постачанні. Виклич list_files, щоб побачити точні назви/ID.`,
      summary: `Файл не знайдено: ${path || fileId}`,
      citations: [],
    };
  }

  // Read the ingest-time Markdown (Claude's transcription). Files indexed before
  // the Markdown pipeline existed are converted on first read and stored.
  let stored = await loadFileMarkdown(file.id);
  if (!stored && (file.status === 'queued' || file.status === 'indexing')) {
    // The worker is converting it right now — don't duplicate the (vision) cost inline.
    return {
      result: `Файл "${file.name}" ще обробляється (розпізнавання в Markdown). Спробуй прочитати його трохи пізніше.`,
      summary: `Читання: ${file.name} (ще обробляється)`,
      citations: [{ file: file.name, page: null }],
    };
  }
  if (!stored) {
    const buf = await readStoredFile(file.disk_path);
    const conv = await convertToMarkdown(buf, file.type, file.name);
    await saveFileMarkdown(file.id, requireWorkspace(ctx), conv).catch(() => undefined);
    stored = {
      pages: conv.pages,
      converter: conv.converter,
      partial: conv.partial,
      pageCount: conv.pageCount,
      note: conv.note,
      charCount: conv.pages.reduce((n, p) => n + p.markdown.length, 0),
    };
  }
  let pages = stored.pages.map((p) => ({ page: p.page, text: p.markdown }));
  if (pages.length === 0) {
    return {
      result:
        `Файл "${file.name}" не містить тексту, який вдалося розпізнати.` +
        (stored.note ? ` Причина: ${stored.note}` : ''),
      summary: `Читання: ${file.name} (без тексту)`,
      citations: [{ file: file.name, page: null }],
    };
  }

  // Optional page range "N-M" for paged formats.
  if (typeof range === 'string' && /^\d+-\d+$/.test(range) && pages.some((p) => p.page)) {
    const [from, to] = range.split('-').map(Number) as [number, number];
    pages = pages.filter((p) => p.page !== null && p.page >= from && p.page <= to);
  }

  let text = joinPages(pages.map((p) => ({ page: p.page, markdown: p.text })));

  // Optional char range "0-2000".
  if (typeof range === 'string' && /^\d+-\d+$/.test(range) && !pages.some((p) => p.page)) {
    const [from, to] = range.split('-').map(Number) as [number, number];
    text = text.slice(from, to);
  }

  // One read returns up to READ_FILE_MAX_CHARS (default 200k ≈ a 60-page contract);
  // longer files ask the agent to page on with `range`.
  const MAX = config.READ_FILE_MAX_CHARS;
  const fullLen = text.length;
  const truncated = fullLen > MAX;
  if (truncated) {
    const pageCount = pages.filter((p) => p.page !== null).length;
    const hint = pageCount
      ? ` Показано перші ~${MAX} символів із ${fullLen} (${pageCount} стор.). Щоб дочитати, виклич read_file з range (напр. "6-12" за сторінками).`
      : ` Показано перші ${MAX} із ${fullLen} символів. Щоб дочитати, виклич read_file з range="${MAX}-${Math.min(fullLen, MAX * 2)}".`;
    text = `${text.slice(0, MAX)}\n…[обрізано —${hint}]`;
  }

  const citations = dedupeCitations(pages.map((p) => ({ file: file.name, page: p.page })));
  const quality = stored.partial || stored.note ? `\n(Увага: ${stored.note ?? 'документ розпізнано не повністю'}.)` : '';
  // Version / provenance hints: draft vs final, translation, a PDF re-saved later.
  const hints = versionHints(file.name, stored.pages[0]?.markdown ?? '');
  // PDF metadata only on a whole-file read (not on every paging call) and only for
  // files small enough to parse cheaply in the API process.
  let provenance = '';
  if (file.type === 'pdf' && typeof range !== 'string') {
    const buf = await readStoredFile(file.disk_path).catch(() => null);
    provenance = buf && buf.length <= PROVENANCE_MAX_BYTES ? formatProvenance(await pdfProvenance(buf)) : '';
  }
  const meta = [
    `Тека: ${file.folder_name ?? '(корінь)'}`,
    hints.length ? `Ознаки версії: ${hints.join('; ')}` : '',
    provenance,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    result: `Файл: ${file.name} (Markdown${stored.pageCount ? `, ${stored.pageCount} стор.` : ''})${quality}\n${meta}\n${wrapDoc(file.name, text)}`,
    summary: `Прочитано: ${file.name}${truncated ? ' (частково)' : ''}`,
    citations: citations.length ? citations : [{ file: file.name, page: null }],
  };
}

const PROVENANCE_MAX_BYTES = 40 * 1024 * 1024;

export async function runListFiles(ctx: ToolContext): Promise<ToolOutcome> {
  const files = await listFiles(requireWorkspace(ctx));
  if (files.length === 0) {
    return { result: 'У постачанні поки немає файлів.', summary: 'Список файлів: порожньо', citations: [] };
  }
  const byFolder = new Map<string, FileRow[]>();
  for (const f of files) {
    const key = f.folder_name ?? '(корінь)';
    (byFolder.get(key) ?? byFolder.set(key, []).get(key)!).push(f);
  }
  const sameName = sameNameCounts(files);
  const lines: string[] = [
    `Усього файлів: ${files.length}. Ознаки версії — підказки з назви/першої сторінки, не вердикт.`,
  ];
  for (const [folder, group] of byFolder) {
    lines.push(`${folder}:`);
    for (const f of group) lines.push(`  - ${fileLine(f, sameName)}`);
  }
  return { result: lines.join('\n'), summary: `Список файлів: ${files.length}`, citations: [] };
}

/** Escapes LIKE wildcards so "HBL_C" or "100%" match literally. */
function escapeLike(t: string): string {
  return t.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** How many files share each base name ("HBL-C.pdf" / "HBL-C (1).pdf"). */
function sameNameCounts(files: FileRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of files) m.set(baseNameKey(f.name), (m.get(baseNameKey(f.name)) ?? 0) + 1);
  return m;
}

function fileLine(f: FileRow, sameName: Map<string, number>): string {
  const dt = f.doc_type ? `, тип: ${f.doc_type}` : '';
  const hints = versionHints(f.name, f.md_head ?? '');
  const twins = sameName.get(baseNameKey(f.name)) ?? 1;
  if (twins > 1) hints.push(`ще ${twins - 1} файл(и) з такою ж назвою — звір версії`);
  const h = hints.length ? ` {${hints.join('; ')}}` : '';
  return `${f.name} [${statusLabel(f.status)}${dt}]${h} (id: ${f.id})`;
}

/**
 * find_files — locate files by name / document number / type / a word from the
 * content. Live test «Сборник 18»: the agent read 2–9 of 196 files and declared an
 * export declaration and a contract "absent" although both were uploaded. This
 * gives it a cheap, exhaustive way to check before saying a document is missing.
 */
export async function runFindFiles(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const raw = (input as { query?: unknown } | null)?.query;
  const q = typeof raw === 'string' ? raw.trim() : '';
  if (!q) {
    return { result: 'Вкажи query — частину назви, номер або тип документа.', summary: 'Пошук файлів: порожній запит', citations: [] };
  }
  const workspaceId = requireWorkspace(ctx);
  const files = await listFiles(workspaceId);
  const full = q.toLowerCase();
  const tokens = full.split(/[\s,;]+/).filter((t) => t.length >= 2);
  // Content match over the indexed section text (not the raw JSONB, whose keys
  // would match everything); short tokens are too noisy for content search.
  const contentTokens = (tokens.length ? tokens : [full]).filter((t) => t.length >= 3).map(escapeLike);
  const { rows: content } = contentTokens.length
    ? await query<{ file_id: string; hits: number }>(
        `SELECT ds.file_id, count(DISTINCT t)::int AS hits
         FROM document_sections ds CROSS JOIN unnest($2::text[]) AS t
         WHERE ds.workspace_id = $1 AND ds.text ILIKE '%' || t || '%' ESCAPE '\\'
         GROUP BY ds.file_id`,
        [workspaceId, contentTokens],
      )
    : { rows: [] as { file_id: string; hits: number }[] };
  const contentHits = new Map(content.map((r) => [r.file_id, r.hits]));
  const scored = files
    .map((f) => {
      const name = f.name.toLowerCase();
      const meta = `${name} ${f.folder_name ?? ''} ${f.doc_type ?? ''}`.toLowerCase();
      let score = name.includes(full) ? 10 : 0;
      for (const t of tokens) if (meta.includes(t)) score += 4;
      score += contentHits.get(f.id) ?? 0;
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
  if (scored.length === 0) {
    return {
      result:
        `Файлів за запитом «${q}» не знайдено (ні в назвах, ні в типах, ні у вмісті ${files.length} файлів). ` +
        'Спробуй інші формулювання (номер, тип англійською/китайською) або list_files.',
      summary: `Пошук файлів «${q}»: 0`,
      citations: [],
    };
  }
  const sameName = sameNameCounts(files);
  const lines = scored.map(({ f }) => `- [${f.folder_name ?? '(корінь)'}] ${fileLine(f, sameName)}`);
  return {
    result: `Знайдено файлів: ${scored.length} (найрелевантніші першими):\n${lines.join('\n')}`,
    summary: `Пошук файлів «${q}»: ${scored.length}`,
    citations: [],
  };
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

async function findFile(
  workspaceId: string,
  path: string,
  fileId?: string,
): Promise<FileRow | null> {
  // 1) Exact id (most reliable, from list_files).
  if (fileId) {
    const { rows } = await query<FileRow>(
      `SELECT f.id, f.name, f.type, f.disk_path, f.status, fo.name AS folder_name
       FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
       WHERE f.workspace_id = $1 AND f.id = $2 LIMIT 1`,
      [workspaceId, fileId],
    );
    if (rows[0]) return rows[0];
  }
  if (!path) return null;
  const name = path.split(/[/\\]/).pop() ?? path;
  // 2) Exact (case-insensitive) name.
  const exact = await query<FileRow>(
    `SELECT f.id, f.name, f.type, f.disk_path, f.status, fo.name AS folder_name
     FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE f.workspace_id = $1 AND lower(f.name) = lower($2)
     ORDER BY f.is_latest DESC, f.version DESC, f.created_at DESC
     LIMIT 1`,
    [workspaceId, name],
  );
  if (exact.rows[0]) return exact.rows[0];
  // 3) Fuzzy: name contains the query (or vice-versa) — tolerate an approximate name.
  const fuzzy = await query<FileRow>(
    `SELECT f.id, f.name, f.type, f.disk_path, f.status, fo.name AS folder_name
     FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE f.workspace_id = $1 AND f.is_latest = true AND lower(f.name) LIKE '%' || lower($2) || '%'
     ORDER BY length(f.name) ASC, f.created_at DESC
     LIMIT 1`,
    [workspaceId, name],
  );
  return fuzzy.rows[0] ?? null;
}

async function listFiles(workspaceId: string): Promise<FileRow[]> {
  const { rows } = await query<FileRow>(
    `SELECT f.id, f.name, f.type, f.disk_path, f.status, fo.name AS folder_name,
            de.extracted_fields->>'doc_type' AS doc_type,
            (SELECT left(ds.text, 3000) FROM document_sections ds
             WHERE ds.file_id = f.id ORDER BY ds.seq LIMIT 1) AS md_head
     FROM files f
     LEFT JOIN folders fo ON fo.id = f.folder_id
     LEFT JOIN LATERAL (
       SELECT extracted_fields FROM document_extractions
       WHERE file_id = f.id ORDER BY extracted_at DESC LIMIT 1
     ) de ON true
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
