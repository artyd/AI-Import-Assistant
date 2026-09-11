import { test, expect } from "@playwright/test";

/**
 * Accessibility + hygiene basics on the login page (standalone).
 */
test.describe("Accessibility & hygiene", () => {
  test("no console errors on load", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/login");
    await page.waitForLoadState("networkidle").catch(() => {});
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("interactive controls have accessible names", async ({ page }) => {
    await page.goto("/login");
    // Icon-only theme button must expose an aria-label.
    await expect(page.getByRole("button", { name: "Тема оформлення" })).toBeVisible();
    // Switch to the admin email form — its submit button has a visible text name.
    await page.getByRole("button", { name: /Вхід адміністратора/ }).click();
    await expect(page.getByRole("button", { name: "Увійти" })).toBeVisible();
  });

  test("focus-visible outline is present on keyboard focus", async ({ page }) => {
    await page.goto("/login");
    await page.keyboard.press("Tab");
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const s = getComputedStyle(el);
      return { outlineWidth: s.outlineWidth, boxShadow: s.boxShadow };
    });
    expect(outline).not.toBeNull();
    // Either a focus outline or the accent focus ring should be present.
    const hasIndicator =
      (outline!.outlineWidth && outline!.outlineWidth !== "0px") ||
      (outline!.boxShadow && outline!.boxShadow !== "none");
    expect(hasIndicator).toBeTruthy();
  });

  test("document has a lang attribute", async ({ page }) => {
    await page.goto("/login");
    const lang = await page.locator("html").getAttribute("lang");
    expect(lang).toBeTruthy();
  });
});
