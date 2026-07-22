#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

import { buildCharactersPackage } from "./build-characters-package.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 4 * 1024 * 1024 * 1024;
const SAFE_REFERENCE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const PINNED_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const TOOL_NAME = "tokenmonster-source-evidence-preparer";

function usage() {
  return [
    "Usage:",
    "  node scripts/asset-pipeline/prepare-source-evidence.mjs \\",
    "    --integrity <manifest-v1.json> \\",
    "    --asset-bank <exact-read-only-source-directory> \\",
    "    --inventory-id <opaque-safe-id> \\",
    "    --repository-id <opaque-safe-id> \\",
    "    --source-revision <exact-40-or-64-hex-revision> \\",
    "    --receipt-root <new-private-receipt-directory> \\",
    "    --out <source-evidence-v1.json>",
    "",
    "The integrity manifest's sibling report.json must describe one complete",
    "image-only WebP build. The source bank must contain exactly its selected",
    "avatar, outfit, and pose inputs and is never modified.",
    "This command records provenance facts only; it grants no rights.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    integrity: null,
    assetBank: null,
    inventoryId: null,
    repositoryId: null,
    sourceRevision: null,
    receiptRoot: null,
    out: null,
  };
  const flags = new Map([
    ["--integrity", "integrity"],
    ["--asset-bank", "assetBank"],
    ["--inventory-id", "inventoryId"],
    ["--repository-id", "repositoryId"],
    ["--source-revision", "sourceRevision"],
    ["--receipt-root", "receiptRoot"],
    ["--out", "out"],
  ]);
  const literalKeys = new Set([
    "inventoryId",
    "repositoryId",
    "sourceRevision",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    const key = flags.get(argument);
    if (key === undefined) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    if (options[key] !== null) {
      throw new Error(`${argument} may be specified only once`);
    }
    options[key] = literalKeys.has(key) ? value : resolve(value);
    index += 1;
  }
  for (const [flag, key] of flags) {
    if (options[key] === null) throw new Error(`${flag} is required`);
  }
  return options;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPlainRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(value, keys) {
  return (
    isPlainRecord(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sameStrings(left, right) {
  return (
    Array.isArray(left) &&
    left.every((value) => typeof value === "string") &&
    JSON.stringify(left) === JSON.stringify(right)
  );
}

function sameRecordKeys(value, expectedKeys) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expectedKeys].sort());
}

async function readJson(path, label) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular, non-symlink file`);
  }
  if (stats.size > MAX_JSON_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_JSON_BYTES}-byte cap`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function portableRelativePath(root, candidate) {
  const path = relative(root, candidate);
  if (
    path === "" ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path)
  ) {
    throw new Error("A source escaped the exact asset bank");
  }
  return path.split(sep).join("/");
}

async function assertAbsent(path, label) {
  try {
    await lstat(path);
    throw new Error(`${label} already exists; choose a fresh path`);
  } catch (error) {
    if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
  }
}

async function freshTarget(path, label) {
  const parentStats = await lstat(dirname(path));
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new Error(`${label} parent must be a regular, non-symlink directory`);
  }
  const parent = await realpath(dirname(path));
  const target = join(parent, basename(path));
  await assertAbsent(target, label);
  return target;
}

function imageMetadata(bytes, label) {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
  ) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width > 0 && height > 0)
      return { mediaType: "image/png", width, height };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const frames = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
      0xcf,
    ]);
    let offset = 2;
    while (offset + 8 < bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset];
      offset += 1;
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) break;
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if (frames.has(marker)) {
        const height = bytes.readUInt16BE(offset + 3);
        const width = bytes.readUInt16BE(offset + 5);
        if (width > 0 && height > 0) {
          return { mediaType: "image/jpeg", width, height };
        }
        break;
      }
      offset += segmentLength;
    }
  }
  throw new Error(`${label} is not a supported PNG or JPEG image source`);
}

function manifestImageObjects(integrity) {
  const objects = [];
  for (const character of integrity.characters) {
    objects.push(character.avatar);
    for (const theme of character.themes) {
      objects.push(theme.outfit);
      for (const state of ["supported", "challenged", "victory"]) {
        const pose = theme.poses[state];
        if (pose !== undefined) objects.push(pose);
      }
    }
  }
  return objects;
}

