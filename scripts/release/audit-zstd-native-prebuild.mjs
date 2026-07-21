#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  loadZstdNativePolicy,
  validateZstdNativePolicy,
  zstdNativeArchiveUrl,
} from "./zstd-native-verifier.mjs";

const DOWNLOAD_TIMEOUT_MS = 30_000;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAYS_MS = Object.freeze([100, 250]);
const KEY_MAX_BYTES = 64 * 1024;
const SIGNATURE_MAX_BYTES = 16 * 1024;
const GPG_OUTPUT_MAX_BYTES = 256 * 1024;
const VERIFIED_READ_FLAGS =
  fsConstants.O_RDONLY |
  (process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
const GITHUB_ASSET_REDIRECT_HOST = "release-assets.githubusercontent.com";
const GITHUB_ASSET_REDIRECT_PATH =
  /^\/github-production-release-asset\/[0-9]+\/[A-Za-z0-9-]+$/u;

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

function wait(milliseconds) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

class RetryableDownloadError extends Error {}

export function isRetryableZstdDownloadStatus(status) {
  return (
    Number.isInteger(status) &&
    (status === 408 || status === 429 || (status >= 500 && status <= 599))
  );
}

async function retryBoundedDownload(operation, label, waitImpl) {
  let lastError;
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof RetryableDownloadError)) throw error;
      lastError = error;
      if (attempt + 1 < DOWNLOAD_ATTEMPTS) {
        await waitImpl(DOWNLOAD_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : "download failed";
  throw new Error(`${label} failed after ${DOWNLOAD_ATTEMPTS} attempts: ${detail}`);
}

function requireResponse(response, label) {
  if (
    response === null ||
    typeof response !== "object" ||
    typeof response.status !== "number" ||
    response.headers === undefined
  ) {
    throw new Error(`${label} returned an invalid HTTP response`);
  }
  return response;
}

async function readBoundedBody(response, maximumBytes, label) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error(`${label} has an invalid byte limit`);
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) ||
      Number(declaredLength) > maximumBytes)
  ) {
    throw new Error(`${label} exceeds its byte limit`);
  }
  if (response.body === null) {
    throw new Error(`${label} response has no body`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    let result;
    try {
      result = await reader.read();
    } catch {
      throw new RetryableDownloadError(`${label} response body failed`);
    }
    const { done, value } = result;
    if (done) break;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${label} returned a non-byte body`);
    }
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${label} exceeds its byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

async function fetchWithoutRedirect(fetchImpl, url, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new RetryableDownloadError(`${label} download failed`);
  }
  return requireResponse(response, label);
}

async function requireExpectedStatus(response, expectedStatus, label) {
  if (response.status === expectedStatus) return;
  if (isRetryableZstdDownloadStatus(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    throw new RetryableDownloadError(`${label} returned a retryable HTTP status`);
  }
  throw new Error(`${label} returned an ineligible HTTP status`);
}

async function downloadOfficialKey(fetchImpl, url, waitImpl) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "pgp.mongodb.com" ||
    parsed.pathname !== "/node-driver.asc" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("MongoDB signing key URL is outside the pinned official origin");
  }
  return retryBoundedDownload(async () => {
    const response = await fetchWithoutRedirect(
      fetchImpl,
      url,
      "MongoDB signing key",
    );
    await requireExpectedStatus(response, 200, "MongoDB signing key");
    if (response.headers.get("location") !== null) {
      throw new Error("MongoDB signing key URL did not return a direct HTTP 200");
    }
    return readBoundedBody(response, KEY_MAX_BYTES, "MongoDB signing key");
  }, "MongoDB signing key", waitImpl);
}

async function downloadGithubReleaseAsset(
  fetchImpl,
  url,
  maximumBytes,
  label,
  waitImpl,
) {
  const source = new URL(url);
  if (
    source.protocol !== "https:" ||
    source.hostname !== "github.com" ||
    source.pathname.split("/").slice(0, 5).join("/") !==
      "/mongodb-js/zstd/releases/download" ||
    source.search !== "" ||
    source.hash !== ""
  ) {
    throw new Error(`${label} URL is outside the pinned GitHub release origin`);
  }
  return retryBoundedDownload(async () => {
    const initial = await fetchWithoutRedirect(fetchImpl, url, label);
    await requireExpectedStatus(initial, 302, label);
    const location = initial.headers.get("location");
    if (location === null) {
      throw new Error(`${label} GitHub response omitted its asset redirect`);
    }
    const redirect = new URL(location);
    if (
      redirect.protocol !== "https:" ||
      redirect.hostname !== GITHUB_ASSET_REDIRECT_HOST ||
      !GITHUB_ASSET_REDIRECT_PATH.test(redirect.pathname) ||
      redirect.hash !== ""
    ) {
      throw new Error(`${label} GitHub redirect left the release-asset origin`);
    }
    const response = await fetchWithoutRedirect(fetchImpl, redirect.href, label);
    await requireExpectedStatus(response, 200, label);
    if (response.headers.get("location") !== null) {
      throw new Error(`${label} asset URL did not return a terminal HTTP 200`);
    }
    return readBoundedBody(response, maximumBytes, label);
  }, label, waitImpl);
}

function parseTarString(header, offset, length, label) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const content = nul < 0 ? field : field.subarray(0, nul);
  if (
    [...content].some((byte) => byte < 0x20 || byte > 0x7e) ||
    (nul >= 0 && [...field.subarray(nul)].some((byte) => byte !== 0))
  ) {
    throw new Error(`${label} contains a non-canonical tar string`);
  }
  return content.toString("ascii");
}

function parseTarOctal(field, label) {
  const text = field.toString("ascii").replace(/[\0 ]+$/u, "");
  if (!/^[0-7]+$/u.test(text)) {
    throw new Error(`${label} is not a canonical tar octal value`);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} exceeds the safe integer range`);
  }
  return value;
}

