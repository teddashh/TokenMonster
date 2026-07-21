import { describe, expect, it } from "vitest";

import {
  planNpmPublication,
  verifyNpmPublication,
} from "../../../scripts/release/npm-publication-policy.mjs";
import {
  compareWindowsReleaseVersions,
  decideMonotonicReleaseTransition,
  npmDistTagForReleaseVersion,
} from "../../../scripts/release/release-version-contract.mjs";
import { planWorkerPublication } from "../../../scripts/release/worker-publication-policy.mjs";
import {
  classifyWranglerR2Get,
  requireExactWranglerVersionOutput,
} from "../../../scripts/release/wrangler-r2-get-policy.mjs";
import {
  createWindowsSquirrelCandidate,
  planWindowsSquirrelPromotion,
} from "../../../scripts/release/windows-squirrel-promotion-policy.mjs";

const INTEGRITY_A = `sha512-${"A".repeat(86)}==`;
const INTEGRITY_B = `sha512-${"B".repeat(86)}==`;
const INTEGRITY_C = `sha512-${"C".repeat(86)}==`;

function npmMetadata({ latest = null, next = null, versions = {} } = {}) {
  return {
    name: "tokenmonster",
    "dist-tags": {
      ...(latest === null ? {} : { latest }),
      ...(next === null ? {} : { next }),
    },
    versions: Object.fromEntries(
      Object.entries(versions).map(([version, integrity]) => [
        version,
        { dist: { integrity } },
      ]),
    ),
  };
}

function workerRelease(version, sha256 = "a".repeat(64)) {
  return JSON.stringify({
    contractVersion: 1,
    platform: "windows-x64",
    version,
    downloadUrl: `https://cdn.ted-h.com/tokenmonster/releases/windows/v${version}/TokenMonsterSetup.exe`,
    sha256,
    bytes: 10_485_760,
  });
}

function squirrelCandidate(version, marker = "a") {
  return createWindowsSquirrelCandidate({
    version,
    releasesSha256: marker.repeat(64),
    releasesBytes: 100,
    fullPackageSha1: marker.repeat(40),
    fullPackageSha256: marker.repeat(64),
    fullPackageBytes: 10_485_760,
  });
}

