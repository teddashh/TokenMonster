import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ASSET_PACK_ALLOWLIST_SCHEMA_VERSION,
  AssetPackAllowlistV1Schema,
  AssetPackDescriptorV1Schema,
  installFixedAssetPack,
  planFixedAssetPack,
  type AssetPackFetch,
  type AssetPackFetchResponse,
} from "../src/asset-pack.js";
import {
  AssetReleaseManifestV2Schema,
  computeAssetReleaseManifestV2Sha256,
  type AssetAssociation,
} from "../src/asset-release.js";
import {
  runFixedPackBuilder,
  runReleaseSlotPreparer,
} from "./fixed-pack-builder-fixture.js";

const PRIVATE_ORIGIN = "https://assets.example.test";
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngObject(label: string) {
  const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.from(`fixed:${label}`)]);
  const hash = sha256(bytes);
  return {
    bytes,
    output: {
      path: `objects/${hash}.png`,
      bytes: bytes.length,
      sha256: hash,
      media: { mediaType: "image/png" as const, width: 32, height: 32 },
    },
  };
}

function releaseEntry(
  object: ReturnType<typeof pngObject>,
  association: AssetAssociation,
) {
  const associationLabel =
    association.kind === "avatar" ? "avatar" : "theme:tech:outfit";
  return {
    assetId: `asset:chatgpt:${associationLabel}`,
    association,
    source: {
      inventoryId: "fixed-pack-builder-test",
      inventoryRevision: "8".repeat(64),
      path: `fixtures/${association.kind}.png`,
      sha256: sha256(`source:${association.kind}`),
    },
    output: object.output,
    generationHistory: {
      tool: { name: "fixture-renderer", version: "1.0.0" },
      sourceMediaType: "image/png" as const,
      resize: { width: 32, height: 32, algorithm: "nearest" as const },
      encoding: { mediaType: "image/png" as const, quality: null },
      metadataStripped: true as const,
    },
    rights: {
      licenseStatus: "approved" as const,
      grantReferenceId: "grant-fixed-pack-builder-test",
      scopes: {
        publicUse: true as const,
        commercialUse: true as const,
        modify: true as const,
        redistribute: true as const,
      },
    },
    review: {
      brandStatus: "approved" as const,
      brandReviewReferenceId: "brand-fixed-pack-builder-test",
      contentStatus: "approved" as const,
      contentReviewReferenceId: "content-fixed-pack-builder-test",
      contentRating: "general" as const,
      disclosureId: "disclosure-fixed-pack-builder-test",
    },
    presentation: {
      altText: {
        "zh-TW": "固定素材包測試角色圖",
        en: "Fixed asset-pack test character art",
      },
      allowedTransforms: ["scale-down" as const],
    },
    releaseStatus: "approved" as const,
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "tokenmonster-pack-builder-"));
  temporaryDirectories.push(root);
  const assetRoot = join(root, "asset-root");
  const objectDirectory = join(assetRoot, "objects");
  const manifestPath = join(root, "asset-release-manifest-v2.json");
  await mkdir(objectDirectory, { recursive: true });

  const avatar = pngObject("avatar");
  const outfit = pngObject("outfit");
  const manifest = AssetReleaseManifestV2Schema.parse({
    schemaVersion: "2",
    releaseId: "characters-builder-test",
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
      releaseEntry(outfit, {
        kind: "outfit",
        characterId: "chatgpt",
        themeId: "tech",
      }),
      releaseEntry(avatar, { kind: "avatar", characterId: "chatgpt" }),
    ],
  });
  await Promise.all(
    [avatar, outfit].map((object) =>
      writeFile(join(assetRoot, object.output.path), object.bytes),
    ),
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, assetRoot, manifestPath, manifest, objects: [avatar, outfit] };
}

