import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mockWorkspace, WSID } from "./mocks";

/**
 * Logistics hub (map) — functional + visual checks against a mocked backend.
 * The live fixture is generated from the backend's own geometry (sea lanes via
 * Suez / around the Cape, an air great-circle, a road leg) so what renders is
 * what production would draw. Screenshots land in test-results/hub-*.png for
 * a visual review.
 */

const LIVE = JSON.parse(readFileSync(join(__dirname, "fixtures", "hub-live.json"), "utf8"));

const EVENTS = [
  { id: "e1", at: "2026-09-16T08:00:00Z", location: "Ningbo, CN", lat: 29.93, lng: 121.85, description: "Завантажено на судно", planned: false },
  { id: "e2", at: "2026-09-17T02:00:00Z", location: "Ningbo, CN", lat: 29.93, lng: 121.85, description: "Відхід судна", planned: false },
  { id: "e3", at: "2026-10-01T10:00:00Z", location: "Port Said, EG", lat: 31.26, lng: 32.31, description: "Прохід Суецького каналу", planned: false },
  { id: "e4", at: "2026-10-20T06:00:00Z", location: "Odesa, UA", lat: 46.49, lng: 30.75, description: "Прибуття судна", planned: true },
];

interface HubMockState {
  added: unknown[];
}

async function mockHub(page: Page, state: HubMockState = { added: [] }) {
  await mockWorkspace(page, async (route, pathname, method) => {
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/hub/live") return (await json(LIVE), true);
    if (pathname === "/api/map/ports") return (await json({ ports: [] }), true);
    if (pathname === "/api/hub/carriers")
      return (
        await json({
          carriers: [
            { id: "maersk", name: "Maersk", mode: "sea" },
            { id: "msc", name: "MSC", mode: "sea" },
            { id: "qr", name: "Qatar Airways Cargo", mode: "air" },
            { id: "novaposhta", name: "Нова Пошта", mode: "domestic" },
            { id: "dhl", name: "DHL Express", mode: "courier" },
          ],
        }),
        true
      );
    if (pathname === "/api/hub/detect") {
      const n = new URL(route.request().url()).searchParams.get("number") ?? "";
      const candidates = n.toUpperCase().startsWith("MSKU")
        ? [{ carrier: "maersk", carrierName: "Maersk", kind: "container", mode: "sea", confidence: 1 }]
        : [];
      return (await json({ normalized: n.toUpperCase(), candidates }), true);
    }
    if (pathname === "/api/hub/tracks" && method === "POST") {
      const body = route.request().postDataJSON() as { number: string };
      state.added.push(body);
      const track = { ...LIVE.items[0], id: "t-new", number: body.number.toUpperCase(), label: "" };
      return (await json({ track, events: [] }, 201), true);
    }
    const m = pathname.match(/^\/api\/hub\/tracks\/([\w-]+)$/);
    if (m && method === "GET") {
      const track = LIVE.items.find((t: { id: string }) => t.id === m[1]) ?? LIVE.items[0];
      return (await json({ track, events: track.id === "t1" ? EVENTS : [] }), true);
    }
    if (pathname === `/api/workspaces/${WSID}/tracking-suggestions`)
      return (
        await json({
          suggestions: [
            { number: "CSQU3054383", carrier: "sea-generic", carrierName: "Морська лінія (не визначено)", kind: "container", mode: "sea", files: ["BL.pdf"] },
          ],
        }),
        true
      );
    return false;
  });
}

async function openHub(page: Page) {
  await page.goto(`/workspaces/${WSID}`);
  await page.getByRole("button", { name: "Карта", exact: true }).first().click();
  await expect(page.getByTestId("hub-map")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".leaflet-container")).toBeVisible();
}

