"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, downloadBlob } from "@/lib/api";
import type { FclOverview, LotDetail } from "@/lib/types";
import { useLotDetail } from "@/lib/fcl/useFcl";
import { LIGHT_COLOR, LOT_STATUS_LABEL, MATCH_LABEL, fclCounts, lotRows, resolveScope } from "@/lib/fcl/fcl";
import { askInChat, askPrompts, type AskScope } from "@/lib/chat/askBus";
import { statusCaveat, summarizeFindings } from "@/lib/shipment/findings";
import { DiscrepanciesBlock, RisksBlock } from "../shipment/Findings";
import { INCOTERMS_2020, TRANSPORT_MODES } from "@/lib/shipmentOptions";
import { AskButtons, CompletenessHeader, Section, Field, lbl } from "../shipment/parts";
import { CONTRACT_TYPE_LABEL, PARTY_SLOTS } from "../shipment/labels";
import { IconSpinner } from "../ui/icons";
import type { TriageCtx } from "../shipment/Triage";
import { openProblemsReport } from "@/lib/shipment/triage";

/**
 * «Комплектність» of a Збірник (spec 006 #09) with the scope switcher
 * «Весь FCL / Партія N». The FCL scope shows the container-wide checks; a lot is
 * shown like a shipment, with its own context.
 */
export function FclCompleteness({
  fclId,
  number,
  overview,
  loading = false,
  version,
  reload,
  scope,
  onScope,
  notify,
}: {
  fclId: string;
  number: string;
  overview: FclOverview | null;
  loading?: boolean;
  version: number;
  reload: () => Promise<void>;
  scope: string;
  onScope: (s: string) => void;
  notify: (text: string) => void;
}) {
  const lots = overview?.lots ?? [];
  const current = resolveScope(scope, lots);
  const { detail, failed: detailFailed } = useLotDetail(fclId, current === "fcl" ? null : current, version);

  if (!overview) {
    return loading ? (
      <div style={{ padding: 18, color: "var(--muted)", fontSize: 13 }}>
        <IconSpinner size={14} /> Завантажую…
      </div>
    ) : (
      <div style={{ padding: 18, color: "var(--warn)", fontSize: 13 }}>
        Не вдалося завантажити перевірку збірника — це не означає, що все гаразд. Спробуйте відкрити панель знову.
      </div>
    );
  }

  return (
    <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 16, overflowY: "auto", height: "100%" }}>
      <select className="input" value={current} onChange={(e) => onScope(e.target.value)} aria-label="Область перевірки">
        <option value="fcl">Весь FCL</option>
        {lots.map((l) => (
          <option key={l.id} value={l.id}>
            Партія — {l.name}
          </option>
        ))}
      </select>
      {current === "fcl" ? (
        <FclScope fclId={fclId} number={number} overview={overview} reload={reload} notify={notify} onScope={onScope} />
      ) : detail ? (
        <LotScope fclId={fclId} detail={detail} reload={reload} notify={notify} onBack={() => onScope("fcl")} />
      ) : detailFailed ? (
        <div style={{ color: "var(--warn)", fontSize: 13 }}>Не вдалося завантажити партію — це не означає, що все гаразд.</div>
      ) : (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>
          <IconSpinner size={14} /> Завантажую партію…
        </div>
      )}
    </div>
  );
}

/** Sidebar questions of a Збірник go to its (consolidated) chat. */
const askFcl = (text: string) => askInChat(text, "consolidated");

function AskSection({ scope, extra }: { scope: AskScope; extra?: { label: string; onClick: () => void }[] }) {
  return (
    <Section title="Запитати Штурмана">
      <AskButtons
        primary={{
          label: scope.kind === "lot" ? "Що не так з партією?" : "Що не так зі збірником?",
          onClick: () => askFcl(askPrompts.check(scope)),
        }}
        items={[
          { label: "Комплектність", onClick: () => askFcl(askPrompts.completeness(scope)) },
          { label: "Розбіжності", onClick: () => askFcl(askPrompts.discrepancies(scope)) },
          { label: "Ризики", onClick: () => askFcl(askPrompts.risks(scope)) },
          ...(extra ?? [{ label: "Що робити далі?", onClick: () => askFcl(askPrompts.next(scope)) }]),
        ]}
      />
    </Section>
  );
}

function Status({ label, caveat }: { label: string; caveat?: string | null }) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600 }}>Статус: {label}</div>
      {caveat ? <div style={{ fontSize: 12, color: "var(--warn)", marginTop: 2 }}>{caveat}</div> : null}
    </div>
  );
}