describe("public release transition policy", () => {
  it("orders rc.11, rc.12, and stable in both directions", () => {
    expect(compareWindowsReleaseVersions("0.1.0-rc.11", "0.1.0-rc.12")).toBe(
      -1,
    );
    expect(compareWindowsReleaseVersions("0.1.0-rc.12", "0.1.0-rc.11")).toBe(1);
    expect(compareWindowsReleaseVersions("0.1.0-rc.12", "0.1.0")).toBe(-1);
    expect(compareWindowsReleaseVersions("0.1.0", "0.1.0-rc.12")).toBe(1);
    expect(compareWindowsReleaseVersions("0.1.0-rc.12", "0.1.0-rc.12")).toBe(0);
  });

  it("allows forward or exact transitions and rejects downgrade or drift", () => {
    expect(
      decideMonotonicReleaseTransition({
        currentVersion: "0.1.0-rc.11",
        candidateVersion: "0.1.0-rc.12",
        currentIdentity: "rc11-bytes",
        candidateIdentity: "rc12-bytes",
      }),
    ).toBe("advance");
    expect(
      decideMonotonicReleaseTransition({
        currentVersion: "0.1.0-rc.12",
        candidateVersion: "0.1.0",
        currentIdentity: "rc12-bytes",
        candidateIdentity: "stable-bytes",
      }),
    ).toBe("advance");
    expect(
      decideMonotonicReleaseTransition({
        currentVersion: "0.1.0-rc.12",
        candidateVersion: "0.1.0-rc.12",
        currentIdentity: "same-bytes",
        candidateIdentity: "same-bytes",
      }),
    ).toBe("idempotent");
    expect(() =>
      decideMonotonicReleaseTransition({
        currentVersion: "0.1.0-rc.12",
        candidateVersion: "0.1.0-rc.11",
        currentIdentity: "rc12-bytes",
        candidateIdentity: "rc11-bytes",
      }),
    ).toThrow(/downgrade/u);
    expect(() =>
      decideMonotonicReleaseTransition({
        currentVersion: "0.1.0-rc.12",
        candidateVersion: "0.1.0-rc.12",
        currentIdentity: "original-bytes",
        candidateIdentity: "different-bytes",
      }),
    ).toThrow(/different bytes/u);
  });

  it("maps stable and prerelease candidates to their public npm channels", () => {
    expect(npmDistTagForReleaseVersion("0.1.0")).toBe("latest");
    expect(npmDistTagForReleaseVersion("0.1.0-rc.12")).toBe("next");
  });

  it("uses the same latest-or-next authority for deterministic Squirrel plans", () => {
    const prerelease = squirrelCandidate("0.1.0-rc.12", "b");
    const stable = squirrelCandidate("0.1.0", "c");
    expect(prerelease.channel).toBe("next");
    expect(stable.channel).toBe("latest");
    expect(prerelease.objects.find((object) => object.role === "releases")).toMatchObject({
      immutableCacheControl: "public, max-age=31536000, immutable",
      channelCacheControl: "no-store, no-cache, must-revalidate",
    });
    expect(planWindowsSquirrelPromotion(null, prerelease)).toMatchObject({
      decision: "advance",
      channel: "next",
      currentVersion: null,
      candidateVersion: "0.1.0-rc.12",
      channelTransition: {
        writesInOrder: [
          { sequence: 1, role: "full-package" },
          { sequence: 2, role: "releases" },
        ],
        retainedForClientOverlap: [],
      },
    });
    expect(planWindowsSquirrelPromotion(prerelease, prerelease)).toMatchObject({
      decision: "idempotent",
      channelTransition: { writesInOrder: [] },
    });
    expect(() =>
      planWindowsSquirrelPromotion(
        prerelease,
        squirrelCandidate("0.1.0-rc.12", "d"),
      ),
    ).toThrow(/different bytes/u);
    expect(() =>
      planWindowsSquirrelPromotion(stable, prerelease),
    ).toThrow(/channel drift/u);
  });

  it("advances npm next without moving latest", () => {
    const before = npmMetadata({
      latest: "0.0.9",
      next: "0.1.0-rc.11",
      versions: {
        "0.0.9": INTEGRITY_A,
        "0.1.0-rc.11": INTEGRITY_B,
      },
    });
    const plan = planNpmPublication(before, "0.1.0-rc.12", INTEGRITY_C);
    expect(plan).toMatchObject({
      targetTag: "next",
      decision: "advance",
      candidateState: "missing",
      latestBefore: "0.0.9",
      nextBefore: "0.1.0-rc.11",
    });

    const after = npmMetadata({
      latest: "0.0.9",
      next: "0.1.0-rc.12",
      versions: {
        "0.0.9": INTEGRITY_A,
        "0.1.0-rc.11": INTEGRITY_B,
        "0.1.0-rc.12": INTEGRITY_C,
      },
    });
    expect(verifyNpmPublication(after, plan)).toEqual({
      targetTag: "next",
      version: "0.1.0-rc.12",
      latest: "0.0.9",
      next: "0.1.0-rc.12",
    });
    expect(() =>
      verifyNpmPublication(
        npmMetadata({
          latest: "0.1.0",
          next: "0.1.0-rc.12",
          versions: {
            "0.1.0": INTEGRITY_A,
            "0.1.0-rc.12": INTEGRITY_C,
          },
        }),
        plan,
      ),
    ).toThrow(/latest changed/u);
  });

  it("repairs an exact npm rerun but rejects reverse order and byte drift", () => {
    const exactButTagBehind = npmMetadata({
      next: "0.1.0-rc.11",
      versions: {
        "0.1.0-rc.11": INTEGRITY_A,
        "0.1.0-rc.12": INTEGRITY_B,
      },
    });
    expect(
      planNpmPublication(exactButTagBehind, "0.1.0-rc.12", INTEGRITY_B),
    ).toMatchObject({ decision: "advance", candidateState: "exact" });
    expect(() =>
      planNpmPublication(exactButTagBehind, "0.1.0-rc.10", INTEGRITY_C),
    ).toThrow(/downgrade/u);
    expect(() =>
      planNpmPublication(exactButTagBehind, "0.1.0-rc.12", INTEGRITY_C),
    ).toThrow(/different bytes/u);
  });

  it("keeps Worker publication monotonic and JSON-idempotent", () => {
    expect(
      planWorkerPublication(
        workerRelease("0.1.0-rc.11"),
        `${workerRelease("0.1.0-rc.12")}\n`,
      ),
    ).toEqual({
      decision: "advance",
      currentVersion: "0.1.0-rc.11",
      candidateVersion: "0.1.0-rc.12",
    });
    expect(
      planWorkerPublication(
        workerRelease("0.1.0-rc.12"),
        workerRelease("0.1.0"),
      ),
    ).toMatchObject({ decision: "advance", candidateVersion: "0.1.0" });
    expect(
      planWorkerPublication(
        workerRelease("0.1.0-rc.12"),
        workerRelease("0.1.0-rc.12"),
      ),
    ).toMatchObject({ decision: "idempotent" });
    expect(() =>
      planWorkerPublication(
        workerRelease("0.1.0-rc.12"),
        workerRelease("0.1.0-rc.11"),
      ),
    ).toThrow(/downgrade/u);
    expect(() =>
      planWorkerPublication(
        workerRelease("0.1.0-rc.12"),
        workerRelease("0.1.0-rc.12", "b".repeat(64)),
      ),
    ).toThrow(/different bytes/u);
  });

  it("classifies only the pinned Wrangler missing-key diagnostic as absent", () => {
    expect(classifyWranglerR2Get(0, "")).toBe("present");
    expect(
      classifyWranglerR2Get(
        1,
        '\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mThe specified key does not exist.\u001b[0m\n\n🪵  Logs were written to "/tmp/wrangler.log"\n',
      ),
    ).toBe("missing");
    for (const error of [
      "✘ [ERROR] Authentication error [code: 10000]\n",
      "✘ [ERROR] A request to the Cloudflare API failed\n",
      "✘ [ERROR] The specified bucket does not exist.\n",
      "✘ [ERROR] The specified key does not exist.\nnetwork timeout\n",
    ]) {
      expect(() => classifyWranglerR2Get(1, error)).toThrow(
        /other than a missing key/u,
      );
    }
  });

  it("accepts only the exact audited Wrangler version output", () => {
    expect(requireExactWranglerVersionOutput("4.111.0\n", "4.111.0")).toBe(
      "4.111.0",
    );
    for (const output of [
      "wrangler 4.111.0",
      "4.111.0 unexpected",
      "4.110.0",
      "14.111.0",
    ]) {
      expect(() =>
        requireExactWranglerVersionOutput(output, "4.111.0"),
      ).toThrow(/exact audited version/u);
    }
  });
});
