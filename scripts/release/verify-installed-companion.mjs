#!/usr/bin/env node

// @ts-check

import { createHash } from "node:crypto";
import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Readable } from "node:stream";

import yauzl from "yauzl";

const MAX_FILE_COUNT = 5_000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SETUP_BYTES = 512 * 1024 * 1024;
const MAX_RELEASES_BYTES = 64 * 1024;
const MAX_SQUIRREL_UPDATE_LOG_BYTES = 16 * 1024;
const MAX_TREE_DEPTH = 24;
const SQUIRREL_UPDATE_LOG_WAIT_MS = 15_000;
const SQUIRREL_UPDATE_LOG_POLL_MS = 50;
const SQUIRREL_PAYLOAD_PREFIX = "lib/net45/";
const EXECUTION_STUB_PAYLOAD_PATH = "TokenMonster_ExecutionStub.exe";
const INSTALLED_ENTRY_POINT = "TokenMonster.exe";
const INSTALLED_UPDATE_EXECUTABLE = "Update.exe";
const PACKAGED_UPDATE_EXECUTABLE = "squirrel.exe";
const SQUIRREL_UPDATE_SELF_LOG = "Squirrel-UpdateSelf.log";
const SQUIRREL_UPDATE_SELF_QUARANTINE =
  ".tokenmonster-squirrel-update-self.verifying";

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

/** @param {number} milliseconds */
function wait(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds)
  );
}

/** @param {unknown} error @param {string[]} codes */
function hasErrorCode(error, codes) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

/**
 * @param {string} path
 * @param {string} label
 * @param {number} maximumBytes
 * @returns {Promise<Buffer>}
 */
