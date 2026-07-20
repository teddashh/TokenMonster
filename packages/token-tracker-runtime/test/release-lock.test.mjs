import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  assertSidecarClosuresMatch,
  collectSidecarClosure,
  createReleaseShrinkwrap,
  mergeSharedRegistryLockEntry,
} from "../../../scripts/release/sidecar-lock.mjs";

const rootLock = JSON.parse(
  await readFile(new URL("../../../package-lock.json", import.meta.url), "utf8"),
);
const sidecarPin = "0.80.0";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFixedPackShrinkwrap() {
  return createReleaseShrinkwrap({
    rootLock,
    releaseManifest: {
      name: "tokenmonster",
      version: "0.1.0-rc.fixed-pack",
      dependencies: {
        "@tokenmonster/token-tracker-runtime": "0.1.0",
        pend: "1.2.0",
        "tokentracker-cli": sidecarPin,
        yauzl: "3.4.0",
      },
      bundleDependencies: [
        "@tokenmonster/token-tracker-runtime",
        "pend",
        "yauzl",
      ],
    },
    bundledManifests: [
      {
        name: "@tokenmonster/token-tracker-runtime",
        version: "0.1.0",
        dependencies: { "tokentracker-cli": sidecarPin },
      },
      { name: "pend", version: "1.2.0" },
      {
        name: "yauzl",
        version: "3.4.0",
        dependencies: { pend: "~1.2.0" },
        engines: { node: ">=12" },
      },
    ],
  });
}

