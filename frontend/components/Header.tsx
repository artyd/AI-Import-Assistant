"use client";

import { useTheme } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import type { Workspace } from "@/lib/types";
import { IconMoon, IconSun, IconLogout } from "./icons";
import { NotificationsBell } from "./NotificationsBell";

const STATUS_LABEL: Record<Workspace["status"], string> = {
  active: "Активна",
  draft: "Чернетка",
  done: "Готово",
  docs_in_progress: "Документи в роботі",
  docs_complete: "Документи повні",
  customs_ready: "Готово до митниці",
};
const STATUS_OK = new Set(["done", "customs_ready", "docs_complete"]);
const STATUS_WARN = new Set(["docs_in_progress"]);

// Status → pill colours, matching the mock's header pill (subtle tinted bg).
function pillColors(status: Workspace["status"]): { bg: string; fg: string } {
  if (STATUS_OK.has(status)) return { bg: "var(--okBg)", fg: "var(--ok)" };
  if (STATUS_WARN.has(status)) return { bg: "var(--warnBg)", fg: "var(--warn)" };
  if (status === "active") return { bg: "var(--accentSoft)", fg: "var(--accent)" };
  return { bg: "var(--hover)", fg: "var(--muted)" };
}

// Brand mark from the mock: an accent square with a white "Ш".
function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <span
      style={{
        flex: "none",
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        background: "var(--accent)",
        color: "var(--accentTx)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 800,
        fontSize: Math.round(size * 0.53),
      }}
    >
      Ш
    </span>
  );
}

export function Header({ workspace }: { workspace?: Workspace | null }) {
  const { theme, toggle } = useTheme();
  const { user, logout } = useAuth();
  const pill = workspace ? pillColors(workspace.status) : null;

  return (
    <header
      style={{
        height: "var(--header-h)",
        background: "var(--chat)",
        color: "var(--text)",
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "0 16px",
        flex: "none",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <a
        href="/workspaces"
        style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}
      >
        <BrandMark />
        <span
          style={{
            fontWeight: 700,
            fontSize: 17,
            letterSpacing: 1.5,
            color: "var(--text)",
          }}
        >
          ШТУРМАН
        </span>
      </a>

      {workspace && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            minWidth: 0,
            fontSize: 14,
          }}
        >
          <span style={{ color: "var(--border2)" }}>|</span>
          <span
            style={{
              fontWeight: 600,
              color: "var(--text)",
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            Постачання №{workspace.number ?? "—"}
          </span>
          {workspace.supplier && (
            <span
              style={{
                color: "var(--muted)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 220,
              }}
            >
              · {workspace.supplier}
            </span>
          )}
          {pill && (
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 11px 4px 9px",
                borderRadius: 20,
                background: pill.bg,
                color: pill.fg,
                fontSize: 11.5,
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: pill.fg,
                }}
              />
              {STATUS_LABEL[workspace.status] ?? workspace.status}
            </span>
          )}
        </div>
      )}

      <div style={{ flex: 1 }} />

      {user && <NotificationsBell />}
      {user && (
        <span
          style={{ color: "var(--muted)", fontSize: 13, whiteSpace: "nowrap" }}
          title={user.email}
        >
          {user.name || user.email}
        </span>
      )}
      <button
        className="btn-icon"
        onClick={toggle}
        aria-label="Перемкнути тему"
        title="Тема оформлення"
      >
        {theme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
      </button>
      {user && (
        <button
          className="btn-icon"
          onClick={logout}
          aria-label="Вийти"
          title="Вийти"
        >
          <IconLogout size={18} />
        </button>
      )}
    </header>
  );
}
