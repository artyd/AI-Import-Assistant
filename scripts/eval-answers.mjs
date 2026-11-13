#!/usr/bin/env node
// Answer eval — asks Штурман real questions on real shipments and scores the
// answers against KNOWN findings, so every prompt / model / tool change is a
// number, not an impression. Runs against a live stack (prod or local) through
// the same chat API the browser uses; each case is a fresh conversation.
//
// Cases hold customer data, so they live OUTSIDE the public repo:
//   .local/answer-cases.json   (gitignored) — see eval/answers/cases.example.json
//
// Usage:
//   TOKEN=<aia_token from the browser's localStorage> node scripts/eval-answers.mjs
//   node scripts/eval-answers.mjs --cases path/to/cases.json --only lizyn
//   node scripts/eval-answers.mjs --from-feedback   # print «Не так» feedback as draft cases
// Env: BASE_URL (default https://ai-import-assistant.duckdns.org), TOKEN, or EMAIL+PASSWORD.
//
// Score per case:
//   expect  — each item is a finding; it counts as FOUND when every `all` pattern
//             and at least one `any` pattern match the answer (regex, case-insensitive).
//   forbid  — patterns that must NOT appear (emoji, «інструмент», a wrong figure…).
//   shape   — built-in checks of the answer rules: verdict in bold on the first
//             line, no tool names, no emoji, an action («→ …» or a «Дія» line) when there are findings.
// Exit code 1 when any case scores below its `minScore` (default 1.0).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertCaseLimit, compareRuns, formatCompare, MAX_CASES, score } from './eval-answers-lib.mjs';

const USAGE = `Answer eval — питання до Штурмана через живий чат-API + оцінка відповідей.

  TOKEN=<aia_token> node scripts/eval-answers.mjs [опції]

  --cases <file>      файл кейсів (за замовчуванням .local/answer-cases.json)
  --only <text>       лише кейси, в назві яких є <text>
  --out <file>        куди записати прогін (JSON); за замовчуванням .local/eval-runs/<дата>.json
  --no-out            не записувати прогін
  --compare <old>     порівняти з минулим прогоном (вірність, слів, без джерела, секунди);
                      код виходу 1, якщо загальна вірність впала
  --force             дозволити більше ${MAX_CASES} кейсів за запуск (за замовчуванням — відмова)
  --from-feedback     вивести відповіді з «Не так» як чернетки кейсів
  --help              ця довідка

  Оточення: BASE_URL, TOKEN або EMAIL + PASSWORD. Формат кейсів: eval/answers/README.md.
`;

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE_URL = (process.env.BASE_URL ?? 'https://ai-import-assistant.duckdns.org').replace(/\/$/, '');
const CASES = arg('--cases') ?? '.local/answer-cases.json';
const ONLY = arg('--only');
let token = process.env.TOKEN ?? '';

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function login() {
  if (token) return;
  const { EMAIL, PASSWORD } = process.env;
  if (!EMAIL || !PASSWORD) {
    console.error('Set TOKEN (from the browser: localStorage.aia_token) or EMAIL + PASSWORD.');
    process.exit(2);
  }
  const r = await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  if (!r.ok) throw new Error(`login failed: ${r.status}`);
  token = (await r.json()).token;
}

/**
 * One case → { text, tools, citations } of the LAST answer. `followUps` (optional)
 * are asked in the same conversation after `question` — e.g. the user repeating
 * «навіщо?», which must not make Штурман reverse a sourced answer. `chatKind:
 * 'normal'` uses the global chat (no workspace).
 */
async function ask(c) {
  let res = await askOne(c, c.question, undefined);
  for (const q of c.followUps ?? []) res = await askOne(c, q, res.conversationId);
  return res;
}

