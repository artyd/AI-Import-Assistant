"use client";

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, downloadBlob } from "@/lib/api";
import type {
  ChecklistItem,
  Discrepancy,
  Party,
  PartyRole,
  PartySuggestion,
  Risk,
  UserLite,
  Workspace,
  WorkspaceStatus,
} from "@/lib/types";
import {
  COUNTRIES,
  INCOTERMS_2020,
  searchCountries,
  transportOptionsFor,
  type Country,
} from "@/lib/shipmentOptions";
import { Combobox } from "./ui/Combobox";
import { InstructionModal } from "./InstructionModal";
import { IconDownload, IconSpinner } from "./icons";

// Three fixed party slots. "Через кого" (intermediary) is optional.
const PARTY_SLOTS: { role: PartyRole; label: string; hint: string; optional?: boolean }[] = [
  { role: "sender", label: "Від кого", hint: "Постачальник / відправник" },
  { role: "intermediary", label: "Через кого", hint: "Посередник / агент", optional: true },
  { role: "recipient", label: "Кому", hint: "Одержувач / покупець" },
];

const countryOptions = COUNTRIES.map((c: Country) => ({ value: c.uk, label: c.uk }));
const countrySearch = (q: string) => searchCountries(q).map((c) => ({ value: c.uk, label: c.uk }));

const STATUS_OPTIONS: { value: WorkspaceStatus; label: string }[] = [
  { value: "draft", label: "Чернетка" },
  { value: "active", label: "Активна" },
  { value: "docs_in_progress", label: "Документи в роботі" },
  { value: "docs_complete", label: "Документи повні" },
  { value: "customs_ready", label: "Готово до митниці" },
  { value: "done", label: "Готово" },
];

const RISK_CLS: Record<Risk["severity"], string> = {
  error: "var(--err)",
  warning: "var(--warn)",
  info: "var(--muted)",
};

const CHECK_LABEL: Record<ChecklistItem["status"], string> = {
  verified: "підтверджено",
  received: "отримано",
  missing: "бракує",
};
const CHECK_CLS: Record<ChecklistItem["status"], string> = {
  verified: "var(--ok)",
  received: "var(--warn)",
  missing: "var(--err)",
};

type Result =
  | { kind: "checklist"; items: ChecklistItem[]; status: string }
  | { kind: "discrepancies"; items: Discrepancy[] }
  | { kind: "text"; title: string; body: string }
  | { kind: "error"; body: string };

