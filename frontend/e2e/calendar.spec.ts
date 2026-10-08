import { test, expect, type Page } from "@playwright/test";
import { mockWorkspace, WSID } from "./mocks";

/**
 * Logist calendar over the team Google Sheet — against a mocked backend with a
 * synthetic sheet (dates relative to today so the views always have content).
 * Desktop only (the mobile layout is frozen for now).
 */

const DAY = 86_400_000;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());
const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

function row(id: string, extra: Record<string, unknown>) {
  return {
    id,
    tab: "tracking",
    rowIndex: 100,
    url: `https://docs.google.com/spreadsheets/d/SHEET/edit#gid=1&range=A100`,
    product: "Товар",
    status: "in_transit",
    statusLabel: "В дорозі",
    active: true,
    number: null,
    carrier: null,
    carrierName: null,
    mode: "sea",
    forwarder: "",
    logist: "",
    origin: "",
    destination: "",
    departure: null,
    arrival: null,
    statusDate: null,
    comment: "",
    weight: "",
    line: "",
    refNo: "",
    customsPlace: "",
    warehouse: "",
    issues: [],
    trackedId: null,
    track: null,
    ...extra,
  };
}

const ROWS = [
  row("r1", {
    rowIndex: 234,
    product: "Холіна хлорид 2 контейнер",
    number: "MSBU1491088",
    carrier: "msc",
    carrierName: "MSC",
    forwarder: "Мультикс",
    logist: "Люда",
    origin: "Шанхай",
    destination: "Гданськ",
    departure: { date: plus(-20), guessed: true },
    arrival: { date: plus(3), guessed: false },
    track: { status: "in_transit", statusLabel: "В дорозі", eta: `${plus(5)}T00:00:00.000Z`, source: "sheet" },
  }),
  row("r2", {
    rowIndex: 230,
    product: "Спиносад",
    number: "5407559360",
    carrier: "dhl",
    carrierName: "DHL Express",
    mode: "courier",
    logist: "Яна",
    destination: "Київ",
    arrival: { date: plus(-2), guessed: true },
    issues: [{ code: "overdue", label: "План прибуття минув, а «розмитнено / доставлено» немає" }],
  }),
  row("r3", {
    rowIndex: 228,
    product: "Моксидектин",
    mode: "courier",
    status: "delivered",
    statusLabel: "Доставлено",
    active: false,
    logist: "Яна",
    statusDate: { date: plus(1), guessed: false },
  }),
  row("w1", { tab: "warehouse", rowIndex: 5, product: "сорбитол", statusLabel: "Заїзд на склад БЦ", destination: "Склад БЦ", qty: "24000", when: "на этой неделе", fits: "не влезет", arrival: { date: plus(2), guessed: true }, mode: null }),
];

const EVENTS = [
  { id: "r1:dep", rowId: "r1", type: "departure", date: plus(-20), approx: true },
  { id: "r1:arr", rowId: "r1", type: "arrival", date: plus(3), approx: false },
  { id: "r1:eta", rowId: "r1", type: "eta", date: plus(5), approx: false, source: "17TRACK" },
  { id: "r2:arr", rowId: "r2", type: "arrival", date: plus(-2), approx: true },
  { id: "r3:st", rowId: "r3", type: "delivered", date: plus(1), approx: false },
  { id: "w1:wh", rowId: "w1", type: "warehouse", date: plus(2), approx: true },
];

const SYNC = {
  enabled: true,
  sheetUrl: "https://docs.google.com/spreadsheets/d/SHEET/edit#gid=1",
  tabs: [{ tab: "tracking", ok: true, rows: 237, error: "", syncedAt: new Date().toISOString() }],
};

interface CalState {
  ranges: string[];
  syncs: number;
  exports: string[];
}

async function mockCalendar(page: Page, state: CalState) {
  await mockWorkspace(page, async (route, pathname, method) => {
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const url = new URL(route.request().url());
    if (pathname === "/api/calendar") {
      const from = url.searchParams.get("from")!;
      const to = url.searchParams.get("to")!;
      state.ranges.push(`${from}..${to}`);
      const events = EVENTS.filter((e) => e.date >= from && e.date <= to);
      const ids = new Set(events.map((e) => e.rowId));
      return (await json({ from, to, events, rows: ROWS.filter((r) => ids.has(r.id)), sync: SYNC }), true);
    }
    if (pathname === "/api/calendar/attention") return (await json({ rows: [ROWS[1]] }), true);
    if (pathname === "/api/sheet/sync" && method === "POST") {
      state.syncs += 1;
      return (await json({ result: { ok: true }, sync: SYNC }), true);
    }
    if (pathname === "/api/calendar/export.xlsx") {
      state.exports.push(url.search);
      await route.fulfill({ status: 200, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: "xlsx" });
      return true;
    }
    if (pathname === "/api/hub/live") return (await json({ items: [], vessels: [], serverTime: new Date().toISOString() }), true);
    return false;
  });
}

