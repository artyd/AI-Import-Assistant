"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { FclOverview, LotSummary } from "@/lib/types";
import { IconSpinner } from "../ui/icons";
import { LIGHT_COLOR, LOT_STATUS_LABEL, fclCounts, lotLight, unassignedLabel } from "@/lib/fcl/fcl";

/**
 * «Партії» tab of a Збірник (spec 006 #09): the FCL header (container, risks,
 * discrepancies), one row per lot with traffic lights, the «Без партії» hint and
 * lot management. Clicking a lot opens it in «Комплектність».
 */
export function LotsTab({
  fclId,
  overview,
  loading,
  reload,
  onOpenLot,
  onSortInbox,
  onRereadAll,
  notify,
}: {
  fclId: string;
  overview: FclOverview | null;
  loading: boolean;
  reload: () => Promise<void>;
  onOpenLot: (lotId: string) => void;
  onSortInbox: () => Promise<void>;
  /** Read every file of the збірник again and re-file it (spec 007). */
  onRereadAll?: () => Promise<void>;
  notify: (text: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>, fail: string) => {
    setBusy(key);
    try {
      await fn();
      await reload();
    } catch {
      notify(fail);
    } finally {
      setBusy(null);
    }
  };

  const createLot = () => {
    const name = (window.prompt("Назва партії (постачальник)") ?? "").trim();
    if (!name) return;
    void run("create", () => api(`/api/workspaces/${fclId}/lots`, { body: { name, supplier_name: name } }), "Не вдалося створити партію.");
  };
  const renameLot = (l: LotSummary) => {
    const name = (window.prompt("Назва партії", l.name) ?? "").trim();
    if (!name || name === l.name) return;
    void run(l.id, () => api(`/api/workspaces/${fclId}/lots/${l.id}`, { method: "PATCH", body: { name } }), "Не вдалося перейменувати партію.");
  };
  const setConsignee = (l: LotSummary) => {
    const next = window.prompt("Отримувач партії (порожньо — як у збірнику)", l.context.consignee ?? "");
    if (next === null) return;
    void run(l.id, () => api(`/api/workspaces/${fclId}/lots/${l.id}`, { method: "PATCH", body: { consignee: next.trim() || null } }), "Не вдалося зберегти отримувача.");
  };
  const deleteLot = (l: LotSummary) => {
    if (!window.confirm(`Видалити партію «${l.name}»?\n\nЇї файли повернуться в Інбокс.`)) return;
    void run(l.id, () => api(`/api/workspaces/${fclId}/lots/${l.id}`, { method: "DELETE" }), "Не вдалося видалити партію.");
  };

  if (!overview) {
    return (
      <div style={{ padding: 18, color: "var(--muted)", fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
        {loading ? <IconSpinner size={14} /> : null}
        {loading ? "Завантажую збірник…" : "Не вдалося завантажити збірник."}
      </div>
    );
  }

  const c = fclCounts(overview);
  const hint = unassignedLabel(overview.fcl.unassigned);
  return (
    <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12, overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>
          FCL {overview.fcl.containers.join(", ") || "— контейнер ще не прочитано"}
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 10, flexWrap: "wrap" }}>
          <span>{LOT_STATUS_LABEL[overview.fcl.derived_status]}</span>
          <span style={{ color: c.risksError ? "var(--err)" : undefined }}>● ризики {c.risksError + c.risksWarning}</span>
          <span style={{ color: c.confirmed ? "var(--err)" : undefined }}>● розбіжності 🔴{c.confirmed} 🟡{c.suspected}</span>
        </div>
      </div>

      {overview.lots.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
          Партій ще немає. Вони створюються автоматично, коли прочитано інвойс, контракт або пакувальний лист нового
          постачальника. Можна створити партію і вручну.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {overview.lots.map((l) => {
            const light = lotLight(l);
            return (
              <div
                key={l.id}
                style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: LIGHT_COLOR[light], flex: "none" }} />
                  <button
                    onClick={() => onOpenLot(l.id)}
                    title="Відкрити в «Комплектності»"
                    style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer", fontWeight: 600, fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {l.name}
                  </button>
                  {busy === l.id ? <IconSpinner size={12} /> : null}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <span>документи {l.completeness.done}/{l.completeness.total}</span>
                  <span>🔴{l.discrepancies.confirmed} 🟡{l.discrepancies.suspected}</span>
                  <span>ризики {l.risks.error + l.risks.warning}</span>
                  <span>{l.file_count} файл.</span>
                  <span>{LOT_STATUS_LABEL[l.derived_status]}</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  Отримувач: {l.consignee ?? "як у збірнику"}
                </div>
                <div style={{ display: "flex", gap: 10, fontSize: 12 }}>
                  <a onClick={() => renameLot(l)} style={{ cursor: "pointer", color: "var(--accent)" }}>Перейменувати</a>
                  <a onClick={() => setConsignee(l)} style={{ cursor: "pointer", color: "var(--accent)" }}>Отримувач</a>
                  <a onClick={() => deleteLot(l)} style={{ cursor: "pointer", color: "var(--err)" }}>Видалити</a>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {hint ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--warn)" }}>
          <span style={{ flex: 1 }}>{hint} — не входять у перевірки партій</span>
          <button className="btn" disabled={busy === "sort"} onClick={() => void run("sort", onSortInbox, "Не вдалося розкласти файли.")}>
            Розкласти
          </button>
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn" onClick={createLot} disabled={busy === "create"}>
          + Партія вручну
        </button>
        {onRereadAll && (
          <button
            className="btn"
            disabled={busy === "reread"}
            onClick={() => void run("reread", onRereadAll, "Не вдалося запустити перечитування.")}
            title="Штурман прочитає кожен файл повністю і розкладе: Постачальник / Товар, Митниця / Постачальник"
          >
            Перечитати і розкласти все
          </button>
        )}
      </div>
    </div>
  );
}
