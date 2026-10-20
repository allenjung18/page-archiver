import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "fixtures/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "test/e2e/**/*.spec.ts"],
    // DOM tests (happy-dom) must never reach the network: no sheet, script or frame loading.
    environmentOptions: {
      happyDOM: {
        url: "http://site.test/page.html",
        settings: {
          disableCSSFileLoading: true,
          disableJavaScriptFileLoading: true,
          disableIframePageLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
  },
});
