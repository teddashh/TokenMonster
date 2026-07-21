import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(packageDirectory, "src/public");
const outputDirectory = resolve(packageDirectory, "dist/public");

await mkdir(outputDirectory, { recursive: true });
const staticFiles = (await readdir(sourceDirectory)).filter(
  (fileName) => fileName.endsWith(".html") || fileName.endsWith(".css")
);
await Promise.all(
  staticFiles.map((fileName) =>
    copyFile(resolve(sourceDirectory, fileName), resolve(outputDirectory, fileName))
  )
);

const outputFiles = await readdir(outputDirectory);
for (const requiredFile of ["index.html", "styles.css", "main.js"]) {
  if (!outputFiles.includes(requiredFile)) {
    throw new Error(`Missing companion UI asset: ${requiredFile}`);
  }
}
