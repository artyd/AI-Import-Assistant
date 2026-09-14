"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { NewsItem, NewsResponse } from "@/lib/types";
import {
  NEWS_RUBRIC_ORDER,
  newsRubricColor,
  newsRubricLabel,
  relativeTimeUk,
} from "@/lib/news";
import { IconSpinner } from "@/components/icons";

const FILTER_KEYS = ["all", ...NEWS_RUBRIC_ORDER] as const;

function pillStyle(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    height: 34,
    padding: "0 7px 0 15px",
    borderRadius: 20,
    fontSize: 13,
    fontWeight: active ? 600 : 500,
    cursor: "pointer",
    whiteSpace: "nowrap",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    background: active ? "var(--accent)" : "var(--surface)",
    color: active ? "var(--accentTx)" : "var(--text)",
    transition: "background .12s",
  };
}

function countStyle(active: boolean): React.CSSProperties {
  return {
    minWidth: 20,
    height: 20,
    padding: "0 6px",
    borderRadius: 10,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 11,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    background: active ? "rgba(255,255,255,.25)" : "var(--hover)",
    color: active ? "var(--accentTx)" : "var(--muted)",
  };
}

export function NewsView() {
  const [rubric, setRubric] = useState<string>("all");
  const [items, setItems] = useState<NewsItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<NewsResponse>(`/api/news?rubric=${encodeURIComponent(rubric)}`)
      .then((res) => {
        if (cancelled) return;
        setItems(res.items ?? []);
        setCounts(res.counts ?? {});
      })
      .catch(() => {
        if (cancelled) return;
        setError("Не вдалося завантажити новини. Спробуйте пізніше.");
        setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rubric]);

  const countFor = (key: string): number =>
    key === "all" ? counts.total ?? 0 : counts[key] ?? 0;

  return (
    <div style={{ height: "100%", overflowY: "auto", minHeight: 0 }}>
      {/* Sticky header: title + one-line horizontally scrolling filter row */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          background: "var(--chat)",
          borderBottom: "1px solid var(--border)",
          padding: "22px 34px 14px",
        }}
      >
        <h1 style={{ margin: "0 0 4px", fontWeight: 700, fontSize: 27, color: "var(--text)" }}>
          Свіжі новини логістики та ЗЕД
        </h1>
        <p
          style={{
            margin: "0 0 16px",
            fontSize: 14.5,
            color: "var(--muted)",
            lineHeight: 1.5,
            textWrap: "pretty",
          }}
        >
          Ключові оновлення по митниці, транзиту ЄС, портах, санкціях, фрахтових ставках та
          фарм/хім регулюванню.
        </p>
        <div style={{ display: "flex", gap: 9, overflowX: "auto", paddingBottom: 2 }}>
          {FILTER_KEYS.map((key) => {
            const active = rubric === key;
            return (
              <button key={key} onClick={() => setRubric(key)} style={pillStyle(active)}>
                {newsRubricLabel(key)}
                <span style={countStyle(active)}>{countFor(key)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Body: loading / error / empty / card grid */}
      <div style={{ padding: "22px 34px 44px" }}>
        {loading ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              padding: 48,
              color: "var(--muted)",
              fontSize: 13,
            }}
          >
            <IconSpinner size={18} />
            Завантаження новин…
          </div>
        ) : error ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--err)", fontSize: 13 }}>
            {error}
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
            Новин поки немає — стрічка оновлюється щопівгодини.
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill,minmax(320px,1fr))",
              gap: 16,
            }}
          >
            {items.map((n) => {
              const color = newsRubricColor(n.rubric);
              return (
                <a
                  key={n.id}
                  href={n.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="news-card"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 11,
                    padding: "18px 19px",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 16,
                    textDecoration: "none",
                    transition: "border-color .12s, transform .12s",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{ width: 7, height: 7, borderRadius: "50%", background: color }}
                    />
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: ".3px",
                        color,
                        textTransform: "uppercase",
                      }}
                    >
                      {newsRubricLabel(n.rubric)}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 16,
                      fontWeight: 600,
                      lineHeight: 1.32,
                      color: "var(--text)",
                      textWrap: "pretty",
                    }}
                  >
                    {n.title}
                  </div>
                  <div
                    style={{
                      fontSize: 13.5,
                      lineHeight: 1.5,
                      color: "var(--muted)",
                      textWrap: "pretty",
                    }}
                  >
                    {n.summary}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginTop: "auto",
                      paddingTop: 6,
                      fontSize: 11.5,
                      color: "var(--faint)",
                    }}
                  >
                    <span style={{ fontWeight: 600, color: "var(--muted)" }}>{n.source}</span>·
                    <span>{relativeTimeUk(n.published_at)}</span>
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
