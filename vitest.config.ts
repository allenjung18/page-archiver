import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  // the workspace packages from their sources, so unit tests need no build first
  resolve: {
    alias: {
      "@page-archiver/core": src("core"),
      "@page-archiver/library": src("library"),
    },
  },
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
