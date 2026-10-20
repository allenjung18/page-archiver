// The real-site smoke run (test/smoke): not part of `npm run test:e2e`, because it loads real pages
// from the network. `npm run smoke`. No fixture server; two pages at a time, each loaded once.
import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

// no fixture server: the pages are on the web
const rest = { ...base };
delete rest.webServer;

export default defineConfig({
  ...rest,
  testDir: "test/smoke",
  outputDir: "test-results/smoke",
  workers: 2,
  globalSetup: "./test/smoke/setup.ts",
  globalTeardown: "./test/smoke/table.ts",
});
