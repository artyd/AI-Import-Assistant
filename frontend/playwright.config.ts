import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the AI Import Assistant frontend.
 *
 * Boots `next dev` on :3000 and runs the e2e suite against it. The specs are
 * split so most can run WITHOUT the backend stack (the login page and all
 * interface-quality / accessibility checks render standalone); tests that need a
 * live API self-skip when `PW_BACKEND=1` is not set.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3100",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
  webServer: {
    // Dedicated port so a stray dev server on :3000 is never reused.
    command: "npm run dev -- -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
