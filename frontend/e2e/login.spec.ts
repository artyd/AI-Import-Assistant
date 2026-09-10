import { test, expect } from "@playwright/test";

/**
 * Login page — functionality. Renders without the backend (auth resolves to
 * "no user" and stays on the page), so these run standalone.
 */
test.describe("Login page", () => {
  test("renders the sign-in form with email, password and submit", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: "Вхід" })).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Увійти" })).toBeVisible();
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

  test("HTML5 validation blocks submit when fields are empty", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Увійти" }).click();
    // Required email field should report invalidity — we never navigate away.
    const emailValid = await page
      .locator('input[type="email"]')
      .evaluate((el: HTMLInputElement) => el.checkValidity());
    expect(emailValid).toBe(false);
    await expect(page).toHaveURL(/\/login/);
  });
});
