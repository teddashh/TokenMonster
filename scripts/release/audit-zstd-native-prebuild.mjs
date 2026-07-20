#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const KEY_MAX_BYTES = 64 * 1024;
const SIGNATURE_MAX_BYTES = 16 * 1024;
const GPG_OUTPUT_MAX_BYTES = 256 * 1024;
const GITHUB_ASSET_REDIRECT_HOST = "release-assets.githubusercontent.com";
const GITHUB_ASSET_REDIRECT_PATH =
  /^\/github-production-release-asset\/[0-9]+\/[A-Za-z0-9-]+$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
    const { done, value } = await reader.read();
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
    throw new Error(`${label} download failed`);
  }
  return requireResponse(response, label);
}

async function downloadOfficialKey(fetchImpl, url) {
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
  const response = await fetchWithoutRedirect(fetchImpl, url, "MongoDB signing key");
  if (response.status !== 200 || response.headers.get("location") !== null) {
    throw new Error("MongoDB signing key URL did not return a direct HTTP 200");
  }
  return readBoundedBody(response, KEY_MAX_BYTES, "MongoDB signing key");
}

async function downloadGithubReleaseAsset(fetchImpl, url, maximumBytes, label) {
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
  const initial = await fetchWithoutRedirect(fetchImpl, url, label);
  if (initial.status !== 302) {
    throw new Error(`${label} did not return the expected GitHub HTTP 302`);
  }
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
  if (response.status !== 200 || response.headers.get("location") !== null) {
    throw new Error(`${label} asset URL did not return a terminal HTTP 200`);
  }
  return readBoundedBody(response, maximumBytes, label);
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

export async function auditZstdNativePrebuild({
  platformKeys,
  policy = undefined,
  fetchImpl = globalThis.fetch,
  gpgCommand = "gpg",
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

  const auditDirectory = await mkdtemp(join(tmpdir(), "tokenmonster-zstd-audit-"));
  try {
    const keyBytes = await downloadOfficialKey(
      fetchImpl,
      validatedPolicy.source.signingKeyUrl,
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
    for (const platformKey of platformKeys) {
      const entry = validatedPolicy.platforms[platformKey];
      const archiveUrl = zstdNativeArchiveUrl(validatedPolicy, entry);
      const archiveBytes = await downloadGithubReleaseAsset(
        fetchImpl,
        archiveUrl,
        entry.archiveBytes,
        `${platformKey} zstd archive`,
      );
      const signatureBytes = await downloadGithubReleaseAsset(
        fetchImpl,
        `${archiveUrl}.sig`,
        SIGNATURE_MAX_BYTES,
        `${platformKey} zstd signature`,
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
    return Object.freeze(evidence);
  } finally {
    await rm(auditDirectory, { recursive: true, force: true });
  }
}

async function runCommandLine() {
  const args = process.argv.slice(2);
  const policy = await loadZstdNativePolicy();
  let platformKeys;
  if (args.length === 1 && args[0] === "--all") {
    platformKeys = Object.keys(policy.platforms);
  } else if (
    args.length === 2 &&
    args[0] === "--platform" &&
    args[1] !== undefined
  ) {
    platformKeys = [args[1]];
  } else {
    console.error(
      "Usage: node scripts/release/audit-zstd-native-prebuild.mjs (--all | --platform <platform-arch>)",
    );
    process.exitCode = 1;
    return;
  }
  const results = await auditZstdNativePrebuild({ platformKeys, policy });
  for (const result of results) {
    console.log(
      `ZSTD NATIVE AUDIT: PASS (${result.platformKey}, archive ${result.archiveBytes} bytes sha256 ${result.archiveSha256}, binding ${result.bindingBytes} bytes sha256 ${result.bindingSha256})`,
    );
  }
  console.log(
    `ZSTD NATIVE SIGNER: PASS (${policy.source.signingKeyFingerprint}, ${policy.source.signingKeyUrl})`,
  );
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
