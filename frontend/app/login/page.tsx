"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { IconMoon, IconSun, IconSpinner } from "@/components/icons";

const CODE_LEN = 4;

export default function LoginPage() {
  const { user, loading, login, loginWithCode } = useAuth();
  const { theme, toggle } = useTheme();
  const router = useRouter();

  const [mode, setMode] = useState<"code" | "email">("code");

  useEffect(() => {
    if (!loading && user) router.replace("/workspaces");
  }, [user, loading, router]);

  return (
    <div style={{ position: "relative", minHeight: "100vh", background: "var(--bg)" }}>
      <button
        className="btn-icon"
        onClick={toggle}
        aria-label="Тема оформлення"
        title="Тема оформлення"
        style={{ position: "absolute", top: 16, right: 16 }}
      >
        {theme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
      </button>

      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        {mode === "code" ? (
          <CodeGate onWantEmail={() => setMode("email")} loginWithCode={loginWithCode} router={router} />
        ) : (
          <EmailForm onWantCode={() => setMode("code")} login={login} router={router} />
        )}
      </div>
    </div>
  );
}

function BrandMark() {
  return (
    <span
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
      Ш
    </span>
  );
}

function CodeGate({
  onWantEmail,
  loginWithCode,
  router,
}: {
  onWantEmail: () => void;
  loginWithCode: (code: string) => Promise<void>;
  router: ReturnType<typeof useRouter>;
}) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef(code);
  codeRef.current = code;

  const verify = useCallback(
    async (value: string) => {
      setBusy(true);
      try {
        await loginWithCode(value);
        router.replace("/workspaces");
      } catch {
        // Wrong code (or no user configured) → shake, then reset.
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
        if (cur.length >= CODE_LEN) return cur;
        const next = (cur + d).slice(0, CODE_LEN);
        if (next.length === CODE_LEN) setTimeout(() => verify(next), 120);
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

  const cells = Array.from({ length: CODE_LEN }, (_, i) => code[i] ?? "");
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

      <div style={{ display: "flex", gap: 11, margin: "26px 0 28px" }}>
        {cells.map((d, i) => {
          const active = i === code.length && !busy;
          return (
            <div
              key={i}
              style={{
                width: 56,
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
        {err && !busy && <span style={{ color: "var(--err)", fontSize: 13 }}>Невірний код</span>}
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
        Вхід адміністратора (email)
      </button>
    </div>
  );
}

function EmailForm({
  onWantCode,
  login,
  router,
}: {
  onWantCode: () => void;
  login: (email: string, password: string) => Promise<void>;
  router: ReturnType<typeof useRouter>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
      router.replace("/workspaces");
    } catch (err) {
      if (err instanceof ApiError && err.code === "invalid_credentials")
        setError("Невірний email або пароль");
      else setError("Не вдалося увійти. Спробуйте ще раз.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{
        width: "100%",
        maxWidth: 360,
        padding: 28,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 18,
        boxShadow: "var(--shadow)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
        <BrandMark />
      </div>
      <h1 style={{ fontSize: 20, margin: "0 0 6px", textAlign: "center" }}>Вхід адміністратора</h1>
      <p style={{ color: "var(--muted)", margin: "0 0 20px", fontSize: 13, textAlign: "center" }}>
        Email + пароль. Доступ надає адміністратор.
      </p>

      <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>Email</label>
      <input
        className="input"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        style={{ marginBottom: 14 }}
      />
      <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>Пароль</label>
      <input
        className="input"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        style={{ marginBottom: 18 }}
      />

      {error && <div style={{ color: "var(--err)", fontSize: 13, marginBottom: 14 }}>{error}</div>}

      <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: "100%" }}>
        {busy ? <IconSpinner size={18} /> : "Увійти"}
      </button>
      <button
        type="button"
        onClick={onWantCode}
        style={{
          display: "block",
          margin: "14px auto 0",
          background: "transparent",
          border: "none",
          color: "var(--muted)",
          fontSize: 12.5,
          cursor: "pointer",
          textDecoration: "underline",
        }}
      >
        Вхід за кодом
      </button>
    </form>
  );
}
