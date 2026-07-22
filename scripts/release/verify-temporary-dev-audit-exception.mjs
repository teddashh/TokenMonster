#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TEMPORARY_DEV_AUDIT_ADVISORY = "GHSA-f88m-g3jw-g9cj";
export const TEMPORARY_DEV_AUDIT_EXPIRES_AT = "2026-07-29T00:00:00.000Z";

const ADVISORY_URL =
  "https://github.com/advisories/GHSA-f88m-g3jw-g9cj";
const EXPECTED_VULNERABILITY_NAMES = Object.freeze([
  "@cloudflare/vite-plugin",
  "miniflare",
  "sharp",
  "wrangler",
]);
const EXPECTED_LOCK_PACKAGES = Object.freeze({
  "@cloudflare/vite-plugin": Object.freeze({
    path: "node_modules/@cloudflare/vite-plugin",
    version: "1.45.0",
    dependencies: Object.freeze({
      miniflare: "4.20260710.0",
      wrangler: "4.111.0",
    }),
  }),
  miniflare: Object.freeze({
    path: "node_modules/miniflare",
    version: "4.20260710.0",
    dependencies: Object.freeze({ sharp: "0.34.5" }),
  }),
  sharp: Object.freeze({
    path: "node_modules/sharp",
    version: "0.34.5",
    dependencies: Object.freeze({}),
  }),
  wrangler: Object.freeze({
    path: "node_modules/wrangler",
    version: "4.111.0",
    dependencies: Object.freeze({ miniflare: "4.20260710.0" }),
  }),
});
const EXPECTED_DIRECT_DEV_DEPENDENCIES = Object.freeze({
  "@cloudflare/vite-plugin": "1.45.0",
  wrangler: "4.111.0",
});
const DEPENDENCY_GROUPS = Object.freeze([
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
]);
const EXPIRY_MILLISECONDS = Date.parse(TEMPORARY_DEV_AUDIT_EXPIRES_AT);

function fail(message) {
  throw new Error(`Temporary development audit exception rejected: ${message}`);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactJson(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => exactJson(entry, right[index]))
    );
  }
  if (isPlainRecord(left) || isPlainRecord(right)) {
    if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      exactJson(leftKeys, rightKeys) &&
      leftKeys.every((key) => exactJson(left[key], right[key]))
    );
  }
  return left === right;
}

function requireExact(value, expected, label) {
  if (!exactJson(value, expected)) fail(`${label} changed`);
}