async function readBoundedPhysicalFile(path, label, maximumBytes) {
  const beforePath = await lstat(path, { bigint: true });
  if (
    !beforePath.isFile() ||
    beforePath.isSymbolicLink() ||
    beforePath.size < 0n ||
    beforePath.size > BigInt(maximumBytes)
  ) {
    throw new Error(`${label} is not a bounded physical file.`);
  }
  const physicalPath = await realpath(path);
  if (!samePlatformPath(path, physicalPath)) {
    throw new Error(`${label} path must not traverse a symbolic link.`);
  }
  const handle = await open(path, "r");
  try {
    const beforeHandle = await handle.stat({ bigint: true });
    if (!samePhysicalFile(beforePath, beforeHandle)) {
      throw new Error(`${label} changed before it could be read.`);
    }
    const bytes = Buffer.alloc(Number(beforeHandle.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset
      );
      if (bytesRead < 1) {
        throw new Error(`${label} changed size while it was read.`);
      }
      offset += bytesRead;
    }
    const [afterHandle, afterPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true })
    ]);
    if (
      !samePhysicalFile(beforeHandle, afterHandle) ||
      !samePhysicalFile(beforeHandle, afterPath)
    ) {
      throw new Error(`${label} changed while it was read.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/** @param {string} line */
function parseSquirrelUpdateLogLine(line) {
  const match =
    /^\[((?:0[1-9]|[12][0-9]|3[01]))\/((?:0[1-9]|1[0-2]))\/([0-9]{2}) ((?:[01][0-9]|2[0-3])):([0-5][0-9]):([0-5][0-9])\] info: (.*)$/u.exec(
      line
    );
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    match[4] === undefined ||
    match[5] === undefined ||
    match[6] === undefined ||
    match[7] === undefined
  ) {
    throw new Error("Squirrel update-self log has invalid line framing.");
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const timestamp = Date.UTC(2000 + year, month - 1, day, hour, minute, second);
  const instant = new Date(timestamp);
  if (
    instant.getUTCFullYear() !== 2000 + year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day ||
    instant.getUTCHours() !== hour ||
    instant.getUTCMinutes() !== minute ||
    instant.getUTCSeconds() !== second
  ) {
    throw new Error("Squirrel update-self log has an invalid timestamp.");
  }
  return Object.freeze({ message: match[7], timestamp });
}

/** @param {Buffer} bytes @param {string} installRoot */
function validateSquirrelUpdateSelfLog(bytes, installRoot) {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  if (bytes.length < bom.length || !bytes.subarray(0, bom.length).equals(bom)) {
    throw new Error("Squirrel update-self log lacks its canonical UTF-8 BOM.");
  }
  const encoded = bytes.subarray(bom.length);
  const contents = encoded.toString("utf8");
  if (!Buffer.from(contents, "utf8").equals(encoded)) {
    throw new Error("Squirrel update-self log is not canonical UTF-8.");
  }
  const lines = contents.split("\r\n");
  if (lines.length !== 4 || lines[3] !== "") {
    throw new Error("Squirrel update-self log has an unexpected line count.");
  }
  const records = lines.slice(0, 3).map(parseSquirrelUpdateLogLine);
  const firstRecord = records[0];
  const parentRecord = records[1];
  const finalRecord = records[2];
  if (
    firstRecord === undefined ||
    parentRecord === undefined ||
    finalRecord === undefined
  ) {
    throw new Error("Squirrel update-self log has an unexpected line count.");
  }
  if (
    firstRecord.timestamp > parentRecord.timestamp ||
    parentRecord.timestamp > finalRecord.timestamp
  ) {
    throw new Error("Squirrel update-self log timestamps are out of order.");
  }
  const updatePrefix = "Program: Starting Squirrel Updater: --updateSelf=";
  if (!firstRecord.message.startsWith(updatePrefix)) {
    throw new Error("Squirrel update-self log lacks its exact start event.");
  }
  const sourceUpdateExecutable = firstRecord.message.slice(updatePrefix.length);
  const expectedSourceUpdateExecutable = resolve(
    dirname(installRoot),
    "SquirrelTemp",
    INSTALLED_UPDATE_EXECUTABLE
  );
  if (
    !samePlatformPath(sourceUpdateExecutable, expectedSourceUpdateExecutable)
  ) {
    throw new Error(
      "Squirrel update-self log names an unexpected source executable."
    );
  }
  if (
    !/^Program: (?:About to wait for parent PID ([1-9][0-9]{0,9})|Parent PID ([1-9][0-9]{0,9}) no longer valid - ignoring)$/u.test(
      parentRecord.message
    )
  ) {
    throw new Error("Squirrel update-self log has an unexpected parent event.");
  }
  const parentMatch = /PID ([1-9][0-9]{0,9})/u.exec(parentRecord.message);
  const parentPid = Number(parentMatch?.[1]);
  if (!Number.isSafeInteger(parentPid) || parentPid > 2_147_483_647) {
    throw new Error("Squirrel update-self log has an invalid parent PID.");
  }
  if (finalRecord.message !== "Program: Finished Squirrel Updater") {
    throw new Error(
      "Squirrel update-self log lacks its exact completion event."
    );
  }
}

/** @param {string} installedRoot @param {string} installRoot */
async function quarantineSquirrelUpdateSelfLog(installedRoot, installRoot) {
  const logPath = resolve(installedRoot, SQUIRREL_UPDATE_SELF_LOG);
  const quarantinePath = resolve(
    installedRoot,
    SQUIRREL_UPDATE_SELF_QUARANTINE
  );
  try {
    await lstat(quarantinePath);
    throw new Error("Squirrel update-self verifier quarantine already exists.");
  } catch (error) {
    if (!hasErrorCode(error, ["ENOENT"])) {
      throw new Error(
        "Squirrel update-self verifier quarantine could not be inspected."
      );
    }
  }
  const deadline = Date.now() + SQUIRREL_UPDATE_LOG_WAIT_MS;
  for (;;) {
    try {
      await rename(logPath, quarantinePath);
      break;
    } catch (error) {
      if (
        Date.now() < deadline &&
        hasErrorCode(error, ["ENOENT", "EACCES", "EBUSY", "EPERM"])
      ) {
        await wait(SQUIRREL_UPDATE_LOG_POLL_MS);
        continue;
      }
      throw new Error(
        "Squirrel update-self log did not reach its closed-file lifecycle barrier."
      );
    }
  }
  let bytes;
  try {
    bytes = await readBoundedPhysicalFile(
      quarantinePath,
      "Squirrel update-self log",
      MAX_SQUIRREL_UPDATE_LOG_BYTES
    );
  } catch {
    throw new Error("Squirrel update-self log could not be read safely.");
  }
  validateSquirrelUpdateSelfLog(bytes, installRoot);
  return quarantinePath;
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
    installRootArgument
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
      "Usage: verify-installed-companion.mjs --full-package <path> --installed-directory <path> --install-root <path>"
    );
  }
  const fullPackagePath = await requirePhysicalFile(
    fullPackageArgument,
    "Full Squirrel package"
  );
  if (!basename(fullPackagePath).endsWith("-full.nupkg")) {
    throw new Error("Expected a full Squirrel package.");
  }
  const installedRoot = await requirePhysicalDirectory(
    installedDirectoryArgument,
    "Installed companion"
  );
  const installRoot = await requirePhysicalDirectory(
    installRootArgument,
    "Squirrel install root"
  );
  if (!samePlatformPath(dirname(installedRoot), installRoot)) {
    throw new Error(
      "Installed companion must be a direct child of its install root."
    );
  }

  const updateLogQuarantine = await quarantineSquirrelUpdateSelfLog(
    installedRoot,
    installRoot
  );

  const packageBefore = await lstat(fullPackagePath, { bigint: true });
  if (
    !packageBefore.isFile() ||
    packageBefore.isSymbolicLink() ||
    packageBefore.size < 1n ||
    packageBefore.size > BigInt(MAX_TOTAL_BYTES)
  ) {
    throw new Error(
      "Full Squirrel package is outside its physical byte bound."
    );
  }
  const expectedPayload = await inventorySquirrelPayload(fullPackagePath);
  const expected = expectedPayload.inventory;
  const expectedUpdater = expected.get(
    PACKAGED_UPDATE_EXECUTABLE.toLocaleLowerCase("en-US")
  );
  if (
    expectedUpdater === undefined ||
    expectedUpdater.relativePath !== PACKAGED_UPDATE_EXECUTABLE
  ) {
    throw new Error(
      "Full Squirrel package lacks its exact packaged update executable."
    );
  }
  const installedUpdater = await hashPhysicalFile(
    resolve(installRoot, INSTALLED_UPDATE_EXECUTABLE),
    "Installed Squirrel updater",
    MAX_TOTAL_BYTES
  );
  if (
    installedUpdater.bytes !== expectedUpdater.bytes ||
    installedUpdater.sha256 !== expectedUpdater.sha256
  ) {
    throw new Error(
      "Installed Squirrel updater differs from the full-package Squirrel executable."
    );
  }
  try {
    await unlink(updateLogQuarantine);
  } catch {
    throw new Error(
      "Validated Squirrel update-self log quarantine could not be removed."
    );
  }

  const installedResult = await inventoryDirectory(
    installedRoot,
    "Installed companion"
  );
  const packageAfter = await lstat(fullPackagePath, { bigint: true });
  if (!samePhysicalFile(packageBefore, packageAfter)) {
    throw new Error("Full Squirrel package changed during comparison.");
  }

  const installed = installedResult.inventory;
  if (expected.size !== installed.size) {
    throw new Error(
      `Installed companion file inventory count differs from the full Squirrel package: expected ${expected.size}, installed ${installed.size}.`
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
        `Installed companion bytes differ from the full Squirrel package: ${expectedFile.relativePath}`
      );
    }
  }
  if (installedResult.entryCount + 2 > MAX_FILE_COUNT) {
    throw new Error("Installed companion exceeded its total file bound.");
  }
  const installedExternalBytes =
    installedResult.totalBytes + installedUpdater.bytes;
  if (installedExternalBytes > MAX_TOTAL_BYTES) {
    throw new Error("Installed companion exceeded its total byte bound.");
  }
  const installedEntryPoint = await hashPhysicalFile(
    resolve(installRoot, INSTALLED_ENTRY_POINT),
    "Installed Squirrel entry point",
    MAX_TOTAL_BYTES - installedExternalBytes
  );
  if (
    installedEntryPoint.bytes !== expectedPayload.executionStub.bytes ||
    installedEntryPoint.sha256 !== expectedPayload.executionStub.sha256
  ) {
    throw new Error(
      "Installed Squirrel entry point differs from the full-package execution stub."
    );
  }

  process.stdout.write(
    `Verified ${installed.size + 2} installed companion, updater, and entry-point files against exact full-nupkg payload bytes.\n`
  );
}

if (arguments_[0] === "--snapshot-maker") {
  await snapshotMakerArtifacts(arguments_);
} else {
  await verifyInstalledCompanion(arguments_);
}
