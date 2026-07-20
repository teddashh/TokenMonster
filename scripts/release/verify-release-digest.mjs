#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_ZSTD_PREBUILD_ARCHIVE_ENTRIES,
  PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY,
  PUBLIC_ZSTD_PREINSTALL_BYTES,
  PUBLIC_ZSTD_PREINSTALL_COMMAND,
  portablePublicTarEntryKey,
  requirePublicTarEntry,
  requirePublicZstdPrebuildArchive,
  requirePublicZstdPreinstallBootstrap,
} from "./public-artifact-policy.mjs";
import { requireCanonicalCliVersion } from "./cli-release-version.mjs";
import {
  validateZstdNativePolicy,
  ZSTD_NATIVE_POLICY,
} from "./zstd-native-verifier.mjs";
import {
  requireBundledZstdManifest,
  ZSTD_NATIVE_BUNDLE_FILE_PATHS,
  ZSTD_NATIVE_PREBUILD_RELATIVE_PATHS,
} from "./zstd-native-release-bundle.mjs";

const MAX_CHECKSUM_BYTES = 4 * 1024;
const MAX_TARBALL_BYTES = 128 * 1024 * 1024;
const MAX_TAR_LISTING_BYTES = 16 * 1024 * 1024;
const MAX_TAR_ENTRIES = 50_000;
const MAX_PACKAGE_MANIFEST_BYTES = 64 * 1_024;
const MAX_SHRINKWRAP_BYTES = 512 * 1_024;
const MAX_ZSTD_POLICY_BYTES = 16 * 1_024;
const MAX_ZSTD_VERIFIER_BYTES = 256 * 1_024;
const MAX_ZSTD_MANIFEST_BYTES = 32 * 1_024;
const MAX_LICENSE_BYTES = 64 * 1_024;
const ZSTD_PACKAGE_PREFIX = "package/node_modules/@mongodb-js/zstd/";
const ZSTD_MANIFEST_ENTRY = `${ZSTD_PACKAGE_PREFIX}package.json`;
const ZSTD_LICENSE_ENTRY = `${ZSTD_PACKAGE_PREFIX}LICENSE.md`;
const ZSTD_TRANSITIVE_LICENSE_ENTRY =
  "package/THIRD_PARTY_LICENSES/Zstandard-1.5.6-BSD.txt";
const RELEASE_SHRINKWRAP_ENTRY = "package/npm-shrinkwrap.json";
const ZSTD_LOCK_PATH = "node_modules/@mongodb-js/zstd";
const ZSTD_NPM_IDENTITY = Object.freeze({
  version: "2.0.1",
  resolved: "https://registry.npmjs.org/@mongodb-js/zstd/-/zstd-2.0.1.tgz",
  integrity:
    "sha512-hbQKltFj0hMrhe+Udh9gjkzswIJJVOo55vEHgfHbb6wjPpo4Oc3kng2bao/XnzLPCdd5Q1PXbWTC91LYPQrCtA==",
  license: "Apache-2.0",
  dependencies: Object.freeze({
    "node-addon-api": "^4.3.0",
    "prebuild-install": "^7.1.3",
  }),
  engines: Object.freeze({ node: ">= 16.20.1" }),
});
const ZSTD_LICENSE_SHA256 =
  "a5fa667ca7b41aa4c715772c98c7c0794364bfc6b2a6dab35cb18a341a4d03e3";
const ZSTD_TRANSITIVE_LICENSE_SHA256 =
  "7055266497633c9025b777c78eb7235af13922117480ed5c674677adc381c9d8";
const ZSTD_POLICY_ENTRY =
  "package/node_modules/@tokenmonster/token-tracker-runtime/dist/zstd-native-policy.json";
const ZSTD_VERIFIER_ENTRY =
  "package/node_modules/@tokenmonster/token-tracker-runtime/dist/zstd-native-verifier.js";
const CHECKSUM_PATTERN =
  /^([0-9a-f]{64})  (tokenmonster-[0-9A-Za-z.-]+\.tgz)\n$/u;