test.describe("Logistics hub", () => {
  test("renders tracked items, live markers, routes and the dispatcher HUD", async ({ page }, info) => {
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" && !/tile|arcgisonline|favicon|Failed to load resource/i.test(m.text())) consoleErrors.push(m.text());
    });
    await mockHub(page);
    await openHub(page);

    // One row per tracked item; one map marker per positioned item (t6 has none).
    await expect(page.getByTestId("hub-track-row")).toHaveCount(6);
    await expect(page.locator(".hub-mk")).toHaveCount(5);
    // Route lines are drawn (traveled + "marching ants" remaining).
    expect(await page.locator("path.hub-ants").count()).toBeGreaterThan(2);
    // Ambient AIS vessels appear from regional zoom (hidden on the world view).
    expect(await page.locator(".hub-ais").count()).toBe(0);
    for (let i = 0; i < 4 && (await page.locator(".hub-ais").count()) === 0; i += 1) {
      await page.getByRole("button", { name: "Збільшити" }).click();
      await page.waitForTimeout(450);
    }
    expect(await page.locator(".hub-ais").count()).toBeGreaterThan(0);

    if (info.project.name !== "mobile") {
      const hud = page.getByTestId("hub-hud");
      await expect(hud).toContainText("в дорозі");
      await expect(hud).toContainText("AIS:");
    }
    // Layers live in a compact menu.
    await page.getByRole("button", { name: /Шари/ }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: /Судна AIS/ })).toBeVisible();
    await page.getByRole("button", { name: /Шари/ }).click();
    await page.waitForTimeout(1600); // let glides settle for the screenshot
    await page.screenshot({ path: `test-results/hub-overview-${info.project.name}.png` });
    expect(consoleErrors).toEqual([]);
  });

  test("detects the carrier while typing and adds a track", async ({ page }, info) => {
    const state: HubMockState = { added: [] };
    await mockHub(page, state);
    await openHub(page);
    const input = page.getByTestId("hub-number-input");
    await input.fill("MSKU1234565");
    await expect(page.getByTestId("hub-detect")).toContainText("Maersk · контейнер ✓");
    await page.screenshot({ path: `test-results/hub-detect-${info.project.name}.png` });
    await page.getByRole("button", { name: "Відстежувати", exact: true }).click();
    await expect.poll(() => state.added.length).toBe(1);
    expect(state.added[0]).toMatchObject({ number: "MSKU1234565", workspaceId: WSID });
  });

  test("offers numbers found in the shipment documents", async ({ page }) => {
    await mockHub(page);
    await openHub(page);
    const box = page.getByTestId("hub-suggestions");
    await expect(box).toContainText("CSQU3054383");
    await expect(box.getByRole("button", { name: "Відстежувати CSQU3054383" })).toBeVisible();
  });

  test("opens a track card with timeline, source and ETA shift", async ({ page }, info) => {
    await mockHub(page);
    await openHub(page);
    await page.getByTestId("hub-track-row").first().click();
    const card = page.getByTestId("hub-track-detail");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Метопрен, партія 2");
    await expect(card).toContainText("API · maersk");
    await expect(card).toContainText("ETA зсунулась на +3 дн.");
    await expect(card).toContainText("Орієнтовно");
    await expect(page.getByTestId("hub-timeline").locator("li")).toHaveCount(4);
    await expect(card.getByRole("link", { name: "Сайт перевізника ↗" })).toHaveAttribute("href", /maersk\.com/);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `test-results/hub-detail-${info.project.name}.png` });
    await card.getByRole("button", { name: "Закрити" }).click();
    await expect(card).toBeHidden();
  });

  test("never invents a status when the carrier gave no data", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "list-driven check");
    await mockHub(page);
    await openHub(page);
    await page.getByRole("tab", { name: /Увага/ }).click();
    const row = page.getByTestId("hub-track-row").filter({ hasText: "HLCU1234567" });
    await expect(row).toContainText("Немає даних від перевізника");
    await row.click();
    await expect(page.getByTestId("hub-track-detail")).toContainText("Штурман не вгадує статус");
  });
});
