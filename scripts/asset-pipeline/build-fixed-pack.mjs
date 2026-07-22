#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32 } from "node:zlib";

import { buildCharactersPackage } from "./build-characters-package.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const PACK_NAMESPACE = "/tokenmonster/characters/v1";
const DESCRIPTOR_FILENAME = "asset-pack-descriptor-v1.json";
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_CENTRAL_HEADER_BYTES = 46;
const ZIP_EOCD_BYTES = 22;
const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORED_METHOD = 0;
const ZIP_VERSION_20 = 20;
const ZIP_UNIX_VERSION_20 = 0x0314;
const ZIP_UNIX_REGULAR_0600 = (0o100600 << 16) >>> 0;
const ZIP_DOS_EPOCH_TIME = 0;
const ZIP_DOS_EPOCH_DATE = 33;

function usage() {
  return [
    "Usage:",
    "  node scripts/asset-pipeline/build-fixed-pack.mjs \\",
    "    --release-manifest <asset-release-manifest-v2.json> \\",
    "    --asset-root <directory-containing-objects> \\",
    "    --out <new-output-directory>",
    "",
    "The output directory must not exist. Failed validation removes it.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    releaseManifest: null,
    assetRoot: null,
    out: null,
  };
  const flags = new Map([
    ["--release-manifest", "releaseManifest"],
    ["--asset-root", "assetRoot"],
    ["--out", "out"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    const key = flags.get(argument);
    if (key === undefined) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    if (options[key] !== null) {
      throw new Error(`${argument} may be specified only once`);
    }
    options[key] = resolve(value);
    index += 1;
  }

  for (const [flag, key] of flags) {
    if (options[key] === null) throw new Error(`${flag} is required`);
  }
  return options;
}

function isMissing(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function readJsonFile(path, label) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular, non-symlink file`);
  }
  if (stats.size > MAX_JSON_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_JSON_BYTES}-byte input cap`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function assertDirectory(path, label) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a regular, non-symlink directory`);
  }
}

async function assertFreshOutput(path) {
  await assertDirectory(dirname(path), "--out parent");
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error("--out already exists; choose a fresh directory");
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function expectedOutputs(manifest) {
  const byPath = new Map();
  for (const asset of manifest.assets) {
    const output = asset.output;
    const expected = {
      path: output.path,
      bytes: output.bytes,
      sha256: output.sha256,
      mediaType: output.media.mediaType,
    };
    const existing = byPath.get(output.path);
    if (existing === undefined) {
      byPath.set(output.path, expected);
      continue;
    }
    if (
      existing.bytes !== expected.bytes ||
      existing.sha256 !== expected.sha256 ||
      existing.mediaType !== expected.mediaType
    ) {
      throw new Error("release manifest contains conflicting object snapshots");
    }
  }
  return [...byPath.values()].sort((left, right) =>
    compareCodePoints(left.path, right.path),
  );
}

function assertMediaSignature(mediaType, bytes) {
  const isPng =
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp =
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
  const isWav =
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WAVE";
  const matches =
    (mediaType === "image/png" && isPng) ||
    (mediaType === "image/webp" && isWebp) ||
    (mediaType === "audio/wav" && isWav);
  if (!matches)
    throw new Error("object media signature does not match manifest");
}

async function readVerifiedObject(assetRoot, expected) {
  const path = join(assetRoot, expected.path);
  const stats = await lstat(path);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.size !== expected.bytes
  ) {
    throw new Error("object must be a regular file with the declared size");
  }
  const bytes = await readFile(path);
  if (
    bytes.length !== expected.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== expected.sha256
  ) {
    throw new Error("object bytes do not match the release manifest");
  }
  assertMediaSignature(expected.mediaType, bytes);
  return bytes;
}

function projectedArchiveBytes(outputs) {
  return (
    outputs.reduce((total, output) => {
      const nameBytes = Buffer.byteLength(output.path, "utf8");
      return (
        total +
        ZIP_LOCAL_HEADER_BYTES +
        nameBytes +
        output.bytes +
        ZIP_CENTRAL_HEADER_BYTES +
        nameBytes
      );
    }, 0) + ZIP_EOCD_BYTES
  );
}

async function writeAll(handle, bytes, position) {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(
      bytes,
      written,
      bytes.length - written,
      position + written,
    );
    if (result.bytesWritten === 0) throw new Error("could not write ZIP bytes");
    written += result.bytesWritten;
  }
}

function localHeader(entry) {
  const header = Buffer.alloc(ZIP_LOCAL_HEADER_BYTES);
  header.writeUInt32LE(ZIP_LOCAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(ZIP_VERSION_20, 4);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 6);
  header.writeUInt16LE(ZIP_STORED_METHOD, 8);
  header.writeUInt16LE(ZIP_DOS_EPOCH_TIME, 10);
  header.writeUInt16LE(ZIP_DOS_EPOCH_DATE, 12);
  header.writeUInt32LE(entry.crc32, 14);
  header.writeUInt32LE(entry.bytes, 18);
  header.writeUInt32LE(entry.bytes, 22);
  header.writeUInt16LE(entry.name.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(entry) {
  const header = Buffer.alloc(ZIP_CENTRAL_HEADER_BYTES);
  header.writeUInt32LE(ZIP_CENTRAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(ZIP_UNIX_VERSION_20, 4);
  header.writeUInt16LE(ZIP_VERSION_20, 6);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
  header.writeUInt16LE(ZIP_STORED_METHOD, 10);
  header.writeUInt16LE(ZIP_DOS_EPOCH_TIME, 12);
  header.writeUInt16LE(ZIP_DOS_EPOCH_DATE, 14);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(entry.bytes, 20);
  header.writeUInt32LE(entry.bytes, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(ZIP_UNIX_REGULAR_0600, 38);
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

function endOfCentralDirectory(entryCount, centralBytes, centralOffset) {
  const record = Buffer.alloc(ZIP_EOCD_BYTES);
  record.writeUInt32LE(ZIP_EOCD_SIGNATURE, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralBytes, 12);
  record.writeUInt32LE(centralOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

async function buildArchive(assetRoot, outputs, temporaryPath) {
  const hash = createHash("sha256");
  const entries = [];
  let position = 0;
  let handle = null;
  const append = async (bytes) => {
    await writeAll(handle, bytes, position);
    hash.update(bytes);
    position += bytes.length;
  };

  try {
    handle = await open(temporaryPath, "wx", 0o600);
    for (const output of outputs) {
      const bytes = await readVerifiedObject(assetRoot, output);
      const entry = {
        name: Buffer.from(output.path, "utf8"),
        bytes: bytes.length,
        crc32: crc32(bytes) >>> 0,
        offset: position,
      };
      await append(localHeader(entry));
      await append(entry.name);
      await append(bytes);
      entries.push(entry);
    }

    const centralOffset = position;
    for (const entry of entries) {
      await append(centralHeader(entry));
      await append(entry.name);
    }
    const centralBytes = position - centralOffset;
    await append(
      endOfCentralDirectory(entries.length, centralBytes, centralOffset),
    );
    await handle.sync();
    await handle.close();
    handle = null;
    return {
      bytes: position,
      sha256: hash.digest("hex"),
    };
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

async function publishFile(temporaryPath, finalPath) {
  try {
    await link(temporaryPath, finalPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (
    options.releaseManifest === options.out ||
    options.assetRoot === options.out
  ) {
    throw new Error("--out must be distinct from every input");
  }
  await assertFreshOutput(options.out);
  await assertDirectory(options.assetRoot, "--asset-root");
  await assertDirectory(
    join(options.assetRoot, "objects"),
    "objects directory",
  );
  const releaseManifestInput = await readJsonFile(
    options.releaseManifest,
    "--release-manifest",
  );

  buildCharactersPackage();
  const releaseModuleUrl = pathToFileURL(
    join(REPOSITORY_ROOT, "packages", "characters", "dist", "asset-release.js"),
  );
  const packModuleUrl = pathToFileURL(
    join(REPOSITORY_ROOT, "packages", "characters", "dist", "asset-pack.js"),
  );
  const releaseModule = await import(releaseModuleUrl.href);
  const packModule = await import(packModuleUrl.href);
  const releaseManifest =
    releaseModule.AssetReleaseManifestV2Schema.parse(releaseManifestInput);
  const outputs = expectedOutputs(releaseManifest);
  const extractedBytes = outputs.reduce(
    (total, output) => total + output.bytes,
    0,
  );
  const archiveBytes = projectedArchiveBytes(outputs);
  if (
    outputs.length > packModule.MAX_ASSET_PACK_ENTRIES ||
    extractedBytes > packModule.MAX_ASSET_PACK_EXTRACTED_BYTES ||
    archiveBytes > packModule.MAX_ASSET_PACK_TRANSFER_BYTES
  ) {
    throw new Error("release exceeds the fixed asset-pack limits");
  }

  let outputCreated = false;
  try {
    await mkdir(options.out, { mode: 0o700 });
    outputCreated = true;
    const temporaryArchivePath = join(options.out, ".asset-pack.zip.tmp");
    const archive = await buildArchive(
      options.assetRoot,
      outputs,
      temporaryArchivePath,
    );
    if (archive.bytes !== archiveBytes) {
      throw new Error("fixed ZIP size projection did not match its output");
    }

    const packPath = `${PACK_NAMESPACE}/packs/${releaseManifest.releaseId}/${archive.sha256}.zip`;
    const descriptor = packModule.AssetPackDescriptorV1Schema.parse({
      schemaVersion: packModule.ASSET_PACK_DESCRIPTOR_SCHEMA_VERSION,
      releaseId: releaseManifest.releaseId,
      releaseManifestSha256:
        releaseModule.computeAssetReleaseManifestV2Sha256(releaseManifest),
      pack: {
        path: packPath,
        mediaType: "application/zip",
        bytes: archive.bytes,
        sha256: archive.sha256,
        entryCount: outputs.length,
        extractedBytes,
      },
    });

    const finalArchivePath = join(options.out, `${archive.sha256}.zip`);
    await publishFile(temporaryArchivePath, finalArchivePath);
    const temporaryDescriptorPath = join(options.out, ".descriptor.json.tmp");
    await writeFile(
      temporaryDescriptorPath,
      `${JSON.stringify(descriptor, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await publishFile(
      temporaryDescriptorPath,
      join(options.out, DESCRIPTOR_FILENAME),
    );

    console.log(`Fixed asset pack: ${finalArchivePath}`);
    console.log(
      `Fixed asset-pack descriptor: ${join(options.out, DESCRIPTOR_FILENAME)}`,
    );
  } catch (error) {
    if (outputCreated) {
      await rm(options.out, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

main().catch((error) => {
  if (
    error !== null &&
    typeof error === "object" &&
    "issues" in error &&
    Array.isArray(error.issues)
  ) {
    const messages = error.issues.map((issue) => {
      const path = Array.isArray(issue?.path) ? issue.path.join(".") : "input";
      const message =
        typeof issue?.message === "string" ? issue.message : "invalid value";
      return `${path || "input"}: ${message}`;
    });
    console.error(
      `Fixed asset-pack validation failed:\n- ${messages.join("\n- ")}`,
    );
  } else {
    console.error(
      error instanceof Error ? error.message : "Fixed asset-pack build failed",
    );
  }
  process.exitCode = 1;
});
