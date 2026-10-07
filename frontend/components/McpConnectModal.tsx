"use client";

// «Підключити MCP» — self-service link to Штурман's MCP server plus a step-by-step
// guide for the common clients, in one window. The backend stores only a hash of
// the token, so the full link is shown once (right after it is issued); after that
// the user sees its tail and can re-issue (which revokes the old link) or revoke.
//
// Wire: GET/POST/DELETE /api/mcp-token → { exists, hint, createdAt, lastUsedAt }
// (+ { token, path } on POST). The link is `${origin}${path}`.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { IconSpinner } from "./icons";
import { LnCheck, LnCopy } from "./LineIcons";

interface TokenStatus {
  exists: boolean;
  hint: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
}

type Client = "claude" | "claudeCode" | "cursor" | "vscode";

const CLIENTS: [Client, string][] = [
  ["claude", "Claude"],
  ["claudeCode", "Claude Code"],
  ["cursor", "Cursor"],
  ["vscode", "VS Code"],
];

const TOOLS = [
  "Митна довідка за кодом УКТ ЗЕД — мито, ПДВ, пільги, ліцензування, обмеження, документи (qdpro.com.ua)",
  "Навігація по класифікатору УКТ ЗЕД",
  "Список товарів подвійного використання",
  "Офіційний курс НБУ на дату",
  "Ідентифікація речовини за назвою / CAS (PubChem)",
  "Перевірка реєстрації лікарського засобу в Держреєстрі",
];

const PLACEHOLDER = "https://…/api/mcp/<ваш-токен>";

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("uk-UA", { dateStyle: "medium", timeStyle: "short" });
}

