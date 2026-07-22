import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AssetBuildProvenanceV1Schema,
  AssetRightsLedgerV2Schema,
  assetIdForAssociation,
  computeAssetBuildProvenanceV1Sha256,
  type AssetAssociation,
} from "../src/index.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const APPROVER_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "asset-pipeline",
  "approve-rights-ledger.mjs",
);
const OWNER_STATEMENT =
  "I am the owner or an authorized rights holder for every image asset bound by this receipt. I grant TokenMonster public use, commercial use, modification, and redistribution rights for only that bound release and provenance hash, and I approve its general-audience brand, content, disclosure, allowed-transform, and deterministic bilingual-alt-text records.";

type RunResult = Readonly<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

async function runApprover(options: {
  pendingLedger: string;
  buildProvenance: string;
  grantReceipt: string;
  out: string;
}): Promise<RunResult> {
  const child = spawn(
    process.execPath,
    [
      APPROVER_PATH,
      "--pending-ledger",
      options.pendingLedger,
      "--build-provenance",
      options.buildProvenance,
      "--grant-receipt",
      options.grantReceipt,
      "--out",
      options.out,
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
  return await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolveResult({ status, signal, stdout, stderr });
    });
  });
}

function outputForAssociation(association: AssetAssociation, index: number) {
  const sha256 = String.fromCharCode("a".charCodeAt(0) + index).repeat(64);
  if (association.kind === "voice") {
    return {
      path: `objects/${sha256}.wav`,
      bytes: 8_192,
      sha256,
      media: { mediaType: "audio/wav" as const, durationMs: 1_200 },
    };
  }
  return {
    path: `objects/${sha256}.webp`,
    bytes: 1_024 + index,
    sha256,
    media: {
      mediaType: "image/webp" as const,
      width: association.kind === "avatar" ? 256 : 512,
      height: association.kind === "avatar" ? 256 : 840,
    },
  };
}

