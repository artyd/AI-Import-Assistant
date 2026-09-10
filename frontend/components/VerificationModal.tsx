"use client";

import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { FileExtraction } from "@/lib/types";
import { IconSpinner } from "./icons";

/**
 * Batch field-verification screen (plan Q9/Q17/Q29). Shows the fields extracted
 * from every document; the declarant confirms/corrects the verdict-driving ones.
 * Fields the product is unsure about (low confidence, or an unreadable scan) are
 * highlighted so attention goes exactly where it's needed — the rest is editable
 * but need not be touched.
 */

type FieldKind = "text" | "num";
const KEY_FIELDS: { key: string; label: string; kind: FieldKind }[] = [
  { key: "doc_type", label: "Тип документа", kind: "text" },
  { key: "invoice_number", label: "№ інвойсу", kind: "text" },
  { key: "po_number", label: "№ замовлення (PO)", kind: "text" },
  { key: "contract_number", label: "№ контракту", kind: "text" },
  { key: "total_value", label: "Сума", kind: "num" },
  { key: "currency", label: "Валюта", kind: "text" },
  { key: "net_weight_kg", label: "Вага нетто, кг", kind: "num" },
  { key: "gross_weight_kg", label: "Вага брутто, кг", kind: "num" },
  { key: "packages_count", label: "Місць", kind: "num" },
  { key: "hs_code", label: "УКТ ЗЕД", kind: "text" },
  { key: "country_of_origin", label: "Країна походження", kind: "text" },
  { key: "incoterm", label: "Incoterms", kind: "text" },
  { key: "manufacturer", label: "Виробник", kind: "text" },
  { key: "registration_number", label: "Реєстраційний номер", kind: "text" },
];

function asString(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

export function VerificationModal({
  workspaceId,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [items, setItems] = useState<FileExtraction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Local edits: fileId → { field → string }.
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    api<{ extractions: FileExtraction[] }>(`/api/workspaces/${workspaceId}/extractions`)
      .then((r) => {
        setItems(r.extractions);
        const seed: Record<string, Record<string, string>> = {};
        for (const it of r.extractions) {
          seed[it.file_id] = Object.fromEntries(
            KEY_FIELDS.map((f) => [f.key, asString(it.fields?.[f.key])]),
          );
        }
        setEdits(seed);
      })
      .catch(() => setError("Не вдалося завантажити витягнуті поля."));
  }, [workspaceId]);

  const setField = (fileId: string, key: string, value: string) =>
    setEdits((e) => ({ ...e, [fileId]: { ...e[fileId], [key]: value } }));

  const save = async (it: FileExtraction) => {
    setSavingId(it.file_id);
    setError(null);
    try {
      const row = edits[it.file_id] ?? {};
      const fields: Record<string, unknown> = {};
      for (const f of KEY_FIELDS) {
        const raw = (row[f.key] ?? "").trim();
        if (raw === "") continue;
        fields[f.key] = f.kind === "num" ? Number(raw.replace(",", ".")) : raw;
      }
      // Confirm the flagged fields plus anything the user typed a value into.
      const confirmed = Array.from(new Set([...it.needs_review, ...Object.keys(fields)]));
      await api(`/api/workspaces/${workspaceId}/files/${it.file_id}/extraction`, {
        method: "PATCH",
        body: { fields, confirmed },
      });
      setSavedIds((s) => new Set(s).add(it.file_id));
      onSaved?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "Не вдалося зберегти.");
    } finally {
      setSavingId(null);
    }
  };

  const pending = useMemo(
    () => (items ? items.filter((i) => i.needs_review.length > 0 && !savedIds.has(i.file_id)).length : 0),
    [items, savedIds],
  );

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "grid", placeItems: "center", zIndex: 100, padding: 20 }}
    >
      <div
        className="m-enter"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 720, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "var(--radius)", boxShadow: "var(--shadow)", padding: 18, display: "flex", flexDirection: "column", gap: 12 }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontWeight: 600, fontFamily: "var(--font-display)" }}>
            Перевірка витягнутих полів
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Закрити">✕</button>
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          Підтвердьте або виправте ключові поля перед аналізом. Жовтим підсвічено те,
          у чому система не впевнена — саме це варто перевірити.
          {pending > 0 ? ` Потребують уваги: ${pending}.` : ""}
        </div>

        {error && <div style={{ color: "var(--err)", fontSize: 13 }}>{error}</div>}

        {items === null ? (
          <div style={{ fontSize: 13, color: "var(--muted)" }}>Завантаження…</div>
        ) : items.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--muted)" }}>Немає документів для перевірки.</div>
        ) : (
          items.map((it) => {
            const needs = new Set(it.needs_review);
            const unreadable = it.extraction_status === "unreadable";
            const saved = savedIds.has(it.file_id);
            return (
              <div
                key={it.file_id}
                style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{it.file_name}</span>
                  {unreadable && (
                    <span style={{ fontSize: 11, fontWeight: 600, color: "var(--err)", background: "var(--hover)", padding: "2px 7px", borderRadius: 999 }}>
                      не прочитано — введіть вручну
                    </span>
                  )}
                  {saved || it.verified ? (
                    <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ok)" }}>підтверджено ✓</span>
                  ) : needs.size > 0 ? (
                    <span style={{ fontSize: 11, fontWeight: 600, color: "var(--warn)" }}>перевірте {needs.size}</span>
                  ) : null}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {KEY_FIELDS.map((f) => {
                    const flagged = needs.has(f.key);
                    return (
                      <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <span style={{ fontSize: 11, color: flagged ? "var(--warn)" : "var(--muted)" }}>
                          {f.label}{flagged ? " ⚠" : ""}
                        </span>
                        <input
                          className="input"
                          value={edits[it.file_id]?.[f.key] ?? ""}
                          onChange={(e) => setField(it.file_id, f.key, e.target.value)}
                          style={flagged ? { borderColor: "var(--warn)" } : undefined}
                        />
                      </label>
                    );
                  })}
                </div>

                <button
                  className="btn btn-primary"
                  onClick={() => save(it)}
                  disabled={savingId === it.file_id}
                  style={{ alignSelf: "flex-start" }}
                >
                  {savingId === it.file_id ? <IconSpinner size={15} /> : null} Підтвердити поля
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
