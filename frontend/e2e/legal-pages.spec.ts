import { test, expect } from "@playwright/test";

/** Privacy and Terms are public: they render logged out, with one h1 and a clean console. */
test.setTimeout(90_000);

for (const [path, heading] of [
  ["/privacy", "Політика конфіденційності"],
  ["/terms", "Умови використання"],
] as const) {
  test(`${path} renders logged out with one h1 and no console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByText(/Остання редакція:/)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    // Contents link jumps to an anchor that exists.
    const first = page.locator(".legal-toc a").first();
    const href = await first.getAttribute("href");
    expect(href).toMatch(/^#/);
    await expect(page.locator(href!)).toHaveCount(1);

    // Fonts come from Google and may be blocked offline; that is not a page error.
    const real = errors.filter((e) => !/fonts\.(googleapis|gstatic)|ERR_(INTERNET|NAME|CONNECTION)|Failed to load resource/i.test(e));
    expect(real).toEqual([]);
  });
}

test("the login page links to both pages", async ({ page }) => {
  await page.route("**/api/auth/methods", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ codeLogin: false, codeLength: null }) })
  );
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("link", { name: "Конфіденційність" })).toHaveAttribute("href", "/privacy");
  await expect(page.getByRole("link", { name: "Умови" })).toHaveAttribute("href", "/terms");
  await page.getByRole("link", { name: "Умови" }).click();
  await expect(page).toHaveURL(/\/terms$/);
});
