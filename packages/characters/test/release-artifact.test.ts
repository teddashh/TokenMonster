import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AssetReleaseManifestV2Schema,
  EMBEDDED_STARTER_ASSET_SNAPSHOTS,
  projectAssetReleaseManifestV2ToRuntimeManifest,
} from "../src/index.js";
import {
  AssetPackAllowlistV1Schema,
  AssetPackDescriptorV1Schema,
  planFixedAssetPack,
} from "../src/asset-pack.js";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const DIST_ROOT = join(PACKAGE_ROOT, "dist");

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

describe("release artifact privacy and rights boundary", () => {
  it("excludes repository-only candidate manifests from the package inventory", () => {
    const packageJson = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { files?: string[] };

    expect(packageJson.files).toEqual(["dist", "README.md"]);
    expect(packageJson.files).not.toContain("asset-manifest.json");
    expect(packageJson.files).not.toContain("asset-manifest.schema.json");
    expect(packageJson.files).not.toContain("ai-sister-source-map.json");
    expect(packageJson.files).not.toContain("ai-sister-source-map.schema.json");
  });

  it("ships only an all-null or strictly cross-bound generated release slot set", () => {
    const jsonNames = listFiles(DIST_ROOT)
      .filter((path) => extname(path) === ".json")
      .map((path) => path.slice(DIST_ROOT.length + 1))
      .sort();

    expect(jsonNames).toEqual([
      "approved-asset-pack-allowlist-v1.json",
      "approved-asset-pack-descriptor-v1.json",
      "approved-release-v2.json",
    ]);
    const [allowlistInput, descriptorInput, releaseInput] = jsonNames.map(
      (name) =>
        JSON.parse(readFileSync(join(DIST_ROOT, name), "utf8")) as unknown,
    );
    const configuredCount = [
      allowlistInput,
      descriptorInput,
      releaseInput,
    ].filter((value) => value !== null).length;
    expect([0, 3]).toContain(configuredCount);
    if (configuredCount === 3) {
      const releaseManifest = AssetReleaseManifestV2Schema.parse(releaseInput);
      const descriptor = AssetPackDescriptorV1Schema.parse(descriptorInput);
      const allowlist = AssetPackAllowlistV1Schema.parse(allowlistInput);
      expect(
        planFixedAssetPack({ releaseManifest, descriptor, allowlist }),
      ).toBeDefined();
      expect(
        projectAssetReleaseManifestV2ToRuntimeManifest(releaseManifest),
      ).toBeDefined();
    }
  });

  it("does not compile unapproved candidate IDs, paths, hashes, or blocked status values", () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "asset-manifest.json"), "utf8"),
    ) as {
      assets: Array<{
        id: string;
        sourcePath: string;
        sha256: string;
        licenseStatus: string;
      }>;
    };
    const sourceMap = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "ai-sister-source-map.json"), "utf8"),
    ) as {
      source: {
        repository: string;
        commit: string;
        externalCandidateLibrary: { logicalRoot: string };
      };
      cloudDelivery: {
        objectPrefix: string;
        manifestObjectPattern: string;
        packObjectPattern: string;
      };
      wardrobe: {
        externalCandidateBank: {
          relativePathTemplates: Record<string, string>;
        };
      };
    };
    const embeddedStarterAuthority = new Set<string>(
      EMBEDDED_STARTER_ASSET_SNAPSHOTS.flatMap((snapshot) => [
        snapshot.avatar.path,
        snapshot.avatar.sha256,
        snapshot.outfit.path,
        snapshot.outfit.sha256,
      ]),
    );
    const forbidden = new Set([
      "pending-owner-grant",
      "ai-sister-source-map.json",
      "ai-sister-source-map.schema.json",
      sourceMap.source.repository,
      sourceMap.source.commit,
      sourceMap.source.externalCandidateLibrary.logicalRoot,
      sourceMap.cloudDelivery.objectPrefix,
      sourceMap.cloudDelivery.manifestObjectPattern,
      sourceMap.cloudDelivery.packObjectPattern,
      ...Object.values(
        sourceMap.wardrobe.externalCandidateBank.relativePathTemplates,
      ),
      ...manifest.assets
        .flatMap((asset) => [
          asset.id,
          asset.sourcePath,
          asset.sha256,
          asset.licenseStatus,
        ])
        .filter((value) => !embeddedStarterAuthority.has(value)),
    ]);
    const runtimeText = listFiles(DIST_ROOT)
      .filter((path) => [".js", ".ts", ".map"].includes(extname(path)))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    for (const value of forbidden) {
      expect(
        runtimeText,
        `compiled release contains forbidden value: ${value}`,
      ).not.toContain(value);
    }
    for (const value of embeddedStarterAuthority) {
      expect(runtimeText).toContain(value);
    }
    expect(runtimeText).not.toContain("asset-manifest.json");
  });
});
