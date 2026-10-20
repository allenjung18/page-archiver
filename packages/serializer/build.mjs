// Bundles the serializer into one IIFE that core injects into every frame of a page
// (and the extension injects into the tab). Output: dist/serializer.iife.js, global PageArchiverSerializer.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

await build({
  absWorkingDir: here,
  entryPoints: ["src/index.ts"],
  outfile: "dist/serializer.iife.js",
  bundle: true,
  format: "iife",
  globalName: "PageArchiverSerializer",
  platform: "browser",
  target: ["chrome120", "firefox120", "safari17"],
  legalComments: "none",
  logLevel: "warning",
});
