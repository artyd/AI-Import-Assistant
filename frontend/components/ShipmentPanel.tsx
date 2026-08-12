"use client";

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { api, ApiError, downloadBlob } from "@/lib/api";
import type {
  ChecklistItem,
  Discrepancy,
  Party,
  PartyRole,
  UserLite,
  Workspace,
  WorkspaceStatus,
} from "@/lib/types";
import { IconDownload, IconSpinner } from "./icons";

const STATUS_OPTIONS: { value: WorkspaceStatus; label: string }[] = [
  { value: "draft", label: "Чернетка" },
  { value: "active", label: "Активна" },
  { value: "docs_in_progress", label: "Документи в роботі" },
  { value: "docs_complete", label: "Документи повні" },
  { value: "customs_ready", label: "Готово до митниці" },
  { value: "done", label: "Готово" },
];

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
  const [users, setUsers] = useState<UserLite[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  // Intake form (local, seeded from workspace).
  const [form, setForm] = useState({
    contract_type: workspace.contract_type ?? "",
    product_category: workspace.product_category ?? "",
    incoterm: workspace.incoterm ?? "",
    transport_mode: workspace.transport_mode ?? "",
    origin_country: workspace.origin_country ?? "",
  });

  useEffect(() => {
    setForm({
      contract_type: workspace.contract_type ?? "",
      product_category: workspace.product_category ?? "",
      incoterm: workspace.incoterm ?? "",
      transport_mode: workspace.transport_mode ?? "",
      origin_country: workspace.origin_country ?? "",
    });
  }, [workspace.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api<{ users: UserLite[] }>("/api/users")
      .then((r) => setUsers(r.users))
      .catch(() => setUsers([]));
    api<{ parties: Party[] }>(`/api/workspaces/${workspaceId}/parties`)
      .then((r) => setParties(r.parties))
      .catch(() => setParties([]));
  }, [workspaceId]);

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
      body.incoterm = form.incoterm || null;
      body.transport_mode = form.transport_mode || null;
      body.origin_country = form.origin_country || null;
      const res = await api<{ workspace: Workspace }>(
        `/api/workspaces/${workspaceId}/intake`,
        { method: "PATCH", body }
      );
      onPatch(res.workspace);
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

  const genInstruction = () =>
    run("instruction", async () => {
      try {
        const r = await api<{ instruction: string }>(
          `/api/workspaces/${workspaceId}/supplier-instruction`,
          { method: "POST", body: {} }
        );
        setResult({ kind: "text", title: "Інструкція постачальнику", body: r.instruction });
      } catch (err) {
        if (err instanceof ApiError && err.code === "missing_context") {
          const missing = (err as ApiError & { message?: string }).message;
          setResult({
            kind: "error",
            body: "Бракує даних постачання — заповніть параметри вище перед генерацією." + (missing ? ` (${missing})` : ""),
          });
          return;
        }
        throw err;
      }
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

  const addParty = () =>
    setParties((p) => [...p, { role: "supplier", company_name: "", country: "" }]);
  const updateParty = (i: number, patch: Partial<Party>) =>
    setParties((p) => p.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const removeParty = (i: number) => setParties((p) => p.filter((_, idx) => idx !== i));

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
          <Field label="Категорія товару" value={form.product_category} onChange={(v) => setForm((f) => ({ ...f, product_category: v }))} />
          <Field label="Incoterms" value={form.incoterm} onChange={(v) => setForm((f) => ({ ...f, incoterm: v }))} />
          <Field label="Транспорт" value={form.transport_mode} onChange={(v) => setForm((f) => ({ ...f, transport_mode: v }))} />
          <Field label="Країна походження" value={form.origin_country} onChange={(v) => setForm((f) => ({ ...f, origin_country: v }))} />
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

        {/* Parties */}
        <Section title="Сторони">
          {parties.map((p, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
              <select className="input" value={p.role} onChange={(e) => updateParty(i, { role: e.target.value as PartyRole })}>
                <option value="our_company">Наша компанія</option>
                <option value="supplier">Постачальник</option>
                <option value="intermediary">Посередник</option>
              </select>
              <input className="input" placeholder="Назва компанії" value={p.company_name} onChange={(e) => updateParty(i, { company_name: e.target.value })} />
              <input className="input" placeholder="Країна" value={p.country ?? ""} onChange={(e) => updateParty(i, { country: e.target.value })} />
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)" }}>
                <input type="checkbox" checked={!!p.is_internal} onChange={(e) => updateParty(i, { is_internal: e.target.checked })} />
                Внутрішня (AGroup95 / PrimeForce)
              </label>
              <button className="btn" onClick={() => removeParty(i)} style={{ height: 30 }}>Прибрати</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={addParty} style={{ flex: 1 }}>+ Сторона</button>
            <button className="btn btn-primary" onClick={saveParties} disabled={busy === "parties"} style={{ flex: 1 }}>Зберегти</button>
          </div>
        </Section>

        {/* Actions */}
        <Section title="Дії">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button className="btn" onClick={loadChecklist} disabled={busy === "checklist"}>Комплектність</button>
            <button className="btn" onClick={loadDiscrepancies} disabled={busy === "discrepancies"}>Розбіжності</button>
            <button className="btn" onClick={genInstruction} disabled={busy === "instruction"}>Інструкція</button>
            <button className="btn" onClick={genReport} disabled={busy === "report"}>HTML-звіт</button>
          </div>
          <button className="btn btn-primary" onClick={exportZip} disabled={busy === "export"}>
            <IconDownload size={16} /> Експорт архіву (.zip)
          </button>
        </Section>

        {result && <ResultView result={result} />}
      </div>
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
