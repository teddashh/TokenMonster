import { access } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { getApprovedAssetManifest } from "../src/index.js";

describe("approved asset manifest", () => {
  it("strictly parses the embedded release allowlist", () => {
    expect(getApprovedAssetManifest()).toEqual({
      schemaVersion: "1",
      generatedAt: "2026-07-16T00:00:00.000Z",
      characters: [],
      voice: []
    });
  });

  it("ships the embedded JSON beside the compiled module", async () => {
    await expect(
      access(new URL("../dist/approved-manifest.json", import.meta.url))
    ).resolves.toBeUndefined();
  });
});
