import { z } from 'zod';
import { query } from '../../db/pool.js';
import { loadFileMarkdown } from '../../ingest/markdown/store.js';
import type { Citation } from '../../chat/conversations.js';
import { findValue, type CorpusDoc, type FoundIn } from '../answerCheck.js';
import { findFile } from './retrieval.js';
import { type ToolContext, type ToolOutcome, requireWorkspace } from './shared.js';

/** verify_facts: deterministic look-up of figures in the shipment's source text (spec 010, part C). */

export const MAX_FACTS = 40;
/** Per file and in total — keeps one call bounded on a 196-file collection. */
const MAX_FILE_CHARS = 1_500_000;
const MAX_TOTAL_CHARS = 8_000_000;
const TIME_BUDGET_MS = 8_000;

const inputSchema = z.object({
  facts: z
    .array(
      z.object({
        value: z.string().trim().min(1, 'порожнє значення').max(200),
        file: z.string().trim().min(1).max(300).optional(),
        page: z.number().int().positive().optional(),
      }),
    )
    .min(1, 'потрібен хоча б один факт')
    .max(MAX_FACTS, `не більше ${MAX_FACTS} фактів за виклик — розбий на кілька викликів`),
});

export interface VerifyDeps {
  /** The named file's text (null = no such file in this shipment). */
  loadNamed(workspaceId: string, name: string): Promise<CorpusDoc | null>;
  /** All current files' text plus extracted fields. */
  loadAll(workspaceId: string): Promise<CorpusDoc[]>;
}

function capPages(pages: { page: number | null; text: string }[], budget: number): { page: number | null; text: string }[] {
  const out: { page: number | null; text: string }[] = [];
  let used = 0;
  for (const p of pages) {
    if (used >= budget) break;
    out.push(p);
    used += p.text.length;
  }
  return out;
}

