import { test, expect, type Page } from "@playwright/test";
import { mockWorkspace, WSID } from "./mocks";

/**
 * S9: security headers are sent, and the Content-Security-Policy doesn't break
 * the app — login, a workspace page, the map and a PDF preview load without
 * any CSP violation in the console.
 */

// Minimal valid one-page PDF.
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF\n",
  "latin1"
);

function collectCspErrors(page: Page): string[] {
  const errs: string[] = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to (load|execute|connect|frame|apply)/i.test(t)) errs.push(t);
  });
  return errs;
}

test("security headers are sent on every page", async ({ page }) => {
  const res = await page.goto("/login");
  const h = res!.headers();
  expect(h["x-powered-by"]).toBeUndefined();
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBe("same-origin");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["permissions-policy"]).toContain("camera=()");
  const csp = h["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'self' blob:");
});

test("login renders without CSP violations", async ({ page }) => {
  const errs = collectCspErrors(page);
  await page.route("**/api/auth/methods", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: '{"codeLogin":false,"codeLength":null}' })
  );
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Вхід" })).toBeVisible();
  expect(errs).toEqual([]);
});

test("workspace, map and PDF preview render without CSP violations", async ({ page }) => {
  const errs = collectCspErrors(page);
  await mockWorkspace(page, (route, pathname, method) => {
    if (pathname === `/api/workspaces/${WSID}/files` && method === "GET") {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          files: [{ id: "p1", folderId: null, name: "invoice.pdf", type: "pdf", status: "ready" }],
        }),
      });
      return true;
    }
    if (pathname === `/api/workspaces/${WSID}/files/p1/content`) {
      void route.fulfill({ status: 200, contentType: "application/pdf", body: PDF });
      return true;
    }
    return false;
  });

  await page.goto(`/workspaces/${WSID}`);
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // PDF preview: rendered through <object type="application/pdf"> on a blob: URL.
  await page.getByRole("button", { name: "invoice.pdf" }).first().click();
  const pdf = page.getByTestId("pdf-preview");
  await expect(pdf).toBeVisible();
  await expect(pdf).toHaveAttribute("data", /^blob:/);
  await page.getByRole("button", { name: "Закрити", exact: true }).click();

  // Map view (Leaflet + external tiles).
  await page.getByRole("button", { name: "Карта", exact: true }).click();
  await expect(page.locator(".leaflet-container")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1_000);

  expect(errs).toEqual([]);
});
