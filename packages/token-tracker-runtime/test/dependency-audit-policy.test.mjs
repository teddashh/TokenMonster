import { describe, expect, it } from "vitest";

import {
  TEMPORARY_DEV_AUDIT_ADVISORY,
  TEMPORARY_DEV_AUDIT_EXPIRES_AT,
  verifyTemporaryDevAuditException,
} from "../../../scripts/release/verify-temporary-dev-audit-exception.mjs";

const BEFORE_EXPIRY = new Date("2026-07-28T23:59:59.999Z");

function advisory() {
  return {
    source: 1124066,
    name: "sharp",
    dependency: "sharp",
    title:
      "sharp inherited vulnerabilities in libvips: CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591",
    url: "https://github.com/advisories/GHSA-f88m-g3jw-g9cj",
    severity: "high",
    cwe: ["CWE-1395"],
    cvss: { score: 0, vectorString: null },
    range: "<0.35.0",
  };
}

function vulnerability({
  name,
  isDirect,
  via,
  effects,
  range,
  nodes,
}) {
  return {
    name,
    severity: "high",
    isDirect,
    via,
    effects,
    range,
    nodes,
    fixAvailable: {
      name: "@cloudflare/vite-plugin",
      version: "1.2.2",
      isSemVerMajor: true,
    },
  };
}

function auditReport() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      "@cloudflare/vite-plugin": vulnerability({
        name: "@cloudflare/vite-plugin",
        isDirect: true,
        via: ["miniflare", "wrangler"],
        effects: [],
        range: "<=0.0.0-7ae5dd357 || >=1.2.3",
        nodes: ["node_modules/@cloudflare/vite-plugin"],
      }),
      miniflare: vulnerability({
        name: "miniflare",
        isDirect: false,
        via: ["sharp"],
        effects: ["@cloudflare/vite-plugin", "wrangler"],
        range: "<=0.0.0-fec45ed61 || >=4.20250508.3",
        nodes: ["node_modules/miniflare"],
      }),
      sharp: vulnerability({
        name: "sharp",
        isDirect: false,
        via: [advisory()],
        effects: ["miniflare"],
        range: "<0.35.0",
        nodes: ["node_modules/sharp"],
      }),
      wrangler: vulnerability({
        name: "wrangler",
        isDirect: true,
        via: ["miniflare"],
        effects: [],
        range: "<=0.0.0-7ae5dd357 || >=4.16.0",
        nodes: ["node_modules/wrangler"],
      }),
    },
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 4,
        critical: 0,
        total: 4,
      },
      dependencies: {
        prod: 92,
        dev: 442,
        optional: 181,
        peer: 0,
        peerOptional: 0,
        total: 541,
      },
    },
  };
}

function webPackage() {
  return {
    name: "@tokenmonster/web",
    version: "0.1.0",
    dependencies: {
      "@tokenmonster/api": "0.1.0",
      react: "19.2.7",
    },
    devDependencies: {
      "@cloudflare/vite-plugin": "1.45.0",
      vite: "8.1.4",
      wrangler: "4.111.0",
    },
  };
}

function lockfile() {
  return {
    name: "tokenmonster-workspace",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "tokenmonster-workspace",
        version: "0.0.0",
        devDependencies: { vitest: "4.1.10" },
      },
      "apps/web": webPackage(),
      "packages/example": {
        name: "@tokenmonster/example",
        version: "0.1.0",
        dependencies: { zod: "4.4.3" },
      },
      "node_modules/@cloudflare/vite-plugin": {
        version: "1.45.0",
        dev: true,
        dependencies: {
          miniflare: "4.20260710.0",
          wrangler: "4.111.0",
          ws: "8.21.0",
        },
      },
      "node_modules/miniflare": {
        version: "4.20260710.0",
        dev: true,
        dependencies: {
          sharp: "0.34.5",
          undici: "7.28.0",
        },
      },
      "node_modules/sharp": {
        version: "0.34.5",
        dev: true,
        dependencies: { semver: "^7.7.3" },
      },
      "node_modules/wrangler": {
        version: "4.111.0",
        dev: true,
        dependencies: { miniflare: "4.20260710.0" },
      },
    },
  };
}

function input(overrides = {}) {
  return {
    auditReport: auditReport(),
    lockfile: lockfile(),
    webPackage: webPackage(),
    auditExitStatus: 1,
    now: BEFORE_EXPIRY,
    ...overrides,
  };
}

