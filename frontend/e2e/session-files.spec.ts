import { test, expect } from "@playwright/test";
import { mockWorkspace, sse, WSID } from "./mocks";

/**
 * Live file-status channel (SSE ticket + events), global 401 handling, and the
 * upload size pre-filter — backend mocked with page.route.
 */

test("file_status events update the file tree; the EventSource uses a ticket, not the JWT", async ({
  page,
}) => {
  const eventUrls: string[] = [];
  let ticketCalls = 0;
  await mockWorkspace(page, (route, pathname) => {
    if (pathname === "/api/auth/sse-ticket") {
      ticketCalls += 1;
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ticket: `tkt-${ticketCalls}` }),
      });
      return true;
    }
    if (pathname === `/api/workspaces/${WSID}/files` && route.request().method() === "GET") {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          files: [{ id: "f1", folderId: null, name: "invoice.pdf", type: "pdf", status: "indexing" }],
        }),
      });
      return true;
    }
    if (pathname.endsWith("/events")) {
      eventUrls.push(route.request().url());
      void route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse([
          { event: "file_status", data: { fileId: "f1", status: "ready" } },
          { event: "file_status", data: { fileId: "f2", status: "queued", name: "cmr.pdf" } },
        ]),
      });
      return true;
    }
    return false;
  });

  await page.goto(`/workspaces/${WSID}`);

  // The event flips f1 to ready ("Готовий") and adds f2 to the tree.
  await expect(page.getByText("cmr.pdf").first()).toBeVisible();
  await expect(page.locator('.dot[title="Готовий"]').first()).toBeVisible();

  expect(eventUrls.length).toBeGreaterThan(0);
  const first = new URL(eventUrls[0]!);
  expect(first.searchParams.get("ticket")).toMatch(/^tkt-\d+$/);
  expect(first.searchParams.has("access_token")).toBe(false);
  expect(eventUrls[0]).not.toContain("test-token");

  // The mocked stream closes right away → the channel reconnects with a FRESH ticket.
  await expect.poll(() => eventUrls.length, { timeout: 8_000 }).toBeGreaterThan(1);
  expect(new URL(eventUrls[1]!).searchParams.get("ticket")).not.toBe(
    first.searchParams.get("ticket")
  );
});

test("a 401 mid-session drops the token and redirects to /login", async ({ page }) => {
  await mockWorkspace(page, (route, pathname, method) => {
    if (pathname === `/api/workspaces/${WSID}/chat` && method === "POST") {
      void route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "unauthorized" }),
      });
      return true;
    }
    return false;
  });
  await page.goto(`/workspaces/${WSID}`);
  const input = page.getByTestId("chat-input");
  await expect(input).toBeVisible();

  await input.fill("Питання");
  await page.getByRole("button", { name: "Надіслати" }).click();

  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(() => localStorage.getItem("aia_token"))).toBeNull();
});

test("a 502 HTML error page from the proxy doesn't crash api() (no SyntaxError)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mockWorkspace(page, (route, pathname) => {
    if (pathname.endsWith("/checklist")) {
      void route.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad Gateway</html>" });
      return true;
    }
    return false;
  });
  await page.goto(`/workspaces/${WSID}`);
  await expect(page.getByTestId("chat-input")).toBeVisible();
  expect(errors.filter((m) => /SyntaxError|JSON/.test(m))).toEqual([]);
});

test("oversize files are skipped before upload and reported", async ({ page }) => {
  const uploaded: string[] = [];
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await mockWorkspace(page, (route, pathname, method) => {
    if (pathname === `/api/workspaces/${WSID}/files` && method === "POST") {
      const body = route.request().postDataBuffer()?.toString("latin1") ?? "";
      for (const m of body.matchAll(/filename="([^"]+)"/g)) uploaded.push(m[1]!);
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          files: [{ id: "f9", folderId: null, name: "small.pdf", type: "pdf", status: "queued" }],
        }),
      });
      return true;
    }
    return false;
  });
  await page.goto(`/workspaces/${WSID}`);
  const chat = page.getByTestId("chat-root");
  await expect(chat).toBeVisible();

  // Drop a small PDF plus a 101 MB PDF (over the 100 MB per-file limit).
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File([new Uint8Array([1, 2, 3])], "small.pdf", { type: "application/pdf" }));
    d.items.add(
      new File([new Uint8Array(101 * 1024 * 1024)], "huge.pdf", { type: "application/pdf" })
    );
    return d;
  });
  await chat.dispatchEvent("dragenter", { dataTransfer: dt });
  await chat.dispatchEvent("drop", { dataTransfer: dt });
  await expect(page.getByTestId("composer-pending")).toContainText("huge.pdf");

  const uploadReq = page.waitForRequest(
    (r) => r.url().endsWith(`/workspaces/${WSID}/files`) && r.method() === "POST"
  );
  await page.getByRole("button", { name: "Надіслати" }).click();
  await uploadReq;

  const banner = page.getByTestId("notice-banner");
  await expect(banner).toContainText("завеликий");
  await expect(banner).toContainText("huge.pdf");
  expect(uploaded).toEqual(["small.pdf"]);
  // Reported in the in-app banner — no blocking alert() dialog.
  expect(dialogs).toEqual([]);
});
