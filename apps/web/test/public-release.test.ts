import { describe, expect, it, vi } from "vitest";

import {
  INVALID_WINDOWS_RELEASE_VERSIONS,
  VALID_WINDOWS_RELEASE_VERSIONS,
} from "../../../scripts/release/release-version-contract.test-vectors.mjs";

import {
  PUBLIC_RELEASE_ENDPOINT,
  fetchPublicRelease,
  parsePublicReleaseSnapshot,
  publicReleaseFromEnvironment,
} from "../src/public-release.js";

const SNAPSHOT = Object.freeze({
  contractVersion: 1,
  platform: "windows-x64",
  version: "0.1.0-rc.11",
  downloadUrl:
    "https://cdn.ted-h.com/tokenmonster/releases/windows/v0.1.0-rc.11/TokenMonsterSetup.exe",
  sha256: "a".repeat(64),
  bytes: 142_387_012,
});

describe("public release projection", () => {
  it("accepts an exact version-bound CDN snapshot", () => {
    expect(parsePublicReleaseSnapshot(SNAPSHOT)).toEqual(SNAPSHOT);
    expect(
      publicReleaseFromEnvironment({
        TOKENMONSTER_PUBLIC_RELEASE_JSON: JSON.stringify(SNAPSHOT),
      }),
    ).toEqual(SNAPSHOT);
  });

  it("requires one exact canonical JSON binding", () => {
    for (const value of [
      undefined,
      "",
      ` ${JSON.stringify(SNAPSHOT)}`,
      `${JSON.stringify(SNAPSHOT)}\n`,
      JSON.stringify({ ...SNAPSHOT, extra: true }),
      JSON.stringify({
        platform: SNAPSHOT.platform,
        contractVersion: SNAPSHOT.contractVersion,
        version: SNAPSHOT.version,
        downloadUrl: SNAPSHOT.downloadUrl,
        sha256: SNAPSHOT.sha256,
        bytes: SNAPSHOT.bytes,
      }),
    ]) {
      expect(() =>
        publicReleaseFromEnvironment({
          TOKENMONSTER_PUBLIC_RELEASE_JSON: value,
        }),
      ).toThrow(TypeError);
    }
    expect(() =>
      publicReleaseFromEnvironment({
        TOKENMONSTER_WINDOWS_RELEASE_VERSION: SNAPSHOT.version,
        TOKENMONSTER_WINDOWS_RELEASE_URL: SNAPSHOT.downloadUrl,
        TOKENMONSTER_WINDOWS_RELEASE_SHA256: SNAPSHOT.sha256,
        TOKENMONSTER_WINDOWS_RELEASE_BYTES: String(SNAPSHOT.bytes),
      }),
    ).toThrow(TypeError);
  });

  it("uses the shared Windows-compatible release-version vectors", () => {
    for (const version of VALID_WINDOWS_RELEASE_VERSIONS) {
      expect(
        parsePublicReleaseSnapshot({
          ...SNAPSHOT,
          version,
          downloadUrl: `https://cdn.ted-h.com/tokenmonster/releases/windows/v${version}/TokenMonsterSetup.exe`,
        }).version,
      ).toBe(version);
    }
    for (const version of INVALID_WINDOWS_RELEASE_VERSIONS) {
      expect(() =>
        parsePublicReleaseSnapshot({
          ...SNAPSHOT,
          version,
          downloadUrl: `https://cdn.ted-h.com/tokenmonster/releases/windows/v${version}/TokenMonsterSetup.exe`,
        }),
      ).toThrow(TypeError);
    }
  });

  it.each([
    ["extra key", { ...SNAPSHOT, notes: "unreviewed" }],
    ["wrong host", { ...SNAPSHOT, downloadUrl: "https://example.test/a.exe" }],
    ["query", { ...SNAPSHOT, downloadUrl: `${SNAPSHOT.downloadUrl}?user=1` }],
    [
      "version drift",
      { ...SNAPSHOT, version: "0.1.0-rc.12" },
    ],
    ["non-canonical version", { ...SNAPSHOT, version: "0.1.0-rc.01" }],
    ["bad hash", { ...SNAPSHOT, sha256: "A".repeat(64) }],
    ["bad bytes", { ...SNAPSHOT, bytes: 4_096 }],
  ])("rejects %s", (_label, input) => {
    expect(() => parsePublicReleaseSnapshot(input)).toThrow(TypeError);
  });

  it("fetches only the exact local JSON endpoint", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(SNAPSHOT, {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(fetchPublicRelease(fetcher)).resolves.toEqual(SNAPSHOT);
    expect(fetcher).toHaveBeenCalledWith(
      PUBLIC_RELEASE_ENDPOINT,
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        redirect: "error",
      }),
    );
  });
});
