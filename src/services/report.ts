import { query } from '../db/pool.js';
import type { WorkspaceRow } from './workspaceAccess.js';
import { computeChecklist, type ChecklistItem } from './checklist.js';
import { computeDiscrepancies, type Discrepancy } from './discrepancies.js';
import { listParties, type PartyRow } from './parties.js';
import { deriveWorkspaceStatus } from './status.js';
import { saveArtifact } from './artifacts.js';

/**
 * Self-contained HTML shipment report. All CSS is inlined and there are NO
 * external asset dependencies (fonts degrade gracefully to system stacks), so it
 * opens correctly outside the app. Conclusions are derived deterministically from
 * checklist + discrepancy data — not free-standing LLM text.
 *
 * Brand palette is provisional (named tokens are not defined anywhere in the
 * repo) — flag for design review.
 */

function esc(v: unknown): string {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

interface Figures {
  totalValue: number | null;
  currency: string | null;
  weightKg: number | null;
  packages: number | null;
}

async function gatherFigures(workspaceId: string): Promise<Figures> {
  const { rows } = await query<{ doc_type: string | null; fields: Record<string, unknown> }>(
    `SELECT de.extracted_fields->>'doc_type' AS doc_type, de.extracted_fields AS fields
     FROM document_extractions de JOIN files f ON f.id = de.file_id
     WHERE de.workspace_id = $1 AND f.is_latest = true`,
    [workspaceId],
  );
  const invoice = rows.find((r) => r.doc_type === 'invoice')?.fields ?? {};
  const packing = rows.find((r) => r.doc_type === 'packing_list')?.fields ?? {};
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    totalValue: num(invoice.total_value),
    currency: str(invoice.currency),
    weightKg: num(invoice.total_weight_kg) ?? num(packing.total_weight_kg),
    packages: num(packing.packages_count) ?? num(invoice.packages_count),
  };
}

function deriveConclusions(
  status: string,
  checklist: ChecklistItem[],
  discrepancies: Discrepancy[],
): string[] {
  const out: string[] = [];
  const missing = checklist.filter((i) => i.status === 'missing').map((i) => i.requirement_key);
  const errors = discrepancies.filter((d) => d.severity === 'error');
  const warnings = discrepancies.filter((d) => d.severity === 'warning');

  if (missing.length) out.push(`Бракує обовʼязкових документів: ${missing.join(', ')}.`);
  for (const e of errors) out.push(`Блокуюча розбіжність — ${e.field}: очікується ${e.expected}, факт ${e.actual}.`);
  for (const w of warnings) out.push(`Попередження — ${w.field}: ${w.actual}.`);
  if (!missing.length && !errors.length) {
    out.push(
      status === 'customs_ready'
        ? 'Пакет документів повний і звірений — постачання готове до митного оформлення.'
        : 'Пакет документів повний; критичних розбіжностей немає.',
    );
  }
  return out;
}

const SEVERITY_LABEL: Record<string, string> = { error: 'Блокуюче', warning: 'Попередження', info: 'Інфо' };

