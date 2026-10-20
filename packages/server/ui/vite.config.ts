// The reader UI, built into packages/server/dist/ui, which the server serves at /.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist/ui/", import.meta.url)),
    emptyOutDir: true,
    // the UI's CSP allows only its own script files: no inline polyfill
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
});
