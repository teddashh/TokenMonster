// @ts-check

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  NtExecutable,
  NtExecutableResource,
  Resource,
} from "resedit";

const MAX_WINDOWS_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_SQUIRREL_VERSION_RESOURCE_BYTES = 4 * 1024;
const WINDOWS_VERSION_RESOURCE_TYPE = 16;
const SQUIRREL_AWARE_KEY = "SquirrelAwareVersion";
const SQUIRREL_AWARE_VERSION = "1";
const SQUIRREL_VERSION_LANGUAGE = Object.freeze({
  lang: 0x0409,
  codepage: 0x04b0,
});

/**
 * @param {import("node:fs").BigIntStats} left
 * @param {import("node:fs").BigIntStats} right
 * @param {boolean} compareMutableMetadata
 */
function samePhysicalFile(left, right, compareMutableMetadata) {
  return (
    left.isFile() &&
    right.isFile() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === 1n &&
    right.nlink === 1n &&
    (!compareMutableMetadata ||
      (left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs))
  );
}

/**
 * @param {Buffer} bytes
 * @param {boolean} allowCertificate
 */
function readSquirrelAwareness(bytes, allowCertificate) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 1 ||
    bytes.length > MAX_WINDOWS_EXECUTABLE_BYTES
  ) {
    throw new Error("Windows executable is outside its PE inspection bound.");
  }
  let executable;
  let resources;
  let versions;
  try {
    executable = NtExecutable.from(
      bytes,
      allowCertificate ? { ignoreCert: true } : undefined,
    );
    resources = NtExecutableResource.from(executable);
    versions = Resource.VersionInfo.fromEntries(resources.entries);
  } catch {
    throw new Error("Windows executable has malformed PE resources.");
  }
  const [versionInfo] = versions;
  if (versions.length !== 1 || versionInfo === undefined) {
    throw new Error("Windows executable must have one version resource.");
  }
  const versionEntries = resources.entries.filter(
    (entry) => entry.type === WINDOWS_VERSION_RESOURCE_TYPE,
  );
  if (
    versionEntries.length !== 1 ||
    versionEntries[0] === undefined ||
    versionEntries[0].id !== 1
  ) {
    throw new Error(
      "Windows executable must have one standard version-resource entry.",
    );
  }
  if (
    versionEntries[0].bin.byteLength < 1 ||
    versionEntries[0].bin.byteLength > MAX_SQUIRREL_VERSION_RESOURCE_BYTES
  ) {
    throw new Error(
      "Windows executable exceeds the Squirrel version-resource byte bound.",
    );
  }
  const languages = versionInfo.getAllLanguagesForStringValues();
  const [language] = languages;
  if (
    languages.length !== 1 ||
    language === undefined ||
    language.lang !== SQUIRREL_VERSION_LANGUAGE.lang ||
    language.codepage !== SQUIRREL_VERSION_LANGUAGE.codepage
  ) {
    throw new Error(
      "Windows executable lacks the exact Squirrel version-resource language.",
    );
  }
  const values = versionInfo.getStringValues(language);
  return Object.freeze({
    executable,
    resources,
    versionInfo,
    language,
    value: Object.hasOwn(values, SQUIRREL_AWARE_KEY)
      ? values[SQUIRREL_AWARE_KEY]
      : null,
  });
}

/**
 * @param {string} inputPath
 * @param {boolean} writable
 */