function render(
  ws: WorkspaceRow,
  parties: PartyRow[],
  checklist: ChecklistItem[],
  discrepancies: Discrepancy[],
  figures: Figures,
  status: string,
  conclusions: string[],
): string {
  const done = checklist.filter((i) => i.status !== 'missing').length;
  const pct = checklist.length ? Math.round((done / checklist.length) * 100) : 0;

  const partiesRows = parties
    .map(
      (p) =>
        `<tr><td>${esc(p.role)}</td><td>${esc(p.company_name)}${p.is_internal ? ' <span class="tag">internal</span>' : ''}</td><td>${esc(p.country ?? '—')}</td></tr>`,
    )
    .join('');

  const checklistRows = checklist
    .map((i) => {
      const cls = i.status === 'verified' ? 'ok' : i.status === 'received' ? 'warn' : 'err';
      return `<tr><td>${esc(i.requirement_key)}</td><td><span class="pill ${cls}">${esc(i.status)}</span></td></tr>`;
    })
    .join('');

  const discRows = discrepancies.length
    ? discrepancies
        .map(
          (d) =>
            `<tr class="sev-${esc(d.severity)}"><td>${esc(SEVERITY_LABEL[d.severity] ?? d.severity)}</td><td>${esc(d.field)}</td><td>${esc(d.expected)}</td><td>${esc(d.actual)}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="4" class="muted">Розбіжностей не виявлено.</td></tr>`;

  const fig = (label: string, value: string): string =>
    `<div class="fig"><div class="fig-v">${esc(value)}</div><div class="fig-l">${esc(label)}</div></div>`;

  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Звіт постачання ${esc(ws.number)}</title>
<style>
:root{
  --dock-white:#F7F8FA; --cargo-navy:#0E2A47; --hazard-amber:#E8890C;
  --route-teal:#0E9E8E; --manifest-grey:#6B7280; --customs-red:#D64545;
  --font-sans:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  --font-display:"Space Grotesk",var(--font-sans);
  --font-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--dock-white);color:var(--cargo-navy);font-family:var(--font-sans);line-height:1.5;font-size:14px}
.wrap{max-width:900px;margin:0 auto;padding:32px}
h1,h2{font-family:var(--font-display);color:var(--cargo-navy);margin:0 0 12px}
h1{font-size:26px} h2{font-size:18px;margin-top:28px}
.sub{color:var(--manifest-grey);font-family:var(--font-mono);font-size:13px}
.status{display:inline-block;margin-top:8px;padding:4px 12px;border-radius:999px;background:var(--route-teal);color:#fff;font-weight:600;font-size:13px}
table{border-collapse:collapse;width:100%;margin:8px 0 4px;font-size:13px}
th,td{border:1px solid rgba(14,42,71,.12);padding:8px 10px;text-align:left;vertical-align:top}
th{background:rgba(14,42,71,.05);font-weight:600}
.muted{color:var(--manifest-grey)}
.tag{font-size:11px;background:rgba(14,158,142,.15);color:var(--route-teal);padding:1px 6px;border-radius:6px}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600}
.pill.ok{background:rgba(14,158,142,.15);color:var(--route-teal)}
.pill.warn{background:rgba(232,137,12,.16);color:var(--hazard-amber)}
.pill.err{background:rgba(214,69,69,.14);color:var(--customs-red)}
.bar{height:12px;border-radius:999px;background:rgba(14,42,71,.1);overflow:hidden;margin:6px 0}
.bar>span{display:block;height:100%;background:var(--route-teal)}
.figs{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0}
.fig{flex:1;min-width:150px;background:#fff;border:1px solid rgba(14,42,71,.12);border-radius:12px;padding:14px}
.fig-v{font-family:var(--font-display);font-size:22px}
.fig-l{color:var(--manifest-grey);font-size:12px;margin-top:2px}
tr.sev-error{background:rgba(214,69,69,.06)}
tr.sev-warning{background:rgba(232,137,12,.06)}
ul.concl{margin:8px 0;padding-left:18px} ul.concl li{margin:4px 0}
.foot{margin-top:32px;color:var(--manifest-grey);font-size:12px;font-family:var(--font-mono)}
</style></head>
<body><div class="wrap">
  <h1>Звіт постачання №${esc(ws.number)}</h1>
  <div class="sub">${esc(ws.supplier || '—')} · ${esc(ws.contract_type ?? 'contract_type —')}</div>
  <div class="status">${esc(status)}</div>

  <h2>Огляд</h2>
  <table>
    <tr><th>Категорія товару</th><td>${esc(ws.product_category ?? '—')}</td><th>Incoterms</th><td>${esc(ws.incoterm ?? '—')}</td></tr>
    <tr><th>Транспорт</th><td>${esc(ws.transport_mode ?? '—')}</td><th>Країна походження</th><td>${esc(ws.origin_country ?? '—')}</td></tr>
    <tr><th>Створено</th><td>${esc(ws.created_at)}</td><th>Статус</th><td>${esc(status)}</td></tr>
  </table>

  <h2>Сторони</h2>
  <table><thead><tr><th>Роль</th><th>Компанія</th><th>Країна</th></tr></thead>
  <tbody>${partiesRows || '<tr><td colspan="3" class="muted">Сторони не задані.</td></tr>'}</tbody></table>

  <h2>Комплектність (${pct}%)</h2>
  <div class="bar"><span style="width:${pct}%"></span></div>
  <table><thead><tr><th>Документ</th><th>Статус</th></tr></thead>
  <tbody>${checklistRows || '<tr><td colspan="2" class="muted">Чек-лист порожній.</td></tr>'}</tbody></table>

  <h2>Розбіжності</h2>
  <table><thead><tr><th>Рівень</th><th>Поле</th><th>Очікується</th><th>Факт</th></tr></thead>
  <tbody>${discRows}</tbody></table>

  <h2>Ключові показники</h2>
  <div class="figs">
    ${fig('Загальна вартість', figures.totalValue != null ? `${figures.totalValue} ${figures.currency ?? ''}`.trim() : '—')}
    ${fig('Вага, кг', figures.weightKg != null ? String(figures.weightKg) : '—')}
    ${fig('Кількість місць', figures.packages != null ? String(figures.packages) : '—')}
  </div>

  <h2>Висновки та рекомендації</h2>
  <ul class="concl">${conclusions.map((c) => `<li>${esc(c)}</li>`).join('') || '<li class="muted">—</li>'}</ul>

  <div class="foot">Згенеровано «Штурманом» · AI Import Assistant</div>
</div></body></html>`;
}

export async function buildAndSaveReport(
  ws: WorkspaceRow,
): Promise<{ id: string; html: string }> {
  const [parties, checklist, discrepancies, figures] = await Promise.all([
    listParties(ws.id),
    computeChecklist(ws),
    computeDiscrepancies(ws.id),
    gatherFigures(ws.id),
  ]);
  const status = deriveWorkspaceStatus(ws, checklist, discrepancies);
  const conclusions = deriveConclusions(status, checklist, discrepancies);
  const html = render(ws, parties, checklist, discrepancies, figures, status, conclusions);
  const { id } = await saveArtifact(ws.id, 'shipment_report_html', html, 'html', 'agent');
  return { id, html };
}