function tarHeaderChecksum(header) {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum;
}

function isZeroBlock(block) {
  return block.every((byte) => byte === 0);
}

export function inspectZstdPrebuildArchive(archiveBytes, platformEntry) {
  if (!(archiveBytes instanceof Uint8Array)) {
    throw new Error("zstd prebuild archive must be bytes");
  }
  if (
    !platformEntry ||
    typeof platformEntry.bindingPath !== "string" ||
    !Number.isSafeInteger(platformEntry.bindingBytes) ||
    typeof platformEntry.bindingSha256 !== "string"
  ) {
    throw new Error("zstd prebuild archive inspection requires a platform policy");
  }
  let tarBytes;
  try {
    tarBytes = gunzipSync(archiveBytes, {
      maxOutputLength: platformEntry.bindingBytes * 2 + 65_536,
    });
  } catch {
    throw new Error("zstd prebuild is not a bounded valid gzip archive");
  }
  if (tarBytes.length % 512 !== 0) {
    throw new Error("zstd prebuild tar length is not block-aligned");
  }

  let offset = 0;
  let entryCount = 0;
  let bindingBytes;
  let terminated = false;
  while (offset < tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.length !== 512) {
      throw new Error("zstd prebuild has a truncated tar header");
    }
    if (isZeroBlock(header)) {
      if (
        tarBytes.length - offset < 1024 ||
        !isZeroBlock(tarBytes.subarray(offset))
      ) {
        throw new Error("zstd prebuild has non-canonical tar termination");
      }
      terminated = true;
      break;
    }

    const storedChecksum = parseTarOctal(
      header.subarray(148, 156),
      "zstd prebuild tar checksum",
    );
    if (storedChecksum !== tarHeaderChecksum(header)) {
      throw new Error("zstd prebuild tar header checksum is invalid");
    }
    const name = parseTarString(header, 0, 100, "zstd prebuild tar name");
    const prefix = parseTarString(
      header,
      345,
      155,
      "zstd prebuild tar prefix",
    );
    const path = prefix.length === 0 ? name : `${prefix}/${name}`;
    const type = header[156];
    if (type !== 0 && type !== 0x30) {
      throw new Error("zstd prebuild tar entry is not a regular file");
    }
    if (path !== platformEntry.bindingPath) {
      throw new Error(
        `zstd prebuild tar entry must be exactly ${platformEntry.bindingPath}`,
      );
    }
    const size = parseTarOctal(
      header.subarray(124, 136),
      "zstd prebuild tar entry size",
    );
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const paddedEnd = dataStart + Math.ceil(size / 512) * 512;
    if (dataEnd > tarBytes.length || paddedEnd > tarBytes.length) {
      throw new Error("zstd prebuild tar entry is truncated");
    }
    if (!isZeroBlock(tarBytes.subarray(dataEnd, paddedEnd))) {
      throw new Error("zstd prebuild tar entry has non-zero padding");
    }
    entryCount += 1;
    if (entryCount !== 1) {
      throw new Error("zstd prebuild tar must contain one entry");
    }
    bindingBytes = tarBytes.subarray(dataStart, dataEnd);
    offset = paddedEnd;
  }

  if (!terminated) {
    throw new Error("zstd prebuild tar omitted its zero-block termination");
  }
  if (entryCount !== 1 || bindingBytes === undefined) {
    throw new Error("zstd prebuild tar must contain one native binding");
  }
  if (bindingBytes.length !== platformEntry.bindingBytes) {
    throw new Error("zstd prebuild binding byte length differs from policy");
  }
  const bindingSha256 = sha256(bindingBytes);
  if (bindingSha256 !== platformEntry.bindingSha256) {
    throw new Error("zstd prebuild binding SHA-256 differs from policy");
  }
  return Object.freeze({
    bindingPath: platformEntry.bindingPath,
    bindingBytes: bindingBytes.length,
    bindingSha256,
  });
}

