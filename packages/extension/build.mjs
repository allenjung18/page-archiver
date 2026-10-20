// Builds the unpacked extension into dist/unpacked/ (load it at chrome://extensions with
// "Load unpacked"): background.js, content.js and popup.js bundled by esbuild, the serializer's
// own IIFE copied as it is (the same bundle core injects), and static/ (manifest, popup page).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = fileURLToPath(new URL("./dist/unpacked/", import.meta.url));

/** core's stamp hashes with node:crypto; the service worker gets a plain sha256 instead. */
const nodeCrypto = {
  name: "node-crypto-shim",
  setup(b) {
    b.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: fileURLToPath(new URL("./src/shims/node-crypto.ts", import.meta.url)) }));
  },
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  absWorkingDir: here,
  entryPoints: { background: "src/background.ts", content: "src/content.ts", popup: "src/popup.ts" },
  outdir: out,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  // core from its sources, so the bundle never depends on what tsc last wrote to dist/
  alias: { "@page-archiver/core/portable": fileURLToPath(new URL("../core/src/portable.ts", import.meta.url)) },
  plugins: [nodeCrypto],
  legalComments: "none",
  logLevel: "warning",
});
cpSync(fileURLToPath(import.meta.resolve("@page-archiver/serializer/iife")), `${out}serializer.iife.js`);
cpSync(fileURLToPath(new URL("./static/", import.meta.url)), out, { recursive: true });
