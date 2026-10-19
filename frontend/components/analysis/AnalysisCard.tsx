"use client";

// Rich consolidated-cargo analysis card — a 1:1 port of the prototype's analysis
// block (ШТУРМАН.dc.html lines ~365–423): sheet banner, CIF/Мито/ПДВ/До сплати
// tiles, manifest table, possible-origin cards, EU/UA broker checks, export button
// and the archive/disclaimer note. Extra backend signals (criticalAlert, warnings,
// aiDegraded, nctsList, needsReview) are surfaced as banners/highlights.

import { downloadBlob } from "@/lib/api";
import type { AnalysisCheck, AnalysisResult, AnalysisRow, SourceCheck } from "@/lib/types";

// Origin key → Ukrainian label + colour token (prototype lines 1227–1228).
const ORIGIN_LABEL: Record<string, string> = {
  plant: "Рослинне",
  animal: "Тваринне",
  fermentation: "Ферментаційне",
  mineral: "Мінеральне",
  synthetic: "Синтетичне",
  mixed: "Змішане",
  unknown: "Підтвердити",
};
const ORIGIN_COLOR: Record<string, string> = {
  plant: "var(--ok)",
  animal: "var(--warn)",
  fermentation: "var(--accent)",
  mineral: "var(--muted)",
  synthetic: "var(--accent)",
  mixed: "var(--warn)",
  unknown: "var(--err)",
};

function originLabel(o: string | null): string {
  return (o && ORIGIN_LABEL[o]) || ORIGIN_LABEL.unknown!;
}
function originColor(o: string | null): string {
  return (o && ORIGIN_COLOR[o]) || ORIGIN_COLOR.unknown!;
}

// Risk label → colour + soft background (prototype rc/rb, line 1330–1331).
function riskColor(r: string | null): string {
  return r === "Критичний" ? "var(--err)" : r === "Середній" ? "var(--warn)" : "var(--ok)";
}
function riskBg(r: string | null): string {
  return r === "Критичний" ? "var(--errBg)" : r === "Середній" ? "var(--warnBg)" : "var(--okBg)";
}

// Check status → dot colour (prototype sc, line 1329). Backend uses green|yellow|red.
function checkDot(status: string): string {
  return status === "red" ? "var(--err)" : status === "yellow" ? "var(--warn)" : "var(--ok)";
}

// fmt: round + uk-UA thousands separators, matching the prototype (line 1328).
function fmt(n: number): string {
  return Math.round(n).toLocaleString("uk-UA");
}
// Money with the prototype's ' $' suffix; null → em dash.
function money(n: number | null): string {
  return n === null || n === undefined ? "—" : fmt(n) + " $";
}

const uctzed = (code: string | null) => (code && code.trim() ? code : "—");