/** One chat turn over SSE-over-POST → { text, tools, citations, conversationId }. */
async function askOne(c, message, conversationId) {
  const path =
    c.chatKind === 'normal'
      ? '/api/chats'
      : c.chatKind === 'consolidated'
        ? `/api/collections/${c.workspaceId}/chat`
        : `/api/workspaces/${c.workspaceId}/chat`;
  const res = await api('POST', path, { message, ...(conversationId ? { conversationId } : {}) });
  if (!res.ok || !res.body) throw new Error(`chat ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  const tools = [];
  let citations = [];
  let convId = conversationId;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const data = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      const d = JSON.parse(data.join('\n'));
      if (event === 'token') text += d.text ?? '';
      else if (event === 'tool_call') tools.push(d.tool);
      else if (event === 'done') {
        text = d.message ?? text;
        citations = d.citations ?? [];
        convId = d.conversationId ?? convId;
      } else if (event === 'error') throw new Error(d.message ?? 'chat error');
    }
  }
  return { text, tools, citations, conversationId: convId };
}

export { score };

async function fromFeedback() {
  await login();
  const r = await api('GET', '/api/feedback?rating=down&limit=200');
  if (!r.ok) throw new Error(`feedback ${r.status}`);
  const { feedback } = await r.json();
  const drafts = feedback
    .filter((f) => f.workspaceId && f.question)
    .map((f, i) => ({
      name: `feedback-${i + 1}`,
      workspaceId: f.workspaceId,
      chatKind: f.chatKind,
      question: f.question,
      note: `Користувач: ${f.comment}${f.lesson ? ` | урок: ${f.lesson}` : ''}`,
      expect: [{ name: 'TODO: що мало бути у відповіді', any: ['TODO'] }],
      forbid: [],
    }));
  console.log(JSON.stringify(drafts, null, 2));
  console.error(`${C.d}${drafts.length} чернеток кейсів — допишіть expect і додайте в ${CASES}.${C.x}`);
}

async function readRun(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    console.error(`Не вдалося прочитати прогін ${file}.`);
    process.exit(2);
  }
}

async function main() {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  if (args.includes('--from-feedback')) return fromFeedback();
  const oldRun = arg('--compare') ? await readRun(arg('--compare')) : null;
  let cases;
  try {
    cases = JSON.parse(await readFile(CASES, 'utf8'));
  } catch {
    console.error(`Немає файлу кейсів ${CASES}. Скопіюйте eval/answers/cases.example.json і заповніть.`);
    process.exit(2);
  }
  if (ONLY) cases = cases.filter((c) => c.name.includes(ONLY));
  try {
    assertCaseLimit(cases.length, args.includes('--force'));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  await login();
  let failed = 0;
  let sum = 0;
  const runCases = [];
  for (const c of cases) {
    process.stdout.write(`${C.b}${c.name}${C.x} — ${c.question}\n`);
    let res;
    const t0 = Date.now();
    try {
      res = await ask(c);
    } catch (err) {
      console.log(`  ${C.r}помилка: ${err.message}${C.x}\n`);
      failed++;
      runCases.push({ name: c.name, question: c.question, error: err.message, correctness: 0, words: 0, unsupported: 0, seconds: (Date.now() - t0) / 1000 });
      continue;
    }
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    const s = score(c, res.text);
    sum += s.score;
    runCases.push({
      name: c.name,
      question: c.question,
      answer: res.text,
      expect: s.expect,
      forbidden: s.forbidden,
      shape: s.shape,
      score: s.score,
      correctness: s.correctness,
      words: s.words,
      verdictFirst: s.verdictFirst,
      figures: s.figures,
      unsupported: s.unsupportedFigures.length,
      unsupportedFigures: s.unsupportedFigures,
      seconds,
      tools: res.tools,
    });
    if (s.unsupportedFigures.length) console.log(`  ${C.y}✗ цифри без джерела: ${s.unsupportedFigures.map((u) => u.figure).join(', ')}${C.x}`);
    for (const e of s.expect) console.log(`  ${e.found ? `${C.g}✓` : `${C.r}✗`} ${e.name}${C.x}`);
    for (const f of s.forbidden) console.log(`  ${C.r}✗ заборонене: /${f}/${C.x}`);
    for (const sh of s.shape) if (!sh.ok) console.log(`  ${C.y}✗ форма: ${sh.name}${C.x}`);
    const min = c.minScore ?? 1;
    const ok = s.score >= min;
    if (!ok) failed++;
    console.log(`  ${ok ? C.g : C.r}оцінка ${(s.score * 100).toFixed(0)}%${C.x} ${C.d}(${s.words} слів, ${seconds} с, інструменти: ${res.tools.join(', ') || '—'})${C.x}\n`);
  }
  const avg = cases.length ? (sum / cases.length) * 100 : 0;
  console.log(`${C.b}Разом: ${cases.length} кейсів, середня оцінка ${avg.toFixed(0)}%, нижче порогу: ${failed}.${C.x}`);

  const run = { date: new Date().toISOString(), baseUrl: BASE_URL, cases: runCases };
  if (!args.includes('--no-out')) {
    const out = arg('--out') ?? `.local/eval-runs/${run.date.replace(/[:.]/g, '-')}.json`;
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(run, null, 2));
    console.log(`${C.d}Прогін записано: ${out}${C.x}`);
  }
  let dropped = false;
  if (oldRun) {
    const cmp = compareRuns(oldRun, run);
    console.log(`\n${C.b}Порівняння (було → стало):${C.x}\n${formatCompare(cmp)}`);
    dropped = cmp.dropped;
    if (dropped) console.log(`${C.r}Загальна вірність впала.${C.x}`);
  }
  process.exit(failed || dropped ? 1 : 0);
}

if (process.argv[1]?.endsWith('eval-answers.mjs')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
