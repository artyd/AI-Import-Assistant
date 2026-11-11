"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { api, ApiError } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { IconMoon, IconSun, IconSpinner } from "@/components/ui/icons";
import { BrandMark, CodeGate } from "@/components/auth/CodeGate";
import { LegalLinks } from "@/components/legal/LegalLinks";

export default function LoginPage() {
  const { user, loading, login, loginWithCode } = useAuth();
  // Which methods the backend offers: the PIN keypad only when configured.
  const [codeLength, setCodeLength] = useState<number | null>(null);
  const [mode, setMode] = useState<"code" | "email">("email");

  useEffect(() => {
    api<{ codeLogin: boolean; codeLength: number | null }>("/api/auth/methods")
      .then((m) => {
        if (m.codeLogin && m.codeLength) {
          setCodeLength(m.codeLength);
          setMode("code");
        }
      })
      .catch(() => {});
  }, []);
  const { theme, toggle } = useTheme();
  const router = useRouter();

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
        {mode === "code" && codeLength ? (
          <CodeGate
            codeLength={codeLength}
            onWantEmail={() => setMode("email")}
            loginWithCode={loginWithCode}
            router={router}
          />
        ) : (
          <EmailForm onWantCode={codeLength ? () => setMode("code") : undefined} login={login} router={router} />
        )}
      </div>
      <LegalLinks fixed />
    </div>
  );
}

function EmailForm({
  onWantCode,
  login,
  router,
}: {
  onWantCode?: () => void;
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
      else if (err instanceof ApiError && err.status === 429)
        setError("Забагато спроб входу. Зачекайте кілька хвилин і спробуйте знову.");
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
      <h1 style={{ fontSize: 20, margin: "0 0 6px", textAlign: "center" }}>Вхід</h1>
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
      {onWantCode && (
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
      )}
    </form>
  );
}
