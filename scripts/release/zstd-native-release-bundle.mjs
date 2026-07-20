import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { inspectZstdPrebuildArchive } from "./audit-zstd-native-prebuild.mjs";
import {
  validateZstdNativePolicy,
  ZSTD_NATIVE_POLICY,
} from "./zstd-native-verifier.mjs";

const MAX_BUNDLED_PACKAGE_FILE_BYTES = 256 * 1_024;
const MAX_BUNDLED_PACKAGE_BYTES = 1 * 1_024 * 1_024;
const VERIFIED_READ_FLAGS =
  fsConstants.O_RDONLY |
  (process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0));

export const ZSTD_NATIVE_PACKAGE_FILE_PATHS = Object.freeze([
  "LICENSE.md",
  "README.md",
  "addon/compression.cpp",
  "addon/compression.h",
  "addon/compression_worker.h",
  "addon/zstd.cpp",
  "binding.gyp",
  "index.d.ts",
  "lib/index.js",
  "package.json",
]);

export const ZSTD_NATIVE_PREBUILD_ARCHIVE_NAMES = Object.freeze(
  Object.values(ZSTD_NATIVE_POLICY.platforms).map(({ archiveName }) =>
    archiveName,
  ),
);

export const ZSTD_NATIVE_PREBUILD_RELATIVE_PATHS = Object.freeze(
  ZSTD_NATIVE_PREBUILD_ARCHIVE_NAMES.map(
    (archiveName) => `prebuilds/${archiveName}`,
  ),
);

export const ZSTD_NATIVE_BUNDLE_FILE_PATHS = Object.freeze([
  ...ZSTD_NATIVE_PACKAGE_FILE_PATHS,
  ...ZSTD_NATIVE_PREBUILD_RELATIVE_PATHS,
]);

const EXPECTED_ZSTD_MANIFEST = Object.freeze({
  name: "@mongodb-js/zstd",
  version: "2.0.1",
  main: "lib/index.js",
  types: "index.d.ts",
  repository: "https://github.com/mongodb-js/zstd",
  files: Object.freeze([
    "index.d.ts",
    "lib/index.js",
    "addon/*",
    "binding.gyp",
  ]),
  dependencies: Object.freeze({
    "node-addon-api": "^4.3.0",
    "prebuild-install": "^7.1.3",
  }),
  license: "Apache-2.0",
  devDependencies: Object.freeze({
    "@mongodb-js/zstd": "^1.2.0",
    "@typescript-eslint/eslint-plugin": "^8.23.0",
    "@wasm-fmt/clang-format": "^19.1.7",
    chai: "^4.5.0",
    eslint: "^9.19.0",
    "eslint-config-prettier": "^10.0.1",
    "eslint-plugin-prettier": "^5.2.3",
    mocha: "^10.8.2",
    "node-gyp": "10.1.0",
    prebuild: "^13.0.1",
    prettier: "^3.4.2",
  }),
  engines: Object.freeze({ node: ">= 16.20.1" }),
  scripts: Object.freeze({
    install: "prebuild-install --runtime napi || npm run clean-install",
    "clean-install": "npm run install-zstd && npm run compile",
    compile: "node-gyp rebuild",
    test: "mocha test/index.test.js",
    "install-zstd": "bash etc/install-zstd.sh",
    "check:eslint":
      "ESLINT_USE_FLAT_CONFIG=false eslint *ts lib/*.js test/*.js .*.json",
    "clang-format":
      "clang-format --style=file:.clang-format --Werror -i addon/*",
    "check:clang-format":
      "clang-format --style=file:.clang-format --dry-run --Werror addon/*",
    prebuild: "prebuild --runtime napi --strip --verbose --all",
  }),
  overrides: Object.freeze({
    prebuild: Object.freeze({ "node-gyp": "$node-gyp" }),
  }),
  binary: Object.freeze({ napi_versions: Object.freeze([4]) }),
  "mongodb:zstd_version": "1.5.6",
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function samePlatformPath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") ===
        normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactJson(actual, expected, label) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      throw new Error(`${label} differs from the pinned @mongodb-js/zstd manifest`);
    }
    for (let index = 0; index < expected.length; index += 1) {
      requireExactJson(actual[index], expected[index], label);
    }
    return;
  }
  if (isPlainRecord(expected)) {
    if (!isPlainRecord(actual)) {
      throw new Error(`${label} differs from the pinned @mongodb-js/zstd manifest`);
    }
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      throw new Error(`${label} differs from the pinned @mongodb-js/zstd manifest`);
    }
    for (const key of expectedKeys) {
      requireExactJson(actual[key], expected[key], label);
    }
    return;
  }
  if (actual !== expected) {
    throw new Error(`${label} differs from the pinned @mongodb-js/zstd manifest`);
  }
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreeze(entry)));
  }
  if (isPlainRecord(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          cloneAndFreeze(entry),
        ]),
      ),
    );
  }
  return value;
}

