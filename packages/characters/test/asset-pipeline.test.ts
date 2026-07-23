import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AssetBuildProvenanceV1Schema,
  AssetRightsLedgerV2Schema,
  AssetSourceEvidenceBundleV1Schema,
  parseAssetManifest,
} from "../src/index.js";
import {
  createPcm16Wav,
  createRiffChunk,
  createWavFromChunks,
  runBuildProvenance,
  runPipeline,
  runPrepareRightsLedger,
  SOLID_COLOR_PNG,
  writeSourceEvidenceFixture,
} from "./asset-pipeline-fixture.js";

async function createPipelineFixture() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "tokenmonster-assets-"));
  const bank = join(fixtureRoot, "bank");
  const out = join(fixtureRoot, "out");
  const voiceDir = join(fixtureRoot, "voice");
  const outfits = join(bank, "outfits_v2_norm");
  await mkdir(outfits, { recursive: true });
  await mkdir(voiceDir);
  await writeFile(join(outfits, "doll_qwen__tech.png"), SOLID_COLOR_PNG);
  return { fixtureRoot, bank, out, voiceDir };
}

function canonicalWavChunks(wav: Buffer) {
  return {
    format: Buffer.from(wav.subarray(12, 36)),
    data: Buffer.from(wav.subarray(36)),
  };
}