describe("public CLI sidecar shrinkwrap", () => {
  it("derives the complete exact registry closure from the repository lock", () => {
    const closure = collectSidecarClosure(rootLock, sidecarPin);
    expect(closure).toHaveLength(41);
    expect(
      closure.map(({ name, version }) => `${name}@${version}`),
    ).toEqual(
      expect.arrayContaining([
        "tokentracker-cli@0.80.0",
        "@mongodb-js/zstd@2.0.1",
        "undici@8.7.0",
        "yauzl@3.4.0",
        "prebuild-install@7.1.3",
      ]),
    );
    expect(
      closure.every(
        ({ resolved, integrity }) =>
          resolved.startsWith("https://registry.npmjs.org/") &&
          integrity.startsWith("sha512-"),
      ),
    ).toBe(true);
  });

  it("builds a publishable lock that keeps bundled packages separate", () => {
    const releaseManifest = {
      name: "tokenmonster",
      version: "0.1.0-rc.test",
      bin: { tokenmonster: "dist/bin.js" },
      engines: { node: ">=20" },
      dependencies: {
        "@tokenmonster/token-tracker-runtime": "0.1.0",
        "tokentracker-cli": sidecarPin,
        zod: "4.4.3",
      },
      bundleDependencies: [
        "@tokenmonster/token-tracker-runtime",
        "zod",
      ],
    };
    const shrinkwrap = createReleaseShrinkwrap({
      rootLock,
      releaseManifest,
      bundledManifests: [
        {
          name: "@tokenmonster/token-tracker-runtime",
          version: "0.1.0",
          dependencies: { "tokentracker-cli": sidecarPin },
        },
        { name: "zod", version: "4.4.3" },
      ],
    });

    expect(shrinkwrap).toMatchObject({
      name: "tokenmonster",
      version: "0.1.0-rc.test",
      lockfileVersion: 3,
      requires: true,
    });
    expect(
      shrinkwrap.packages["node_modules/@tokenmonster/token-tracker-runtime"],
    ).toMatchObject({ version: "0.1.0", inBundle: true });
    expect(shrinkwrap.packages["node_modules/tokentracker-cli"]).toMatchObject({
      version: sidecarPin,
      integrity:
        "sha512-rm6HdcLeq4uWPPo6ikIpnmVyyCD/Y22iune5ZeVP0FJ34P9XmFDAeX2DldyPouzy1PJ4W6o0JraSzjJp6iVX3w==",
    });
  });

  it("reuses an exact provenance-bearing bundled transitive dependency", () => {
    const shrinkwrap = createFixedPackShrinkwrap();
    const expectedPend = rootLock.packages["node_modules/pend"];

    expect(shrinkwrap.packages["node_modules/pend"]).toEqual({
      ...expectedPend,
      inBundle: true,
    });
    const closure = collectSidecarClosure(shrinkwrap, sidecarPin);
    expect(
      closure.find(({ path }) => path === "node_modules/pend")?.entry,
    ).toMatchObject({
      version: "1.2.0",
      resolved: expectedPend.resolved,
      integrity: expectedPend.integrity,
      inBundle: true,
    });
    expect(() =>
      assertSidecarClosuresMatch({
        expectedLock: shrinkwrap,
        actualLock: clone(shrinkwrap),
        actualParentPath: "",
        sidecarPin,
      }),
    ).not.toThrow();
  });

  it("rejects every mismatched shared bundled registry identity", () => {
    const path = "node_modules/pend";
    const sidecarEntry = clone(rootLock.packages[path]);
    const bundledEntry = { ...clone(sidecarEntry), inBundle: true };
    const merge = (overrides = {}) =>
      mergeSharedRegistryLockEntry({
        bundledPath: path,
        bundledEntry,
        sidecarPath: path,
        sidecarEntry,
        ...overrides,
      });

    expect(merge()).toEqual(bundledEntry);
    expect(() =>
      merge({
        sidecarEntry: { ...sidecarEntry, version: "1.2.1" },
      }),
    ).toThrow(/identity differs/u);
    expect(() =>
      merge({
        sidecarEntry: {
          ...sidecarEntry,
          integrity:
            "sha512-rm6HdcLeq4uWPPo6ikIpnmVyyCD/Y22iune5ZeVP0FJ34P9XmFDAeX2DldyPouzy1PJ4W6o0JraSzjJp6iVX3w==",
        },
      }),
    ).toThrow(/identity differs/u);
    expect(() =>
      merge({
        sidecarEntry: {
          ...sidecarEntry,
          dependencies: { unexpected: "1.0.0" },
        },
      }),
    ).toThrow(/identity differs/u);
    expect(() =>
      merge({
        sidecarPath: "node_modules/tokentracker-cli/node_modules/pend",
      }),
    ).toThrow(/does not match bundled path/u);
  });

  it("does not accept an integrity-free bundled entry as registry provenance", () => {
    const shrinkwrap = createFixedPackShrinkwrap();
    delete shrinkwrap.packages["node_modules/pend"].integrity;

    expect(() => collectSidecarClosure(shrinkwrap, sidecarPin)).toThrow(
      /integrity/u,
    );
  });

  it("fails closed when the repository lock loses integrity or a dependency", () => {
    const missingIntegrity = clone(rootLock);
    delete missingIntegrity.packages["node_modules/tokentracker-cli"].integrity;
    expect(() => collectSidecarClosure(missingIntegrity, sidecarPin)).toThrow(
      /integrity/u,
    );

    const missingDependency = clone(rootLock);
    delete missingDependency.packages["node_modules/tokentracker-cli/node_modules/undici"];
    expect(() => collectSidecarClosure(missingDependency, sidecarPin)).toThrow(
      /undici.*production registry package/u,
    );

    expect(() =>
      collectSidecarClosure(rootLock, sidecarPin, "node_modules/../escape"),
    ).toThrow(/Invalid package-lock path/u);
  });

  it("rejects an installed tree with a substituted transitive package", () => {
    const expectedLock = createReleaseShrinkwrap({
      rootLock,
      releaseManifest: {
        name: "tokenmonster",
        version: "0.1.0",
        dependencies: {
          "@tokenmonster/token-tracker-runtime": "0.1.0",
          "tokentracker-cli": sidecarPin,
        },
        bundleDependencies: ["@tokenmonster/token-tracker-runtime"],
      },
      bundledManifests: [
        {
          name: "@tokenmonster/token-tracker-runtime",
          version: "0.1.0",
          dependencies: { "tokentracker-cli": sidecarPin },
        },
      ],
    });
    const actualLock = clone(expectedLock);
    actualLock.packages["node_modules/tokentracker-cli/node_modules/undici"].version =
      "8.7.1";

    expect(() =>
      assertSidecarClosuresMatch({
        expectedLock,
        actualLock,
        actualParentPath: "",
        sidecarPin,
      }),
    ).toThrow(/differs from shrinkwrap/u);
  });
});