function requireRecord(value, label) {
  if (!isPlainRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requireVulnerability(report, name, expected) {
  const vulnerability = requireRecord(
    report.vulnerabilities[name],
    `${name} vulnerability`,
  );
  requireExact(vulnerability.name, name, `${name} vulnerability name`);
  requireExact(
    vulnerability.severity,
    "high",
    `${name} vulnerability severity`,
  );
  requireExact(
    vulnerability.isDirect,
    expected.isDirect,
    `${name} directness`,
  );
  requireExact(vulnerability.via, expected.via, `${name} advisory path`);
  requireExact(vulnerability.effects, expected.effects, `${name} effects`);
  requireExact(vulnerability.range, expected.range, `${name} affected range`);
  requireExact(vulnerability.nodes, expected.nodes, `${name} install paths`);
}

function verifyAuditReport(auditReport) {
  const report = requireRecord(auditReport, "npm audit report");
  requireExact(report.auditReportVersion, 2, "npm audit report version");
  const vulnerabilities = requireRecord(
    report.vulnerabilities,
    "npm audit vulnerabilities",
  );
  requireExact(
    Object.keys(vulnerabilities).sort(),
    EXPECTED_VULNERABILITY_NAMES,
    "npm audit vulnerability package set",
  );

  const advisory = Object.freeze({
    source: 1124066,
    name: "sharp",
    dependency: "sharp",
    title:
      "sharp inherited vulnerabilities in libvips: CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591",
    url: ADVISORY_URL,
    severity: "high",
    cwe: Object.freeze(["CWE-1395"]),
    cvss: Object.freeze({ score: 0, vectorString: null }),
    range: "<0.35.0",
  });
  requireVulnerability(report, "@cloudflare/vite-plugin", {
    isDirect: true,
    via: ["miniflare", "wrangler"],
    effects: [],
    range: "<=0.0.0-7ae5dd357 || >=1.2.3",
    nodes: ["node_modules/@cloudflare/vite-plugin"],
  });
  requireVulnerability(report, "miniflare", {
    isDirect: false,
    via: ["sharp"],
    effects: ["@cloudflare/vite-plugin", "wrangler"],
    range: "<=0.0.0-fec45ed61 || >=4.20250508.3",
    nodes: ["node_modules/miniflare"],
  });
  requireVulnerability(report, "sharp", {
    isDirect: false,
    via: [advisory],
    effects: ["miniflare"],
    range: "<0.35.0",
    nodes: ["node_modules/sharp"],
  });
  requireVulnerability(report, "wrangler", {
    isDirect: true,
    via: ["miniflare"],
    effects: [],
    range: "<=0.0.0-7ae5dd357 || >=4.16.0",
    nodes: ["node_modules/wrangler"],
  });

  const metadata = requireRecord(report.metadata, "npm audit metadata");
  requireExact(
    metadata.vulnerabilities,
    {
      info: 0,
      low: 0,
      moderate: 0,
      high: 4,
      critical: 0,
      total: 4,
    },
    "npm audit vulnerability totals",
  );
}

function lockPathContainsPackage(lockPath, packageName) {
  const marker = `node_modules/${packageName}`;
  return lockPath === marker || lockPath.endsWith(`/${marker}`);
}

function requireDirectDevOnlyDependencies(manifest, label) {
  const record = requireRecord(manifest, label);
  for (const [name, version] of Object.entries(
    EXPECTED_DIRECT_DEV_DEPENDENCIES,
  )) {
    const developmentDependencies = requireRecord(
      record.devDependencies,
      `${label} devDependencies`,
    );
    requireExact(
      developmentDependencies[name],
      version,
      `${label} ${name} development pin`,
    );
  }
  for (const name of EXPECTED_VULNERABILITY_NAMES) {
    for (const group of DEPENDENCY_GROUPS) {
      const dependencies = record[group];
      if (dependencies === undefined) continue;
      const dependencyRecord = requireRecord(
        dependencies,
        `${label} ${group}`,
      );
      const expectedVersion = EXPECTED_DIRECT_DEV_DEPENDENCIES[name];
      if (group === "devDependencies" && expectedVersion !== undefined) {
        requireExact(
          dependencyRecord[name],
          expectedVersion,
          `${label} ${name} development pin`,
        );
      } else if (Object.hasOwn(dependencyRecord, name)) {
        fail(`${label} must not declare ${name} in ${group}`);
      }
    }
  }
}

function verifyLockfile(lockfile, webPackage) {
  const lock = requireRecord(lockfile, "package lock");
  requireExact(lock.lockfileVersion, 3, "package lock version");
  const packages = requireRecord(lock.packages, "package lock packages");
  const workspace = requireRecord(packages["apps/web"], "apps/web lock entry");
  requireDirectDevOnlyDependencies(workspace, "apps/web lock entry");
  requireDirectDevOnlyDependencies(webPackage, "apps/web package");

  for (const [name, expected] of Object.entries(EXPECTED_LOCK_PACKAGES)) {
    const matchingPaths = Object.keys(packages).filter((lockPath) =>
      lockPathContainsPackage(lockPath, name),
    );
    requireExact(
      matchingPaths,
      [expected.path],
      `${name} package lock path set`,
    );
    const entry = requireRecord(packages[expected.path], `${name} lock entry`);
    requireExact(entry.version, expected.version, `${name} locked version`);
    requireExact(entry.dev, true, `${name} development-only flag`);
    const dependencies = requireRecord(
      entry.dependencies ?? {},
      `${name} lock dependencies`,
    );
    for (const [dependencyName, dependencyVersion] of Object.entries(
      expected.dependencies,
    )) {
      requireExact(
        dependencies[dependencyName],
        dependencyVersion,
        `${name} -> ${dependencyName} lock edge`,
      );
    }
  }

  for (const [lockPath, rawEntry] of Object.entries(packages)) {
    if (lockPath.includes("node_modules") || lockPath === "apps/web") continue;
    if (!isPlainRecord(rawEntry)) continue;
    for (const group of DEPENDENCY_GROUPS) {
      const dependencies = rawEntry[group];
      if (!isPlainRecord(dependencies)) continue;
      for (const name of EXPECTED_VULNERABILITY_NAMES) {
        if (Object.hasOwn(dependencies, name)) {
          fail(`${lockPath || "root"} unexpectedly declares ${name} in ${group}`);
        }
      }
    }
  }
}

export function verifyTemporaryDevAuditException({
  auditReport,
  lockfile,
  webPackage,
  auditExitStatus,
  now = new Date(),
}) {
  if (!Number.isSafeInteger(auditExitStatus) || auditExitStatus !== 1) {
    fail("npm audit exit status must be exactly 1");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail("verification time must be a valid Date");
  }
  if (now.getTime() >= EXPIRY_MILLISECONDS) {
    fail(`exception expired at ${TEMPORARY_DEV_AUDIT_EXPIRES_AT}`);
  }
  verifyAuditReport(auditReport);
  verifyLockfile(lockfile, webPackage);
  return Object.freeze({
    advisory: TEMPORARY_DEV_AUDIT_ADVISORY,
    expiresAt: TEMPORARY_DEV_AUDIT_EXPIRES_AT,
    packages: EXPECTED_VULNERABILITY_NAMES,
  });
}

function parseArguments(argv) {
  const allowed = new Set([
    "--audit",
    "--lock",
    "--web-package",
    "--audit-exit-status",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !allowed.has(name) ||
      value === undefined ||
      value.startsWith("--") ||
      values.has(name)
    ) {
      fail(
        "usage: --audit <json> --lock <json> --web-package <json> --audit-exit-status <integer>",
      );
    }
    values.set(name, value);
  }
  if (values.size !== allowed.size) {
    fail(
      "usage: --audit <json> --lock <json> --web-package <json> --audit-exit-status <integer>",
    );
  }
  const auditExitStatusText = values.get("--audit-exit-status");
  if (!/^(?:0|[1-9][0-9]*)$/u.test(auditExitStatusText)) {
    fail("audit exit status must be a non-negative integer");
  }
  return Object.freeze({
    auditPath: values.get("--audit"),
    lockPath: values.get("--lock"),
    webPackagePath: values.get("--web-package"),
    auditExitStatus: Number(auditExitStatusText),
  });
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [auditText, lockText, webPackageText] = await Promise.all([
    readFile(options.auditPath, "utf8"),
    readFile(options.lockPath, "utf8"),
    readFile(options.webPackagePath, "utf8"),
  ]);
  const result = verifyTemporaryDevAuditException({
    auditReport: parseJson(auditText, "npm audit report"),
    lockfile: parseJson(lockText, "package lock"),
    webPackage: parseJson(webPackageText, "apps/web package"),
    auditExitStatus: options.auditExitStatus,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Audit verification failed");
    process.exitCode = 1;
  });
}
