"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, downloadBlob } from "@/lib/api";
import type { FclOverview, LotDetail } from "@/lib/types";
import { useLotDetail } from "@/lib/fcl/useFcl";
import { LOT_STATUS_LABEL, MATCH_LABEL, resolveScope } from "@/lib/fcl/fcl";
import { INCOTERMS_2020, TRANSPORT_MODES } from "@/lib/shipmentOptions";
import { ResultView, Section, Field, lbl } from "../shipment/parts";
import { CHECK_CLS, CHECK_LABEL, CONTRACT_TYPE_LABEL, PARTY_SLOTS, RISK_CLS } from "../shipment/labels";
import { IconSpinner } from "../ui/icons";

/**
 * «Комплектність» of a Збірник (spec 006 #09) with the scope switcher
 * «Весь FCL / Партія N». The FCL scope shows the container-wide checks; a lot is
 * shown like a shipment, with its own context.
 */
export function FclCompleteness({
  fclId,
  number,
  overview,
  version,
  reload,
  scope,
  onScope,
  notify,
}: {
  fclId: string;
  number: string;
  overview: FclOverview | null;
  version: number;
  reload: () => Promise<void>;
  scope: string;
  onScope: (s: string) => void;
  notify: (text: string) => void;
}) {
  const lots = overview?.lots ?? [];
  const current = resolveScope(scope, lots);
  const detail = useLotDetail(fclId, current === "fcl" ? null : current, version);

  if (!overview) {
    return (
      <div style={{ padding: 18, color: "var(--muted)", fontSize: 13 }}>
        <IconSpinner size={14} /> Завантажую…
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
        <FclScope fclId={fclId} number={number} overview={overview} reload={reload} notify={notify} />
      ) : detail ? (
        <LotScope fclId={fclId} detail={detail} reload={reload} notify={notify} />
      ) : (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>
          <IconSpinner size={14} /> Завантажую партію…
        </div>
      )}
    </div>
  );
}

function Status({ label }: { label: string }) {
  return <div style={{ fontSize: 13, fontWeight: 600 }}>Статус: {label}</div>;
}

function FclScope({
  fclId,
  number,
  overview,
  reload,
  notify,
}: {
  fclId: string;
  number: string;
  overview: FclOverview;
  reload: () => Promise<void>;
  notify: (text: string) => void;
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

  const docs = overview.checklist.filter((i) => i.stage === "docs");
  const customs = overview.checklist.filter((i) => i.stage === "customs");
  return (
    <>
      <Status label={LOT_STATUS_LABEL[f.derived_status]} />

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

      <Section title="Документи FCL">
        {[...docs, ...customs].map((i) => (
          <div key={i.requirement_key} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
            <span>
              {i.label}
              {i.stage === "customs" ? <span style={{ color: "var(--muted)" }}> · для митниці</span> : null}
            </span>
            <span style={{ color: CHECK_CLS[i.status], fontWeight: 600, flex: "none" }}>{CHECK_LABEL[i.status]}</span>
          </div>
        ))}
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

      <ResultView result={{ kind: "discrepancies", items: overview.all_discrepancies.map((d) => ({ ...d, expected: d.lot ? `${d.lot}: ${d.expected}` : d.expected })) }} />

      <Section title="Ризики">
        {overview.risks.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 13 }}>Ризиків не виявлено.</div>
        ) : (
          overview.risks.map((r) => (
            <div key={r.code} style={{ fontSize: 13, borderLeft: `3px solid ${RISK_CLS[r.severity]}`, paddingLeft: 8 }}>
              <b>{r.title}</b>
              {r.detail ? <div style={{ color: "var(--muted)", fontSize: 12 }}>{r.detail}</div> : null}
            </div>
          ))
        )}
      </Section>

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
}: {
  fclId: string;
  detail: LotDetail;
  reload: () => Promise<void>;
  notify: (text: string) => void;
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
  const auto = (k: string) => (l.context.auto_fields.includes(k) ? " · з документів" : "");

  return (
    <>
      <Status label={LOT_STATUS_LABEL[l.derived_status]} />
      <div style={{ fontSize: 12, color: "var(--muted)" }}>
        Постачальник: {l.supplier_name || "—"} · {l.file_count} файл. · партія {l.source === "auto" ? "створена автоматично" : "створена вручну"}
      </div>

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

      <ResultView result={{ kind: "checklist", items: detail.checklist, status: l.derived_status }} />
      <ResultView result={{ kind: "discrepancies", items: detail.discrepancies }} />

      <Section title="Ризики партії">
        {detail.risks.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 13 }}>Ризиків не виявлено.</div>
        ) : (
          detail.risks.map((r) => (
            <div key={r.code} style={{ fontSize: 13, borderLeft: `3px solid ${RISK_CLS[r.severity]}`, paddingLeft: 8 }}>
              <b>{r.title}</b>
              {r.detail ? <div style={{ color: "var(--muted)", fontSize: 12 }}>{r.detail}</div> : null}
            </div>
          ))
        )}
      </Section>

      <Section title="Дії">
        <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => router.push(`/workspaces/${fclId}/instruction?lotId=${l.id}`)}>
          Інструкція постачальнику
        </button>
      </Section>
    </>
  );
}
