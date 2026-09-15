"use client";

// Input surface for consolidated-cargo analysis — a port of the prototype's
// analyze composer (ШТУРМАН.dc.html lines ~305–322). Three input modes:
//   • upload an Excel/CSV manifest (multipart `files`)
//   • paste manifest rows as text (JSON { text })
//   • paste a Google Sheets URL (JSON { sheetUrl } — any value starting with http)
// A single "Аналізувати" button POSTs to /api/collections/:id/analyze and calls
// back with the returned AnalysisResult. A stepped loader runs while in flight.

import { useRef, useState } from "react";
import { streamAnalyze } from "@/lib/sse";
import type { AnalysisResult } from "@/lib/types";
import { LnSettings } from "./LineIcons";

// Prototype sample manifest (line 1243) — for the "Вставити приклад" affordance.
const SAMPLE_MANIFEST =
  "Номенклатура\tКод УКТЗЕД\tКг\tЦіна/кг\n" +
  "Метамізол натрію\t2933199000\t500\t12.5\n" +
  "Аскорбінова кислота\t2936270000\t800\t6.2\n" +
  "Желатин фармацевтичний\t3503001000\t1200\t4.8\n" +
  "ПВХ-плівка\t3920431000\t2000\t2.1";

export function AnalyzePanel({
  collectionId,
  onResult,
  onOpenAiSettings,
}: {
  collectionId: string;
  onResult: (result: AnalysisResult) => void;
  onOpenAiSettings?: () => void;
}) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [running, setRunning] = useState(false);
  const [pct, setPct] = useState(0);
  const [step, setStep] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const trimmed = text.trim();
  const canRun = !running && (file !== null || trimmed.length > 0);

  const run = async () => {
    if (!canRun) return;
    setRunning(true);
    setError(null);
    setPct(0);
    setStep("Готую аналіз…");

    const path = `/api/collections/${collectionId}/analyze`;
    let body: Record<string, unknown> | FormData;
    if (file) {
      const form = new FormData();
      form.append("files", file, file.name || "manifest");
      body = form;
    } else {
      body = /^https?:\/\//i.test(trimmed) ? { sheetUrl: trimmed } : { text: trimmed };
    }

    let done = false;
    try {
      await streamAnalyze(path, body, {
        onProgress: (e) => {
          setPct(e.pct);
          setStep(e.step);
        },
        onDone: (analysis) => {
          done = true;
          onResult(analysis);
          setText("");
          setFile(null);
        },
        onError: (message) => setError(message || "Не вдалося виконати аналіз."),
      });
      if (!done && !error) setError("Аналіз перервано. Спробуйте ще раз.");
    } catch {
      setError("Не вдалося виконати аналіз.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ width: "100%", maxWidth: 640, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "center", margin: "0 0 18px" }}>
        <span
          style={{
            flex: "none",
            width: 56,
            height: 56,
            borderRadius: 16,
            background: "var(--accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--accentTx)",
          }}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3v18h18" />
            <path d="M7 15l3-4 3 3 4-6" />
          </svg>
        </span>
      </div>
      <h1
        style={{
          margin: "0 0 8px",
          fontWeight: 700,
          fontSize: 26,
          lineHeight: 1.15,
          textAlign: "center",
          color: "var(--text)",
        }}
      >
        Аналіз збірного вантажу
      </h1>
      {running ? (
        <Loader pct={pct} step={step} />
      ) : (
        <>
      <p
        style={{
          margin: "0 0 20px",
          fontSize: 15,
          lineHeight: 1.55,
          color: "var(--muted)",
          textAlign: "center",
        }}
      >
        Завантажте маніфест (Excel/CSV), вставте таблицю або дайте посилання на Google Sheets. Штурман
        обере актуальний лист, порахує CIF / мито / ПДВ, визначить походження та сформує перевірки ЄС / UA.
      </p>

      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border2)",
          borderRadius: 16,
          padding: 14,
          boxShadow: "var(--shadow)",
        }}
      >
        <input
          ref={fileRef}
          type="file"
          hidden
          accept=".xlsx,.csv"
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            if (f) {
              setFile(f);
              setError(null);
            }
            e.target.value = "";
          }}
        />

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          disabled={running}
          placeholder="Вставте рядки маніфесту або URL Google Sheets…"
          style={{
            width: "100%",
            border: "none",
            outline: "none",
            resize: "vertical",
            background: "transparent",
            fontSize: 14,
            lineHeight: 1.5,
            color: "var(--text)",
            minHeight: 90,
            fontFamily: "inherit",
          }}
        />

        {file ? (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              marginTop: 6,
              padding: "4px 10px",
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 12.5,
              color: "var(--text)",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
              <path d="M14 2v6h6" />
              <path d="M8 13h8M8 17h6" />
            </svg>
            <span style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {file.name}
            </span>
            <button
              type="button"
              onClick={() => setFile(null)}
              title="Прибрати файл"
              disabled={running}
              style={{ border: "none", background: "transparent", color: "var(--muted)", cursor: "pointer", padding: 0, display: "flex" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            marginTop: 10,
            paddingTop: 12,
            borderTop: "1px solid var(--border)",
          }}
        >
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={running}
            style={affBtn}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12" />
              <path d="m7 8 5-5 5 5" />
              <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
            </svg>
            Excel / CSV
          </button>
          <button
            type="button"
            onClick={() => {
              setFile(null);
              setText(SAMPLE_MANIFEST);
              setError(null);
            }}
            disabled={running}
            style={affBtn}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M7 9h10M7 13h6" />
            </svg>
            Вставити приклад
          </button>

          {onOpenAiSettings ? (
            <button
              type="button"
              onClick={onOpenAiSettings}
              disabled={running}
              title="Налаштування AI"
              aria-label="Налаштування AI"
              style={{ ...affBtn, padding: "0 11px" }}
            >
              <LnSettings size={15} />
            </button>
          ) : null}

          <div style={{ flex: 1 }} />

          <button
            type="button"
            onClick={run}
            disabled={!canRun}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              height: 36,
              padding: "0 18px",
              background: "var(--accent)",
              border: "none",
              borderRadius: 9,
              color: "var(--accentTx)",
              fontWeight: 600,
              fontSize: 13,
              cursor: canRun ? "pointer" : "not-allowed",
              opacity: canRun ? 1 : 0.55,
            }}
          >
            {running ? (
              <Spinner />
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            )}
            Аналізувати
          </button>
        </div>

        {error ? (
          <div
            style={{
              marginTop: 12,
              padding: "8px 12px",
              background: "var(--errBg)",
              color: "var(--err)",
              borderRadius: 9,
              fontSize: 12.5,
              lineHeight: 1.4,
            }}
          >
            {error}
          </div>
        ) : null}
      </div>
        </>
      )}
    </div>
  );
}

