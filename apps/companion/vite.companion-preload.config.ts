import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import {
  normalizePreloadGuardExport,
  runtimeExternal
} from "./vite.runtime.js";

// Sandboxed Electron preloads cannot require sibling files. Keep this bridge
// in its own single-entry build so Rolldown cannot extract shared runtime code
// into a second chunk beside companion.cjs.
export default defineConfig({
  plugins: [normalizePreloadGuardExport()],
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(
        new URL("src/preload/companion.cts", import.meta.url)
      ),
      formats: ["cjs"]
    },
    minify: false,
    outDir: "dist/main",
    rollupOptions: {
      external: runtimeExternal,
      output: {
        codeSplitting: false,
        entryFileNames: "preload/companion.cjs"
      }
    },
    sourcemap: false,
    target: "node24"
  }
});