function runGpg(gpgCommand, homeDirectory, args, label) {
  const result = spawnSync(
    gpgCommand,
    ["--batch", "--no-options", "--homedir", homeDirectory, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, GNUPGHOME: homeDirectory },
      maxBuffer: GPG_OUTPUT_MAX_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    result.signal !== null
  ) {
    const detail = result.error?.code === "ENOENT" ? "gpg is not installed" : "gpg rejected the input";
    throw new Error(`${label} failed: ${detail}`);
  }
  return result.stdout;
}

function primaryFingerprintsFromColonListing(output) {
  const fingerprints = [];
  let awaitingPrimaryFingerprint = false;
  for (const line of output.split(/\r?\n/u)) {
    const fields = line.split(":");
    if (fields[0] === "pub") {
      awaitingPrimaryFingerprint = true;
    } else if (fields[0] === "fpr" && awaitingPrimaryFingerprint) {
      fingerprints.push(fields[9] ?? "");
      awaitingPrimaryFingerprint = false;
    }
  }
  return fingerprints;
}

export function validateGpgVerificationStatus(output, expectedFingerprint) {
  const statuses = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("[GNUPG:] "))
    .map((line) => line.slice(9).split(" "));
  const valid = statuses.filter(([status]) => status === "VALIDSIG");
  const good = statuses.filter(([status]) => status === "GOODSIG");
  const rejectedStatus = new Set([
    "BADSIG",
    "ERRSIG",
    "EXPSIG",
    "EXPKEYSIG",
    "REVKEYSIG",
    "NO_PUBKEY",
  ]);
  if (
    valid.length !== 1 ||
    good.length !== 1 ||
    statuses.some(([status]) => rejectedStatus.has(status))
  ) {
    throw new Error("detached signature did not produce one valid GPG signature");
  }
  const validFields = valid[0];
  const signingFingerprint = validFields[1] ?? "";
  const primaryFingerprint = validFields.at(-1) ?? "";
  if (
    signingFingerprint !== expectedFingerprint &&
    primaryFingerprint !== expectedFingerprint
  ) {
    throw new Error("detached signature does not belong to the pinned MongoDB key");
  }
  return Object.freeze({ signingFingerprint, primaryFingerprint });
}

function importAndValidateSigningKey({
  gpgCommand,
  homeDirectory,
  keyPath,
  expectedFingerprint,
}) {
  runGpg(
    gpgCommand,
    homeDirectory,
    ["--status-fd", "1", "--import-options", "import-minimal,import-clean", "--import", keyPath],
    "MongoDB signing key import",
  );
  const listing = runGpg(
    gpgCommand,
    homeDirectory,
    ["--with-colons", "--fingerprint", "--list-keys"],
    "MongoDB signing key fingerprint inspection",
  );
  const fingerprints = primaryFingerprintsFromColonListing(listing);
  if (
    fingerprints.length !== 1 ||
    fingerprints[0] !== expectedFingerprint
  ) {
    throw new Error("MongoDB signing key does not have the pinned fingerprint");
  }
}

function verifyDetachedSignature({
  gpgCommand,
  homeDirectory,
  signaturePath,
  archivePath,
  expectedFingerprint,
}) {
  const status = runGpg(
    gpgCommand,
    homeDirectory,
    [
      "--status-fd",
      "1",
      "--no-auto-key-retrieve",
      "--verify",
      signaturePath,
      archivePath,
    ],
    "zstd detached signature verification",
  );
  return validateGpgVerificationStatus(status, expectedFingerprint);
}

function requireExactAllPlatforms(platformKeys, policy) {
  const expected = Object.keys(policy.platforms).sort();
  const actual = [...platformKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "zstd authenticated output requires exactly every policy platform",
    );
  }
}