function responseFor(url: string, archive: Buffer): AssetPackFetchResponse {
  let delivered = false;
  return {
    ok: true,
    status: 200,
    redirected: false,
    url,
    headers: {
      get: (name: string) => {
        switch (name.toLowerCase()) {
          case "content-type":
            return "application/zip";
          case "content-length":
            return String(archive.length);
          default:
            return null;
        }
      },
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (delivered) return { done: true as const };
          delivered = true;
          return { done: false as const, value: archive };
        },
        cancel: async () => undefined,
      }),
    },
  };
}

describe("fixed asset-pack builder", () => {
  it("emits deterministic bytes accepted by the production installer", async () => {
    const fixture = await createFixture();
    const firstOut = join(fixture.root, "first-pack");
    const secondOut = join(fixture.root, "second-pack");
    const first = await runFixedPackBuilder(
      fixture.manifestPath,
      fixture.assetRoot,
      firstOut,
    );
    const second = await runFixedPackBuilder(
      fixture.manifestPath,
      fixture.assetRoot,
      secondOut,
    );
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);

    const descriptor = AssetPackDescriptorV1Schema.parse(
      JSON.parse(
        await readFile(join(firstOut, "asset-pack-descriptor-v1.json"), "utf8"),
      ) as unknown,
    );
    const firstArchive = await readFile(
      join(firstOut, `${descriptor.pack.sha256}.zip`),
    );
    const secondArchive = await readFile(
      join(secondOut, `${descriptor.pack.sha256}.zip`),
    );
    expect(secondArchive).toEqual(firstArchive);
    expect(sha256(firstArchive)).toBe(descriptor.pack.sha256);
    expect(descriptor).toMatchObject({
      releaseId: fixture.manifest.releaseId,
      releaseManifestSha256: computeAssetReleaseManifestV2Sha256(
        fixture.manifest,
      ),
      pack: {
        path: `/tokenmonster/characters/v1/packs/${fixture.manifest.releaseId}/${descriptor.pack.sha256}.zip`,
        bytes: firstArchive.length,
        entryCount: 2,
        extractedBytes: fixture.objects.reduce(
          (total, object) => total + object.bytes.length,
          0,
        ),
      },
    });

    const allowlist = {
      schemaVersion: ASSET_PACK_ALLOWLIST_SCHEMA_VERSION,
      origin: PRIVATE_ORIGIN,
      path: descriptor.pack.path,
    };
    const plan = planFixedAssetPack({
      releaseManifest: fixture.manifest,
      descriptor,
      allowlist,
    });
    expect(plan.entryPaths).toEqual(
      fixture.objects
        .map((object) => object.output.path)
        .sort((left, right) => (left < right ? -1 : 1)),
    );

    const cacheDirectory = join(fixture.root, "asset-cache");
    const fetch: AssetPackFetch = async (url) => responseFor(url, firstArchive);
    const installed = await installFixedAssetPack({
      releaseManifest: fixture.manifest,
      descriptor,
      allowlist,
      cacheDirectory,
      fetch,
    });
    expect(installed.entryPaths).toEqual(plan.entryPaths);
    for (const object of fixture.objects) {
      expect(
        await readFile(join(cacheDirectory, basename(object.output.path))),
      ).toEqual(object.bytes);
    }
  }, 60_000);

  it("derives and atomically publishes the exact three runtime release slots", async () => {
    const fixture = await createFixture();
    const packOut = join(fixture.root, "release-pack");
    const built = await runFixedPackBuilder(
      fixture.manifestPath,
      fixture.assetRoot,
      packOut,
    );
    expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
    const descriptorPath = join(packOut, "asset-pack-descriptor-v1.json");
    const slotOut = join(fixture.root, "release-slots");
    const prepared = await runReleaseSlotPreparer(
      fixture.manifestPath,
      descriptorPath,
      PRIVATE_ORIGIN,
      slotOut,
    );
    expect(prepared.status, `${prepared.stdout}\n${prepared.stderr}`).toBe(0);
    expect((await readdir(slotOut)).sort()).toEqual([
      "approved-asset-pack-allowlist-v1.json",
      "approved-asset-pack-descriptor-v1.json",
      "approved-release-v2.json",
    ]);
    await expect(
      readFile(join(slotOut, "approved-release-v2.json")),
    ).resolves.toEqual(await readFile(fixture.manifestPath));
    await expect(
      readFile(join(slotOut, "approved-asset-pack-descriptor-v1.json")),
    ).resolves.toEqual(await readFile(descriptorPath));

    const descriptor = AssetPackDescriptorV1Schema.parse(
      JSON.parse(await readFile(descriptorPath, "utf8")) as unknown,
    );
    const allowlist = AssetPackAllowlistV1Schema.parse(
      JSON.parse(
        await readFile(
          join(slotOut, "approved-asset-pack-allowlist-v1.json"),
          "utf8",
        ),
      ) as unknown,
    );
    expect(allowlist).toEqual({
      schemaVersion: ASSET_PACK_ALLOWLIST_SCHEMA_VERSION,
      origin: PRIVATE_ORIGIN,
      path: descriptor.pack.path,
    });
    expect(
      planFixedAssetPack({
        releaseManifest: fixture.manifest,
        descriptor,
        allowlist,
      }),
    ).toMatchObject({
      releaseId: fixture.manifest.releaseId,
      url: `${PRIVATE_ORIGIN}${descriptor.pack.path}`,
    });
  }, 60_000);

  it("publishes no release-slot directory for an invalid origin or stale binding", async () => {
    const fixture = await createFixture();
    const packOut = join(fixture.root, "rejected-release-pack");
    const built = await runFixedPackBuilder(
      fixture.manifestPath,
      fixture.assetRoot,
      packOut,
    );
    expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
    const descriptorPath = join(packOut, "asset-pack-descriptor-v1.json");
    const invalidOriginOut = join(fixture.root, "invalid-origin-slots");
    const invalidOrigin = await runReleaseSlotPreparer(
      fixture.manifestPath,
      descriptorPath,
      "http://assets.example.test",
      invalidOriginOut,
    );
    expect(invalidOrigin.status).toBe(1);
    await expect(lstat(invalidOriginOut)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const descriptor = AssetPackDescriptorV1Schema.parse(
      JSON.parse(await readFile(descriptorPath, "utf8")) as unknown,
    );
    const staleDescriptorPath = join(fixture.root, "stale-descriptor.json");
    await writeFile(
      staleDescriptorPath,
      `${JSON.stringify(
        { ...descriptor, releaseManifestSha256: "0".repeat(64) },
        null,
        2,
      )}\n`,
    );
    const staleBindingOut = join(fixture.root, "stale-binding-slots");
    const staleBinding = await runReleaseSlotPreparer(
      fixture.manifestPath,
      staleDescriptorPath,
      PRIVATE_ORIGIN,
      staleBindingOut,
    );
    expect(staleBinding.status).toBe(1);
    await expect(lstat(staleBindingOut)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await readdir(fixture.root)).some((name) =>
        name.startsWith(".tokenmonster-release-slots-"),
      ),
    ).toBe(false);
  }, 60_000);

  it("rejects a stale object and leaves no partial output", async () => {
    const fixture = await createFixture();
    const out = join(fixture.root, "rejected-pack");
    const staleBytes = Buffer.from(fixture.objects[0]!.bytes);
    const finalByteIndex = staleBytes.length - 1;
    staleBytes[finalByteIndex] = staleBytes[finalByteIndex]! ^ 0x01;
    await writeFile(
      join(fixture.assetRoot, fixture.objects[0]!.output.path),
      staleBytes,
    );

    const result = await runFixedPackBuilder(
      fixture.manifestPath,
      fixture.assetRoot,
      out,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("object bytes do not match");
    await expect(lstat(out)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);
});
