#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
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
import { spawnSync } from "node:child_process";

const PERSONAS = [
  "chatgpt",
  "claude",
  "gemini",
  "grok",
  "deepseek",
  "qwen",
  "mistral",
  "venice",
  "sakana",
  "perplexity",
];
const THEMES = [
  "tech",
  "finance",
  "politics",
  "education",
  "health",
  "environment",
  "law",
  "relationship",
  "family",
  "workplace",
  "science",
  "culture",
  "sports",
  "food",
  "travel",
  "psychology",
  "philosophy",
  "international",
  "media",
  "festival",
];
const POSE_STATES = ["supported", "challenged", "victory"];
const VOICE_PERSONAS = [
  "openai",
  "anthropic",
  "google",
  "xai",
  "deepseek",
  "qwen",
  "mistral",
  "venice",
  "sakana",
  "perplexity",
];
const VOICE_CHARACTER_IDS = {
  openai: "chatgpt",
  anthropic: "claude",
  google: "gemini",
  xai: "grok",
  deepseek: "deepseek",
  qwen: "qwen",
  mistral: "mistral",
  venice: "venice",
  sakana: "sakana",
  perplexity: "perplexity",
};
const VOICE_FILENAME_PATTERN = /^([a-z0-9]+)__([a-z0-9]+)\.wav$/u;
const MAX_VOICE_FILE_BYTES = 400_000;
const MAX_VOICE_DURATION_MS = 6_000;
const WEBP_QUALITY = 82;
const CACHE_VERSION = "1";
const SCRIPT_ROOT = resolve(import.meta.dirname, "../..");

function usage() {
  return `Usage: node scripts/asset-pipeline/build-manifest.mjs [options]

Options:
  --out <dir>           Output directory (default: ~/.cache/tokenmonster-asset-build)
  --voice-dir <dir>     Directory containing approved persona__trigger.wav clips
  --personas <a,b>      Comma-separated persona IDs
  --themes <a,b>        Comma-separated theme IDs
  --sample              Select the first three requested themes per persona
  --allow-png-passthrough
                        Allow PNG output when libwebp encoding is unavailable
  --help                Show this help

Environment:
  ASSET_BANK_DIR        Read-only tachie bank root (required)
  SOURCE_DATE_EPOCH     Optional manifest timestamp override, in Unix seconds`;
}

function parseList(value, allowedValues, flag) {
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`${flag} requires at least one value`);
  }
  const unknown = values.filter((item) => !allowedValues.includes(item));
  if (unknown.length > 0) {
    throw new Error(`${flag} contains unknown values: ${unknown.join(", ")}`);
  }
  const selectedValues = new Set(values);
  return allowedValues.filter((item) => selectedValues.has(item));
}