async function createFreshPhysicalOutputDirectory(requestedDirectory) {
  if (
    typeof requestedDirectory !== "string" ||
    requestedDirectory.length === 0 ||
    requestedDirectory.includes("\0")
  ) {
    throw new Error("zstd authenticated output requires a directory path");
  }
  const directory = resolve(requestedDirectory);
  await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error) => {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error("zstd authenticated output directory must not already exist");
    }
    throw error;
  });
  try {
    const metadata = await lstat(directory);
    const physicalDirectory = await realpath(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !samePlatformPath(directory, physicalDirectory)
    ) {
      throw new Error("zstd authenticated output must be a physical directory");
    }
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function requireExactAuthenticatedOutput(directory, archives) {
  const expectedNames = archives.map(({ archiveName }) => archiveName).sort();
  const entries = await readdir(directory, { withFileTypes: true });
  const actualNames = entries.map(({ name }) => name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      "zstd authenticated output does not contain exactly the three policy archives",
    );
  }
  for (const archive of archives) {
    const path = join(directory, archive.archiveName);
    const metadata = await lstat(path, { bigint: true });
    const physicalPath = await realpath(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== BigInt(archive.archiveBytes) ||
      !samePlatformPath(path, physicalPath)
    ) {
      throw new Error("zstd authenticated output contains a non-physical archive");
    }
    const handle = await open(path, VERIFIED_READ_FLAGS);
    try {
      const beforeHandle = await handle.stat({ bigint: true });
      if (!samePhysicalFile(metadata, beforeHandle)) {
        throw new Error(
          "zstd authenticated output archive changed before verification",
        );
      }
      const bytes = Buffer.allocUnsafe(archive.archiveBytes);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (bytesRead < 1) {
          throw new Error(
            "zstd authenticated output archive changed during verification",
          );
        }
        offset += bytesRead;
      }
      const [afterHandle, afterPath] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(path, { bigint: true }),
      ]);
      if (
        offset !== archive.archiveBytes ||
        sha256(bytes) !== archive.archiveSha256 ||
        !samePhysicalFile(beforeHandle, afterHandle) ||
        !samePhysicalFile(beforeHandle, afterPath)
      ) {
        throw new Error(
          "zstd authenticated output archive bytes differ from policy",
        );
      }
    } finally {
      await handle.close();
    }
  }
}