const VERIFIED_READ_FLAGS =
  fsConstants.O_RDONLY |
  (process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0));

function fail(message) {
  throw new Error(`Release digest verification failed: ${message}`);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactJson(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => exactJson(entry, right[index]))
    );
  }
  if (isPlainRecord(left) || isPlainRecord(right)) {
    if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      exactJson(leftKeys, rightKeys) &&
      leftKeys.every((key) => exactJson(left[key], right[key]))
    );
  }
  return left === right;
}

function samePlatformPath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function samePhysicalFile(left, right) {
  return (
    left.isFile() &&
    !left.isSymbolicLink() &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function samePhysicalDirectory(left, right) {
  return (
    left.isDirectory() &&
    !left.isSymbolicLink() &&
    right.isDirectory() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function requirePhysicalDirectory(path, label) {
  const before = await lstat(path, { bigint: true }).catch(() => null);
  const physicalPath = await realpath(path).catch(() => null);
  if (
    before === null ||
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    physicalPath === null
  ) {
    fail(`${label} must be a physical non-symlink directory`);
  }
  const after = await lstat(physicalPath, { bigint: true }).catch(() => null);
  if (after === null || !samePhysicalDirectory(before, after)) {
    fail(`${label} changed while resolving its physical directory`);
  }
  return Object.freeze({ metadata: after, path: physicalPath });
}

async function readBoundedPhysicalFile(path, maximumBytes, label) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    fail(`${label} has an invalid byte limit`);
  }
  const before = await lstat(path, { bigint: true }).catch(() => null);
  const physicalPath = await realpath(path).catch(() => null);
  if (
    before === null ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size < 1n ||
    before.size > BigInt(maximumBytes) ||
    physicalPath === null ||
    !samePlatformPath(path, physicalPath)
  ) {
    fail(`${label} must be a bounded physical file with one link`);
  }

  const handle = await open(path, VERIFIED_READ_FLAGS).catch(() => null);
  if (handle === null) fail(`${label} could not be opened safely`);
  try {
    const beforeHandle = await handle.stat({ bigint: true });
    if (!samePhysicalFile(before, beforeHandle)) {
      fail(`${label} changed before it could be read`);
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
      if (bytesRead < 1) fail(`${label} changed size while it was being read`);
      offset += bytesRead;
    }
    const [afterHandle, afterPath, afterPhysicalPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }).catch(() => null),
      realpath(path).catch(() => null),
    ]);
    if (
      afterPath === null ||
      afterPhysicalPath === null ||
      offset !== expectedBytes ||
      !samePlatformPath(path, afterPhysicalPath) ||
      !samePhysicalFile(beforeHandle, afterHandle) ||
      !samePhysicalFile(beforeHandle, afterPath)
    ) {
      fail(`${label} changed while it was being read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function extractTarballEntry(tarballBytes, entry, maximumBytes, label) {
  const result = spawnSync("tar", ["-xOzf", "-", entry], {
    encoding: null,
    input: tarballBytes,
    maxBuffer: maximumBytes,
    windowsHide: true,
  });
  if (
    result.status !== 0 ||
    !Buffer.isBuffer(result.stdout) ||
    result.stdout.length < 1 ||
    result.stdout.length > maximumBytes
  ) {
    fail(`${label} could not be read`);
  }
  return result.stdout;
}

function extractTarballJson(tarballBytes, entry, maximumBytes, label) {
  const bytes = extractTarballEntry(
    tarballBytes,
    entry,
    maximumBytes,
    label,
  );
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8 JSON`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid UTF-8 JSON`);
  }
}

export function verifyPublicTarballEntries(entries) {
  if (
    !Array.isArray(entries) ||
    entries.some((entry) => typeof entry !== "string")
  ) {
    fail("release tarball inventory could not be read");
  }
  if (entries.length < 2 || entries.length > MAX_TAR_ENTRIES) {
    fail("release tarball inventory has an invalid size");
  }
  const seen = new Set();
  const portableEntries = new Map();
  for (const entry of entries) {
    try {
      requirePublicTarEntry(entry);
    } catch (error) {
      fail(error instanceof Error ? error.message : "unsafe tarball entry");
    }
    if (seen.has(entry)) fail(`release tarball repeats an entry: ${entry}`);
    seen.add(entry);
    const portableKey = portablePublicTarEntryKey(entry);
    const existingPortableEntry = portableEntries.get(portableKey);
    if (
      existingPortableEntry !== undefined &&
      existingPortableEntry !== entry
    ) {
      fail(
        `release tarball has a case-insensitive or portable path collision: ${existingPortableEntry} and ${entry}`,
      );
    }
    portableEntries.set(portableKey, entry);
  }
  for (const [portableKey, entry] of portableEntries) {
    const segments = portableKey.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parentKey = segments.slice(0, index).join("/");
      const parentEntry = portableEntries.get(parentKey);
      if (parentEntry !== undefined && !parentEntry.endsWith("/")) {
        fail(
          `release tarball uses a file as a parent path: ${parentEntry} and ${entry}`,
        );
      }
    }
  }
  if (!seen.has("package/"))
    fail("release tarball has no canonical package root");
  return Object.freeze({ entryCount: entries.length, entries: seen });
}

function tarballListing(tarballBytes, arguments_, label) {
  const result = spawnSync("tar", arguments_, {
    encoding: "utf8",
    input: tarballBytes,
    maxBuffer: MAX_TAR_LISTING_BYTES,
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    fail(`${label} could not be read`);
  }
  const entries = result.stdout.split(/\r?\n/u);
  if (entries.at(-1) === "") entries.pop();
  return entries;
}

function verifyPublicTarballInventory(tarballBytes) {
  const entries = tarballListing(
    tarballBytes,
    ["-tzf", "-"],
    "release tarball inventory",
  );
  const verboseEntries = tarballListing(
    tarballBytes,
    ["-tvzf", "-"],
    "release tarball typed inventory",
  );
  if (verboseEntries.length !== entries.length) {
    fail("release tarball typed inventory differs from its path inventory");
  }
  for (const [index, entry] of entries.entries()) {
    const type = verboseEntries[index]?.[0];
    if (
      (type !== "-" && type !== "d") ||
      (type === "d") !== entry.endsWith("/")
    ) {
      fail(
        `release tarball entries must be regular files or directories: ${entry}`,
      );
    }
  }
  return verifyPublicTarballEntries(entries);
}

function verifyReleaseZstdAuthority(
  tarballBytes,
  inventory,
  expectedPolicy = ZSTD_NATIVE_POLICY,
) {
  if (!inventory.has(ZSTD_POLICY_ENTRY)) {
    fail("release tarball omits the shipped zstd native policy");
  }
  if (!inventory.has(ZSTD_VERIFIER_ENTRY)) {
    fail("release tarball omits the shipped zstd native verifier");
  }
  let stagedPolicy;
  try {
    stagedPolicy = validateZstdNativePolicy(
      extractTarballJson(
        tarballBytes,
        ZSTD_POLICY_ENTRY,
        MAX_ZSTD_POLICY_BYTES,
        "shipped zstd native policy",
      ),
    );
  } catch {
    fail("shipped zstd native policy is invalid");
  }
  const authority = validateZstdNativePolicy(expectedPolicy);
  if (JSON.stringify(stagedPolicy) !== JSON.stringify(authority)) {
    fail("shipped zstd native policy differs from the release authority");
  }
  const verifierBytes = extractTarballEntry(
    tarballBytes,
    ZSTD_VERIFIER_ENTRY,
    MAX_ZSTD_VERIFIER_BYTES,
    "shipped zstd native verifier",
  );
  const verifierSha256 = createHash("sha256")
    .update(verifierBytes)
    .digest("hex");
  if (verifierSha256 !== stagedPolicy.runtimeVerifier.sha256) {
    fail("shipped zstd native verifier differs from its pinned bytes");
  }
  return stagedPolicy;
}

function verifyReleaseManifest(tarballBytes, tarballName, expectedVersion) {
  const manifest = extractTarballJson(
    tarballBytes,
    "package/package.json",
    MAX_PACKAGE_MANIFEST_BYTES,
    "release package manifest",
  );
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.name !== "tokenmonster"
  ) {
    fail("release package manifest has an unexpected package name");
  }
  let version;
  try {
    version = requireCanonicalCliVersion(manifest.version);
  } catch {
    fail("release package manifest has an invalid version");
  }
  if (tarballName !== `tokenmonster-${version}.tgz`) {
    fail("tarball filename does not match the package version");
  }
  if (expectedVersion !== undefined) {
    let expected;
    try {
      expected = requireCanonicalCliVersion(
        expectedVersion,
        "Expected version",
      );
    } catch {
      fail("expected version is invalid");
    }
    if (version !== expected) {
      fail("package version does not match the expected release version");
    }
  }
  return Object.freeze({ manifest, version });
}

function requireExactlyOnce(values, expected, label) {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string") ||
    values.filter((value) => value === expected).length !== 1 ||
    new Set(values).size !== values.length
  ) {
    fail(`${label} must contain ${expected} exactly once`);
  }
}

function verifyReleaseZstdBundle(
  tarballBytes,
  inventory,
  releaseManifest,
  policy,
) {
  if (!inventory.has(PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY)) {
    fail("release package omits the fixed zstd preinstall bootstrap");
  }
  const preinstallBootstrap = extractTarballEntry(
    tarballBytes,
    PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY,
    PUBLIC_ZSTD_PREINSTALL_BYTES,
    "zstd preinstall bootstrap",
  );
  try {
    requirePublicZstdPreinstallBootstrap(
      PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY,
      preinstallBootstrap,
    );
  } catch (error) {
    fail(
      error instanceof Error
        ? error.message
        : "zstd preinstall bootstrap is invalid",
    );
  }
  if (
    !exactJson(releaseManifest.scripts, {
      preinstall: PUBLIC_ZSTD_PREINSTALL_COMMAND,
    })
  ) {
    fail(
      "release package scripts must contain only the fixed zstd preinstall command",
    );
  }

  const expectedFiles = ZSTD_NATIVE_BUNDLE_FILE_PATHS.map(
    (relativePath) => `${ZSTD_PACKAGE_PREFIX}${relativePath}`,
  ).sort();
  const actualFiles = [...inventory]
    .filter(
      (entry) => entry.startsWith(ZSTD_PACKAGE_PREFIX) && !entry.endsWith("/"),
    )
    .sort();
  if (!exactJson(actualFiles, expectedFiles)) {
    fail("bundled @mongodb-js/zstd inventory differs from the fixed policy");
  }
  if (!inventory.has(ZSTD_LICENSE_ENTRY)) {
    fail("bundled @mongodb-js/zstd omits its license");
  }
  if (!inventory.has(ZSTD_TRANSITIVE_LICENSE_ENTRY)) {
    fail("release package omits the pinned Zstandard license");
  }
  const licenseChecks = [
    [
      ZSTD_LICENSE_ENTRY,
      ZSTD_LICENSE_SHA256,
      "bundled @mongodb-js/zstd license",
    ],
    [
      ZSTD_TRANSITIVE_LICENSE_ENTRY,
      ZSTD_TRANSITIVE_LICENSE_SHA256,
      "pinned Zstandard license",
    ],
  ];
  for (const [entry, expectedSha256, label] of licenseChecks) {
    const bytes = extractTarballEntry(
      tarballBytes,
      entry,
      MAX_LICENSE_BYTES,
      label,
    );
    if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
      fail(`${label} differs from its reviewed bytes`);
    }
  }

  const expectedArchiveEntries = ZSTD_NATIVE_PREBUILD_RELATIVE_PATHS.map(
    (relativePath) => `${ZSTD_PACKAGE_PREFIX}${relativePath}`,
  ).sort();
  if (
    !exactJson(expectedArchiveEntries, PUBLIC_ZSTD_PREBUILD_ARCHIVE_ENTRIES)
  ) {
    fail("bundled zstd prebuild paths differ from the public asset policy");
  }
  for (const entry of expectedArchiveEntries) {
    const archiveName = entry.slice(entry.lastIndexOf("/") + 1);
    const platform = Object.values(policy.platforms).find(
      (candidate) => candidate.archiveName === archiveName,
    );
    if (platform === undefined) {
      fail("bundled zstd prebuild has no platform policy");
    }
    const archive = extractTarballEntry(
      tarballBytes,
      entry,
      platform.archiveBytes,
      "bundled zstd prebuild",
    );
    try {
      requirePublicZstdPrebuildArchive(entry, archive, policy);
    } catch (error) {
      fail(
        error instanceof Error
          ? error.message
          : "bundled zstd prebuild is invalid",
      );
    }
  }

  if (
    !isPlainRecord(releaseManifest.dependencies) ||
    releaseManifest.dependencies["@mongodb-js/zstd"] !==
      ZSTD_NPM_IDENTITY.version
  ) {
    fail("release package does not exact-pin bundled @mongodb-js/zstd");
  }
  requireExactlyOnce(
    releaseManifest.bundleDependencies,
    "@mongodb-js/zstd",
    "release package bundleDependencies",
  );

  const bundledManifest = extractTarballJson(
    tarballBytes,
    ZSTD_MANIFEST_ENTRY,
    MAX_ZSTD_MANIFEST_BYTES,
    "bundled @mongodb-js/zstd manifest",
  );
  try {
    requireBundledZstdManifest(bundledManifest);
  } catch {
    fail("bundled @mongodb-js/zstd manifest differs from its pinned identity");
  }

  const shrinkwrap = extractTarballJson(
    tarballBytes,
    RELEASE_SHRINKWRAP_ENTRY,
    MAX_SHRINKWRAP_BYTES,
    "release npm shrinkwrap",
  );
  if (
    !isPlainRecord(shrinkwrap) ||
    shrinkwrap.name !== releaseManifest.name ||
    shrinkwrap.version !== releaseManifest.version ||
    shrinkwrap.lockfileVersion !== 3 ||
    shrinkwrap.requires !== true ||
    !isPlainRecord(shrinkwrap.packages)
  ) {
    fail("release npm shrinkwrap has an invalid root identity");
  }
  const shrinkwrapRoot = shrinkwrap.packages[""];
  if (
    !isPlainRecord(shrinkwrapRoot) ||
    !isPlainRecord(shrinkwrapRoot.dependencies) ||
    shrinkwrapRoot.dependencies["@mongodb-js/zstd"] !==
      ZSTD_NPM_IDENTITY.version
  ) {
    fail("release npm shrinkwrap omits the root zstd dependency pin");
  }
  requireExactlyOnce(
    shrinkwrapRoot.bundleDependencies,
    "@mongodb-js/zstd",
    "release npm shrinkwrap bundleDependencies",
  );
  const zstdPaths = Object.keys(shrinkwrap.packages).filter(
    (entry) =>
      entry === ZSTD_LOCK_PATH ||
      entry.endsWith(`/node_modules/@mongodb-js/zstd`),
  );
  if (!exactJson(zstdPaths, [ZSTD_LOCK_PATH])) {
    fail("release npm shrinkwrap contains an ambiguous zstd package path");
  }
  const zstdLock = shrinkwrap.packages[ZSTD_LOCK_PATH];
  if (
    !isPlainRecord(zstdLock) ||
    zstdLock.version !== ZSTD_NPM_IDENTITY.version ||
    zstdLock.resolved !== ZSTD_NPM_IDENTITY.resolved ||
    zstdLock.integrity !== ZSTD_NPM_IDENTITY.integrity ||
    zstdLock.inBundle !== true ||
    zstdLock.hasInstallScript !== true ||
    zstdLock.license !== ZSTD_NPM_IDENTITY.license ||
    !exactJson(zstdLock.dependencies, ZSTD_NPM_IDENTITY.dependencies) ||
    !exactJson(zstdLock.engines, ZSTD_NPM_IDENTITY.engines)
  ) {
    fail("release npm shrinkwrap zstd entry differs from bundled provenance");
  }
}

export async function verifyReleaseDigest(directory, options = {}) {
  const requestedRoot = resolve(directory);
  const initialRoot = await requirePhysicalDirectory(
    requestedRoot,
    "release root",
  );
  const root = initialRoot.path;
  const rootMetadata = initialRoot.metadata;
  const checksumPath = join(root, "SHASUMS256.txt");
  const checksumBytes = await readBoundedPhysicalFile(
    checksumPath,
    MAX_CHECKSUM_BYTES,
    "SHASUMS256.txt",
  );
  let checksum;
  try {
    checksum = new TextDecoder("utf-8", { fatal: true }).decode(checksumBytes);
  } catch {
    fail("SHASUMS256.txt must contain valid UTF-8");
  }
  const match = CHECKSUM_PATTERN.exec(checksum);
  if (match?.[1] === undefined || match[2] === undefined) {
    fail("SHASUMS256.txt must contain one canonical tarball record");
  }
  const expectedDigest = match[1];
  const tarballName = match[2];
  if (basename(tarballName) !== tarballName) {
    fail("checksum tarball name is unsafe");
  }
  const tarballs = (await readdir(root)).filter((name) =>
    name.endsWith(".tgz"),
  );
  if (tarballs.length !== 1 || tarballs[0] !== tarballName) {
    fail("release root must contain exactly the checksummed tarball");
  }
  const tarballPath = join(root, tarballName);
  const tarballBytes = await readBoundedPhysicalFile(
    tarballPath,
    MAX_TARBALL_BYTES,
    "release tarball",
  );
  const actualDigest = createHash("sha256").update(tarballBytes).digest("hex");
  if (actualDigest !== expectedDigest) fail("tarball SHA-256 differs");
  const inventory = verifyPublicTarballInventory(tarballBytes);
  const policy = verifyReleaseZstdAuthority(
    tarballBytes,
    inventory.entries,
    options.zstdPolicy,
  );
  const release = verifyReleaseManifest(
    tarballBytes,
    tarballName,
    options.expectedVersion,
  );
  verifyReleaseZstdBundle(
    tarballBytes,
    inventory.entries,
    release.manifest,
    policy,
  );
  const [finalChecksumBytes, finalTarballBytes] = await Promise.all([
    readBoundedPhysicalFile(
      checksumPath,
      MAX_CHECKSUM_BYTES,
      "SHASUMS256.txt",
    ),
    readBoundedPhysicalFile(
      tarballPath,
      MAX_TARBALL_BYTES,
      "release tarball",
    ),
  ]);
  if (
    !finalChecksumBytes.equals(checksumBytes) ||
    !finalTarballBytes.equals(tarballBytes)
  ) {
    fail("release inputs changed during verification");
  }
  const finalRoot = await requirePhysicalDirectory(
    requestedRoot,
    "release root",
  );
  if (
    !samePlatformPath(root, finalRoot.path) ||
    !samePhysicalDirectory(rootMetadata, finalRoot.metadata)
  ) {
    fail("release root changed during verification");
  }
  return Object.freeze({
    tarballName,
    bytes: tarballBytes.length,
    sha256: actualDigest,
    entryCount: inventory.entryCount,
    version: release.version,
  });
}

async function main() {
  const arguments_ = process.argv.slice(2);
  let directory = "dist-release";
  let expectedVersion;
  if (arguments_[0] !== undefined && arguments_[0] !== "--expected-version") {
    directory = arguments_.shift();
  }
  if (arguments_[0] === "--expected-version" && arguments_[1] !== undefined) {
    arguments_.shift();
    expectedVersion = arguments_.shift();
  }
  if (arguments_.length !== 0) {
    throw new Error(
      "Usage: node scripts/release/verify-release-digest.mjs [dist-release] [--expected-version <version>]",
    );
  }
  const result = await verifyReleaseDigest(directory, { expectedVersion });
  process.stdout.write(
    `Verified ${result.tarballName}: version ${result.version}, ${result.bytes} bytes, ${result.entryCount} safe entries, SHA-256 ${result.sha256}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Digest verification failed",
    );
    process.exitCode = 1;
  });
}