function Loader({ pct, step }: { pct: number; step: string }) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div
      data-anim
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "26px 8px 12px",
        animation: "fadeUp .4s ease both",
      }}
    >
      {/* Percentage — top */}
      <div
        style={{
          fontSize: 48,
          fontWeight: 800,
          color: "var(--accent)",
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1,
        }}
      >
        {clamped}%
      </div>
      {/* Progress bar — middle */}
      <div
        style={{
          width: "100%",
          maxWidth: 440,
          height: 8,
          background: "var(--hover)",
          borderRadius: 999,
          overflow: "hidden",
          marginTop: 20,
        }}
      >
        <div
          style={{
            width: `${clamped}%`,
            height: "100%",
            background: "var(--accent)",
            borderRadius: 999,
            transition: "width .45s ease",
          }}
        />
      </div>
      {/* Current step comment — below the bar */}
      <div
        style={{
          marginTop: 16,
          fontSize: 13.5,
          color: "var(--muted)",
          textAlign: "center",
          minHeight: 20,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Spinner />
        <span>{step}</span>
      </div>
    </div>
  );
}

const affBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  height: 36,
  padding: "0 13px",
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 12.5,
  fontWeight: 500,
  cursor: "pointer",
};

function Spinner() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M12 3a9 9 0 1 0 9 9" />
      <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
    </svg>
  );
}