function parseArguments(argv) {
  let outDir = join(homedir(), ".cache", "tokenmonster-asset-build");
  let personas = [...PERSONAS];
  let themes = [...THEMES];
  let voiceDir = null;
  let sample = false;
  let allowPngPassthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--sample") {
      sample = true;
      continue;
    }
    if (argument === "--allow-png-passthrough") {
      allowPngPassthrough = true;
      continue;
    }
    if (
      argument === "--out" ||
      argument === "--voice-dir" ||
      argument === "--personas" ||
      argument === "--themes"
    ) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--out") {
        outDir = resolve(value);
      } else if (argument === "--voice-dir") {
        voiceDir = resolve(value);
      } else if (argument === "--personas") {
        personas = parseList(value, PERSONAS, argument);
      } else {
        themes = parseList(value, THEMES, argument);
      }
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    outDir,
    voiceDir,
    personas,
    themes: sample ? themes.slice(0, 3) : themes,
    sample,
    allowPngPassthrough,
  };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: SCRIPT_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function buildCharactersPackage() {
  // Spawn tsc through the current Node binary instead of the npm shim:
  // .cmd shims cannot be spawned without a shell on Windows.
  const result = run(
    process.execPath,
    [join(SCRIPT_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
    { cwd: join(SCRIPT_ROOT, "packages", "characters") },
  );
  if (result.status !== 0) {
    throw new Error(
      `Could not build @tokenmonster/characters before validation: ${(result.stderr ?? result.stdout ?? "").trim()}`,
    );
  }
}

function probeEncoder(allowPngPassthrough) {
  const encoders = run("ffmpeg", ["-hide_banner", "-encoders"]);
  const output = `${encoders.stdout ?? ""}\n${encoders.stderr ?? ""}`;
  if (encoders.status === 0 && /\blibwebp\b/u.test(output)) {
    const version = run("ffmpeg", ["-hide_banner", "-version"]);
    return {
      encoder: "webp",
      ffmpegVersion: (version.stdout ?? "").split("\n", 1)[0] || "ffmpeg-unknown",
      warning: null,
    };
  }
  if (!allowPngPassthrough) {
    throw new Error(
      "ffmpeg with the libwebp encoder is required; install libwebp-enabled ffmpeg or use --allow-png-passthrough for development only",
    );
  }
  return {
    encoder: "png-passthrough",
    ffmpegVersion: null,
    warning:
      "ffmpeg with the libwebp encoder was not found; using PNG passthrough objects.",
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function imageMetadata(bytes, sourcePath) {
  const signature = "89504e470d0a1a0a";
  if (bytes.length >= 24 && bytes.subarray(0, 8).toString("hex") === signature) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1) {
      throw new Error(`PNG has invalid dimensions: ${sourcePath}`);
    }
    return { format: "png", width, height };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const startOfFrameMarkers = new Set([
      0xc0,
      0xc1,
      0xc2,
      0xc3,
      0xc5,
      0xc6,
      0xc7,
      0xc9,
      0xca,
      0xcb,
      0xcd,
      0xce,
      0xcf,
    ]);
    let offset = 2;
    while (offset + 8 < bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 0xff) {
        offset += 1;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) {
        offset += 1;
      }
      const marker = bytes[offset];
      offset += 1;
      if (marker === undefined || marker === 0xd9 || marker === 0xda) {
        break;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        continue;
      }
      if (offset + 2 > bytes.length) {
        break;
      }
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) {
        break;
      }
      if (startOfFrameMarkers.has(marker)) {
        const height = bytes.readUInt16BE(offset + 3);
        const width = bytes.readUInt16BE(offset + 5);
        if (width > 0 && height > 0) {
          return { format: "jpeg", width, height };
        }
        break;
      }
      offset += segmentLength;
    }
  }

  throw new Error(`Expected PNG or JPEG image bytes: ${sourcePath}`);
}

function voiceMetadata(bytes, sourcePath) {
  if (bytes.length > MAX_VOICE_FILE_BYTES) {
    throw new Error(
      `Voice clip exceeds ${MAX_VOICE_FILE_BYTES} bytes: ${sourcePath}`,
    );
  }
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error(`Voice clip is not a RIFF/WAVE file: ${sourcePath}`);
  }
  if (bytes.readUInt32LE(4) !== bytes.length - 8) {
    throw new Error(`Voice clip has an invalid RIFF size: ${sourcePath}`);
  }

  let format = null;
  let dataBytes = null;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw new Error(`Voice clip has a truncated chunk header: ${sourcePath}`);
    }
    const chunkId = bytes.toString("ascii", offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > bytes.length) {
      throw new Error(`Voice clip has a truncated ${chunkId} chunk: ${sourcePath}`);
    }

    if (chunkId === "fmt ") {
      if (format !== null) {
        throw new Error(`Voice clip has duplicate fmt chunks: ${sourcePath}`);
      }
      if (chunkSize < 16) {
        throw new Error(`Voice clip has an invalid fmt chunk: ${sourcePath}`);
      }
      format = {
        audioFormat: bytes.readUInt16LE(chunkStart),
        channels: bytes.readUInt16LE(chunkStart + 2),
        sampleRate: bytes.readUInt32LE(chunkStart + 4),
        byteRate: bytes.readUInt32LE(chunkStart + 8),
        blockAlign: bytes.readUInt16LE(chunkStart + 12),
        bitsPerSample: bytes.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === "data") {
      if (dataBytes !== null) {
        throw new Error(`Voice clip has duplicate data chunks: ${sourcePath}`);
      }
      dataBytes = chunkSize;
    }

    offset = chunkEnd + (chunkSize % 2);
    if (offset > bytes.length) {
      throw new Error(`Voice clip has a missing chunk padding byte: ${sourcePath}`);
    }
  }

  if (format === null || dataBytes === null) {
    throw new Error(`Voice clip must contain fmt and data chunks: ${sourcePath}`);
  }
  if (format.audioFormat !== 1) {
    throw new Error(`Voice clip must use PCM format 1: ${sourcePath}`);
  }
  if (format.bitsPerSample !== 16) {
    throw new Error(`Voice clip must be 16-bit: ${sourcePath}`);
  }
  if (format.channels !== 1) {
    throw new Error(`Voice clip must be mono: ${sourcePath}`);
  }
  if (format.sampleRate !== 22_050) {
    throw new Error(`Voice clip must use a 22050 Hz sample rate: ${sourcePath}`);
  }
  if (format.blockAlign !== 2 || format.byteRate !== 44_100) {
    throw new Error(`Voice clip has inconsistent PCM rate fields: ${sourcePath}`);
  }
  if (dataBytes % format.blockAlign !== 0) {
    throw new Error(`Voice clip data is not sample-aligned: ${sourcePath}`);
  }

  const durationMs = Math.round((dataBytes / format.byteRate) * 1_000);
  if (durationMs < 1 || durationMs > MAX_VOICE_DURATION_MS) {
    throw new Error(
      `Voice clip duration must be between 1 and ${MAX_VOICE_DURATION_MS} ms: ${sourcePath}`,
    );
  }
  return { durationMs };
}