export function ShipmentPanel({
  workspaceId,
  workspace,
  onPatch,
}: {
  workspaceId: string;
  workspace: Workspace;
  onPatch: (partial: Partial<Workspace>) => void;
}) {
  const router = useRouter();
  const [users, setUsers] = useState<UserLite[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [risks, setRisks] = useState<Risk[] | null>(null);
  const [instructionOpen, setInstructionOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [suggestedContractType, setSuggestedContractType] = useState<
    "bilateral" | "trilateral" | null
  >(null);

  // Intake form (local, seeded from workspace).
  const [form, setForm] = useState({
    contract_type: workspace.contract_type ?? "",
    product_category: workspace.product_category ?? "",
    incoterm_in: workspace.incoterm_in ?? workspace.incoterm ?? "",
    incoterm_out: workspace.incoterm_out ?? "",
    transport_mode: workspace.transport_mode ?? "",
    origin_country: workspace.origin_country ?? "",
    destination_country: workspace.destination_country ?? "",
  });

  useEffect(() => {
    setForm({
      contract_type: workspace.contract_type ?? "",
      product_category: workspace.product_category ?? "",
      incoterm_in: workspace.incoterm_in ?? workspace.incoterm ?? "",
      incoterm_out: workspace.incoterm_out ?? "",
      transport_mode: workspace.transport_mode ?? "",
      origin_country: workspace.origin_country ?? "",
      destination_country: workspace.destination_country ?? "",
    });
  }, [workspace.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api<{ users: UserLite[] }>("/api/users")
      .then((r) => setUsers(r.users))
      .catch(() => setUsers([]));
    api<{ parties: Party[] }>(`/api/workspaces/${workspaceId}/parties`)
      // Normalise any legacy role labels into the three fixed slots on load.
      .then((r) => setParties(r.parties.map((p) => ({ ...p, role: canonRole(p.role) }))))
      .catch(() => setParties([]));
    // Proactively surface current/upcoming problems on open.
    api<{ risks: Risk[] }>(`/api/workspaces/${workspaceId}/risks`)
      .then((r) => setRisks(r.risks))
      .catch(() => setRisks(null));
  }, [workspaceId]);

  const reloadRisks = () =>
    run("risks", async () => {
      const r = await api<{ risks: Risk[] }>(`/api/workspaces/${workspaceId}/risks`);
      setRisks(r.risks);
    });

  const run = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      setBusy(key);
      try {
        await fn();
      } catch (err) {
        const msg = err instanceof ApiError ? err.code : "Помилка запиту";
        setResult({ kind: "error", body: msg });
      } finally {
        setBusy(null);
      }
    },
    []
  );

  const saveIntake = () =>
    run("intake", async () => {
      const body: Record<string, string | null> = {};
      body.contract_type = form.contract_type || null;
      body.product_category = form.product_category || null;
      body.incoterm_in = form.incoterm_in || null;
      body.incoterm_out = form.incoterm_out || null;
      body.transport_mode = form.transport_mode || null;
      body.origin_country = form.origin_country || null;
      body.destination_country = form.destination_country || null;
      const res = await api<{ workspace: Workspace }>(
        `/api/workspaces/${workspaceId}/intake`,
        { method: "PATCH", body }
      );
      onPatch(res.workspace);
    });

  // Incoming Incoterm drives transport validity (sea-only terms restrict
  // transport to sea/inland waterway).
  const setIncotermIn = (incoterm_in: string) =>
    setForm((f) => {
      const allowed = transportOptionsFor(incoterm_in).map((m) => m.value);
      const transport_mode = allowed.includes(f.transport_mode) ? f.transport_mode : "";
      return { ...f, incoterm_in, transport_mode };
    });

  const setStatus = (status: WorkspaceStatus) =>
    run("status", async () => {
      await api(`/api/workspaces/${workspaceId}/status`, {
        method: "PATCH",
        body: { status },
      });
      onPatch({ status });
    });

  // Assigning a responsible user is what lets the daily reminder job fire.
  const setResponsible = (responsible_user_id: string | null) =>
    run("responsible", async () => {
      const res = await api<{ workspace: Workspace }>(
        `/api/workspaces/${workspaceId}`,
        { method: "PATCH", body: { responsible_user_id } }
      );
      onPatch(res.workspace);
    });

  const saveParties = () =>
    run("parties", async () => {
      const res = await api<{ parties: Party[]; warnings: string[] }>(
        `/api/workspaces/${workspaceId}/parties`,
        { method: "POST", body: { parties: parties.filter((p) => p.company_name.trim()) } }
      );
      setParties(res.parties);
      setResult({
        kind: "text",
        title: "Сторони збережено",
        body: res.warnings.length ? `Застереження:\n• ${res.warnings.join("\n• ")}` : "Готово.",
      });
    });

  // Autofill parties + Incoterms from document extractions (suggestions,
  // user-editable). Places at most one company into each of the three slots.
  const autofillParties = () =>
    run("suggest", async () => {
      const res = await api<{
        suggestions: PartySuggestion[];
        suggested_contract_type: "bilateral" | "trilateral" | null;
        suggested_incoterm_in: string | null;
        suggested_incoterm_out: string | null;
      }>(`/api/workspaces/${workspaceId}/parties/suggest`, { method: "POST", body: {} });
      setSuggestedContractType(res.suggested_contract_type);

      setParties((cur) => {
        const next = [...cur];
        for (const role of ["sender", "intermediary", "recipient"] as PartyRole[]) {
          if (next.some((p) => p.role === role && p.company_name.trim())) continue;
          const pick = res.suggestions.find((s) => canonRole(s.role) === role && s.company_name.trim());
          if (!pick) continue;
          const idx = next.findIndex((p) => p.role === role);
          const party: Party = {
            role,
            company_name: pick.company_name,
            country: pick.country,
            contact_info: { source: "auto", source_files: pick.source_files },
          };
          if (idx >= 0) next[idx] = party;
          else next.push(party);
        }
        return next;
      });

      // Apply Incoterm suggestions into the intake form (user can still edit).
      if (res.suggested_incoterm_in || res.suggested_incoterm_out) {
        setForm((f) => ({
          ...f,
          incoterm_in: res.suggested_incoterm_in ?? f.incoterm_in,
          incoterm_out: res.suggested_incoterm_out ?? f.incoterm_out,
        }));
      }

      setResult({
        kind: "text",
        title: "Автозаповнення з документів",
        body: res.suggestions.length
          ? `Знайдено сторін: ${res.suggestions.length}.` +
            (res.suggested_incoterm_in ? ` Incoterms (вх.): ${res.suggested_incoterm_in}.` : "") +
            (res.suggested_incoterm_out ? ` Incoterms (вих.): ${res.suggested_incoterm_out}.` : "") +
            " Перевірте та збережіть."
          : "Сторін у документах не виявлено.",
      });
    });

  const duplicate = () =>
    run("duplicate", async () => {
      const res = await api<{ workspace: Workspace }>(
        `/api/workspaces/${workspaceId}/duplicate`,
        { method: "POST", body: {} }
      );
      router.push(`/workspaces/${res.workspace.id}`);
    });

  const del = () =>
    run("delete", async () => {
      const ok = window.confirm(
        `Видалити поставку №${workspace.number ?? "—"}?\n\n` +
          "Буде видалено всі файли, папки та чати цієї поставки. Дію не можна скасувати."
      );
      if (!ok) return;
      await api(`/api/workspaces/${workspaceId}`, { method: "DELETE" });
      router.push("/workspaces");
    });

  const loadChecklist = () =>
    run("checklist", async () => {
      const r = await api<{ items: ChecklistItem[]; status: string }>(
        `/api/workspaces/${workspaceId}/checklist`
      );
      setResult({ kind: "checklist", items: r.items, status: r.status });
      onPatch({ status: r.status as WorkspaceStatus });
    });

  const loadDiscrepancies = () =>
    run("discrepancies", async () => {
      const r = await api<{ discrepancies: Discrepancy[] }>(
        `/api/workspaces/${workspaceId}/discrepancies`
      );
      setResult({ kind: "discrepancies", items: r.discrepancies });
    });

  const genReport = () =>
    run("report", async () => {
      const r = await api<{ html: string }>(`/api/workspaces/${workspaceId}/report`, {
        method: "POST",
        body: {},
      });
      const url = URL.createObjectURL(new Blob([r.html], { type: "text/html" }));
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });

  const exportZip = () =>
    run("export", async () => {
      await downloadBlob(`/api/workspaces/${workspaceId}/export`, `${workspace.number ?? "export"}.zip`);
    });

  const slotParty = (role: PartyRole): Party | undefined =>
    parties.find((p) => p.role === role);

  const setSlotParty = (role: PartyRole, patch: Partial<Party>) =>
    setParties((cur) => {
      const idx = cur.findIndex((p) => p.role === role);
      if (idx < 0) {
        return [...cur, { role, company_name: "", country: "", contact_info: { source: "manual" }, ...patch }];
      }
      return cur.map((x, i) => {
        if (i !== idx) return x;
        // Editing an auto-filled party marks it manual so provenance stays truthful.
        const contact_info =
          x.contact_info?.source === "auto"
            ? { ...x.contact_info, source: "manual" as const }
            : x.contact_info;
        return { ...x, ...patch, contact_info };
      });
    });

  const clearSlotParty = (role: PartyRole) =>
    setParties((cur) => cur.filter((p) => p.role !== role));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Status */}
        <Section title="Статус">
          <select
            className="input"
            value={workspace.status}
            onChange={(e) => setStatus(e.target.value as WorkspaceStatus)}
            disabled={busy === "status"}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            Заповненість даних: {workspace.intake_complete ? "повна" : "неповна"}
          </div>
        </Section>

        {/* Intake */}
        <Section title="Параметри постачання">
          <label style={lbl}>Тип контракту</label>
          <select
            className="input"
            value={form.contract_type}
            onChange={(e) => setForm((f) => ({ ...f, contract_type: e.target.value }))}
          >
            <option value="">—</option>
            <option value="bilateral">Двосторонній</option>
            <option value="trilateral">Тристоронній</option>
          </select>
          {suggestedContractType && suggestedContractType !== form.contract_type && (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              Запропоновано за документами:{" "}
              {suggestedContractType === "trilateral" ? "тристоронній" : "двосторонній"}{" "}
              <button
                type="button"
                className="btn"
                style={{ height: 24, padding: "0 8px", fontSize: 12 }}
                onClick={() => setForm((f) => ({ ...f, contract_type: suggestedContractType }))}
              >
                Застосувати
              </button>
            </div>
          )}

          <Field label="Категорія товару" value={form.product_category} onChange={(v) => setForm((f) => ({ ...f, product_category: v }))} />

          <label style={lbl}>Incoterms — вхідний (закупівля: постачальник → ми)</label>
          <select className="input" value={form.incoterm_in} onChange={(e) => setIncotermIn(e.target.value)}>
            <option value="">—</option>
            {INCOTERMS_2020.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <label style={lbl}>Incoterms — вихідний (продаж: ми → покупець)</label>
          <select
            className="input"
            value={form.incoterm_out}
            onChange={(e) => setForm((f) => ({ ...f, incoterm_out: e.target.value }))}
          >
            <option value="">—</option>
            {INCOTERMS_2020.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            «Автозаповнення з документів» нижче визначає обидва Incoterms за файлами.
          </div>

          <label style={lbl}>Транспорт</label>
          <select
            className="input"
            value={form.transport_mode}
            onChange={(e) => setForm((f) => ({ ...f, transport_mode: e.target.value }))}
          >
            <option value="">—</option>
            {transportOptionsFor(form.incoterm_in).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {form.incoterm_in && transportOptionsFor(form.incoterm_in).length < 8 && (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              Цей Incoterm обмежує транспорт до морського / внутрішніх водних шляхів.
            </div>
          )}

          <label style={lbl}>Країна походження</label>
          <Combobox
            value={form.origin_country}
            onChange={(v) => setForm((f) => ({ ...f, origin_country: v }))}
            options={countryOptions}
            onSearch={countrySearch}
            placeholder="Почніть вводити…"
          />

          <label style={lbl}>Країна призначення</label>
          <Combobox
            value={form.destination_country}
            onChange={(v) => setForm((f) => ({ ...f, destination_country: v }))}
            options={countryOptions}
            onSearch={countrySearch}
            placeholder="Почніть вводити…"
          />

          <button className="btn btn-primary" onClick={saveIntake} disabled={busy === "intake"}>
            {busy === "intake" ? <IconSpinner size={15} /> : null} Зберегти параметри
          </button>
        </Section>

        {/* Responsible — enables daily reminders */}
        <Section title="Відповідальний">
          <select
            className="input"
            value={workspace.responsible_user_id ?? ""}
            onChange={(e) => setResponsible(e.target.value || null)}
            disabled={busy === "responsible"}
          >
            <option value="">— не призначено —</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.email}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            Отримує щоденні нагадування про незавершені документи.
          </div>
        </Section>

        {/* Parties — three fixed slots: Від кого / Через кого / Кому */}
        <Section title="Сторони">
          {PARTY_SLOTS.map((slot) => {
            const p = slotParty(slot.role);
            const filled = Boolean(p && p.company_name.trim());
            // The optional intermediary slot only renders once it exists or is trilateral.
            if (slot.optional && !p && form.contract_type !== "trilateral") {
              return (
                <button
                  key={slot.role}
                  className="btn"
                  onClick={() => setSlotParty(slot.role, {})}
                  style={{ height: 30 }}
                >
                  + Додати «{slot.label}» (посередник)
                </button>
              );
            }
            return (
              <div key={slot.role} style={{ display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>
                    {slot.label}
                    <span style={{ color: "var(--muted)", fontWeight: 400 }}> — {slot.hint}</span>
                  </span>
                  {p?.contact_info?.source === "auto" && (
                    <span style={{ fontSize: 11, fontWeight: 600, color: "var(--warn)", background: "var(--hover)", padding: "2px 7px", borderRadius: 999, whiteSpace: "nowrap" }}>
                      авто
                    </span>
                  )}
                </div>
                <input
                  className="input"
                  placeholder="Назва компанії"
                  value={p?.company_name ?? ""}
                  onChange={(e) => setSlotParty(slot.role, { company_name: e.target.value })}
                />
                <Combobox
                  value={p?.country ?? ""}
                  onChange={(v) => setSlotParty(slot.role, { country: v })}
                  options={countryOptions}
                  onSearch={countrySearch}
                  placeholder="Країна"
                />
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)" }}>
                  <input type="checkbox" checked={!!p?.is_internal} onChange={(e) => setSlotParty(slot.role, { is_internal: e.target.checked })} />
                  Наша компанія (AGroup95 / PrimeForce)
                </label>
                {slot.optional && (
                  <button className="btn" onClick={() => clearSlotParty(slot.role)} style={{ height: 30 }}>
                    Прибрати посередника
                  </button>
                )}
                {!slot.optional && filled && (
                  <button className="btn" onClick={() => clearSlotParty(slot.role)} style={{ height: 30 }}>
                    Очистити
                  </button>
                )}
              </div>
            );
          })}
          <button className="btn" onClick={autofillParties} disabled={busy === "suggest"}>
            {busy === "suggest" ? <IconSpinner size={15} /> : null} Автозаповнення з документів
          </button>
          <button className="btn btn-primary" onClick={saveParties} disabled={busy === "parties"}>
            Зберегти сторони
          </button>
        </Section>

        {/* Risks — proactive current + upcoming problems */}
        <Section title="Ризики">
          {risks === null ? (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Аналіз ризиків…</div>
          ) : risks.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--ok)" }}>Ризиків не виявлено.</div>
          ) : (
            risks.map((r, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2, borderLeft: `3px solid ${RISK_CLS[r.severity]}`, paddingLeft: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: RISK_CLS[r.severity] }}>{r.title}</span>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>{r.detail}</span>
              </div>
            ))
          )}
          <button className="btn" onClick={reloadRisks} disabled={busy === "risks"} style={{ height: 30 }}>
            {busy === "risks" ? <IconSpinner size={15} /> : null} Оновити ризики
          </button>
        </Section>

        {/* Actions */}
        <Section title="Дії">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button className="btn" onClick={loadChecklist} disabled={busy === "checklist"}>Комплектність</button>
            <button className="btn" onClick={loadDiscrepancies} disabled={busy === "discrepancies"}>Розбіжності</button>
            <button className="btn" onClick={() => setInstructionOpen(true)}>Інструкція</button>
            <button className="btn" onClick={exportZip} disabled={busy === "export"}>Архів (.zip)</button>
          </div>
          <button className="btn btn-primary" onClick={genReport} disabled={busy === "report"}>
            {busy === "report" ? <IconSpinner size={15} /> : <IconDownload size={16} />} Експорт звіту (HTML)
          </button>
        </Section>

        {/* Management */}
        <Section title="Керування">
          <button className="btn" onClick={duplicate} disabled={busy === "duplicate"}>
            {busy === "duplicate" ? <IconSpinner size={15} /> : null} Дублювати поставку
          </button>
          <button
            className="btn"
            onClick={del}
            disabled={busy === "delete"}
            style={{ color: "var(--err)", borderColor: "var(--err)" }}
          >
            Видалити поставку
          </button>
        </Section>

        {result && <ResultView result={result} />}
      </div>
      {instructionOpen && (
        <InstructionModal workspaceId={workspaceId} onClose={() => setInstructionOpen(false)} />
      )}
    </div>
  );
}

