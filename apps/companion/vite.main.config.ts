import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getCompanionUiAssetDirectory } from "@tokenmonster/companion-ui";
import { defineConfig } from "vite";

import { runtimeExternal } from "./vite.runtime.js";

// Mirrors the gateway's directory loader: index.html + styles.css + every
// safe-named ES module of the browser UI (main.js entry plus its imports).
const UI_SCRIPT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*\.js$/u;
const REQUIRED_UI_FILES = ["index.html", "styles.css", "main.js"] as const;

const copyCompanionUi = () => ({
  name: "tokenmonster-copy-companion-ui",
  async writeBundle(): Promise<void> {
    const source = getCompanionUiAssetDirectory();
    const destination = fileURLToPath(
      new URL("dist/main/main/public/", import.meta.url)
    );
    const fileNames = (await readdir(source)).filter(
      (fileName) =>
        fileName === "index.html" ||
        fileName === "styles.css" ||
        UI_SCRIPT_NAME_PATTERN.test(fileName)
    );
    for (const requiredFile of REQUIRED_UI_FILES) {
      if (!fileNames.includes(requiredFile)) {
        throw new Error(
          `Companion UI asset missing: ${requiredFile} — build @tokenmonster/companion-ui first.`
        );
      }
    }
    await mkdir(destination, { recursive: true });
    await Promise.all(
      fileNames.map(async (fileName) =>
        copyFile(join(source, fileName), join(destination, fileName))
      )
    );
  }
});

export default defineConfig({
  plugins: [copyCompanionUi()],
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
