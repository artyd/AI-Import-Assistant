"use client";

import { useCallback, useEffect, useState } from "react";
import { SupplyApiError } from "@/lib/supply/api";
import { ICompass } from "./SupplyIcons";

/** The Штурман PIN, asked only to unlock editing of Поставки. */
export function PinModal({ length, enabled, onSubmit, onCancel }: { length: number; enabled: boolean; onSubmit: (code: string) => Promise<void>; onCancel: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [shake, setShake] = useState(0);

  const submit = useCallback(
    async (value: string) => {
      setBusy(true);
      try {
        await onSubmit(value);
      } catch (e) {
        setMsg(
          e instanceof SupplyApiError && e.status === 429
            ? e.code === "code_login_locked" ? "Вхід за кодом тимчасово заблоковано." : "Забагато спроб. Зачекайте 15 хвилин."
            : "Невірний код",
        );
        setShake((n) => n + 1);
        setTimeout(() => setCode(""), 500);
      } finally {
        setBusy(false);
      }
    },
    [onSubmit],
  );

  const push = useCallback(
    (d: string) => {
      if (busy) return;
      setMsg(null);
      setCode((c) => {
        if (d === "del") return c.slice(0, -1);
        if (c.length >= length) return c;
        const next = c + d;
        if (next.length === length) setTimeout(() => void submit(next), 120);
        return next;
      });
    },
    [busy, length, submit],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) push(e.key);
      else if (e.key === "Backspace") push("del");
      else if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [push, onCancel]);

  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className={`pin${shake ? " shake" : ""}`} key={shake} role="dialog" aria-label="Код Штурмана">
        <span className="lg" style={{ color: "#fff" }}><ICompass size={24} /></span>
        <div className="t">Редагування поставок</div>
        {enabled ? (
          <>
            <div className="s" style={msg ? { color: "#f0686e" } : undefined}>{msg ?? "Введіть код Штурмана. Без нього реєстр лише для перегляду."}</div>
            <div className="cells">
              {Array.from({ length }, (_, i) => (
                <div key={i} className={i < code.length ? "on" : i === code.length && !busy ? "cur" : ""}>{i < code.length ? "•" : ""}</div>
              ))}
            </div>
            <div className="keys">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((k) => <button key={k} onClick={() => push(k)} disabled={busy}>{k}</button>)}
              <span />
              <button onClick={() => push("0")} disabled={busy}>0</button>
              <button className="g" onClick={() => push("del")} disabled={busy} aria-label="Стерти">⌫</button>
            </div>
          </>
        ) : (
          <div className="s" style={{ margin: "12px 0" }}>Код Штурмана на сервері не налаштовано. Редагувати можна з відкритого сеансу Штурмана.</div>
        )}
        <button className="cancel" onClick={onCancel}>Скасувати</button>
      </div>
    </div>
  );
}
