import type { Page, Route } from "@playwright/test";

/**
 * Shared backend mock for the workspace page (same page.route pattern as
 * chat-upload.spec.ts). `overrides` get the first shot at every /api request;
 * return true when handled.
 */
export const WSID = "ws-test";
export const WS = {
  id: WSID,
  number: "2026-0001",
  supplier: "SupplierABC",
  status: "active",
  created_at: "2026-01-01T00:00:00.000Z",
};

export type Override = (route: Route, pathname: string, method: string) => Promise<boolean> | boolean;

export const sse = (records: { event: string; data: unknown }[]) =>
  records.map((r) => `event: ${r.event}\ndata: ${JSON.stringify(r.data)}\n\n`).join("");

export async function mockWorkspace(page: Page, override?: Override) {
  await page.addInitScript(() => {
    try {
      // Only seed the token on the first load of this test (a reload after a
      // forced logout must not resurrect the session).
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem("aia_token", "test-token");
        sessionStorage.setItem("seeded", "1");
      }
    } catch {
      /* ignore */
    }
  });

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    const method = req.method();
    if (override && (await override(route, pathname, method))) return;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

    if (pathname === "/api/auth/sse-ticket") return json({ ticket: "tkt-1" });
    // Live file-status channel — keep it quiet unless a test overrides it.
    if (pathname.endsWith("/events")) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": ok\n\n" });
    }
    if (pathname === "/api/auth/methods") return json({ codeLogin: false, codeLength: null });
    if (pathname === "/api/auth/me") return json({ user: { id: "u1", email: "t@t", name: "Тест" } });
    if (pathname === "/api/workspaces" && method === "GET") return json({ workspaces: [WS] });
    if (pathname === `/api/workspaces/${WSID}` && method === "GET")
      return json({ workspace: WS, folders: [] });
    if (pathname === `/api/workspaces/${WSID}/files` && method === "GET") return json({ files: [] });
    if (pathname === `/api/workspaces/${WSID}/conversations` && method === "GET")
      return json({ conversations: [] });
    if (pathname.endsWith("/checklist")) return json({ items: [], status: "docs_in_progress" });
    if (pathname === "/api/collections") return json({ collections: [] });
    return json({});
  });
}
