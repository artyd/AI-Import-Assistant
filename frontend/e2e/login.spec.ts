import { test, expect } from "@playwright/test";

/**
 * Login — optional PIN keypad (only when the backend reports it via
 * /api/auth/methods) plus email + password. Backend calls are mocked, so these
 * run standalone.
 */
const methods = (codeLogin: boolean, codeLength: number | null = null) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ codeLogin, codeLength }),
});

test.describe("Login — PIN disabled", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/auth/methods", (r) => r.fulfill(methods(false)));
  });

  test("shows only the email/password form", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Вхід" })).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByText("Введіть код доступу")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Вхід за кодом" })).toHaveCount(0);
  });

  test("shows a throttling message on 429", async ({ page }) => {
    await page.route("**/api/auth/login", (r) =>
      r.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "too_many_attempts" }) })
    );
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("pilot@example.com");
    await page.locator('input[type="password"]').fill("wrong");
    await page.getByRole("button", { name: "Увійти" }).click();
    await expect(page.getByText(/Забагато спроб входу/)).toBeVisible();
  });
});

test.describe("Login — PIN enabled (6 digits)", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/auth/methods", (r) => r.fulfill(methods(true, 6)));
  });

  test("renders a 6-cell keypad and switches to email and back", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Введіть код доступу")).toBeVisible();
    await page.getByRole("button", { name: "1", exact: true }).click();
    await page.getByRole("button", { name: "9", exact: true }).click();
    await expect(page.getByText("•")).toHaveCount(2);
    await page.getByRole("button", { name: "Вхід через email" }).click();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await page.getByRole("button", { name: "Вхід за кодом" }).click();
    await expect(page.getByText("Введіть код доступу")).toBeVisible();
  });

  test("a locked PIN login explains to use email", async ({ page }) => {
    await page.route("**/api/auth/login-code", (r) =>
      r.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "code_login_locked" }) })
    );
    await page.goto("/login");
    for (const d of ["1", "2", "3", "4", "5", "6"]) await page.getByRole("button", { name: d, exact: true }).click();
    await expect(page.getByText(/тимчасово заблоковано/)).toBeVisible();
  });
});