function ResultView({ result }: { result: Result }) {
  return (
    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      {result.kind === "checklist" && (
        <>
          <SectionTitle>Комплектність · {result.status}</SectionTitle>
          {result.items.length === 0 ? (
            <Muted>Чек-лист порожній — заповніть параметри постачання.</Muted>
          ) : (
            result.items.map((i) => (
              <div key={i.requirement_key} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span>{i.requirement_key}</span>
                <span style={{ color: CHECK_CLS[i.status], fontWeight: 600 }}>{CHECK_LABEL[i.status]}</span>
              </div>
            ))
          )}
        </>
      )}
      {result.kind === "discrepancies" && (
        <>
          <SectionTitle>Розбіжності</SectionTitle>
          {result.items.length === 0 ? (
            <Muted>Розбіжностей не виявлено.</Muted>
          ) : (
            result.items.map((d, i) => (
              <div key={i} style={{ fontSize: 13 }}>
                <span style={{ color: d.severity === "error" ? "var(--err)" : d.severity === "warning" ? "var(--warn)" : "var(--muted)", fontWeight: 600 }}>
                  {d.field}
                </span>
                <div style={{ color: "var(--muted)", fontSize: 12 }}>{d.expected} → {d.actual}</div>
              </div>
            ))
          )}
        </>
      )}
      {result.kind === "text" && (
        <>
          <SectionTitle>{result.title}</SectionTitle>
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-sans)", fontSize: 13, margin: 0 }}>{result.body}</pre>
        </>
      )}
      {result.kind === "error" && <div style={{ color: "var(--err)", fontSize: 13 }}>{result.body}</div>}
    </div>
  );
}