export function requireBundledZstdManifest(manifest) {
  requireExactJson(
    manifest,
    EXPECTED_ZSTD_MANIFEST,
    "bundled zstd package manifest",
  );
  return cloneAndFreeze(EXPECTED_ZSTD_MANIFEST);
}

async function requirePhysicalDirectory(requestedPath, label) {
  if (
    typeof requestedPath !== "string" ||
    requestedPath.length === 0 ||
    requestedPath.includes("\0")
  ) {
    throw new Error(`${label} requires a directory path`);
  }
  const path = resolve(requestedPath);
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error(`${label} must be a physical directory`);
  }
  const physicalPath = await realpath(path);
  if (!samePlatformPath(path, physicalPath)) {
    throw new Error(`${label} must be a physical directory`);
  }
  return path;
}

function samePhysicalFile(left, right) {
  return (
    left.isFile() &&
    !left.isSymbolicLink() &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readBoundedPhysicalFile(path, maximumBytes, label) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error(`${label} has an invalid byte limit`);
  }
  const before = await lstat(path, { bigint: true }).catch(() => null);
  if (
    before === null ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1n ||
    before.size > BigInt(maximumBytes)
  ) {
    throw new Error(`${label} must be a bounded physical file`);
  }
  const physicalPath = await realpath(path);
  if (!samePlatformPath(path, physicalPath)) {
    throw new Error(`${label} must be a bounded physical file`);
  }
  const handle = await open(path, VERIFIED_READ_FLAGS);
  try {
    const beforeHandle = await handle.stat({ bigint: true });
    if (!samePhysicalFile(before, beforeHandle)) {
      throw new Error(`${label} changed before it could be read`);
    }
    const expectedBytes = Number(beforeHandle.size);
    const bytes = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        expectedBytes - offset,
        offset,
      );
      if (bytesRead < 1) {
        throw new Error(`${label} changed size while it was being read`);
      }
      offset += bytesRead;
    }
    const [afterHandle, afterPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }).catch(() => null),
    ]);
    if (
      afterPath === null ||
      offset !== expectedBytes ||
      !samePhysicalFile(beforeHandle, afterHandle) ||
      !samePhysicalFile(beforeHandle, afterPath)
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function platformEntries(policy) {
  return Object.entries(policy.platforms).map(([platformKey, entry]) =>
    Object.freeze({ platformKey, entry }),
  );
}

async function collectAuthenticatedPrebuildDirectory(
  inputDirectory,
  rawPolicy,
) {
  const policy = validateZstdNativePolicy(rawPolicy);
  const directory = await requirePhysicalDirectory(
    inputDirectory,
    "zstd authenticated prebuild root",
  );
  const platforms = platformEntries(policy);
  const expectedNames = platforms
    .map(({ entry }) => entry.archiveName)
    .sort();
  const entries = await readdir(directory, { withFileTypes: true });
  const actualNames = entries.map(({ name }) => name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      "zstd authenticated prebuild root must contain exactly the three policy archives",
    );
  }

  const archives = [];
  for (const { platformKey, entry } of platforms) {
    const sourcePath = join(directory, entry.archiveName);
    const bytes = await readBoundedPhysicalFile(
      sourcePath,
      entry.archiveBytes,
      `${platformKey} zstd prebuild archive`,
    );
    if (bytes.length !== entry.archiveBytes) {
      throw new Error(`${platformKey} zstd archive byte length differs from policy`);
    }
    const archiveSha256 = sha256(bytes);
    if (archiveSha256 !== entry.archiveSha256) {
      throw new Error(`${platformKey} zstd archive SHA-256 differs from policy`);
    }
    inspectZstdPrebuildArchive(bytes, entry);
    archives.push(
      Object.freeze({
        platformKey,
        archiveName: entry.archiveName,
        archiveBytes: bytes.length,
        archiveSha256,
        sourcePath,
        bytes,
      }),
    );
  }
  return Object.freeze({ directory, archives: Object.freeze(archives), policy });
}

