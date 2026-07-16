import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(packageDirectory, "src/public");
const outputDirectory = resolve(packageDirectory, "dist/public");

await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  ["index.html", "styles.css"].map((fileName) =>
    copyFile(resolve(sourceDirectory, fileName), resolve(outputDirectory, fileName))
  )
);
