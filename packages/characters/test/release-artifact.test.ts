import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

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

  it("does not compile candidate IDs, paths, hashes, or blocked status values", () => {
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
      cloudDelivery: { objectPrefix: string; manifestObject: string };
      wardrobe: {
        externalCandidateBank: {
          relativePathTemplates: Record<string, string>;
        };
      };
    };
    const forbidden = new Set([
      ".webp",
      "pending-owner-grant",
      "ai-sister-source-map.json",
      "ai-sister-source-map.schema.json",
      sourceMap.source.repository,
      sourceMap.source.commit,
      sourceMap.source.externalCandidateLibrary.logicalRoot,
      sourceMap.cloudDelivery.objectPrefix,
      sourceMap.cloudDelivery.manifestObject,
      ...Object.values(
        sourceMap.wardrobe.externalCandidateBank.relativePathTemplates,
      ),
      ...manifest.assets.flatMap((asset) => [
        asset.id,
        asset.sourcePath,
        asset.sha256,
        asset.licenseStatus,
      ]),
    ]);
    const runtimeText = listFiles(DIST_ROOT)
      .filter((path) => [".js", ".ts", ".map"].includes(extname(path)))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    for (const value of forbidden) {
      expect(runtimeText, `compiled release contains forbidden value: ${value}`).not.toContain(
        value,
      );
    }
    expect(runtimeText).not.toContain("asset-manifest.json");
  });
});
