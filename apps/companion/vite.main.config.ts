import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { runtimeExternal } from "./vite.runtime.js";

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL("src/main/main.ts", import.meta.url)),
      formats: ["es"]
    },
    minify: false,
    outDir: "dist/main",
    rollupOptions: {
      external: runtimeExternal,
      output: {
        entryFileNames: "main/[name].js"
      }
    },
    sourcemap: false,
    target: "node24"
  }
});
