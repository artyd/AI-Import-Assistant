"use client";

import { IconClock } from "./icons";

export interface LogEntry {
  id: string;
  time: string; // HH:MM
  text: string;
  kind: "call" | "result" | "info" | "warn";
}

const DOT: Record<LogEntry["kind"], string> = {
  call: "var(--info)",
  result: "var(--ok)",
  info: "var(--st-queue)",
  warn: "var(--warn)",
};

export function AgentLog({ entries }: { entries: LogEntry[] }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
          fontWeight: 600,
          flex: "none",
        }}
      >
        <IconClock size={17} />
        Журнал агента
      </div>

      <div style={{ overflowY: "auto", padding: "12px 16px", flex: 1 }}>
        {entries.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 13, paddingTop: 8 }}>
            Тут з’являться дії Штурмана: пошук, читання файлів, звірка та
            перевірка комплектності.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {entries.map((e) => (
              <div
                key={e.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "14px 1fr",
                  gap: 10,
                  padding: "7px 0",
                }}
              >
                <div style={{ display: "flex", justifyContent: "center", paddingTop: 5 }}>
                  <span
                    className="dot"
                    style={{ background: DOT[e.kind] }}
                  />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      color: "var(--muted)",
                    }}
                  >
                    {e.time}
                  </div>
                  <div style={{ fontSize: 13, wordBreak: "break-word" }}>
                    {e.text}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
