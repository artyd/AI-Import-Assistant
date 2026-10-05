import type { ReportFacts } from './facts.js';

/**
 * One-page A4 management report — the approved mockup
 * (docs/instruction-builder-and-report/mockups/report-a4.html) as a template.
 * Pure: facts (+ optional AI summary) in, self-contained HTML out. The same
 * HTML is served as-is and printed to PDF by `pdf.ts`.
 */

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const nf = (n: number, digits = 0): string =>
  n.toLocaleString('uk-UA', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const money = (v: number, cur: string): string =>
  cur === 'USD' ? `$${nf(v)}` : cur === 'EUR' ? `€${nf(v)}` : `${nf(v)} ${esc(cur)}`;

/** "«TEKHINFORM PLUS» LLC / ТОВ «ТЕХІНФОРМ ПЛЮС»" → "TEKHINFORM PLUS" — chips stay one line. */
export function shortName(name: string): string {
  const first = name.split(' / ')[0]!;
  const cleaned = first
    .replace(/[«»"“”„']/g, '')
    .replace(/\b(business|limited|ltd|llc|inc|gmbh|pvt|private|co|corp|company)\b\.?/gi, '')
    .replace(/^(ТОВ|ТзОВ|ПП|ФОП)\s+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned || name;
}
const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

const ROLE_UK: Record<string, string> = { sender: 'виробник', intermediary: 'посередник', recipient: 'покупець' };
const COUNTRY_CODE: Record<string, string> = {
  india: 'IN', 'індія': 'IN', 'united kingdom': 'GB', 'велика британія': 'GB', ukraine: 'UA', 'україна': 'UA',
  china: 'CN', 'китай': 'CN', germany: 'DE', 'німеччина': 'DE', poland: 'PL', 'польща': 'PL', usa: 'US',
};
function cc(country: string | null): string {
  if (!country) return '';
  const k = country.split('/')[0]!.trim().toLowerCase();
  return COUNTRY_CODE[k] ?? (k.length === 2 ? k.toUpperCase() : country.split('/')[0]!.trim());
}
const MODE: Record<string, { icon: string; cls: string }> = {
  air: { icon: '✈', cls: '' },
  road: { icon: '🚚', cls: 'road' },
  sea: { icon: '🚢', cls: '' },
  rail: { icon: '🚆', cls: 'road' },
};
const SERVICE_UK: Record<string, string> = { broker: 'брокер', freight: 'фрахт', storage: 'зберігання', insurance: 'страхування', other: 'послуги' };

export function renderReportHtml(f: ReportFacts, summary: string | null): string {
  const p = f.product;
  const title = [p.name ?? 'Товар', p.quantity !== null ? `${nf(p.quantity)} ${esc(p.unit ?? '')}` : ''].join(' ').trim();
  const sub = [p.cas ? `CAS ${p.cas}` : null, p.form].filter(Boolean).join(' · ');

  const chain = f.chain
    .map((c) => `<span class="chip" title="${esc(c.name)}">${esc(shortName(c.name))}<i>${esc(cc(c.country))} · ${ROLE_UK[c.role]}</i></span>`)
    .join('<span class="arr">→</span>');
  const chainNote = [
    f.contractType === 'trilateral' ? 'тристоронній' : f.contractType === 'bilateral' ? 'двосторонній' : null,
    f.contractNumber ? `контракт ${f.contractNumber}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const pills = [
    f.cleared
      ? `<span class="pill p-ok"><span class="dot"></span>Розмитнено${f.cleared.date ? ` ${esc(f.cleared.date)}` : ''}</span>`
      : `<span class="pill p-info"><span class="dot"></span>Ще не розмитнено</span>`,
    f.counts.errors
      ? `<span class="pill p-err"><span class="dot"></span>${f.counts.errors} ${f.counts.errors === 1 ? 'критичний ризик' : 'критичні ризики'}</span>`
      : `<span class="pill p-ok"><span class="dot"></span>Критичних ризиків немає</span>`,
  ].join('');

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const m = f.money;
  const kValue = m.outbound
    ? `<div class="v">${money(m.outbound.value, m.outbound.currency)}</div><div class="s">${m.inbound ? 'продаж' : 'інвойс'}${m.outbound.place ? `, ${esc(m.outbound.place)}` : ''}${
        m.inbound
          ? `<br>закупівля посередника <b>${money(m.inbound.value, m.inbound.currency)}</b>${
              m.markupPct !== null ? ` <span class="${m.markupPct < 0 ? 'neg' : 'pos'}">${m.markupPct > 0 ? '+' : ''}${m.markupPct}%</span>` : ''
            }`
          : ''
      }</div>`
    : `<div class="v">—</div><div class="s">інвойс не розпізнано</div>`;
  const pay = m.dutyUah !== null || m.vatUah !== null ? (m.dutyUah ?? 0) + (m.vatUah ?? 0) : null;
  const kPay =
    pay !== null
      ? `<div class="v">${nf(pay)} ₴</div><div class="s">мито${m.dutyRatePct !== null ? ` ${nf(m.dutyRatePct, m.dutyRatePct % 1 ? 1 : 0)}%` : ''} <b>${nf(m.dutyUah ?? 0)} ₴</b> · ПДВ <b>${nf(m.vatUah ?? 0)} ₴</b><br>${
          m.customsValueUah !== null ? `МВ ${nf(m.customsValueUah)} ₴` : ''
        }${m.rate !== null ? ` · курс ${nf(m.rate, 4)}` : ''}</div>`
      : `<div class="v">—</div><div class="s">МД ще немає</div>`;
  const svc = m.servicesUah.map((s) => `${esc(SERVICE_UK[s.kind] ?? s.kind)} <b>${nf(s.amountUah)} ₴</b>`).join(' + ');
  const kCost =
    m.costPerKgUah !== null
      ? `<div class="v">${nf(m.costPerKgUah)} ₴<span class="u"> /кг</span></div><div class="s">товар + мито${svc ? ` + ${svc}` : ''}<br>без ПДВ (до кредиту)${m.freightInPrice ? '; фрахт у ціні' : ''}</div>`
      : `<div class="v">—</div><div class="s">потрібні МД і кількість</div>`;
  const d = f.durations;
  const kTime =
    d.contractToDeclaration !== null
      ? `<div class="v">${d.contractToDeclaration} днів</div><div class="s">контракт → МД${d.shipmentToDeclaration !== null ? `<br>відвантаження → МД <b>${d.shipmentToDeclaration} днів</b>` : ''}</div>`
      : `<div class="v">—</div><div class="s">дат замало для розрахунку</div>`;

  // ── route / timeline ──────────────────────────────────────────────────────
  const routeParts: string[] = [];
  f.route.stops.forEach((s, i) => {
    const last = i === f.route.stops.length - 1;
    routeParts.push(
      `<div class="stop${last ? ' end' : ''}"><span class="pt"></span><b>${esc(s.name)}</b><span>${esc(s.date ?? '')}</span></div>`,
    );
    const leg = f.route.legs[i];
    if (!last && leg) {
      const md = MODE[leg.mode] ?? MODE.road!;
      routeParts.push(
        `<div class="leg ${md.cls}"><span class="md">${md.icon}${leg.ref ? ` ${esc(leg.ref)}` : ''}</span><span class="ln"></span></div>`,
      );
    }
  });
  const modes = [...new Set(f.route.legs.map((l) => ({ air: 'авіа', road: 'авто', sea: 'море', rail: 'залізниця' })[l.mode] ?? l.mode))].join(' + ');
  const routeMeta = [modes, f.shipment.packages !== null ? `${f.shipment.packages} місця` : null, f.shipment.grossKg !== null ? `брутто ${nf(f.shipment.grossKg, f.shipment.grossKg % 1 ? 2 : 0)} кг` : null]
    .filter(Boolean)
    .join(' · ');

  const tl = f.timeline
    .map((e) => `<div class="ev"><div class="d"></div><b>${esc(e.date)}</b><span>${esc(e.label)}</span></div>`)
    .join('');

  // ── risks / classification / docs ─────────────────────────────────────────
  const risks = f.risksTop.length
    ? f.risksTop
        .map(
          (r, i) =>
            `<li><span class="n ${r.severity === 'error' ? 'r-err' : 'r-warn'}">${i + 1}</span><div>${esc(cap(r.title.replace(/^Розбіжність:\s*/, '')))}<small>${esc(
              r.detail.length > 110 ? `${r.detail.slice(0, 107)}…` : r.detail,
            )}</small></div></li>`,
        )
        .join('')
    : '<li class="none">Ризиків не виявлено</li>';
  const totalRisks = f.counts.errors + f.counts.warnings;

  const c = f.classification;
  const kv: [string, string][] = [];
  if (c.hsCode) kv.push(['УКТ ЗЕД', `${esc(c.hsCode)}${c.hsSource ? ` <span class="src">${esc(c.hsSource)}</span>` : ''}`]);
  if (c.duty || c.vatPct !== null) kv.push(['Ставки', [c.duty ? `мито ${esc(c.duty)}` : null, c.vatPct !== null ? `ПДВ ${c.vatPct}%` : null].filter(Boolean).join(' · ')]);
  if (c.controls.length) kv.push(['Контроль', `${esc(c.controls.join(' · '))} <span class="src">${esc(c.controlsSource ?? '')}</span>`]);
  if (p.batch) kv.push(['Партія', esc(p.batch)]);
  if (p.manufactured || p.expiry) kv.push(['Придатність', `${esc(p.manufactured ?? '?')} → ${esc(p.expiry ?? '?')}`]);
  const kvHtml = kv.length ? kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') : '<dt>—</dt><dd>даних немає</dd>';

  const docsHtml = f.docs.items
    .map((i) => (i.ok ? `<div><span class="ck">✓</span>${esc(i.label)}</div>` : `<div class="miss">— ${esc(i.label)}</div>`))
    .join('');

  return `<!doctype html><html lang="uk"><head><meta charset="utf-8">
<title>Звіт по постачанню — ${esc(f.number)}</title>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><div class="page">
<div class="hd"><div class="brand"><div class="mark">Ш</div><b>ШТУРМАН</b><span>Звіт по постачанню для керівництва</span></div>
<div class="meta">Постачання <b>${esc(f.number)}</b> · сформовано <b>${esc(f.generatedAt)}</b>${f.responsible ? `<br>Відповідальний: ${esc(f.responsible)}` : ''}</div></div>

<div class="hero"><div><div class="title">${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>
<div class="chain">${chain}${chainNote ? `<span class="cn">${esc(chainNote)}</span>` : ''}</div></div>
<div class="status">${pills}</div></div>

<div class="kpis">
<div class="kpi"><div class="l">Вартість товару</div>${kValue}</div>
<div class="kpi"><div class="l">Митні платежі</div>${kPay}</div>
<div class="kpi"><div class="l">Собівартість</div>${kCost}</div>
<div class="kpi"><div class="l">Строк</div>${kTime}</div>
</div>

${f.route.stops.length >= 2 ? `<div class="card"><h3>Маршрут <em>${esc(routeMeta)}</em></h3><div class="route">${routeParts.join('')}</div></div>` : ''}
${f.timeline.length ? `<div class="card"><h3>Таймлайн <em>етапи з документів</em></h3><div class="tl" style="grid-template-columns:repeat(${f.timeline.length},1fr)">${tl}</div></div>` : ''}

<div class="grid2">
<div class="card summary"><h3>Резюме для керівництва ${summary ? '<span class="ai">✦ ШІ</span>' : ''}</h3><p>${
    summary ? esc(summary) : 'Резюме недоступне — дивіться ключові показники та ризики.'
  }</p></div>
<div class="card"><h3>Головні ризики <em>топ-${f.risksTop.length} з ${totalRisks}</em></h3><ul class="risks">${risks}</ul></div>
</div>

<div class="grid2">
<div class="card"><h3>Товар і класифікація</h3><dl class="kv">${kvHtml}</dl></div>
<div class="card"><h3>Документи <em>${f.docs.present} з ${f.docs.required} обовʼязкових</em></h3><div class="docs">${docsHtml}</div>
<div class="counts"><div class="cnt c-err"><b>${f.counts.errors}</b>критичні</div><div class="cnt c-warn"><b>${f.counts.warnings}</b>попередження</div><div class="cnt c-n"><b>${f.docs.files}</b>файлів</div></div></div>
</div>

<div class="ft"><span>Дані зібрано автоматично з документів поставки${summary ? ' · резюме ✦ згенеровано ШІ, перевірте перед рішенням' : ''}</span><span>Деталі та джерела — у Штурмані</span></div>
</div></body></html>`;
}

const CSS = `
:root{--bg:#fff;--panel:#f7f7f8;--text:#0d0d0f;--muted:#8b8b94;--faint:#b4b4bc;--border:rgba(13,13,15,.09);--border2:rgba(13,13,15,.14);
--accent:#2f6feb;--accentSoft:rgba(47,111,235,.12);--ok:#12936a;--okBg:rgba(18,147,106,.12);--warn:#d98213;--warnBg:rgba(217,130,19,.14);
--err:#dc4a4f;--errBg:rgba(220,74,79,.12);--font:"Hanken Grotesk",system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
@page{size:A4;margin:0}*{box-sizing:border-box}
html,body{margin:0;background:#e9e9ee;font-family:var(--font);color:var(--text);-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:210mm;height:297mm;margin:12mm auto;background:var(--bg);padding:11mm 12mm 9mm;display:flex;flex-direction:column;gap:3.2mm;box-shadow:0 10px 34px rgba(13,13,20,.12);overflow:hidden}
@media print{html,body{background:#fff}.page{margin:0;box-shadow:none}}
.hd{display:flex;align-items:center;justify-content:space-between;padding-bottom:3mm;border-bottom:1.5px solid var(--text)}
.brand{display:flex;align-items:center;gap:8px}.mark{width:26px;height:26px;border-radius:8px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px}
.brand b{font-weight:700;font-size:14px;letter-spacing:1.5px}.brand span{color:var(--muted);font-size:12px;margin-left:6px}
.meta{text-align:right;font-size:10.5px;color:var(--muted);line-height:1.45}.meta b{color:var(--text);font-weight:600}
.hero{display:grid;grid-template-columns:1fr auto;gap:6mm;align-items:start}
.title{font-size:22px;font-weight:800;letter-spacing:-.3px;line-height:1.1}.title small{font-size:13px;font-weight:500;color:var(--muted);margin-left:6px;letter-spacing:0}
.chain{margin-top:5px;font-size:11.5px;display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.chip{padding:2px 7px;border-radius:999px;background:var(--panel);border:1px solid var(--border);font-weight:600}.chip i{font-style:normal;color:var(--muted);font-weight:500;margin-left:3px}
.arr{color:var(--faint)}.cn{color:var(--muted);margin-left:4px}
.status{display:flex;flex-direction:column;gap:5px;align-items:flex-end}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:11.5px;font-weight:700;white-space:nowrap}.pill .dot{width:7px;height:7px;border-radius:50%}
.p-ok{background:var(--okBg);color:var(--ok)}.p-ok .dot{background:var(--ok)}.p-err{background:var(--errBg);color:var(--err)}.p-err .dot{background:var(--err)}
.p-info{background:var(--accentSoft);color:var(--accent)}.p-info .dot{background:var(--accent)}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:2.6mm}
.kpi{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:8px 10px 9px}
.kpi .l{font-size:9.5px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);font-weight:600}
.kpi .v{font-size:19px;font-weight:800;margin-top:3px;letter-spacing:-.3px}.kpi .v .u{font-size:12px;font-weight:600}
.kpi .s{font-size:10px;color:var(--muted);margin-top:2px;line-height:1.35}.kpi .s b{color:var(--text);font-weight:600}
.neg{color:var(--err)}.pos{color:var(--ok)}
.card{border:1px solid var(--border);border-radius:10px;padding:8px 10px}
.card h3{margin:0 0 6px;font-size:9.5px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);font-weight:700;display:flex;justify-content:space-between}
.card h3 em{font-style:normal;text-transform:none;letter-spacing:0;font-weight:500}
.route{display:flex;align-items:flex-start;font-size:10.5px;padding-top:4px}
.stop{display:flex;flex-direction:column;align-items:center;text-align:center;flex:none;width:24mm}
.stop .pt{width:11px;height:11px;border-radius:50%;background:#fff;border:2.5px solid var(--accent)}.stop.end .pt{background:var(--accent)}
.stop b{margin-top:4px;font-size:11px}.stop span{color:var(--muted);font-size:9.5px;line-height:1.25}
.leg{flex:1;display:flex;flex-direction:column;align-items:center;margin-top:2px;min-width:0}
.leg .ln{height:2px;width:100%;background:var(--accent);opacity:.5}
.leg.road .ln{background:repeating-linear-gradient(90deg,var(--accent) 0 6px,transparent 6px 10px);opacity:.6}
.leg .md{font-size:9.5px;color:var(--accent);font-weight:700;background:#fff;padding:0 5px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.tl{position:relative;display:grid;margin-top:3px}
.tl:before{content:"";position:absolute;left:4%;right:4%;top:5px;height:2px;background:var(--border2)}
.ev{position:relative;text-align:center;font-size:9.5px;line-height:1.3;padding:0 2px}
.ev .d{width:12px;height:12px;border-radius:50%;background:var(--accent);border:2.5px solid #fff;box-shadow:0 0 0 1px var(--accent);margin:0 auto 4px}
.ev b{display:block;font-size:10.5px}.ev span{color:var(--muted)}
.grid2{display:grid;grid-template-columns:1.15fr 1fr;gap:2.6mm}
.summary p{margin:0;font-size:11.2px;line-height:1.5;max-height:44mm;overflow:hidden}
.summary .ai{font-size:9px;font-weight:700;color:var(--accent);background:var(--accentSoft);padding:1px 6px;border-radius:999px;text-transform:none;letter-spacing:0}
.risks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.risks li{display:grid;grid-template-columns:18px 1fr;gap:6px;font-size:10.8px;line-height:1.35}.risks li.none{display:block;color:var(--muted)}
.risks .n{width:18px;height:18px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:10px}
.r-err{background:var(--errBg);color:var(--err)}.r-warn{background:var(--warnBg);color:var(--warn)}
.risks small{display:block;color:var(--muted);font-size:9.8px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:10.6px;margin:0}.kv dt{color:var(--muted)}.kv dd{margin:0;font-weight:600}
.src{font-size:8.5px;font-weight:700;color:var(--accent);background:var(--accentSoft);padding:0 5px;border-radius:999px;margin-left:4px;vertical-align:1px}
.docs{display:grid;grid-template-columns:1fr 1fr;gap:3px 10px;font-size:10.4px}.docs div{display:flex;gap:5px;align-items:center}.docs .miss{color:var(--err)}
.ck{color:var(--ok);font-weight:800}
.counts{display:flex;gap:6px;margin-top:7px}.cnt{flex:1;border-radius:8px;padding:5px 7px;font-size:10px;font-weight:600}.cnt b{font-size:15px;font-weight:800;display:block}
.c-err{background:var(--errBg);color:var(--err)}.c-warn{background:var(--warnBg);color:var(--warn)}.c-n{background:var(--panel);color:var(--muted)}
.ft{margin-top:auto;display:flex;justify-content:space-between;font-size:9px;color:var(--faint);border-top:1px solid var(--border);padding-top:2.5mm}
`;
