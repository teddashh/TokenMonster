#!/usr/bin/env node

// @ts-check

import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Readable } from "node:stream";

import yauzl from "yauzl";

const MAX_FILE_COUNT = 5_000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SETUP_BYTES = 512 * 1024 * 1024;
const MAX_RELEASES_BYTES = 64 * 1024;
const MAX_TREE_DEPTH = 24;
const SQUIRREL_PAYLOAD_PREFIX = "lib/net45/";
const EXECUTION_STUB_PAYLOAD_PATH = "TokenMonster_ExecutionStub.exe";
const INSTALLED_ENTRY_POINT = "TokenMonster.exe";
const INVENTORY_DIAGNOSTIC_PATH_LIMIT = 20;

/** @typedef {{ bytes: number; sha256: string }} FileDigest */
/** @typedef {{ dev: string; ino: string; mtimeNs: string; ctimeNs: string }} FileIdentity */
/** @typedef {{ bytes: number; sha256: string; identity: Readonly<FileIdentity> }} PhysicalFileBinding */
/** @typedef {{ relativePath: string; bytes: number; sha256: string }} InventoryFile */
/** @typedef {Map<string, Readonly<InventoryFile>>} FileInventory */
/** @typedef {import("yauzl").ZipFile} ZipFile */
/** @typedef {import("yauzl").Entry} ZipEntry */

class FileHandleRangeReadStream extends Readable {
  /**
   * @param {import("node:fs/promises").FileHandle} handle
   * @param {number} start
   * @param {number} end
   */
  constructor(handle, start, end) {
    super();
    this.handle = handle;
    this.position = start;
    this.end = end;
    /** @type {Promise<import("node:fs/promises").FileReadResult<Buffer>> | null} */
    this.pendingRead = null;
  }

  /** @override @param {number} requestedBytes */
  _read(requestedBytes) {
    if (this.pendingRead !== null || this.destroyed) return;
    if (this.position >= this.end) {
      this.push(null);
      return;
    }
    const length = Math.min(
      Number.isSafeInteger(requestedBytes) && requestedBytes > 0
        ? requestedBytes
        : 1,
      64 * 1024,
      this.end - this.position,
    );
    const buffer = Buffer.allocUnsafe(length);
    const position = this.position;
    const pendingRead = this.handle.read(buffer, 0, length, position);
    this.pendingRead = pendingRead;
    void pendingRead.then(
      ({ bytesRead }) => {
        if (this.pendingRead === pendingRead) this.pendingRead = null;
        if (this.destroyed) return;
        if (
          !Number.isSafeInteger(bytesRead) ||
          bytesRead < 1 ||
          bytesRead > length
        ) {
          this.destroy(
            new Error("ZIP range ended before its advertised boundary."),
          );
          return;
        }
        this.position = position + bytesRead;
        this.push(buffer.subarray(0, bytesRead));
      },
      (error) => {
        if (this.pendingRead === pendingRead) this.pendingRead = null;
        if (this.destroyed) return;
        this.destroy(
          error instanceof Error
            ? error
            : new Error("Squirrel package range read failed."),
        );
      },
    );
  }

  /**
   * Deliberately leave the shared FileHandle open; this stream does not own it.
   * @override
   * @param {Error | null} error
   * @param {(error?: Error | null) => void} callback
   */
  _destroy(error, callback) {
    const pendingRead = this.pendingRead;
    if (pendingRead === null) {
      callback(error);
      return;
    }
    let called = false;
    /** @param {Error | null} nextError */
    const done = (nextError) => {
      if (called) return;
      called = true;
      callback(nextError);
    };
    void pendingRead.then(
      () => done(error),
      (readError) =>
        done(
          error ??
            (readError instanceof Error
              ? readError
              : new Error("Squirrel package range read failed.")),
        ),
    );
  }
}

class FileHandleRandomAccessReader extends yauzl.RandomAccessReader {
  /** @param {import("node:fs/promises").FileHandle} handle */
  constructor(handle) {
    super();
    this.handle = handle;
  }

  /** @override @param {number} start @param {number} end */
  _readStreamForRange(start, end) {
    return new FileHandleRangeReadStream(this.handle, start, end);
  }
}

const arguments_ = process.argv.slice(2);

