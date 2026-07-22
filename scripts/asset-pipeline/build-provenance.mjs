#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { buildCharactersPackage } from "./build-characters-package.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const PIPELINE_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "asset-pipeline",
  "build-manifest.mjs",
);
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_RECEIPT_BYTES = 64 * 1024 * 1024;
const WEBP_QUALITY = 82;

function usage() {
  return [
    "Usage:",
    "  node scripts/asset-pipeline/build-provenance.mjs \\",
    "    --integrity <manifest-v1.json> \\",
    "    --asset-bank <exact-build-source-directory> \\",
    "    --inventory-id <opaque-safe-id> \\",
    "    --source-evidence <source-evidence-v1.json> \\",
    "    --receipt-root <private-receipt-directory> \\",
    "    --out <build-provenance-v1.json>",
    "",
    "The integrity manifest's sibling report.json and objects/ are verified.",
    "Only metadata-stripped WebP image builds are accepted; voice is rejected.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    integrity: null,
    assetBank: null,
    inventoryId: null,
    sourceEvidence: null,
    receiptRoot: null,
    out: null,
  };
  const flags = new Map([
    ["--integrity", "integrity"],
    ["--asset-bank", "assetBank"],
    ["--inventory-id", "inventoryId"],
    ["--source-evidence", "sourceEvidence"],
    ["--receipt-root", "receiptRoot"],
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
    options[key] = key === "inventoryId" ? value : resolve(value);
    index += 1;
  }
  for (const [flag, key] of flags) {
    if (options[key] === null) {
      throw new Error(`${flag} is required`);
    }
  }
  return options;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

function probeEncoderVersion() {
  const encoders = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const encoderOutput = `${encoders.stdout ?? ""}\n${encoders.stderr ?? ""}`;
  if (encoders.status !== 0 || !/\blibwebp\b/u.test(encoderOutput)) {
    throw new Error("Build provenance requires ffmpeg with libwebp");
  }
  const version = spawnSync("ffmpeg", ["-hide_banner", "-version"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const versionLine = (version.stdout ?? "").split("\n", 1)[0] ?? "";
  const versionMatch = /^ffmpeg version ([A-Za-z0-9][A-Za-z0-9._+-]*)/u.exec(
    versionLine,
  );
  if (version.status !== 0 || versionMatch === null) {
    throw new Error("Could not determine the exact ffmpeg tool version");
  }
  return versionMatch[1];
}

async function rebuildWebp(buildDirectory, sourceBytes, dimensions) {
  const stage = await mkdtemp(join(buildDirectory, ".provenance-rebuild-"));
  try {
    const sourcePath = join(stage, "source.image");
    const outputPath = join(stage, "output.webp");
    await writeFile(sourcePath, sourceBytes, { flag: "wx", mode: 0o600 });
    const rebuilt = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        sourcePath,
        "-vf",
        `scale=${dimensions.width}:${dimensions.height}:flags=lanczos`,
        "-frames:v",
        "1",
        "-c:v",
        "libwebp",
        "-quality",
        String(WEBP_QUALITY),
        "-compression_level",
        "6",
        "-preset",
        "picture",
        "-map_metadata",
        "-1",
        outputPath,
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    if (rebuilt.status !== 0) {
      throw new Error("Controlled WebP rebuild failed");
    }
    return await readFile(outputPath);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function stableReportSnapshot(report) {
  const counts = report?.counts;
  return {
    schemaVersion: report?.schemaVersion,
    encoder: report?.encoder,
    encoderVersion: report?.encoderVersion,
    warnings: report?.warnings,
    selection: report?.selection,
    counts:
      counts === null || typeof counts !== "object"
        ? counts
        : {
            personasRequested: counts.personasRequested,
            personasEmitted: counts.personasEmitted,
            themesRequestedPerPersona: counts.themesRequestedPerPersona,
            avatars: counts.avatars,
            outfits: counts.outfits,
            poses: counts.poses,
            assetReferences: counts.assetReferences,
            uniqueObjects: counts.uniqueObjects,
            processed:
              typeof counts.encoded === "number" &&
              typeof counts.reused === "number"
                ? counts.encoded + counts.reused
                : null,
            missing: counts.missing,
          },
    totalBytes: report?.totalBytes,
    voice: report?.voice,
    perPersonaBytes: report?.perPersonaBytes,
    perPersona: report?.perPersona,
    missingAssets: report?.missingAssets,
  };
}

async function runControlledPipelineRebuild(
  assetBank,
  buildDirectory,
  integrity,
  report,
) {
  if (
    !Array.isArray(report.selection?.personas) ||
    report.selection.personas.length === 0 ||
    !report.selection.personas.every(
      (value) => typeof value === "string" && value.length > 0,
    ) ||
    !Array.isArray(report.selection?.themes) ||
    report.selection.themes.length === 0 ||
    !report.selection.themes.every(
      (value) => typeof value === "string" && value.length > 0,
    ) ||
    typeof report.selection.sample !== "boolean"
  ) {
    throw new Error("report.json has an invalid asset selection");
  }
  const generatedAtMs = Date.parse(integrity.generatedAt);
  if (!Number.isFinite(generatedAtMs) || generatedAtMs % 1_000 !== 0) {
    throw new Error("integrity manifest has a non-reproducible timestamp");
  }

  const rebuildDirectory = await mkdtemp(
    join(buildDirectory, ".provenance-full-rebuild-"),
  );
  try {
    const arguments_ = [
      PIPELINE_PATH,
      "--out",
      rebuildDirectory,
      "--personas",
      report.selection.personas.join(","),
      "--themes",
      report.selection.themes.join(","),
      ...(report.selection.sample ? ["--sample"] : []),
    ];
    const rebuilt = spawnSync(process.execPath, arguments_, {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        ASSET_BANK_DIR: assetBank,
        SOURCE_DATE_EPOCH: String(generatedAtMs / 1_000),
      },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (rebuilt.status !== 0) {
      throw new Error("Controlled asset pipeline rebuild failed");
    }
    const [rebuiltIntegrityInput, rebuiltReport] = await Promise.all([
      readJson(
        join(rebuildDirectory, "manifest.json"),
        "controlled rebuild manifest.json",
      ),
      readJson(
        join(rebuildDirectory, "report.json"),
        "controlled rebuild report.json",
      ),
    ]);
    if (JSON.stringify(rebuiltIntegrityInput) !== JSON.stringify(integrity)) {
      throw new Error(
        "Controlled asset pipeline rebuild does not match the integrity manifest",
      );
    }
    if (
      JSON.stringify(stableReportSnapshot(rebuiltReport)) !==
      JSON.stringify(stableReportSnapshot(report))
    ) {
      throw new Error(
        "Controlled asset pipeline rebuild does not match report.json",
      );
    }
    return rebuiltReport;
  } finally {
    await rm(rebuildDirectory, { recursive: true, force: true });
  }
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function portableRelativePath(root, path) {
  const value = relative(root, path);
  if (
    value === "" ||
    value === ".." ||
    value.startsWith(`..${sep}`) ||
    isAbsolute(value)
  ) {
    throw new Error("A provenance source escaped the exact asset inventory");
  }
  return value.split(sep).join("/");
}

async function regularFileInside(root, candidate, label) {
  const stats = await lstat(candidate);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular, non-symlink file`);
  }
  const resolved = await realpath(candidate);
  if (!isInside(root, resolved)) {
    throw new Error(`${label} escaped its expected directory`);
  }
  return { path: resolved, stats };
}

async function verifyReceiptSnapshots(receiptRoot, sourceEvidence) {
  const verified = new Map();
  let totalReceiptBytes = 0;
  for (const entry of sourceEvidence.entries) {
    for (const step of entry.upstream.steps) {
      const existingDigest = verified.get(step.receipt.path);
      if (existingDigest !== undefined) {
        if (existingDigest !== step.receipt.sha256) {
          throw new Error(`receipt digest conflict for ${step.receipt.path}`);
        }
        continue;
      }
      const receipt = await regularFileInside(
        receiptRoot,
        join(receiptRoot, step.receipt.path),
        `receipt ${step.receipt.path}`,
      );
      if (receipt.stats.size > MAX_RECEIPT_BYTES) {
        throw new Error(
          `receipt ${step.receipt.path} exceeds the ${MAX_RECEIPT_BYTES}-byte cap`,
        );
      }
      totalReceiptBytes += receipt.stats.size;
      if (totalReceiptBytes > MAX_TOTAL_RECEIPT_BYTES) {
        throw new Error(
          `source evidence receipts exceed the ${MAX_TOTAL_RECEIPT_BYTES}-byte aggregate cap`,
        );
      }
      const digest = sha256(await readFile(receipt.path));
      if (digest !== step.receipt.sha256) {
        throw new Error(`receipt digest does not match ${step.receipt.path}`);
      }
      verified.set(step.receipt.path, digest);
    }
  }
}

function imageMetadata(bytes, label) {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
  ) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width > 0 && height > 0) {
      return { mediaType: "image/png", width, height };
    }
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
  throw new Error(`${label} is not a supported PNG or JPEG source`);
}

function expectedDimensions(source, kind) {
  const measured =
    kind === "avatar" ? Math.max(source.width, source.height) : source.height;
  const maximum = kind === "avatar" ? 256 : 840;
  const scale = Math.min(1, maximum / measured);
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

function outputSnapshot(object) {
  return {
    path: object.path,
    bytes: object.bytes,
    sha256: object.sha256,
    media: {
      mediaType: "image/webp",
      width: object.width,
      height: object.height,
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (
    options.out === options.integrity ||
    options.out === options.sourceEvidence
  ) {
    throw new Error("--out must not overwrite an input file");
  }
  try {
    await lstat(options.out);
    throw new Error("--out already exists; choose a fresh path");
  } catch (error) {
    if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
  }

  const assetBankStats = await lstat(options.assetBank);
  if (assetBankStats.isSymbolicLink() || !assetBankStats.isDirectory()) {
    throw new Error("--asset-bank must be a regular, non-symlink directory");
  }
  const assetBank = await realpath(options.assetBank);
  const receiptRootStats = await lstat(options.receiptRoot);
  if (receiptRootStats.isSymbolicLink() || !receiptRootStats.isDirectory()) {
    throw new Error("--receipt-root must be a regular, non-symlink directory");
  }
  const receiptRoot = await realpath(options.receiptRoot);
  const buildDirectory = await realpath(dirname(options.integrity));
  const [integrityInput, report, sourceEvidenceInput] = await Promise.all([
    readJson(options.integrity, "--integrity"),
    readJson(join(buildDirectory, "report.json"), "sibling report.json"),
    readJson(options.sourceEvidence, "--source-evidence"),
  ]);
  if (
    report?.schemaVersion !== "1" ||
    report.encoder !== "webp" ||
    typeof report.encoderVersion !== "string" ||
    report.encoderVersion.length === 0 ||
    report.counts?.missing !== 0
  ) {
    throw new Error(
      "Build provenance requires a complete metadata-stripped WebP report",
    );
  }
  const encoderVersion = probeEncoderVersion();
  if (encoderVersion !== report.encoderVersion) {
    throw new Error("report.json was produced by a different ffmpeg version");
  }

  buildCharactersPackage();
  const moduleUrl = pathToFileURL(
    join(REPOSITORY_ROOT, "packages", "characters", "dist", "asset-release.js"),
  );
  const {
    AssetBuildProvenanceV1Schema,
    AssetIntegrityManifestV1Schema,
    AssetSourceEvidenceBundleV1Schema,
    assetIdForAssociation,
    computeAssetIntegrityManifestV1Sha256,
  } = await import(moduleUrl.href);
  const integrity = AssetIntegrityManifestV1Schema.parse(integrityInput);
  if (report.builtAt !== integrity.generatedAt) {
    throw new Error("report.json build timestamp does not match manifest.json");
  }
  const sourceEvidence =
    AssetSourceEvidenceBundleV1Schema.parse(sourceEvidenceInput);
  if (sourceEvidence.inventoryId !== options.inventoryId) {
    throw new Error("--inventory-id does not match --source-evidence");
  }
  await verifyReceiptSnapshots(receiptRoot, sourceEvidence);
  const evidenceBySourcePath = new Map(
    sourceEvidence.entries.map((entry) => [entry.path, entry]),
  );
  if (integrity.voice.length !== 0) {
    throw new Error(
      "Voice provenance requires a separate metadata-stripping build step",
    );
  }
  if (
    !Array.isArray(report.selection?.personas) ||
    JSON.stringify(report.selection.personas) !==
      JSON.stringify(integrity.characters.map(({ characterId }) => characterId))
  ) {
    throw new Error(
      "report.json persona selection does not match manifest.json",
    );
  }
  const rebuiltReport = await runControlledPipelineRebuild(
    assetBank,
    buildDirectory,
    integrity,
    report,
  );

  const drafts = [];
  const inventoryFiles = new Map();
  async function addEntry(association, kind, sourceRelative, object) {
    const sourceFile = await regularFileInside(
      assetBank,
      join(assetBank, sourceRelative),
      `source ${sourceRelative}`,
    );
    const sourceBytes = await readFile(sourceFile.path);
    const sourceMedia = imageMetadata(sourceBytes, sourceRelative);
    const dimensions = expectedDimensions(sourceMedia, kind);
    if (
      object.width !== dimensions.width ||
      object.height !== dimensions.height ||
      !object.path.endsWith(".webp")
    ) {
      throw new Error(
        `integrity output dimensions do not match ${sourceRelative}`,
      );
    }
    const objectFile = await regularFileInside(
      buildDirectory,
      join(buildDirectory, object.path),
      `output ${object.path}`,
    );
    const objectBytes = await readFile(objectFile.path);
    if (
      objectBytes.length !== object.bytes ||
      sha256(objectBytes) !== object.sha256
    ) {
      throw new Error(`integrity object bytes do not match ${object.path}`);
    }
    const rebuiltBytes = await rebuildWebp(
      buildDirectory,
      sourceBytes,
      dimensions,
    );
    if (!rebuiltBytes.equals(objectBytes)) {
      throw new Error(
        `controlled source rebuild does not match ${object.path}`,
      );
    }
    const sourcePath = portableRelativePath(assetBank, sourceFile.path);
    const sourceSha256 = sha256(sourceBytes);
    const evidence = evidenceBySourcePath.get(sourcePath);
    if (evidence === undefined) {
      throw new Error(`source evidence missing for ${sourcePath}`);
    }
    if (evidence.sha256 !== sourceSha256) {
      throw new Error(`source evidence hash does not match ${sourcePath}`);
    }
    const priorHash = inventoryFiles.get(sourcePath);
    if (priorHash !== undefined && priorHash !== sourceSha256) {
      throw new Error(
        `source inventory path changed during build: ${sourcePath}`,
      );
    }
    inventoryFiles.set(sourcePath, sourceSha256);
    drafts.push({
      assetId: assetIdForAssociation(association),
      association,
      sourcePath,
      sourceSha256,
      output: outputSnapshot(object),
      upstream: evidence.upstream,
      generationHistory: {
        tool: { name: "ffmpeg", version: report.encoderVersion },
        sourceMediaType: sourceMedia.mediaType,
        resize: { ...dimensions, algorithm: "lanczos" },
        encoding: { mediaType: "image/webp", quality: WEBP_QUALITY },
        metadataStripped: true,
      },
    });
  }

  for (const character of integrity.characters) {
    const firstTheme = character.themes[0];
    if (firstTheme === undefined) {
      throw new Error(
        `character ${character.characterId} has no wardrobe themes`,
      );
    }
    const avatarSource =
      rebuiltReport.perPersona?.[character.characterId]?.avatarSource;
    if (avatarSource !== "root" && avatarSource !== "outfit-fallback") {
      throw new Error(
        `controlled rebuild omitted ${character.characterId} avatar source`,
      );
    }
    const avatarRelative =
      avatarSource === "root"
        ? `${character.characterId}.png`
        : `outfits_v2_norm/doll_${character.characterId}__${firstTheme.themeId}.png`;
    await addEntry(
      { kind: "avatar", characterId: character.characterId },
      "avatar",
      avatarRelative,
      character.avatar,
    );
    for (const theme of character.themes) {
      await addEntry(
        {
          kind: "outfit",
          characterId: character.characterId,
          themeId: theme.themeId,
        },
        "outfit",
        `outfits_v2_norm/doll_${character.characterId}__${theme.themeId}.png`,
        theme.outfit,
      );
      for (const state of ["supported", "challenged", "victory"]) {
        const pose = theme.poses[state];
        if (pose === undefined) continue;
        await addEntry(
          {
            kind: "pose",
            characterId: character.characterId,
            themeId: theme.themeId,
            state,
          },
          "pose",
          `poses/react/doll_${character.characterId}__${theme.themeId}__${state}.png`,
          pose,
        );
      }
    }
  }

  const inventoryEntries = [...inventoryFiles]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, sourceSha256]) => ({ path, sha256: sourceSha256 }));
  const unusedEvidencePaths = [...evidenceBySourcePath.keys()]
    .filter((path) => !inventoryFiles.has(path))
    .sort();
  if (unusedEvidencePaths.length > 0) {
    throw new Error(
      `source evidence contains unselected paths: ${unusedEvidencePaths.join(", ")}`,
    );
  }
  const inventoryRevision = sha256(
    Buffer.from(
      JSON.stringify({ schemaVersion: "1", entries: inventoryEntries }),
    ),
  );
  const provenance = AssetBuildProvenanceV1Schema.parse({
    schemaVersion: "1",
    createdAt: report.builtAt,
    integrityManifestSha256: computeAssetIntegrityManifestV1Sha256(integrity),
    pipeline: {
      repositoryId: "tokenmonster",
      revision: sha256(await readFile(PIPELINE_PATH)),
      scriptPath: "scripts/asset-pipeline/build-manifest.mjs",
    },
    entries: drafts
      .sort((left, right) =>
        left.assetId < right.assetId
          ? -1
          : left.assetId > right.assetId
            ? 1
            : 0,
      )
      .map(({ sourcePath, sourceSha256, ...entry }) => ({
        ...entry,
        source: {
          inventoryId: options.inventoryId,
          inventoryRevision,
          path: sourcePath,
          sha256: sourceSha256,
        },
      })),
  });
  const outputParent = await lstat(dirname(options.out));
  if (outputParent.isSymbolicLink() || !outputParent.isDirectory()) {
    throw new Error("--out parent must be a regular, non-symlink directory");
  }
  await writeFile(options.out, `${JSON.stringify(provenance, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    `Build provenance v1: ${options.out} (${provenance.entries.length} entries)`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