async function openPhysicalExecutable(inputPath, writable) {
  const requestedPath = resolve(inputPath);
  const pathBefore = await lstat(requestedPath, { bigint: true });
  if (
    !pathBefore.isFile() ||
    pathBefore.isSymbolicLink() ||
    pathBefore.nlink !== 1n ||
    pathBefore.size < 1n ||
    pathBefore.size > BigInt(MAX_WINDOWS_EXECUTABLE_BYTES)
  ) {
    throw new Error("Windows executable must be one bounded physical file.");
  }
  const physicalPath = await realpath(requestedPath);
  const physicalBefore = await lstat(physicalPath, { bigint: true });
  if (!samePhysicalFile(pathBefore, physicalBefore, true)) {
    throw new Error("Windows executable path changed during canonicalization.");
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const flags = (writable ? constants.O_RDWR : constants.O_RDONLY) | noFollow;
  const handle = await open(physicalPath, flags);
  try {
    const handleBefore = await handle.stat({ bigint: true });
    if (!samePhysicalFile(pathBefore, handleBefore, true)) {
      throw new Error("Windows executable changed before PE inspection.");
    }
    const bytes = await handle.readFile();
    const handleAfter = await handle.stat({ bigint: true });
    if (
      bytes.length !== Number(handleBefore.size) ||
      !samePhysicalFile(handleBefore, handleAfter, true)
    ) {
      throw new Error("Windows executable changed during PE inspection.");
    }
    return Object.freeze({
      bytes,
      handle,
      metadata: handleBefore,
      path: requestedPath,
      physicalPath,
    });
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Squirrel 2.0.1 invokes lifecycle hooks only when this exact English version
 * block value is present in the packaged application executable.
 *
 * @param {string} path
 */
export async function markSquirrelAwareExecutable(path) {
  const opened = await openPhysicalExecutable(path, true);
  const { handle, metadata } = opened;
  try {
    // Mutating a signed PE would discard its certificate table. The writable
    // path deliberately keeps resedit's default signed-binary rejection.
    const parsed = readSquirrelAwareness(opened.bytes, false);
    parsed.versionInfo.setStringValue(
      parsed.language,
      SQUIRREL_AWARE_KEY,
      SQUIRREL_AWARE_VERSION,
      false,
    );
    parsed.versionInfo.outputToResourceEntries(parsed.resources.entries);
    parsed.resources.outputResource(parsed.executable);
    const output = Buffer.from(parsed.executable.generate());
    if (
      output.length < 1 ||
      output.length > MAX_WINDOWS_EXECUTABLE_BYTES
    ) {
      throw new Error("Marked Windows executable exceeded its byte bound.");
    }
    let written = 0;
    while (written < output.length) {
      const result = await handle.write(
        output,
        written,
        output.length - written,
        written,
      );
      if (result.bytesWritten < 1) {
        throw new Error("Windows executable marker write ended early.");
      }
      written += result.bytesWritten;
    }
    await handle.truncate(output.length);
    await handle.sync();
    const handleAfter = await handle.stat({ bigint: true });
    const [pathAfter, physicalAfter] = await Promise.all([
      lstat(opened.path, { bigint: true }),
      lstat(opened.physicalPath, { bigint: true }),
    ]);
    if (
      !samePhysicalFile(metadata, handleAfter, false) ||
      !samePhysicalFile(handleAfter, pathAfter, true) ||
      !samePhysicalFile(handleAfter, physicalAfter, true) ||
      handleAfter.size !== BigInt(output.length)
    ) {
      throw new Error("Windows executable identity changed during marker write.");
    }
    const persisted = Buffer.alloc(output.length);
    let read = 0;
    while (read < persisted.length) {
      const result = await handle.read(
        persisted,
        read,
        persisted.length - read,
        read,
      );
      if (result.bytesRead < 1) {
        throw new Error("Windows executable marker read ended early.");
      }
      read += result.bytesRead;
    }
    const trailing = Buffer.alloc(1);
    const trailingRead = await handle.read(trailing, 0, 1, persisted.length);
    const [handleVerified, pathVerified, physicalVerified] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(opened.path, { bigint: true }),
      lstat(opened.physicalPath, { bigint: true }),
    ]);
    if (
      trailingRead.bytesRead !== 0 ||
      !persisted.equals(output) ||
      !samePhysicalFile(handleAfter, handleVerified, true) ||
      !samePhysicalFile(handleVerified, pathVerified, true) ||
      !samePhysicalFile(handleVerified, physicalVerified, true)
    ) {
      throw new Error("Windows executable marker bytes did not persist exactly.");
    }
    const verified = readSquirrelAwareness(persisted, false);
    if (verified.value !== SQUIRREL_AWARE_VERSION) {
      throw new Error("Windows executable rejected its Squirrel marker.");
    }
    return Object.freeze({
      language: "040904B0",
      version: SQUIRREL_AWARE_VERSION,
    });
  } finally {
    await handle.close();
  }
}

/** @param {string} path */
export async function verifySquirrelAwareExecutable(path) {
  const opened = await openPhysicalExecutable(path, false);
  try {
    // Verification is read-only and must also inspect the final Authenticode-
    // signed release executable after Electron Packager has signed it.
    const parsed = readSquirrelAwareness(opened.bytes, true);
    if (parsed.value !== SQUIRREL_AWARE_VERSION) {
      throw new Error(
        "Windows executable lacks its exact Squirrel awareness marker.",
      );
    }
    const [handleAfter, pathAfter, physicalAfter] = await Promise.all([
      opened.handle.stat({ bigint: true }),
      lstat(opened.path, { bigint: true }),
      lstat(opened.physicalPath, { bigint: true }),
    ]);
    if (
      !samePhysicalFile(opened.metadata, handleAfter, true) ||
      !samePhysicalFile(opened.metadata, pathAfter, true) ||
      !samePhysicalFile(opened.metadata, physicalAfter, true)
    ) {
      throw new Error("Windows executable changed during marker verification.");
    }
    return Object.freeze({
      language: "040904B0",
      version: SQUIRREL_AWARE_VERSION,
    });
  } finally {
    await opened.handle.close();
  }
}