export async function auditZstdNativePrebuild({
  platformKeys,
  policy = undefined,
  fetchImpl = globalThis.fetch,
  gpgCommand = "gpg",
  outputDirectory = undefined,
  retryWait = wait,
}) {
  const validatedPolicy =
    policy === undefined
      ? await loadZstdNativePolicy()
      : validateZstdNativePolicy(policy);
  if (
    !Array.isArray(platformKeys) ||
    platformKeys.length === 0 ||
    new Set(platformKeys).size !== platformKeys.length ||
    platformKeys.some(
      (platformKey) => validatedPolicy.platforms[platformKey] === undefined,
    )
  ) {
    throw new Error("zstd audit platform selection must be unique and policy-backed");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("zstd audit requires an explicit fetch implementation");
  }
  if (typeof retryWait !== "function") {
    throw new Error("zstd audit requires an explicit retry wait implementation");
  }

  let physicalOutputDirectory;
  let retainOutput = false;
  const auditDirectory = await mkdtemp(join(tmpdir(), "tokenmonster-zstd-audit-"));
  try {
    if (outputDirectory !== undefined) {
      requireExactAllPlatforms(platformKeys, validatedPolicy);
      physicalOutputDirectory = await createFreshPhysicalOutputDirectory(
        outputDirectory,
      );
    }
    const keyBytes = await downloadOfficialKey(
      fetchImpl,
      validatedPolicy.source.signingKeyUrl,
      retryWait,
    );
    const keyPath = join(auditDirectory, "node-driver.asc");
    const gpgHome = join(auditDirectory, "gnupg");
    await writeFile(keyPath, keyBytes, { mode: 0o600 });
    await mkdir(gpgHome, { mode: 0o700 });
    importAndValidateSigningKey({
      gpgCommand,
      homeDirectory: gpgHome,
      keyPath,
      expectedFingerprint: validatedPolicy.source.signingKeyFingerprint,
    });

    const evidence = [];
    const authenticatedArchives = [];
    for (const platformKey of platformKeys) {
      const entry = validatedPolicy.platforms[platformKey];
      const archiveUrl = zstdNativeArchiveUrl(validatedPolicy, entry);
      const archiveBytes = await downloadGithubReleaseAsset(
        fetchImpl,
        archiveUrl,
        entry.archiveBytes,
        `${platformKey} zstd archive`,
        retryWait,
      );
      const signatureBytes = await downloadGithubReleaseAsset(
        fetchImpl,
        `${archiveUrl}.sig`,
        SIGNATURE_MAX_BYTES,
        `${platformKey} zstd signature`,
        retryWait,
      );
      if (archiveBytes.length !== entry.archiveBytes) {
        throw new Error(`${platformKey} zstd archive byte length differs from policy`);
      }
      const archiveSha256 = sha256(archiveBytes);
      if (archiveSha256 !== entry.archiveSha256) {
        throw new Error(`${platformKey} zstd archive SHA-256 differs from policy`);
      }

      const archivePath = join(auditDirectory, `${platformKey}.tar.gz`);
      const signaturePath = `${archivePath}.sig`;
      await writeFile(archivePath, archiveBytes, { mode: 0o600 });
      await writeFile(signaturePath, signatureBytes, { mode: 0o600 });
      const signature = verifyDetachedSignature({
        gpgCommand,
        homeDirectory: gpgHome,
        signaturePath,
        archivePath,
        expectedFingerprint: validatedPolicy.source.signingKeyFingerprint,
      });
      const binding = inspectZstdPrebuildArchive(archiveBytes, entry);
      authenticatedArchives.push(
        Object.freeze({
          archiveName: entry.archiveName,
          archiveBytes: archiveBytes.length,
          archiveSha256,
          bytes: archiveBytes,
        }),
      );
      evidence.push(
        Object.freeze({
          platformKey,
          archiveName: entry.archiveName,
          archiveBytes: archiveBytes.length,
          archiveSha256,
          ...binding,
          signingFingerprint: signature.signingFingerprint,
          primaryFingerprint: signature.primaryFingerprint,
        }),
      );
    }
    if (physicalOutputDirectory !== undefined) {
      for (const archive of authenticatedArchives) {
        await writeFile(
          join(physicalOutputDirectory, archive.archiveName),
          archive.bytes,
          { flag: "wx", mode: 0o600 },
        );
      }
      await requireExactAuthenticatedOutput(
        physicalOutputDirectory,
        authenticatedArchives,
      );
      retainOutput = true;
    }
    return Object.freeze(evidence);
  } finally {
    let auditDirectoryRemoved = false;
    try {
      await rm(auditDirectory, { recursive: true, force: true });
      auditDirectoryRemoved = true;
    } finally {
      if (
        physicalOutputDirectory !== undefined &&
        (!retainOutput || !auditDirectoryRemoved)
      ) {
        await rm(physicalOutputDirectory, { recursive: true, force: true });
      }
    }
  }
}

async function runCommandLine() {
  const args = process.argv.slice(2);
  const policy = await loadZstdNativePolicy();
  let platformKeys;
  let outputDirectory;
  if (args.length === 1 && args[0] === "--all") {
    platformKeys = Object.keys(policy.platforms);
  } else if (
    args.length === 2 &&
    args[0] === "--platform" &&
    args[1] !== undefined &&
    !args[1].startsWith("--")
  ) {
    platformKeys = [args[1]];
  } else if (
    args.length === 3 &&
    args[0] === "--all" &&
    args[1] === "--output" &&
    args[2] !== undefined &&
    !args[2].startsWith("--")
  ) {
    platformKeys = Object.keys(policy.platforms);
    outputDirectory = args[2];
  } else {
    console.error(
      "Usage: node scripts/release/audit-zstd-native-prebuild.mjs (--all [--output <fresh-directory>] | --platform <platform-arch>)",
    );
    process.exitCode = 1;
    return;
  }
  const results = await auditZstdNativePrebuild({
    platformKeys,
    policy,
    outputDirectory,
  });
  for (const result of results) {
    console.log(
      `ZSTD NATIVE AUDIT: PASS (${result.platformKey}, archive ${result.archiveBytes} bytes sha256 ${result.archiveSha256}, binding ${result.bindingBytes} bytes sha256 ${result.bindingSha256})`,
    );
  }
  console.log(
    `ZSTD NATIVE SIGNER: PASS (${policy.source.signingKeyFingerprint}, ${policy.source.signingKeyUrl})`,
  );
  if (outputDirectory !== undefined) {
    console.log("ZSTD NATIVE OUTPUT: PASS (3 authenticated archives)");
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    await runCommandLine();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    console.error(`ZSTD NATIVE AUDIT: FAIL (${message})`);
    process.exitCode = 1;
  }
}
