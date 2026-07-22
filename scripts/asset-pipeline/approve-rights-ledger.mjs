#!/usr/bin/env node

import { chmod, link, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildCharactersPackage } from "./build-characters-package.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_PROVENANCE_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const SAFE_REFERENCE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const OWNER_STATEMENT =
  "I am the owner or an authorized rights holder for every image asset bound by this receipt. I grant TokenMonster public use, commercial use, modification, and redistribution rights for only that bound release and provenance hash, and I approve its general-audience brand, content, disclosure, allowed-transform, and deterministic bilingual-alt-text records.";
const REQUIRED_ALLOWED_TRANSFORMS = ["scale-down"];
const REQUIRED_ALT_TEXT_POLICY = {
  mode: "deterministic-tokenmonster-catalog-v1",
  locales: ["zh-TW", "en"],
  associationKinds: ["avatar", "outfit", "pose"],
  privateReceiptContentUsed: false,
};
const STATE_LABELS_ZH_TW = {
  supported: "支持",
  challenged: "挑戰",
  victory: "勝利",
};

function usage() {
  return [
    "Usage:",
    "  node scripts/asset-pipeline/approve-rights-ledger.mjs \\",
    "    --pending-ledger <private-rights-ledger-v2.json> \\",
    "    --build-provenance <build-provenance-v1.json> \\",
    "    --grant-receipt <owner-private-grant-receipt-v1.json> \\",
    "    --out <approved-private-rights-ledger-v2.json>",
    "",
    "This command approves only an exact image-only pending ledger bound to",
    "the actual provenance and a strict owner-private grant receipt. It never",
    "creates a grant receipt and never approves voice assets.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    pendingLedger: null,
    buildProvenance: null,
    grantReceipt: null,
    out: null,
  };
  const flags = new Map([
    ["--pending-ledger", "pendingLedger"],
    ["--build-provenance", "buildProvenance"],
    ["--grant-receipt", "grantReceipt"],
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

function sameStrings(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function isSafeReferenceId(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 120 &&
    SAFE_REFERENCE_PATTERN.test(value)
  );
}

function isCanonicalUtcTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function parseGrantReceipt(input) {
  if (
    !hasExactKeys(input, [
      "schemaVersion",
      "receiptType",
      "ownerStatement",
      "release",
      "references",
      "rights",
      "review",
      "presentation",
    ]) ||
    input.schemaVersion !== "1" ||
    input.receiptType !== "tokenmonster-image-rights-grant"
  ) {
    throw new Error("--grant-receipt has an invalid exact v1 shape");
  }
  if (input.ownerStatement !== OWNER_STATEMENT) {
    throw new Error(
      "--grant-receipt ownerStatement is not the exact controlled statement",
    );
  }
  if (
    !hasExactKeys(input.release, [
      "releaseId",
      "approvedAt",
      "expectedBuildProvenanceSha256",
    ]) ||
    !isSafeReferenceId(input.release.releaseId) ||
    !isCanonicalUtcTimestamp(input.release.approvedAt) ||
    typeof input.release.expectedBuildProvenanceSha256 !== "string" ||
    !SHA256_PATTERN.test(input.release.expectedBuildProvenanceSha256)
  ) {
    throw new Error("--grant-receipt release binding is invalid or unsafe");
  }
  const referenceKeys = [
    "grantReferenceId",
    "brandReviewReferenceId",
    "contentReviewReferenceId",
    "disclosureId",
  ];
  if (
    !hasExactKeys(input.references, referenceKeys) ||
    !referenceKeys.every((key) => isSafeReferenceId(input.references[key]))
  ) {
    throw new Error(
      "--grant-receipt reference IDs must all be explicit safe IDs",
    );
  }
  if (
    !hasExactKeys(input.rights, ["licenseStatus", "scopes"]) ||
    input.rights.licenseStatus !== "approved" ||
    !hasExactKeys(input.rights.scopes, [
      "publicUse",
      "commercialUse",
      "modify",
      "redistribute",
    ]) ||
    input.rights.scopes.publicUse !== true ||
    input.rights.scopes.commercialUse !== true ||
    input.rights.scopes.modify !== true ||
    input.rights.scopes.redistribute !== true
  ) {
    throw new Error(
      "--grant-receipt must grant every required rights scope literally",
    );
  }
  if (
    !hasExactKeys(input.review, [
      "brandStatus",
      "contentStatus",
      "contentRating",
    ]) ||
    input.review.brandStatus !== "approved" ||
    input.review.contentStatus !== "approved" ||
    input.review.contentRating !== "general"
  ) {
    throw new Error(
      "--grant-receipt must explicitly approve brand and general-audience content",
    );
  }
  if (
    !hasExactKeys(input.presentation, [
      "allowedTransforms",
      "bilingualAltTextPolicy",
    ]) ||
    !sameStrings(
      input.presentation.allowedTransforms,
      REQUIRED_ALLOWED_TRANSFORMS,
    ) ||
    !hasExactKeys(input.presentation.bilingualAltTextPolicy, [
      "mode",
      "locales",
      "associationKinds",
      "privateReceiptContentUsed",
    ]) ||
    input.presentation.bilingualAltTextPolicy.mode !==
      REQUIRED_ALT_TEXT_POLICY.mode ||
    !sameStrings(
      input.presentation.bilingualAltTextPolicy.locales,
      REQUIRED_ALT_TEXT_POLICY.locales,
    ) ||
    !sameStrings(
      input.presentation.bilingualAltTextPolicy.associationKinds,
      REQUIRED_ALT_TEXT_POLICY.associationKinds,
    ) ||
    input.presentation.bilingualAltTextPolicy.privateReceiptContentUsed !==
      false
  ) {
    throw new Error(
      "--grant-receipt must use the exact transform and bilingual-alt-text policy",
    );
  }
  return input;
}

async function readJson(path, label, maximumBytes) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular, non-symlink file`);
  }
  if (stats.size < 1 || stats.size > maximumBytes) {
    throw new Error(`${label} exceeds its bounded input size`);
  }
  const bytes = await readFile(path);
  if (bytes.length !== stats.size) {
    throw new Error(`${label} changed while it was read`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
}

async function readPrivateGrantReceipt(path) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("--grant-receipt must be a regular, non-symlink file");
  }
  if ((stats.mode & 0o777) !== 0o600 || stats.nlink !== 1) {
    throw new Error(
      "--grant-receipt must be owner-private mode 0600 with one link",
    );
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("--grant-receipt must be owned by the current OS user");
  }
  const parentStats = await lstat(dirname(path));
  if (
    parentStats.isSymbolicLink() ||
    !parentStats.isDirectory() ||
    (parentStats.mode & 0o077) !== 0
  ) {
    throw new Error(
      "--grant-receipt parent must be a private non-symlink directory",
    );
  }
  return await readJson(path, "--grant-receipt", MAX_RECEIPT_BYTES);
}

async function assertFreshOutput(path) {
  try {
    await lstat(path);
    throw new Error("--out already exists; choose a fresh path");
  } catch (error) {
    if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
  }
  const parent = await lstat(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error("--out parent must be a regular, non-symlink directory");
  }
}

function assertExactPendingLedger(ledger, provenance) {
  if (ledger.release.approvedAt !== null) {
    throw new Error("--pending-ledger release must still be pending");
  }
  if (
    ledger.entries.length === 0 ||
    ledger.entries.length !== provenance.entries.length
  ) {
    throw new Error(
      "--pending-ledger must contain the exact non-empty provenance entry set",
    );
  }
  for (const [index, entry] of ledger.entries.entries()) {
    const provenanceEntry = provenance.entries[index];
    if (
      entry.association.kind === "voice" ||
      provenanceEntry?.association.kind === "voice"
    ) {
      throw new Error(
        "Rights approval is image-only and rejects every voice entry",
      );
    }
    if (
      provenanceEntry === undefined ||
      entry.assetId !== provenanceEntry.assetId ||
      !isDeepStrictEqual(entry.association, provenanceEntry.association) ||
      !isDeepStrictEqual(entry.expectedSource, provenanceEntry.source) ||
      entry.expectedOutputSha256 !== provenanceEntry.output.sha256
    ) {
      throw new Error(
        "--pending-ledger is stale or does not exactly match build provenance",
      );
    }
    if (
      entry.rights.licenseStatus !== "pending" ||
      entry.rights.grantReferenceId !== null ||
      entry.rights.scopes.publicUse !== false ||
      entry.rights.scopes.commercialUse !== false ||
      entry.rights.scopes.modify !== false ||
      entry.rights.scopes.redistribute !== false ||
      entry.review.brandStatus !== "pending" ||
      entry.review.brandReviewReferenceId !== null ||
      entry.review.contentStatus !== "pending" ||
      entry.review.contentReviewReferenceId !== null ||
      entry.review.contentRating !== "unreviewed" ||
      entry.review.disclosureId !== null ||
      entry.presentation.altText !== null ||
      entry.presentation.allowedTransforms.length !== 0 ||
      entry.voiceEvidence !== undefined ||
      entry.releaseStatus !== "pending"
    ) {
      throw new Error(
        "--pending-ledger must retain the exact all-pending, false, and empty template",
      );
    }
  }
}

function catalogMaps(progressionManifest, wardrobeCatalog, stateTriggers) {
  const characters = new Map(
    progressionManifest.characters
      .filter(({ id }) => id !== "reserved")
      .map(({ id, displayName }) => [id, displayName]),
  );
  const themes = new Map(
    wardrobeCatalog.map(({ themeId, displayName }) => [
      themeId,
      { id: themeId, displayName },
    ]),
  );
  if (
    !sameStrings(stateTriggers, ["supported", "challenged", "victory"]) ||
    !stateTriggers.every((state) => Object.hasOwn(STATE_LABELS_ZH_TW, state))
  ) {
    throw new Error(
      "The controlled state catalog no longer matches alt-text policy v1",
    );
  }
  return { characters, themes };
}

function deriveBilingualAltText(association, catalogs) {
  const characterName = catalogs.characters.get(association.characterId);
  if (characterName === undefined) {
    throw new Error(
      "An image association is absent from the character catalog",
    );
  }
  if (association.kind === "avatar") {
    return {
      "zh-TW": `${characterName} 的角色頭像`,
      en: `${characterName} character avatar`,
    };
  }
  const theme = catalogs.themes.get(association.themeId);
  if (theme === undefined) {
    throw new Error("An image association is absent from the wardrobe catalog");
  }
  if (association.kind === "outfit") {
    return {
      "zh-TW": `${characterName} 的${theme.displayName}主題服裝`,
      en: `${characterName} wearing the ${theme.id} theme outfit`,
    };
  }
  if (association.kind === "pose") {
    const stateZhTw = STATE_LABELS_ZH_TW[association.state];
    if (stateZhTw === undefined) {
      throw new Error("An image association is absent from the state catalog");
    }
    return {
      "zh-TW": `${characterName} 穿著${theme.displayName}主題服裝，呈現${stateZhTw}姿勢`,
      en: `${characterName} wearing the ${theme.id} theme outfit in a ${association.state} pose`,
    };
  }
  throw new Error(
    "Rights approval is image-only and rejects every voice entry",
  );
}

async function publishLedger(path, ledger) {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await link(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await rm(temporaryPath, { force: true }).catch(() => {
    console.warn(
      "WARNING: approved ledger published but temporary link cleanup failed",
    );
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const inputs = [
    options.pendingLedger,
    options.buildProvenance,
    options.grantReceipt,
  ];
  if (new Set(inputs).size !== inputs.length || inputs.includes(options.out)) {
    throw new Error("Every input and --out must use a distinct path");
  }
  await assertFreshOutput(options.out);

  const receipt = parseGrantReceipt(
    await readPrivateGrantReceipt(options.grantReceipt),
  );
  const [pendingInput, provenanceInput] = await Promise.all([
    readJson(options.pendingLedger, "--pending-ledger", MAX_LEDGER_BYTES),
    readJson(
      options.buildProvenance,
      "--build-provenance",
      MAX_PROVENANCE_BYTES,
    ),
  ]);

  buildCharactersPackage();
  const moduleUrl = pathToFileURL(
    join(REPOSITORY_ROOT, "packages", "characters", "dist", "index.js"),
  );
  const {
    ASSET_STATE_TRIGGERS,
    AssetBuildProvenanceV1Schema,
    AssetRightsLedgerV2Schema,
    LETTER_WARDROBE_CATALOG,
    PROGRESSION_MANIFEST,
    computeAssetBuildProvenanceV1Sha256,
  } = await import(moduleUrl.href);
  const provenance = AssetBuildProvenanceV1Schema.parse(provenanceInput);
  const pendingLedger = AssetRightsLedgerV2Schema.parse(pendingInput);
  const provenanceSha256 = computeAssetBuildProvenanceV1Sha256(provenance);

  if (
    Date.parse(receipt.release.approvedAt) < Date.parse(provenance.createdAt)
  ) {
    throw new Error(
      "--grant-receipt approvedAt must not predate build provenance creation",
    );
  }
  if (
    pendingLedger.release.releaseId !== receipt.release.releaseId ||
    pendingLedger.release.expectedBuildProvenanceSha256 !== provenanceSha256 ||
    receipt.release.expectedBuildProvenanceSha256 !== provenanceSha256
  ) {
    throw new Error(
      "Grant receipt, pending ledger, and actual build provenance binding do not match",
    );
  }
  assertExactPendingLedger(pendingLedger, provenance);
  const catalogs = catalogMaps(
    PROGRESSION_MANIFEST,
    LETTER_WARDROBE_CATALOG,
    ASSET_STATE_TRIGGERS,
  );
  const approvedLedger = AssetRightsLedgerV2Schema.parse({
    schemaVersion: "2",
    release: {
      releaseId: pendingLedger.release.releaseId,
      approvedAt: receipt.release.approvedAt,
      expectedBuildProvenanceSha256: provenanceSha256,
    },
    entries: pendingLedger.entries.map((entry) => ({
      assetId: entry.assetId,
      association: entry.association,
      expectedSource: entry.expectedSource,
      expectedOutputSha256: entry.expectedOutputSha256,
      rights: {
        licenseStatus: "approved",
        grantReferenceId: receipt.references.grantReferenceId,
        scopes: {
          publicUse: true,
          commercialUse: true,
          modify: true,
          redistribute: true,
        },
      },
      review: {
        brandStatus: "approved",
        brandReviewReferenceId: receipt.references.brandReviewReferenceId,
        contentStatus: "approved",
        contentReviewReferenceId: receipt.references.contentReviewReferenceId,
        contentRating: "general",
        disclosureId: receipt.references.disclosureId,
      },
      presentation: {
        altText: deriveBilingualAltText(entry.association, catalogs),
        allowedTransforms: [...REQUIRED_ALLOWED_TRANSFORMS],
      },
      releaseStatus: "approved",
    })),
  });

  await publishLedger(options.out, approvedLedger);
  console.log(
    `Approved private rights ledger v2: ${options.out} (${approvedLedger.entries.length} image entries)`,
  );
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
      `Rights approval input validation failed:\n- ${messages.join("\n- ")}`,
    );
  } else {
    console.error(
      error instanceof Error ? error.message : "Rights approval failed",
    );
  }
  process.exitCode = 1;
});