describe("temporary development-only npm audit exception", () => {
  it("accepts only the exact reviewed advisory and dev-only dependency chain", () => {
    expect(verifyTemporaryDevAuditException(input())).toEqual({
      advisory: TEMPORARY_DEV_AUDIT_ADVISORY,
      expiresAt: TEMPORARY_DEV_AUDIT_EXPIRES_AT,
      packages: [
        "@cloudflare/vite-plugin",
        "miniflare",
        "sharp",
        "wrangler",
      ],
    });
  });

  it("rejects a clean audit, unexpected status, malformed report, and expiry", () => {
    const clean = auditReport();
    clean.vulnerabilities = {};
    clean.metadata.vulnerabilities = {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    };
    expect(() =>
      verifyTemporaryDevAuditException(input({ auditReport: clean })),
    ).toThrow(/package set changed/u);
    expect(() =>
      verifyTemporaryDevAuditException(input({ auditExitStatus: 0 })),
    ).toThrow(/exit status must be exactly 1/u);
    expect(() =>
      verifyTemporaryDevAuditException(input({ auditReport: [] })),
    ).toThrow(/audit report must be an object/u);
    expect(() =>
      verifyTemporaryDevAuditException(
        input({ now: new Date("2026-07-29T00:00:00.000Z") }),
      ),
    ).toThrow(/exception expired/u);
  });

  it("rejects extra findings and any advisory identity or severity drift", () => {
    const mutations = [
      (report) => {
        report.vulnerabilities.other = vulnerability({
          name: "other",
          isDirect: false,
          via: ["sharp"],
          effects: [],
          range: "<1.0.0",
          nodes: ["node_modules/other"],
        });
      },
      (report) => {
        report.vulnerabilities.sharp.via[0].source = 1124067;
      },
      (report) => {
        report.vulnerabilities.sharp.via[0].url =
          "https://github.com/advisories/GHSA-not-approved";
      },
      (report) => {
        report.vulnerabilities.sharp.via[0].range = "<0.36.0";
      },
      (report) => {
        report.vulnerabilities.sharp.severity = "critical";
      },
      (report) => {
        report.vulnerabilities.miniflare.via = ["some-other-package"];
      },
    ];
    for (const mutate of mutations) {
      const report = auditReport();
      mutate(report);
      expect(() =>
        verifyTemporaryDevAuditException(input({ auditReport: report })),
      ).toThrow(/changed/u);
    }
  });

  it("rejects lock version, edge, path, and development-flag drift", () => {
    const mutations = [
      (lock) => {
        lock.packages["node_modules/sharp"].version = "0.35.3";
      },
      (lock) => {
        lock.packages["node_modules/sharp"].dev = false;
      },
      (lock) => {
        lock.packages["node_modules/miniflare"].dependencies.sharp = "0.35.3";
      },
      (lock) => {
        lock.packages["node_modules/wrangler/node_modules/sharp"] = {
          version: "0.34.5",
          dev: true,
        };
      },
      (lock) => {
        lock.packages["packages/example"].dependencies.sharp = "0.34.5";
      },
    ];
    for (const mutate of mutations) {
      const lock = lockfile();
      mutate(lock);
      expect(() =>
        verifyTemporaryDevAuditException(input({ lockfile: lock })),
      ).toThrow(/changed|development-only|unexpectedly declares/u);
    }
  });

  it("requires the exact Cloudflare tools as direct web devDependencies only", () => {
    const wrongPin = webPackage();
    wrongPin.devDependencies.wrangler = "4.113.0";
    expect(() =>
      verifyTemporaryDevAuditException(input({ webPackage: wrongPin })),
    ).toThrow(/development pin changed/u);

    const runtimeDependency = webPackage();
    runtimeDependency.dependencies["@cloudflare/vite-plugin"] = "1.45.0";
    expect(() =>
      verifyTemporaryDevAuditException(
        input({ webPackage: runtimeDependency }),
      ),
    ).toThrow(/must not declare/u);

    const directMiniflare = webPackage();
    directMiniflare.devDependencies.miniflare = "4.20260710.0";
    expect(() =>
      verifyTemporaryDevAuditException(input({ webPackage: directMiniflare })),
    ).toThrow(/must not declare/u);
  });
});