function wavChunkIds(wav: Buffer) {
  const ids: string[] = [];
  let offset = 12;
  while (offset < wav.length) {
    ids.push(wav.toString("ascii", offset, offset + 4));
    const chunkSize = wav.readUInt32LE(offset + 4);
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return ids;
}

function wavWithDuplicateChunk(chunkId: "fmt " | "data") {
  const canonical = createPcm16Wav();
  const { format, data } = canonicalWavChunks(canonical);
  return createWavFromChunks(
    chunkId === "fmt "
      ? [format, format, data]
      : [format, data, Buffer.from(data)],
  );
}

function wavWithUnexpectedTrailingBytes() {
  const wav = Buffer.concat([
    createPcm16Wav(),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
  ]);
  wav.writeUInt32LE(wav.length - 8, 4);
  return wav;
}

function wavWithNonZeroPadding() {
  const canonical = createPcm16Wav();
  const { format, data } = canonicalWavChunks(canonical);
  const metadata = createRiffChunk("JUNK", Buffer.from([0x01]));
  metadata[metadata.length - 1] = 0xff;
  return createWavFromChunks([format, metadata, data]);
}

describe("asset pipeline", () => {
  it("builds and validates a content-addressed fallback avatar", async () => {
    const { fixtureRoot, bank, out } = await createPipelineFixture();

    try {
      const build = await runPipeline(bank, out, "qwen");
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      const manifestInput: unknown = JSON.parse(
        await readFile(join(out, "manifest.json"), "utf8"),
      );
      const manifest = parseAssetManifest(manifestInput);
      const report = JSON.parse(
        await readFile(join(out, "report.json"), "utf8"),
      ) as {
        builtAt: string;
        perPersona: { qwen: { avatarSource: string } };
        voice: { characters: number; lines: number; bytes: number };
      };

      expect(manifest.generatedAt).toBe("2023-11-14T22:13:20.000Z");
      expect(report.builtAt).toBe(manifest.generatedAt);
      expect(manifest.characters).toHaveLength(1);
      expect(manifest.voice).toEqual([]);
      expect(manifest.characters[0]!.avatar).toMatchObject({
        width: 1,
        height: 1,
      });
      expect(report.perPersona.qwen.avatarSource).toBe("outfit-fallback");
      expect(report.voice).toEqual({ characters: 0, lines: 0, bytes: 0 });

      const objectFiles = await readdir(join(out, "objects"));
      expect(objectFiles.length).toBeGreaterThan(0);
      for (const filename of objectFiles) {
        const match = /^([0-9a-f]{64})\.(?:webp|png)$/u.exec(filename);
        expect(match).not.toBeNull();
        const bytes = await readFile(join(out, "objects", filename));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          match![1],
        );
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it("emits exact image build provenance and rejects a stale object", async () => {
    const { fixtureRoot, bank, out } = await createPipelineFixture();
    const poses = join(bank, "poses", "react");
    const receiptRoot = join(fixtureRoot, "private-receipts");
    const sourceEvidencePath = join(fixtureRoot, "source-evidence-v1.json");
    const provenancePath = join(fixtureRoot, "build-provenance-v1.json");
    const rightsLedgerPath = join(fixtureRoot, "private-rights-ledger-v2.json");
    const staleProvenancePath = join(
      fixtureRoot,
      "stale-build-provenance-v1.json",
    );
    const partialProvenancePath = join(
      fixtureRoot,
      "partial-build-provenance-v1.json",
    );
    const forgedProvenancePath = join(
      fixtureRoot,
      "forged-build-provenance-v1.json",
    );
    const staleReceiptProvenancePath = join(
      fixtureRoot,
      "stale-receipt-build-provenance-v1.json",
    );
    const staleTimestampProvenancePath = join(
      fixtureRoot,
      "stale-timestamp-build-provenance-v1.json",
    );
    const incompleteEvidencePath = join(
      fixtureRoot,
      "incomplete-source-evidence-v1.json",
    );
    const incompleteEvidenceProvenancePath = join(
      fixtureRoot,
      "incomplete-evidence-build-provenance-v1.json",
    );

    try {
      await mkdir(poses, { recursive: true });
      for (const state of ["supported", "challenged", "victory"]) {
        await writeFile(
          join(poses, `doll_qwen__tech__${state}.png`),
          SOLID_COLOR_PNG,
        );
      }
      const sourceEvidence = await writeSourceEvidenceFixture(
        bank,
        receiptRoot,
        sourceEvidencePath,
      );
      const build = await runPipeline(bank, out, "qwen");
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
      const report = JSON.parse(
        await readFile(join(out, "report.json"), "utf8"),
      ) as { encoder: string; encoderVersion: string | null };
      const provenance = await runBuildProvenance(
        bank,
        join(out, "manifest.json"),
        sourceEvidencePath,
        receiptRoot,
        provenancePath,
      );

      if (report.encoder !== "webp") {
        expect(provenance.status).not.toBe(0);
        expect(provenance.stderr).toContain(
          "complete metadata-stripped WebP report",
        );
        await expect(readFile(provenancePath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        return;
      }

      expect(report.encoderVersion).toMatch(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u);
      expect(
        provenance.status,
        `${provenance.stdout}\n${provenance.stderr}`,
      ).toBe(0);
      const parsed = AssetBuildProvenanceV1Schema.parse(
        JSON.parse(await readFile(provenancePath, "utf8")) as unknown,
      );
      expect(parsed.entries).toHaveLength(5);
      expect(
        new Set(parsed.entries.map(({ source }) => source.inventoryRevision))
          .size,
      ).toBe(1);
      expect(
        parsed.entries.every(
          ({ generationHistory }) => generationHistory.metadataStripped,
        ),
      ).toBe(true);
      expect(
        parsed.entries.every(
          ({ source, upstream }) =>
            upstream.repository.repositoryId === "test-source-repository" &&
            upstream.steps.at(-1)?.outputSha256 === source.sha256,
        ),
      ).toBe(true);
      expect(JSON.stringify(parsed)).not.toMatch(
        /(?:prompt|\/home\/|[A-Z]:\\)/u,
      );

      const reportPath = join(out, "report.json");
      const originalReportBytes = await readFile(reportPath);
      const staleTimestampReport = JSON.parse(
        originalReportBytes.toString("utf8"),
      ) as { builtAt: string };
      staleTimestampReport.builtAt = "2026-07-21T12:00:01.000Z";
      await writeFile(
        reportPath,
        `${JSON.stringify(staleTimestampReport, null, 2)}\n`,
      );
      const staleTimestamp = await runBuildProvenance(
        bank,
        join(out, "manifest.json"),
        sourceEvidencePath,
        receiptRoot,
        staleTimestampProvenancePath,
      );
      expect(staleTimestamp.status).not.toBe(0);
      expect(staleTimestamp.stderr).toContain(
        "build timestamp does not match manifest.json",
      );
      await expect(readFile(staleTimestampProvenancePath)).rejects.toMatchObject(
        { code: "ENOENT" },
      );
      await writeFile(reportPath, originalReportBytes);

      const unsafeEvidence = structuredClone(sourceEvidence) as unknown as {
        entries: Array<{
          upstream: { steps: Array<Record<string, unknown>> };
        }>;
      };
      unsafeEvidence.entries[0]!.upstream.steps[0]!["prompt"] =
        "must stay private";
      expect(
        AssetSourceEvidenceBundleV1Schema.safeParse(unsafeEvidence).success,
      ).toBe(false);
      delete unsafeEvidence.entries[0]!.upstream.steps[0]!["prompt"];
      unsafeEvidence.entries[0]!.upstream.steps[0]!["receipt"] = {
        path: "/private/receipt.json",
        sha256: "a".repeat(64),
      };
      expect(
        AssetSourceEvidenceBundleV1Schema.safeParse(unsafeEvidence).success,
      ).toBe(false);

      const brokenChain = structuredClone(sourceEvidence) as unknown as {
        entries: Array<{
          sha256: string;
          upstream: { steps: Array<Record<string, unknown>> };
        }>;
      };
      const finalStep = brokenChain.entries[0]!.upstream.steps[0]!;
      brokenChain.entries[0]!.upstream.steps = [
        { ...finalStep, outputSha256: "a".repeat(64) },
        {
          ...finalStep,
          inputs: ["b".repeat(64)],
          outputSha256: brokenChain.entries[0]!.sha256,
        },
      ];
      expect(
        AssetSourceEvidenceBundleV1Schema.safeParse(brokenChain).success,
      ).toBe(false);

      const incompleteEvidence = structuredClone(sourceEvidence);
      incompleteEvidence.entries.pop();
      await writeFile(
        incompleteEvidencePath,
        `${JSON.stringify(incompleteEvidence, null, 2)}\n`,
      );
      const incomplete = await runBuildProvenance(
        bank,
        join(out, "manifest.json"),
        incompleteEvidencePath,
        receiptRoot,
        incompleteEvidenceProvenancePath,
      );
      expect(incomplete.status).not.toBe(0);
      expect(incomplete.stderr).toContain("source evidence missing for");
      await expect(
        readFile(incompleteEvidenceProvenancePath),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const preparedLedger = await runPrepareRightsLedger(
        provenancePath,
        rightsLedgerPath,
      );
      expect(
        preparedLedger.status,
        `${preparedLedger.stdout}\n${preparedLedger.stderr}`,
      ).toBe(0);
      const ledger = AssetRightsLedgerV2Schema.parse(
        JSON.parse(await readFile(rightsLedgerPath, "utf8")) as unknown,
      );
      expect(ledger.release.approvedAt).toBeNull();
      expect(ledger.entries).toHaveLength(parsed.entries.length);
      expect(
        ledger.entries.every(
          (entry) =>
            entry.rights.licenseStatus === "pending" &&
            entry.review.brandStatus === "pending" &&
            entry.review.contentStatus === "pending" &&
            entry.releaseStatus === "pending",
        ),
      ).toBe(true);

      const firstReceiptPath =
        sourceEvidence.entries[0]!.upstream.steps[0]!.receipt.path;
      const firstReceipt = join(receiptRoot, ...firstReceiptPath.split("/"));
      const originalReceipt = await readFile(firstReceipt);
      await writeFile(firstReceipt, `${originalReceipt.toString("utf8")} `);
      const staleReceipt = await runBuildProvenance(
        bank,
        join(out, "manifest.json"),
        sourceEvidencePath,
        receiptRoot,
        staleReceiptProvenancePath,
      );
      expect(staleReceipt.status).not.toBe(0);
      expect(staleReceipt.stderr).toContain("receipt digest does not match");
      await expect(readFile(staleReceiptProvenancePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await writeFile(firstReceipt, originalReceipt);

      const manifest = parseAssetManifest(
        JSON.parse(
          await readFile(join(out, "manifest.json"), "utf8"),
        ) as unknown,
      );

      const partialManifest = structuredClone(manifest) as unknown as {
        characters: Array<{
          themes: Array<{ poses: { victory?: unknown } }>;
        }>;
      };
      delete partialManifest.characters[0]!.themes[0]!.poses.victory;
      const partialManifestPath = join(out, "partial-manifest.json");
      await writeFile(
        partialManifestPath,
        `${JSON.stringify(partialManifest, null, 2)}\n`,
      );
      const partial = await runBuildProvenance(
        bank,
        partialManifestPath,
        sourceEvidencePath,
        receiptRoot,
        partialProvenancePath,
      );
      expect(partial.status).not.toBe(0);
      expect(partial.stderr).toContain(
        "Controlled asset pipeline rebuild does not match the integrity manifest",
      );
      await expect(readFile(partialProvenancePath)).rejects.toMatchObject({
        code: "ENOENT",
      });

      const forgedBytes = Buffer.from("this is not a WebP image", "utf8");
      const forgedHash = createHash("sha256").update(forgedBytes).digest("hex");
      await writeFile(join(out, "objects", `${forgedHash}.webp`), forgedBytes);
      const forgedManifest = structuredClone(manifest) as unknown as {
        characters: Array<{
          avatar: { path: string; bytes: number; sha256: string };
        }>;
      };
      Object.assign(forgedManifest.characters[0]!.avatar, {
        path: `objects/${forgedHash}.webp`,
        bytes: forgedBytes.length,
        sha256: forgedHash,
      });
      const forgedManifestPath = join(out, "forged-manifest.json");
      await writeFile(
        forgedManifestPath,
        `${JSON.stringify(forgedManifest, null, 2)}\n`,
      );
      const forged = await runBuildProvenance(
        bank,
        forgedManifestPath,
        sourceEvidencePath,
        receiptRoot,
        forgedProvenancePath,
      );
      expect(forged.status).not.toBe(0);
      expect(forged.stderr).toContain(
        "Controlled asset pipeline rebuild does not match the integrity manifest",
      );
      await expect(readFile(forgedProvenancePath)).rejects.toMatchObject({
        code: "ENOENT",
      });

      await writeFile(
        join(out, manifest.characters[0]!.avatar.path),
        "stale-object",
      );
      const stale = await runBuildProvenance(
        bank,
        join(out, "manifest.json"),
        sourceEvidencePath,
        receiptRoot,
        staleProvenancePath,
      );
      expect(stale.status).not.toBe(0);
      expect(stale.stderr).toContain("integrity object bytes do not match");
      await expect(readFile(staleProvenancePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it("strips WAV metadata while preserving samples and deterministic content addressing", async () => {
    const { fixtureRoot, bank, out, voiceDir } = await createPipelineFixture();
    const repeatedOut = join(fixtureRoot, "out-repeated");
    const sampleValues = Array.from(
      { length: 441 },
      (_, index) => ((index * 1_013) % 65_536) - 32_768,
    );
    const canonicalWav = createPcm16Wav({
      frameCount: sampleValues.length,
      sampleValues,
    });
    const { format, data } = canonicalWavChunks(canonicalWav);
    const sourceWav = createWavFromChunks([
      createRiffChunk("JUNK", Buffer.from([0x01, 0x02, 0x03])),
      format,
      createRiffChunk("LIST", Buffer.from("INFOISFTfixture-encoder", "ascii")),
      data,
      createRiffChunk("JUNK", Buffer.from([0x04, 0x05])),
      createRiffChunk("bext", Buffer.from("trailing metadata", "ascii")),
    ]);

    try {
      await writeFile(join(voiceDir, "chatgpt__active.wav"), sourceWav);
      await writeFile(join(voiceDir, "qwen__error.wav"), sourceWav);
      await writeFile(join(voiceDir, "openai__greeting.wav"), sourceWav);
      const build = await runPipeline(bank, out, "qwen", { voiceDir });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
      const repeatedBuild = await runPipeline(bank, repeatedOut, "qwen", {
        voiceDir,
      });
      expect(
        repeatedBuild.status,
        `${repeatedBuild.stdout}\n${repeatedBuild.stderr}`,
      ).toBe(0);

      const manifestInput: unknown = JSON.parse(
        await readFile(join(out, "manifest.json"), "utf8"),
      );
      const manifest = parseAssetManifest(manifestInput);
      const wavSha256 = createHash("sha256")
        .update(canonicalWav)
        .digest("hex");
      expect(manifest.voice).toEqual([
        {
          characterId: "chatgpt",
          lines: [
            {
              id: "chatgpt-greeting",
              trigger: "greeting",
              object: {
                path: `objects/${wavSha256}.wav`,
                bytes: canonicalWav.length,
                sha256: wavSha256,
              },
              durationMs: 20,
            },
            {
              id: "chatgpt-active",
              trigger: "active",
              object: {
                path: `objects/${wavSha256}.wav`,
                bytes: canonicalWav.length,
                sha256: wavSha256,
              },
              durationMs: 20,
            },
          ],
        },
        {
          characterId: "qwen",
          lines: [
            {
              id: "qwen-error",
              trigger: "error",
              object: {
                path: `objects/${wavSha256}.wav`,
                bytes: canonicalWav.length,
                sha256: wavSha256,
              },
              durationMs: 20,
            },
          ],
        },
      ]);
      const outputWav = await readFile(
        join(out, "objects", `${wavSha256}.wav`),
      );
      expect(outputWav).toEqual(canonicalWav);
      expect(outputWav.subarray(44)).toEqual(canonicalWav.subarray(44));
      expect(wavChunkIds(sourceWav)).toEqual([
        "JUNK",
        "fmt ",
        "LIST",
        "data",
        "JUNK",
        "bext",
      ]);
      expect(wavChunkIds(outputWav)).toEqual(["fmt ", "data"]);
      expect(sourceWav.length).toBeGreaterThan(outputWav.length);

      const repeatedManifest = await readFile(
        join(repeatedOut, "manifest.json"),
      );
      expect(repeatedManifest).toEqual(await readFile(join(out, "manifest.json")));
      expect(
        await readFile(
          join(repeatedOut, "objects", `${wavSha256}.wav`),
        ),
      ).toEqual(outputWav);

      const report = JSON.parse(
        await readFile(join(out, "report.json"), "utf8"),
      ) as { voice: { characters: number; lines: number; bytes: number } };
      expect(report.voice).toEqual({
        characters: 2,
        lines: 3,
        bytes: canonicalWav.length * 3,
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it("stages GLM image and voice objects when approved sources are present", async () => {
    const { fixtureRoot, bank, out, voiceDir } = await createPipelineFixture();
    const wav = createPcm16Wav();

    try {
      await writeFile(
        join(bank, "outfits_v2_norm", "doll_glm__tech.png"),
        SOLID_COLOR_PNG,
      );
      await writeFile(join(voiceDir, "glm__greeting.wav"), wav);
      const build = await runPipeline(bank, out, "glm", { voiceDir });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      const manifest = parseAssetManifest(
        JSON.parse(
          await readFile(join(out, "manifest.json"), "utf8"),
        ) as unknown,
      );
      expect(manifest.characters.map(({ characterId }) => characterId)).toEqual(
        ["glm"],
      );
      expect(manifest.voice).toMatchObject([
        {
          characterId: "glm",
          lines: [{ id: "glm-greeting", trigger: "greeting" }],
        },
      ]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it("accepts canonical starter prefixes while retaining legacy aliases", async () => {
    const { fixtureRoot, bank, out, voiceDir } = await createPipelineFixture();
    const wav = createPcm16Wav();

    try {
      await writeFile(join(voiceDir, "chatgpt__greeting.wav"), wav);
      await writeFile(join(voiceDir, "claude__unlock.wav"), wav);
      await writeFile(join(voiceDir, "gemini__quiet.wav"), wav);
      await writeFile(join(voiceDir, "grok__active.wav"), wav);
      await writeFile(join(voiceDir, "xai__error.wav"), wav);
      const build = await runPipeline(bank, out, "qwen", { voiceDir });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      const manifest = parseAssetManifest(
        JSON.parse(
          await readFile(join(out, "manifest.json"), "utf8"),
        ) as unknown,
      );
      expect(
        manifest.voice.map(({ characterId, lines }) => ({
          characterId,
          triggers: lines.map(({ trigger }) => trigger),
        })),
      ).toEqual([
        { characterId: "chatgpt", triggers: ["greeting"] },
        { characterId: "claude", triggers: ["unlock"] },
        { characterId: "gemini", triggers: ["quiet"] },
        { characterId: "grok", triggers: ["active", "error"] },
      ]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it("rejects alias collisions after mapping to a canonical character", async () => {
    const { fixtureRoot, bank, out, voiceDir } = await createPipelineFixture();
    const wav = createPcm16Wav();

    try {
      await writeFile(join(voiceDir, "chatgpt__greeting.wav"), wav);
      await writeFile(join(voiceDir, "openai__greeting.wav"), wav);
      const build = await runPipeline(bank, out, "qwen", { voiceDir });
      expect(build.status).not.toBe(0);
      expect(build.stderr).toContain(
        "Duplicate voice clip for chatgpt/greeting",
      );
      await expect(readFile(join(out, "manifest.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it.each([
    {
      label: "the wrong sample rate",
      filename: "openai__greeting.wav",
      wav: createPcm16Wav({ sampleRate: 44_100 }),
    },
    {
      label: "stereo audio",
      filename: "openai__greeting.wav",
      wav: createPcm16Wav({ channels: 2 }),
    },
    {
      label: "an oversized clip",
      filename: "openai__greeting.wav",
      wav: createPcm16Wav({ frameCount: 200_000 }),
    },
    {
      label: "an overlong clip",
      filename: "openai__greeting.wav",
      wav: createPcm16Wav({ frameCount: 132_323 }),
    },
    {
      label: "duplicate fmt chunks",
      filename: "openai__greeting.wav",
      wav: wavWithDuplicateChunk("fmt "),
    },
    {
      label: "duplicate data chunks",
      filename: "openai__greeting.wav",
      wav: wavWithDuplicateChunk("data"),
    },
    {
      label: "unexpected trailing bytes",
      filename: "openai__greeting.wav",
      wav: wavWithUnexpectedTrailingBytes(),
    },
    {
      label: "non-zero RIFF padding",
      filename: "openai__greeting.wav",
      wav: wavWithNonZeroPadding(),
    },
    {
      label: "a bad filename",
      filename: "openai-greeting.wav",
      wav: createPcm16Wav(),
    },
  ])(
    "rejects $label without writing a manifest",
    async ({ filename, wav }) => {
      const { fixtureRoot, bank, out, voiceDir } =
        await createPipelineFixture();

      try {
        await writeFile(join(voiceDir, filename), wav);
        const build = await runPipeline(bank, out, "qwen", { voiceDir });
        expect(build.status).not.toBe(0);
        await expect(
          readFile(join(out, "manifest.json")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
