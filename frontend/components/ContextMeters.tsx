"use client";

import type { ChatUsage } from "@/lib/types";

/**
 * Two compact meters under the chat input:
 * - «Контекст» — how much of the model's context window the last reply used
 *   (tokens / window). When the API cleared old tool results to keep reading,
 *   it says so: reading never stops because the context is full.
 * - «Чат» — how much of this conversation is still given to the model
 *   (user turns replayed / total); older turns beyond the budget drop out.
 * Data comes from the `usage` field of the chat `done` event (and of stored
 * assistant messages), so the meters survive a page reload.
 */
export function ContextMeters({ usage, streaming }: { usage: ChatUsage | null; streaming: boolean }) {
  if (!usage) {
    return (
      <div style={rowStyle} data-testid="context-meters">
        <span style={{ color: "var(--muted)" }}>
          Контекст і вікно чату зʼявляться після першої відповіді Штурмана.
        </span>
      </div>
    );
  }
  const ctxPct = pct(usage.contextTokens, usage.contextWindow);
  const h = usage.history;
  const chatPct = h.historyBudgetChars > 0 ? pct(h.historyChars, h.historyBudgetChars) : 0;
  const dropped = Math.max(0, h.totalTurns - h.keptTurns);

  const ctxTitle =
    `Модель: ${usage.model}\n` +
    `Останній запит: ${fmt(usage.contextTokens)} з ${fmt(usage.contextWindow)} токенів (пік за відповідь: ${fmt(
      usage.peakContextTokens
    )}).\n` +
    (usage.clearedToolUses > 0
      ? `Щоб читати далі, API прибрав ${usage.clearedToolUses} старих результатів інструментів (~${fmt(
          usage.clearedTokens
        )} токенів). Нові документи читаються далі; прибране можна перечитати.`
      : "Старі результати інструментів не прибиралися.");
  const chatTitle =
    `У вікні моделі: ${h.keptTurns} з ${h.totalTurns} попередніх запитань цієї розмови ` +
    `(${fmt(h.historyChars)} з ${fmt(h.historyBudgetChars)} символів історії).` +
    (dropped > 0 ? `\nНайстаріші ${dropped} запит. модель уже не бачить — повторіть важливе або почніть нову розмову.` : "");

  return (
    <div style={rowStyle} data-testid="context-meters" aria-busy={streaming}>
      <Meter
        label="Контекст"
        value={`${fmt(usage.contextTokens)} / ${fmt(usage.contextWindow)}`}
        percent={ctxPct}
        note={usage.clearedToolUses > 0 ? `прибрано ${usage.clearedToolUses} старих` : undefined}
        title={ctxTitle}
        testId="meter-context"
      />
      <Meter
        label="Чат"
        value={`${h.keptTurns}/${h.totalTurns} запит.`}
        percent={chatPct}
        note={dropped > 0 ? `${dropped} поза вікном` : h.totalTurns === 0 ? "нова розмова" : undefined}
        title={chatTitle}
        testId="meter-chat"
      />
    </div>
  );
}

function Meter({
  label,
  value,
  percent,
  note,
  title,
  testId,
}: {
  label: string;
  value: string;
  percent: number;
  note?: string;
  title: string;
  testId: string;
}) {
  const color = percent >= 85 ? "var(--err)" : percent >= 60 ? "var(--warn)" : "var(--accent)";
  return (
    <div
      title={title}
      data-testid={testId}
      style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}
    >
      <span style={{ color: "var(--muted)", flex: "none" }}>{label}</span>
      <span
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        style={{
          flex: "none",
          width: 64,
          height: 5,
          borderRadius: 3,
          background: "var(--border2)",
          overflow: "hidden",
        }}
      >
        <span
          style={{
            display: "block",
            width: `${Math.max(percent, percent > 0 ? 3 : 0)}%`,
            height: "100%",
            background: color,
            transition: "width .3s",
          }}
        />
      </span>
      <span style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
        {value}
      </span>
      {note && <span style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>· {note}</span>}
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "center",
  alignItems: "center",
  columnGap: 18,
  rowGap: 6,
  fontSize: 12,
  marginTop: 8,
};

function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}

/** 12345 → "12,3 тис.", 1000000 → "1 млн" (compact, Ukrainian). */
function fmt(n: number): string {
  return new Intl.NumberFormat("uk-UA", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
