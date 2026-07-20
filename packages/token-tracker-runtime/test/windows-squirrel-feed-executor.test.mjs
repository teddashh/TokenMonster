import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  executeWindowsSquirrelPromotion,
  retrieveAuthoritativeWindowsSquirrelChannel,
} from "../../../scripts/release/windows-squirrel-feed-executor-policy.mjs";
import {
  createWindowsSquirrelCandidate,
  fullSquirrelPackageNameForVersion,
  windowsReleaseVersionFromFullSquirrelPackageName,
} from "../../../scripts/release/windows-squirrel-promotion-policy.mjs";

function digest(algorithm, contents) {
  return createHash(algorithm).update(contents).digest("hex");
}

function releaseFixture(version, marker = 0x41) {
  const fullPackage = Buffer.alloc(8_192, marker);
  const fileName = fullSquirrelPackageNameForVersion(version);
  const releases = Buffer.from(
    `${digest("sha1", fullPackage)} ${fileName} ${fullPackage.byteLength}\n`,
  );
  const candidate = createWindowsSquirrelCandidate({
    version,
    releasesSha256: digest("sha256", releases),
    releasesBytes: releases.byteLength,
    fullPackageSha1: digest("sha1", fullPackage),
    fullPackageSha256: digest("sha256", fullPackage),
    fullPackageBytes: fullPackage.byteLength,
  });
  return Object.freeze({ candidate, releases, fullPackage });
}

function observation(role, contents, cacheControl = null) {
  return Object.freeze({
    state: "present",
    bytes: contents.byteLength,
    sha256: digest("sha256", contents),
    sha1: role === "full-package" ? digest("sha1", contents) : null,
    contents: role === "releases" ? Buffer.from(contents) : null,
    cacheControl,
  });
}

function sources(fixture) {
  return Object.freeze({
    releases: Object.freeze({
      source: fixture.releases,
      observation: observation("releases", fixture.releases),
    }),
    fullPackage: Object.freeze({
      source: fixture.fullPackage,
      observation: observation("full-package", fixture.fullPackage),
    }),
  });
}

function memoryTransport(initialFixtures = []) {
  const r2 = new Map();
  const publicObjects = new Map();
  const events = [];

  function storeFixture(fixture, destination, exposePublic = true) {
    for (const object of fixture.candidate.objects) {
      const contents =
        object.role === "releases" ? fixture.releases : fixture.fullPackage;
      const key =
        destination === "channel" ? object.channelKey : object.immutableKey;
      const cacheControl =
        destination === "channel"
          ? object.channelCacheControl
          : object.immutableCacheControl;
      r2.set(key, { role: object.role, contents, cacheControl });
      if (exposePublic) {
        publicObjects.set(key, { role: object.role, contents, cacheControl });
      }
    }
  }

  for (const fixture of initialFixtures) storeFixture(fixture, "channel");

  const getR2 = vi.fn(async ({ key, role }) => {
    events.push(`get-r2:${key}`);
    const entry = r2.get(key);
    return entry === undefined
      ? Object.freeze({ state: "missing" })
      : observation(role, entry.contents);
  });
  const putR2 = vi.fn(
    async ({ key, role, cacheControl, source, contentType }) => {
      events.push(`put:${key}:${cacheControl}:${contentType}`);
      const contents =
        source instanceof Uint8Array ? source : source.contents;
      r2.set(key, { role, contents: Buffer.from(contents), cacheControl });
      publicObjects.set(key, {
        role,
        contents: Buffer.from(contents),
        cacheControl,
      });
    },
  );
  const deleteR2 = vi.fn(async ({ key }) => {
    events.push(`delete:${key}`);
    r2.delete(key);
    publicObjects.delete(key);
  });
  const getPublic = vi.fn(async ({ key, role }) => {
    events.push(`get-public:${key}`);
    const entry = publicObjects.get(key);
    return entry === undefined
      ? Object.freeze({ state: "missing" })
      : observation(role, entry.contents, entry.cacheControl);
  });

  return {
    r2,
    publicObjects,
    events,
    getR2,
    putR2,
    deleteR2,
    getPublic,
    storeFixture,
  };
}

