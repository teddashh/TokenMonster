#!/usr/bin/env node

import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildCharactersPackage } from "./build-characters-package.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const MAX_JSON_BYTES = 32 * 1024 * 1024;

function usage() {
  return [
    "Usage:",
    "  node scripts/asset-pipeline/prepare-embedded-starter-release.mjs \\",
    "    --release-manifest <asset-release-manifest-v2.json> \\",
    "    --out <new-output-directory>",
    "",
    "Writes an eight-image derived manifest for release-only starter staging.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { releaseManifest: null, out: null };
  const flags = new Map([
    ["--release-manifest", "releaseManifest"],
    ["--out", "out"],
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

async function readJson(path) {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size < 1 ||
    metadata.size > MAX_JSON_BYTES
  ) {
    throw new Error("--release-manifest must be one bounded physical file");
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("--release-manifest is not valid JSON");
  }
}

async function requireFreshOutput(path) {
  const parent = await lstat(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error("--out parent must be a physical directory");
  }
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error("--out must not already exist");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.releaseManifest === options.out) {
    throw new Error("--out must differ from --release-manifest");
  }
  await requireFreshOutput(options.out);
  const input = await readJson(options.releaseManifest);

  buildCharactersPackage();
  const characters = await import(
    pathToFileURL(
      join(REPOSITORY_ROOT, "packages", "characters", "dist", "index.js"),
    ).href
  );
  const fullRelease = characters.AssetReleaseManifestV2Schema.parse(input);
  const approvedRuntime =
    characters.projectAssetReleaseManifestV2ToRuntimeManifest(fullRelease);
  characters.projectEmbeddedStarterAssetManifest(approvedRuntime);
  const expectedPaths = new Set(
    characters.EMBEDDED_STARTER_ASSET_SNAPSHOTS.flatMap((snapshot) => [
      snapshot.avatar.path,
      snapshot.outfit.path,
    ]),
  );
  const assets = fullRelease.assets.filter((asset) =>
    expectedPaths.has(asset.output.path),
  );
  if (
    assets.length !== characters.EMBEDDED_STARTER_ASSET_COUNT ||
    new Set(assets.map((asset) => asset.output.path)).size !== expectedPaths.size
  ) {
    throw new Error("approved release does not contain the exact starter subset");
  }
  const derived = characters.AssetReleaseManifestV2Schema.parse({
    ...fullRelease,
    assets,
  });

  let created = false;
  try {
    await mkdir(options.out, { mode: 0o700 });
    created = true;
    const path = join(options.out, "asset-release-manifest-v2.json");
    await writeFile(path, `${JSON.stringify(derived, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    console.log(`Embedded starter release manifest: ${path}`);
    console.log(
      `Assets: ${assets.length}; extracted bytes: ${assets.reduce((sum, asset) => sum + asset.output.bytes, 0)}`,
    );
  } catch (error) {
    if (created) {
      await rm(options.out, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
