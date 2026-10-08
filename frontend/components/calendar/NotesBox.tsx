"use client";

// Team notes on a sheet row («машина замовлена на 14.10», «брокер в курсі»).
// Kept in Штурман — never written to the sheet. Only the author can delete.

import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { calendarApi, type SheetNote } from "@/lib/calendar";

export function NotesBox({ rowId, onCount }: { rowId: string; onCount?: (n: number) => void }) {
  const { user } = useAuth();
  const [notes, setNotes] = useState<SheetNote[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setNotes(null);
    calendarApi
      .notes(rowId)
      .then((r) => setNotes(r.notes))
      .catch(() => setNotes([]));
  }, [rowId]);

  const apply = (list: SheetNote[]) => {
    setNotes(list);
    onCount?.(list.length);
  };

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      apply((await calendarApi.addNote(rowId, text.trim())).notes);
      setText("");
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Не вдалося зберегти нотатку.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="calendar-notes">
      <div style={{ fontSize: 11, fontWeight: 650, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 6 }}>
        Нотатки команди
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {notes === null ? (
          <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Завантаження…</div>
        ) : notes.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Ще немає нотаток.</div>
        ) : (
          notes.map((n) => (
            <div key={n.id} style={{ padding: "6px 8px", borderRadius: 8, background: "var(--hover)", fontSize: 12.5 }} data-testid="calendar-note">
              <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{n.text}</div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                <span style={{ flex: 1 }}>
                  {n.userName || "—"} ·{" "}
                  {new Date(n.createdAt).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </span>
                {user && n.userId === user.id && (
                  <button
                    type="button"
                    aria-label="Видалити нотатку"
                    onClick={() => void calendarApi.deleteNote(n.id).then((r) => apply(r.notes))}
                    style={{ border: "none", background: "none", color: "var(--muted)", cursor: "pointer", padding: 0 }}
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
      <form onSubmit={add} style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={1000}
          placeholder="Нотатка: напр. «машина замовлена на 14.10»"
          aria-label="Нова нотатка"
          style={{ flex: 1, minWidth: 0, height: 32, borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", font: "inherit", fontSize: 12.5, padding: "0 8px" }}
        />
        <button type="submit" className="btn" disabled={busy || !text.trim()} style={{ height: 32, padding: "0 10px", fontSize: 12.5 }}>
          {busy ? "…" : "Додати"}
        </button>
      </form>
      {err && (
        <div role="alert" style={{ fontSize: 12, color: "var(--err)", marginTop: 4 }}>
          {err}
        </div>
      )}
    </section>
  );
}