function FclScope({
  fclId,
  number,
  overview,
  reload,
  notify,
  onScope,
}: {
  fclId: string;
  number: string;
  overview: FclOverview;
  reload: () => Promise<void>;
  notify: (text: string) => void;
  onScope: (s: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const f = overview.fcl;
  const run = async (key: string, fn: () => Promise<unknown>, fail: string) => {
    setBusy(key);
    try {
      await fn();
    } catch {
      notify(fail);
    } finally {
      setBusy(null);
    }
  };
  const patchWs = (body: Record<string, unknown>) =>
    run("ctx", async () => {
      await api(`/api/workspaces/${fclId}`, { method: "PATCH", body });
      await reload();
    }, "Не вдалося зберегти.");
  const setEuTransit = (v: string) =>
    run("ctx", async () => {
      await api(`/api/workspaces/${fclId}/fcl`, { method: "PATCH", body: { eu_transit: v === "" ? null : v === "yes" } });
      await reload();
    }, "Не вдалося зберегти.");
  const report = (format: "pdf" | "html") =>
    run("report", async () => {
      const r = await api<{ html: string; artifactId: string }>(`/api/workspaces/${fclId}/report`, { method: "POST", body: {} });
      if (format === "pdf") {
        await downloadBlob(`/api/workspaces/${fclId}/report/${r.artifactId}/pdf`, `zvit-${number}.pdf`);
        return;
      }
      const url = URL.createObjectURL(new Blob([r.html], { type: "text/html" }));
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }, "Не вдалося сформувати звіт.");
  const zip = () => run("zip", () => downloadBlob(`/api/workspaces/${fclId}/export`, `${number}.zip`), "Не вдалося експортувати.");
  const problems = () => run("problems", () => openProblemsReport(fclId), "Не вдалося сформувати звіт про проблеми.");
  const triage: TriageCtx = { workspaceId: fclId, onChanged: reload, notify };

  const levelFindings = overview.all_discrepancies.filter((d) => !d.lot);
  const lotLevelFindings = overview.all_discrepancies.filter((d) => !!d.lot);
  const counts = fclCounts(overview);
  const caveat = statusCaveat(f.derived_status, { errors: counts.all.errors + counts.risksError, warnings: counts.all.warnings + counts.risksWarning, toCheck: counts.all.toCheck });
  const scope: AskScope = { kind: "fcl" };
  const rows = lotRows(overview);
  // Container documents first, then the customs ones (МД per consignee).
  const fclDocs = [
    ...overview.checklist.filter((i) => i.stage === "docs"),
    ...overview.checklist.filter((i) => i.stage === "customs"),
  ];
  return (
    <>
      <Status label={LOT_STATUS_LABEL[f.derived_status]} caveat={caveat} />

      <Section title={`Партії (${rows.length})`}>
        {rows.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 13 }}>
            Партій ще немає — вони створюються, коли прочитано інвойс, контракт або PL постачальника.
          </div>
        ) : (
          rows.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onScope(r.id)}
              title="Відкрити партію"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                textAlign: "left",
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "7px 9px",
                cursor: "pointer",
                color: "var(--text)",
              }}
            >
              <span style={{ flex: "none", width: 9, height: 9, borderRadius: "50%", background: LIGHT_COLOR[r.light] }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.name}
                </span>
                <span style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>
                  документи {r.docs} · {r.summary}
                  {r.consignee ? ` · → ${r.consignee}` : ""}
                </span>
              </span>
              <span style={{ flex: "none", color: "var(--muted)", fontSize: 13 }}>›</span>
            </button>
          ))
        )}
      </Section>

      {fclDocs.length > 0 ? (
        <CompletenessHeader
          title="Документи контейнера"
          items={fclDocs}
          onAskMissing={(label) => askFcl(askPrompts.missing(label, scope))}
          onRequestMissing={(label) => askFcl(askPrompts.request(label, scope))}
        />
      ) : null}

      <AskSection
        scope={scope}
        extra={[
          ...(overview.manifest ? [{ label: "Маніфест ↔ інвойси", onClick: () => askFcl(askPrompts.manifest()) }] : []),
          { label: "Що робити далі?", onClick: () => askFcl(askPrompts.next(scope)) },
        ]}
      />

      <Section title="Ризики">
        <RisksBlock risks={overview.risks} title="" onAsk={askFcl} triage={triage} />
      </Section>

      <DiscrepanciesBlock
        title="Розбіжності збірника"
        items={levelFindings}
        emptyText="На рівні збірника розбіжностей не виявлено."
        onAsk={askFcl}
        triage={triage}
      />
      <DiscrepanciesBlock
        title="Розбіжності по партіях"
        items={lotLevelFindings}
        emptyText="По партіях розбіжностей не виявлено."
        onAsk={askFcl}
        triage={triage}
      />

      <Section title="Параметри FCL">
        <label style={lbl}>Вид транспорту</label>
        <select className="input" value={f.transport_mode ?? ""} disabled={busy === "ctx"} onChange={(e) => void patchWs({ transport_mode: e.target.value || null })}>
          <option value="">—</option>
          {TRANSPORT_MODES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <label style={lbl}>
          Транзит через ЄС (T1 + CMR){f.eu_transit === null && f.eu_transit_derived !== null ? ` — з документів: ${f.eu_transit_derived ? "так" : "ні"}` : ""}
        </label>
        <select className="input" value={f.eu_transit === null ? "" : f.eu_transit ? "yes" : "no"} disabled={busy === "ctx"} onChange={(e) => void setEuTransit(e.target.value)}>
          <option value="">визначити з документів</option>
          <option value="yes">так</option>
          <option value="no">ні</option>
        </select>
      </Section>

      <Section title="Отримувачі">
        {overview.consignees.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 13 }}>Не визначено — задайте отримувача партій у вкладці «Партії».</div>
        ) : (
          overview.consignees.map((c) => (
            <div key={c.name} style={{ fontSize: 13 }}>
              <b>{c.name}</b> — {c.lots.join(", ")} ·{" "}
              <span style={{ color: c.customs_declaration_file_id ? "var(--ok)" : "var(--muted)" }}>
                МД {c.customs_declaration_file_id ? "є" : "ще немає"}
              </span>
            </div>
          ))
        )}
      </Section>

      {overview.manifest ? (
        <Section title={overview.manifest.built ? "Позиції з інвойсів (маніфесту немає)" : `Маніфест ↔ інвойси · ${overview.manifest.file_name}`}>
          {overview.manifest.matches.map((m, i) => (
            <div key={i} style={{ fontSize: 12, display: "flex", gap: 8, justifyContent: "space-between" }}>
              <span style={{ minWidth: 0 }}>
                {m.manifest?.name ?? m.invoice?.description}
                {m.invoice ? <span style={{ color: "var(--muted)" }}> · {m.invoice.lot_name}</span> : null}
              </span>
              <span style={{ flex: "none", color: m.status === "ok" ? "var(--ok)" : m.status === "qty" ? "var(--err)" : "var(--warn)" }}>
                {overview.manifest!.built ? "" : MATCH_LABEL[m.status]}
              </span>
            </div>
          ))}
        </Section>
      ) : null}

      <Section title="Дії">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn" disabled={busy === "report"} onClick={() => void report("pdf")}>
            Звіт PDF
          </button>
          <button className="btn" disabled={busy === "report"} onClick={() => void report("html")}>
            Звіт HTML
          </button>
          <button className="btn" disabled={busy === "zip"} onClick={() => void zip()}>
            Архів по партіях (.zip)
          </button>
          <button className="btn" disabled={busy === "problems"} onClick={() => void problems()} title="Що відкрито, вирішено і виключено — у новій вкладці">
            Звіт про проблеми
          </button>
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>Інструкція постачальнику — у кожній партії окремо.</div>
      </Section>
    </>
  );
}

