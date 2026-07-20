import { describe, expect, it } from "vitest";

import {
  requireCanonicalCliVersion,
  resolveCliReleaseVersion,
} from "../../../scripts/release/cli-release-version.mjs";
import {
  INVALID_WINDOWS_RELEASE_VERSIONS,
  VALID_WINDOWS_RELEASE_VERSIONS,
} from "../../../scripts/release/release-version-contract.test-vectors.mjs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("CLI release version", () => {
  it("uses the source version or an exact prerelease on the same base", () => {
    expect(resolveCliReleaseVersion("0.1.0")).toBe("0.1.0");
    expect(
      resolveCliReleaseVersion("0.1.0", { exactVersion: "0.1.0-rc.11" }),
    ).toBe("0.1.0-rc.11");
    expect(
      resolveCliReleaseVersion("0.1.0", { versionSuffix: "ci.123" }),
    ).toBe("0.1.0-ci.123");
  });

  it("uses the shared Windows-compatible version vectors", () => {
    for (const version of VALID_WINDOWS_RELEASE_VERSIONS) {
      expect(requireCanonicalCliVersion(version)).toBe(version);
    }
    for (const version of INVALID_WINDOWS_RELEASE_VERSIONS) {
      expect(() => requireCanonicalCliVersion(version)).toThrow();
    }
  });

  it("rejects path-like, non-canonical, foreign-base, and ambiguous input", () => {
    for (const versionSuffix of ["../rc.1", "rc+1", "rc.01", "rc/1", ""]) {
      expect(() =>
        resolveCliReleaseVersion("0.1.0", { versionSuffix }),
      ).toThrow();
    }
    expect(() =>
      resolveCliReleaseVersion("0.1.0", { exactVersion: "0.2.0-rc.1" }),
    ).toThrow(/source base/u);
    expect(() =>
      resolveCliReleaseVersion("0.1.0", { exactVersion: "0.1.1" }),
    ).toThrow(/source base/u);
    expect(() =>
      resolveCliReleaseVersion("0.1.0", {
        exactVersion: "0.1.0-rc.1",
        versionSuffix: "rc.1",
      }),
    ).toThrow(/mutually exclusive/u);
  });

  it("derives source-based branch and exact tag versions from one authority", () => {
    const script = resolve(rootDirectory, "scripts/derive-cli-release-version.mjs");
    for (const [environment, expected] of [
      [
        { GITHUB_REF_TYPE: "branch", GITHUB_RUN_ID: "29566777400" },
        "0.1.0-ci29566777400x",
      ],
      [
        { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.1.0-rc.12" },
        "0.1.0-rc.12",
      ],
      [
        { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.1.0" },
        "0.1.0",
      ],
    ]) {
      const result = spawnSync(process.execPath, [script], {
        cwd: rootDirectory,
        encoding: "utf8",
        env: { ...process.env, ...environment },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(expected);
    }

    for (const environment of [
      { GITHUB_REF_TYPE: "branch", GITHUB_RUN_ID: "0" },
      { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "0.1.0-rc.12" },
      { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.2.0" },
    ]) {
      const result = spawnSync(process.execPath, [script], {
        cwd: rootDirectory,
        encoding: "utf8",
        env: { ...process.env, ...environment },
      });
      expect(result.status).not.toBe(0);
    }
  });
});
