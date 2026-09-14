"use client";

// «Налаштування AI» (BYOK) modal. Lets the user pick the engine that powers the
// consolidated-cargo analysis:
//   • builtin — the server's own Claude (tokens billed on our side)
//   • byok    — the customer's own provider key (OpenAI / Gemini / Claude / OpenRouter)
// The key is stored encrypted server-side and never sent back to the browser; the
// backend only returns a masked hint (keyMask). BYOK applies ONLY to the collector
// analysis — the main Штурман agent always runs on the built-in Claude.
//
// Wire: GET /api/ai-config, PUT /api/ai-config. Non-2xx errors carry { error }
// with codes byok_disabled | provider_required | key_required | invalid_request,
// all handled inline (no throws bubble out).

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { AiConfig, AiProvider } from "@/lib/types";
import { IconSpinner } from "./icons";

const PROVIDERS: { value: AiProvider; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "claude", label: "Claude" },
  { value: "openrouter", label: "OpenRouter" },
];

function isProvider(v: string | null): v is AiProvider {
  return v === "openai" || v === "gemini" || v === "claude" || v === "openrouter";
}

// Map the backend error code onto an inline Ukrainian message.
function messageForCode(code: string): string {
  switch (code) {
    case "byok_disabled":
      return "BYOK не увімкнено на цьому сервері (немає ключа шифрування).";
    case "provider_required":
      return "Оберіть провайдера.";
    case "key_required":
      return "Введіть ключ.";
    case "invalid_request":
      return "Некоректні дані. Перевірте вибір провайдера та ключ.";
    default:
      return "Не вдалося зберегти налаштування.";
  }
}

export function AiSettingsModal({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Form state.
  const [engine, setEngine] = useState<"builtin" | "byok">("builtin");
  const [provider, setProvider] = useState<AiProvider>("openai");
  const [key, setKey] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api<AiConfig>("/api/ai-config")
      .then((c) => {
        if (!alive) return;
        setConfig(c);
        setEngine(c.engine);
        if (isProvider(c.provider)) setProvider(c.provider);
      })
      .catch(() => {
        if (alive) setError("Не вдалося завантажити налаштування AI.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hasKey = config?.hasKey ?? false;
  const keyMask = config?.keyMask ?? null;
  // A key must be typed only when switching to BYOK and none is stored yet.
  const keyRequired = engine === "byok" && !hasKey;

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const body: {
        engine: "builtin" | "byok";
        provider?: AiProvider;
        key?: string;
      } = { engine };
      if (engine === "byok") {
        body.provider = provider;
        const k = key.trim();
        if (k !== "") body.key = k;
      }
      const next = await api<AiConfig>("/api/ai-config", { method: "PUT", body });
      setConfig(next);
      setEngine(next.engine);
      if (isProvider(next.provider)) setProvider(next.provider);
      setKey("");
      setSaved(true);
      // Brief confirmation, then close.
      setTimeout(() => onClose(), 750);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(messageForCode(code));
    } finally {
      setSaving(false);
    }
  };

  const canSave = !saving && !loading && (engine === "builtin" || !keyRequired || key.trim() !== "");

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "grid", placeItems: "center", zIndex: 120, padding: 20 }}
    >
      <div
        className="m-enter"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 520, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "var(--radius)", boxShadow: "var(--shadow)", padding: 18, display: "flex", flexDirection: "column", gap: 14 }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontWeight: 600, fontFamily: "var(--font-display)" }}>Налаштування AI</div>
          <button className="btn-icon" onClick={onClose} aria-label="Закрити">✕</button>
        </div>

        {loading ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--muted)", padding: "12px 0" }}>
            <IconSpinner size={16} /> Завантаження…
          </div>
        ) : (
          <>
            {/* Engine choice */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <EngineCard
                selected={engine === "builtin"}
                onSelect={() => setEngine("builtin")}
                title="Вбудований Claude"
                desc="Використовує сервер, оплата токенів на нашому боці."
              />
              <EngineCard
                selected={engine === "byok"}
                onSelect={() => setEngine("byok")}
                title="Власний ключ (BYOK)"
                desc="Аналіз збірного вантажу працює на вашому провайдері та ключі."
              />
            </div>

            {/* BYOK details */}
            {engine === "byok" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>Провайдер</span>
                  <select
                    className="input"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value as AiProvider)}
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>
                    Ключ API{keyRequired ? " *" : ""}
                  </span>
                  <input
                    className="input"
                    type="password"
                    autoComplete="off"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder={hasKey && keyMask ? keyMask : "sk-…"}
                  />
                  {hasKey && (
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>
                      Залиште порожнім, щоб не змінювати ключ.
                    </span>
                  )}
                </label>
              </div>
            )}

            <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5 }}>
              Ключ зберігається зашифрованим на сервері та ніколи не передається у
              браузер. BYOK застосовується лише до аналізу збірного вантажу —
              основний агент Штурман працює на вбудованому Claude.
            </div>

            {error && (
              <div style={{ padding: "8px 12px", background: "var(--errBg)", color: "var(--err)", borderRadius: 9, fontSize: 12.5, lineHeight: 1.4 }}>
                {error}
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button className="btn btn-primary" onClick={save} disabled={!canSave}>
                {saving ? <IconSpinner size={15} /> : null} Зберегти
              </button>
              {saved && <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ok)" }}>Збережено ✓</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function EngineCard({
  selected,
  onSelect,
  title,
  desc,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        textAlign: "left",
        padding: "12px 13px",
        background: selected ? "var(--accentSoft)" : "var(--card)",
        border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 10,
        cursor: "pointer",
        color: "var(--text)",
      }}
    >
      <span
        style={{
          flex: "none",
          width: 16,
          height: 16,
          marginTop: 2,
          borderRadius: "50%",
          border: `2px solid ${selected ? "var(--accent)" : "var(--border2)"}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected && (
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)" }} />
        )}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{title}</span>
        <span style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.45 }}>{desc}</span>
      </span>
    </button>
  );
}