/** Extracted fields flattened to «ключ: значення» lines, as one page-less document. */
function fieldsToText(fields: unknown): string {
  const lines: string[] = [];
  const walk = (prefix: string, v: unknown): void => {
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}.${k}` : k, x);
    else lines.push(`${prefix}: ${String(v)}`);
  };
  walk('', fields);
  return lines.join('\n');
}

export const defaultDeps: VerifyDeps = {
  async loadNamed(workspaceId, name) {
    const file = await findFile(workspaceId, name);
    if (!file) return null;
    const md = await loadFileMarkdown(file.id);
    if (!md) return { file: file.name, pages: [] };
    return { file: file.name, pages: capPages(md.pages.map((p) => ({ page: p.page, text: p.markdown })), MAX_FILE_CHARS) };
  },
  async loadAll(workspaceId) {
    return loadShipmentCorpus(workspaceId);
  },
};

/** Markdown of every ready, current file of the shipment + its extracted fields. Bounded. */
export async function loadShipmentCorpus(workspaceId: string): Promise<CorpusDoc[]> {
  const { rows } = await query<{ name: string; pages: { page: number | null; markdown: string }[] }>(
    `SELECT f.name, fm.pages
     FROM files f JOIN file_markdown fm ON fm.file_id = f.id
     WHERE f.workspace_id = $1 AND f.status = 'ready' AND f.is_latest = true
     ORDER BY f.created_at`,
    [workspaceId],
  );
  const docs: CorpusDoc[] = [];
  let total = 0;
  for (const r of rows) {
    if (total >= MAX_TOTAL_CHARS) break;
    const pages = capPages((r.pages ?? []).map((p) => ({ page: p.page, text: p.markdown })), Math.min(MAX_FILE_CHARS, MAX_TOTAL_CHARS - total));
    total += pages.reduce((n, p) => n + p.text.length, 0);
    docs.push({ file: r.name, pages });
  }
  const ex = await query<{ name: string; extracted_fields: unknown }>(
    `SELECT DISTINCT ON (f.id) f.name, de.extracted_fields
     FROM document_extractions de JOIN files f ON f.id = de.file_id
     WHERE f.workspace_id = $1 AND f.is_latest = true
     ORDER BY f.id, de.extracted_at DESC`,
    [workspaceId],
  );
  for (const r of ex.rows) {
    const text = fieldsToText(r.extracted_fields);
    if (text) docs.push({ file: `${r.name} (поля)`, pages: [{ page: null, text }] });
  }
  return docs;
}

const loc = (f: FoundIn): string => (f.page ? `${f.file}, стор. ${f.page}` : f.file);

function problems(err: z.ZodError): string {
  const lines = err.issues.map((i) => `- ${i.path.join('.') || 'input'}: ${i.message}`);
  return `Некоректний виклик verify_facts. Виправ і повтори:\n${lines.join('\n')}\nФормат: { "facts": [ { "value": "25 000 кг", "file"?: "назва файлу", "page"?: 2 } ] }, до ${MAX_FACTS} фактів.`;
}

export async function runVerifyFacts(input: unknown, ctx: ToolContext, deps: VerifyDeps = defaultDeps): Promise<ToolOutcome> {
  const workspaceId = requireWorkspace(ctx);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { result: problems(parsed.error), summary: 'verify_facts: некоректний виклик', citations: [] };
  }
  const deadline = Date.now() + TIME_BUDGET_MS;
  let all: CorpusDoc[] | null = null;
  const everything = async (): Promise<CorpusDoc[]> => (all ??= await deps.loadAll(workspaceId));
  const named = new Map<string, CorpusDoc | null>();

  const lines: string[] = [];
  const citations: Citation[] = [];
  let found = 0;
  let partial = 0;
  let missing = 0;

  for (const [i, fact] of parsed.data.facts.entries()) {
    const label = `${i + 1}. «${fact.value}»`;
    let where: FoundIn[] = [];
    let status: 'found' | 'number_only' | 'not_found' = 'not_found';
    let note = '';
    let timedOut = false;
    let partialHit: FoundIn[] = [];

    if (fact.file) {
      if (!named.has(fact.file)) named.set(fact.file, await deps.loadNamed(workspaceId, fact.file));
      const doc = named.get(fact.file) ?? null;
      if (!doc) {
        note = `файл «${fact.file}» не знайдено в постачанні (шукаю в усіх)`;
      } else {
        const scoped = fact.page ? { ...doc, pages: doc.pages.filter((p) => p.page === fact.page) } : doc;
        const r = findValue(fact.value, [scoped], { deadline });
        timedOut = !!r.timedOut;
        if (r.status === 'found') {
          status = 'found';
          where = r.foundIn;
        } else {
          note = fact.page ? `не на стор. ${fact.page} файлу ${doc.file}` : `не в ${doc.file}`;
          if (r.status === 'number_only') partialHit = r.foundIn;
        }
      }
    }

    if (status === 'not_found' && !timedOut) {
      const r = findValue(fact.value, await everything(), { deadline });
      status = r.status;
      where = r.foundIn;
      timedOut = !!r.timedOut;
      if (status === 'not_found' && partialHit.length) ({ status, where } = { status: 'number_only', where: partialHit });
    }

    if (status === 'found') {
      found++;
      lines.push(`${label} — ЗНАЙДЕНО: ${where.map(loc).join('; ')}${note ? ` (${note}, а в інших файлах)` : ''}`);
    } else if (status === 'number_only') {
      partial++;
      lines.push(`${label} — число є (${where.map(loc).join('; ')}), але поруч немає такої одиниці/валюти: перевір формулювання.`);
    } else {
      missing++;
      lines.push(
        `${label} — НЕ ЗНАЙДЕНО${note ? ` (${note})` : ''}${timedOut ? ' (перевірку обірвано за часом)' : ''}. ` +
          'Не стверджуй це як факт із документів: перечитай джерело або познач «(висновок)».',
      );
    }
    for (const w of where) citations.push(w.page ? { file: w.file, page: w.page } : { file: w.file, page: null });
  }

  const total = parsed.data.facts.length;
  const summary = `verify_facts: ${found} з ${total} знайдено${partial ? `, ${partial} лише число` : ''}, не знайдено: ${missing}`;
  const seen = new Set<string>();
  const unique = citations.filter((c) => {
    const k = `${c.file}#${c.page ?? ''}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  return { result: `${summary}\n${lines.join('\n')}`, summary, citations: unique };
}