function createFixture(includeVoice = false) {
  const associations = [
    { kind: "avatar", characterId: "qwen" },
    { kind: "outfit", characterId: "qwen", themeId: "tech" },
    {
      kind: "pose",
      characterId: "qwen",
      themeId: "tech",
      state: "supported",
    },
    ...(includeVoice
      ? ([
          {
            kind: "voice",
            characterId: "qwen",
            lineId: "qwen-greeting",
            trigger: "greeting",
          },
        ] satisfies AssetAssociation[])
      : []),
  ] satisfies AssetAssociation[];
  const entries = associations.map((association, index) => {
    const output = outputForAssociation(association, index);
    const sourceSha256 = String(index + 1).repeat(64);
    const isVoice = association.kind === "voice";
    return {
      assetId: assetIdForAssociation(association),
      association,
      source: {
        inventoryId: "controlled-image-inventory",
        inventoryRevision: "9".repeat(64),
        path: isVoice
          ? "voice/qwen-greeting.wav"
          : `tachie/qwen/${association.kind}.png`,
        sha256: sourceSha256,
      },
      upstream: {
        repository: {
          repositoryId: "reviewed-source-repository",
          revision: "d".repeat(40),
        },
        steps: [
          {
            operation: "import" as const,
            receipt: {
              path: `receipts/source-${String(index).padStart(4, "0")}.json`,
              sha256: "e".repeat(64),
            },
            tool: { name: "fixture-importer", version: "1.0.0" },
            model: null,
            inputs: [],
            outputSha256: sourceSha256,
          },
        ],
      },
      output,
      generationHistory: {
        tool: { name: "ffmpeg", version: "7.1.1" },
        sourceMediaType: isVoice ? ("audio/wav" as const) : ("image/png" as const),
        resize:
          output.media.mediaType === "audio/wav"
            ? null
            : {
                width: output.media.width,
                height: output.media.height,
                algorithm: "lanczos" as const,
              },
        encoding: {
          mediaType: output.media.mediaType,
          quality: output.media.mediaType === "image/webp" ? 82 : null,
        },
        metadataStripped: true as const,
      },
    };
  });
  const provenance = AssetBuildProvenanceV1Schema.parse({
    schemaVersion: "1",
    createdAt: "2026-07-21T12:00:00.000Z",
    integrityManifestSha256: "f".repeat(64),
    pipeline: {
      repositoryId: "tokenmonster",
      revision: "c".repeat(40),
      scriptPath: "scripts/asset-pipeline/build-manifest.mjs",
    },
    entries,
  });
  const provenanceSha256 = computeAssetBuildProvenanceV1Sha256(provenance);
  const pendingLedger = AssetRightsLedgerV2Schema.parse({
    schemaVersion: "2",
    release: {
      releaseId: "characters-controlled-test",
      approvedAt: null,
      expectedBuildProvenanceSha256: provenanceSha256,
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
  const receipt = {
    schemaVersion: "1",
    receiptType: "tokenmonster-image-rights-grant",
    ownerStatement: OWNER_STATEMENT,
    release: {
      releaseId: pendingLedger.release.releaseId,
      approvedAt: "2026-07-21T13:00:00.000Z",
      expectedBuildProvenanceSha256: provenanceSha256,
    },
    references: {
      grantReferenceId: "owner-image-grant-v1",
      brandReviewReferenceId: "brand-review-general-v1",
      contentReviewReferenceId: "content-review-general-v1",
      disclosureId: "tokenmonster-unaffiliated-v1",
    },
    rights: {
      licenseStatus: "approved",
      scopes: {
        publicUse: true,
        commercialUse: true,
        modify: true,
        redistribute: true,
      },
    },
    review: {
      brandStatus: "approved",
      contentStatus: "approved",
      contentRating: "general",
    },
    presentation: {
      allowedTransforms: ["scale-down"],
      bilingualAltTextPolicy: {
        mode: "deterministic-tokenmonster-catalog-v1",
        locales: ["zh-TW", "en"],
        associationKinds: ["avatar", "outfit", "pose"],
        privateReceiptContentUsed: false,
      },
    },
  };
  return { provenance, pendingLedger, receipt };
}

async function writeJson(path: string, value: unknown, mode?: number) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
  if (mode !== undefined) await chmod(path, mode);
}

async function writeInputs(root: string, fixture = createFixture()) {
  const pendingLedger = join(root, "pending-rights-ledger-v2.json");
  const buildProvenance = join(root, "build-provenance-v1.json");
  const grantReceipt = join(root, "owner-grant-receipt-v1.json");
  await Promise.all([
    writeJson(pendingLedger, fixture.pendingLedger),
    writeJson(buildProvenance, fixture.provenance),
    writeJson(grantReceipt, fixture.receipt, 0o600),
  ]);
  return { pendingLedger, buildProvenance, grantReceipt };
}

async function expectMissing(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("controlled image rights-ledger approval", () => {
  it("derives deterministic catalog-only bilingual alt text and emits a schema-valid approved ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokenmonster-rights-approval-"));
    try {
      const fixture = createFixture();
      const inputs = await writeInputs(root, fixture);
      const pendingBefore = await readFile(inputs.pendingLedger);
      const firstOut = join(root, "approved-rights-ledger-v2-a.json");
      const first = await runApprover({ ...inputs, out: firstOut });
      expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);

      const firstBytes = await readFile(firstOut);
      const approved = AssetRightsLedgerV2Schema.parse(
        JSON.parse(firstBytes.toString("utf8")) as unknown,
      );
      expect(approved.release).toEqual({
        releaseId: fixture.receipt.release.releaseId,
        approvedAt: fixture.receipt.release.approvedAt,
        expectedBuildProvenanceSha256:
          fixture.receipt.release.expectedBuildProvenanceSha256,
      });
      expect(
        approved.entries.map(({ presentation }) => presentation.altText),
      ).toEqual([
        { "zh-TW": "Qwen 的角色頭像", en: "Qwen character avatar" },
        {
          "zh-TW": "Qwen 的科技主題服裝",
          en: "Qwen wearing the tech theme outfit",
        },
        {
          "zh-TW": "Qwen 穿著科技主題服裝，呈現支持姿勢",
          en: "Qwen wearing the tech theme outfit in a supported pose",
        },
      ]);
      expect(
        approved.entries.every(
          (entry) =>
            entry.rights.licenseStatus === "approved" &&
            entry.rights.grantReferenceId === "owner-image-grant-v1" &&
            Object.values(entry.rights.scopes).every((scope) => scope) &&
            entry.review.brandStatus === "approved" &&
            entry.review.contentStatus === "approved" &&
            entry.review.contentRating === "general" &&
            entry.releaseStatus === "approved" &&
            JSON.stringify(entry.presentation.allowedTransforms) ===
              JSON.stringify(["scale-down"]),
        ),
      ).toBe(true);
      expect(firstBytes.toString("utf8")).not.toContain(OWNER_STATEMENT);
      expect(firstBytes.toString("utf8")).not.toContain(
        "bilingualAltTextPolicy",
      );
      expect((await lstat(firstOut)).mode & 0o777).toBe(0o600);
      expect(await readFile(inputs.pendingLedger)).toEqual(pendingBefore);

      const secondOut = join(root, "approved-rights-ledger-v2-b.json");
      const second = await runApprover({ ...inputs, out: secondOut });
      expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
      expect(await readFile(secondOut)).toEqual(firstBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects unsafe statements, IDs, partial scopes, transforms, and alt-text policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokenmonster-rights-receipt-"));
    try {
      const fixture = createFixture();
      const pendingLedger = join(root, "pending.json");
      const buildProvenance = join(root, "provenance.json");
      await Promise.all([
        writeJson(pendingLedger, fixture.pendingLedger),
        writeJson(buildProvenance, fixture.provenance),
      ]);
      const cases = [
        {
          name: "unsafe-statement",
          expected: "ownerStatement",
          mutate: (receipt: typeof fixture.receipt) => {
            receipt.ownerStatement = `${receipt.ownerStatement} extra`;
          },
        },
        {
          name: "unsafe-id",
          expected: "reference IDs",
          mutate: (receipt: typeof fixture.receipt) => {
            receipt.references.grantReferenceId = "https://private.invalid/grant";
          },
        },
        {
          name: "partial-scope",
          expected: "rights scope",
          mutate: (receipt: typeof fixture.receipt) => {
            receipt.rights.scopes.commercialUse = false;
          },
        },
        {
          name: "extra-transform",
          expected: "transform and bilingual-alt-text policy",
          mutate: (receipt: typeof fixture.receipt) => {
            receipt.presentation.allowedTransforms.push("crop-safe-area");
          },
        },
        {
          name: "private-alt-source",
          expected: "transform and bilingual-alt-text policy",
          mutate: (receipt: typeof fixture.receipt) => {
            receipt.presentation.bilingualAltTextPolicy.privateReceiptContentUsed =
              true;
          },
        },
      ];
      for (const testCase of cases) {
        const receipt = structuredClone(fixture.receipt);
        testCase.mutate(receipt);
        const grantReceipt = join(root, `${testCase.name}-receipt.json`);
        const out = join(root, `${testCase.name}-out.json`);
        await writeJson(grantReceipt, receipt, 0o600);
        const result = await runApprover({
          pendingLedger,
          buildProvenance,
          grantReceipt,
          out,
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(testCase.expected);
        await expectMissing(out);
      }

      const privateReceipt = join(root, "private-receipt.json");
      const linkedReceipt = join(root, "linked-receipt.json");
      await writeJson(privateReceipt, fixture.receipt, 0o600);
      await symlink(privateReceipt, linkedReceipt);
      const linkedOut = join(root, "linked-out.json");
      const linked = await runApprover({
        pendingLedger,
        buildProvenance,
        grantReceipt: linkedReceipt,
        out: linkedOut,
      });
      expect(linked.status).not.toBe(0);
      expect(linked.stderr).toContain("regular, non-symlink file");
      await expectMissing(linkedOut);

      const publicReceipt = join(root, "public-receipt.json");
      await writeJson(publicReceipt, fixture.receipt, 0o644);
      const publicOut = join(root, "public-out.json");
      const publicResult = await runApprover({
        pendingLedger,
        buildProvenance,
        grantReceipt: publicReceipt,
        out: publicOut,
      });
      expect(publicResult.status).not.toBe(0);
      expect(publicResult.stderr).toContain("owner-private mode 0600");
      await expectMissing(publicOut);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects mismatched bindings, stale or edited ledgers, and existing output", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokenmonster-rights-binding-"));
    try {
      const fixture = createFixture();
      const runCase = async (
        name: string,
        pendingValue: unknown,
        receiptValue: unknown,
        expected: string,
      ) => {
        const pendingLedger = join(root, `${name}-pending.json`);
        const buildProvenance = join(root, `${name}-provenance.json`);
        const grantReceipt = join(root, `${name}-receipt.json`);
        const out = join(root, `${name}-out.json`);
        await Promise.all([
          writeJson(pendingLedger, pendingValue),
          writeJson(buildProvenance, fixture.provenance),
          writeJson(grantReceipt, receiptValue, 0o600),
        ]);
        const result = await runApprover({
          pendingLedger,
          buildProvenance,
          grantReceipt,
          out,
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(expected);
        await expectMissing(out);
      };

      const wrongRelease = structuredClone(fixture.receipt);
      wrongRelease.release.releaseId = "characters-other-release";
      await runCase(
        "wrong-release",
        fixture.pendingLedger,
        wrongRelease,
        "binding do not match",
      );

      const wrongHash = structuredClone(fixture.receipt);
      wrongHash.release.expectedBuildProvenanceSha256 = "0".repeat(64);
      await runCase(
        "wrong-hash",
        fixture.pendingLedger,
        wrongHash,
        "binding do not match",
      );

      const earlyApproval = structuredClone(fixture.receipt);
      earlyApproval.release.approvedAt = "2026-07-21T11:59:59.999Z";
      await runCase(
        "early-approval",
        fixture.pendingLedger,
        earlyApproval,
        "approvedAt must not predate build provenance creation",
      );

      const staleLedger = structuredClone(fixture.pendingLedger);
      staleLedger.entries[0]!.expectedOutputSha256 = "0".repeat(64);
      await runCase(
        "stale-ledger",
        staleLedger,
        fixture.receipt,
        "stale or does not exactly match",
      );

      const editedLedger = structuredClone(fixture.pendingLedger);
      editedLedger.entries[0]!.rights.scopes.publicUse = true;
      await runCase(
        "edited-ledger",
        editedLedger,
        fixture.receipt,
        "exact all-pending",
      );

      const inputs = await writeInputs(root, fixture);
      const existingOut = join(root, "existing-out.json");
      await writeFile(existingOut, "sentinel\n");
      const existing = await runApprover({ ...inputs, out: existingOut });
      expect(existing.status).not.toBe(0);
      expect(existing.stderr).toContain("--out already exists");
      expect(await readFile(existingOut, "utf8")).toBe("sentinel\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects a fully schema-valid pending ledger when any provenance row is voice", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokenmonster-rights-voice-"));
    try {
      const inputs = await writeInputs(root, createFixture(true));
      const out = join(root, "voice-out.json");
      const result = await runApprover({ ...inputs, out });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("image-only and rejects every voice entry");
      await expectMissing(out);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
