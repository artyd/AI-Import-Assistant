"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Workspace } from "@/lib/types";
import { Header } from "@/components/Header";
import {
  IconFolder,
  IconFolderPlus,
  IconSpinner,
  IconAgent,
} from "@/components/icons";

export default function WorkspacesPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [items, setItems] = useState<Workspace[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [user, authLoading, router]);

  const load = useCallback(async () => {
    const { workspaces } = await api<{ workspaces: Workspace[] }>(
      "/api/workspaces"
    );
    setItems(workspaces);
  }, []);

  useEffect(() => {
    if (user) load().catch(() => setItems([]));
  }, [user, load]);

  if (authLoading || !user) {
    return (
      <div style={{ height: "100vh", display: "grid", placeItems: "center" }}>
        <IconSpinner size={26} />
      </div>
    );
  }

  const empty = items !== null && items.length === 0;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header />

      <div style={{ flex: 1, display: "flex" }}>
        {/* Left rail — mirrors the mock's shell */}
        <aside
          style={{
            width: 288,
            borderRight: "1px solid var(--border)",
            background: "var(--panel)",
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--muted)",
              textTransform: "uppercase",
              letterSpacing: 0.4,
              marginBottom: 4,
            }}
          >
            Поставки
          </div>
          {items === null ? (
            <div style={{ color: "var(--muted)", padding: 12 }}>
              <IconSpinner size={18} />
            </div>
          ) : empty ? (
            <div
              style={{
                textAlign: "center",
                color: "var(--muted)",
                padding: "40px 8px",
              }}
            >
              <IconFolder size={26} />
              <div style={{ marginTop: 8, fontSize: 13 }}>
                Поставки не підключені
              </div>
            </div>
          ) : (
            items.map((w) => (
              <button
                key={w.id}
                onClick={() => router.push(`/workspaces/${w.id}`)}
                className="btn"
                style={{
                  justifyContent: "flex-start",
                  height: "auto",
                  padding: "10px 12px",
                  textAlign: "left",
                  background: "var(--surface)",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>
                    №{w.number ?? "—"}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--muted)",
                      fontWeight: 400,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {w.supplier || "Без постачальника"}
                  </span>
                </div>
              </button>
            ))
          )}
        </aside>

        {/* Center — empty CTA or hint */}
        <main
          style={{
            flex: 1,
            display: "grid",
            placeItems: "center",
            padding: 24,
          }}
        >
          <div style={{ maxWidth: 460, textAlign: "center" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 22,
                marginBottom: 22,
              }}
            >
              <span
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 16,
                  background: "var(--accent)",
                  color: "var(--accentTx)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <IconFolder size={26} />
              </span>
              <span
                style={{
                  borderTop: "2px dashed var(--border2)",
                  width: 56,
                  height: 0,
                }}
              />
              <span
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 14,
                  border: "1px solid var(--border)",
                  display: "grid",
                  placeItems: "center",
                  color: "var(--muted)",
                }}
              >
                <IconAgent size={22} />
              </span>
            </div>
            <h1
              style={{
                fontFamily: "var(--font-display)",
                fontSize: 28,
                margin: "0 0 12px",
              }}
            >
              Підключіть папку поставки
            </h1>
            <p style={{ color: "var(--muted)", margin: "0 0 24px" }}>
              Штурман проіндексує документи — контракт, інвойс, пакувальний
              лист, сертифікати — і буде звіряти чернетки, стежити за
              комплектністю та підказувати код УКТ ЗЕД.
            </p>
            <button
              className="btn btn-primary"
              onClick={() => setCreating(true)}
              style={{ margin: "0 auto" }}
            >
              <IconFolderPlus size={18} /> Додати папку
            </button>
          </div>
        </main>
      </div>

      {creating && (
        <CreateWorkspaceModal
          onClose={() => setCreating(false)}
          onCreated={(w) => router.push(`/workspaces/${w.id}`)}
        />
      )}
    </div>
  );
}

function CreateWorkspaceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (w: Workspace) => void;
}) {
  const [number, setNumber] = useState("");
  const [supplier, setSupplier] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { workspace } = await api<{ workspace: Workspace }>(
        "/api/workspaces",
        {
          body: {
            number: number.trim() || undefined,
            supplier: supplier.trim() || undefined,
            status: "active",
          },
        }
      );
      onCreated(workspace);
    } catch {
      setError("Не вдалося створити поставку");
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.45)",
        display: "grid",
        placeItems: "center",
        padding: 24,
        zIndex: 50,
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="panel"
        style={{
          width: "100%",
          maxWidth: 420,
          padding: 24,
          background: "var(--surface)",
          boxShadow: "var(--shadow)",
        }}
      >
        <h2
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 18,
            margin: "0 0 4px",
          }}
        >
          Нова поставка
        </h2>
        <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 18px" }}>
          Створимо поставку та скелет із 10 митних папок.
        </p>

        <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
          Номер
        </label>
        <input
          className="input"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="2026-0815"
          style={{ marginBottom: 14 }}
        />
        <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
          Постачальник
        </label>
        <input
          className="input"
          value={supplier}
          onChange={(e) => setSupplier(e.target.value)}
          placeholder="SupplierABC"
          style={{ marginBottom: 18 }}
        />

        {error && (
          <div style={{ color: "var(--err)", fontSize: 13, marginBottom: 14 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Скасувати
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <IconSpinner size={18} /> : "Створити"}
          </button>
        </div>
      </form>
    </div>
  );
}
