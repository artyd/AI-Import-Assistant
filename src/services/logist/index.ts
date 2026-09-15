import { config } from '../../config.js';

/**
 * Thin client for the internal `logist-mcp` service (plain-REST over the Compose
 * network, no MCP session handshake). Exposes customs/logistics reference lookups
 * — УКТ ЗЕД duty/VAT, dual-use classifier, NBU exchange rate, PubChem substance
 * identification — that the Штурман agent calls as tools.
 *
 * Enabled only when LOGIST_MCP_URL is set (empty = the agent advertises no logist
 * tools). All upstreams are public read-only sources; nothing here is exposed to
 * the browser or the shared host.
 */

const TIMEOUT_MS = 20_000;

export function logistEnabled(): boolean {
  return config.LOGIST_MCP_URL.trim().length > 0;
}

export interface LogistLink {
  id: string;
  label: string;
}

export interface UktzedLookupResult {
  code: string;
  text: string;
  source: string;
}

export interface BrowseResult {
  code?: string;
  node_id?: string;
  text: string;
  links: LogistLink[];
  source: string;
}

export interface RateResult {
  currency: string;
  date: string;
  text: string;
}

export interface PubchemResult {
  identifier: string;
  text: string;
}

/**
 * GET a REST endpoint and return the parsed JSON. The service reports domain
 * problems (bad input, upstream 404/timeout) as `{ error }`; we surface that
 * message verbatim so the agent can relay a clean reason. Network/parse failures
 * throw a friendly Ukrainian message.
 */
async function logistGet<T>(path: string, params: Record<string, string>): Promise<T> {
  if (!logistEnabled()) {
    throw new Error('Сервіс довідок не налаштований (LOGIST_MCP_URL).');
  }
  const base = config.LOGIST_MCP_URL.replace(/\/+$/, '');
  const qs = new URLSearchParams(params).toString();
  const url = `${base}${path}${qs ? `?${qs}` : ''}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
  } catch (err) {
    throw new Error(`Сервіс довідок недоступний: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let body: unknown = {};
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error('Некоректна відповідь сервісу довідок.');
    }
  }
  if (body && typeof body === 'object' && 'error' in body) {
    throw new Error(String((body as { error: unknown }).error));
  }
  if (!res.ok) {
    throw new Error(`Сервіс довідок повернув HTTP ${res.status}.`);
  }
  return body as T;
}

export function uktzedLookup(code: string): Promise<UktzedLookupResult> {
  return logistGet<UktzedLookupResult>('/rest/uktzed/lookup', { code });
}

export function uktzedBrowse(code: string): Promise<BrowseResult> {
  return logistGet<BrowseResult>('/rest/uktzed/browse', code ? { code } : {});
}

export function dualuseBrowse(nodeId: string): Promise<BrowseResult> {
  return logistGet<BrowseResult>('/rest/dualuse', nodeId ? { node_id: nodeId } : {});
}

export function exchangeRate(currency: string, date: string): Promise<RateResult> {
  const params: Record<string, string> = { currency };
  if (date) params.date = date;
  return logistGet<RateResult>('/rest/rate', params);
}

export function pubchemIdentify(identifier: string): Promise<PubchemResult> {
  return logistGet<PubchemResult>('/rest/pubchem', { identifier });
}
