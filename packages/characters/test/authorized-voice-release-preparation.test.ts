import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ASSET_CHARACTER_IDS,
  ASSET_VOICE_TRIGGERS,
} from "../src/asset-manifest.js";
import {
  AssetBuildProvenanceV1Schema,
  AssetIntegrityManifestV1Schema,
  AssetReleaseManifestV2Schema,
  AssetRightsLedgerV2Schema,
  assembleAssetReleaseManifestV2,
  computeAssetBuildProvenanceV1Sha256,
} from "../src/asset-release.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const PREPARER_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "asset-pipeline",
  "prepare-authorized-voice-release.mjs",
);
const BUILD_MANIFEST_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "asset-pipeline",
  "build-manifest.mjs",
);
const PRIVATE_SENTINEL = "PRIVATE-SPOKEN-CONTENT-SENTINEL";
const roots: string[] = [];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function riffChunk(id: string, payload: Buffer): Buffer {
  const chunk = Buffer.alloc(8 + payload.length + (payload.length % 2));
  chunk.write(id, 0, "ascii");
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);
  return chunk;
}

function riffWave(chunks: readonly Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WAVE", 8, "ascii");
  return Buffer.concat([header, body]);
}

function voiceBytes(): { raw: Buffer; canonical: Buffer; durationMs: number } {
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(22_050, 4);
  format.writeUInt32LE(44_100, 8);
  format.writeUInt16LE(2, 12);
  format.writeUInt16LE(16, 14);
  const data = Buffer.alloc(882, 0x12);
  const formatChunk = riffChunk("fmt ", format);
  const dataChunk = riffChunk("data", data);
  return {
    raw: riffWave([
      formatChunk,
      riffChunk("LIST", Buffer.from("INFOfixture-metadata")),
      dataChunk,
    ]),
    canonical: riffWave([formatChunk, dataChunk]),
    durationMs: 20,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function runPreparer(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  const child = spawn(
    process.execPath,
    [
      PREPARER_PATH,
      "--integrity",
      fixture.integrityPath,
      "--previous-release",
      fixture.previousReleasePath,
      "--previous-build-provenance",
      fixture.previousBuildPath,
      "--voice-dir",
      fixture.voiceDir,
      "--release-id",
      "combined-authorized-voice-test",
      "--authorization-reference",
      "owner-voice-authorization-test",
      "--spoken-review-reference",
      "owner-spoken-review-test",
      "--approved-at",
      "2026-07-23T08:00:00.000Z",
      "--out",
      fixture.out,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return await new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (status) => {
      resolveResult({ status, stdout, stderr });
    });
  });
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "tokenmonster-voice-release-"));
  roots.push(root);
  const combined = join(root, "combined");
  const objects = join(combined, "objects");
  const voiceDir = join(root, "private-voice");
  await Promise.all([
    mkdir(objects, { recursive: true }),
    mkdir(voiceDir, { recursive: true }),
  ]);

  const imageBytes = Buffer.from("fixture-image-object");
  const imageSha256 = sha256(imageBytes);
  const imageObject = {
    path: `objects/${imageSha256}.png`,
    bytes: imageBytes.length,
    sha256: imageSha256,
    width: 1,
    height: 1,
  };
  await writeFile(join(objects, `${imageSha256}.png`), imageBytes);
  const source = {
    inventoryId: "prior-image-inventory",
    inventoryRevision: "1".repeat(64),
    path: "chatgpt.png",
    sha256: "2".repeat(64),
  };
  const imageOutput = {
    path: imageObject.path,
    bytes: imageObject.bytes,
    sha256: imageObject.sha256,
    media: {
      mediaType: "image/png" as const,
      width: 1,
      height: 1,
    },
  };
  const association = {
    kind: "avatar" as const,
    characterId: "chatgpt" as const,
  };
  const generationHistory = {
    tool: { name: "fixture-normalizer", version: "1.0.0" },
    sourceMediaType: "image/png" as const,
    resize: null,
    encoding: { mediaType: "image/png" as const, quality: null },
    metadataStripped: true as const,
  };
  const previousBuild = AssetBuildProvenanceV1Schema.parse({
    schemaVersion: "1",
    createdAt: "2026-07-21T00:00:00.000Z",
    integrityManifestSha256: "3".repeat(64),
    pipeline: {
      repositoryId: "tokenmonster",
      revision: "4".repeat(64),
      scriptPath: "scripts/asset-pipeline/build-manifest.mjs",
    },
    entries: [
      {
        assetId: "asset:chatgpt:avatar",
        association,
        source,
        output: imageOutput,
        generationHistory,
        upstream: {
          repository: {
            repositoryId: "fixture-image-source",
            revision: "5".repeat(40),
          },
          steps: [
            {
              operation: "import",
              receipt: {
                path: "receipts/image.json",
                sha256: "6".repeat(64),
              },
              tool: { name: "fixture-importer", version: "1.0.0" },
              model: null,
              inputs: [],
              outputSha256: source.sha256,
            },
          ],
        },
      },
    ],
  });
  const imageApproval = {
    rights: {
      licenseStatus: "approved" as const,
      grantReferenceId: "prior-image-grant",
      scopes: {
        publicUse: true as const,
        commercialUse: true as const,
        modify: true as const,
        redistribute: true as const,
      },
    },
    review: {
      brandStatus: "approved" as const,
      brandReviewReferenceId: "prior-image-brand-review",
      contentStatus: "approved" as const,
      contentReviewReferenceId: "prior-image-content-review",
      contentRating: "general" as const,
      disclosureId: "tokenmonster-unaffiliated-v1",
    },
    presentation: {
      altText: {
        "zh-TW": "測試角色頭像",
        en: "Test character avatar",
      },
      allowedTransforms: ["scale-down" as const],
    },
    releaseStatus: "approved" as const,
  };
  const priorBuildEntry = previousBuild.entries[0]!;
  const priorPublicAsset = {
    assetId: priorBuildEntry.assetId,
    association: priorBuildEntry.association,
    source: priorBuildEntry.source,
    output: priorBuildEntry.output,
    generationHistory: priorBuildEntry.generationHistory,
  };
  const previousRelease = AssetReleaseManifestV2Schema.parse({
    schemaVersion: "2",
    releaseId: "prior-image-release",
    approvedAt: "2026-07-21T01:00:00.000Z",
    provenance: {
      integrityManifestSha256: previousBuild.integrityManifestSha256,
      buildProvenanceSha256: computeAssetBuildProvenanceV1Sha256(previousBuild),
      pipeline: previousBuild.pipeline,
    },
    assets: [
      {
        ...priorPublicAsset,
        ...imageApproval,
      },
    ],
  });

  const wav = voiceBytes();
  const wavSha256 = sha256(wav.canonical);
  const wavObject = {
    path: `objects/${wavSha256}.wav`,
    bytes: wav.canonical.length,
    sha256: wavSha256,
  };
  await writeFile(join(objects, `${wavSha256}.wav`), wav.canonical);
  const voiceScript: Record<string, Record<string, string>> = {};
  const voice = [];
  for (const characterId of ASSET_CHARACTER_IDS) {
    voiceScript[characterId] = {};
    const lines = [];
    for (const trigger of ASSET_VOICE_TRIGGERS) {
      const wavFilename = `${characterId}__${trigger}.wav`;
      voiceScript[characterId][trigger] =
        `${PRIVATE_SENTINEL}:${characterId}:${trigger}`;
      await writeFile(join(voiceDir, wavFilename), wav.raw);
      await writeJson(join(voiceDir, `${characterId}__${trigger}.json`), {
        workflow: "tokenmonster-voice-v1",
        status: "completed",
        settings: { persona: characterId, qualityGate: true },
        summary: { chunks: 1 },
        chunks: [{ accepted: true, text: PRIVATE_SENTINEL }],
        outputs: [{ kind: "audio", filename: wavFilename }],
      });
      lines.push({
        id: `${characterId}-${trigger}`,
        trigger,
        object: wavObject,
        durationMs: wav.durationMs,
      });
    }
    voice.push({ characterId, lines });
  }
  await writeJson(join(voiceDir, "voice_script_v1.json"), voiceScript);
  const integrity = AssetIntegrityManifestV1Schema.parse({
    schemaVersion: "1",
    generatedAt: "2026-07-23T07:30:00.000Z",
    characters: [{ characterId: "chatgpt", avatar: imageObject, themes: [] }],
    voice,
  });

  const integrityPath = join(combined, "manifest.json");
  const previousReleasePath = join(root, "previous-release.json");
  const previousBuildPath = join(root, "previous-build.json");
  await Promise.all([
    writeJson(integrityPath, integrity),
    writeJson(previousReleasePath, previousRelease),
    writeJson(previousBuildPath, previousBuild),
  ]);
  return {
    root,
    voiceDir,
    integrity,
    integrityPath,
    previousRelease,
    previousReleasePath,
    previousBuild,
    previousBuildPath,
    out: join(root, "out"),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("authorized combined voice release preparation", () => {
  it("preserves approved images and emits only hashed private voice evidence", async () => {
    const fixture = await makeFixture();
    const result = await runPreparer(fixture);
    expect(result, result.stderr).toMatchObject({ status: 0 });

    const provenance = AssetBuildProvenanceV1Schema.parse(
      JSON.parse(
        await readFile(join(fixture.out, "build-provenance-v1.json"), "utf8"),
      ),
    );
    const ledger = AssetRightsLedgerV2Schema.parse(
      JSON.parse(
        await readFile(
          join(fixture.out, "approved-rights-ledger-v2.json"),
          "utf8",
        ),
      ),
    );
    expect(provenance.entries).toHaveLength(56);
    expect(ledger.entries).toHaveLength(56);
    expect(
      provenance.entries.find(
        ({ assetId }) => assetId === "asset:chatgpt:avatar",
      ),
    ).toEqual(fixture.previousBuild.entries[0]);
    expect(provenance.createdAt).toBe(fixture.integrity.generatedAt);
    expect(provenance.pipeline.revision).toBe(
      sha256(await readFile(BUILD_MANIFEST_PATH)),
    );

    const voiceBuild = provenance.entries.find(
      ({ assetId }) =>
        assetId === "asset:chatgpt:voice:chatgpt-greeting:greeting",
    );
    const voiceRights = ledger.entries.find(
      ({ assetId }) =>
        assetId === "asset:chatgpt:voice:chatgpt-greeting:greeting",
    );
    expect(voiceBuild).toMatchObject({
      source: { path: "voice/chatgpt__greeting.wav" },
      generationHistory: {
        sourceMediaType: "audio/wav",
        metadataStripped: true,
      },
      upstream: {
        steps: [
          {
            receipt: { path: "voice/chatgpt__greeting.json" },
            outputSha256: sha256(voiceBytes().raw),
          },
        ],
      },
    });
    expect(voiceRights).toMatchObject({
      rights: { grantReferenceId: "owner-voice-authorization-test" },
      voiceEvidence: {
        sourceType: "owner-authorized-reference-clone",
        consentReferenceId: "owner-voice-authorization-test",
        syntheticProvenanceReferenceId: null,
        spokenContentReviewReferenceId: "owner-spoken-review-test",
      },
    });
    expect(JSON.stringify({ provenance, ledger })).not.toContain(
      PRIVATE_SENTINEL,
    );
    expect(
      assembleAssetReleaseManifestV2({
        integrityManifest: fixture.integrity,
        buildProvenance: provenance,
        rightsLedger: ledger,
      }).assets,
    ).toHaveLength(56);
  });

  it("rejects an unexpected private-directory entry without publishing output", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.voiceDir, "unexpected.txt"), "not approved");
    const result = await runPreparer(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "raw voice directory extra: unexpected.txt",
    );
    await expect(lstat(fixture.out)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