function deriveSelectedSourcePaths(integrity, report) {
  if (integrity.characters.length === 0) {
    throw new Error("Source evidence requires at least one image character");
  }
  if (integrity.voice.length !== 0) {
    throw new Error("Source evidence preparation rejects voice assets");
  }
  const topLevelKeys = [
    "schemaVersion",
    "builtAt",
    "encoder",
    "encoderVersion",
    "warnings",
    "selection",
    "counts",
    "totalBytes",
    "voice",
    "perPersonaBytes",
    "perPersona",
    "missingAssets",
  ];
  if (!hasExactKeys(report, topLevelKeys) || report.schemaVersion !== "1") {
    throw new Error("sibling report.json has an invalid exact shape");
  }
  if (
    report.encoder !== "webp" ||
    typeof report.encoderVersion !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(report.encoderVersion) ||
    !Array.isArray(report.warnings) ||
    !report.warnings.every((warning) => typeof warning === "string")
  ) {
    throw new Error("Source evidence requires a complete WebP build report");
  }
  if (
    !hasExactKeys(report.selection, ["personas", "themes", "sample"]) ||
    typeof report.selection.sample !== "boolean" ||
    !Array.isArray(report.selection.themes) ||
    report.selection.themes.length === 0 ||
    !report.selection.themes.every((theme) => typeof theme === "string")
  ) {
    throw new Error("sibling report.json has an invalid image selection");
  }
  const characterIds = integrity.characters.map(
    ({ characterId }) => characterId,
  );
  if (!sameStrings(report.selection.personas, characterIds)) {
    throw new Error(
      "report.json persona selection does not match manifest.json",
    );
  }
  for (const character of integrity.characters) {
    const manifestThemeIds = character.themes.map(({ themeId }) => themeId);
    if (!sameStrings(manifestThemeIds, report.selection.themes)) {
      throw new Error(
        `report.json theme selection does not match ${character.characterId}`,
      );
    }
  }

  const imageObjects = manifestImageObjects(integrity);
  const outfitCount = integrity.characters.reduce(
    (total, character) => total + character.themes.length,
    0,
  );
  const poseCount =
    imageObjects.length - integrity.characters.length - outfitCount;
  const expectedCounts = {
    personasRequested: integrity.characters.length,
    personasEmitted: integrity.characters.length,
    themesRequestedPerPersona: report.selection.themes.length,
    avatars: integrity.characters.length,
    outfits: outfitCount,
    poses: poseCount,
    assetReferences: imageObjects.length,
    missing: 0,
  };
  const countKeys = [
    "personasRequested",
    "personasEmitted",
    "themesRequestedPerPersona",
    "avatars",
    "outfits",
    "poses",
    "assetReferences",
    "uniqueObjects",
    "encoded",
    "reused",
    "missing",
  ];
  if (
    !hasExactKeys(report.counts, countKeys) ||
    !countKeys.every((key) => isNonnegativeInteger(report.counts[key])) ||
    Object.entries(expectedCounts).some(
      ([key, value]) => report.counts[key] !== value,
    ) ||
    report.counts.encoded + report.counts.reused !== imageObjects.length ||
    !Array.isArray(report.missingAssets) ||
    report.missingAssets.length !== 0
  ) {
    throw new Error("report.json image counts are incomplete or inconsistent");
  }
  if (
    !hasExactKeys(report.voice, ["characters", "lines", "bytes"]) ||
    report.voice.characters !== 0 ||
    report.voice.lines !== 0 ||
    report.voice.bytes !== 0
  ) {
    throw new Error("Source evidence preparation rejects voice assets");
  }

  const uniqueObjects = new Map();
  for (const object of imageObjects) {
    if (!object.path.endsWith(".webp")) {
      throw new Error("Source evidence requires WebP integrity objects");
    }
    const existing = uniqueObjects.get(object.path);
    if (
      existing !== undefined &&
      JSON.stringify(existing) !== JSON.stringify(object)
    ) {
      throw new Error(`manifest.json has conflicting object ${object.path}`);
    }
    uniqueObjects.set(object.path, object);
  }
  const uniqueBytes = [...uniqueObjects.values()].reduce(
    (total, object) => total + object.bytes,
    0,
  );
  if (
    report.counts.uniqueObjects !== uniqueObjects.size ||
    report.totalBytes !== uniqueBytes
  ) {
    throw new Error(
      "report.json unique object totals do not match manifest.json",
    );
  }
  if (
    !sameRecordKeys(report.perPersona, characterIds) ||
    !sameRecordKeys(report.perPersonaBytes, characterIds)
  ) {
    throw new Error("report.json persona summaries do not match manifest.json");
  }

  const selected = new Set();
  for (const character of integrity.characters) {
    const summary = report.perPersona[character.characterId];
    const expectedBytes = [
      character.avatar,
      ...character.themes.flatMap((theme) => [
        theme.outfit,
        ...[
          theme.poses.supported,
          theme.poses.challenged,
          theme.poses.victory,
        ].filter((object) => object !== undefined),
      ]),
    ].reduce((total, object) => total + object.bytes, 0);
    if (
      !hasExactKeys(summary, ["bytes", "avatarSource"]) ||
      summary.bytes !== expectedBytes ||
      report.perPersonaBytes[character.characterId] !== expectedBytes ||
      (summary.avatarSource !== "root" &&
        summary.avatarSource !== "outfit-fallback")
    ) {
      throw new Error(
        `report.json persona summary does not match ${character.characterId}`,
      );
    }
    const firstTheme = character.themes[0];
    if (firstTheme === undefined) {
      throw new Error(
        `character ${character.characterId} has no wardrobe themes`,
      );
    }
    selected.add(
      summary.avatarSource === "root"
        ? `${character.characterId}.png`
        : `outfits_v2_norm/doll_${character.characterId}__${firstTheme.themeId}.png`,
    );
    for (const theme of character.themes) {
      selected.add(
        `outfits_v2_norm/doll_${character.characterId}__${theme.themeId}.png`,
      );
      for (const state of ["supported", "challenged", "victory"]) {
        if (theme.poses[state] !== undefined) {
          selected.add(
            `poses/react/doll_${character.characterId}__${theme.themeId}__${state}.png`,
          );
        }
      }
    }
  }
  return [...selected].sort();
}

