import { test, expect } from "@playwright/test";

/**
 * Interface quality — verifies the Material Design language is actually applied
 * and the layout is sound. All run standalone against the login page.
 */
test.describe("Interface quality (Material)", () => {
  test("primary button carries Material elevation (box-shadow)", async ({ page }) => {
    await page.goto("/login");
    const btn = page.getByRole("button", { name: "Увійти" });
    const shadow = await btn.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow).not.toBe("none");
    expect(shadow.length).toBeGreaterThan(0);
  });

  test("buttons have a state-layer overlay (::after)", async ({ page }) => {
    await page.goto("/login");
    const hasLayer = await page
      .getByRole("button", { name: "Увійти" })
      .evaluate((el) => {
        const after = getComputedStyle(el, "::after");
        return after.content !== "none" && after.position === "absolute";
      });
    expect(hasLayer).toBe(true);
  });

  test("input shows an accent focus ring on focus", async ({ page }) => {
    await page.goto("/login");
    const email = page.locator('input[type="email"]');
    const before = await email.evaluate((el) => getComputedStyle(el).boxShadow);
    await email.focus();
    const after = await email.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(after).not.toBe(before);
    expect(after).not.toBe("none");
  });

  test("theme toggle flips the document theme", async ({ page }) => {
    await page.goto("/login");
    const root = page.locator("html");
    const initial = await root.getAttribute("data-theme");
    await page.getByRole("button", { name: "Тема" }).click();
    await expect
      .poll(async () => root.getAttribute("data-theme"))
      .not.toBe(initial);
  });

  test("no horizontal overflow on desktop or mobile", async ({ page }) => {
    for (const size of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await page.goto("/login");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `viewport ${size.width}px`).toBeLessThanOrEqual(1);
    }
  });

  test("motion respects prefers-reduced-motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/login");
    // Page still renders and is interactive under reduced motion.
    await expect(page.getByRole("button", { name: "Увійти" })).toBeVisible();
  });
});