async function openCalendar(page: Page) {
  await page.goto(`/workspaces/${WSID}`);
  await page.getByTestId("nav-calendar").click();
  await expect(page.getByTestId("calendar")).toBeVisible();
}

test.describe("Logist calendar (team sheet)", () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name === "mobile", "desktop-only feature");
  });

  test("month view shows the sheet's events on their days, with sync state", async ({ page }, info) => {
    const state: CalState = { ranges: [], syncs: 0, exports: [] };
    await mockCalendar(page, state);
    await page.addInitScript(() => localStorage.setItem("aia_calendar_view", "month"));
    await openCalendar(page);
    await expect(page.getByTestId("calendar-month")).toBeVisible();
    await expect(page.getByTestId("calendar-sync")).toContainText("Таблиця");
    // The planned arrival sits in its day cell.
    const cell = page.locator(`[data-day="${plus(3)}"]`);
    await expect(cell.getByTestId("calendar-event")).toContainText("Холіна хлорид 2 контейнер");
    await expect(page.getByTestId("calendar-event").filter({ hasText: "Холіна" }).first()).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/calendar-month-${info.project.name}.png` });
  });

  test("week and year views, navigation re-fetches the period", async ({ page }) => {
    const state: CalState = { ranges: [], syncs: 0, exports: [] };
    await mockCalendar(page, state);
    await page.addInitScript(() => localStorage.setItem("aia_calendar_view", "week"));
    await openCalendar(page);
    await expect(page.getByTestId("calendar-week")).toBeVisible();
    const title = await page.getByTestId("calendar-title").textContent();
    const before = state.ranges.length;
    await page.getByRole("button", { name: "Наступний період" }).click();
    await expect(page.getByTestId("calendar-title")).not.toHaveText(title!);
    await expect.poll(() => state.ranges.length).toBeGreaterThan(before);
    await page.getByRole("button", { name: "Сьогодні" }).click();
    await expect(page.getByTestId("calendar-title")).toHaveText(title!);

    await page.getByRole("tab", { name: "Рік" }).click();
    await expect(page.getByTestId("calendar-year")).toBeVisible();
    await expect(page.getByTestId("calendar-title")).toHaveText(today.slice(0, 4));
    expect(state.ranges.at(-1)).toBe(`${today.slice(0, 4)}-01-01..${today.slice(0, 4)}-12-31`);
    // A day with events is highlighted; clicking it opens its week.
    await page.locator(`[data-testid="calendar-year"] [data-day="${plus(3)}"]`).click();
    await expect(page.getByTestId("calendar-week")).toBeVisible();
  });

  test("filters by logist and by event type", async ({ page }) => {
    const state: CalState = { ranges: [], syncs: 0, exports: [] };
    await mockCalendar(page, state);
    await page.addInitScript(() => localStorage.setItem("aia_calendar_view", "month"));
    await openCalendar(page);
    const events = page.getByTestId("calendar-event");
    const all = await events.count();
    expect(all).toBeGreaterThan(2);
    await page.getByLabel("Логіст").selectOption("Яна");
    await expect(events.filter({ hasText: "Холіна" })).toHaveCount(0);
    await expect(events.filter({ hasText: "Спиносад" })).not.toHaveCount(0);
    await page.getByRole("button", { name: "Скинути" }).click();
    await expect(events).toHaveCount(all);
    await page.getByRole("button", { name: "Склад БЦ" }).click();
    await expect(events.filter({ hasText: "сорбитол" })).toHaveCount(0);
  });

  test("event → row card with countdown, sheet link; «Увага» list; sync + Excel", async ({ page }, info) => {
    const state: CalState = { ranges: [], syncs: 0, exports: [] };
    await mockCalendar(page, state);
    await page.addInitScript(() => localStorage.setItem("aia_calendar_view", "week"));
    await openCalendar(page);
    await page.getByTestId("calendar-event").filter({ hasText: "Холіна" }).first().click();
    const card = page.getByTestId("calendar-detail");
    await expect(card).toContainText("MSBU1491088");
    await expect(card).toContainText("Мультикс");
    await expect(card.getByTestId("calendar-countdown")).toContainText("до прибуття 3 дн");
    await expect(card).toContainText("рік вгадано");
    await expect(card.getByRole("link", { name: /Відкрити рядок у таблиці/ })).toHaveAttribute("href", /range=A100/);
    await page.screenshot({ path: `test-results/calendar-week-${info.project.name}.png` });
    await card.getByRole("button", { name: "Закрити" }).click();

    await page.getByTestId("calendar-attention-toggle").click();
    const att = page.getByTestId("calendar-attention");
    await expect(att.getByTestId("calendar-attention-row")).toHaveCount(1);
    await expect(att).toContainText("Спиносад");
    await expect(att).toContainText("План прибуття минув");

    await page.getByRole("button", { name: "↻ Оновити" }).click();
    await expect.poll(() => state.syncs).toBe(1);
    await page.getByRole("button", { name: "Excel" }).click();
    await expect.poll(() => state.exports.length).toBe(1);
    expect(state.exports[0]).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  });
});