async function scanAssetBank(root, directory = root, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Asset bank symlinks are not allowed: ${portableRelativePath(root, path)}`,
      );
    }
    const resolved = await realpath(path);
    if (!isInside(root, resolved)) {
      throw new Error("An asset bank entry escaped the exact source directory");
    }
    if (stats.isDirectory()) {
      await scanAssetBank(root, resolved, files);
    } else if (stats.isFile()) {
      files.push(portableRelativePath(root, resolved));
    } else {
      throw new Error(
        `Asset bank entries must be regular files or directories: ${portableRelativePath(root, path)}`,
      );
    }
  }
  return files;
}

async function readSelectedSources(assetBank, selectedPaths) {
  const actualPaths = (await scanAssetBank(assetBank)).sort();
  const expected = new Set(selectedPaths);
  const actual = new Set(actualPaths);
  const missing = selectedPaths.filter((path) => !actual.has(path));
  const extra = actualPaths.filter((path) => !expected.has(path));
  if (missing.length > 0) {
    throw new Error(
      `Exact asset bank is missing selected sources: ${missing.join(", ")}`,
    );
  }
  if (extra.length > 0) {
    throw new Error(
      `Exact asset bank contains unselected sources: ${extra.join(", ")}`,
    );
  }

  let totalBytes = 0;
  const sources = [];
  for (const path of selectedPaths) {
    const candidate = join(assetBank, ...path.split("/"));
    const stats = await lstat(candidate);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(
        `Selected source must be a regular, non-symlink file: ${path}`,
      );
    }
    const resolved = await realpath(candidate);
    if (!isInside(assetBank, resolved)) {
      throw new Error(`Selected source escaped the exact asset bank: ${path}`);
    }
    if (stats.size < 1 || stats.size > MAX_SOURCE_BYTES) {
      throw new Error(`Selected source has an invalid bounded size: ${path}`);
    }
    totalBytes += stats.size;
    if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
      throw new Error(
        "Selected source inventory exceeds the aggregate byte cap",
      );
    }
    const bytes = await readFile(resolved);
    if (bytes.length !== stats.size) {
      throw new Error(`Selected source changed while it was read: ${path}`);
    }
    imageMetadata(bytes, path);
    sources.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return sources;
}

function assertPublicEvidenceIsPathSafe(evidence) {
  const visit = (value) => {
    if (typeof value === "string") {
      if (
        /(?:https?|file):\/\//iu.test(value) ||
        /^[\\/]/u.test(value) ||
        /^[A-Za-z]:[\\/]/u.test(value) ||
        value.includes("\\")
      ) {
        throw new Error(
          "Public source evidence contains an unsafe path or URL",
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (isPlainRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (/prompt|instruction|url/iu.test(key)) {
          throw new Error("Public source evidence contains a forbidden field");
        }
        visit(child);
      }
    }
  };
  visit(evidence);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (
    !SAFE_REFERENCE_PATTERN.test(options.inventoryId) ||
    options.inventoryId.length > 120
  ) {
    throw new Error("--inventory-id must be an opaque safe reference ID");
  }
  if (
    !SAFE_REFERENCE_PATTERN.test(options.repositoryId) ||
    options.repositoryId.length > 120
  ) {
    throw new Error("--repository-id must be an opaque safe reference ID");
  }
  if (!PINNED_REVISION_PATTERN.test(options.sourceRevision)) {
    throw new Error(
      "--source-revision must be exactly 40 or 64 lowercase hex characters",
    );
  }
  if (options.out === options.receiptRoot) {
    throw new Error("--out and --receipt-root must be different fresh paths");
  }

  const bankStats = await lstat(options.assetBank);
  if (bankStats.isSymbolicLink() || !bankStats.isDirectory()) {
    throw new Error("--asset-bank must be a regular, non-symlink directory");
  }
  const assetBank = await realpath(options.assetBank);
  const receiptRoot = await freshTarget(options.receiptRoot, "--receipt-root");
  const out = await freshTarget(options.out, "--out");
  if (isInside(assetBank, receiptRoot) || isInside(assetBank, out)) {
    throw new Error(
      "Evidence outputs must be outside the read-only asset bank",
    );
  }

  const integrityStats = await lstat(options.integrity);
  if (integrityStats.isSymbolicLink() || !integrityStats.isFile()) {
    throw new Error("--integrity must be a regular, non-symlink file");
  }
  const integrityPath = await realpath(options.integrity);
  const reportPath = join(dirname(integrityPath), "report.json");
  const [integrityInput, report] = await Promise.all([
    readJson(integrityPath, "--integrity"),
    readJson(reportPath, "sibling report.json"),
  ]);

  buildCharactersPackage();
  const moduleUrl = pathToFileURL(
    join(REPOSITORY_ROOT, "packages", "characters", "dist", "asset-release.js"),
  );
  const { AssetIntegrityManifestV1Schema, AssetSourceEvidenceBundleV1Schema } =
    await import(moduleUrl.href);
  const integrity = AssetIntegrityManifestV1Schema.parse(integrityInput);
  if (report.builtAt !== integrity.generatedAt) {
    throw new Error("report.json build timestamp does not match manifest.json");
  }
  const selectedPaths = deriveSelectedSourcePaths(integrity, report);
  const sources = await readSelectedSources(assetBank, selectedPaths);
  const preparerSha256 = sha256(await readFile(new URL(import.meta.url)));

  const receipts = sources.map((source, index) => {
    const path = `receipts/import-${String(index).padStart(4, "0")}.json`;
    const value = {
      schemaVersion: "1",
      receiptType: "source-import",
      operation: "import",
      inventoryId: options.inventoryId,
      repository: {
        repositoryId: options.repositoryId,
        revision: options.sourceRevision,
      },
      source,
      preparer: { name: TOOL_NAME, sha256: preparerSha256 },
    };
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    return { path, bytes, sha256: sha256(bytes) };
  });
  const evidence = AssetSourceEvidenceBundleV1Schema.parse({
    schemaVersion: "1",
    inventoryId: options.inventoryId,
    entries: sources.map((source, index) => ({
      path: source.path,
      sha256: source.sha256,
      upstream: {
        repository: {
          repositoryId: options.repositoryId,
          revision: options.sourceRevision,
        },
        steps: [
          {
            operation: "import",
            receipt: {
              path: receipts[index].path,
              sha256: receipts[index].sha256,
            },
            tool: { name: TOOL_NAME, version: preparerSha256 },
            model: null,
            inputs: [],
            outputSha256: source.sha256,
          },
        ],
      },
    })),
  });
  assertPublicEvidenceIsPathSafe(evidence);

  let createdReceiptRoot = false;
  let createdOut = false;
  try {
    await mkdir(receiptRoot, { mode: 0o700 });
    createdReceiptRoot = true;
    await chmod(receiptRoot, 0o700);
    const receiptDirectory = join(receiptRoot, "receipts");
    await mkdir(receiptDirectory, { mode: 0o700 });
    await chmod(receiptDirectory, 0o700);
    for (const receipt of receipts) {
      const path = join(receiptRoot, ...receipt.path.split("/"));
      await writeFile(path, receipt.bytes, { flag: "wx", mode: 0o600 });
      await chmod(path, 0o600);
    }
    await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    createdOut = true;
    await chmod(out, 0o600);
  } catch (error) {
    if (createdOut) await rm(out, { force: true }).catch(() => undefined);
    if (createdReceiptRoot) {
      await rm(receiptRoot, { force: true, recursive: true }).catch(
        () => undefined,
      );
    }
    throw error;
  }
  console.log(
    `Source evidence v1: ${out} (${evidence.entries.length} exact image sources)`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
