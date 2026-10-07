"use client";

// Bottom bar for "Програти рейс": play / pause, speed, a time slider with event
// ticks, the date, the last carrier event and how far behind plan the cargo was.

import { useEffect, useRef, useState } from "react";
import { DAY, lagDays, lastEventAt, type Replay } from "./playback";

const SPEEDS = [
  { v: 1, label: "1 дн/с" },
  { v: 3, label: "3 дн/с" },
  { v: 7, label: "7 дн/с" },
];

export function PlaybackBar({
  replay,
  title,
  t,
  setT,
  onClose,
  left,
  right,
}: {
  replay: Replay;
  title: string;
  t: number;
  setT: (t: number) => void;
  onClose: () => void;
  left: number;
  right: number;
}) {
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(3);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let prev = performance.now();
    const step = (now: number) => {
      const dt = now - prev;
      prev = now;
      const next = tRef.current + (dt / 1000) * speed * DAY;
      if (next >= replay.end) {
        setT(replay.end);
        setPlaying(false);
        return;
      }
      setT(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, replay.end, setT]);

  const lag = lagDays(replay, t);
  const ev = lastEventAt(replay, t);
  const span = Math.max(1, replay.end - replay.start);
  const date = new Date(t).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });

  return (
    <div style={{ position: "absolute", left, right, bottom: 18, zIndex: 1300, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
      <div
        data-testid="hub-playback"
        style={{
          pointerEvents: "auto",
          width: "min(680px, 100%)",
          padding: "10px 14px",
          background: "color-mix(in srgb, var(--surface) 95%, transparent)",
          backdropFilter: "blur(12px)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow)",
          display: "grid",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
          <button
            type="button"
            aria-label={playing ? "Пауза" : "Відтворити"}
            onClick={() => {
              if (!playing && t >= replay.end) setT(replay.start);
              setPlaying((p) => !p);
            }}
            className="btn btn-primary"
            style={{ width: 34, height: 30, padding: 0 }}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <b style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Рейс: {title}</b>
          <span data-testid="hub-playback-date" style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
            {date}
          </span>
          <select aria-label="Швидкість" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={{ height: 28, borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", font: "inherit", fontSize: 12 }}>
            {SPEEDS.map((s) => (
              <option key={s.v} value={s.v}>
                {s.label}
              </option>
            ))}
          </select>
          <button type="button" aria-label="Закрити відтворення" onClick={onClose} style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--muted)", cursor: "pointer" }}>
            ×
          </button>
        </div>
        <div style={{ position: "relative", height: 22 }}>
          {replay.events.map((e, i) => (
            <span
              key={i}
              title={`${new Date(e.t).toLocaleDateString("uk-UA")} · ${e.label}`}
              style={{
                position: "absolute",
                top: 2,
                left: `calc(${((e.t - replay.start) / span) * 100}% - 1px)`,
                width: 2,
                height: 7,
                borderRadius: 1,
                background: e.t <= t ? "var(--accent)" : "var(--faint)",
              }}
            />
          ))}
          <input
            type="range"
            aria-label="Час рейсу"
            data-testid="hub-playback-slider"
            min={replay.start}
            max={replay.end}
            step={3_600_000}
            value={Math.round(t)}
            onChange={(e) => {
              setPlaying(false);
              setT(Number(e.target.value));
            }}
            style={{ position: "absolute", left: 0, right: 0, bottom: -2, width: "100%", accentColor: "var(--accent)" }}
          />
        </div>
        <div style={{ display: "flex", gap: 12, fontSize: 12, color: "var(--muted)", flexWrap: "wrap" }}>
          <span style={{ minWidth: 0, flex: 1 }}>{ev ? `${ev.label}${ev.location ? ` · ${ev.location}` : ""}` : "До першої події перевізника"}</span>
          {lag != null && (
            <span data-testid="hub-playback-lag" style={{ fontWeight: 700, color: lag > 0.5 ? "var(--err)" : lag < -0.5 ? "var(--ok)" : "var(--text)" }}>
              {Math.abs(lag) <= 0.5 ? "У графіку" : lag > 0 ? `Відставання від плану: ${lag} дн` : `Випереджає план: ${Math.abs(lag)} дн`}
            </span>
          )}
          <span>
            <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: "var(--accent)", marginRight: 4 }} />
            факт
            <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", border: "2px dashed var(--muted)", margin: "0 4px 0 10px" }} />
            план
          </span>
        </div>
      </div>
    </div>
  );
}
