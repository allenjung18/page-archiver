import { defineConfig, devices } from "@playwright/test";
import { ASSETS_PORT, PAGES_ORIGIN, PAGES_PORT, VIEWPORT } from "./test/e2e/env.ts";

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORT, deviceScaleFactor: 1 },
    },
  ],
  webServer: {
    command: "node fixtures/server.ts",
    env: { PAGES_PORT: String(PAGES_PORT), ASSETS_PORT: String(ASSETS_PORT) },
    url: `${PAGES_ORIGIN}/healthz`,
    // never reuse: a server left by another checkout would serve that checkout's fixtures
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
