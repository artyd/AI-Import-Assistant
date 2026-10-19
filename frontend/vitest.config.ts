import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for the pure frontend modules (no DOM): lib/**/__tests__/*.spec.ts.
// Browser behaviour stays in Playwright (e2e/).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    include: ["lib/**/__tests__/*.spec.ts", "components/**/__tests__/*.spec.ts"],
    environment: "node",
  },
});