const lbl: CSSProperties = { fontSize: 12, color: "var(--muted)" };

// Bucket any legacy/free-text role label into one of the three fixed slots
// (mirrors the backend canonicalRole). Unrecognised → recipient as a safe default.
const ROLE_SYNONYMS: Record<PartyRole, string[]> = {
  sender: ["sender", "від кого", "постачальник", "поставщик", "продавець", "продавец", "supplier", "seller", "shipper", "вантажовідправник", "експортер", "exporter"],
  intermediary: ["intermediary", "через кого", "посередник", "посредник", "агент", "agent", "trader", "брокер"],
  recipient: ["recipient", "кому", "покупець", "покупатель", "buyer", "вантажоодержувач", "consignee", "отримувач", "імпортер", "importer", "our_company", "наша компанія"],
};
function canonRole(role: string): PartyRole {
  const r = role.trim().toLowerCase();
  for (const slot of ["sender", "intermediary", "recipient"] as PartyRole[]) {
    if (slot === r || ROLE_SYNONYMS[slot].includes(r)) return slot;
  }
  return "recipient";
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <>
      <label style={lbl}>{label}</label>
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} />
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionTitle>{title}</SectionTitle>
      {children}
    </div>
  );
}
function SectionTitle({ children }: { children: ReactNode }) {
  return <div style={{ fontWeight: 600, fontSize: 13 }}>{children}</div>;
}
function Muted({ children }: { children: ReactNode }) {
  return <div style={{ color: "var(--muted)", fontSize: 13 }}>{children}</div>;
}
