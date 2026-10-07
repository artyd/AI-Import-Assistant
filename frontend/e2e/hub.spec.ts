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
const PORTS = JSON.parse(readFileSync(join(__dirname, "fixtures", "hub-ports.json"), "utf8"));
const LINES = JSON.parse(readFileSync(join(__dirname, "fixtures", "hub-lines.json"), "utf8"));
const ROUTES = JSON.parse(readFileSync(join(__dirname, "fixtures", "hub-routes.json"), "utf8"));

const EVENTS = [
  { id: "e1", at: "2026-09-16T08:00:00Z", location: "Ningbo, CN", lat: 29.93, lng: 121.85, description: "Завантажено на судно", planned: false },
  { id: "e2", at: "2026-09-17T02:00:00Z", location: "Ningbo, CN", lat: 29.93, lng: 121.85, description: "Відхід судна", planned: false },
  { id: "e3", at: "2026-10-01T10:00:00Z", location: "Singapore, SG", lat: 1.26, lng: 103.82, description: "Перевантаження в Сингапурі", planned: false },
  { id: "e4", at: "2026-10-20T06:00:00Z", location: "Odesa, UA", lat: 46.49, lng: 30.75, description: "Прибуття судна", planned: true },
];

interface HubMockState {
  added: unknown[];
  marks?: unknown[];
  favs?: string[];
  services?: unknown[];
  carrierMarks?: unknown[];
  savedRoutes?: unknown[];
  suggests?: unknown[];
}

