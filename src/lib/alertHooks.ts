import type { FastifyInstance } from 'fastify';
import { notifyOps, describeError, reportAnthropicError } from './alerts.js';

/**
 * Fastify hook: a 5xx response caused by a thrown error raises an ops alert.
 * onError only observes — the existing response behaviour is untouched.
 * 4xx (validation, auth, 404, 429 rate limits) never alert.
 */
export function registerOpsAlertHooks(app: FastifyInstance): void {
  app.addHook('onError', async (req, _reply, error) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) return;
    const route = req.routeOptions?.url ?? 'unmatched';
    notifyOps({
      source: 'backend',
      severity: 'error',
      title: `${req.method} ${route} → ${status}`,
      detail: describeError(error),
      key: `5xx:${req.method}:${route}`,
    });
  });
}

/**
 * A chat turn that ended with a server-side failure (the SSE `error` event).
 * User aborts do not alert; an Anthropic outage was already reported under its
 * own key, so it is not repeated as a generic chat failure.
 */
export function alertChatFailure(opts: {
  kind: 'supply' | 'normal' | 'consolidated';
  workspaceId?: string | null;
  aborted?: boolean;
  /** Thrown error (catch path). */
  err?: unknown;
  /** Error message from the agent turn result (result.error path). */
  message?: string;
  anthropicHandled?: boolean;
}): void {
  if (opts.aborted) return;
  if (opts.anthropicHandled) return;
  if (opts.err !== undefined && reportAnthropicError(opts.err, 'chat')) return;
  notifyOps({
    source: 'chat',
    severity: 'error',
    title: `хід чату не вдався (${opts.kind})`,
    detail: opts.err !== undefined ? describeError(opts.err) : opts.message,
    key: `chat-failed:${opts.kind}`,
    workspaceId: opts.workspaceId ?? null,
  });
}