function targetDimensions(dimensions, kind, encoder) {
  if (encoder === "png-passthrough") {
    return dimensions;
  }
  const maxDimension = kind === "avatar" ? 256 : 840;
  const measuredDimension =
    kind === "avatar"
      ? Math.max(dimensions.width, dimensions.height)
      : dimensions.height;
  const scale = Math.min(1, maxDimension / measuredDimension);
  return {
    width: Math.max(1, Math.round(dimensions.width * scale)),
    height: Math.max(1, Math.round(dimensions.height * scale)),
  };
}

async function objectMatches(path, expectedSha256, expectedBytes) {
  try {
    const objectStats = await lstat(path);
    if (!objectStats.isFile() || objectStats.isSymbolicLink()) {
      return false;
    }
    const bytes = await readFile(path);
    return bytes.length === expectedBytes && sha256(bytes) === expectedSha256;
  } catch {
    return false;
  }
}

let atomicWriteCounter = 0;

async function atomicWriteFile(path, contents) {
  atomicWriteCounter += 1;
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}-${atomicWriteCounter}.tmp`,
  );
  try {
    await writeFile(temporaryPath, contents, { flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readCache(cachePath) {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8"));
    if (
      parsed?.schemaVersion === CACHE_VERSION &&
      typeof parsed.entries === "object" &&
      parsed.entries !== null
    ) {
      return parsed.entries;
    }
  } catch {
    // A missing or invalid local cache is safe to rebuild.
  }
  return {};
}

async function writeCache(cachePath, entries) {
  const sortedEntries = Object.fromEntries(
    Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)),
  );
  await atomicWriteFile(
    cachePath,
    `${JSON.stringify({ schemaVersion: CACHE_VERSION, entries: sortedEntries }, null, 2)}\n`,
  );
}

function isInside(rootPath, candidatePath) {
  const path = relative(rootPath, candidatePath);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

async function resolvePotentialPath(path) {
  let existingAncestor = resolve(path);
  const missingSegments = [];
  while (true) {
    try {
      return join(await realpath(existingAncestor), ...missingSegments);
    } catch (error) {
      if (!(error instanceof Error) || !Object.hasOwn(error, "code")) {
        throw error;
      }
      if (error.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw error;
      }
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

function sourceRelativePath(assetBankDir, sourcePath) {
  const path = relative(assetBankDir, sourcePath);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`Source escaped the asset bank: ${sourcePath}`);
  }
  return path;
}

function generatedAtFromSources(latestSourceMtimeMs) {
  const epoch = process.env["SOURCE_DATE_EPOCH"];
  if (epoch !== undefined) {
    if (!/^\d+$/u.test(epoch)) {
      throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer");
    }
    const date = new Date(Number(epoch) * 1_000);
    if (!Number.isFinite(date.getTime())) {
      throw new Error("SOURCE_DATE_EPOCH is outside the supported date range");
    }
    return date.toISOString();
  }
  return new Date(Math.floor(latestSourceMtimeMs / 1_000) * 1_000).toISOString();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const assetBankValue = process.env["ASSET_BANK_DIR"];
  if (assetBankValue === undefined || assetBankValue.trim() === "") {
    throw new Error("ASSET_BANK_DIR must point to the read-only tachie bank");
  }
  const assetBankDir = await realpath(resolve(assetBankValue));
  const bankStats = await stat(assetBankDir);
  if (!bankStats.isDirectory()) {
    throw new Error(`ASSET_BANK_DIR is not a directory: ${assetBankDir}`);
  }
  const outDir = await resolvePotentialPath(options.outDir);
  if (isInside(assetBankDir, outDir)) {
    throw new Error("--out must not be equal to or inside ASSET_BANK_DIR");
  }
  let voiceDir = null;
  if (options.voiceDir !== null) {
    const voiceDirStats = await lstat(options.voiceDir);
    if (voiceDirStats.isSymbolicLink()) {
      throw new Error(`--voice-dir must not be a symlink: ${options.voiceDir}`);
    }
    if (!voiceDirStats.isDirectory()) {
      throw new Error(`--voice-dir is not a directory: ${options.voiceDir}`);
    }
    voiceDir = await realpath(options.voiceDir);
    if (isInside(voiceDir, outDir)) {
      throw new Error("--out must not be equal to or inside --voice-dir");
    }
  }

  async function assertInsideBank(sourcePath) {
    const sourceStats = await lstat(sourcePath);
    if (sourceStats.isSymbolicLink()) {
      throw new Error(
        `Source symlinks are not allowed: ${sourceRelativePath(assetBankDir, sourcePath)}`,
      );
    }
    if (!sourceStats.isFile()) {
      throw new Error(
        `Source is not a regular file: ${sourceRelativePath(assetBankDir, sourcePath)}`,
      );
    }
    const resolvedSourcePath = await realpath(sourcePath);
    if (!isInside(assetBankDir, resolvedSourcePath)) {
      throw new Error(`Source escaped the asset bank: ${sourcePath}`);
    }
    return { path: resolvedSourcePath, stats: sourceStats };
  }

  async function findSource(sourcePath) {
    try {
      return await assertInsideBank(sourcePath);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  const encoderProbe = probeEncoder(options.allowPngPassthrough);
  const warnings = encoderProbe.warning === null ? [] : [encoderProbe.warning];
  if (encoderProbe.warning !== null) {
    console.warn(`WARNING: ${encoderProbe.warning}`);
  }

  buildCharactersPackage();
  const charactersModuleUrl = pathToFileURL(
    join(
      SCRIPT_ROOT,
      "packages",
      "characters",
      "dist",
      "asset-manifest.js",
    ),
  );
  const { ASSET_VOICE_TRIGGERS, parseAssetManifest } = await import(
    charactersModuleUrl.href
  );

  const voiceClips = [];
  if (voiceDir !== null) {
    const filenames = (await readdir(voiceDir)).sort((left, right) =>
      left.localeCompare(right),
    );
    const seenVoiceLines = new Set();
    for (const filename of filenames) {
      const sourcePath = join(voiceDir, filename);
      const sourceStats = await lstat(sourcePath);
      if (sourceStats.isSymbolicLink()) {
        throw new Error(`Voice clip symlinks are not allowed: ${filename}`);
      }
      if (!sourceStats.isFile()) {
        throw new Error(`Voice clip is not a regular file: ${filename}`);
      }
      const resolvedSourcePath = await realpath(sourcePath);
      if (!isInside(voiceDir, resolvedSourcePath)) {
        throw new Error(`Voice clip escaped --voice-dir: ${filename}`);
      }

      const filenameMatch = VOICE_FILENAME_PATTERN.exec(filename);
      if (filenameMatch === null) {
        throw new Error(
          `Voice clip filename must be <persona>__<trigger>.wav: ${filename}`,
        );
      }
      const [, persona, trigger] = filenameMatch;
      if (!VOICE_PERSONAS.includes(persona)) {
        throw new Error(`Voice clip has an unknown persona: ${filename}`);
      }
      if (!ASSET_VOICE_TRIGGERS.includes(trigger)) {
        throw new Error(`Voice clip has an unknown trigger: ${filename}`);
      }
      const lineKey = `${persona}/${trigger}`;
      if (seenVoiceLines.has(lineKey)) {
        throw new Error(`Duplicate voice clip for ${lineKey}`);
      }
      seenVoiceLines.add(lineKey);

      const bytes = await readFile(resolvedSourcePath);
      const { durationMs } = voiceMetadata(bytes, resolvedSourcePath);
      voiceClips.push({
        characterId: VOICE_CHARACTER_IDS[persona],
        trigger,
        bytes,
        durationMs,
        mtimeMs: sourceStats.mtimeMs,
      });
    }
  }
  voiceClips.sort((left, right) => {
    const characterOrder =
      PERSONAS.indexOf(left.characterId) - PERSONAS.indexOf(right.characterId);
    return characterOrder === 0
      ? ASSET_VOICE_TRIGGERS.indexOf(left.trigger) -
          ASSET_VOICE_TRIGGERS.indexOf(right.trigger)
      : characterOrder;
  });

  const objectsDir = join(outDir, "objects");
  const cachePath = join(outDir, ".asset-pipeline-cache.json");
  await mkdir(objectsDir, { recursive: true });
  const cacheEntries = await readCache(cachePath);
  let temporaryCounter = 0;
  let latestSourceMtimeMs = 0;
  let encodedCount = 0;
  let reusedCount = 0;
  const referencedObjects = new Map();
  const missingAssets = [];
  const perPersona = Object.fromEntries(
    options.personas.map((characterId) => [
      characterId,
      {
        bytes: 0,
        avatars: 0,
        outfits: 0,
        poses: 0,
        missing: 0,
        avatarSource: null,
      },
    ]),
  );

  const voiceLinesByCharacter = new Map();
  for (const clip of voiceClips) {
    latestSourceMtimeMs = Math.max(latestSourceMtimeMs, clip.mtimeMs);
    const objectSha256 = sha256(clip.bytes);
    const object = {
      path: `objects/${objectSha256}.wav`,
      bytes: clip.bytes.length,
      sha256: objectSha256,
    };
    const targetPath = join(objectsDir, `${objectSha256}.wav`);
    if (!(await objectMatches(targetPath, objectSha256, clip.bytes.length))) {
      await atomicWriteFile(targetPath, clip.bytes);
    }
    referencedObjects.set(object.path, object);
    const lines = voiceLinesByCharacter.get(clip.characterId) ?? [];
    lines.push({
      id: `${clip.characterId}-${clip.trigger}`,
      trigger: clip.trigger,
      object,
      durationMs: clip.durationMs,
    });
    voiceLinesByCharacter.set(clip.characterId, lines);
  }
  const voice = PERSONAS.filter((characterId) =>
    voiceLinesByCharacter.has(characterId),
  ).map((characterId) => ({
    characterId,
    lines: voiceLinesByCharacter.get(characterId),
  }));

  async function recordMissing(characterId, kind, sourcePath, details = {}) {
    perPersona[characterId].missing += 1;
    missingAssets.push({
      characterId,
      kind,
      ...details,
      source: sourceRelativePath(assetBankDir, sourcePath),
    });
  }

  async function processImage(characterId, kind, source) {
    const sourceBytes = await readFile(source.path);
    latestSourceMtimeMs = Math.max(latestSourceMtimeMs, source.stats.mtimeMs);
    const image = imageMetadata(sourceBytes, source.path);
    const originalDimensions = { width: image.width, height: image.height };
    const dimensions = targetDimensions(
      originalDimensions,
      kind,
      encoderProbe.encoder,
    );
    const extension = encoderProbe.encoder === "webp" ? "webp" : "png";
    const cacheKey = sha256(
      Buffer.from(
        JSON.stringify({
          sourceSha256: sha256(sourceBytes),
          encoder: encoderProbe.encoder,
          ffmpegVersion: encoderProbe.ffmpegVersion,
          quality: encoderProbe.encoder === "webp" ? WEBP_QUALITY : null,
          sourceFormat: image.format,
          width: dimensions.width,
          height: dimensions.height,
        }),
      ),
    );
    const cached = cacheEntries[cacheKey];
    if (
      cached?.extension === extension &&
      cached.width === dimensions.width &&
      cached.height === dimensions.height
    ) {
      const cachedPath = join(objectsDir, `${cached.sha256}.${extension}`);
      if (await objectMatches(cachedPath, cached.sha256, cached.bytes)) {
        reusedCount += 1;
        const object = {
          path: `objects/${cached.sha256}.${extension}`,
          bytes: cached.bytes,
          sha256: cached.sha256,
          width: dimensions.width,
          height: dimensions.height,
        };
        referencedObjects.set(object.path, object);
        perPersona[characterId].bytes += object.bytes;
        perPersona[characterId][`${kind}s`] += 1;
        return object;
      }
    }

    let encodedBytes;
    if (encoderProbe.encoder === "webp") {
      temporaryCounter += 1;
      const temporaryPath = join(
        objectsDir,
        `.encode-${process.pid}-${temporaryCounter}-${basename(source.path, ".png")}.webp`,
      );
      const ffmpeg = run("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        source.path,
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
        temporaryPath,
      ]);
      if (ffmpeg.status !== 0) {
        await rm(temporaryPath, { force: true });
        throw new Error(
          `ffmpeg failed for ${sourceRelativePath(assetBankDir, source.path)}: ${(ffmpeg.stderr ?? "").trim()}`,
        );
      }
      encodedBytes = await readFile(temporaryPath);
      const encodedSha256 = sha256(encodedBytes);
      const targetPath = join(objectsDir, `${encodedSha256}.${extension}`);
      if (await objectMatches(targetPath, encodedSha256, encodedBytes.length)) {
        await rm(temporaryPath, { force: true });
      } else {
        await rename(temporaryPath, targetPath);
      }
    } else {
      if (image.format === "png") {
        encodedBytes = sourceBytes;
        const encodedSha256 = sha256(encodedBytes);
        const targetPath = join(objectsDir, `${encodedSha256}.${extension}`);
        if (
          !(await objectMatches(
            targetPath,
            encodedSha256,
            encodedBytes.length,
          ))
        ) {
          await atomicWriteFile(targetPath, encodedBytes);
        }
      } else {
        const normalizationWarning =
          "One or more .png-named inputs contained JPEG bytes; ffmpeg normalized them to PNG for fallback output.";
        if (!warnings.includes(normalizationWarning)) {
          warnings.push(normalizationWarning);
          console.warn(`WARNING: ${normalizationWarning}`);
        }
        temporaryCounter += 1;
        const temporaryPath = join(
          objectsDir,
          `.normalize-${process.pid}-${temporaryCounter}-${basename(source.path, ".png")}.png`,
        );
        const ffmpeg = run("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          source.path,
          "-frames:v",
          "1",
          "-c:v",
          "png",
          "-map_metadata",
          "-1",
          temporaryPath,
        ]);
        if (ffmpeg.status !== 0) {
          await rm(temporaryPath, { force: true });
          throw new Error(
            `ffmpeg PNG normalization failed for ${sourceRelativePath(assetBankDir, source.path)}: ${(ffmpeg.stderr ?? "").trim()}`,
          );
        }
        encodedBytes = await readFile(temporaryPath);
        const encodedSha256 = sha256(encodedBytes);
        const targetPath = join(objectsDir, `${encodedSha256}.${extension}`);
        if (
          await objectMatches(targetPath, encodedSha256, encodedBytes.length)
        ) {
          await rm(temporaryPath, { force: true });
        } else {
          await rename(temporaryPath, targetPath);
        }
      }
    }

    encodedCount += 1;
    const encodedSha256 = sha256(encodedBytes);
    const object = {
      path: `objects/${encodedSha256}.${extension}`,
      bytes: encodedBytes.length,
      sha256: encodedSha256,
      width: dimensions.width,
      height: dimensions.height,
    };
    cacheEntries[cacheKey] = {
      sha256: encodedSha256,
      bytes: encodedBytes.length,
      extension,
      width: dimensions.width,
      height: dimensions.height,
    };
    referencedObjects.set(object.path, object);
    perPersona[characterId].bytes += object.bytes;
    perPersona[characterId][`${kind}s`] += 1;
    return object;
  }

  const characters = [];
  for (const characterId of options.personas) {
    const avatarPath = join(assetBankDir, `${characterId}.png`);
    let avatarSource = await findSource(avatarPath);
    if (avatarSource === null) {
      const fallbackPath = join(
        assetBankDir,
        "outfits_v2_norm",
        `doll_${characterId}__${options.themes[0]}.png`,
      );
      avatarSource = await findSource(fallbackPath);
      if (avatarSource === null) {
        await recordMissing(characterId, "avatar", avatarPath, {
          fallbackSource: sourceRelativePath(assetBankDir, fallbackPath),
        });
        continue;
      }
      perPersona[characterId].avatarSource = "outfit-fallback";
    } else {
      perPersona[characterId].avatarSource = "root";
    }
    const avatar = await processImage(characterId, "avatar", avatarSource);
    const themes = [];
    for (const themeId of options.themes) {
      const outfitPath = join(
        assetBankDir,
        "outfits_v2_norm",
        `doll_${characterId}__${themeId}.png`,
      );
      const outfitSource = await findSource(outfitPath);
      if (outfitSource === null) {
        await recordMissing(characterId, "outfit", outfitPath, { themeId });
        continue;
      }
      const outfit = await processImage(characterId, "outfit", outfitSource);
      const poses = {};
      for (const state of POSE_STATES) {
        const posePath = join(
          assetBankDir,
          "poses",
          "react",
          `doll_${characterId}__${themeId}__${state}.png`,
        );
        const poseSource = await findSource(posePath);
        if (poseSource === null) {
          await recordMissing(characterId, "pose", posePath, { themeId, state });
          continue;
        }
        poses[state] = await processImage(characterId, "pose", poseSource);
      }
      themes.push({ themeId, outfit, poses });
    }
    characters.push({ characterId, avatar, themes });
  }

  if (latestSourceMtimeMs === 0) {
    latestSourceMtimeMs = bankStats.mtimeMs;
  }
  const manifest = {
    schemaVersion: "1",
    generatedAt: generatedAtFromSources(latestSourceMtimeMs),
    characters,
    voice,
  };
  parseAssetManifest(manifest);

  const uniqueObjects = [...referencedObjects.values()];
  const totalBytes = uniqueObjects.reduce(
    (total, object) => total + object.bytes,
    0,
  );
  const counts = {
    personasRequested: options.personas.length,
    personasEmitted: characters.length,
    themesRequestedPerPersona: options.themes.length,
    avatars: Object.values(perPersona).reduce(
      (total, value) => total + value.avatars,
      0,
    ),
    outfits: Object.values(perPersona).reduce(
      (total, value) => total + value.outfits,
      0,
    ),
    poses: Object.values(perPersona).reduce(
      (total, value) => total + value.poses,
      0,
    ),
    assetReferences: Object.values(perPersona).reduce(
      (total, value) => total + value.avatars + value.outfits + value.poses,
      0,
    ),
    uniqueObjects: uniqueObjects.length,
    encoded: encodedCount,
    reused: reusedCount,
    missing: missingAssets.length,
  };
  const report = {
    schemaVersion: "1",
    builtAt: new Date().toISOString(),
    encoder: encoderProbe.encoder,
    warnings,
    selection: {
      personas: options.personas,
      themes: options.themes,
      sample: options.sample,
    },
    counts,
    totalBytes,
    voice: {
      characters: voice.length,
      lines: voiceClips.length,
      bytes: voiceClips.reduce((total, clip) => total + clip.bytes.length, 0),
    },
    perPersonaBytes: Object.fromEntries(
      options.personas.map((characterId) => [
        characterId,
        perPersona[characterId].bytes,
      ]),
    ),
    perPersona: Object.fromEntries(
      options.personas.map((characterId) => [
        characterId,
        {
          bytes: perPersona[characterId].bytes,
          avatarSource: perPersona[characterId].avatarSource,
        },
      ]),
    ),
    missingAssets,
  };

  await atomicWriteFile(
    join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await atomicWriteFile(
    join(outDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeCache(cachePath, cacheEntries);

  const tableRows = options.personas.map((characterId) => ({
    persona: characterId,
    avatars: perPersona[characterId].avatars,
    outfits: perPersona[characterId].outfits,
    poses: perPersona[characterId].poses,
    bytes: perPersona[characterId].bytes,
    missing: perPersona[characterId].missing,
  }));
  tableRows.push({
    persona: "TOTAL",
    avatars: counts.avatars,
    outfits: counts.outfits,
    poses: counts.poses,
    bytes: totalBytes,
    missing: counts.missing,
  });
  console.log(`\nAsset manifest build (${encoderProbe.encoder})`);
  console.table(tableRows);
  console.log(`Manifest: ${join(outDir, "manifest.json")}`);
  console.log(`Report:   ${join(outDir, "report.json")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
