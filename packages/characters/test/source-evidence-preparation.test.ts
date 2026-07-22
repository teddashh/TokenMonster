import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AssetBuildProvenanceV1Schema,
  AssetSourceEvidenceBundleV1Schema,
} from "../src/index.js";
import {
  runBuildProvenance,
  runPipeline,
  runPrepareSourceEvidence,
  SOLID_COLOR_PNG,
} from "./asset-pipeline-fixture.js";

const SELECTED_SOURCE_PATHS = [
  "outfits_v2_norm/doll_qwen__tech.png",
  "poses/react/doll_qwen__tech__challenged.png",
  "poses/react/doll_qwen__tech__supported.png",
  "poses/react/doll_qwen__tech__victory.png",
  "qwen.png",
] as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function imageObject(label: string) {
  const bytes = Buffer.from(`controlled-output-${label}`);
  const digest = sha256(bytes);
  return {
    path: `objects/${digest}.webp`,
    bytes: bytes.length,
    sha256: digest,
    width: 1,
    height: 1,
  };
}

async function createSourceEvidenceFixture() {
  const root = await mkdtemp(join(tmpdir(), "tokenmonster-source-evidence-"));
  const bank = join(root, "exact-bank");
  const build = join(root, "build");
  await mkdir(join(bank, "outfits_v2_norm"), { recursive: true });
  await mkdir(join(bank, "poses", "react"), { recursive: true });
  await mkdir(build);
  for (const path of SELECTED_SOURCE_PATHS) {
    const source = join(bank, ...path.split("/"));
    await writeFile(source, SOLID_COLOR_PNG, { mode: 0o444 });
    await chmod(source, 0o444);
  }

  const avatar = imageObject("avatar");
  const outfit = imageObject("outfit");
  const supported = imageObject("supported");
  const challenged = imageObject("challenged");
  const victory = imageObject("victory");
  const integrity = {
    schemaVersion: "1",
    generatedAt: "2026-07-21T12:00:00.000Z",
    characters: [
      {
        characterId: "qwen",
        avatar,
        themes: [
          {
            themeId: "tech",
            outfit,
            poses: { supported, challenged, victory },
          },
        ],
      },
    ],
    voice: [],
  };
  const objects = [avatar, outfit, supported, challenged, victory];
  const totalBytes = objects.reduce((total, object) => total + object.bytes, 0);
  const report = {
    schemaVersion: "1",
    builtAt: "2026-07-21T12:00:00.000Z",
    encoder: "webp",
    encoderVersion: "6.1.1",
    warnings: [],
    selection: { personas: ["qwen"], themes: ["tech"], sample: false },
    counts: {
      personasRequested: 1,
      personasEmitted: 1,
      themesRequestedPerPersona: 1,
      avatars: 1,
      outfits: 1,
      poses: 3,
      assetReferences: 5,
      uniqueObjects: 5,
      encoded: 5,
      reused: 0,
      missing: 0,
    },
    totalBytes,
    voice: { characters: 0, lines: 0, bytes: 0 },
    perPersonaBytes: { qwen: totalBytes },
    perPersona: { qwen: { bytes: totalBytes, avatarSource: "root" } },
    missingAssets: [],
  };
  const integrityPath = join(build, "manifest.json");
  await writeFile(
    integrityPath,
    `${JSON.stringify(integrity, null, 2)}\n`,
  );
  await writeFile(
    join(build, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return { root, bank, build, integrity, integrityPath };
}

async function expectMissing(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function sourceSnapshot(bank: string) {
  return await Promise.all(
    SELECTED_SOURCE_PATHS.map(async (path) => {
      const source = join(bank, ...path.split("/"));
      const [bytes, metadata] = await Promise.all([
        readFile(source),
        stat(source),
      ]);
      return {
        path,
        sha256: sha256(bytes),
        mode: metadata.mode & 0o777,
        mtimeMs: metadata.mtimeMs,
      };
    }),
  );
}

describe("controlled source evidence preparation", () => {
  it("feeds the unchanged build-provenance mapping including an outfit-fallback avatar", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokenmonster-source-chain-"));
    const bank = join(root, "exact-bank");
    const out = join(root, "build");
    const receiptRoot = join(root, "private-receipts");
    const evidencePath = join(root, "source-evidence-v1.json");
    const provenancePath = join(root, "build-provenance-v1.json");
    try {
      await mkdir(join(bank, "outfits_v2_norm"), { recursive: true });
      await mkdir(join(bank, "poses", "react"), { recursive: true });
      await writeFile(
        join(bank, "outfits_v2_norm", "doll_qwen__tech.png"),
        SOLID_COLOR_PNG,
      );
      for (const state of ["supported", "challenged", "victory"]) {
        await writeFile(
          join(bank, "poses", "react", `doll_qwen__tech__${state}.png`),
          SOLID_COLOR_PNG,
        );
      }
      const build = await runPipeline(bank, out, "qwen");
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
      const report = JSON.parse(
        await readFile(join(out, "report.json"), "utf8"),
      ) as { encoder: string };
      const prepared = await runPrepareSourceEvidence({
        integrity: join(out, "manifest.json"),
        bank,
        receiptRoot,
        out: evidencePath,
      });
      if (report.encoder !== "webp") {
        expect(prepared.status).not.toBe(0);
        expect(prepared.stderr).toContain("complete WebP build report");
        return;
      }
      expect(prepared.status, `${prepared.stdout}\n${prepared.stderr}`).toBe(0);
      const evidence = AssetSourceEvidenceBundleV1Schema.parse(
        JSON.parse(await readFile(evidencePath, "utf8")) as unknown,
      );
      expect(evidence.entries.map(({ path }) => path)).toEqual([
        "outfits_v2_norm/doll_qwen__tech.png",
        "poses/react/doll_qwen__tech__challenged.png",
        "poses/react/doll_qwen__tech__supported.png",
        "poses/react/doll_qwen__tech__victory.png",
      ]);

      const built = await runBuildProvenance(
        bank,
        join(out, "manifest.json"),
        evidencePath,
        receiptRoot,
        provenancePath,
      );
      expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
      const provenance = AssetBuildProvenanceV1Schema.parse(
        JSON.parse(await readFile(provenancePath, "utf8")) as unknown,
      );
      expect(provenance.entries).toHaveLength(5);
      expect(
        provenance.entries.filter(
          ({ source }) =>
            source.path === "outfits_v2_norm/doll_qwen__tech.png",
        ),
      ).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("derives the exact image set and writes factual private receipts for 40- and 64-hex revisions", async () => {
    const fixture = await createSourceEvidenceFixture();
    try {
      const before = await sourceSnapshot(fixture.bank);
      for (const [index, revision] of ["a".repeat(40), "b".repeat(64)].entries()) {
        const receiptRoot = join(fixture.root, `private-receipts-${index}`);
        const out = join(fixture.root, `source-evidence-${index}.json`);
        const result = await runPrepareSourceEvidence({
          integrity: fixture.integrityPath,
          bank: fixture.bank,
          inventoryId: "controlled-image-inventory",
          repositoryId: "reviewed-source-repository",
          sourceRevision: revision,
          receiptRoot,
          out,
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

        const evidenceBytes = await readFile(out);
        const evidence = AssetSourceEvidenceBundleV1Schema.parse(
          JSON.parse(evidenceBytes.toString("utf8")) as unknown,
        );
        expect(evidence.inventoryId).toBe("controlled-image-inventory");
        expect(evidence.entries.map(({ path }) => path)).toEqual(
          SELECTED_SOURCE_PATHS,
        );
        expect(
          evidence.entries.every(
            (entry) =>
              entry.upstream.repository.repositoryId ===
                "reviewed-source-repository" &&
              entry.upstream.repository.revision === revision &&
              entry.upstream.steps.length === 1 &&
              entry.upstream.steps[0]?.operation === "import" &&
              entry.upstream.steps[0]?.model === null &&
              entry.upstream.steps[0]?.inputs.length === 0 &&
              entry.upstream.steps[0]?.outputSha256 === entry.sha256,
          ),
        ).toBe(true);
        expect(evidenceBytes.toString("utf8")).not.toMatch(
          /(?:prompt|instruction|https?:\/\/|file:\/\/|\/home\/|[A-Z]:\\)/iu,
        );
        expect(evidenceBytes.toString("utf8")).not.toContain(fixture.root);
        expect((await stat(out)).mode & 0o777).toBe(0o600);
        expect((await stat(receiptRoot)).mode & 0o777).toBe(0o700);
        expect((await stat(join(receiptRoot, "receipts"))).mode & 0o777).toBe(
          0o700,
        );

        for (const entry of evidence.entries) {
          const step = entry.upstream.steps[0]!;
          const receiptPath = join(
            receiptRoot,
            ...step.receipt.path.split("/"),
          );
          const receiptBytes = await readFile(receiptPath);
          expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
          expect(sha256(receiptBytes)).toBe(step.receipt.sha256);
          expect(
            JSON.parse(receiptBytes.toString("utf8")) as unknown,
          ).toMatchObject({
            schemaVersion: "1",
            receiptType: "source-import",
            operation: "import",
            inventoryId: "controlled-image-inventory",
            repository: {
              repositoryId: "reviewed-source-repository",
              revision,
            },
            source: { path: entry.path, sha256: entry.sha256 },
          });
          expect(receiptBytes.toString("utf8")).not.toMatch(
            /(?:approved|license|rights|grant)/iu,
          );
        }
      }
      expect(await sourceSnapshot(fixture.bank)).toEqual(before);
      expect(before.every(({ mode }) => mode === 0o444)).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects extra, missing, symlinked, and output-escaping source banks without residue", async () => {
    const fixture = await createSourceEvidenceFixture();
    const runFailure = async (
      suffix: string,
      expectedError: string,
      receiptRoot = join(fixture.root, `receipts-${suffix}`),
    ) => {
      const out = join(fixture.root, `evidence-${suffix}.json`);
      const result = await runPrepareSourceEvidence({
        integrity: fixture.integrityPath,
        bank: fixture.bank,
        receiptRoot,
        out,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(expectedError);
      await expectMissing(out);
      await expectMissing(receiptRoot);
    };
    try {
      const extra = join(fixture.bank, "unselected-source.png");
      await writeFile(extra, SOLID_COLOR_PNG);
      await runFailure("extra", "contains unselected sources");
      await rm(extra);

      const missing = join(
        fixture.bank,
        "poses",
        "react",
        "doll_qwen__tech__victory.png",
      );
      await rm(missing);
      await runFailure("missing", "is missing selected sources");
      await writeFile(missing, SOLID_COLOR_PNG);

      const outfit = join(
        fixture.bank,
        "outfits_v2_norm",
        "doll_qwen__tech.png",
      );
      const outside = join(fixture.root, "outside.png");
      await writeFile(outside, SOLID_COLOR_PNG);
      await rm(outfit);
      await symlink(outside, outfit);
      await runFailure("symlink", "Asset bank symlinks are not allowed");
      await rm(outfit);
      await writeFile(outfit, SOLID_COLOR_PNG);

      await runFailure(
        "escape",
        "must be outside the read-only asset bank",
        join(fixture.bank, "private-receipts"),
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects a same-length report theme selection that differs from the manifest", async () => {
    const fixture = await createSourceEvidenceFixture();
    const receiptRoot = join(fixture.root, "theme-mismatch-receipts");
    const out = join(fixture.root, "theme-mismatch-evidence.json");
    try {
      const reportPath = join(fixture.build, "report.json");
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        selection: { themes: string[] };
      };
      report.selection.themes = ["finance"];
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

      const result = await runPrepareSourceEvidence({
        integrity: fixture.integrityPath,
        bank: fixture.bank,
        receiptRoot,
        out,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "report.json theme selection does not match qwen",
      );
      await expectMissing(out);
      await expectMissing(receiptRoot);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects voice, unsafe authority, and every pre-existing output", async () => {
    const fixture = await createSourceEvidenceFixture();
    try {
      const voiceBytes = Buffer.from("voice-output");
      const voiceSha256 = sha256(voiceBytes);
      const voiceIntegrity = {
        ...structuredClone(fixture.integrity),
        voice: [
          {
            characterId: "qwen",
            lines: [
              {
                id: "qwen-greeting",
                trigger: "greeting",
                object: {
                  path: `objects/${voiceSha256}.wav`,
                  bytes: voiceBytes.length,
                  sha256: voiceSha256,
                },
                durationMs: 100,
              },
            ],
          },
        ],
      };
      const voiceManifest = join(fixture.build, "voice-manifest.json");
      await writeFile(
        voiceManifest,
        `${JSON.stringify(voiceIntegrity, null, 2)}\n`,
      );
      const voiceOut = join(fixture.root, "voice-evidence.json");
      const voiceReceipts = join(fixture.root, "voice-receipts");
      const voice = await runPrepareSourceEvidence({
        integrity: voiceManifest,
        bank: fixture.bank,
        receiptRoot: voiceReceipts,
        out: voiceOut,
      });
      expect(voice.status).not.toBe(0);
      expect(voice.stderr).toContain("rejects voice assets");
      await expectMissing(voiceOut);
      await expectMissing(voiceReceipts);

      const unsafeOut = join(fixture.root, "unsafe-evidence.json");
      const unsafeReceipts = join(fixture.root, "unsafe-receipts");
      const unsafe = await runPrepareSourceEvidence({
        integrity: fixture.integrityPath,
        bank: fixture.bank,
        repositoryId: "https://source.invalid",
        sourceRevision: "A".repeat(40),
        receiptRoot: unsafeReceipts,
        out: unsafeOut,
      });
      expect(unsafe.status).not.toBe(0);
      expect(unsafe.stderr).toMatch(/repository-id|source-revision/u);
      await expectMissing(unsafeOut);
      await expectMissing(unsafeReceipts);

      const existingReceipts = join(fixture.root, "existing-receipts");
      await mkdir(existingReceipts);
      const absentOut = join(fixture.root, "absent-evidence.json");
      const existingRoot = await runPrepareSourceEvidence({
        integrity: fixture.integrityPath,
        bank: fixture.bank,
        receiptRoot: existingReceipts,
        out: absentOut,
      });
      expect(existingRoot.status).not.toBe(0);
      expect(existingRoot.stderr).toContain("--receipt-root already exists");
      await expectMissing(absentOut);

      const existingOut = join(fixture.root, "existing-evidence.json");
      await writeFile(existingOut, "sentinel");
      const freshReceipts = join(fixture.root, "fresh-receipts");
      const existingFile = await runPrepareSourceEvidence({
        integrity: fixture.integrityPath,
        bank: fixture.bank,
        receiptRoot: freshReceipts,
        out: existingOut,
      });
      expect(existingFile.status).not.toBe(0);
      expect(existingFile.stderr).toContain("--out already exists");
      expect(await readFile(existingOut, "utf8")).toBe("sentinel");
      await expectMissing(freshReceipts);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects a report timestamp that is not bound to the integrity manifest", async () => {
    const fixture = await createSourceEvidenceFixture();
    const receiptRoot = join(fixture.root, "timestamp-receipts");
    const out = join(fixture.root, "timestamp-evidence.json");
    try {
      const reportPath = join(fixture.build, "report.json");
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        builtAt: string;
      };
      report.builtAt = "2026-07-21T12:00:01.000Z";
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

      const result = await runPrepareSourceEvidence({
        integrity: fixture.integrityPath,
        bank: fixture.bank,
        receiptRoot,
        out,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "build timestamp does not match manifest.json",
      );
      await expectMissing(out);
      await expectMissing(receiptRoot);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);
});
