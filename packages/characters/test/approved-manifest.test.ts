import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  AssetReleaseManifestV2Schema,
  computeAssetReleaseManifestV2Sha256,
  getApprovedAssetManifest,
  getApprovedAssetPackConfiguration,
} from "../src/index.js";
import {
  AssetPackAllowlistV1Schema,
  AssetPackDescriptorV1Schema,
  planFixedAssetPack,
} from "../src/asset-pack.js";
import {
  resolveApprovedAssetAuthority,
  resolveApprovedAssetPackAuthority,
} from "../src/approved-authority.js";

function approvedAvatarRelease(): unknown {
  const hash = "a".repeat(64);
  return {
    schemaVersion: "2",
    releaseId: "approved-authority-test",
    approvedAt: "2026-07-18T12:00:00.000Z",
    provenance: {
      integrityManifestSha256: "b".repeat(64),
      buildProvenanceSha256: "c".repeat(64),
      pipeline: {
        repositoryId: "tokenmonster",
        revision: "d".repeat(40),
        scriptPath: "scripts/asset-pipeline/build-manifest.mjs",
      },
    },
    assets: [
      {
        assetId: "asset:chatgpt:avatar",
        association: { kind: "avatar", characterId: "chatgpt" },
        source: {
          inventoryId: "approved-authority-test",
          inventoryRevision: "e".repeat(64),
          path: "fixtures/avatar.png",
          sha256: "f".repeat(64),
        },
        output: {
          path: `objects/${hash}.png`,
          bytes: 12,
          sha256: hash,
          media: { mediaType: "image/png", width: 32, height: 32 },
        },
        generationHistory: {
          tool: { name: "fixture-renderer", version: "1.0.0" },
          sourceMediaType: "image/png",
          resize: { width: 32, height: 32, algorithm: "nearest" },
          encoding: { mediaType: "image/png", quality: null },
          metadataStripped: true,
        },
        rights: {
          licenseStatus: "approved",
          grantReferenceId: "grant-approved-authority-test",
          scopes: {
            publicUse: true,
            commercialUse: true,
            modify: true,
            redistribute: true,
          },
        },
        review: {
          brandStatus: "approved",
          brandReviewReferenceId: "brand-approved-authority-test",
          contentStatus: "approved",
          contentReviewReferenceId: "content-approved-authority-test",
          contentRating: "general",
          disclosureId: "tokenmonster-unaffiliated-v1",
        },
        presentation: {
          altText: {
            "zh-TW": "測試角色頭像",
            en: "Test character avatar",
          },
          allowedTransforms: ["scale-down"],
        },
        releaseStatus: "approved",
      },
    ],
  };
}

describe("approved asset manifest", () => {
  it("emits exactly three all-null or strictly cross-bound release-authority slots", async () => {
    const dist = new URL("../dist/", import.meta.url);
    const jsonNames = (await readdir(dist))
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(jsonNames).toEqual([
      "approved-asset-pack-allowlist-v1.json",
      "approved-asset-pack-descriptor-v1.json",
      "approved-release-v2.json",
    ]);
    const [allowlistInput, descriptorInput, releaseInput] = await Promise.all(
      jsonNames.map((name) =>
        readFile(new URL(name, dist), "utf8").then(
          (contents) => JSON.parse(contents) as unknown,
        ),
      ),
    );
    const configuredCount = [allowlistInput, descriptorInput, releaseInput].filter(
      (value) => value !== null,
    ).length;
    expect([0, 3]).toContain(configuredCount);

    if (configuredCount === 0) {
      expect(getApprovedAssetManifest()).toBeNull();
      expect(getApprovedAssetPackConfiguration()).toBeNull();
      return;
    }

    const releaseManifest = AssetReleaseManifestV2Schema.parse(releaseInput);
    const descriptor = AssetPackDescriptorV1Schema.parse(descriptorInput);
    const allowlist = AssetPackAllowlistV1Schema.parse(allowlistInput);
    expect(planFixedAssetPack({ releaseManifest, descriptor, allowlist })).toBeDefined();
    expect(getApprovedAssetManifest()).not.toBeNull();
    expect(getApprovedAssetPackConfiguration()).toEqual({
      releaseManifest,
      descriptor,
      allowlist,
    });
  });

  it("rejects null, legacy v1, and malformed v2 authority input", () => {
    expect(resolveApprovedAssetAuthority(null)).toBeNull();
    expect(
      resolveApprovedAssetAuthority({
        schemaVersion: "1",
        generatedAt: "2026-07-18T12:00:00.000Z",
        characters: [],
        voice: [],
      }),
    ).toBeNull();
    expect(
      resolveApprovedAssetAuthority({ schemaVersion: "2", assets: [] }),
    ).toBeNull();
  });

  it("projects a strictly approved v2 authority into runtime cache metadata", () => {
    expect(resolveApprovedAssetAuthority(approvedAvatarRelease())).toEqual({
      schemaVersion: "1",
      generatedAt: "2026-07-18T12:00:00.000Z",
      characters: [
        {
          characterId: "chatgpt",
          avatar: {
            path: `objects/${"a".repeat(64)}.png`,
            bytes: 12,
            sha256: "a".repeat(64),
            width: 32,
            height: 32,
          },
          themes: [],
        },
      ],
      voice: [],
    });
  });

  it("requires descriptor, exact HTTPS allowlist, and manifest hash binding together", () => {
    const release = approvedAvatarRelease();
    const releaseId = "approved-authority-test";
    const packHash = "9".repeat(64);
    const path = `/tokenmonster/characters/v1/packs/${releaseId}/${packHash}.zip`;
    const descriptor = {
      schemaVersion: "1",
      releaseId,
      releaseManifestSha256: computeAssetReleaseManifestV2Sha256(release),
      pack: {
        path,
        mediaType: "application/zip",
        bytes: 100,
        sha256: packHash,
        entryCount: 1,
        extractedBytes: 12,
      },
    };
    const allowlist = {
      schemaVersion: "1",
      origin: "https://assets.example.test",
      path,
    };

    expect(
      resolveApprovedAssetPackAuthority(release, descriptor, allowlist),
    ).toMatchObject({ descriptor, allowlist });
    expect(
      resolveApprovedAssetPackAuthority(release, {
        ...descriptor,
        releaseManifestSha256: "0".repeat(64),
      }, allowlist),
    ).toBeNull();
    expect(
      resolveApprovedAssetPackAuthority(release, descriptor, {
        ...allowlist,
        path: `${path}?character=glm`,
      }),
    ).toBeNull();
  });
});
