"use client";

import { useTheme } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import type { Workspace } from "@/lib/types";
import { IconLogo, IconMoon, IconSun, IconLogout } from "./icons";

const STATUS_LABEL: Record<Workspace["status"], string> = {
  active: "Активна",
  draft: "Чернетка",
  done: "Готово",
};

export function Header({ workspace }: { workspace?: Workspace | null }) {
  const { theme, toggle } = useTheme();
  const { user, logout } = useAuth();

  return (
    <header
      style={{
        height: "var(--header-h)",
        background: "var(--header)",
        color: "#fafafa",
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 16px",
        flex: "none",
      }}
    >
      <a
        href="/workspaces"
        style={{ display: "flex", alignItems: "center", gap: 10 }}
      >
        <IconLogo size={22} />
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 16,
          }}
        >
          AI Import Assistant
        </span>
      </a>

      {workspace && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: "rgba(250,250,250,.7)",
            fontSize: 14,
            minWidth: 0,
          }}
        >
          <span style={{ opacity: 0.4 }}>|</span>
          <span style={{ color: "#fafafa", fontWeight: 600 }}>
            Поставка №{workspace.number ?? "—"}
          </span>
          {workspace.supplier && (
            <>
              <span style={{ opacity: 0.5 }}>·</span>
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {workspace.supplier}
              </span>
            </>
          )}
          <span
            className={workspace.status === "done" ? "badge ok" : "badge"}
            style={{ marginLeft: 4 }}
          >
            {workspace.status === "done" && <span className="dot done" />}
            {STATUS_LABEL[workspace.status]}
          </span>
        </div>
      )}

      <div style={{ flex: 1 }} />

      {user && (
        <span
          style={{ color: "rgba(250,250,250,.6)", fontSize: 13 }}
          title={user.email}
        >
          {user.name || user.email}
        </span>
      )}
      <button
        className="btn-icon"
        onClick={toggle}
        aria-label="Перемкнути тему"
        title="Тема"
        style={{ color: "rgba(250,250,250,.85)" }}
      >
        {theme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
      </button>
      {user && (
        <button
          className="btn-icon"
          onClick={logout}
          aria-label="Вийти"
          title="Вийти"
          style={{ color: "rgba(250,250,250,.85)" }}
        >
          <IconLogout size={18} />
        </button>
      )}
    </header>
  );
}
