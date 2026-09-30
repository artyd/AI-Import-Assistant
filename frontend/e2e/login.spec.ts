import { test, expect } from "@playwright/test";

/**
 * Login — email + password only (the shared PIN code login was removed for
 * security). Renders without the backend (auth resolves to "no user" and
 * stays), so these run standalone.
 */
test.describe("Login", () => {
  test("renders the email/password form, no PIN keypad", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Вхід" })).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Увійти" })).toBeVisible();
    await expect(page.getByText("Введіть код доступу")).toHaveCount(0);
  });

  test("email and password fields accept input", async ({ page }) => {
    await page.goto("/login");
    const email = page.locator('input[type="email"]');
    const password = page.locator('input[type="password"]');
    await email.fill("pilot@example.com");
    await password.fill("secret123");
    await expect(email).toHaveValue("pilot@example.com");
    await expect(password).toHaveValue("secret123");
  });

  test("shows a throttling message on 429", async ({ page }) => {
    await page.route("**/api/auth/login", (route) =>
      route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "too_many_attempts" }) }),
    );
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("pilot@example.com");
    await page.locator('input[type="password"]').fill("wrong");
    await page.getByRole("button", { name: "Увійти" }).click();
    await expect(page.getByText(/Забагато спроб входу/)).toBeVisible();
  });
});
