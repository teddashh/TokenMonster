#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { link, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const MAX_JSON_BYTES = 16 * 1024 * 1024;

function usage() {
  return [
    "Usage:",
    "  node scripts/asset-pipeline/assemble-release.mjs \\",
    "    --integrity <manifest-v1.json> \\",
    "    --build-provenance <build-provenance-v1.json> \\",
    "    --rights-ledger <private-rights-ledger-v2.json> \\",
    "    --out <asset-release-manifest-v2.json>",
    "",
    "The output path must not already exist. Failed validation writes nothing.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    integrity: null,
    buildProvenance: null,
    rightsLedger: null,
    out: null,
  };
  const flags = new Map([
    ["--integrity", "integrity"],
    ["--build-provenance", "buildProvenance"],
    ["--rights-ledger", "rightsLedger"],
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
    if (options[key] === null) {
      throw new Error(`${flag} is required`);
    }
  }
  return options;
}

function buildCharactersPackage() {
  const result = spawnSync(
    process.execPath,
    [
      join(REPOSITORY_ROOT, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      "tsconfig.build.json",
    ],
    {
      cwd: join(REPOSITORY_ROOT, "packages", "characters"),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Could not build @tokenmonster/characters: ${(result.stderr ?? result.stdout ?? "").trim()}`,
    );
  }
}

async function readJsonFile(path, label) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular, non-symlink file`);
  }
  if (stats.size > MAX_JSON_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_JSON_BYTES}-byte input cap`);
  }
  const bytes = await readFile(path);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function assertFreshOutput(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  throw new Error("--out already exists; choose a fresh path");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const inputPaths = [
    options.integrity,
    options.buildProvenance,
    options.rightsLedger,
  ];
  if (new Set(inputPaths).size !== inputPaths.length) {
    throw new Error("Each input must use a distinct file");
  }
  if (inputPaths.includes(options.out)) {
    throw new Error("--out must not overwrite an input");
  }
  await assertFreshOutput(options.out);

  const [integrityManifest, buildProvenance, rightsLedger] = await Promise.all([
    readJsonFile(options.integrity, "--integrity"),
    readJsonFile(options.buildProvenance, "--build-provenance"),
    readJsonFile(options.rightsLedger, "--rights-ledger"),
  ]);

  buildCharactersPackage();
  const moduleUrl = pathToFileURL(
    join(REPOSITORY_ROOT, "packages", "characters", "dist", "asset-release.js"),
  );
  const { assembleAssetReleaseManifestV2 } = await import(moduleUrl.href);
  const releaseManifest = assembleAssetReleaseManifestV2({
    integrityManifest,
    buildProvenance,
    rightsLedger,
  });

  const outputDirectoryStats = await lstat(dirname(options.out));
  if (
    outputDirectoryStats.isSymbolicLink() ||
    !outputDirectoryStats.isDirectory()
  ) {
    throw new Error("--out parent must be a regular, non-symlink directory");
  }
  const temporaryPath = join(
    dirname(options.out),
    `.${basename(options.out)}.${process.pid}.tmp`,
  );
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(releaseManifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    // A same-directory hard link publishes the already-complete inode without
    // the overwrite race that rename() has on POSIX.
    await link(temporaryPath, options.out);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await rm(temporaryPath, { force: true }).catch(() => {
    // Publication already succeeded. A hidden complete hard-link is harmless,
    // and cleanup trouble must not turn a valid output into an apparent failed
    // assembly whose caller might retry under a different release ID.
    console.warn(
      "WARNING: release manifest published but temporary link cleanup failed",
    );
  });
  console.log(`Asset release manifest v2: ${options.out}`);
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
      `Asset release input validation failed:\n- ${messages.join("\n- ")}`,
    );
  } else {
    console.error(
      error instanceof Error ? error.message : "Asset release assembly failed",
    );
  }
  process.exitCode = 1;
});