function CheckList({ title, checks }: { title: string; checks: AnalysisCheck[] }) {
  return (
    <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: "var(--muted)",
          textTransform: "uppercase",
          letterSpacing: ".3px",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {checks.length === 0 ? (
        <div style={{ fontSize: 11.5, color: "var(--faint)" }}>—</div>
      ) : (
        checks.map((c, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              marginBottom: 5,
              fontSize: 11.5,
              color: "var(--text)",
              lineHeight: 1.35,
            }}
          >
            <span
              style={{
                flex: "none",
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: checkDot(c.status),
                marginTop: 4,
              }}
            />
            <span>
              {c.item}
              {c.note ? <span style={{ color: "var(--muted)" }}> {c.note}</span> : null}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

// Live cross-check with qdpro (logist-mcp): restriction flags the static engine
// can't surface, shown as compact chips under the code. Enrichment only.
function SourceFlags({ sc }: { sc: SourceCheck }) {
  const chips: { label: string; color: string }[] = [];
  if (sc.banRf) chips.push({ label: "Заборона РФ", color: "var(--err)" });
  if (sc.dualUse) chips.push({ label: "Подвійне викор.", color: "var(--err)" });
  if (sc.narcotic) chips.push({ label: "Наркотич./прекурсор", color: "var(--err)" });
  if (sc.license) chips.push({ label: "Ліцензія", color: "var(--warn)" });
  if (sc.vetControl) chips.push({ label: "Ветконтроль", color: "var(--warn)" });
  if (sc.phyto) chips.push({ label: "Фітоконтроль", color: "var(--warn)" });
  if (sc.dutyMismatch && sc.dutyPref)
    chips.push({ label: `qdpro: мито ${sc.dutyPref}`, color: "var(--warn)" });
  if (chips.length === 0) {
    return (
      <div style={{ fontSize: 9.5, color: "var(--ok)", marginTop: 4 }}>
        ✓ qdpro: без обмежень{sc.dutyPref ? ` · мито ${sc.dutyPref}` : ""}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
      {chips.map((c) => (
        <span
          key={c.label}
          title={`Джерело: qdpro.com.ua (${sc.source})`}
          style={{
            fontSize: 9.5,
            fontWeight: 600,
            color: c.color,
            border: `1px solid ${c.color}`,
            borderRadius: 5,
            padding: "0 5px",
            lineHeight: "15px",
            whiteSpace: "nowrap",
          }}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}

function ManifestRow({ r }: { r: AnalysisRow }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "2.3fr 1fr 1.3fr .8fr 1.4fr",
        borderTop: "1px solid var(--border)",
        alignItems: "center",
        background: r.needsReview ? "var(--warnBg)" : "transparent",
      }}
    >
      <div style={{ padding: "10px 11px", minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", lineHeight: 1.3 }}>
          {r.name}
          {r.needsReview ? (
            <span
              style={{
                marginLeft: 6,
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: ".3px",
                color: "var(--warn)",
                border: "1px solid var(--warn)",
                borderRadius: 5,
                padding: "1px 5px",
                verticalAlign: "middle",
              }}
            >
              ПЕРЕВІРИТИ
            </span>
          ) : null}
        </div>
        <div
          style={{
            fontSize: 10.5,
            color: "var(--muted)",
            fontVariantNumeric: "tabular-nums",
            marginTop: 2,
          }}
        >
          {uctzed(r.code)}
        </div>
        {r.sourceCheck ? <SourceFlags sc={r.sourceCheck} /> : null}
      </div>
      <div style={{ padding: "10px 11px", fontSize: 11.5, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
        {fmt(r.qtyKg)} кг · {r.price} $/кг
      </div>
      <div style={{ padding: "10px 11px", fontSize: 11.5, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
        <div>{money(r.cif)}</div>
        <div style={{ color: "var(--muted)", fontSize: 10.5 }}>
          {money(r.duty)}
          {r.dutyRate !== null && r.dutyRate !== undefined ? ` · ${r.dutyRate}%` : ""}
        </div>
      </div>
      <div style={{ padding: "10px 11px", fontSize: 11.5, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
        {money(r.vat)}
      </div>
      <div style={{ padding: "10px 11px", display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            color: originColor(r.origin),
            border: `1px solid ${originColor(r.origin)}`,
            borderRadius: 6,
            padding: "1px 6px",
          }}
        >
          {originLabel(r.origin)}
        </span>
        {r.risk ? (
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              color: riskColor(r.risk),
              background: riskBg(r.risk),
              borderRadius: 6,
              padding: "2px 7px",
            }}
          >
            {r.risk}
          </span>
        ) : null}
      </div>
    </div>
  );
}

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      padding: "6px 16px 6px",
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: ".5px",
      color: "var(--faint)",
      textTransform: "uppercase",
    }}
  >
    {children}
  </div>
);

export function AnalysisCard({ analysis }: { analysis: AnalysisResult }) {
  const a = analysis;
  const sheet = a.sheet || a.meta.sheet;
  const hasIgnored = a.meta.ignored && a.meta.ignored.length > 0;

  const metrics: { label: string; tag: string; value: string; valColor: string }[] = [
    { label: "Митна вартість", tag: "CIF", value: money(a.totals.cif), valColor: "var(--text)" },
    { label: "Мито", tag: "УКТЗЕД", value: money(a.totals.duty), valColor: "var(--text)" },
    { label: "ПДВ 20%", tag: "ПДВ", value: money(a.totals.vat), valColor: "var(--text)" },
    { label: "До сплати", tag: "ІТОГО", value: money(a.totals.payable), valColor: "var(--accent)" },
  ];

  const onExport = () => {
    if (!a.id) return;
    void downloadBlob(`/api/analyses/${a.id}/xlsx`, `analysis-${sheet || "manifest"}.xlsx`).catch(
      () => alert("Не вдалося завантажити звіт.")
    );
  };

  return (
    <div
      style={{
        marginTop: 14,
        border: "1px solid var(--border)",
        borderRadius: 14,
        overflow: "hidden",
        background: "var(--surface)",
      }}
    >
      {/* Critical alert banner */}
      {a.criticalAlert ? (
        <div
          style={{
            padding: "10px 16px",
            background: "var(--errBg)",
            color: "var(--err)",
            fontSize: 12.5,
            fontWeight: 600,
            lineHeight: 1.4,
            borderBottom: "1px solid var(--border)",
          }}
        >
          {a.criticalAlert}
        </div>
      ) : null}

      {/* AI-degraded note */}
      {a.aiDegraded ? (
        <div
          style={{
            padding: "8px 16px",
            background: "var(--warnBg)",
            color: "var(--warn)",
            fontSize: 11.5,
            lineHeight: 1.4,
            borderBottom: "1px solid var(--border)",
          }}
        >
          AI-аналіз недоступний — показано детерміновані значення, перевірте вручну.
        </div>
      ) : null}

      {/* Live source cross-check note (qdpro via logist-mcp) */}
      {a.sourceChecked ? (
        <div
          style={{
            padding: "8px 16px",
            background: "var(--okBg)",
            color: "var(--muted)",
            fontSize: 11,
            lineHeight: 1.4,
            borderBottom: "1px solid var(--border)",
          }}
        >
          Позиції звірено з офіційним джерелом (qdpro): під кодом показано реальні ставки та
          обмеження/контроль. Розрахунок мита/ПДВ лишається за базовою таблицею.
        </div>
      ) : null}

      {/* Sheet banner */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px 10px",
          padding: "12px 16px",
          background: "var(--accentSoft)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontWeight: 700,
            fontSize: 12,
            color: "var(--accent)",
            letterSpacing: ".3px",
          }}
        >
          ▶ ЛИСТ «{sheet}»
        </span>
        {a.meta.date ? (
          <span style={{ fontSize: 12, color: "var(--text)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
            {a.meta.date}
          </span>
        ) : null}
        {a.meta.reason ? <span style={{ fontSize: 12, color: "var(--muted)" }}>· {a.meta.reason}</span> : null}
        {hasIgnored ? (
          <span style={{ width: "100%", fontSize: 11, color: "var(--muted)" }}>
            Проігноровано ({a.meta.ignored.length}): {a.meta.ignored.join(", ")}
          </span>
        ) : null}
      </div>

      {/* Financial summary tiles */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(128px,1fr))",
          gap: 1,
          background: "var(--border)",
        }}
      >
        {metrics.map((mt) => (
          <div key={mt.tag} style={{ padding: "13px 15px", background: "var(--surface)" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 6,
                marginBottom: 5,
              }}
            >
              <span style={{ fontSize: 11, color: "var(--muted)" }}>{mt.label}</span>
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: ".4px",
                  color: "var(--faint)",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  padding: "1px 5px",
                  whiteSpace: "nowrap",
                }}
              >
                {mt.tag}
              </span>
            </div>
            <div style={{ fontSize: 19, fontWeight: 700, color: mt.valColor, fontVariantNumeric: "tabular-nums" }}>
              {mt.value}
            </div>
          </div>
        ))}
      </div>

      {/* NCTS transit note */}
      {a.nctsList && a.nctsList.length > 0 ? (
        <div style={{ padding: "10px 16px 0", fontSize: 11.5, color: "var(--muted)", lineHeight: 1.45 }}>
          Транзит ЄС (NCTS): {a.nctsList.join(", ")}
        </div>
      ) : null}

      {/* Manifest table */}
      <SectionLabel>Маніфест партії</SectionLabel>
      <div style={{ overflowX: "auto", padding: "0 16px 12px" }}>
        <div style={{ minWidth: 660, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "2.3fr 1fr 1.3fr .8fr 1.4fr",
              background: "var(--hover)",
              fontSize: 10,
              fontWeight: 600,
              color: "var(--muted)",
              textTransform: "uppercase",
              letterSpacing: ".3px",
            }}
          >
            <div style={{ padding: "9px 11px" }}>Товар / УКТЗЕД</div>
            <div style={{ padding: "9px 11px" }}>Кг · ціна</div>
            <div style={{ padding: "9px 11px" }}>CIF · мито</div>
            <div style={{ padding: "9px 11px" }}>ПДВ</div>
            <div style={{ padding: "9px 11px" }}>Походж. · ризик</div>
          </div>
          {a.rows.map((r, i) => (
            <ManifestRow key={i} r={r} />
          ))}
        </div>
      </div>

      {/* Possible origin cards */}
      <SectionLabel>Можливе походження</SectionLabel>
      <div
        style={{
          padding: "0 16px 12px",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))",
          gap: 8,
        }}
      >
        {a.rows.map((r, i) => (
          <div
            key={i}
            style={{
              padding: "10px 12px",
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              borderLeft: `3px solid ${originColor(r.origin)}`,
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {r.name}
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, color: originColor(r.origin), marginTop: 3 }}>
              {originLabel(r.origin)}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 3, lineHeight: 1.4 }}>
              {r.riskNote || r.category}
            </div>
          </div>
        ))}
      </div>

      {/* Broker checks · EU / UA */}
      <SectionLabel>Перевірки брокера · ЄС / UA</SectionLabel>
      <div style={{ padding: "0 16px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
        {a.rows.map((r, i) => (
          <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "8px 12px", background: "var(--hover)", fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
              {r.name}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
              <CheckList title="Транзит ЄС" checks={r.eu} />
              <CheckList title="Розмитнення UA" checks={r.ua} />
            </div>
          </div>
        ))}
      </div>

      {/* Warnings */}
      {a.warnings && a.warnings.length > 0 ? (
        <div style={{ padding: "0 16px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
          {a.warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.4 }}>
              • {w}
            </div>
          ))}
        </div>
      ) : null}

      {/* Export + disclaimer */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 10,
          padding: "12px 16px",
          borderTop: "1px solid var(--border)",
          background: "var(--card)",
        }}
      >
        {a.id ? (
          <button
            onClick={onExport}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              height: 38,
              padding: "0 16px",
              background: "var(--accent)",
              border: "none",
              borderRadius: 10,
              color: "var(--accentTx)",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M7 10l5 5 5-5" />
              <path d="M12 15V3" />
            </svg>
            Експорт звіту (.xlsx)
          </button>
        ) : null}
        <span style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.4 }}>
          Збережено в архів. Походження — не юридичне підтвердження; звіряйте CoA/SDS/declaration of origin.
        </span>
      </div>
    </div>
  );
}
