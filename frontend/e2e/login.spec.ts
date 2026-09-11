import { test, expect } from "@playwright/test";

/**
 * Login — the ШТУРМАН code gate (PIN keypad) plus the admin email fallback.
 * Renders without the backend (auth resolves to "no user" and stays), so these
 * run standalone.
 */
test.describe("Login — code gate", () => {
  test("renders the PIN keypad", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Введіть код доступу")).toBeVisible();
    await expect(page.getByRole("button", { name: "1", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "0", exact: true })).toBeVisible();
  });

  test("pressing keys fills the code cells", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "1", exact: true }).click();
    await page.getByRole("button", { name: "9", exact: true }).click();
    // Two filled cells render a "•" mask.
    await expect(page.getByText("•").first()).toBeVisible();
  });

  test("can switch to the admin email login and back", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /Вхід адміністратора/ }).click();
    await expect(page.getByRole("heading", { name: "Вхід адміністратора" })).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Увійти" })).toBeVisible();

    await page.getByRole("button", { name: "Вхід за кодом" }).click();
    await expect(page.getByText("Введіть код доступу")).toBeVisible();
  });

  test("email and password fields accept input", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /Вхід адміністратора/ }).click();
    const email = page.locator('input[type="email"]');
    const password = page.locator('input[type="password"]');
    await email.fill("pilot@example.com");
    await password.fill("secret123");
    await expect(email).toHaveValue("pilot@example.com");
    await expect(password).toHaveValue("secret123");
  });
});
