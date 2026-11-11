import { test, expect } from "@playwright/test";

/**
 * Real-backend checks for the CI `full-stack` job (no page.route mocks): the
 * browser origin must serve both the frontend and the API (the production split
 * routing). Runs only with PW_BACKEND=1; then E2E_EMAIL / E2E_PASSWORD (a seeded
 * user) are REQUIRED and a missing one fails the run instead of skipping.
 */
const enabled = process.env.PW_BACKEND === "1";

test.describe("Full stack (real backend)", () => {
  test.skip(!enabled, "needs the real stack: set PW_BACKEND=1");

  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;

  test.beforeAll(() => {
    if (enabled && (!email || !password)) {
      throw new Error("PW_BACKEND=1 requires E2E_EMAIL and E2E_PASSWORD (a seeded user)");
    }
  });

  test("/health answers through the proxy", async ({ request }) => {
    const res = await request.get("/health");
    expect(res.ok()).toBe(true);
    expect((await res.json()).status).toBe("ok");
  });

  test("login page renders from the frontend", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Вхід" })).toBeVisible();
  });

  test("API login returns a token and /me works", async ({ request }) => {
    const login = await request.post("/api/auth/login", { data: { email, password } });
    expect(login.status()).toBe(200);
    const { token } = await login.json();
    expect(typeof token).toBe("string");
    const me = await request.get("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(me.status()).toBe(200);
    expect((await me.json()).user.email).toBe(email!.toLowerCase());
  });
});
