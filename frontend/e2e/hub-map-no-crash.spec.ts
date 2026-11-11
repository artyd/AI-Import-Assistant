import { test, expect } from "@playwright/test";
import { mockWorkspace } from "./mocks";
import { WSID } from "./mocks";

/**
 * Guard: the map must not throw when the hub snapshot arrives incomplete.
 * mockWorkspace answers unmocked endpoints with `{}`, so /api/hub/live has no
 * `vessels` — HubCanvas used to read `snap.vessels.length` during render and the
 * whole page died with "Application error" (only when the response landed before
 * the test finished looking at the map, hence the intermittent CI failure).
 */
test("map survives an incomplete hub snapshot", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await mockWorkspace(page);
  await page.goto(`/workspaces/${WSID}`);
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await page.getByRole("button", { name: "Карта", exact: true }).click();
  await expect(page.locator(".leaflet-container")).toBeVisible({ timeout: 15_000 });
  // Let the (empty) live snapshot and the other hub polls land and re-render.
  await expect.poll(() => page.getByText("AIS:").count(), { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(page.locator(".leaflet-container")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
