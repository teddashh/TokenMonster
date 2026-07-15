import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import {
  normalizePreloadGuardExport,
  runtimeExternal
} from "./vite.runtime.js";

export default defineConfig({
  plugins: [normalizePreloadGuardExport()],
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("src/preload/index.cts", import.meta.url)),
      formats: ["cjs"]
    },
    minify: false,
    outDir: "dist/main",
    rollupOptions: {
      external: runtimeExternal,
      output: {
        entryFileNames: "preload/index.cjs"
      }
    },
    sourcemap: false,
    target: "node24"
  }
});
