#!/usr/bin/env node

import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildCharactersPackage } from "./build-characters-package.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const MAX_JSON_BYTES = 16 * 1024 * 1024;

function usage() {
  return [
    "Usage:",
    "  node scripts/asset-pipeline/prepare-rights-ledger.mjs \\",
    "    --build-provenance <build-provenance-v1.json> \\",
    "    --release-id <opaque-safe-id> \\",
    "    --out <private-rights-ledger-v2.json>",
    "",
    "The generated owner input is deliberately pending and cannot ship.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { buildProvenance: null, releaseId: null, out: null };
  const flags = new Map([
    ["--build-provenance", "buildProvenance"],
    ["--release-id", "releaseId"],
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
    options[key] = key === "releaseId" ? value : resolve(value);
    index += 1;
  }
  for (const [flag, key] of flags) {
    if (options[key] === null) throw new Error(`${flag} is required`);
  }
  return options;
}

async function readJson(path) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("--build-provenance must be a regular, non-symlink file");
  }
  if (stats.size > MAX_JSON_BYTES) {
    throw new Error(`--build-provenance exceeds ${MAX_JSON_BYTES} bytes`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("--build-provenance must contain valid JSON");
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.out === options.buildProvenance) {
    throw new Error("--out must not overwrite --build-provenance");
  }
  try {
    await lstat(options.out);
    throw new Error("--out already exists; choose a fresh path");
  } catch (error) {
    if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
  }

  buildCharactersPackage();
  const moduleUrl = pathToFileURL(
    join(REPOSITORY_ROOT, "packages", "characters", "dist", "asset-release.js"),
  );
  const {
    AssetBuildProvenanceV1Schema,
    AssetRightsLedgerV2Schema,
    computeAssetBuildProvenanceV1Sha256,
  } = await import(moduleUrl.href);
  const provenance = AssetBuildProvenanceV1Schema.parse(
    await readJson(options.buildProvenance),
  );
  const ledger = AssetRightsLedgerV2Schema.parse({
    schemaVersion: "2",
    release: {
      releaseId: options.releaseId,
      approvedAt: null,
      expectedBuildProvenanceSha256:
        computeAssetBuildProvenanceV1Sha256(provenance),
    },
    entries: provenance.entries.map((entry) => ({
      assetId: entry.assetId,
      association: entry.association,
      expectedSource: entry.source,
      expectedOutputSha256: entry.output.sha256,
      rights: {
        licenseStatus: "pending",
        grantReferenceId: null,
        scopes: {
          publicUse: false,
          commercialUse: false,
          modify: false,
          redistribute: false,
        },
      },
      review: {
        brandStatus: "pending",
        brandReviewReferenceId: null,
        contentStatus: "pending",
        contentReviewReferenceId: null,
        contentRating: "unreviewed",
        disclosureId: null,
      },
      presentation: { altText: null, allowedTransforms: [] },
      releaseStatus: "pending",
    })),
  });
  const parent = await lstat(dirname(options.out));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error("--out parent must be a regular, non-symlink directory");
  }
  await writeFile(options.out, `${JSON.stringify(ledger, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    `Pending rights ledger v2: ${options.out} (${ledger.entries.length} entries)`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
