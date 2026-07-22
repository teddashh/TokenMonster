#!/usr/bin/env node

import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { buildCharactersPackage } from "./build-characters-package.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const MAX_RELEASE_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_ORIGIN_CHARACTERS = 2_048;
const SLOT_FILE_NAMES = Object.freeze([
  "approved-asset-pack-allowlist-v1.json",
  "approved-asset-pack-descriptor-v1.json",
  "approved-release-v2.json",
]);

function usage() {
  return [
    "Usage:",
    "  node scripts/asset-pipeline/prepare-release-slots.mjs \\",
    "    --release-manifest <asset-release-manifest-v2.json> \\",
    "    --descriptor <asset-pack-descriptor-v1.json> \\",
    "    --origin <https-origin> \\",
    "    --out <new-output-directory>",
    "",
    "The output directory must not exist. The allowlist path is derived from",
    "the descriptor; failed validation publishes no output directory.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    releaseManifest: null,
    descriptor: null,
    origin: null,
    out: null,
  };
  const flags = new Map([
    ["--release-manifest", "releaseManifest"],
    ["--descriptor", "descriptor"],
    ["--origin", "origin"],
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
    options[key] = key === "origin" ? value : resolve(value);
    index += 1;
  }
  for (const [flag, key] of flags) {
    if (options[key] === null) throw new Error(`${flag} is required`);
  }
  if (options.origin.length > MAX_ORIGIN_CHARACTERS) {
    throw new Error("--origin exceeds its length bound");
  }
  const outputPrefix = `${options.out}${sep}`;
  if (
    options.releaseManifest === options.out ||
    options.descriptor === options.out ||
    options.releaseManifest.startsWith(outputPrefix) ||
    options.descriptor.startsWith(outputPrefix)
  ) {
    throw new Error("--out must be distinct from every input");
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

async function assertPhysicalDirectory(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a regular, non-symlink directory`);
  }
}

async function assertFreshOutput(path) {
  await assertPhysicalDirectory(dirname(path), "--out parent");
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error("--out already exists; choose a fresh directory");
}

async function readStableJson(path, label, maximumBytes) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be a regular, non-symlink file`);
  }
  if (before.size > maximumBytes) {
    throw new Error(`${label} exceeds its input size bound`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    bytes.byteLength !== before.size
  ) {
    throw new Error(`${label} changed while it was being read`);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return Object.freeze({ bytes, value: JSON.parse(text) });
  } catch {
    throw new Error(`${label} must be valid UTF-8 JSON`);
  }
}

async function verifyStagedSlots(directory, expectedBytes) {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    JSON.stringify(names) !== JSON.stringify(SLOT_FILE_NAMES)
  ) {
    throw new Error("Generated release slot inventory is not exact");
  }
  for (const name of SLOT_FILE_NAMES) {
    const path = join(directory, name);
    const metadata = await lstat(path);
    const bytes = await readFile(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      !bytes.equals(expectedBytes.get(name))
    ) {
      throw new Error(
        "Generated release slot bytes changed before publication",
      );
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await assertFreshOutput(options.out);
  const [releaseInput, descriptorInput] = await Promise.all([
    readStableJson(
      options.releaseManifest,
      "--release-manifest",
      MAX_RELEASE_MANIFEST_BYTES,
    ),
    readStableJson(options.descriptor, "--descriptor", MAX_DESCRIPTOR_BYTES),
  ]);

  buildCharactersPackage();
  const charactersDist = join(
    REPOSITORY_ROOT,
    "packages",
    "characters",
    "dist",
  );
  const [releaseModule, packModule] = await Promise.all([
    import(pathToFileURL(join(charactersDist, "asset-release.js")).href),
    import(pathToFileURL(join(charactersDist, "asset-pack.js")).href),
  ]);
  const releaseManifest = releaseModule.AssetReleaseManifestV2Schema.parse(
    releaseInput.value,
  );
  const descriptor = packModule.AssetPackDescriptorV1Schema.parse(
    descriptorInput.value,
  );
  const allowlist = packModule.AssetPackAllowlistV1Schema.parse({
    schemaVersion: packModule.ASSET_PACK_ALLOWLIST_SCHEMA_VERSION,
    origin: options.origin,
    path: descriptor.pack.path,
  });
  packModule.planFixedAssetPack({ releaseManifest, descriptor, allowlist });
  releaseModule.projectAssetReleaseManifestV2ToRuntimeManifest(releaseManifest);

  const allowlistBytes = Buffer.from(`${JSON.stringify(allowlist, null, 2)}\n`);
  const expectedBytes = new Map([
    ["approved-asset-pack-allowlist-v1.json", allowlistBytes],
    ["approved-asset-pack-descriptor-v1.json", descriptorInput.bytes],
    ["approved-release-v2.json", releaseInput.bytes],
  ]);
  const stagingDirectory = await mkdtemp(
    join(dirname(options.out), ".tokenmonster-release-slots-"),
  );
  let published = false;
  try {
    await Promise.all(
      SLOT_FILE_NAMES.map((name) =>
        writeFile(join(stagingDirectory, name), expectedBytes.get(name), {
          flag: "wx",
          mode: 0o600,
        }),
      ),
    );
    await verifyStagedSlots(stagingDirectory, expectedBytes);
    await assertFreshOutput(options.out);
    await rename(stagingDirectory, options.out);
    published = true;
  } finally {
    if (!published) {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }
  console.log("Generated three validated, cross-bound asset release slots.");
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
      `Release slot validation failed:\n- ${messages.join("\n- ")}`,
    );
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
});