export async function requireAuthenticatedPrebuildDirectory(
  inputDirectory,
  policy = ZSTD_NATIVE_POLICY,
) {
  const result = await collectAuthenticatedPrebuildDirectory(
    inputDirectory,
    policy,
  );
  return Object.freeze({
    directory: result.directory,
    archives: Object.freeze(
      result.archives.map(
        ({ platformKey, archiveName, archiveBytes, archiveSha256, sourcePath }) =>
          Object.freeze({
            platformKey,
            archiveName,
            archiveBytes,
            archiveSha256,
            sourcePath,
          }),
      ),
    ),
  });
}

function filesystemPath(root, portablePath) {
  return join(root, ...portablePath.split("/"));
}

async function collectPackageFiles(installedPackageDirectory) {
  const sourceRoot = await requirePhysicalDirectory(
    installedPackageDirectory,
    "installed @mongodb-js/zstd package root",
  );
  const files = [];
  let totalBytes = 0;
  for (const relativePath of ZSTD_NATIVE_PACKAGE_FILE_PATHS) {
    const bytes = await readBoundedPhysicalFile(
      filesystemPath(sourceRoot, relativePath),
      MAX_BUNDLED_PACKAGE_FILE_BYTES,
      `bundled @mongodb-js/zstd file ${relativePath}`,
    );
    totalBytes += bytes.length;
    if (totalBytes > MAX_BUNDLED_PACKAGE_BYTES) {
      throw new Error("bundled @mongodb-js/zstd package exceeds its byte limit");
    }
    files.push(Object.freeze({ relativePath, bytes }));
  }
  const manifestFile = files.find(
    ({ relativePath }) => relativePath === "package.json",
  );
  if (manifestFile === undefined) {
    throw new Error("fixed @mongodb-js/zstd inventory omitted package.json");
  }
  let rawManifest;
  try {
    rawManifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  } catch {
    throw new Error("zstd package manifest must contain valid JSON");
  }
  const manifest = requireBundledZstdManifest(rawManifest);
  return Object.freeze({ files: Object.freeze(files), manifest });
}

async function inventoryPhysicalFiles(root) {
  const pending = [root];
  const files = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    const physicalDirectory = await requirePhysicalDirectory(
      directory,
      "staged @mongodb-js/zstd directory",
    );
    const entries = await readdir(physicalDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(physicalDirectory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        pending.push(path);
        continue;
      }
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(
          "staged @mongodb-js/zstd contains a non-physical inventory entry",
        );
      }
      const physicalPath = await realpath(path);
      if (!samePlatformPath(path, physicalPath)) {
        throw new Error(
          "staged @mongodb-js/zstd contains a non-physical inventory entry",
        );
      }
      files.push(relative(root, path).split(sep).join("/"));
    }
  }
  return files.sort();
}