/** @param {string} left @param {string} right */
function samePlatformPath(left, right) {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

/**
 * @param {string} inputPath
 * @param {string} label
 * @returns {Promise<string>}
 */
async function requirePhysicalFile(inputPath, label) {
  const requestedPath = resolve(inputPath);
  const requestedMetadata = await lstat(requestedPath);
  if (!requestedMetadata.isFile() || requestedMetadata.isSymbolicLink()) {
    throw new Error(`${label} must be a physical file.`);
  }
  const physicalPath = await realpath(requestedPath);
  if (!samePlatformPath(requestedPath, physicalPath)) {
    throw new Error(`${label} path must not traverse a symbolic link.`);
  }
  return physicalPath;
}

/**
 * @param {string} inputPath
 * @param {string} label
 * @returns {Promise<string>}
 */
async function requirePhysicalDirectory(inputPath, label) {
  const requestedPath = resolve(inputPath);
  const requestedMetadata = await lstat(requestedPath);
  if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) {
    throw new Error(`${label} must be a physical directory.`);
  }
  const physicalPath = await realpath(requestedPath);
  if (!samePlatformPath(requestedPath, physicalPath)) {
    throw new Error(`${label} path must not traverse a symbolic link.`);
  }
  return physicalPath;
}

/** @param {string} input */
function safeArchiveEntryName(input) {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    Buffer.byteLength(input, "utf8") > 4_096 ||
    input.includes("\0") ||
    input.includes("\\") ||
    input.startsWith("/") ||
    /^[A-Za-z]:/u.test(input)
  ) {
    return false;
  }
  const segments = input.split("/");
  if (input.endsWith("/")) segments.pop();
  return (
    segments.length >= 1 &&
    segments.length <= MAX_TREE_DEPTH &&
    segments.every(
      (segment) => segment.length >= 1 && segment !== "." && segment !== "..",
    )
  );
}

/**
 * Open yauzl against the same physical handle whose complete bytes and
 * identity were validated. This prevents a path replacement between the
 * precheck and ZIP parsing from changing the comparison authority.
 *
 * @param {string} path
 * @returns {Promise<Readonly<{ binding: Readonly<PhysicalFileBinding>; handle: import("node:fs/promises").FileHandle; metadata: import("node:fs").BigIntStats; zip: ZipFile }>>}
 */
async function openZip(path) {
  const pathMetadata = await lstat(path, { bigint: true });
  if (
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    pathMetadata.size < 1n ||
    pathMetadata.size > BigInt(MAX_TOTAL_BYTES)
  ) {
    throw new Error("Full Squirrel package is not a bounded physical file.");
  }
  const handle = await open(path, "r");
  try {
    const handleMetadata = await handle.stat({ bigint: true });
    if (!samePhysicalFile(pathMetadata, handleMetadata)) {
      throw new Error("Full Squirrel package changed before ZIP parsing.");
    }
    const binding = await hashOpenFileHandle(
      handle,
      handleMetadata,
      "Full Squirrel package",
      MAX_TOTAL_BYTES,
    );
    const reader = new FileHandleRandomAccessReader(handle);
    const zip = await new Promise((resolvePromise, reject) => {
      yauzl.fromRandomAccessReader(
        reader,
        Number(handleMetadata.size),
        {
          autoClose: false,
          decodeStrings: true,
          lazyEntries: true,
          // Squirrel archives created on Windows can carry backslash
          // separators. yauzl normalizes them before the strict path check.
          strictFileNames: false,
          validateEntrySizes: true,
        },
        (error, openedZip) => {
          if (error !== null) {
            reject(error);
            return;
          }
          if (openedZip === undefined) {
            reject(new Error("Squirrel ZIP reader returned no archive."));
            return;
          }
          resolvePromise(openedZip);
        },
      );
    });
    return Object.freeze({ binding, handle, metadata: handleMetadata, zip });
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * @param {ZipFile} zip
 * @param {ZipEntry} entry
 * @returns {Promise<Readonly<FileDigest>>}
 */
function hashZipEntry(zip, entry) {
  return new Promise((resolvePromise, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        reject(error);
        return;
      }
      if (stream === undefined) {
        reject(new Error("Squirrel ZIP reader returned no entry stream."));
        return;
      }
      const hash = createHash("sha256");
      let bytes = 0;
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > entry.uncompressedSize || bytes > MAX_TOTAL_BYTES) {
          stream.destroy(
            new Error("Squirrel payload entry exceeded its size bound."),
          );
          return;
        }
        hash.update(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => {
        if (bytes !== entry.uncompressedSize) {
          reject(new Error("Squirrel payload entry size changed while reading."));
          return;
        }
        resolvePromise(
          Object.freeze({ bytes, sha256: hash.digest("hex") }),
        );
      });
    });
  });
}

