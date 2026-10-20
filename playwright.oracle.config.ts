// The SingleFile oracle (test/oracle): not part of `npm run test:e2e`, because it runs a third-party
// program through npx. `npm run oracle`.
import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

export default defineConfig({
  ...base,
  testDir: "test/oracle",
  outputDir: "test-results/oracle",
  globalSetup: "./test/oracle/setup.ts",
  globalTeardown: "./test/oracle/table.ts",
});