export async function stageZstdNativeReleaseBundle({
  installedPackageDirectory,
  prebuildsDirectory,
  destinationPackageDirectory,
  policy = ZSTD_NATIVE_POLICY,
}) {
  const packageFiles = await collectPackageFiles(installedPackageDirectory);
  const prebuilds = await collectAuthenticatedPrebuildDirectory(
    prebuildsDirectory,
    policy,
  );
  if (
    typeof destinationPackageDirectory !== "string" ||
    destinationPackageDirectory.length === 0 ||
    destinationPackageDirectory.includes("\0")
  ) {
    throw new Error("staged @mongodb-js/zstd destination requires a path");
  }
  const destinationRoot = resolve(destinationPackageDirectory);
  if ((await lstat(destinationRoot).catch(() => null)) !== null) {
    throw new Error("staged @mongodb-js/zstd destination must not already exist");
  }

  let created = false;
  try {
    await mkdir(dirname(destinationRoot), { recursive: true, mode: 0o755 });
    await mkdir(destinationRoot, { recursive: false, mode: 0o755 }).catch(
      (error) => {
        if (error && typeof error === "object" && error.code === "EEXIST") {
          throw new Error(
            "staged @mongodb-js/zstd destination must remain fresh",
          );
        }
        throw error;
      },
    );
    created = true;
    await requirePhysicalDirectory(
      destinationRoot,
      "staged @mongodb-js/zstd package root",
    );

    for (const { relativePath, bytes } of packageFiles.files) {
      const destinationPath = filesystemPath(destinationRoot, relativePath);
      await mkdir(dirname(destinationPath), { recursive: true, mode: 0o755 });
      await writeFile(destinationPath, bytes, {
        flag: "wx",
        mode: 0o644,
      });
    }
    for (const archive of prebuilds.archives) {
      const relativePath = `prebuilds/${archive.archiveName}`;
      const destinationPath = filesystemPath(destinationRoot, relativePath);
      await mkdir(dirname(destinationPath), { recursive: true, mode: 0o755 });
      await writeFile(destinationPath, archive.bytes, {
        flag: "wx",
        mode: 0o644,
      });
    }

    const inventory = await inventoryPhysicalFiles(destinationRoot);
    const expectedInventory = [...ZSTD_NATIVE_BUNDLE_FILE_PATHS].sort();
    if (JSON.stringify(inventory) !== JSON.stringify(expectedInventory)) {
      throw new Error(
        "staged @mongodb-js/zstd inventory differs from the fixed release bundle",
      );
    }
    for (const { relativePath, bytes } of packageFiles.files) {
      const stagedBytes = await readBoundedPhysicalFile(
        filesystemPath(destinationRoot, relativePath),
        bytes.length,
        `staged @mongodb-js/zstd file ${relativePath}`,
      );
      if (!stagedBytes.equals(bytes)) {
        throw new Error(
          `staged @mongodb-js/zstd file ${relativePath} differs from its source`,
        );
      }
    }
    for (const archive of prebuilds.archives) {
      const relativePath = `prebuilds/${archive.archiveName}`;
      const stagedBytes = await readBoundedPhysicalFile(
        filesystemPath(destinationRoot, relativePath),
        archive.archiveBytes,
        `staged @mongodb-js/zstd archive ${archive.archiveName}`,
      );
      if (!stagedBytes.equals(archive.bytes)) {
        throw new Error(
          `staged @mongodb-js/zstd archive ${archive.archiveName} differs from policy`,
        );
      }
    }
    return Object.freeze({
      manifest: packageFiles.manifest,
      filePaths: ZSTD_NATIVE_BUNDLE_FILE_PATHS,
    });
  } catch (error) {
    if (created) {
      await rm(destinationRoot, { recursive: true, force: true });
    }
    throw error;
  }
}
