import { config } from './config.js';
import { query } from '../db/pool.js';

/**
 * Ops alerts: production failures land in the in-app bell (notifications,
 * type `ops_alert`) of the admins, and are always logged as one structured line
 * (`ops_alert=true`) so `docker compose logs | grep ops_alert` is the history.
 * Never throws, never blocks the caller (fire-and-forget).
 */

export type OpsSeverity = 'error' | 'warning' | 'info';

export interface OpsAlert {
  /** Area: chat | upload | ingest | worker | backend | process | anthropic | … */
  source: string;
  severity: OpsSeverity;
  title: string;
  /** Short technical detail (error class + message). Scrubbed + truncated. */
  detail?: string;
  /** Throttle key; default `source:title`. */
  key?: string;
  /** Shipment the failure belongs to (linked only for recipients who own it). */
  workspaceId?: string | null;
  /** Skip the throttle (alert:test). */
  force?: boolean;
}

export const OPS_ALERT_TYPE = 'ops_alert';
const RECIPIENT_TTL_MS = 5 * 60_000;
const DB_TIMEOUT_MS = 5_000;
const RETENTION_DAYS = 30;
const PURGE_EVERY_MS = 60 * 60_000;
const MAX_DETAIL = 500;

let role: 'backend' | 'worker' = 'backend';
export function setOpsRole(r: 'backend' | 'worker'): void {
  role = r;
}

// ---------------------------------------------------------------- privacy ----

/** Redacts anything that looks like a key, bearer token or JWT. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted-key]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');
}

export function sanitizeDetail(text: string, max = MAX_DETAIL): string {
  const clean = scrubSecrets(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** `ErrorClass: message` — no stack, no request data. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return sanitizeDetail(`${err.name}: ${err.message}`);
  return sanitizeDetail(String(err));
}

// ------------------------------------------------------------- throttling ----

interface ThrottleState {
  lastSent: number;
  suppressed: number;
}
const throttle = new Map<string, ThrottleState>();

/**
 * Pure throttle decision. Returns whether to deliver now and how many similar
 * alerts were swallowed since the previous delivery.
 */
export function throttleDecision(
  state: Map<string, ThrottleState>,
  key: string,
  now: number,
  windowMs: number,
): { send: boolean; suppressed: number } {
  const s = state.get(key);
  if (!s || now - s.lastSent >= windowMs) {
    const suppressed = s?.suppressed ?? 0;
    state.set(key, { lastSent: now, suppressed: 0 });
    return { send: true, suppressed };
  }
  s.suppressed += 1;
  return { send: false, suppressed: 0 };
}

// ------------------------------------------------------------- recipients ----

export function pickRecipients(users: { id: string; email: string }[], adminEmails: string): string[] {
  const wanted = adminEmails
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (wanted.length === 0) return users.map((u) => u.id); // small team: everyone
  return users.filter((u) => wanted.includes(u.email.toLowerCase())).map((u) => u.id);
}

let recipientCache: { ids: string[]; at: number } | null = null;

async function getRecipients(now: number): Promise<string[]> {
  if (recipientCache && now - recipientCache.at < RECIPIENT_TTL_MS) return recipientCache.ids;
  const { rows } = await query<{ id: string; email: string }>('SELECT id, email FROM users');
  const ids = pickRecipients(rows, config.OPS_ADMIN_EMAILS);
  recipientCache = { ids, at: now };
  return ids;
}

// ---------------------------------------------------------------- message ----

const SOURCE_LABEL: Record<string, string> = {
  chat: 'чат',
  upload: 'завантаження',
  ingest: 'обробка файлів',
  worker: 'фонова задача',
  backend: 'сервер',
  process: 'процес',
  anthropic: 'Anthropic',
};

export function formatMessage(a: OpsAlert, suppressed: number, at: Date): string {
  const prefix = a.severity === 'error' ? '⚠ Збій' : a.severity === 'warning' ? '⚠ Попередження' : 'ℹ Інфо';
  const time = at.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
  const detail = a.detail ? ` · ${sanitizeDetail(a.detail, 160)}` : '';
  const more = suppressed > 0 ? ` (+${suppressed} схожих)` : '';
  return `${prefix}: ${SOURCE_LABEL[a.source] ?? a.source} — ${sanitizeDetail(a.title, 120)}${detail} (${time})${more}`;
}

// --------------------------------------------------------------- delivery ----

