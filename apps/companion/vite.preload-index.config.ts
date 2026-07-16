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
      entry: {
        index: fileURLToPath(new URL("src/preload/index.cts", import.meta.url)),
        "pet-shell": fileURLToPath(
          new URL("src/preload/pet-shell.cts", import.meta.url)
        )
      },
      formats: ["cjs"]
    },
    minify: false,
    outDir: "dist/main",
    rollupOptions: {
      external: runtimeExternal,
      output: {
        entryFileNames: "preload/[name].cjs"
      }
    },
    sourcemap: false,
    target: "node24"
  }
});
