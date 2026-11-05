import { test, expect, type Page } from "@playwright/test";

/**
 * Поставки (spec 008) + the site entry. Backend mocked; data is made up.
 * Set PW_SHOTS=<dir> to also save screenshots for a visual check.
 */

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const add = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const step = (id: string, name: string, state: string, plan = "", actual = "") => ({ id, name, state, plan, actual, note: "" });

function data(canEdit: boolean) {
  return {
    revision: "1",
    canEdit,
    settings: {
      stages: ["Готовність", "Відправка", "Прибуття в порт", "Доставка"],
      categories: ["Міжнародні", "Україна", "Зразки"],
      fields: [{ id: "qty", name: "Кількість", type: "text" }, { id: "supplier", name: "Постачальник", type: "text" }],
      templates: [{ id: "t1", name: "Через порт", stages: ["Готовність", "Відправка", "Прибуття в порт", "Доставка"] }],
    },
    shipments: [
      { id: "a1", name: "Тестова сіль", category: "Міжнародні", action: "Уточнити дату", note: "Вийшло з порту", archived: false, position: 1,
        steps: [step("1", "Готовність", "done", add(-9), add(-9)), step("2", "Прибуття в порт", "active", add(-2)), step("3", "Доставка", "pending", add(5))],
        custom: { qty: "20 т" }, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" },
      { id: "a2", name: "Пробний крохмаль", category: "Україна", action: "", note: "", archived: false, position: 2,
        steps: [step("1", "Доставка", "active", add(3))], custom: {}, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z" },
      { id: "a3", name: "Зразок фарби", category: "Зразки", action: "", note: "", archived: false, position: 3,
        steps: [step("1", "Відправка", "active")], custom: {}, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z" },
    ],
  };
}

async function mockSupply(page: Page, calls: string[] = []) {
  let unlocked = false;
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    const method = req.method();
    calls.push(`${method} ${pathname}`);
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/auth/methods") return json({ codeLogin: true, codeLength: 6 });
    if (pathname === "/api/supply") return json(data(unlocked));
    if (pathname === "/api/supply/revision") return json({ revision: "1" });
    if (pathname === "/api/supply/session") return json({ canEdit: unlocked, codeLogin: true, codeLength: 6 });
    if (pathname === "/api/supply/history") return json({ history: [{ id: 1, at: new Date().toISOString(), actor: "Код Штурмана", kind: "shipment", text: "Змінено поставку: Тестова сіль", shipmentId: "a1", undoable: true }] });
    if (pathname === "/api/supply/unlock") {
      const { code } = req.postDataJSON() as { code: string };
      if (code !== "123456") return json({ error: "invalid_code" }, 401);
      unlocked = true;
      return json({ token: "supply-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (pathname.startsWith("/api/supply/shipments/") && method === "PATCH") {
      const s = data(true).shipments.find((x) => pathname.endsWith(x.id))!;
      return json({ shipment: { ...s, ...(req.postDataJSON() as object), updatedAt: new Date().toISOString() } });
    }
    return json({ error: "not_found" }, 404);
  });
}

const shots = process.env.PW_SHOTS;
async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}-${test.info().project.name}.png`, fullPage: false });
}

test("entry: Поставки by default, the corner mark opens the Штурман PIN gate and back", async ({ page }) => {
  await mockSupply(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Поставки" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Увійти/ })).toHaveAttribute("href", "/supply");
  await shot(page, "entry-supply");
  await page.getByRole("button", { name: "Відкрити вхід у Штурман" }).click();
  await expect(page.getByText("Введіть код доступу")).toBeVisible();
  await page.waitForTimeout(1600);
  await shot(page, "entry-shturman");
  await page.getByRole("button", { name: "Повернутись до Поставок" }).click();
  await expect(page.getByRole("heading", { name: "Поставки" })).toBeVisible();
});

test("register: open to read, editing needs the code", async ({ page }) => {
  const calls: string[] = [];
  await mockSupply(page, calls);
  await page.goto("/supply");
  await expect(page.getByText("Тестова сіль")).toBeVisible();
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: /Нова поставка/ })).toBeDisabled();
  await shot(page, "supply-list");

  await page.getByRole("button", { name: "Відкрити: Тестова сіль" }).click();
  await expect(page.getByText("Лише перегляд")).toBeVisible();
  await shot(page, "supply-card");
  await page.getByRole("button", { name: "Редагувати" }).click();

  await expect(page.getByText("Введіть код Штурмана")).toBeVisible();
  for (const d of "000000") await page.keyboard.press(d);
  await expect(page.getByText("Невірний код")).toBeVisible();
  await page.waitForTimeout(600);
  for (const d of "123456") await page.keyboard.press(d);
  await expect(page.getByText(/Режим редагування\./)).toBeVisible();
  await expect(page.getByRole("button", { name: "Зберегти" })).toBeVisible();
  await shot(page, "supply-card-edit");
  expect(await page.evaluate(() => localStorage.getItem("aia_token"))).toBeNull();
});

test("calendar fits one screen on desktop", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium", "desktop layout");
  await mockSupply(page);
  await page.goto("/supply");
  await page.getByRole("button", { name: "Календар" }).click();
  await expect(page.locator(".sp .calwrap")).toBeVisible();
  await shot(page, "supply-calendar");
  const scrolls = await page.evaluate(() => document.scrollingElement!.scrollHeight > window.innerHeight + 1);
  expect(scrolls).toBe(false);
});
