#!/usr/bin/env node
// Bundle budget: prints first-load JS (gzipped KB) per app route from the
// `next build` output and fails when a route exceeds its budget in
// perf-budget.json. Run after `next build`:  npm run perf:bundle
//   --update   rewrite perf-budget.json as measured size + 10 % (rounded up)
//   --json     machine-readable output
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nextDir = join(root, '.next');
const budgetPath = join(root, 'perf-budget.json');
const args = new Set(process.argv.slice(2));

if (!existsSync(join(nextDir, 'app-build-manifest.json'))) {
  console.error('No .next/app-build-manifest.json — run `npm run build` first.');
  process.exit(2);
}
const readJson = (p) => JSON.parse(readFileSync(join(nextDir, p), 'utf8'));
const appManifest = readJson('app-build-manifest.json').pages;

const sizeCache = new Map();
const gzKb = (file) => {
  if (!sizeCache.has(file)) sizeCache.set(file, gzipSync(readFileSync(join(nextDir, file))).length);
  return sizeCache.get(file);
};

// A route loads its page entry plus every layout above it (root /layout and
// nested ones such as /supply/layout) — same idea as the
// "First Load JS" column of `next build`, but measured here against the files.
const routes = Object.keys(appManifest)
  .filter((k) => k.endsWith('/page'))
  .map((k) => k.slice(0, -'/page'.length) || '/');

function firstLoad(route) {
  const segs = route === '/' ? [] : route.split('/').filter(Boolean);
  const entries = [`${route === '/' ? '' : route}/page`];
  for (let i = 0; i <= segs.length; i++) entries.push(`${i ? '/' + segs.slice(0, i).join('/') : ''}/layout`);
  const files = new Set(); // polyfills are nomodule-only, not loaded by modern browsers
  for (const e of entries) for (const f of appManifest[e] ?? []) if (f.endsWith('.js')) files.add(f);
  let bytes = 0;
  for (const f of files) bytes += gzKb(f);
  return bytes / 1024;
}

const measured = Object.fromEntries(
  routes.filter((r) => !r.startsWith('/_')).sort().map((r) => [r, Math.round(firstLoad(r) * 10) / 10]),
);

if (args.has('--update')) {
  const budgets = Object.fromEntries(Object.entries(measured).map(([r, kb]) => [r, Math.ceil(kb * 1.1)]));
  writeFileSync(
    budgetPath,
    JSON.stringify({ unit: 'KB gzip, first-load JS per route', rule: 'measured + 10% rounded up', routes: budgets }, null, 2) + '\n',
  );
  console.log(`Wrote ${budgetPath}`);
}

const budget = existsSync(budgetPath) ? JSON.parse(readFileSync(budgetPath, 'utf8')).routes : {};
let failed = false;
const rows = [];
for (const [route, kb] of Object.entries(measured)) {
  const limit = budget[route];
  const over = limit !== undefined && kb > limit;
  if (over) failed = true;
  rows.push({ route, kb, limit: limit ?? null, status: limit === undefined ? 'NO BUDGET' : over ? 'OVER' : 'ok' });
}
for (const route of Object.keys(budget)) {
  if (!(route in measured)) {
    failed = true;
    rows.push({ route, kb: null, limit: budget[route], status: 'ROUTE MISSING' });
  }
}

if (args.has('--json')) console.log(JSON.stringify(rows, null, 2));
else {
  const w = Math.max(...rows.map((r) => r.route.length), 5);
  console.log(`${'route'.padEnd(w)}  first-load JS (gzip)   budget  status`);
  for (const r of rows)
    console.log(`${r.route.padEnd(w)}  ${(r.kb ?? '-').toString().padStart(10)} KB   ${(r.limit ?? '-').toString().padStart(5)} KB  ${r.status}`);
}
if (failed) {
  console.error('\nBundle budget FAILED. Fix the regression, or (if intended) raise the budget in frontend/perf-budget.json.');
  process.exit(1);
}
