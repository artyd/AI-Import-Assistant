import { fieldLabel } from './risks.js';
import { REASON_LABELS, STATUS_LABELS, type FindingTriage } from './fingerprint.js';
import type { Discrepancy } from './reconcile.js';
import type { Risk } from './risks.js';

/**
 * «Звіт про проблеми» (spec 011): one printable page — what is still open, what
 * was solved, what was marked «Не проблема» (reason, who, when). Human labels
 * only; every text is escaped. `collectProblems` is pure (verdicts in, entries
 * out); the route loads the verdicts and calls `renderProblemsReport`.
 */

export interface ProblemEntry {
  /** Lot name in an FCL; null for a shipment or the FCL level. */
  lot: string | null;
  text: string;
  detail: string;
  severity: 'error' | 'warning' | 'info';
  /** Suspected («перевірити») rather than confirmed. */
  check: boolean;
  files: string[];
  triage?: FindingTriage;
}

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function discrepancyEntry(d: Discrepancy, lot: string | null): ProblemEntry {
  const files = [...new Set(d.citations.map((c) => c.file_name).filter((n): n is string => Boolean(n)))];
  return {
    lot,
    text: fieldLabel(d.field),
    detail: `очікувалось ${d.expected}; фактично ${d.actual}`,
    severity: d.severity,
    check: d.kind === 'suspected',
    files,
    triage: d.triage,
  };
}

export function riskEntry(r: Risk, lot: string | null): ProblemEntry {
  return { lot, text: r.title, detail: r.detail, severity: r.severity, check: false, files: [], triage: r.triage };
}

/**
 * Entries for a list of findings. A risk built from a discrepancy
 * (category «discrepancy») repeats it and is left out.
 */
export function collectProblems(discrepancies: Discrepancy[], risks: Risk[], lot: string | null): ProblemEntry[] {
  return [
    ...discrepancies.map((d) => discrepancyEntry(d, lot)),
    ...risks.filter((r) => r.category !== 'discrepancy').map((r) => riskEntry(r, lot)),
  ];
}

const SEVERITY_UA: Record<string, string> = { error: 'критична', warning: 'попередження', info: 'довідка' };

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'short' });
}

function item(e: ProblemEntry, decided: boolean): string {
  const files = e.files.length ? `<div class="f">Файли: ${e.files.map(esc).join(', ')}</div>` : '';
  const t = e.triage;
  let tail = '';
  if (decided && t) {
    const reason = t.reason ? `${esc(REASON_LABELS[t.reason])}` : '';
    tail =
      `<div class="d"><b>${esc(STATUS_LABELS[t.status])}</b>${reason ? ` · ${reason}` : ''}` +
      `${t.note ? ` · ${esc(t.note)}` : ''}` +
      ` · ${esc(t.user_name || '—')}, ${esc(when(t.decided_at))}</div>`;
  }
  const mark = decided
    ? ''
    : `<span class="s ${e.severity}">${esc(SEVERITY_UA[e.severity] ?? e.severity)}</span>${e.check ? ' <span class="s chk">перевірити</span>' : ''} `;
  return `<li>${mark}<b>${esc(e.text)}</b>${e.detail ? `<div class="t">${esc(e.detail)}</div>` : ''}${files}${tail}</li>`;
}

function section(title: string, entries: ProblemEntry[], decided: boolean, byLot: boolean, empty: string): string {
  if (entries.length === 0) return `<h2>${esc(title)} <em>0</em></h2><p class="e">${esc(empty)}</p>`;
  let body: string;
  if (byLot) {
    const groups = new Map<string, ProblemEntry[]>();
    for (const e of entries) groups.set(e.lot ?? 'Збірник (рівень контейнера)', [...(groups.get(e.lot ?? 'Збірник (рівень контейнера)') ?? []), e]);
    body = [...groups.entries()].map(([lot, list]) => `<h3>${esc(lot)}</h3><ul>${list.map((e) => item(e, decided)).join('')}</ul>`).join('');
  } else {
    body = `<ul>${entries.map((e) => item(e, decided)).join('')}</ul>`;
  }
  return `<h2>${esc(title)} <em>${entries.length}</em></h2>${body}`;
}

const CSS = `
body{font:13px/1.45 'Hanken Grotesk',Arial,sans-serif;color:#14213d;margin:0;background:#fff}
.page{max-width:780px;margin:0 auto;padding:28px 32px}
.hd{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #1d4ed8;padding-bottom:8px}
.hd b{color:#1d4ed8;font-size:18px}.hd span{color:#475569}
h2{font-size:15px;margin:22px 0 6px}h2 em{font-style:normal;color:#64748b;font-weight:400;margin-left:4px}
h3{font-size:13px;margin:12px 0 4px;color:#334155}
ul{margin:0;padding-left:18px}li{margin:6px 0}
.t{color:#334155}.f{color:#64748b;font-size:12px}.d{color:#0f5132;font-size:12px;margin-top:2px}
.s{display:inline-block;border-radius:4px;padding:0 6px;font-size:11px;color:#fff;background:#64748b}
.s.error{background:#dc2626}.s.warning{background:#d97706}.s.chk{background:#2563eb}
.e{color:#64748b;margin:4px 0}.n{margin-top:18px;color:#475569}
@media print{.page{padding:0}}
`;

export interface ProblemsReportInput {
  number: string;
  fcl: boolean;
  generatedAt: Date;
  entries: ProblemEntry[];
}

export function renderProblemsReport({ number, fcl, generatedAt, entries }: ProblemsReportInput): string {
  const real = entries.filter((e) => e.severity !== 'info');
  const open = real.filter((e) => !e.triage);
  const resolved = entries.filter((e) => e.triage?.status === 'resolved');
  const excluded = entries.filter((e) => e.triage?.status === 'not_problem');
  const notes = entries.filter((e) => e.triage && e.triage.note.trim()).length;
  const date = generatedAt.toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' });
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>Звіт про проблеми — ${esc(number)}</title>
<style>${CSS}</style></head><body><div class="page">
<div class="hd"><b>ШТУРМАН · Звіт про проблеми</b><span>${fcl ? 'Збірник' : 'Постачання'} <b style="font-size:13px">${esc(number)}</b> · ${esc(date)}</span></div>
${section('Відкриті проблеми', open, false, fcl, 'Відкритих проблем немає.')}
${section('Вирішено', resolved, true, fcl, 'Поки нічого не позначено як вирішене.')}
${section('Не проблема', excluded, true, fcl, 'Поки нічого не виключено.')}
<p class="n">Приміток до рішень: <b>${notes}</b></p>
</div></body></html>`;
}
