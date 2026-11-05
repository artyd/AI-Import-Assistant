"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/api";
import { IconSpinner } from "@/components/ui/icons";

// The Штурман PIN gate, shared by /login and the site entry (/). Same look and
// behaviour in both places: auto-verify on the last digit, shake on a wrong code.

export function BrandMark({ letter = "Ш" }: { letter?: string }) {
  return (
    <span
      data-brand-mark=""
      style={{
        flex: "none",
        width: 64,
        height: 64,
        borderRadius: 18,
        background: "var(--accent)",
        color: "var(--accentTx)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 800,
        fontSize: 32,
        boxShadow: "0 10px 30px var(--accentSoft)",
      }}
    >
      {letter}
    </span>
  );
}

export function CodeGate({
  codeLength,
  onWantEmail,
  loginWithCode,
  router,
}: {
  codeLength: number;
  onWantEmail: () => void;
  loginWithCode: (code: string) => Promise<void>;
  router: ReturnType<typeof useRouter>;
}) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState(false);
  const [msg, setMsg] = useState("Невірний код");
  const [busy, setBusy] = useState(false);
  const codeRef = useRef(code);
  codeRef.current = code;

  const verify = useCallback(
    async (value: string) => {
      setBusy(true);
      try {
        await loginWithCode(value);
        router.replace("/workspaces");
      } catch (e) {
        // Wrong code / throttled → shake, then reset.
        setMsg(
          e instanceof ApiError && e.status === 429
            ? e.code === "code_login_locked"
              ? "Вхід за кодом тимчасово заблоковано. Увійдіть через email."
              : "Забагато спроб. Зачекайте 15 хвилин."
            : "Невірний код"
        );
        setErr(true);
        setBusy(false);
        setTimeout(() => {
          setCode("");
          setErr(false);
        }, 600);
      }
    },
    [loginWithCode, router]
  );

  const push = useCallback(
    (d: string) => {
      if (busy) return;
      setErr(false);
      setCode((cur) => {
        if (cur.length >= codeLength) return cur;
        const next = (cur + d).slice(0, codeLength);
        if (next.length === codeLength) setTimeout(() => verify(next), 120);
        return next;
      });
    },
    [busy, verify]
  );

  const back = useCallback(() => {
    if (busy) return;
    setErr(false);
    setCode((c) => c.slice(0, -1));
  }, [busy]);

  // Physical keyboard support.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        push(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [push, back]);
  // Cells shrink for 7–8 digit PINs so the row still fits a phone.
  const cellW = codeLength > 6 ? 38 : codeLength > 4 ? 44 : 56;

  const cells = Array.from({ length: codeLength }, (_, i) => code[i] ?? "");
  const keypad = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
  const keyBtn: React.CSSProperties = {
    height: 60,
    borderRadius: 14,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    color: "var(--text)",
    fontSize: 22,
    fontWeight: 600,
    cursor: "pointer",
    fontVariantNumeric: "tabular-nums",
  };

  return (
    <div
      key={err ? "shake" : "calm"}
      style={{
        width: "100%",
        maxWidth: 340,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        animation: err ? "gateShake .5s ease both" : undefined,
      }}
    >
      <BrandMark />
      <div style={{ marginTop: 18, fontSize: 22, fontWeight: 700, letterSpacing: 1.5, color: "var(--text)" }}>
        ШТУРМАН
      </div>
      <div style={{ marginTop: 6, fontSize: 14, color: "var(--muted)" }}>Введіть код доступу</div>

      <div style={{ display: "flex", gap: codeLength > 6 ? 7 : 11, margin: "26px 0 28px" }}>
        {cells.map((d, i) => {
          const active = i === code.length && !busy;
          return (
            <div
              key={i}
              style={{
                width: cellW,
                height: 64,
                borderRadius: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 26,
                fontWeight: 600,
                fontVariantNumeric: "tabular-nums",
                color: "var(--text)",
                background: "var(--surface)",
                border: `1.5px solid ${
                  err ? "var(--err)" : d ? "var(--accent)" : active ? "var(--accent)" : "var(--border2)"
                }`,
                transition: "border-color .15s",
              }}
            >
              {d ? "•" : ""}
            </div>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, width: "100%", maxWidth: 280 }}>
        {keypad.map((k) => (
          <button key={k} onClick={() => push(k)} style={keyBtn} disabled={busy}>
            {k}
          </button>
        ))}
        <span />
        <button onClick={() => push("0")} style={keyBtn} disabled={busy}>
          0
        </button>
        <button
          onClick={back}
          title="Стерти"
          disabled={busy}
          style={{
            height: 60,
            borderRadius: 14,
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--muted)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 5H8.5a2 2 0 0 0-1.6.8L2 12l4.9 6.2a2 2 0 0 0 1.6.8H21a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1Z" />
            <path d="m18 9-6 6M12 9l6 6" />
          </svg>
        </button>
      </div>

      <div style={{ marginTop: 20, height: 18 }}>
        {busy && <IconSpinner size={16} />}
        {err && !busy && <span style={{ color: "var(--err)", fontSize: 13 }}>{msg}</span>}
      </div>

      <button
        onClick={onWantEmail}
        style={{
          marginTop: 14,
          background: "transparent",
          border: "none",
          color: "var(--muted)",
          fontSize: 12.5,
          cursor: "pointer",
          textDecoration: "underline",
        }}
      >
        Вхід через email
      </button>
    </div>
  );
}

