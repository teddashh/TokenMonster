// Compose the four-sisters application icon from the staged embedded starter
// avatars. The desktop packaging wrapper runs this after
// stageCompanionEmbeddedStarterAssets, so the inputs are the same pinned,
// reviewed bytes that ship inside the installer; nothing new is drawn and no
// binary icon lives in the repository. ffmpeg (libwebp) decodes and scales —
// the same external tool contract the asset pipeline already requires — and
// the multi-size .ico container is assembled here from PNG entries.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { PUBLIC_EMBEDDED_STARTER_ASSETS } from "./public-artifact-policy.mjs";

export const COMPANION_APP_ICON_STAGING_NAME = "app-icon-staging";

// Fixed reading order for the 2×2 grid: top-left, top-right, bottom-left,
// bottom-right. This mirrors the roster order of the four starters.
const GRID_CHARACTER_IDS = Object.freeze([
  "chatgpt",
  "claude",
  "gemini",
  "grok",
]);
const MASTER_CELL = 256;
const MASTER_SIZE = MASTER_CELL * 2;
const ICO_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256]);

function requireFfmpeg() {
  const probe = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) {
    throw new Error(
      "ffmpeg is required to compose the application icon (same toolchain contract as the asset pipeline)",
    );
  }
}

function runFfmpeg(args) {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    { encoding: "utf8" },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `ffmpeg failed: ${result.stderr?.trim() || result.error?.message || "unknown error"}`,
    );
  }
}

async function requirePinnedAvatar(objectsDirectory, characterId) {
  const asset = PUBLIC_EMBEDDED_STARTER_ASSETS.find(
    (candidate) =>
      candidate.characterId === characterId && candidate.kind === "avatar",
  );
  if (asset === undefined) {
    throw new Error(`No pinned avatar policy entry for ${characterId}`);
  }
  const path = join(objectsDirectory, ...asset.objectPath.split("/").slice(1));
  const contents = await readFile(path);
  if (
    contents.length !== asset.bytes ||
    createHash("sha256").update(contents).digest("hex") !== asset.sha256
  ) {
    throw new Error(
      `Staged avatar for ${characterId} differs from the pinned policy bytes`,
    );
  }
  return path;
}

function pngIcoEntry(size, png) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size === 256 ? 0 : size, 0);
  entry.writeUInt8(size === 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  return entry;
}

function assembleIco(framesBySize) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(framesBySize.length, 4);
  const entries = [];
  const blobs = [];
  let offset = 6 + 16 * framesBySize.length;
  for (const [size, png] of framesBySize) {
    const entry = pngIcoEntry(size, png);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

export async function buildCompanionAppIcon({
  objectsDirectory,
  outDirectory,
}) {
  requireFfmpeg();
  const avatarPaths = [];
  for (const characterId of GRID_CHARACTER_IDS) {
    avatarPaths.push(await requirePinnedAvatar(objectsDirectory, characterId));
  }
  await rm(outDirectory, { force: true, recursive: true });
  await mkdir(outDirectory, { mode: 0o755, recursive: true });
  const workDirectory = await mkdtemp(join(tmpdir(), "tm-app-icon-"));
  try {
    const masterPath = join(workDirectory, "master.png");
    // Top-anchored square crop keeps every chibi face in frame, then the four
    // cells stack into one 512×512 master.
    const cellFilter = (index) =>
      `[${index}:v]crop='min(iw,ih)':'min(iw,ih)':'(iw-min(iw,ih))/2':0,` +
      `scale=${MASTER_CELL}:${MASTER_CELL}:flags=lanczos,format=rgba[c${index}]`;
    runFfmpeg([
      ...avatarPaths.flatMap((path) => ["-i", path]),
      "-filter_complex",
      [
        cellFilter(0),
        cellFilter(1),
        cellFilter(2),
        cellFilter(3),
        "[c0][c1][c2][c3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[grid]",
      ].join(";"),
      "-map",
      "[grid]",
      "-frames:v",
      "1",
      masterPath,
    ]);
    const framesBySize = [];
    for (const size of ICO_SIZES) {
      const framePath = join(workDirectory, `frame-${size}.png`);
      runFfmpeg([
        "-i",
        masterPath,
        "-vf",
        `scale=${size}:${size}:flags=lanczos`,
        "-frames:v",
        "1",
        framePath,
      ]);
      framesBySize.push([size, await readFile(framePath)]);
    }
    await writeFile(join(outDirectory, "icon.ico"), assembleIco(framesBySize), {
      mode: 0o644,
    });
    const master = framesBySize.find(([size]) => size === 256);
    if (master === undefined) {
      throw new Error("Icon assembly lost the 256px master frame");
    }
    await writeFile(join(outDirectory, "icon.png"), master[1], { mode: 0o644 });
  } finally {
    await rm(workDirectory, { force: true, recursive: true });
  }
  if (MASTER_SIZE !== 512) {
    throw new Error("Icon master size invariant changed unexpectedly");
  }
}

function parseArguments(argv) {
  let objectsDirectory = null;
  let outDirectory = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--objects") {
      if (value === undefined) throw new Error("--objects requires a value");
      objectsDirectory = resolve(value);
      index += 1;
    } else if (argument === "--out") {
      if (value === undefined) throw new Error("--out requires a value");
      outDirectory = resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (objectsDirectory === null || outDirectory === null) {
    throw new Error(
      "Usage: node scripts/release/build-app-icon.mjs --objects <staged objects dir> --out <icon staging dir>",
    );
  }
  return { objectsDirectory, outDirectory };
}

const invokedPath = process.argv[1];
if (
  typeof invokedPath === "string" &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  await buildCompanionAppIcon(parseArguments(process.argv.slice(2)));
}
