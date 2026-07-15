import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { rootDirectory } from "./repository-files.mjs";

const artifactRoots = [join(rootDirectory, "apps", "web", "dist")];
for (const parentName of ["apps", "packages"]) {
  const parent = join(rootDirectory, parentName);
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (entry.isDirectory() && !(parentName === "apps" && entry.name === "web")) {
      artifactRoots.push(join(parent, entry.name, "dist"));
    }
  }
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

const forbiddenExtensions = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".map",
  ".mp3",
  ".mp4",
  ".ogg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".wav",
  ".webm",
  ".webp",
]);
const forbiddenMarkers = [
  ["-----BEGIN ", "PRIVATE KEY-----"].join(""),
  "web/public/avatars/",
  "data:image/",
];
let fileCount = 0;
for (const root of artifactRoots) {
  for (const file of await listFiles(root)) {
    fileCount += 1;
    if (forbiddenExtensions.has(extname(file).toLowerCase())) {
      throw new Error(`Forbidden artifact type: ${relative(rootDirectory, file)}`);
    }
    const contents = await readFile(file);
    if (contents.includes(0)) {
      throw new Error(`Unknown binary artifact: ${relative(rootDirectory, file)}`);
    }
    const text = contents.toString("utf8");
    for (const marker of forbiddenMarkers) {
      if (text.includes(marker)) {
        throw new Error(`Forbidden marker in artifact: ${relative(rootDirectory, file)}`);
      }
    }
  }
}

if (fileCount === 0) {
  throw new Error("Release artifact inventory is empty.");
}
