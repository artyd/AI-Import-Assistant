import { test, expect } from "@playwright/test";
import { mockWorkspace, WSID } from "./mocks";

/**
 * The gear in the top-right corner holds theme, sound, lock and the legal links;
 * the sidebar no longer shows «Конфіденційність · Умови».
 */

test.beforeEach(({}, info) => {
  test.skip(info.project.name === "mobile", "desktop-only");
});

test("settings gear: theme, sound, legal links; closes on Escape", async ({ page }) => {
  await mockWorkspace(page);
  await page.goto(`/workspaces/${WSID}`);
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // Sidebar has no legal line any more, and the old top-bar icons are gone.
  await expect(page.getByTestId("legal-links")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Тема оформлення" })).toHaveCount(0);

  const gear = page.getByTestId("settings-button");
  await gear.click();
  const menu = page.getByTestId("settings-menu");
  await expect(menu).toBeVisible();

  const root = page.locator("html");
  const initial = await root.getAttribute("data-theme");
  await menu.getByRole("menuitem", { name: "Тема оформлення" }).click();
  await expect.poll(() => root.getAttribute("data-theme")).not.toBe(initial);
  await expect(menu).toBeVisible(); // toggles keep the menu open

  const sound = menu.getByRole("menuitemcheckbox", { name: "Звук" });
  const before = await sound.getAttribute("aria-checked");
  await sound.click();
  await expect(sound).not.toHaveAttribute("aria-checked", before ?? "");

  await expect(menu.getByRole("menuitem", { name: "Заблокувати" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Конфіденційність" })).toHaveAttribute("href", "/privacy");
  await expect(menu.getByRole("menuitem", { name: "Умови" })).toHaveAttribute("href", "/terms");

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});
