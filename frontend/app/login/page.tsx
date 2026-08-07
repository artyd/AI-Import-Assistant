"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { IconLogo, IconMoon, IconSun, IconSpinner } from "@/components/icons";

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const { theme, toggle } = useTheme();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace("/workspaces");
  }, [user, loading, router]);

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
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          height: "var(--header-h)",
          background: "var(--header)",
          color: "#fafafa",
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 10,
        }}
      >
        <IconLogo size={22} />
        <span
          style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}
        >
          AI Import Assistant
        </span>
        <div style={{ flex: 1 }} />
        <button
          className="btn-icon"
          onClick={toggle}
          aria-label="Тема"
          style={{ color: "rgba(250,250,250,.85)" }}
        >
          {theme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
        </button>
      </div>

      <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 24 }}>
        <form
          onSubmit={onSubmit}
          className="panel"
          style={{
            width: "100%",
            maxWidth: 380,
            padding: 28,
            background: "var(--surface)",
          }}
        >
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 22,
              margin: "0 0 6px",
            }}
          >
            Вхід
          </h1>
          <p style={{ color: "var(--muted)", margin: "0 0 20px", fontSize: 13 }}>
            Штурман — помічник з імпортної логістики. Доступ надає адміністратор.
          </p>

          <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
            Email
          </label>
          <input
            className="input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ marginBottom: 14 }}
          />

          <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
            Пароль
          </label>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ marginBottom: 18 }}
          />

          {error && (
            <div
              style={{
                color: "var(--err)",
                fontSize: 13,
                marginBottom: 14,
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy}
            style={{ width: "100%" }}
          >
            {busy ? <IconSpinner size={18} /> : "Увійти"}
          </button>
        </form>
      </div>
    </div>
  );
}
