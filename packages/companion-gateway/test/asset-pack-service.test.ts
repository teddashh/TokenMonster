import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AssetReleaseManifestV2Schema,
  computeAssetReleaseManifestV2Sha256,
  type ApprovedAssetPackConfiguration,
  type AssetManifest,
} from "@tokenmonster/characters";
import { recoverFixedAssetPackCache } from "@tokenmonster/characters/asset-pack";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ASSET_PACK_CONSENT_FILE,
  createAssetPackService,
} from "../src/asset-pack-service.js";

const temporaryDirectories: string[] = [];
const CRASHED_OWNER_ID = "30000000-0000-4000-8000-000000000003";
const BASE_MANIFEST: AssetManifest = Object.freeze({
  schemaVersion: "1",
  generatedAt: "2026-07-18T11:00:00.000Z",
  characters: [],
  voice: [],
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function releaseAsset(
  kind: "avatar" | "outfit",
  hash: string,
  sourceHash: string,
) {
  return {
    assetId:
      kind === "avatar"
        ? "asset:glm:avatar"
        : "asset:glm:theme:tech:outfit",
    association:
      kind === "avatar"
        ? ({ kind, characterId: "glm" } as const)
        : ({ kind, characterId: "glm", themeId: "tech" } as const),
    source: {
      inventoryId: "asset-pack-service-test",
      inventoryRevision: "8".repeat(64),
      path: `fixtures/${kind}.png`,
      sha256: sourceHash,
    },
    output: {
      path: `objects/${hash}.png`,
      bytes: 16,
      sha256: hash,
      media: { mediaType: "image/png" as const, width: 32, height: 32 },
    },
    generationHistory: {
      tool: { name: "fixture-renderer", version: "1.0.0" },
      sourceMediaType: "image/png" as const,
      resize: { width: 32, height: 32, algorithm: "nearest" as const },
      encoding: { mediaType: "image/png" as const, quality: null },
      metadataStripped: true as const,
    },
    rights: {
      licenseStatus: "approved" as const,
      grantReferenceId: "grant-asset-pack-service-test",
      scopes: {
        publicUse: true as const,
        commercialUse: true as const,
        modify: true as const,
        redistribute: true as const,
      },
    },
    review: {
      brandStatus: "approved" as const,
      brandReviewReferenceId: "brand-asset-pack-service-test",
      contentStatus: "approved" as const,
      contentReviewReferenceId: "content-asset-pack-service-test",
      contentRating: "general" as const,
      disclosureId: "tokenmonster-unaffiliated-v1",
    },
    presentation: {
      altText: { "zh-TW": "GLM 測試角色圖", en: "GLM test character art" },
      allowedTransforms: ["scale-down" as const],
    },
    releaseStatus: "approved" as const,
  };
}

function approvedConfiguration(
  avatarHash = "d".repeat(64),
  outfitHash = "e".repeat(64),
): ApprovedAssetPackConfiguration {
  const releaseManifest = AssetReleaseManifestV2Schema.parse({
    schemaVersion: "2",
    releaseId: "glm-2026.07.18",
    approvedAt: "2026-07-18T12:00:00.000Z",
    provenance: {
      integrityManifestSha256: "a".repeat(64),
      buildProvenanceSha256: "b".repeat(64),
      pipeline: {
        repositoryId: "tokenmonster",
        revision: "c".repeat(40),
        scriptPath: "scripts/asset-pipeline/build-manifest.mjs",
      },
    },
    assets: [
      releaseAsset("avatar", avatarHash, "1".repeat(64)),
      releaseAsset("outfit", outfitHash, "2".repeat(64)),
    ],
  });
  const packHash = "f".repeat(64);
  const path = `/tokenmonster/characters/v1/packs/${releaseManifest.releaseId}/${packHash}.zip`;
  return Object.freeze({
    releaseManifest,
    descriptor: {
      schemaVersion: "1" as const,
      releaseId: releaseManifest.releaseId,
      releaseManifestSha256:
        computeAssetReleaseManifestV2Sha256(releaseManifest),
      pack: {
        path,
        mediaType: "application/zip" as const,
        bytes: 5_238_148,
        sha256: packHash,
        entryCount: 2,
        extractedBytes: 32,
      },
    },
    allowlist: {
      schemaVersion: "1" as const,
      origin: "https://assets.example.test",
      path,
    },
  });
}

async function paths() {
  const directory = await mkdtemp(
    join(tmpdir(), "tokenmonster-asset-pack-service-"),
  );
  temporaryDirectories.push(directory);
  return {
    directory,
    cacheDirectory: join(directory, "asset-cache"),
    progressionStorePath: join(directory, "progression-v1.json"),
  };
}

async function noOpRecoverCache(): Promise<void> {}

async function writeGatewayCrashResidue(
  cacheDirectory: string,
  configuration: ApprovedAssetPackConfiguration,
): Promise<Readonly<{ stagePath: string; lockPath: string }>> {
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const stageName = `.asset-pack-stage-v1-${CRASHED_OWNER_ID}`;
  const stagePath = join(cacheDirectory, stageName);
  const markerBinding = {
    schemaVersion: "1",
    ownerId: CRASHED_OWNER_ID,
    stageName,
    releaseId: configuration.releaseManifest.releaseId,
    packSha256: configuration.descriptor.pack.sha256,
  } as const;
  await mkdir(stagePath, { mode: 0o700 });
  await writeFile(
    join(stagePath, ".asset-pack-stage-owner-v1.json"),
    `${JSON.stringify({
      ...markerBinding,
      kind: "fixed-asset-pack-stage",
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(join(stagePath, "interrupted-pack.zip"), "partial", {
    mode: 0o600,
  });
  const lockPath = join(cacheDirectory, ".asset-pack-install.lock");
  await writeFile(
    lockPath,
    `${JSON.stringify({
      ...markerBinding,
      kind: "fixed-asset-pack-lock",
    })}\n`,
    { mode: 0o600 },
  );
  return Object.freeze({ stagePath, lockPath });
}

describe("player-controlled fixed asset pack service", () => {
  it("stays unavailable and never calls acquisition without full authority", async () => {
    const local = await paths();
    const install = vi.fn();
    const setActiveManifest = vi.fn();
    const service = createAssetPackService(
      {
        configuration: null,
        ...local,
        setActiveManifest,
      },
      {
        recoverCache: noOpRecoverCache,
        install,
        cacheIsComplete: vi.fn(async () => false),
        removeCache: vi.fn(async () => undefined),
      },
    );

    await expect(service.initialize()).resolves.toEqual({
      status: "ok",
      phase: "unavailable",
      consented: false,
      enabled: false,
      releaseId: null,
      downloadBytes: null,
      lastError: null,
    });
    await expect(service.setEnabled(true)).resolves.toMatchObject({
      phase: "unavailable",
    });
    expect(install).not.toHaveBeenCalled();
    expect(setActiveManifest).not.toHaveBeenCalled();
  });

  it("overrides embedded base assets with the complete pack and restores them on revoke", async () => {
    const local = await paths();
    let cacheComplete = false;
    const activations: Array<AssetManifest | null> = [];
    const install = vi.fn(async () => {
      cacheComplete = true;
      return Object.freeze({
        releaseId: "glm-2026.07.18",
        packSha256: "f".repeat(64),
        entryPaths: Object.freeze([]),
        extractedBytes: 32,
      });
    });
    const removeCache = vi.fn(async () => {
      cacheComplete = false;
    });
    const service = createAssetPackService(
      {
        configuration: approvedConfiguration(),
        fallbackManifest: BASE_MANIFEST,
        ...local,
        setActiveManifest: (manifest) => activations.push(manifest),
      },
      {
        recoverCache: noOpRecoverCache,
        install,
        cacheIsComplete: vi.fn(async () => cacheComplete),
        removeCache,
      },
    );

    await expect(service.initialize()).resolves.toMatchObject({
      phase: "available",
      enabled: false,
    });
    await expect(service.setEnabled(true)).resolves.toMatchObject({
      phase: "installed",
      consented: true,
      enabled: true,
      downloadBytes: 5_238_148,
    });
    expect(activations.at(-1)?.characters[0]).toMatchObject({
      characterId: "glm",
      themes: [{ themeId: "tech" }],
    });
    await expect(service.setEnabled(false)).resolves.toMatchObject({
      phase: "available",
      consented: false,
      enabled: false,
    });
    expect(activations).toEqual([
      BASE_MANIFEST,
      expect.any(Object),
      BASE_MANIFEST,
    ]);
    expect(install).toHaveBeenCalledTimes(1);
    expect(removeCache).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(
        await readFile(join(local.directory, ASSET_PACK_CONSENT_FILE), "utf8"),
      ),
    ).toEqual({
      schemaVersion: "1",
      releaseId: "glm-2026.07.18",
      consented: false,
    });
    expect(
      (await stat(join(local.directory, ASSET_PACK_CONSENT_FILE))).mode & 0o777,
    ).toBe(0o600);
  });

  it("verifies a consented cache at startup but never retries the network", async () => {
    const local = await paths();
    const configuration = approvedConfiguration();
    const first = createAssetPackService(
      {
        configuration,
        ...local,
        setActiveManifest: vi.fn(),
      },
      {
        recoverCache: noOpRecoverCache,
        install: vi.fn(async () => ({
          releaseId: configuration.releaseManifest.releaseId,
          packSha256: configuration.descriptor.pack.sha256,
          entryPaths: [],
          extractedBytes: 32,
        })),
        cacheIsComplete: vi.fn(async () => true),
        removeCache: vi.fn(async () => undefined),
      },
    );
    await first.initialize();
    await first.setEnabled(true);

    const install = vi.fn();
    const active = vi.fn();
    const completeRestart = createAssetPackService(
      {
        configuration,
        ...local,
        setActiveManifest: active,
      },
      {
        recoverCache: noOpRecoverCache,
        install,
        cacheIsComplete: vi.fn(async () => true),
        removeCache: vi.fn(async () => undefined),
      },
    );
    await expect(completeRestart.initialize()).resolves.toMatchObject({
      phase: "installed",
      enabled: true,
    });
    expect(install).not.toHaveBeenCalled();
    expect(active).toHaveBeenLastCalledWith(expect.any(Object));

    const repairInstall = vi.fn();
    const partialRestart = createAssetPackService(
      {
        configuration,
        ...local,
        setActiveManifest: vi.fn(),
      },
      {
        recoverCache: noOpRecoverCache,
        install: repairInstall,
        cacheIsComplete: vi.fn(async () => false),
        removeCache: vi.fn(async () => undefined),
      },
    );
    await expect(partialRestart.initialize()).resolves.toMatchObject({
      phase: "repair-needed",
      consented: true,
      enabled: false,
    });
    expect(repairInstall).not.toHaveBeenCalled();
  });

  it("recovers strict crash residue during offline startup before cache verification", async () => {
    const local = await paths();
    const configuration = approvedConfiguration();
    await writeFile(
      join(local.directory, ASSET_PACK_CONSENT_FILE),
      `${JSON.stringify({
        schemaVersion: "1",
        releaseId: configuration.releaseManifest.releaseId,
        consented: true,
      })}\n`,
      { mode: 0o600 },
    );
    const crashed = await writeGatewayCrashResidue(
      local.cacheDirectory,
      configuration,
    );
    const malformedStage = join(
      local.cacheDirectory,
      ".asset-pack-stage-v1-40000000-0000-4000-8000-000000000004",
    );
    const lookalikeStage = join(
      local.cacheDirectory,
      ".asset-pack-stage-v1-not-a-uuid",
    );
    const unrelated = join(local.cacheDirectory, "player-note.keep");
    await mkdir(malformedStage, { mode: 0o700 });
    await writeFile(
      join(malformedStage, ".asset-pack-stage-owner-v1.json"),
      '{"schemaVersion":"wrong"}\n',
      { mode: 0o600 },
    );
    await mkdir(lookalikeStage, { mode: 0o700 });
    await writeFile(unrelated, "preserved", { mode: 0o600 });
    const recoverCache = vi.fn(recoverFixedAssetPackCache);
    const cacheIsComplete = vi.fn(async () => false);
    const install = vi.fn();
    const service = createAssetPackService(
      {
        configuration,
        ...local,
        setActiveManifest: vi.fn(),
      },
      {
        recoverCache,
        install,
        cacheIsComplete,
        removeCache: vi.fn(async () => undefined),
      },
    );

    await expect(service.initialize()).resolves.toMatchObject({
      phase: "repair-needed",
      consented: true,
      enabled: false,
      lastError: null,
    });

    expect(recoverCache).toHaveBeenCalledWith({
      cacheDirectory: local.cacheDirectory,
    });
    expect(recoverCache.mock.invocationCallOrder[0]).toBeLessThan(
      cacheIsComplete.mock.invocationCallOrder[0]!,
    );
    expect(install).not.toHaveBeenCalled();
    await expect(stat(crashed.stagePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(crashed.lockPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(malformedStage)).resolves.toMatchObject({});
    await expect(stat(lookalikeStage)).resolves.toMatchObject({});
    expect(await readFile(unrelated, "utf8")).toBe("preserved");
  });

  it("surfaces startup residue cleanup failure without verifying or downloading", async () => {
    const local = await paths();
    const configuration = approvedConfiguration();
    await writeFile(
      join(local.directory, ASSET_PACK_CONSENT_FILE),
      `${JSON.stringify({
        schemaVersion: "1",
        releaseId: configuration.releaseManifest.releaseId,
        consented: true,
      })}\n`,
      { mode: 0o600 },
    );
    const cacheIsComplete = vi.fn(async () => true);
    const install = vi.fn();
    const service = createAssetPackService(
      {
        configuration,
        ...local,
        setActiveManifest: vi.fn(),
      },
      {
        recoverCache: vi.fn(async () => {
          throw new Error("fixture cleanup blocked");
        }),
        install,
        cacheIsComplete,
        removeCache: vi.fn(async () => undefined),
      },
    );

    await expect(service.initialize()).resolves.toMatchObject({
      phase: "repair-needed",
      consented: true,
      enabled: false,
      lastError: "cache-unavailable",
    });
    expect(cacheIsComplete).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("keeps art inactive after a failed or partial explicit download", async () => {
    const local = await paths();
    const setActiveManifest = vi.fn();
    const service = createAssetPackService(
      {
        configuration: approvedConfiguration(),
        ...local,
        setActiveManifest,
      },
      {
        recoverCache: noOpRecoverCache,
        install: vi.fn(async () => {
          throw new Error("private network detail");
        }),
        cacheIsComplete: vi.fn(async () => false),
        removeCache: vi.fn(async () => undefined),
      },
    );

    await service.initialize();
    await expect(service.setEnabled(true)).resolves.toEqual({
      status: "ok",
      phase: "available",
      consented: false,
      enabled: false,
      releaseId: "glm-2026.07.18",
      downloadBytes: 5_238_148,
      lastError: "download-failed",
    });
    expect(
      setActiveManifest.mock.calls.every(([manifest]) => manifest === null),
    ).toBe(true);
    expect(JSON.stringify(service.getStatus())).not.toContain("private");
  });

  it("restores embedded base assets after a failed complete-pack download", async () => {
    const local = await paths();
    const setActiveManifest = vi.fn();
    const service = createAssetPackService(
      {
        configuration: approvedConfiguration(),
        fallbackManifest: BASE_MANIFEST,
        ...local,
        setActiveManifest,
      },
      {
        recoverCache: noOpRecoverCache,
        install: vi.fn(async () => {
          throw new Error("network unavailable");
        }),
        cacheIsComplete: vi.fn(async () => false),
        removeCache: vi.fn(async () => undefined),
      },
    );

    await service.initialize();
    await expect(service.setEnabled(true)).resolves.toMatchObject({
      phase: "available",
      enabled: false,
      lastError: "download-failed",
    });
    expect(setActiveManifest).toHaveBeenLastCalledWith(BASE_MANIFEST);
    expect(setActiveManifest.mock.calls.map(([manifest]) => manifest)).toEqual([
      BASE_MANIFEST,
      BASE_MANIFEST,
    ]);
  });

  it("does not activate when an installer returns before the full cache verifies", async () => {
    const local = await paths();
    const configuration = approvedConfiguration();
    const setActiveManifest = vi.fn();
    const service = createAssetPackService(
      {
        configuration,
        ...local,
        setActiveManifest,
      },
      {
        recoverCache: noOpRecoverCache,
        install: vi.fn(async () => ({
          releaseId: configuration.releaseManifest.releaseId,
          packSha256: configuration.descriptor.pack.sha256,
          entryPaths: [],
          extractedBytes: configuration.descriptor.pack.extractedBytes,
        })),
        cacheIsComplete: vi.fn(async () => false),
        removeCache: vi.fn(async () => undefined),
      },
    );

    await service.initialize();
    await expect(service.setEnabled(true)).resolves.toMatchObject({
      phase: "available",
      consented: false,
      enabled: false,
      lastError: "download-failed",
    });
    expect(
      setActiveManifest.mock.calls.every(([manifest]) => manifest === null),
    ).toBe(true);
  });

  it("removes only this release's exact object files when disabled", async () => {
    const local = await paths();
    const avatarBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6,
      7, 8,
    ]);
    const outfitBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 8, 7, 6, 5, 4, 3,
      2, 1,
    ]);
    const avatarHash = createHash("sha256").update(avatarBytes).digest("hex");
    const outfitHash = createHash("sha256").update(outfitBytes).digest("hex");
    await mkdir(local.cacheDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(local.cacheDirectory, `${avatarHash}.png`), avatarBytes),
      writeFile(join(local.cacheDirectory, `${outfitHash}.png`), outfitBytes),
      writeFile(join(local.cacheDirectory, "keep-local-file.bin"), "keep"),
    ]);
    const service = createAssetPackService({
      configuration: approvedConfiguration(avatarHash, outfitHash),
      ...local,
      setActiveManifest: vi.fn(),
    });

    await service.initialize();
    await expect(service.setEnabled(false)).resolves.toMatchObject({
      phase: "available",
      consented: false,
      enabled: false,
    });
    await expect(readdir(local.cacheDirectory)).resolves.toEqual([
      "keep-local-file.bin",
    ]);
  });

  it("keeps a failed cache cleanup recoverable across restart", async () => {
    const local = await paths();
    const configuration = approvedConfiguration();
    let cacheComplete = false;
    let cleanupBlocked = false;
    const dependencies = {
      recoverCache: noOpRecoverCache,
      install: vi.fn(async () => {
        cacheComplete = true;
        return {
          releaseId: configuration.releaseManifest.releaseId,
          packSha256: configuration.descriptor.pack.sha256,
          entryPaths: [],
          extractedBytes: 32,
        };
      }),
      cacheIsComplete: vi.fn(async () => cacheComplete),
      removeCache: vi.fn(async () => {
        if (cleanupBlocked) throw new Error("fixture file is busy");
        cacheComplete = false;
      }),
    };
    const first = createAssetPackService(
      {
        configuration,
        ...local,
        setActiveManifest: vi.fn(),
      },
      dependencies,
    );

    await first.initialize();
    await expect(first.setEnabled(true)).resolves.toMatchObject({
      phase: "installed",
      consented: true,
    });
    cleanupBlocked = true;
    await expect(first.setEnabled(false)).resolves.toMatchObject({
      phase: "repair-needed",
      consented: false,
      enabled: false,
      lastError: "cache-unavailable",
    });
    await first.close();

    const restarted = createAssetPackService(
      {
        configuration,
        ...local,
        setActiveManifest: vi.fn(),
      },
      dependencies,
    );
    await expect(restarted.initialize()).resolves.toMatchObject({
      phase: "repair-needed",
      consented: false,
      lastError: "cache-unavailable",
    });
    cleanupBlocked = false;
    await expect(restarted.setEnabled(false)).resolves.toMatchObject({
      phase: "available",
      consented: false,
      enabled: false,
      lastError: null,
    });
  });
});