function logAlert(a: OpsAlert, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    level: a.severity === 'error' ? 'error' : 'warn',
    ops_alert: true,
    role,
    source: a.source,
    severity: a.severity,
    title: sanitizeDetail(a.title, 200),
    detail: a.detail ? sanitizeDetail(a.detail) : undefined,
    key: a.key,
    workspaceId: a.workspaceId ?? undefined,
    ...extra,
  });
  // eslint-disable-next-line no-console
  (a.severity === 'error' ? console.error : console.warn)(line);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error('ops alert DB timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

let lastPurge = 0;

async function insertForRecipients(a: OpsAlert, message: string, now: number): Promise<number> {
  const ids = await getRecipients(now);
  if (ids.length === 0) return 0;

  // Link the shipment only for recipients who own it.
  let ownerId: string | null = null;
  if (a.workspaceId) {
    const { rows } = await query<{ owner_id: string }>('SELECT owner_id FROM workspaces WHERE id = $1', [
      a.workspaceId,
    ]);
    ownerId = rows[0]?.owner_id ?? null;
  }

  let inserted = 0;
  for (const userId of ids) {
    const ws = ownerId && ownerId === userId ? (a.workspaceId ?? null) : null;
    await query('INSERT INTO notifications (user_id, workspace_id, type, message) VALUES ($1, $2, $3, $4)', [
      userId,
      ws,
      OPS_ALERT_TYPE,
      message,
    ]);
    inserted++;
  }

  if (now - lastPurge > PURGE_EVERY_MS) {
    lastPurge = now;
    await query(`DELETE FROM notifications WHERE type = $1 AND created_at < now() - ($2 || ' days')::interval`, [
      OPS_ALERT_TYPE,
      String(RETENTION_DAYS),
    ]).catch(() => undefined);
  }
  return inserted;
}

/**
 * Awaitable variant (tests, alert:test, crash handlers). Resolves with the number
 * of notifications inserted (0 when throttled or on failure). Never rejects.
 */
export async function notifyOpsAsync(alert: OpsAlert): Promise<number> {
  try {
    const now = Date.now();
    const a: OpsAlert = { ...alert, key: alert.key ?? `${alert.source}:${alert.title}` };
    const windowMs = config.ALERT_THROTTLE_MINUTES * 60_000;
    const decision = alert.force
      ? { send: true, suppressed: 0 }
      : throttleDecision(throttle, a.key!, now, windowMs);

    logAlert(a, decision.send ? {} : { throttled: true });
    if (!decision.send) return 0;

    const message = formatMessage(a, decision.suppressed, new Date(now));
    try {
      return await withTimeout(insertForRecipients(a, message, now), DB_TIMEOUT_MS);
    } catch (err) {
      // DB down: the structured log line above is the fallback.
      logAlert(
        { source: 'backend', severity: 'error', title: 'ops alert not delivered to the bell', detail: describeError(err) },
        { delivery_failed: true },
      );
      return 0;
    }
  } catch {
    return 0; // never throws
  }
}

/** Fire-and-forget. Safe on any request path. */
export function notifyOps(alert: OpsAlert): void {
  void notifyOpsAsync(alert);
}

// ------------------------------------------------------- Anthropic outages ----

export interface AnthropicOutage {
  key: 'anthropic-auth' | 'anthropic-billing' | 'anthropic-overloaded';
  title: string;
  immediate: boolean;
}

/** Maps an Anthropic SDK error to an outage class, or null if it is not one. */
export function classifyAnthropicError(err: unknown): AnthropicOutage | null {
  const e = err as { status?: number; message?: string } | null;
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const msg = (e?.message ?? '').toLowerCase();
  if (status === 401 || status === 403) {
    return { key: 'anthropic-auth', title: 'Ключ Anthropic відхилено (401/403)', immediate: true };
  }
  if (status === 402 || /credit balance|billing|payment required/.test(msg)) {
    return { key: 'anthropic-billing', title: 'Anthropic: закінчились кошти / проблема з оплатою', immediate: true };
  }
  if (status === 429 || status === 529) {
    return { key: 'anthropic-overloaded', title: `Anthropic перевантажений (${status})`, immediate: false };
  }
  return null;
}

const overloadHits: number[] = [];
const OVERLOAD_WINDOW_MS = 10 * 60_000;
const OVERLOAD_THRESHOLD = 3;

/**
 * Call where an Anthropic call finally failed (after SDK retries). Alerts on
 * auth/billing at once and on 429/529 only when it repeats (sustained).
 * Returns true if the error was an outage class (so callers skip a generic alert).
 */
export function reportAnthropicError(err: unknown, source: string): boolean {
  try {
    const o = classifyAnthropicError(err);
    if (!o) return false;
    if (!o.immediate) {
      const now = Date.now();
      overloadHits.push(now);
      while (overloadHits.length && now - (overloadHits[0] ?? now) > OVERLOAD_WINDOW_MS) overloadHits.shift();
      if (overloadHits.length < OVERLOAD_THRESHOLD) return true;
    }
    notifyOps({ source: 'anthropic', severity: 'error', title: o.title, detail: `${source}: ${describeError(err)}`, key: o.key });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ process hooks ----

/** uncaughtException / unhandledRejection: alert, then exit(1) like Node's default. */
export function installProcessAlerts(r: 'backend' | 'worker'): void {
  setOpsRole(r);
  const crash = (kind: string) => (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`${kind}:`, err);
    const done = notifyOpsAsync({
      source: 'process',
      severity: 'error',
      title: `${r}: ${kind}`,
      detail: describeError(err),
      key: `process:${r}:${kind}`,
    });
    const cap = new Promise((res) => setTimeout(res, 3_000));
    void Promise.race([done, cap]).finally(() => process.exit(1));
  };
  process.on('uncaughtException', crash('uncaughtException'));
  process.on('unhandledRejection', crash('unhandledRejection'));
}

/** Test helper. */
export function _resetAlertsForTests(): void {
  throttle.clear();
  recipientCache = null;
  lastPurge = 0;
  overloadHits.length = 0;
}
