import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(packageDirectory, "src");
const outputDirectory = resolve(packageDirectory, "dist");
const releaseSlotNames = Object.freeze([
  "approved-release-v2.json",
  "approved-asset-pack-descriptor-v1.json",
  "approved-asset-pack-allowlist-v1.json",
]);
const maximumBytesByName = Object.freeze({
  "approved-release-v2.json": 32 * 1024 * 1024,
  "approved-asset-pack-descriptor-v1.json": 64 * 1024,
  "approved-asset-pack-allowlist-v1.json": 64 * 1024,
});

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function requirePhysicalDirectory(path, label, { create = false } = {}) {
  if (create) await mkdir(path, { recursive: true });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a physical directory`);
  }
}

async function readStableSource(fileName) {
  const sourcePath = resolve(sourceDirectory, fileName);
  const before = await lstat(sourcePath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    before.size > maximumBytesByName[fileName]
  ) {
    throw new Error(`Release slot must be a bounded physical file: ${fileName}`);
  }
  const bytes = await readFile(sourcePath);
  const after = await lstat(sourcePath);
  if (!sameFile(before, after) || bytes.byteLength !== before.size) {
    throw new Error(`Release slot changed while being read: ${fileName}`);
  }
  return bytes;
}

await requirePhysicalDirectory(sourceDirectory, "Release slot source directory");
await requirePhysicalDirectory(outputDirectory, "Compiled output directory", {
  create: true,
});
await rm(resolve(outputDirectory, "approved-manifest.json"), { force: true });

const sourceBytes = new Map(
  await Promise.all(
    releaseSlotNames.map(async (fileName) => [
      fileName,
      await readStableSource(fileName),
    ]),
  ),
);
const stagingDirectory = await mkdtemp(join(outputDirectory, ".release-slots-"));
try {
  for (const fileName of releaseSlotNames) {
    const destinationPath = resolve(outputDirectory, fileName);
    const existing = await lstat(destinationPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing?.isSymbolicLink()) {
      throw new Error(`Compiled release slot must not be a symlink: ${fileName}`);
    }

    const stagedPath = resolve(stagingDirectory, fileName);
    const handle = await open(stagedPath, "wx", 0o600);
    try {
      await handle.writeFile(sourceBytes.get(fileName));
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!(await readFile(stagedPath)).equals(sourceBytes.get(fileName))) {
      throw new Error(`Staged release slot differs from source: ${fileName}`);
    }
    await rename(stagedPath, destinationPath);
    const installed = await lstat(destinationPath);
    if (
      !installed.isFile() ||
      installed.isSymbolicLink() ||
      !(await readFile(destinationPath)).equals(sourceBytes.get(fileName))
    ) {
      throw new Error(`Compiled release slot differs from source: ${fileName}`);
    }
  }
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}