const LOT_FIELDS = ["incoterm_in", "incoterm_out", "product_category", "origin_country", "contract_type", "consignee"] as const;
type LotForm = Record<(typeof LOT_FIELDS)[number], string>;

function LotScope({
  fclId,
  detail,
  reload,
  notify,
  onBack,
}: {
  fclId: string;
  detail: LotDetail;
  reload: () => Promise<void>;
  notify: (text: string) => void;
  onBack: () => void;
}) {
  const router = useRouter();
  const l = detail.lot;
  const initial = (): LotForm => ({
    incoterm_in: l.context.incoterm_in ?? "",
    incoterm_out: l.context.incoterm_out ?? "",
    product_category: l.context.product_category ?? "",
    origin_country: l.context.origin_country ?? "",
    contract_type: l.context.contract_type ?? "",
    consignee: l.context.consignee ?? "",
  });
  const [form, setForm] = useState<LotForm>(initial);
  const [saving, setSaving] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setForm(initial()), [detail]);

  const dirty = LOT_FIELDS.some((k) => form[k] !== initial()[k]);
  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, string | null> = {};
      for (const k of LOT_FIELDS) if (form[k] !== initial()[k]) body[k] = form[k] || null;
      await api(`/api/workspaces/${fclId}/lots/${l.id}`, { method: "PATCH", body });
      await reload();
    } catch {
      notify("Не вдалося зберегти параметри партії.");
    } finally {
      setSaving(false);
    }
  };
  const lotSummary = summarizeFindings(detail.discrepancies);
  const lotRisks = summarizeFindings(detail.risks);
  const lotCaveat = statusCaveat(l.derived_status, { errors: lotSummary.errors + lotRisks.errors, warnings: lotSummary.warnings + lotRisks.warnings, toCheck: lotSummary.toCheck });
  const auto = (k: string) => (l.context.auto_fields.includes(k) ? " · з документів" : "");

  const scope: AskScope = { kind: "lot", name: l.name };
  const triage: TriageCtx = { workspaceId: fclId, lot: l.name, onChanged: reload, notify };
  return (
    <>
      <button type="button" className="btn" onClick={onBack} style={{ alignSelf: "flex-start", height: 28, fontSize: 12 }}>
        ← Весь збірник
      </button>
      <Status label={LOT_STATUS_LABEL[l.derived_status]} caveat={lotCaveat} />
      <div style={{ fontSize: 12, color: "var(--muted)" }}>
        Постачальник: {l.supplier_name || "—"} · {l.file_count} файл. · партія {l.source === "auto" ? "створена автоматично" : "створена вручну"}
      </div>

      {detail.checklist.length > 0 ? (
        <CompletenessHeader
          title="Комплектність партії"
          items={detail.checklist}
          onAskMissing={(label) => askFcl(askPrompts.missing(label, scope))}
          onRequestMissing={(label) => askFcl(askPrompts.request(label, scope))}
        />
      ) : (
        <div style={{ fontSize: 13, color: "var(--muted)" }}>Чек-лист порожній — заповніть параметри партії нижче.</div>
      )}

      <AskSection scope={scope} />

      <Section title="Ризики партії">
        <RisksBlock risks={detail.risks} title="" onAsk={askFcl} triage={triage} />
      </Section>
      <DiscrepanciesBlock items={detail.discrepancies} onAsk={askFcl} triage={triage} />

      <Section title="Параметри партії">
        <label style={lbl}>Incoterms (вхідні){auto("incoterm_in")}</label>
        <select className="input" value={form.incoterm_in} onChange={(e) => setForm((f) => ({ ...f, incoterm_in: e.target.value }))}>
          <option value="">—</option>
          {INCOTERMS_2020.map((o) => (
            <option key={o.value} value={o.value}>
              {o.value}
            </option>
          ))}
        </select>
        <label style={lbl}>Тип контракту{l.context.contract_type_source === "auto" ? " · з документів" : ""}</label>
        <select className="input" value={form.contract_type} onChange={(e) => setForm((f) => ({ ...f, contract_type: e.target.value }))}>
          <option value="">—</option>
          <option value="bilateral">{CONTRACT_TYPE_LABEL.bilateral}</option>
          <option value="trilateral">{CONTRACT_TYPE_LABEL.trilateral}</option>
        </select>
        <Field label="Категорія товару" value={form.product_category} onChange={(v) => setForm((f) => ({ ...f, product_category: v }))} />
        <Field label={`Країна походження${auto("origin_country")}`} value={form.origin_country} onChange={(v) => setForm((f) => ({ ...f, origin_country: v }))} />
        <Field label="Отримувач (порожньо — як у збірнику)" value={form.consignee} onChange={(v) => setForm((f) => ({ ...f, consignee: v }))} />
        {dirty ? (
          <button className="btn" disabled={saving} onClick={() => void save()} style={{ alignSelf: "flex-start" }}>
            {saving ? "Зберігаю…" : "Зберегти"}
          </button>
        ) : null}
      </Section>

      <Section title="Сторони">
        {PARTY_SLOTS.map((s) => {
          const p = detail.parties.find((x) => x.role === s.role);
          return (
            <div key={s.role} style={{ fontSize: 13 }}>
              <span style={{ color: "var(--muted)" }}>{s.label}: </span>
              {p?.company_name || "—"}
            </div>
          );
        })}
      </Section>

      <Section title="Дії">
        <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => router.push(`/workspaces/${fclId}/instruction?lotId=${l.id}`)}>
          Інструкція постачальнику
        </button>
      </Section>
    </>
  );
}
