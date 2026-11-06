// API client for Поставки (spec 008). Separate from lib/api.ts on purpose: a
// 401 here must never log anyone out of Штурман, and the supply edit token lives
// under its own key. Reads are public; writes send the supply token, or the
// Штурман session token when there is one (a Штурман session may edit too).

import type { ShipmentDraft, SupplyData, SupplyMarks, SupplyHistoryEntry, SupplySettings, SupplyShipment } from "./types";

const SUPPLY_TOKEN_KEY = "supply_token";
const SHTURMAN_TOKEN_KEY = "aia_token";

export class SupplyApiError extends Error {
  constructor(public status: number, public code: string, public body?: Record<string, unknown>) {
    super(code);
  }
}

function read(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function getSupplyToken(): string | null {
  const raw = read(SUPPLY_TOKEN_KEY);
  if (!raw) return null;
  try {
    const { token, expiresAt } = JSON.parse(raw) as { token: string; expiresAt: string };
    if (Date.parse(expiresAt) > Date.now() + 60_000) return token;
  } catch {
    /* fall through */
  }
  setSupplyToken(null);
  return null;
}

export function setSupplyToken(t: { token: string; expiresAt: string } | null): void {
  try {
    if (t) window.localStorage.setItem(SUPPLY_TOKEN_KEY, JSON.stringify(t));
    else window.localStorage.removeItem(SUPPLY_TOKEN_KEY);
  } catch {
    /* storage blocked: editing just won't survive a reload */
  }
}

function authHeader(): Record<string, string> {
  const t = getSupplyToken() ?? read(SHTURMAN_TOKEN_KEY);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...authHeader() };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  let data: Record<string, unknown> | undefined;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) throw new SupplyApiError(res.status, (data?.error as string) || `http_${res.status}`, data);
  return data as T;
}

export const supplyApi = {
  load: () => call<SupplyData>("/api/supply"),
  revision: () => call<{ revision: string }>("/api/supply/revision"),
  session: () => call<{ canEdit: boolean; codeLogin: boolean; codeLength: number | null }>("/api/supply/session"),
  history: (shipmentId?: string) =>
    call<{ history: SupplyHistoryEntry[] }>(`/api/supply/history?limit=300${shipmentId ? `&shipmentId=${encodeURIComponent(shipmentId)}` : ""}`),
  unlock: (code: string) => call<{ token: string; expiresAt: string }>("/api/supply/unlock", { body: { code } }),
  create: (draft: ShipmentDraft) => call<{ shipment: SupplyShipment }>("/api/supply/shipments", { body: draft }),
  update: (id: string, patch: Partial<ShipmentDraft> & { expectedUpdatedAt?: string }) =>
    call<{ shipment: SupplyShipment }>(`/api/supply/shipments/${id}`, { method: "PATCH", body: patch }),
  marks: (id: string, marks: SupplyMarks) => call<{ shipment: SupplyShipment }>(`/api/supply/shipments/${id}/marks`, { method: "PATCH", body: marks }),
  archive: (id: string, archived: boolean) => call<{ shipment: SupplyShipment }>(`/api/supply/shipments/${id}/archive`, { body: { archived } }),
  saveSettings: (s: SupplySettings) => call<{ settings: SupplySettings }>("/api/supply/settings", { body: s }),
  undo: (historyId: number) => call<{ ok: true }>(`/api/supply/history/${historyId}/undo`, { body: {} }),
};
