"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { IconSpinner } from "./icons";

// Mirrors the backend INSTRUCTION_SECTIONS. Prototype: user toggles sections,
// generates a draft, edits it, previews, then copies/downloads. Real sending
// (email) is a later phase — the "send" action is a stub for now.
const SECTIONS: { key: string; label: string }[] = [
  { key: "documents", label: "Перелік обовʼязкових документів" },
  { key: "invoice_packing", label: "Вимоги до інвойсу та пакувального листа" },
  { key: "marking", label: "Маркування, палети, фото" },
  { key: "certificates", label: "Вимоги до сертифікатів" },
  { key: "timelines", label: "Орієнтовні терміни" },
];

export function InstructionModal({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>(
    Object.fromEntries(SECTIONS.map((s) => [s.key, true]))
  );
  const [recipient, setRecipient] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const toggle = (key: string) =>
    setSelected((s) => ({ ...s, [key]: !s[key] }));

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const sections = SECTIONS.map((s) => s.key).filter((k) => selected[k]);
      const r = await api<{ instruction: string }>(
        `/api/workspaces/${workspaceId}/supplier-instruction`,
        { method: "POST", body: { sections } }
      );
      setBody(r.instruction);
    } catch (err) {
      if (err instanceof ApiError && err.code === "missing_context") {
        setError(
          "Бракує даних постачання — заповніть параметри (категорія, країна, вхідний Incoterms, транспорт) і сторону «Від кого» перед генерацією."
        );
      } else {
        setError("Не вдалося згенерувати інструкцію.");
      }
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Не вдалося скопіювати.");
    }
  };

  const download = () => {
    const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "instruction.md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "grid", placeItems: "center", zIndex: 100, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 620, maxWidth: "100%", maxHeight: "88vh", overflowY: "auto", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "var(--radius)", boxShadow: "var(--shadow)", padding: 18, display: "flex", flexDirection: "column", gap: 12 }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontWeight: 600, fontFamily: "var(--font-display)" }}>
            Конструктор інструкції постачальнику
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Закрити">✕</button>
        </div>

        {/* Recipient (prototype field) */}
        <label style={{ fontSize: 12, color: "var(--muted)" }}>Отримувач (email)</label>
        <input
          className="input"
          placeholder="supplier@example.com"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
        />

        {/* Section toggles */}
        <div style={{ fontWeight: 600, fontSize: 13 }}>Розділи листа</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {SECTIONS.map((s) => (
            <label key={s.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={!!selected[s.key]} onChange={() => toggle(s.key)} />
              {s.label}
            </label>
          ))}
        </div>

        <button className="btn btn-primary" onClick={generate} disabled={busy}>
          {busy ? <IconSpinner size={15} /> : null} Згенерувати чернетку
        </button>

        {error && <div style={{ color: "var(--err)", fontSize: 13 }}>{error}</div>}

        {/* Editable body + live preview */}
        {body && (
          <>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Текст листа (редагується)</div>
            <textarea
              className="input"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              style={{ minHeight: 200, fontFamily: "var(--font-mono)", fontSize: 12, resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn" onClick={copy}>{copied ? "Скопійовано ✓" : "Скопіювати"}</button>
              <button className="btn" onClick={download}>Завантажити .md</button>
              <button
                className="btn btn-primary"
                title="Прототип: реальна відправка зʼявиться пізніше (SMTP)."
                onClick={() => {
                  copy();
                  setError(null);
                }}
              >
                Відправити{recipient ? ` → ${recipient}` : ""} (прототип)
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>
              «Відправити» поки що лише копіює текст — реальна відправка буде додана згодом.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
