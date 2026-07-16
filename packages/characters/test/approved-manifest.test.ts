import { access } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { getApprovedAssetManifest } from "../src/index.js";

describe("approved asset manifest", () => {
  it("strictly parses the embedded release allowlist", () => {
    const manifest = getApprovedAssetManifest();
    expect(manifest).not.toBeNull();
    expect(manifest!.schemaVersion).toBe("1");
    expect(manifest!.characters.length).toBeGreaterThan(0);
    const ids = manifest!.characters.map((entry) => entry.characterId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ships the embedded JSON beside the compiled module", async () => {
    await expect(
      access(new URL("../dist/approved-manifest.json", import.meta.url))
    ).resolves.toBeUndefined();
  });
});
