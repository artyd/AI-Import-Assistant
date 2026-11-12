"use client";

import { useEffect, useState } from "react";
import { IconCheck, IconChevronRight, IconSpinner } from "../ui/icons";
import {
  currentActivity,
  estimate,
  formatElapsed,
  formatSeconds,
  lastEventAt,
  loadDurations,
  QUIET_MS,
  type TurnTrace,
} from "@/lib/chat/progress";

const SHOWN_STEPS = 6;

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function StepRow({ label, done, ms }: { label: string; done: boolean; ms?: number }) {
  return (
    <li className="tp-step" data-done={done || undefined}>
      <span className="tp-step-icon" aria-hidden="true">
        {done ? <IconCheck size={13} /> : <IconSpinner size={13} />}
      </span>
      <span className="ellipsis" style={{ flex: 1, minWidth: 0 }} title={label}>
        {label}
      </span>
      {ms !== undefined && <span className="tp-time">{formatSeconds(ms / 1000)}</span>}
    </li>
  );
}

/**
 * The live card while Штурман works: what it is doing now, the steps so far, a
 * running timer and a rough estimate — so a long turn reads as work, not a hang.
 */
export function ThinkingProgress({ trace, writing = false }: { trace: TurnTrace; writing?: boolean }) {
  const now = useNow(true);
  const [past] = useState(loadDurations);
  const elapsed = now - trace.startedAt;
  const est = estimate(elapsed, past);
  const quiet = !writing && now - lastEventAt(trace) > QUIET_MS;
  const steps = trace.steps;
  const hidden = Math.max(0, steps.length - SHOWN_STEPS);

  if (writing) {
    return (
      <div className="tp-inline" data-testid="thinking-writing" aria-live="polite">
        <IconSpinner size={13} /> Пишу відповідь · {formatElapsed(elapsed)}
      </div>
    );
  }

  return (
    <div className="tp-card" data-testid="thinking-progress" role="status" aria-live="polite">
      <div className="tp-head">
        <IconSpinner size={16} />
        <span className="tp-now" data-testid="thinking-now">
          {currentActivity(trace, false)}…
        </span>
        <span className="tp-time" data-testid="thinking-elapsed">
          {formatElapsed(elapsed)}
        </span>
      </div>
      <div className="tp-bar" aria-hidden="true">
        <span
          className={est.fraction === null ? "tp-bar-fill tp-bar-indeterminate" : "tp-bar-fill"}
          style={est.fraction === null ? undefined : { width: `${Math.round(est.fraction * 100)}%` }}
        />
      </div>
      <div className="tp-meta">
        {steps.length > 0 ? `Крок ${steps.length}` : "Початок"} · {est.text}
      </div>
      {steps.length > 0 && (
        <ul className="tp-steps">
          {hidden > 0 && <li className="tp-more">+ ще {hidden} {hidden === 1 ? "крок" : "кроки"} раніше</li>}
          {steps.slice(-SHOWN_STEPS).map((s) => (
            <StepRow key={s.id} label={s.label} done={s.endedAt !== undefined} ms={s.endedAt !== undefined ? s.endedAt - s.startedAt : undefined} />
          ))}
        </ul>
      )}
      {quiet && (
        <div className="tp-quiet" data-testid="thinking-quiet">
          Штурман зважує зібране перед відповіддю — це нормально для складних питань. Не завис: таймер іде. Можна
          зупинити й звузити питання.
        </div>
      )}
    </div>
  );
}

/** After the answer: a folded «Хід роботи» with the steps and the total time. */
export function TurnTraceSummary({ trace }: { trace: TurnTrace }) {
  if (trace.endedAt === undefined) return null;
  const total = trace.endedAt - trace.startedAt;
  const n = trace.steps.length;
  return (
    <details className="tp-summary" data-testid="turn-trace">
      <summary>
        <IconChevronRight size={13} className="sources-chev" />
        Хід роботи · {n === 0 ? "без інструментів" : `${n} ${n === 1 ? "крок" : n < 5 ? "кроки" : "кроків"}`} ·{" "}
        {formatSeconds(total / 1000)}
      </summary>
      {n > 0 && (
        <ul className="tp-steps">
          {trace.steps.map((s) => (
            <StepRow key={s.id} label={s.label} done ms={s.endedAt !== undefined ? s.endedAt - s.startedAt : undefined} />
          ))}
        </ul>
      )}
    </details>
  );
}
