"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Workspace } from "@/lib/types";
import { Header } from "@/components/Header";
import { IconFolderPlus, IconSpinner } from "@/components/icons";

// In the ШТУРМАН design there is no separate shipment list — the shell's sidebar
// dropdown switches between them. So this route just lands the user in the most
// recent shipment, or shows a create prompt when there are none yet.
export default function WorkspacesPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [empty, setEmpty] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [user, authLoading, router]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const { workspaces } = await api<{ workspaces: Workspace[] }>("/api/workspaces");
        if (cancelled) return;
        if (workspaces.length > 0) {
          const newest = [...workspaces].sort((a, b) =>
            (b.created_at ?? "").localeCompare(a.created_at ?? "")
          )[0]!;
          router.replace(`/workspaces/${newest.id}`);
        } else {
          setEmpty(true);
        }
      } catch {
        if (!cancelled) setEmpty(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, router]);

  if (authLoading || !user || !empty) {
    return (
      <div style={{ height: "100vh", display: "grid", placeItems: "center" }}>
        <IconSpinner size={26} />
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header />
      <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 24 }}>
        <div style={{ maxWidth: 460, textAlign: "center" }}>
          <span
            style={{
              display: "inline-flex",
              width: 60,
              height: 60,
              borderRadius: 17,
              background: "var(--accent)",
              color: "var(--accentTx)",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 800,
              fontSize: 31,
              marginBottom: 22,
            }}
          >
            Ш
          </span>
          <h1 style={{ fontSize: 28, margin: "0 0 12px" }}>Створіть перше постачання</h1>
          <p style={{ color: "var(--muted)", margin: "0 0 24px" }}>
            Штурман проіндексує документи — контракт, інвойс, пакувальний лист,
            сертифікати — і буде звіряти чернетки, стежити за комплектністю та
            підказувати код УКТ&nbsp;ЗЕД.
          </p>
          <button className="btn btn-primary" onClick={() => setCreating(true)} style={{ margin: "0 auto" }}>
            <IconFolderPlus size={18} /> Нове постачання
          </button>
        </div>
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
      const { workspace } = await api<{ workspace: Workspace }>("/api/workspaces", {
        body: {
          number: number.trim() || undefined,
          supplier: supplier.trim() || undefined,
          status: "active",
        },
      });
      onCreated(workspace);
    } catch {
      setError("Не вдалося створити постачання");
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10,10,14,.45)",
        display: "grid",
        placeItems: "center",
        padding: 24,
        zIndex: 50,
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        style={{
          width: "100%",
          maxWidth: 420,
          padding: 24,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 18,
          boxShadow: "var(--shadow)",
        }}
      >
        <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>Нове постачання</h2>
        <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 18px" }}>
          Створимо постачання та скелет із 10 митних тек.
        </p>

        <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>Номер</label>
        <input
          className="input"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="2026-0815"
          style={{ marginBottom: 14 }}
        />
        <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>Постачальник</label>
        <input
          className="input"
          value={supplier}
          onChange={(e) => setSupplier(e.target.value)}
          placeholder="SupplierABC"
          style={{ marginBottom: 18 }}
        />

        {error && <div style={{ color: "var(--err)", fontSize: 13, marginBottom: 14 }}>{error}</div>}

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