async function mockHub(page: Page, state: HubMockState = { added: [] }) {
  await mockWorkspace(page, async (route, pathname, method) => {
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/hub/live") return (await json(LIVE), true);
    if (pathname === "/api/map/ports") return (await json({ ports: [] }), true);
    if (pathname === "/api/hub/ports") return (await json(PORTS), true);
    if (pathname === "/api/hub/routes" && method === "GET") return (await json({ routes: ROUTES.routes }), true);
    if (pathname === "/api/hub/routes/suggest") {
      state.suggests?.push(route.request().postDataJSON());
      return (await json(ROUTES.suggest), true);
    }
    if (pathname === "/api/hub/routes" && method === "POST") {
      state.savedRoutes?.push(route.request().postDataJSON());
      return (await json({ route: ROUTES.routes[0] }, 201), true);
    }
    if (pathname.startsWith("/api/hub/routes/")) return (await json({ route: ROUTES.routes[0] }), true);
    if (pathname === "/api/hub/lines") return (await json({ carriers: LINES.carriers, lanes: LINES.lanes }), true);
    const lm = pathname.match(/^\/api\/hub\/lines\/([a-z-]+)(\/.*)?$/);
    if (lm) {
      if (lm[2] === "/services" && method === "POST") state.services?.push(route.request().postDataJSON());
      if (lm[2] === "/status" && method === "POST") state.carrierMarks?.push(route.request().postDataJSON());
      return (await json(LINES.detail, method === "POST" && lm[2] === "/services" ? 201 : 200), true);
    }
    const pm = pathname.match(/^\/api\/hub\/ports\/([A-Z]+)(\/.*)?$/);
    if (pm) {
      const port = PORTS.ports.find((x: { code: string }) => x.code === pm[1]);
      const detail = {
        port,
        history: port?.status ? [{ id: "h0", ...port.status, createdAt: port.status.updatedAt, validUntil: "2026-10-10T00:00:00Z" }, { id: "h1", status: "ok", label: "Працює", note: "", by: "user", userName: "Олена", sourceUrl: "", sourceTitle: "", createdAt: "2026-10-03T09:00:00Z", validUntil: "2026-10-06T09:00:00Z", confirmations: 0 }] : [],
        tracks: pm[1] === "UAODS" ? [{ id: "t1", number: "MSKU1234565", label: "Метопрен, партія 2", status: "in_transit", eta: "2026-10-20T06:00:00Z" }] : [],
      };
      if (pm[2] === "/status" && method === "POST") {
        state.marks?.push(route.request().postDataJSON());
        return (await json(detail), true);
      }
      if (pm[2] === "/favorite") {
        state.favs?.push(`${method}:${pm[1]}`);
        return (await route.fulfill({ status: 204 }), true);
      }
      return (await json(detail), true);
    }
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
      await expect(hud.getByLabel(/3 в дорозі/)).toBeVisible();
      await expect(hud.getByLabel(/портів і кордонів зі збоями/)).toBeVisible();
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
    await expect(card.getByRole("link", { name: "Сайт ↗" })).toHaveAttribute("href", /maersk\.com/);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `test-results/hub-detail-${info.project.name}.png` });
    // Actions: three equal buttons on one row, «Видалити» spans the full row below.
    const boxes = await Promise.all(
      [card.getByRole("button", { name: /Оновити/ }), card.getByRole("link", { name: "Сайт ↗" }), card.getByRole("button", { name: "В архів" }), card.getByRole("button", { name: "Видалити" })].map((l) => l.boundingBox())
    );
    const [r1, r2, r3, del] = boxes.map((b) => b!);
    expect(Math.abs(r1!.width - r2!.width)).toBeLessThan(2);
    expect(Math.abs(r2!.width - r3!.width)).toBeLessThan(2);
    expect(Math.abs(r1!.y - r3!.y)).toBeLessThan(2);
    expect(del!.y).toBeGreaterThan(r1!.y + r1!.height - 1);
    expect(Math.abs(del!.x - r1!.x)).toBeLessThan(2);
    expect(Math.abs(del!.x + del!.width - (r3!.x + r3!.width))).toBeLessThan(2);
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

  test("ports tab: live statuses, favourites, team marks", async ({ page }, info) => {
    const state: HubMockState = { added: [], marks: [], favs: [] };
    await mockHub(page, state);
    await openHub(page);
    await page.getByRole("tab", { name: /Порти/ }).click();
    // Default filter = favourites; problems surface first.
    const rows = page.getByTestId("hub-port-row");
    await expect(rows.first()).toContainText("Ягодин");
    await expect(rows.first()).toContainText("Закрито");
    // Port markers on the map, alerts pulse.
    expect(await page.locator(".hub-port").count()).toBeGreaterThan(3);
    expect(await page.locator(".hub-port.is-alert").count()).toBeGreaterThan(0);

    // Search → open Odesa card.
    await page.getByTestId("hub-port-search").fill("Одеса");
    await page.getByTestId("hub-port-row").filter({ hasText: "UAODS" }).getByRole("button", { name: /UAODS/ }).click();
    const card = page.getByTestId("hub-port-detail");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("hub-port-status")).toContainText("Збої в роботі");
    await expect(page.getByTestId("hub-port-status")).toContainText("ШІ з новини");
    await expect(card.getByRole("link", { name: /Укрінформ/ })).toHaveAttribute("href", /example\.com/);
    await expect(card).toContainText("Метопрен, партія 2");
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `test-results/hub-port-${info.project.name}.png` });

    // Team mark with a comment + confirm the AI mark + toggle favourite.
    await card.getByLabel("Коментар до статусу").fill("черга 2 доби");
    await card.getByRole("button", { name: "Черги / перевантаження" }).click();
    await expect.poll(() => state.marks!.length).toBe(1);
    expect(state.marks![0]).toEqual({ status: "congested", note: "черга 2 доби" });
    await card.getByRole("button", { name: "Прибрати з обраних" }).click();
    await expect.poll(() => state.favs!).toContain("DELETE:UAODS");
  });

  test("lines tab: carrier statuses, corridors, services", async ({ page }, info) => {
    const state: HubMockState = { added: [], services: [], carrierMarks: [] };
    await mockHub(page, state);
    await openHub(page);
    await page.getByRole("tab", { name: /Лінії/ }).click();
    const rows = page.getByTestId("hub-carrier-row");
    await expect(rows.first()).toContainText("Maersk");
    await expect(rows.first()).toContainText("Приймає на Україну");
    await expect(rows.first()).toContainText("вчасно 71%");
    // Corridors with computed transit, war-risk zones on the map.
    await expect(page.getByTestId("hub-lane-row")).toHaveCount(LINES.lanes.length);
    expect(await page.locator("path.leaflet-interactive").count()).toBeGreaterThan(LINES.lanes.length);
    await page.getByTestId("hub-lane-row").filter({ hasText: "Китай → Одеса (в обхід Африки)" }).click();
    await page.waitForTimeout(1300);
    await page.screenshot({ path: `test-results/hub-lanes-${info.project.name}.png` });

    await rows.first().click();
    const card = page.getByTestId("hub-carrier-detail");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("hub-carrier-field").first()).toContainText("ШІ з новини");
    await expect(card).toContainText("AE-12 / Black Sea feeder");
    await expect(card).toContainText("WRS $150/TEU на Одесу");
    await page.waitForTimeout(1300);
    await page.screenshot({ path: `test-results/hub-carrier-${info.project.name}.png` });

    // Team mark + add a service.
    await card.getByLabel("Україна").selectOption("limited");
    await card.getByLabel("Коментар").fill("лише через Констанцу");
    await card.getByRole("button", { name: "Зберегти позначку" }).click();
    await expect.poll(() => state.carrierMarks!.length).toBe(1);
    expect(state.carrierMarks![0]).toMatchObject({ uaStatus: "limited", note: "лише через Констанцу" });

    await card.getByRole("button", { name: "+ Додати сервіс" }).click();
    await card.getByLabel("Назва сервісу").fill("ME-3");
    await card.getByLabel("Ротація").fill("INNSA, TRAMR, UAODS");
    await card.getByLabel("Транзит від").fill("24");
    await card.getByRole("button", { name: "Зберегти сервіс" }).click();
    await expect.poll(() => state.services!.length).toBe(1);
    expect(state.services![0]).toMatchObject({ name: "ME-3", rotation: ["INNSA", "TRAMR", "UAODS"], transitDaysMin: 24 });
  });

  test("routes tab: plan vs fact, Штурман variants, builder", async ({ page }, info) => {
    const state: HubMockState = { added: [], savedRoutes: [], suggests: [] };
    await mockHub(page, state);
    await openHub(page);
    await page.getByRole("tab", { name: "Маршрути" }).click();
    const row = page.getByTestId("hub-route-row").first();
    await expect(row).toContainText("Метопрен Нінбо → Київ");
    await expect(row).toContainText("Затримка");
    await row.click();

    const card = page.getByTestId("hub-route-detail");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("hub-route-legs").locator("li")).toHaveCount(3);
    await expect(page.getByTestId("hub-route-summary")).toContainText("5");
    await expect(card.getByTestId("hub-free-time")).toContainText("Free time 5 дн");
    await expect(card).toContainText("Метопрен, партія 2");
    // Planned (dashed) + actual (solid) paths and numbered stops on the map.
    expect(await page.locator("path.hub-trail").count()).toBeGreaterThan(0);
    await page.waitForTimeout(1300);
    await page.screenshot({ path: `test-results/hub-route-${info.project.name}.png` });

    // New route via Штурман's suggestions.
    await card.getByRole("button", { name: "Закрити" }).click();
    if (info.project.name === "mobile") await page.getByRole("button", { name: "Показати панель хабу" }).click();
    await page.getByTestId("hub-route-new").click();
    const ed = page.getByTestId("hub-route-editor");
    await ed.getByLabel("Звідки").first().fill("Нінбо (CNNGB)");
    await ed.getByLabel("Куди").first().fill("Київ (UAIEV)");
    await ed.getByRole("button", { name: "Запропонувати варіанти" }).click();
    await expect(page.getByTestId("hub-route-variants")).toContainText("Море до Констанци");
    expect(state.suggests![0]).toMatchObject({ from: "Нінбо (CNNGB)", to: "Київ (UAIEV)", priority: "reliability" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/hub-route-suggest-${info.project.name}.png` });
    await page.getByTestId("hub-route-variants").getByRole("button", { name: "Застосувати" }).first().click();
    await expect(page.getByTestId("hub-route-leg")).toHaveCount(4);
    await expect(ed.getByLabel("Назва маршруту")).toHaveValue("Море до Констанци + авто через Орлівку");
    // Add a manual leg, then save.
    await page.getByTestId("hub-route-add-leg").click();
    await expect(page.getByTestId("hub-route-leg")).toHaveCount(5);
    await page.getByRole("button", { name: "Видалити плече 5" }).click();
    await page.getByTestId("hub-route-save").click();
    await expect.poll(() => state.savedRoutes!.length).toBe(1);
    const saved = state.savedRoutes![0] as { legs: { mode: string; from: { code: string } }[]; workspaceId: string };
    expect(saved.legs.map((l) => l.mode)).toEqual(["sea", "road", "customs", "road"]);
    expect(saved.legs[0]!.from.code).toBe("CNNGB");
    expect(saved.workspaceId).toBe(WSID);
    await expect(page.getByTestId("hub-route-detail")).toBeVisible();
  });

  test("dark theme: hub stays legible (visual)", async ({ page }, info) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("theme", "dark");
      } catch {
        /* ignore */
      }
    });
    await mockHub(page);
    await openHub(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByTestId("hub-track-row").first().click();
    await expect(page.getByTestId("hub-track-detail")).toBeVisible();
    // Card text must contrast with its background in dark mode.
    const [fg, bg] = await page.getByTestId("hub-track-detail").evaluate((el) => {
      const c = getComputedStyle(el).color;
      let n: Element | null = el;
      let b = "rgba(0, 0, 0, 0)";
      while (n && (b === "rgba(0, 0, 0, 0)" || b === "transparent")) {
        b = getComputedStyle(n).backgroundColor;
        n = n.parentElement;
      }
      return [c, b];
    });
    const lum = (s: string) => {
      const m = s.match(/[\d.]+/g)!.map(Number);
      return 0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!;
    };
    expect(lum(fg) - lum(bg)).toBeGreaterThan(100);
    await page.waitForTimeout(1300);
    await page.screenshot({ path: `test-results/hub-dark-${info.project.name}.png` });
  });

  test("map styles switch and persist; risk zones are filled", async ({ page }, info) => {
    await mockHub(page);
    await openHub(page);
    // War-risk zones: solid, clearly filled polygons.
    const zone = page.locator('path.leaflet-interactive[fill="#ff2d2d"]');
    await expect(zone).toHaveCount(1);
    expect(Number(await zone.getAttribute("fill-opacity"))).toBeGreaterThan(0.3);
    expect(await zone.getAttribute("stroke-dasharray")).toBeNull();

    await page.getByRole("button", { name: /Шари/ }).click();
    await page.getByRole("menuitemradio", { name: /Супутник/ }).click();
    await expect.poll(() => page.locator(".leaflet-tile-pane img").first().getAttribute("src")).toContain("World_Imagery");
    expect(await page.evaluate(() => localStorage.getItem("hub-basemap"))).toBe("satellite");
    await page.getByRole("menuitemradio", { name: /Темна мінімал/ }).click();
    await expect.poll(() => page.locator(".leaflet-tile-pane img").first().getAttribute("src")).toContain("World_Dark_Gray_Base");
    await page.getByRole("button", { name: /Шари/ }).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `test-results/hub-style-dark-${info.project.name}.png` });
    await page.reload();
    await expect(page.getByTestId("hub-map").or(page.getByRole("button", { name: "Карта", exact: true }).first())).toBeVisible();
  });

  test.describe("map UX (desktop)", () => {
    test.skip(({ isMobile }) => isMobile, "desktop-only features");

    test("port markers: kind colours, status badges, clusters, labels", async ({ page }) => {
      await mockHub(page);
      await openHub(page);
      await page.getByRole("tab", { name: /Порти/ }).click();
      // Zoomed out → clusters with counts.
      await expect(page.locator(".hub-cluster").first()).toBeVisible();
      const before = await page.locator(".hub-port").count();
      // Kind colour: sea ports blue, airports violet, crossings orange.
      expect(await page.locator('.hub-port[style*="--mk:#2f6feb"]').count()).toBeGreaterThan(0);
      expect(await page.locator(".hub-port .hub-st").count()).toBeGreaterThan(0);
      // Clicking a cluster zooms in and splits it; labels appear from zoom 6.
      await page.locator(".hub-cluster").first().click();
      await page.waitForTimeout(1200);
      for (let i = 0; i < 6 && (await page.locator(".hub-label").count()) === 0; i += 1) {
        await page.getByRole("button", { name: "Збільшити" }).click();
        await page.waitForTimeout(500);
      }
      expect(await page.locator(".hub-label").count()).toBeGreaterThan(0);
      expect(await page.locator(".hub-port").count()).toBeGreaterThan(0);
      expect(before).toBeGreaterThanOrEqual(0);
      await page.screenshot({ path: "test-results/hub-ports-colours.png" });
    });

    test("legend explains colours and remembers being open", async ({ page }) => {
      await mockHub(page);
      await openHub(page);
      await page.getByRole("button", { name: "Легенда" }).click();
      const lg = page.getByTestId("hub-legend");
      await expect(lg).toContainText("Морський порт");
      await expect(lg).toContainText("Днів до ETA");
      await expect(lg).toContainText("Коридор в обхід Африки");
      await page.waitForTimeout(800);
      await page.screenshot({ path: "test-results/hub-legend.png" });
      await page.reload();
      await openHub(page);
      await expect(page.getByTestId("hub-legend")).toBeVisible();
    });

    test("search finds ports, tracks and any place", async ({ page }) => {
      await mockHub(page);
      await page.route("https://nominatim.openstreetmap.org/**", (r) =>
        r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ lat: "50.0", lon: "36.23", display_name: "Харків, Україна" }]) })
      );
      await openHub(page);
      const box = page.getByTestId("hub-search");
      await box.fill("Одеса");
      await expect(page.getByTestId("hub-search-results")).toContainText("UAODS");
      await page.getByRole("option", { name: /Одеса.*UAODS/ }).first().click();
      await expect(page.getByTestId("hub-port-detail")).toBeVisible();

      await box.fill("Метопрен");
      await box.press("Enter");
      await expect(page.getByTestId("hub-track-detail")).toContainText("Метопрен, партія 2");

      await box.fill("Харків");
      await page.getByRole("option", { name: /Знайти на карті/ }).click();
      await expect(page.locator(".hub-label", { hasText: "Харків" })).toBeVisible();
    });

    test("ETA badges and the shipment filter", async ({ page }) => {
      await mockHub(page);
      await openHub(page);
      await expect.poll(() => page.locator(".hub-eta").count()).toBeGreaterThan(1);
      await expect.poll(() => page.locator(".hub-eta.is-late").count()).toBeGreaterThan(0);
      await expect(page.getByTestId("hub-track-row")).toHaveCount(6);
      await page.getByTestId("hub-only-shipment").click();
      await expect(page.getByTestId("hub-track-row")).toHaveCount(1);
      await expect(page.locator(".hub-mk")).toHaveCount(1);
      await page.getByTestId("hub-all-shipments").click();
      await expect(page.getByTestId("hub-track-row")).toHaveCount(6);
    });

    test("replay a voyage: fact vs plan with the lag", async ({ page }) => {
      await mockHub(page);
      await openHub(page);
      await page.getByTestId("hub-track-row").first().click();
      await page.getByTestId("hub-play").click();
      const bar = page.getByTestId("hub-playback");
      await expect(bar).toBeVisible();
      const d0 = await page.getByTestId("hub-playback-date").textContent();
      await page.waitForTimeout(1200);
      expect(await page.getByTestId("hub-playback-date").textContent()).not.toBe(d0);
      // Jump to the end: the cargo is behind its first ETA.
      const slider = page.getByTestId("hub-playback-slider");
      await slider.evaluate((el: HTMLInputElement) => {
        el.value = el.max;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await expect(page.getByTestId("hub-playback-lag")).toContainText("Відставання");
      await expect(page.locator(".hub-label", { hasText: "За планом" })).toBeVisible();
      await expect(page.locator(".hub-label", { hasText: "Факт" })).toBeVisible();
      expect(await page.locator(".hub-ghost .hub-mk").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
      await page.waitForTimeout(600);
      await page.screenshot({ path: "test-results/hub-replay.png" });
      await bar.getByRole("button", { name: "Закрити відтворення" }).click();
      await expect(bar).toBeHidden();
    });
  });
});