/**
 * @param {string} fullPackagePath
 * @returns {Promise<Readonly<{ executionStub: Readonly<InventoryFile>; inventory: FileInventory }>>}
 */
async function inventorySquirrelPayload(fullPackagePath) {
  const opened = await openZip(fullPackagePath);
  const { binding, handle, metadata, zip } = opened;
  try {
    return await new Promise((resolvePromise, reject) => {
      /** @type {FileInventory} */
      const inventory = new Map();
      /** @type {Readonly<InventoryFile> | undefined} */
      let executionStub;
      /** @type {Set<string>} */
      const archiveNames = new Set();
      /** @type {Set<string>} */
      const archiveFoldedNames = new Set();
      let entries = 0;
      let totalBytes = 0;
      let settled = false;
      /** @param {unknown} error */
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      zip.once("error", fail);
      zip.once("end", () => {
        if (settled) return;
        if (inventory.size < 1 || executionStub === undefined) {
          fail(new Error("Full Squirrel package has no lib/net45 payload."));
          return;
        }
        settled = true;
        resolvePromise(Object.freeze({ executionStub, inventory }));
      });
      zip.on("entry", (entry) => {
        void (async () => {
          entries += 1;
          if (entries > MAX_FILE_COUNT) {
            throw new Error("Full Squirrel package exceeded its entry bound.");
          }
          if (!safeArchiveEntryName(entry.fileName)) {
            throw new Error("Full Squirrel package contains an unsafe path.");
          }
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
            throw new Error("Encrypted Squirrel payload entries are forbidden.");
          }
          const archiveFolded = entry.fileName.toLocaleLowerCase("en-US");
          if (
            archiveNames.has(entry.fileName) ||
            archiveFoldedNames.has(archiveFolded)
          ) {
            throw new Error(
              "Full Squirrel package contains duplicate or case-colliding paths.",
            );
          }
          archiveNames.add(entry.fileName);
          archiveFoldedNames.add(archiveFolded);

          const isDirectory = entry.fileName.endsWith("/");
          if (isDirectory) {
            if (entry.uncompressedSize !== 0) {
              throw new Error("Squirrel directory metadata is invalid.");
            }
          } else {
            if (
              !Number.isSafeInteger(entry.uncompressedSize) ||
              entry.uncompressedSize < 0 ||
              entry.uncompressedSize > MAX_TOTAL_BYTES
            ) {
              throw new Error("Squirrel payload file size is outside the bound.");
            }
            totalBytes += entry.uncompressedSize;
            if (totalBytes > MAX_TOTAL_BYTES) {
              throw new Error(
                "Full Squirrel package exceeded its uncompressed byte bound.",
              );
            }
            if (entry.fileName.startsWith(SQUIRREL_PAYLOAD_PREFIX)) {
              const relativePath = entry.fileName.slice(
                SQUIRREL_PAYLOAD_PREFIX.length,
              );
              if (!safeArchiveEntryName(relativePath)) {
                throw new Error("Squirrel application payload path is unsafe.");
              }
              if (relativePath === EXECUTION_STUB_PAYLOAD_PATH) {
                if (executionStub !== undefined) {
                  throw new Error(
                    "Full Squirrel package contains multiple execution stubs.",
                  );
                }
                executionStub = Object.freeze({
                  relativePath,
                  ...(await hashZipEntry(zip, entry)),
                });
                if (!settled) zip.readEntry();
                return;
              }
              const comparisonKey = relativePath.toLocaleLowerCase("en-US");
              if (inventory.has(comparisonKey)) {
                throw new Error(
                  "Squirrel application payload contains a case collision.",
                );
              }
              inventory.set(
                comparisonKey,
                Object.freeze({
                  relativePath,
                  ...(await hashZipEntry(zip, entry)),
                }),
              );
            }
          }
          if (!settled) zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } finally {
    try {
      const [handleAfter, pathAfter] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(fullPackagePath, { bigint: true }),
      ]);
      if (
        !samePhysicalFile(metadata, handleAfter) ||
        !samePhysicalFile(metadata, pathAfter)
      ) {
        throw new Error("Full Squirrel package changed during ZIP parsing.");
      }
      const bindingAfter = await hashOpenFileHandle(
        handle,
        handleAfter,
        "Full Squirrel package",
        MAX_TOTAL_BYTES,
      );
      const [handleFinal, pathFinal] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(fullPackagePath, { bigint: true }),
      ]);
      if (
        bindingAfter.bytes !== binding.bytes ||
        bindingAfter.sha256 !== binding.sha256 ||
        !samePhysicalFile(metadata, handleFinal) ||
        !samePhysicalFile(metadata, pathFinal)
      ) {
        throw new Error("Full Squirrel package bytes changed during parsing.");
      }
    } finally {
      zip.close();
      await handle.close();
    }
  }
}

/**
 * @param {import("node:fs").BigIntStats} left
 * @param {import("node:fs").BigIntStats} right
 */
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

/**
 * @param {import("node:fs").BigIntStats} left
 * @param {import("node:fs").BigIntStats} right
 */
function samePhysicalDirectory(left, right) {
  return (
    left.isDirectory() &&
    !left.isSymbolicLink() &&
    right.isDirectory() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * @param {import("node:fs/promises").FileHandle} handle
 * @param {import("node:fs").BigIntStats} metadata
 * @param {string} label
 * @param {number} maximumBytes
 * @returns {Promise<Readonly<PhysicalFileBinding>>}
 */
async function hashOpenFileHandle(handle, metadata, label, maximumBytes) {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 0n ||
    metadata.size > BigInt(maximumBytes)
  ) {
    throw new Error(`${label} contains a non-physical or oversized file.`);
  }
  const expectedBytes = Number(metadata.size);
  const hash = createHash("sha256");
  let bytes = 0;
  const buffer = Buffer.allocUnsafe(Math.min(expectedBytes || 1, 1024 * 1024));
  while (bytes < expectedBytes) {
    const length = Math.min(buffer.length, expectedBytes - bytes);
    const { bytesRead } = await handle.read(buffer, 0, length, bytes);
    if (bytesRead < 1) {
      throw new Error(`${label} changed size while it was read.`);
    }
    bytes += bytesRead;
    if (bytes > maximumBytes) {
      throw new Error(`${label} exceeded its byte bound while reading.`);
    }
    hash.update(buffer.subarray(0, bytesRead));
  }
  if (bytes !== expectedBytes) {
    throw new Error(`${label} changed size while it was read.`);
  }
  return Object.freeze({
    bytes,
    sha256: hash.digest("hex"),
    identity: Object.freeze({
      dev: metadata.dev.toString(),
      ino: metadata.ino.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
      ctimeNs: metadata.ctimeNs.toString(),
    }),
  });
}

/**
 * Hash one open physical file handle while enforcing the advertised byte
 * budget. Comparing path and handle identities before and after the stream
 * rejects replacement, links, growth, truncation, and same-size rewrites.
 *
 * @param {string} path
 * @param {string} label
 * @param {number} maximumBytes
 * @returns {Promise<Readonly<PhysicalFileBinding>>}
 */
async function hashPhysicalFile(path, label, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error(`${label} has no valid byte budget.`);
  }
  const beforePath = await lstat(path, { bigint: true });
  if (
    !beforePath.isFile() ||
    beforePath.isSymbolicLink() ||
    beforePath.size < 0n ||
    beforePath.size > BigInt(maximumBytes)
  ) {
    throw new Error(`${label} contains a non-physical or oversized file.`);
  }
  const handle = await open(path, "r");
  try {
    const beforeHandle = await handle.stat({ bigint: true });
    if (!samePhysicalFile(beforePath, beforeHandle)) {
      throw new Error(`${label} changed before it could be inventoried.`);
    }
    const binding = await hashOpenFileHandle(
      handle,
      beforeHandle,
      label,
      maximumBytes,
    );
    const [afterHandle, afterPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (
      !samePhysicalFile(beforeHandle, afterHandle) ||
      !samePhysicalFile(beforeHandle, afterPath)
    ) {
      throw new Error(`${label} changed while it was inventoried.`);
    }
    return binding;
  } finally {
    await handle.close();
  }
}

/**
 * @param {string} root
 * @param {string} label
 * @returns {Promise<Readonly<{ entryCount: number; fileCount: number; inventory: FileInventory; totalBytes: number }>>}
 */
async function inventoryDirectory(root, label) {
  /** @type {FileInventory} */
  const inventory = new Map();
  let entryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;

  /**
   * @param {string} directory
   * @param {string[]} relativeParts
   * @param {number} depth
   * @returns {Promise<void>}
   */
  async function walk(directory, relativeParts, depth) {
    if (depth > MAX_TREE_DEPTH) {
      throw new Error(`${label} exceeded its directory depth bound.`);
    }
    const directoryBefore = await lstat(directory, { bigint: true });
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
      throw new Error(`${label} contains a non-physical directory.`);
    }
    const physicalDirectory = await realpath(directory);
    if (!samePlatformPath(directory, physicalDirectory)) {
      throw new Error(`${label} directory path traverses a symbolic link.`);
    }
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    entryCount += entries.length;
    if (entryCount > MAX_FILE_COUNT) {
      throw new Error(`${label} exceeded its directory-entry bound.`);
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link.`);
      }
      const nextParts = [...relativeParts, entry.name];
      if (metadata.isDirectory()) {
        await walk(path, nextParts, depth + 1);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`${label} contains a non-regular entry.`);
      }
      const relativePath = nextParts.join("/");
      const comparisonKey = relativePath.toLocaleLowerCase("en-US");
      if (inventory.has(comparisonKey)) {
        throw new Error(`${label} contains a case-colliding path.`);
      }
      fileCount += 1;
      if (fileCount > MAX_FILE_COUNT) {
        throw new Error(`${label} exceeded its file or byte bound.`);
      }
      const digest = await hashPhysicalFile(
        path,
        label,
        MAX_TOTAL_BYTES - totalBytes,
      );
      totalBytes += digest.bytes;
      inventory.set(
        comparisonKey,
        Object.freeze({
          relativePath,
          bytes: digest.bytes,
          sha256: digest.sha256,
        }),
      );
    }
    const directoryAfter = await lstat(directory, { bigint: true });
    if (!samePhysicalDirectory(directoryBefore, directoryAfter)) {
      throw new Error(`${label} directory changed while it was inventoried.`);
    }
  }

  await walk(root, [], 0);
  return Object.freeze({ entryCount, fileCount, inventory, totalBytes });
}

/** @param {string[]} paths */
function summarizeInventoryPaths(paths) {
  const sorted = [...paths].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const visible = sorted.slice(0, INVENTORY_DIAGNOSTIC_PATH_LIMIT);
  const remainder = sorted.length - visible.length;
  return `${JSON.stringify(visible)}${remainder > 0 ? ` (+${remainder} more)` : ""}`;
}

/** @param {string[]} input */
async function snapshotMakerArtifacts(input) {
  const [
    mode,
    setupFlag,
    setupArgument,
    fullPackageFlag,
    fullPackageArgument,
    releasesFlag,
    releasesArgument,
  ] = input;
  if (
    input.length !== 7 ||
    mode !== "--snapshot-maker" ||
    setupFlag !== "--setup" ||
    typeof setupArgument !== "string" ||
    fullPackageFlag !== "--full-package" ||
    typeof fullPackageArgument !== "string" ||
    releasesFlag !== "--releases" ||
    typeof releasesArgument !== "string"
  ) {
    throw new Error(
      "Usage: verify-installed-companion.mjs --snapshot-maker --setup <path> --full-package <path> --releases <path>",
    );
  }
  const [setupPath, fullPackagePath, releasesPath] = await Promise.all([
    requirePhysicalFile(setupArgument, "Squirrel Setup"),
    requirePhysicalFile(fullPackageArgument, "Full Squirrel package"),
    requirePhysicalFile(releasesArgument, "Squirrel RELEASES"),
  ]);
  const makerDirectory = dirname(setupPath);
  if (
    !samePlatformPath(dirname(fullPackagePath), makerDirectory) ||
    !samePlatformPath(dirname(releasesPath), makerDirectory)
  ) {
    throw new Error("Squirrel maker artifacts must share one physical directory.");
  }
  if (
    basename(setupPath) !== "TokenMonsterSetup.exe" ||
    !basename(fullPackagePath).endsWith("-full.nupkg") ||
    basename(releasesPath).toUpperCase() !== "RELEASES"
  ) {
    throw new Error("Squirrel maker artifact names are not canonical.");
  }
  const [setup, fullPackage, releases] = await Promise.all([
    hashPhysicalFile(setupPath, "Squirrel Setup", MAX_SETUP_BYTES),
    hashPhysicalFile(
      fullPackagePath,
      "Full Squirrel package",
      MAX_TOTAL_BYTES,
    ),
    hashPhysicalFile(releasesPath, "Squirrel RELEASES", MAX_RELEASES_BYTES),
  ]);
  process.stdout.write(
    `${JSON.stringify({
      makerArtifactBindingContractVersion: 1,
      files: [
        { role: "setup", ...setup },
        { role: "full-package", ...fullPackage },
        { role: "releases", ...releases },
      ],
    })}\n`,
  );
}

/** @param {string[]} input */
async function verifyInstalledCompanion(input) {
  const [
    fullPackageFlag,
    fullPackageArgument,
    installedDirectoryFlag,
    installedDirectoryArgument,
    installRootFlag,
    installRootArgument,
  ] = input;
  if (
    input.length !== 6 ||
    fullPackageFlag !== "--full-package" ||
    typeof fullPackageArgument !== "string" ||
    installedDirectoryFlag !== "--installed-directory" ||
    typeof installedDirectoryArgument !== "string" ||
    installRootFlag !== "--install-root" ||
    typeof installRootArgument !== "string"
  ) {
    throw new Error(
      "Usage: verify-installed-companion.mjs --full-package <path> --installed-directory <path> --install-root <path>",
    );
  }
  const fullPackagePath = await requirePhysicalFile(
    fullPackageArgument,
    "Full Squirrel package",
  );
  if (!basename(fullPackagePath).endsWith("-full.nupkg")) {
    throw new Error("Expected a full Squirrel package.");
  }
  const installedRoot = await requirePhysicalDirectory(
    installedDirectoryArgument,
    "Installed companion",
  );
  const installRoot = await requirePhysicalDirectory(
    installRootArgument,
    "Squirrel install root",
  );
  if (!samePlatformPath(dirname(installedRoot), installRoot)) {
    throw new Error(
      "Installed companion must be a direct child of its install root.",
    );
  }

  const packageBefore = await lstat(fullPackagePath, { bigint: true });
  if (
    !packageBefore.isFile() ||
    packageBefore.isSymbolicLink() ||
    packageBefore.size < 1n ||
    packageBefore.size > BigInt(MAX_TOTAL_BYTES)
  ) {
    throw new Error("Full Squirrel package is outside its physical byte bound.");
  }
  const [expectedPayload, installedResult] = await Promise.all([
    inventorySquirrelPayload(fullPackagePath),
    inventoryDirectory(installedRoot, "Installed companion"),
  ]);
  const packageAfter = await lstat(fullPackagePath, { bigint: true });
  if (!samePhysicalFile(packageBefore, packageAfter)) {
    throw new Error("Full Squirrel package changed during comparison.");
  }

  const expected = expectedPayload.inventory;
  const installed = installedResult.inventory;
  if (expected.size !== installed.size) {
    const missing = [...expected]
      .filter(([key]) => !installed.has(key))
      .map(([, file]) => file.relativePath);
    const unexpected = [...installed]
      .filter(([key]) => !expected.has(key))
      .map(([, file]) => file.relativePath);
    throw new Error(
      `Installed companion file inventory differs from the full Squirrel package: expected ${expected.size}, installed ${installed.size}; missing ${summarizeInventoryPaths(missing)}; unexpected ${summarizeInventoryPaths(unexpected)}.`,
    );
  }
  for (const [key, expectedFile] of expected) {
    const installedFile = installed.get(key);
    if (
      installedFile === undefined ||
      installedFile.bytes !== expectedFile.bytes ||
      installedFile.sha256 !== expectedFile.sha256
    ) {
      throw new Error(
        `Installed companion bytes differ from the full Squirrel package: ${expectedFile.relativePath}`,
      );
    }
  }
  if (installedResult.entryCount + 1 > MAX_FILE_COUNT) {
    throw new Error("Installed companion exceeded its total file bound.");
  }
  const installedEntryPoint = await hashPhysicalFile(
    resolve(installRoot, INSTALLED_ENTRY_POINT),
    "Installed Squirrel entry point",
    MAX_TOTAL_BYTES - installedResult.totalBytes,
  );
  if (
    installedEntryPoint.bytes !== expectedPayload.executionStub.bytes ||
    installedEntryPoint.sha256 !== expectedPayload.executionStub.sha256
  ) {
    throw new Error(
      "Installed Squirrel entry point differs from the full-package execution stub.",
    );
  }

  process.stdout.write(
    `Verified ${installed.size + 1} installed companion and entry-point files against exact full-nupkg payload bytes.\n`,
  );
}

if (arguments_[0] === "--snapshot-maker") {
  await snapshotMakerArtifacts(arguments_);
} else {
  await verifyInstalledCompanion(arguments_);
}
