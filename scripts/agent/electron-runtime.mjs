import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

import { rootDirectory } from "./contract.mjs";

const ELECTRON_PATH_CAP = 1024;
const ELECTRON_PACKAGE_FILE_CAP = 64 * 1024;
const EXPECTED_ELECTRON_VERSION = "43.7.7";
const REVIEWED_ELECTRON_PACKAGE_FILES = Object.freeze({
  "package.json":
    "5fe95208a534298829bf8dcb6d0d45f5b93624b01e25ab8b5a8cc0a1df39812d",
  "install.js":
    "3b9e0c3c9070edbdb732dc05ed23c6f1c6b7a404bd623033a2f0b71052534e93",
  "checksums.json":
    "3239850744ff96b0642a2160733cc331ae12496ed1c0c1950292b2e555994160",
});

function regularFile(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error("agent_electron_file_invalid");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("agent_electron_file_invalid");
  }
  return metadata;
}

function readBoundedRegularFile(path, cap) {
  const initial = regularFile(path);
  if (initial.size === 0 || initial.size > cap) {
    throw new Error("agent_electron_path_invalid");
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size === 0 || before.size > cap) {
      throw new Error("agent_electron_path_invalid");
    }
    const buffer = Buffer.alloc(cap + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (
      offset > cap ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      offset !== after.size
    ) {
      throw new Error("agent_electron_path_invalid");
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function realDirectory(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error("agent_electron_directory_invalid");
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("agent_electron_directory_invalid");
  }
}

function assertDirectoryChain(base, target) {
  const relativePath = relative(base, target);
  if (
    relativePath === "" ||
    isAbsolute(relativePath) ||
    relativePath.split(sep).includes("..")
  ) {
    throw new Error("agent_electron_path_invalid");
  }
  let current = base;
  realDirectory(current);
  const parts = relativePath.split(sep);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    realDirectory(current);
  }
}

export function verifyReviewedElectronPackageDirectory(
  electronDirectory,
) {
  realDirectory(electronDirectory);
  for (const [name, expectedSha256] of Object.entries(
    REVIEWED_ELECTRON_PACKAGE_FILES,
  )) {
    const contents = readBoundedRegularFile(
      join(electronDirectory, name),
      ELECTRON_PACKAGE_FILE_CAP,
    );
    const actualSha256 = createHash("sha256")
      .update(contents, "utf8")
      .digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error("agent_electron_package_invalid");
    }
  }
  let packageManifest;
  try {
    packageManifest = JSON.parse(
      readBoundedRegularFile(
        join(electronDirectory, "package.json"),
        ELECTRON_PACKAGE_FILE_CAP,
      ),
    );
  } catch {
    throw new Error("agent_electron_package_invalid");
  }
  if (
    packageManifest?.name !== "electron" ||
    packageManifest?.version !== EXPECTED_ELECTRON_VERSION
  ) {
    throw new Error("agent_electron_package_invalid");
  }
  return electronDirectory;
}

function reviewedElectronPackageDirectory() {
  const nodeModules = join(rootDirectory, "node_modules");
  const electronDirectory = join(nodeModules, "electron");
  realDirectory(nodeModules);
  verifyReviewedElectronPackageDirectory(electronDirectory);
  return electronDirectory;
}

export function resolveElectronInstaller() {
  return join(reviewedElectronPackageDirectory(), "install.js");
}

function expectedElectronPath() {
  if (process.platform === "darwin") {
    return "Electron.app/Contents/MacOS/Electron";
  }
  if (process.platform === "linux") return "electron";
  if (process.platform === "win32") return "electron.exe";
  throw new Error("agent_electron_platform_invalid");
}

export function resolveElectronRuntime() {
  const electronDirectory = reviewedElectronPackageDirectory();
  const pathFile = join(electronDirectory, "path.txt");
  const relativeExecutable = readBoundedRegularFile(
    pathFile,
    ELECTRON_PATH_CAP,
  ).trim();
  if (
    relativeExecutable !== expectedElectronPath() ||
    isAbsolute(relativeExecutable) ||
    relativeExecutable.includes("\0") ||
    relativeExecutable
      .replaceAll("\\", "/")
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("agent_electron_path_invalid");
  }
  const distDirectory = join(electronDirectory, "dist");
  const executable = resolve(distDirectory, relativeExecutable);
  if (!executable.startsWith(`${distDirectory}${sep}`)) {
    throw new Error("agent_electron_path_invalid");
  }
  assertDirectoryChain(distDirectory, executable);
  regularFile(executable);
  const installedVersion = readBoundedRegularFile(
    join(distDirectory, "version"),
    ELECTRON_PATH_CAP,
  ).trim();
  if (
    installedVersion !== EXPECTED_ELECTRON_VERSION &&
    installedVersion !== `v${EXPECTED_ELECTRON_VERSION}`
  ) {
    throw new Error("agent_electron_version_invalid");
  }
  const companionDirectory = join(rootDirectory, "apps", "companion");
  realDirectory(join(rootDirectory, "apps"));
  realDirectory(companionDirectory);
  return { executable, companionDirectory };
}
