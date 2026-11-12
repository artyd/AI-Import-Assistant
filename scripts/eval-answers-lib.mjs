// Pure logic of the answer eval (no network, no files) — unit-tested in
// scripts/__tests__/eval-answers-lib.spec.mjs. The CLI is scripts/eval-answers.mjs.

export const MAX_CASES = 15;

const rx = (p) => new RegExp(p, 'iu');

/** Words in an answer: tokens that hold a letter or a digit (markdown marks, dashes, pipes are not words). */
export function wordCount(text) {
  return (text.match(/[^\s|]+/gu) ?? []).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

export function median(list) {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const FILE_EXT = '(?:pdf|docx?|xlsx?|jpe?g|png|csv|txt)';
const HAS_SOURCE = new RegExp(String.raw`\.${FILE_EXT}\b`, 'iu');
const FILE_NAME = new RegExp(String.raw`\S+\.${FILE_EXT}\b`, 'giu');
const NUMBER = /\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/gu;

/** Split an answer into checkable units: a table row, a list line, or a sentence. */
function units(answer) {
  const out = [];
  for (const line of answer.split('\n')) {
    if (line.trim().startsWith('|')) out.push(line);
    else out.push(...line.split(/(?<=[.!?](?:\*\*)?)\s+(?=[*_]*[A-ZА-ЯІЇЄҐ])/u));
  }
  return out;
}

/**
 * Every figure (a number of 2+ digits that is not a date, a year or a list index)
 * must have a source — a file name — in the same sentence / row / line.
 * → { total, unsupported: [{ figure, unit }] }
 */
export function unsupportedFigures(answer) {
  let total = 0;
  const unsupported = [];
  for (const unit of units(answer)) {
    const cleaned = unit
      .replace(/^\s*(?:\d+[.)]|[-*•])\s+/u, '')
      .replace(FILE_NAME, ' ')
      .replace(/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/gu, ' ');
    const sourced = HAS_SOURCE.test(unit);
    for (const m of cleaned.matchAll(NUMBER)) {
      const figure = m[0].trim();
      if (figure.replace(/\D/g, '').length < 2) continue;
      if (/^(?:19|20)\d{2}$/.test(figure)) continue;
      total++;
      if (!sourced) unsupported.push({ figure, unit: unit.trim() });
    }
  }
  return { total, unsupported };
}

/**
 * Score one answer against a case. `score` keeps the original formula (expect + shape
 * + forbid); the new fields are reported next to it.
 */
export function score(c, answer) {
  const expect = (c.expect ?? []).map((e) => {
    const all = (e.all ?? []).every((p) => rx(p).test(answer));
    const any = !e.any?.length || e.any.some((p) => rx(p).test(answer));
    return { name: e.name, found: all && any };
  });
  const forbidden = (c.forbid ?? []).filter((p) => rx(p).test(answer));
  const firstLine = answer.trim().split('\n')[0] ?? '';
  const verdictFirst = /^\s*\*\*.+\*\*/u.test(firstLine);
  const words = wordCount(answer);
  const shape = [
    { name: 'висновок жирним у першому рядку', ok: verdictFirst },
    { name: 'без назв інструментів', ok: !/\b(get_[a-z_]+|read_file|list_files|find_files|search_documents)\b|інструмент/iu.test(answer) },
    { name: 'без емодзі', ok: !/\p{Extended_Pictographic}/u.test(answer) },
    { name: 'дія за наявності знахідок («→ …» або «Дія»)', ok: !(c.expect ?? []).length || /(^|\n)\s*(\*\*)?Дія/u.test(answer) || /→|->/u.test(answer) },
  ];
  if (c.maxWords) shape.push({ name: `довжина ≤ ${c.maxWords} слів`, ok: words <= c.maxWords });
  const points = expect.filter((e) => e.found).length + shape.filter((s) => s.ok).length;
  const total = expect.length + shape.length + forbidden.length;
  const correctness = expect.length ? expect.filter((e) => e.found).length / expect.length : 1;
  const figures = unsupportedFigures(answer);
  return {
    expect,
    forbidden,
    shape,
    score: total ? points / total : 1,
    correctness,
    words,
    verdictFirst,
    figures: figures.total,
    unsupportedFigures: figures.unsupported,
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** run = { cases: [{ name, correctness, words, unsupported, seconds }] } */
export function summarizeRun(run) {
  const cs = run.cases;
  return {
    cases: cs.length,
    correctness: mean(cs.map((c) => c.correctness)),
    medianWords: median(cs.map((c) => c.words)),
    unsupported: cs.reduce((a, c) => a + (c.unsupported ?? 0), 0),
    seconds: cs.reduce((a, c) => a + (c.seconds ?? 0), 0),
  };
}

/** Old vs new: per case, and totals over the cases both runs have. `dropped` = total correctness fell. */
export function compareRuns(oldRun, newRun) {
  const o = new Map(oldRun.cases.map((c) => [c.name, c]));
  const n = new Map(newRun.cases.map((c) => [c.name, c]));
  const names = [...new Set([...o.keys(), ...n.keys()])];
  const rows = names.map((name) => ({ name, old: o.get(name) ?? null, new: n.get(name) ?? null }));
  const common = names.filter((x) => o.has(x) && n.has(x));
  const pick = (m) => ({ cases: (common.length ? common : [...m.keys()]).map((x) => m.get(x)).filter(Boolean) });
  const totals = { old: summarizeRun(pick(o)), new: summarizeRun(pick(n)) };
  return { rows, totals, dropped: totals.new.correctness < totals.old.correctness - 1e-9 };
}

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const num = (x) => (x == null ? '—' : String(Math.round(x * 10) / 10));
const pair = (a, b) => `${a} → ${b}`;

export function formatCompare(cmp) {
  const head = ['кейс', 'вірність', 'слів', 'без джерела', 'секунд'];
  const lines = cmp.rows.map((r) => [
    r.name,
    pair(pct(r.old?.correctness), pct(r.new?.correctness)),
    pair(num(r.old?.words), num(r.new?.words)),
    pair(num(r.old?.unsupported), num(r.new?.unsupported)),
    pair(num(r.old?.seconds), num(r.new?.seconds)),
  ]);
  const t = cmp.totals;
  lines.push([
    'РАЗОМ (спільні кейси)',
    pair(pct(t.old.correctness), pct(t.new.correctness)),
    pair(num(t.old.medianWords), num(t.new.medianWords)) + ' (медіана)',
    pair(t.old.unsupported, t.new.unsupported),
    pair(num(t.old.seconds), num(t.new.seconds)),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => String(l[i]).length)));
  const fmt = (l) => l.map((c, i) => String(c).padEnd(w[i])).join('  ');
  return [fmt(head), ...lines.map(fmt)].join('\n');
}

export function assertCaseLimit(count, force) {
  if (count > MAX_CASES && !force) {
    throw new Error(`Забагато кейсів: ${count} (ліміт ${MAX_CASES} за запуск — вартість). Додайте --force або використайте --only.`);
  }
}
