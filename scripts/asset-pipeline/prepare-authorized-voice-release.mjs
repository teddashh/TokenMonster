#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildCharactersPackage } from "./build-characters-package.mjs";
import { canonicalizeVoiceWav } from "./canonicalize-voice-wav.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const BUILD_MANIFEST_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "asset-pipeline",
  "build-manifest.mjs",
);
const WAV_CANONICALIZER_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "asset-pipeline",
  "canonicalize-voice-wav.mjs",
);
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const EXPECTED_PIPELINE_PATH = "scripts/asset-pipeline/build-manifest.mjs";

const CHARACTER_NAMES = Object.freeze({
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  mistral: "Mistral",
  venice: "Venice",
  sakana: "Sakana",
  perplexity: "Perplexity",
  glm: "GLM",
});

const TRIGGER_NAMES_ZH_TW = Object.freeze({
  greeting: "問候",
  unlock: "解鎖",
  quiet: "安靜",
  active: "活躍",
  error: "錯誤",
});

function usage() {
  return [
    "Usage:",
    "  node scripts/asset-pipeline/prepare-authorized-voice-release.mjs \\",
    "    --integrity <combined-manifest-v1.json> \\",
    "    --previous-release <approved-image-only-release-v2.json> \\",
    "    --previous-build-provenance <image-build-provenance-v1.json> \\",
    "    --voice-dir <raw-wav-and-private-sidecars-directory> \\",
    "    --release-id <opaque-safe-id> \\",
    "    --authorization-reference <opaque-safe-id> \\",
    "    --spoken-review-reference <opaque-safe-id> \\",
    "    --approved-at <ISO-8601-timestamp> \\",
    "    --out <fresh-output-directory>",
    "",
    "Writes build-provenance-v1.json and approved-rights-ledger-v2.json.",
    "Private sidecar contents are validated but never copied into either output.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    integrity: null,
    previousRelease: null,
    previousBuildProvenance: null,
    voiceDir: null,
    releaseId: null,
    authorizationReference: null,
    spokenReviewReference: null,
    approvedAt: null,
    out: null,
  };
  const flags = new Map([
    ["--integrity", "integrity"],
    ["--previous-release", "previousRelease"],
    ["--previous-build-provenance", "previousBuildProvenance"],
    ["--voice-dir", "voiceDir"],
    ["--release-id", "releaseId"],
    ["--authorization-reference", "authorizationReference"],
    ["--spoken-review-reference", "spokenReviewReference"],
    ["--approved-at", "approvedAt"],
    ["--out", "out"],
  ]);
  const pathOptions = new Set([
    "integrity",
    "previousRelease",
    "previousBuildProvenance",
    "voiceDir",
    "out",
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
    options[key] = pathOptions.has(key) ? resolve(value) : value;
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

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("Only JSON values can be compared");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort(compareCodePoints)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function exactSetProblems(label, expected, actual) {
  const missing = [...expected]
    .filter((item) => !actual.has(item))
    .sort(compareCodePoints);
  const extra = [...actual]
    .filter((item) => !expected.has(item))
    .sort(compareCodePoints);
  return [
    ...(missing.length === 0
      ? []
      : [`${label} missing: ${missing.join(", ")}`]),
    ...(extra.length === 0 ? [] : [`${label} extra: ${extra.join(", ")}`]),
  ];
}

function assertExactSet(label, expected, actual) {
  const problems = exactSetProblems(label, expected, actual);
  if (problems.length > 0) {
    throw new Error(problems.join("; "));
  }
}

function isInside(parent, candidate) {
  return candidate.startsWith(`${parent}/`);
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
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function assertFreshOutputDirectory(path) {
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
  throw new Error("--out already exists; choose a fresh directory");
}

async function verifyRegularFileInside(root, path, label) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular, non-symlink file`);
  }
  const resolved = await realpath(path);
  if (!isInside(root, resolved)) {
    throw new Error(`${label} escaped its declared directory`);
  }
  return { path: resolved, stats };
}

function imageOutputSnapshot(object) {
  const extension = object.path.slice(object.path.lastIndexOf(".") + 1);
  return {
    path: object.path,
    bytes: object.bytes,
    sha256: object.sha256,
    media: {
      mediaType: extension === "webp" ? "image/webp" : "image/png",
      width: object.width,
      height: object.height,
    },
  };
}

function voiceOutputSnapshot(object, durationMs) {
  return {
    path: object.path,
    bytes: object.bytes,
    sha256: object.sha256,
    media: { mediaType: "audio/wav", durationMs },
  };
}

function flattenIntegrityManifest(
  integrity,
  assetIdForAssociation,
  stateTriggers,
) {
  const entries = [];
  for (const character of integrity.characters) {
    const avatarAssociation = {
      kind: "avatar",
      characterId: character.characterId,
    };
    entries.push({
      assetId: assetIdForAssociation(avatarAssociation),
      association: avatarAssociation,
      output: imageOutputSnapshot(character.avatar),
    });
    for (const theme of character.themes) {
      const outfitAssociation = {
        kind: "outfit",
        characterId: character.characterId,
        themeId: theme.themeId,
      };
      entries.push({
        assetId: assetIdForAssociation(outfitAssociation),
        association: outfitAssociation,
        output: imageOutputSnapshot(theme.outfit),
      });
      for (const state of stateTriggers) {
        const pose = theme.poses[state];
        if (pose === undefined) continue;
        const poseAssociation = {
          kind: "pose",
          characterId: character.characterId,
          themeId: theme.themeId,
          state,
        };
        entries.push({
          assetId: assetIdForAssociation(poseAssociation),
          association: poseAssociation,
          output: imageOutputSnapshot(pose),
        });
      }
    }
  }
  for (const character of integrity.voice) {
    for (const line of character.lines) {
      const association = {
        kind: "voice",
        characterId: character.characterId,
        lineId: line.id,
        trigger: line.trigger,
      };
      entries.push({
        assetId: assetIdForAssociation(association),
        association,
        output: voiceOutputSnapshot(line.object, line.durationMs),
      });
    }
  }
  return entries.sort((left, right) =>
    compareCodePoints(left.assetId, right.assetId),
  );
}

async function verifyCombinedObjects(integrityRoot, integrityEntries) {
  const verifiedPaths = new Set();
  for (const entry of integrityEntries) {
    const output = entry.output;
    if (verifiedPaths.has(output.path)) continue;
    verifiedPaths.add(output.path);
    const file = await verifyRegularFileInside(
      integrityRoot,
      join(integrityRoot, ...output.path.split("/")),
      `combined object ${output.path}`,
    );
    if (file.stats.size !== output.bytes) {
      throw new Error(`combined object byte count is stale: ${output.path}`);
    }
    const bytes = await readFile(file.path);
    if (sha256(bytes) !== output.sha256) {
      throw new Error(`combined object hash is stale: ${output.path}`);
    }
  }
}

function validatePreviousImageAuthority(
  previousRelease,
  previousBuild,
  combinedImageEntries,
  computeAssetBuildProvenanceV1Sha256,
) {
  if (
    previousRelease.assets.some((asset) => asset.association.kind === "voice")
  ) {
    throw new Error("--previous-release must be image-only");
  }
  if (
    previousBuild.entries.some((entry) => entry.association.kind === "voice")
  ) {
    throw new Error("--previous-build-provenance must be image-only");
  }
  if (
    previousRelease.provenance.buildProvenanceSha256 !==
    computeAssetBuildProvenanceV1Sha256(previousBuild)
  ) {
    throw new Error(
      "--previous-build-provenance does not match --previous-release",
    );
  }
  if (
    previousBuild.integrityManifestSha256 !==
    previousRelease.provenance.integrityManifestSha256
  ) {
    throw new Error(
      "previous image provenance pins a different integrity hash",
    );
  }
  if (!sameJson(previousBuild.pipeline, previousRelease.provenance.pipeline)) {
    throw new Error("previous image pipeline snapshot is inconsistent");
  }
  if (previousBuild.pipeline.scriptPath !== EXPECTED_PIPELINE_PATH) {
    throw new Error("previous image pipeline script path is unsupported");
  }

  const releaseById = new Map(
    previousRelease.assets.map((asset) => [asset.assetId, asset]),
  );
  const buildById = new Map(
    previousBuild.entries.map((entry) => [entry.assetId, entry]),
  );
  const combinedById = new Map(
    combinedImageEntries.map((entry) => [entry.assetId, entry]),
  );
  const expectedIds = new Set(releaseById.keys());
  assertExactSet(
    "previous image build provenance",
    expectedIds,
    new Set(buildById.keys()),
  );
  assertExactSet(
    "combined image integrity",
    expectedIds,
    new Set(combinedById.keys()),
  );

  for (const assetId of [...expectedIds].sort(compareCodePoints)) {
    const releaseAsset = releaseById.get(assetId);
    const buildEntry = buildById.get(assetId);
    const combinedEntry = combinedById.get(assetId);
    for (const [field, left, right] of [
      ["association", releaseAsset.association, buildEntry.association],
      ["source", releaseAsset.source, buildEntry.source],
      ["output", releaseAsset.output, buildEntry.output],
      [
        "generation history",
        releaseAsset.generationHistory,
        buildEntry.generationHistory,
      ],
      [
        "combined association",
        releaseAsset.association,
        combinedEntry.association,
      ],
      ["combined output", releaseAsset.output, combinedEntry.output],
    ]) {
      if (!sameJson(left, right)) {
        throw new Error(`${assetId} ${field} does not match prior approval`);
      }
    }
  }

  return { releaseById };
}

function validateVoiceScript(voiceScript, characterIds, voiceTriggers) {
  if (
    voiceScript === null ||
    typeof voiceScript !== "object" ||
    Array.isArray(voiceScript)
  ) {
    throw new Error("voice_script_v1.json must contain an object");
  }
  assertExactSet(
    "voice script personas",
    new Set(characterIds),
    new Set(Object.keys(voiceScript)),
  );
  for (const characterId of characterIds) {
    const lines = voiceScript[characterId];
    if (lines === null || typeof lines !== "object" || Array.isArray(lines)) {
      throw new Error(`voice script entry must be an object: ${characterId}`);
    }
    assertExactSet(
      `voice script triggers for ${characterId}`,
      new Set(voiceTriggers),
      new Set(Object.keys(lines)),
    );
    for (const trigger of voiceTriggers) {
      if (typeof lines[trigger] !== "string" || lines[trigger].length === 0) {
        throw new Error(
          `voice script line must be a non-empty string: ${characterId}/${trigger}`,
        );
      }
    }
  }
}

function validatePrivateSidecar(sidecar, characterId, trigger, wavFilename) {
  if (
    sidecar === null ||
    typeof sidecar !== "object" ||
    Array.isArray(sidecar)
  ) {
    throw new Error(`voice sidecar must contain an object: ${wavFilename}`);
  }
  if (
    sidecar.workflow !== "tokenmonster-voice-v1" ||
    sidecar.status !== "completed" ||
    sidecar.settings?.persona !== characterId ||
    sidecar.settings?.qualityGate !== true ||
    sidecar.summary?.chunks !== 1 ||
    !Array.isArray(sidecar.chunks) ||
    sidecar.chunks.length !== 1 ||
    sidecar.chunks[0]?.accepted !== true
  ) {
    throw new Error(
      `voice sidecar is not one completed quality-gated clip: ${wavFilename}`,
    );
  }
  if (
    !Array.isArray(sidecar.outputs) ||
    sidecar.outputs.length !== 1 ||
    sidecar.outputs[0]?.kind !== "audio" ||
    sidecar.outputs[0]?.filename !== wavFilename
  ) {
    throw new Error(`voice sidecar output does not match: ${wavFilename}`);
  }
  const scriptKey = `${characterId}/${trigger}`;
  return scriptKey;
}

async function prepareVoiceEntries({
  voiceDir,
  combinedVoiceEntries,
  characterIds,
  voiceTriggers,
  releaseId,
  authorizationReference,
  spokenReviewReference,
  disclosureId,
  canonicalizerRevision,
}) {
  const expectedNames = new Set(["voice_script_v1.json"]);
  for (const characterId of characterIds) {
    for (const trigger of voiceTriggers) {
      expectedNames.add(`${characterId}__${trigger}.wav`);
      expectedNames.add(`${characterId}__${trigger}.json`);
    }
  }
  const directoryEntries = await readdir(voiceDir, { withFileTypes: true });
  assertExactSet(
    "raw voice directory",
    expectedNames,
    new Set(directoryEntries.map((entry) => entry.name)),
  );
  for (const entry of directoryEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(
        `raw voice directory entries must be regular files: ${entry.name}`,
      );
    }
  }

  const scriptFile = await verifyRegularFileInside(
    voiceDir,
    join(voiceDir, "voice_script_v1.json"),
    "voice_script_v1.json",
  );
  const voiceScriptInput = await readJsonFile(
    scriptFile.path,
    "voice_script_v1.json",
  );
  validateVoiceScript(voiceScriptInput.value, characterIds, voiceTriggers);

  const combinedById = new Map(
    combinedVoiceEntries.map((entry) => [entry.assetId, entry]),
  );
  const expectedAssetIds = new Set();
  const drafts = [];
  const inventoryEntries = [];

  for (const characterId of characterIds) {
    for (const trigger of voiceTriggers) {
      const lineId = `${characterId}-${trigger}`;
      const assetId = `asset:${characterId}:voice:${lineId}:${trigger}`;
      expectedAssetIds.add(assetId);
      const combinedEntry = combinedById.get(assetId);
      if (combinedEntry === undefined) continue;

      const wavFilename = `${characterId}__${trigger}.wav`;
      const sidecarFilename = `${characterId}__${trigger}.json`;
      const [wavFile, sidecarFile] = await Promise.all([
        verifyRegularFileInside(
          voiceDir,
          join(voiceDir, wavFilename),
          `voice source ${wavFilename}`,
        ),
        verifyRegularFileInside(
          voiceDir,
          join(voiceDir, sidecarFilename),
          `voice sidecar ${sidecarFilename}`,
        ),
      ]);
      const [rawBytes, sidecarInput] = await Promise.all([
        readFile(wavFile.path),
        readJsonFile(sidecarFile.path, `voice sidecar ${sidecarFilename}`),
      ]);
      validatePrivateSidecar(
        sidecarInput.value,
        characterId,
        trigger,
        wavFilename,
      );
      const canonical = canonicalizeVoiceWav(rawBytes, wavFilename);
      if (
        canonical.bytes.length !== combinedEntry.output.bytes ||
        sha256(canonical.bytes) !== combinedEntry.output.sha256 ||
        canonical.durationMs !== combinedEntry.output.media.durationMs
      ) {
        throw new Error(
          `canonical voice bytes do not match combined integrity: ${wavFilename}`,
        );
      }

      const sourcePath = `voice/${wavFilename}`;
      const sourceSha256 = sha256(rawBytes);
      inventoryEntries.push({ path: sourcePath, sha256: sourceSha256 });
      drafts.push({
        characterId,
        trigger,
        wavFilename,
        sidecarFilename,
        sidecarSha256: sha256(sidecarInput.bytes),
        sourcePath,
        sourceSha256,
        combinedEntry,
      });
    }
  }
  assertExactSet(
    "combined voice integrity",
    expectedAssetIds,
    new Set(combinedById.keys()),
  );

  inventoryEntries.sort((left, right) =>
    compareCodePoints(left.path, right.path),
  );
  const inventoryRevision = sha256(
    Buffer.from(
      JSON.stringify({ schemaVersion: "1", entries: inventoryEntries }),
    ),
  );
  const voiceBuildEntries = [];
  const voiceRightsEntries = [];
  for (const draft of drafts.sort((left, right) =>
    compareCodePoints(left.combinedEntry.assetId, right.combinedEntry.assetId),
  )) {
    const displayName = CHARACTER_NAMES[draft.characterId];
    const triggerName = TRIGGER_NAMES_ZH_TW[draft.trigger];
    if (displayName === undefined || triggerName === undefined) {
      throw new Error(
        `missing non-transcript voice label for ${draft.characterId}/${draft.trigger}`,
      );
    }
    const source = {
      inventoryId: releaseId,
      inventoryRevision,
      path: draft.sourcePath,
      sha256: draft.sourceSha256,
    };
    voiceBuildEntries.push({
      assetId: draft.combinedEntry.assetId,
      association: draft.combinedEntry.association,
      source,
      output: draft.combinedEntry.output,
      generationHistory: {
        tool: {
          name: "tokenmonster-wav-canonicalizer",
          version: canonicalizerRevision,
        },
        sourceMediaType: "audio/wav",
        resize: null,
        encoding: { mediaType: "audio/wav", quality: null },
        metadataStripped: true,
      },
      upstream: {
        repository: {
          repositoryId: "owner-authorized-voice-inventory",
          revision: inventoryRevision,
        },
        steps: [
          {
            operation: "generate",
            receipt: {
              path: `voice/${draft.sidecarFilename}`,
              sha256: draft.sidecarSha256,
            },
            tool: {
              name: "tokenmonster-voice-workflow",
              version: "tokenmonster-voice-v1",
            },
            model: null,
            inputs: [],
            outputSha256: draft.sourceSha256,
          },
        ],
      },
    });
    voiceRightsEntries.push({
      assetId: draft.combinedEntry.assetId,
      association: draft.combinedEntry.association,
      expectedSource: source,
      expectedOutputSha256: draft.combinedEntry.output.sha256,
      rights: {
        licenseStatus: "approved",
        grantReferenceId: authorizationReference,
        scopes: {
          publicUse: true,
          commercialUse: true,
          modify: true,
          redistribute: true,
        },
      },
      review: {
        brandStatus: "approved",
        brandReviewReferenceId: authorizationReference,
        contentStatus: "approved",
        contentReviewReferenceId: spokenReviewReference,
        contentRating: "general",
        disclosureId,
      },
      presentation: {
        altText: {
          "zh-TW": `${displayName} 的${triggerName}中文語音提示`,
          en: `${displayName} ${draft.trigger} Chinese voice prompt`,
        },
        allowedTransforms: [],
      },
      voiceEvidence: {
        locale: "zh-TW",
        sourceType: "owner-authorized-reference-clone",
        consentReferenceId: authorizationReference,
        syntheticProvenanceReferenceId: null,
        spokenContentReviewReferenceId: spokenReviewReference,
      },
      releaseStatus: "approved",
    });
  }
  return { voiceBuildEntries, voiceRightsEntries };
}

function imageRightsEntry(asset) {
  return {
    assetId: asset.assetId,
    association: asset.association,
    expectedSource: asset.source,
    expectedOutputSha256: asset.output.sha256,
    rights: asset.rights,
    review: asset.review,
    presentation: asset.presentation,
    releaseStatus: asset.releaseStatus,
  };
}

async function publishOutputs(out, provenance, ledger) {
  await mkdir(out, { mode: 0o700 });
  let complete = false;
  try {
    await Promise.all([
      writeFile(
        join(out, "build-provenance-v1.json"),
        `${JSON.stringify(provenance, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      ),
      writeFile(
        join(out, "approved-rights-ledger-v2.json"),
        `${JSON.stringify(ledger, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      ),
    ]);
    complete = true;
  } finally {
    if (!complete) {
      await rm(out, { recursive: true, force: true });
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const inputPaths = [
    options.integrity,
    options.previousRelease,
    options.previousBuildProvenance,
    options.voiceDir,
  ];
  if (new Set(inputPaths).size !== inputPaths.length) {
    throw new Error("Each input must use a distinct path");
  }
  if (inputPaths.includes(options.out)) {
    throw new Error("--out must not overwrite an input");
  }
  await assertFreshOutputDirectory(options.out);
  const outputParent = await lstat(dirname(options.out));
  if (outputParent.isSymbolicLink() || !outputParent.isDirectory()) {
    throw new Error("--out parent must be a regular, non-symlink directory");
  }
  const voiceDirStats = await lstat(options.voiceDir);
  if (voiceDirStats.isSymbolicLink() || !voiceDirStats.isDirectory()) {
    throw new Error("--voice-dir must be a regular, non-symlink directory");
  }
  const voiceDir = await realpath(options.voiceDir);
  const integrityRoot = await realpath(dirname(options.integrity));

  const [integrityInput, previousReleaseInput, previousBuildInput] =
    await Promise.all([
      readJsonFile(options.integrity, "--integrity"),
      readJsonFile(options.previousRelease, "--previous-release"),
      readJsonFile(
        options.previousBuildProvenance,
        "--previous-build-provenance",
      ),
    ]);

  buildCharactersPackage();
  const [assetManifestModule, assetReleaseModule] = await Promise.all([
    import(
      pathToFileURL(
        join(
          REPOSITORY_ROOT,
          "packages",
          "characters",
          "dist",
          "asset-manifest.js",
        ),
      ).href
    ),
    import(
      pathToFileURL(
        join(
          REPOSITORY_ROOT,
          "packages",
          "characters",
          "dist",
          "asset-release.js",
        ),
      ).href
    ),
  ]);
  const { ASSET_CHARACTER_IDS, ASSET_STATE_TRIGGERS, ASSET_VOICE_TRIGGERS } =
    assetManifestModule;
  const {
    AssetBuildProvenanceV1Schema,
    AssetIntegrityManifestV1Schema,
    AssetReleaseManifestV2Schema,
    AssetRightsLedgerV2Schema,
    assetIdForAssociation,
    computeAssetBuildProvenanceV1Sha256,
    computeAssetIntegrityManifestV1Sha256,
  } = assetReleaseModule;

  const integrity = AssetIntegrityManifestV1Schema.parse(integrityInput.value);
  const previousRelease = AssetReleaseManifestV2Schema.parse(
    previousReleaseInput.value,
  );
  const previousBuild = AssetBuildProvenanceV1Schema.parse(
    previousBuildInput.value,
  );
  const approvedAtMs = Date.parse(options.approvedAt);
  const generatedAtMs = Date.parse(integrity.generatedAt);
  if (
    !Number.isFinite(approvedAtMs) ||
    new Date(approvedAtMs).toISOString() !== options.approvedAt
  ) {
    throw new Error("--approved-at must be a canonical ISO-8601 timestamp");
  }
  if (approvedAtMs < generatedAtMs) {
    throw new Error("--approved-at cannot precede combined integrity creation");
  }

  const integrityEntries = flattenIntegrityManifest(
    integrity,
    assetIdForAssociation,
    ASSET_STATE_TRIGGERS,
  );
  await verifyCombinedObjects(integrityRoot, integrityEntries);
  const combinedImageEntries = integrityEntries.filter(
    (entry) => entry.association.kind !== "voice",
  );
  const combinedVoiceEntries = integrityEntries.filter(
    (entry) => entry.association.kind === "voice",
  );
  const { releaseById } = validatePreviousImageAuthority(
    previousRelease,
    previousBuild,
    combinedImageEntries,
    computeAssetBuildProvenanceV1Sha256,
  );

  const disclosureIds = new Set(
    previousRelease.assets.map((asset) => asset.review.disclosureId),
  );
  if (disclosureIds.size !== 1) {
    throw new Error("previous image release must use one disclosure reference");
  }
  const disclosureId = [...disclosureIds][0];
  const [pipelineRevision, canonicalizerRevision] = await Promise.all([
    readFile(BUILD_MANIFEST_PATH).then(sha256),
    readFile(WAV_CANONICALIZER_PATH).then(sha256),
  ]);
  const { voiceBuildEntries, voiceRightsEntries } = await prepareVoiceEntries({
    voiceDir,
    combinedVoiceEntries,
    characterIds: ASSET_CHARACTER_IDS,
    voiceTriggers: ASSET_VOICE_TRIGGERS,
    releaseId: options.releaseId,
    authorizationReference: options.authorizationReference,
    spokenReviewReference: options.spokenReviewReference,
    disclosureId,
    canonicalizerRevision,
  });

  const provenance = AssetBuildProvenanceV1Schema.parse({
    schemaVersion: "1",
    createdAt: integrity.generatedAt,
    integrityManifestSha256: computeAssetIntegrityManifestV1Sha256(integrity),
    pipeline: {
      repositoryId: previousBuild.pipeline.repositoryId,
      revision: pipelineRevision,
      scriptPath: EXPECTED_PIPELINE_PATH,
    },
    entries: [...previousBuild.entries, ...voiceBuildEntries].sort(
      (left, right) => compareCodePoints(left.assetId, right.assetId),
    ),
  });
  const ledger = AssetRightsLedgerV2Schema.parse({
    schemaVersion: "2",
    release: {
      releaseId: options.releaseId,
      approvedAt: options.approvedAt,
      expectedBuildProvenanceSha256:
        computeAssetBuildProvenanceV1Sha256(provenance),
    },
    entries: [
      ...[...releaseById.values()].map(imageRightsEntry),
      ...voiceRightsEntries,
    ].sort((left, right) => compareCodePoints(left.assetId, right.assetId)),
  });

  await publishOutputs(options.out, provenance, ledger);
  console.log(
    `Authorized combined release inputs: ${options.out} ` +
      `(${previousBuild.entries.length} image + ${voiceBuildEntries.length} voice entries)`,
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
    console.error(`Input validation failed:\n- ${messages.join("\n- ")}`);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
