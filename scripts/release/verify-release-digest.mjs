#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  portablePublicTarEntryKey,
  requirePublicTarEntry,
} from "./public-artifact-policy.mjs";
import { requireCanonicalCliVersion } from "./cli-release-version.mjs";
import {
  validateZstdNativePolicy,
  ZSTD_NATIVE_POLICY,
} from "../../packages/token-tracker-runtime/src/zstd-native-verifier.ts";

const MAX_CHECKSUM_BYTES = 4 * 1024;
const MAX_TARBALL_BYTES = 128 * 1024 * 1024;
const MAX_TAR_LISTING_BYTES = 16 * 1024 * 1024;
const MAX_TAR_ENTRIES = 50_000;
const MAX_PACKAGE_MANIFEST_BYTES = 64 * 1_024;
const MAX_ZSTD_POLICY_BYTES = 16 * 1_024;
const MAX_ZSTD_VERIFIER_BYTES = 256 * 1_024;
const ZSTD_POLICY_ENTRY =
  "package/node_modules/@tokenmonster/token-tracker-runtime/dist/zstd-native-policy.json";
const ZSTD_VERIFIER_ENTRY =
  "package/node_modules/@tokenmonster/token-tracker-runtime/dist/zstd-native-verifier.js";
const CHECKSUM_PATTERN =
  /^([0-9a-f]{64})  (tokenmonster-[0-9A-Za-z.-]+\.tgz)\n$/u;

function fail(message) {
  throw new Error(`Release digest verification failed: ${message}`);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
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

function verifyPublicTarballInventory(path) {
  const result = spawnSync("tar", ["-tzf", path], {
    encoding: "utf8",
    maxBuffer: MAX_TAR_LISTING_BYTES,
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    fail("release tarball inventory could not be read");
  }
  const entries = result.stdout.split(/\r?\n/u);
  if (entries.at(-1) === "") entries.pop();
  return verifyPublicTarballEntries(entries);
}

function verifyReleaseZstdAuthority(path, inventory) {
  if (!inventory.has(ZSTD_POLICY_ENTRY)) {
    fail("release tarball omits the shipped zstd native policy");
  }
  if (!inventory.has(ZSTD_VERIFIER_ENTRY)) {
    fail("release tarball omits the shipped zstd native verifier");
  }
  const result = spawnSync("tar", ["-xOzf", path, ZSTD_POLICY_ENTRY], {
    encoding: "utf8",
    maxBuffer: MAX_ZSTD_POLICY_BYTES,
    windowsHide: true,
  });
  if (
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    result.stdout.length < 2 ||
    Buffer.byteLength(result.stdout) > MAX_ZSTD_POLICY_BYTES
  ) {
    fail("shipped zstd native policy could not be read");
  }
  let stagedPolicy;
  try {
    stagedPolicy = validateZstdNativePolicy(JSON.parse(result.stdout));
  } catch {
    fail("shipped zstd native policy is invalid");
  }
  if (JSON.stringify(stagedPolicy) !== JSON.stringify(ZSTD_NATIVE_POLICY)) {
    fail("shipped zstd native policy differs from the release authority");
  }
  const verifierResult = spawnSync(
    "tar",
    ["-xOzf", path, ZSTD_VERIFIER_ENTRY],
    {
      encoding: null,
      maxBuffer: MAX_ZSTD_VERIFIER_BYTES,
      windowsHide: true,
    },
  );
  if (
    verifierResult.status !== 0 ||
    !Buffer.isBuffer(verifierResult.stdout) ||
    verifierResult.stdout.length < 1 ||
    verifierResult.stdout.length > MAX_ZSTD_VERIFIER_BYTES
  ) {
    fail("shipped zstd native verifier could not be read");
  }
  const verifierSha256 = createHash("sha256")
    .update(verifierResult.stdout)
    .digest("hex");
  if (verifierSha256 !== stagedPolicy.runtimeVerifier.sha256) {
    fail("shipped zstd native verifier differs from its pinned bytes");
  }
}

function verifyReleaseManifest(path, tarballName, expectedVersion) {
  const result = spawnSync("tar", ["-xOzf", path, "package/package.json"], {
    encoding: "utf8",
    maxBuffer: MAX_PACKAGE_MANIFEST_BYTES,
    windowsHide: true,
  });
  if (
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    result.stdout.length < 2 ||
    Buffer.byteLength(result.stdout) > MAX_PACKAGE_MANIFEST_BYTES
  ) {
    fail("release package manifest could not be read");
  }
  let manifest;
  try {
    manifest = JSON.parse(result.stdout);
  } catch {
    fail("release package manifest is not valid JSON");
  }
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
  return version;
}

export async function verifyReleaseDigest(directory, options = {}) {
  const root = resolve(directory);
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    fail("release root must be a regular non-symlink directory");
  }
  const checksumPath = join(root, "SHASUMS256.txt");
  const checksumMetadata = await lstat(checksumPath);
  if (
    checksumMetadata.isSymbolicLink() ||
    !checksumMetadata.isFile() ||
    checksumMetadata.size < 1 ||
    checksumMetadata.size > MAX_CHECKSUM_BYTES
  ) {
    fail("SHASUMS256.txt must be a bounded regular file");
  }
  const checksum = await readFile(checksumPath, "utf8");
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
  const tarballMetadata = await lstat(tarballPath);
  if (
    tarballMetadata.isSymbolicLink() ||
    !tarballMetadata.isFile() ||
    tarballMetadata.size < 1 ||
    tarballMetadata.size > MAX_TARBALL_BYTES
  ) {
    fail("release tarball must be a bounded regular file");
  }
  const actualDigest = await sha256File(tarballPath);
  if (actualDigest !== expectedDigest) fail("tarball SHA-256 differs");
  const inventory = verifyPublicTarballInventory(tarballPath);
  verifyReleaseZstdAuthority(tarballPath, inventory.entries);
  const version = verifyReleaseManifest(
    tarballPath,
    tarballName,
    options.expectedVersion,
  );
  return Object.freeze({
    tarballName,
    bytes: tarballMetadata.size,
    sha256: actualDigest,
    entryCount: inventory.entryCount,
    version,
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