function execute(fixture, transport, overrides = {}) {
  return executeWindowsSquirrelPromotion({
    candidate: fixture.candidate,
    candidateSources: sources(fixture),
    getR2: transport.getR2,
    putR2: transport.putR2,
    deleteR2: transport.deleteR2,
    getPublic: transport.getPublic,
    publicReadAttempts: 3,
    wait: vi.fn(async () => {}),
    ...overrides,
  });
}

describe("Windows Squirrel feed executor policy", () => {
  it("round-trips stable, numbered prerelease, and non-numbered projected package names", () => {
    for (const version of ["0.1.0", "0.1.0-rc.11", "0.1.0-ci123x"]) {
      expect(
        windowsReleaseVersionFromFullSquirrelPackageName(
          fullSquirrelPackageNameForVersion(version),
        ),
      ).toBe(version);
    }
    expect(() =>
      windowsReleaseVersionFromFullSquirrelPackageName(
        "TokenMonster-0.1.0-rc.11-full.nupkg",
      ),
    ).toThrow(/malformed/u);
  });

  it("distinguishes exact missing, present, and unknown authoritative current state", async () => {
    const current = releaseFixture("0.1.0-rc.11");
    const transport = memoryTransport([current]);
    await expect(
      retrieveAuthoritativeWindowsSquirrelChannel({
        channel: "next",
        getR2: transport.getR2,
      }),
    ).resolves.toMatchObject({
      state: "present",
      candidate: { version: "0.1.0-rc.11", channel: "next" },
    });
    await expect(
      retrieveAuthoritativeWindowsSquirrelChannel({
        channel: "latest",
        getR2: transport.getR2,
      }),
    ).resolves.toEqual({
      state: "missing",
      candidate: null,
      releases: null,
      fullPackage: null,
    });
    await expect(
      retrieveAuthoritativeWindowsSquirrelChannel({
        channel: "next",
        getR2: async () => Object.freeze({ state: "unknown" }),
      }),
    ).rejects.toThrow(/unknown/u);
  });

  it("creates immutable objects and commits package before no-store channel metadata", async () => {
    const candidate = releaseFixture("0.1.0", 0x42);
    const transport = memoryTransport();
    const evidence = await execute(candidate, transport);
    expect(evidence).toMatchObject({
      decision: "advance",
      channel: "latest",
      currentState: "missing",
      verification: "exact-r2-and-public-cdn-readback",
    });
    const puts = transport.events.filter((event) => event.startsWith("put:"));
    expect(puts.map((event) => event.split(":")[1])).toEqual([
      candidate.candidate.objects[1].immutableKey,
      candidate.candidate.objects[0].immutableKey,
      candidate.candidate.objects[1].channelKey,
      candidate.candidate.objects[0].channelKey,
    ]);
    expect(puts[2]).toContain("public, max-age=31536000, immutable");
    expect(puts[3]).toContain("no-store, no-cache, must-revalidate");
    expect(transport.deleteR2).not.toHaveBeenCalled();
  });

  it("isolates next from latest and retains the prior package for client overlap", async () => {
    const stable = releaseFixture("0.1.0", 0x31);
    const prior = releaseFixture("0.2.0-rc.11", 0x32);
    const candidate = releaseFixture("0.2.0-rc.12", 0x33);
    const transport = memoryTransport([stable, prior]);
    const latestBefore = Buffer.from(
      transport.r2.get(stable.candidate.objects[0].channelKey).contents,
    );
    const evidence = await execute(candidate, transport);
    expect(evidence.operations).toContain(
      "prior-channel-full-package-retained-for-client-overlap",
    );
    expect(
      transport.r2.has(prior.candidate.objects[1].channelKey),
    ).toBe(true);
    expect(
      transport.r2.get(stable.candidate.objects[0].channelKey).contents,
    ).toEqual(latestBefore);
    expect(transport.deleteR2).not.toHaveBeenCalled();
  });

  it("is idempotent after an exact rerun and performs no mutation", async () => {
    const candidate = releaseFixture("0.1.0-rc.12", 0x44);
    const transport = memoryTransport([candidate]);
    transport.storeFixture(candidate, "immutable");
    const evidence = await execute(candidate, transport);
    expect(evidence.decision).toBe("idempotent");
    expect(transport.putR2).not.toHaveBeenCalled();
    expect(transport.deleteR2).not.toHaveBeenCalled();
  });

  it("repairs cache metadata only after authoritative bytes are exact", async () => {
    const candidate = releaseFixture("0.1.0-rc.12", 0x46);
    const transport = memoryTransport([candidate]);
    transport.storeFixture(candidate, "immutable");
    const releasesObject = candidate.candidate.objects[0];
    const entry = transport.publicObjects.get(releasesObject.immutableKey);
    transport.publicObjects.set(releasesObject.immutableKey, {
      ...entry,
      cacheControl: "public, max-age=60",
    });
    const evidence = await execute(candidate, transport);
    expect(evidence.operations).toContain("immutable-releases-metadata-repaired");
    expect(transport.putR2).toHaveBeenCalledTimes(1);
    const immutableRepair = transport.putR2.mock.calls.find(
      ([argument]) => argument.key === releasesObject.immutableKey,
    );
    expect(immutableRepair?.[0].source).toBe(candidate.releases);
    expect(transport.r2.get(releasesObject.immutableKey).contents).toEqual(
      candidate.releases,
    );
    expect(
      transport.publicObjects.get(releasesObject.immutableKey).cacheControl,
    ).toBe(releasesObject.immutableCacheControl);
  });

  it("repairs idempotent channel cache metadata with the same exact bytes", async () => {
    const candidate = releaseFixture("0.1.0-rc.12", 0x47);
    const transport = memoryTransport([candidate]);
    transport.storeFixture(candidate, "immutable");
    const releasesObject = candidate.candidate.objects[0];
    const entry = transport.publicObjects.get(releasesObject.channelKey);
    transport.publicObjects.set(releasesObject.channelKey, {
      ...entry,
      cacheControl: "public, max-age=60",
    });
    const evidence = await execute(candidate, transport);
    expect(evidence.decision).toBe("idempotent");
    expect(evidence.operations).toContain(
      "idempotent-channel-releases-metadata-repaired",
    );
    expect(transport.putR2).toHaveBeenCalledTimes(1);
    expect(transport.putR2.mock.calls[0][0].source).toBe(candidate.releases);
    expect(
      transport.publicObjects.get(releasesObject.channelKey).cacheControl,
    ).toBe(releasesObject.channelCacheControl);
  });

  it("fails before mutation when the authoritative decision is unknown", async () => {
    const candidate = releaseFixture("0.1.0-rc.12", 0x45);
    const transport = memoryTransport();
    transport.getR2.mockImplementationOnce(async () =>
      Object.freeze({ state: "unknown" }),
    );
    await expect(execute(candidate, transport)).rejects.toThrow(/unknown/u);
    expect(transport.putR2).not.toHaveBeenCalled();
  });

  it("retries stale public RELEASES and requires the exact no-store policy", async () => {
    const prior = releaseFixture("0.1.0-rc.11", 0x51);
    const candidate = releaseFixture("0.1.0-rc.12", 0x52);
    const transport = memoryTransport([prior]);
    const basePublic = transport.getPublic;
    let staleReads = 2;
    transport.getPublic = vi.fn(async ({ key, role }) => {
      if (
        key === candidate.candidate.objects[0].channelKey &&
        transport.r2.get(key)?.contents.equals(candidate.releases) &&
        staleReads > 0
      ) {
        staleReads -= 1;
        return observation(
          "releases",
          prior.releases,
          prior.candidate.objects[0].channelCacheControl,
        );
      }
      return basePublic({ key, role });
    });
    const wait = vi.fn(async () => {});
    await expect(execute(candidate, transport, { wait })).resolves.toMatchObject({
      decision: "advance",
    });
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("rolls metadata back on persistent stale public readback and keeps both packages", async () => {
    const prior = releaseFixture("0.1.0-rc.11", 0x61);
    const candidate = releaseFixture("0.1.0-rc.12", 0x62);
    const transport = memoryTransport([prior]);
    const basePublic = transport.getPublic;
    transport.getPublic = vi.fn(async ({ key, role }) => {
      if (key === candidate.candidate.objects[0].channelKey) {
        return observation(
          "releases",
          prior.releases,
          prior.candidate.objects[0].channelCacheControl,
        );
      }
      return basePublic({ key, role });
    });
    await expect(execute(candidate, transport)).rejects.toThrow(
      /rollback recovery completed/u,
    );
    expect(
      transport.r2.get(prior.candidate.objects[0].channelKey).contents,
    ).toEqual(prior.releases);
    expect(transport.r2.has(prior.candidate.objects[1].channelKey)).toBe(true);
    expect(transport.r2.has(candidate.candidate.objects[1].channelKey)).toBe(
      true,
    );
    expect(transport.deleteR2).not.toHaveBeenCalled();
  });

  it("removes only first-publication metadata on rollback and keeps the candidate package", async () => {
    const candidate = releaseFixture("0.1.0", 0x71);
    const transport = memoryTransport();
    const basePublic = transport.getPublic;
    transport.getPublic = vi.fn(async ({ key, role }) => {
      if (
        key === candidate.candidate.objects[0].channelKey &&
        transport.r2.has(key)
      ) {
        return Object.freeze({ state: "unknown" });
      }
      return basePublic({ key, role });
    });
    await expect(execute(candidate, transport)).rejects.toThrow(
      /rollback recovery completed/u,
    );
    expect(transport.r2.has(candidate.candidate.objects[0].channelKey)).toBe(
      false,
    );
    expect(transport.r2.has(candidate.candidate.objects[1].channelKey)).toBe(
      true,
    );
    expect(transport.deleteR2).toHaveBeenCalledTimes(1);
  });

  it("does not call a first-publication rollback exact while CDN metadata remains visible", async () => {
    const candidate = releaseFixture("0.1.0", 0x75);
    const transport = memoryTransport();
    const basePublic = transport.getPublic;
    transport.getPublic = vi.fn(async ({ key, role }) => {
      if (key === candidate.candidate.objects[0].channelKey) {
        return observation(
          "releases",
          candidate.releases,
          candidate.candidate.objects[0].immutableCacheControl,
        );
      }
      return basePublic({ key, role });
    });
    await expect(execute(candidate, transport)).rejects.toThrow(
      /exact recovery also failed/u,
    );
    expect(transport.r2.has(candidate.candidate.objects[1].channelKey)).toBe(
      true,
    );
  });

  for (const currentState of ["prior", "missing"]) {
    for (const responseLoss of ["after-commit", "before-commit"]) {
      it(`recovers ${currentState} metadata when put fails ${responseLoss}`, async () => {
        const prior = releaseFixture("0.1.0-rc.11", 0x76);
        const candidate = releaseFixture("0.1.0-rc.12", 0x77);
        const transport = memoryTransport(
          currentState === "prior" ? [prior] : [],
        );
        const basePut = transport.putR2;
        const metadataKey = candidate.candidate.objects[0].channelKey;
        let injected = false;
        transport.putR2 = vi.fn(async (argument) => {
          if (argument.key === metadataKey && !injected) {
            injected = true;
            if (responseLoss === "after-commit") await basePut(argument);
            throw new Error("simulated response loss");
          }
          return basePut(argument);
        });

        await expect(execute(candidate, transport)).rejects.toThrow(
          /exact no-change or rollback recovery completed/u,
        );
        if (currentState === "prior") {
          expect(transport.r2.get(metadataKey).contents).toEqual(prior.releases);
          expect(transport.r2.has(prior.candidate.objects[1].channelKey)).toBe(
            true,
          );
        } else {
          expect(transport.r2.has(metadataKey)).toBe(false);
        }
        expect(
          transport.r2.has(candidate.candidate.objects[1].channelKey),
        ).toBe(true);
      });
    }
  }

  it("accepts a prior-metadata rollback put that commits before response loss", async () => {
    const prior = releaseFixture("0.1.0-rc.11", 0x79);
    const candidate = releaseFixture("0.1.0-rc.12", 0x7a);
    const transport = memoryTransport([prior]);
    const basePut = transport.putR2;
    transport.putR2 = vi.fn(async (argument) => {
      if (argument.source?.kind === "inline-releases") {
        await basePut(argument);
        throw new Error("simulated rollback response loss");
      }
      return basePut(argument);
    });
    const basePublic = transport.getPublic;
    transport.getPublic = vi.fn(async ({ key, role }) => {
      if (key === candidate.candidate.objects[0].channelKey) {
        return observation(
          "releases",
          prior.releases,
          prior.candidate.objects[0].channelCacheControl,
        );
      }
      return basePublic({ key, role });
    });
    await expect(execute(candidate, transport)).rejects.toThrow(
      /rollback recovery completed/u,
    );
    expect(
      transport.r2.get(prior.candidate.objects[0].channelKey).contents,
    ).toEqual(prior.releases);
    expect(transport.r2.has(candidate.candidate.objects[1].channelKey)).toBe(
      true,
    );
  });

  it("accepts a first-publication rollback delete that commits before response loss", async () => {
    const candidate = releaseFixture("0.1.0", 0x7b);
    const transport = memoryTransport();
    const baseDelete = transport.deleteR2;
    transport.deleteR2 = vi.fn(async (argument) => {
      await baseDelete(argument);
      throw new Error("simulated rollback delete response loss");
    });
    const basePublic = transport.getPublic;
    transport.getPublic = vi.fn(async ({ key, role }) => {
      if (
        key === candidate.candidate.objects[0].channelKey &&
        transport.r2.has(key)
      ) {
        return Object.freeze({ state: "unknown" });
      }
      return basePublic({ key, role });
    });
    await expect(execute(candidate, transport)).rejects.toThrow(
      /rollback recovery completed/u,
    );
    expect(transport.r2.has(candidate.candidate.objects[0].channelKey)).toBe(
      false,
    );
    expect(transport.r2.has(candidate.candidate.objects[1].channelKey)).toBe(
      true,
    );
  });

  it("refuses metadata commit without the aggregate recovery window", async () => {
    const candidate = releaseFixture("0.1.0", 0x78);
    const transport = memoryTransport();
    await expect(
      execute(candidate, transport, {
        now: () => 1_000,
        executionDeadline: 1_100,
        minimumMetadataWindowMs: 101,
      }),
    ).rejects.toThrow(/insufficient aggregate deadline/u);
    expect(
      transport.putR2.mock.calls.some(
        ([argument]) => argument.key === candidate.candidate.objects[0].channelKey,
      ),
    ).toBe(false);
    expect(transport.r2.has(candidate.candidate.objects[1].channelKey)).toBe(
      true,
    );
  });

  it("rejects a concurrent current-state change before committing metadata", async () => {
    const prior = releaseFixture("0.1.0-rc.11", 0x72);
    const concurrent = releaseFixture("0.1.0-rc.12", 0x73);
    const candidate = releaseFixture("0.1.0-rc.13", 0x74);
    const transport = memoryTransport([prior]);
    let currentReleasesReads = 0;
    const baseGetR2 = transport.getR2;
    transport.getR2 = vi.fn(async ({ key, role }) => {
      if (key === prior.candidate.objects[0].channelKey) {
        currentReleasesReads += 1;
        if (currentReleasesReads >= 2) {
          transport.storeFixture(concurrent, "channel");
        }
      }
      return baseGetR2({ key, role });
    });
    await expect(execute(candidate, transport)).rejects.toThrow(
      /changed during/u,
    );
    expect(
      transport.putR2.mock.calls.some(
        ([argument]) => argument.role === "releases" && argument.key.includes("/next/"),
      ),
    ).toBe(false);
  });
});