export function McpConnectModal({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<TokenStatus | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<Client>("claude");

  useEffect(() => {
    let alive = true;
    api<TokenStatus>("/api/mcp-token")
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setError("Не вдалося завантажити стан підключення."));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const issue = async () => {
    if (status?.exists && !window.confirm("Старе посилання перестане працювати. Згенерувати нове?")) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<TokenStatus & { path: string }>("/api/mcp-token", { method: "POST" });
      setStatus(r);
      setUrl(`${window.location.origin}${r.path}`);
    } catch {
      setError("Не вдалося отримати посилання. Спробуйте ще раз.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!window.confirm("Відкликати посилання? Підключені клієнти втратять доступ.")) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await api<TokenStatus>("/api/mcp-token", { method: "DELETE" }));
      setUrl(null);
    } catch {
      setError("Не вдалося відкликати посилання.");
    } finally {
      setBusy(false);
    }
  };

  const link = url ?? PLACEHOLDER;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "grid", placeItems: "center", zIndex: 120, padding: 20 }}
    >
      <div
        className="m-enter"
        role="dialog"
        aria-label="Підключити Штурман MCP"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 640, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "var(--radius)", boxShadow: "var(--shadow)", padding: 20, display: "flex", flexDirection: "column", gap: 16 }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontWeight: 600, fontFamily: "var(--font-display)", fontSize: 16 }}>Підключити Штурман MCP</div>
          <button className="btn-icon" onClick={onClose} aria-label="Закрити">✕</button>
        </div>

        <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}>
          Підключіть Штурман до свого AI-асистента (Claude, Cursor, VS Code…) і перевіряйте коди
          УКТ ЗЕД та інші довідки прямо з нього. Доступні інструменти:
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {TOOLS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>

        {/* Step 1 — the link */}
        <Step n={1} title="Отримайте посилання">
          {status === null && !error ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--muted)" }}>
              <IconSpinner size={16} /> Завантаження…
            </div>
          ) : url ? (
            <>
              <CopyField value={url} />
              <Note>
                Збережіть посилання зараз — повністю воно показується лише один раз. Це ваш особистий
                ключ доступу: не публікуйте його.
              </Note>
            </>
          ) : status?.exists ? (
            <Note>
              Посилання вже видано (закінчується на <b>…{status.hint}</b>, створено {fmt(status.createdAt)},
              востаннє використано {fmt(status.lastUsedAt)}). Повністю воно показується лише при створенні —
              якщо ви його не зберегли, згенеруйте нове.
            </Note>
          ) : (
            <Note>У вас ще немає посилання. Натисніть кнопку — воно зʼявиться тут.</Note>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={issue} disabled={busy || status === null}>
              {busy ? <IconSpinner size={15} /> : null}
              {status?.exists ? "Згенерувати нове посилання" : "Отримати посилання"}
            </button>
            {status?.exists && (
              <button className="btn" onClick={revoke} disabled={busy}>
                Відкликати
              </button>
            )}
          </div>
          {error && (
            <div style={{ padding: "8px 12px", background: "var(--errBg)", color: "var(--err)", borderRadius: 9, fontSize: 12.5 }}>
              {error}
            </div>
          )}
        </Step>

        {/* Step 2 — client-specific guide */}
        <Step n={2} title="Додайте його у свій клієнт">
          <div style={{ display: "flex", gap: 4, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 3 }}>
            {CLIENTS.map(([k, label]) => (
              <button
                key={k}
                onClick={() => setClient(k)}
                style={{
                  flex: 1,
                  height: 30,
                  borderRadius: 8,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12.5,
                  fontWeight: 600,
                  background: client === k ? "var(--accent)" : "transparent",
                  color: client === k ? "var(--accentTx)" : "var(--muted)",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <Guide client={client} link={link} />
        </Step>

        {/* Step 3 — try it */}
        <Step n={3} title="Перевірте">
          <Note>Відкрийте новий чат у клієнті та напишіть, наприклад:</Note>
          <CopyField value="Через Штурман: яке мито, ПДВ і які документи потрібні для імпорту коду УКТ ЗЕД 2941 10 00 00?" />
          <CopyField value="Через Штурман: ідентифікуй речовину за CAS 50-78-2 і запропонуй кандидатів коду УКТ ЗЕД" />
          <Note>
            Підбір коду — довідковий: остаточно код підтверджує митний фахівець.
          </Note>
        </Step>
      </div>
    </div>
  );
}

function Guide({ client, link }: { client: Client; link: string }) {
  switch (client) {
    case "claude":
      return (
        <Steps
          items={[
            <>Відкрийте claude.ai або Claude Desktop → <b>Settings</b> (Налаштування) → <b>Connectors</b>.</>,
            <>Натисніть <b>Add custom connector</b>.</>,
            <>Назва: <b>Shturman</b>; у поле <b>Remote MCP server URL</b> вставте посилання з кроку 1. Натисніть <b>Add</b>.</>,
            <>У новому чаті натисніть кнопку інструментів (≡ / «+» → Connectors) і переконайтесь, що <b>Shturman</b> увімкнено.</>,
          ]}
        />
      );
    case "claudeCode":
      return (
        <>
          <Steps items={[<>У терміналі виконайте команду:</>]} />
          <CopyField value={`claude mcp add --transport http shturman ${link}`} mono />
          <Steps start={2} items={[<>Перезапустіть Claude Code і перевірте командою <code>/mcp</code> — сервер <b>shturman</b> має бути «connected».</>]} />
        </>
      );
    case "cursor":
      return (
        <>
          <Steps
            items={[
              <>Cursor → <b>Settings</b> → <b>MCP & Integrations</b> → <b>Add Custom MCP</b> (відкриється файл <code>~/.cursor/mcp.json</code>).</>,
              <>Додайте сервер і збережіть файл:</>,
            ]}
          />
          <CopyField value={JSON.stringify({ mcpServers: { shturman: { url: link } } }, null, 2)} mono multiline />
          <Steps start={3} items={[<>Поверніться в налаштування MCP — біля <b>shturman</b> має світитися зелений індикатор.</>]} />
        </>
      );
    case "vscode":
      return (
        <>
          <Steps
            items={[
              <>Палітра команд (Ctrl+Shift+P) → <b>MCP: Open User Configuration</b>.</>,
              <>Додайте сервер і збережіть файл:</>,
            ]}
          />
          <CopyField value={JSON.stringify({ servers: { shturman: { type: "http", url: link } } }, null, 2)} mono multiline />
          <Steps start={3} items={[<>Відкрийте Copilot Chat у режимі <b>Agent</b> → кнопка інструментів → увімкніть <b>shturman</b>.</>]} />
        </>
      );
  }
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "flex", gap: 12 }}>
      <span
        style={{ flex: "none", width: 24, height: 24, borderRadius: "50%", background: "var(--accentSoft)", color: "var(--accent)", fontWeight: 700, fontSize: 12.5, display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        {n}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontWeight: 600, fontSize: 14, lineHeight: "24px" }}>{title}</div>
        {children}
      </div>
    </section>
  );
}

function Steps({ items, start = 1 }: { items: React.ReactNode[]; start?: number }) {
  return (
    <ol start={start} style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.6, display: "flex", flexDirection: "column", gap: 4 }}>
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ol>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.55 }}>{children}</div>;
}

function CopyField({ value, mono, multiline }: { value: string; mono?: boolean; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the text stays selectable */
    }
  };
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: "8px 8px 8px 12px" }}>
      <code
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: mono || !multiline ? "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" : undefined,
          fontSize: 12.5,
          lineHeight: 1.5,
          whiteSpace: multiline ? "pre" : "normal",
          overflowX: multiline ? "auto" : undefined,
          wordBreak: multiline ? undefined : "break-all",
          paddingTop: 5,
          userSelect: "all",
        }}
      >
        {value}
      </code>
      <button className="btn-icon" onClick={copy} title={copied ? "Скопійовано" : "Копіювати"} aria-label="Копіювати" style={{ flex: "none" }}>
        {copied ? <LnCheck size={16} /> : <LnCopy size={16} />}
      </button>
    </div>
  );
}
