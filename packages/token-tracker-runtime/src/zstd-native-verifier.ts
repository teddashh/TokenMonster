import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import rawPolicy from "./zstd-native-policy.json" with { type: "json" };

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EXPECTED_PLATFORM_KEYS = Object.freeze([
  "linux-x64",
  "darwin-arm64",
  "win32-x64"
] as const);
const EXPECTED_BINDING_PATH = "build/Release/zstd.node";
const EXPECTED_DEPENDENCY = Object.freeze({
  sidecarPackage: "tokentracker-cli",
  sidecarVersion: "0.80.0",
  nativePackage: "@mongodb-js/zstd",
  nativeVersion: "2.0.1",
  sidecarDependencySpecifier: "^2.0.1"
} as const);
const EXPECTED_SOURCE = Object.freeze({
  repositoryUrl: "https://github.com/mongodb-js/zstd",
  releaseTag: "v2.0.1",
  releaseAssetBaseUrl:
    "https://github.com/mongodb-js/zstd/releases/download/v2.0.1",
  signingKeyUrl: "https://pgp.mongodb.com/node-driver.asc",
  signingKeyFingerprint: "9CABA99E47FA20E21F8409E5C6666E424A119C64",
  napiVersion: 4
} as const);

export type ZstdNativePlatformKey =
  (typeof EXPECTED_PLATFORM_KEYS)[number];

export interface ZstdNativePlatformPolicy {
  readonly platform: string;
  readonly arch: string;
  readonly archiveName: string;
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly bindingPath: "build/Release/zstd.node";
  readonly bindingBytes: number;
  readonly bindingSha256: string;
}

export interface ZstdNativePolicy {
  readonly schemaVersion: "1";
  readonly dependency: typeof EXPECTED_DEPENDENCY;
  readonly source: typeof EXPECTED_SOURCE;
  readonly runtimeVerifier: Readonly<{
    archiveEntry: "node_modules/@tokenmonster/token-tracker-runtime/dist/zstd-native-verifier.js";
    sha256: string;
  }>;
  readonly platforms: Readonly<
    Record<ZstdNativePlatformKey, ZstdNativePlatformPolicy>
  >;
}

export interface InstalledZstdNativeEvidence {
  readonly platformKey: ZstdNativePlatformKey;
  readonly sidecar: "tokentracker-cli@0.80.0";
  readonly nativePackage: "@mongodb-js/zstd@2.0.1";
  readonly bindingPath: "build/Release/zstd.node";
  readonly bindingBytes: number;
  readonly bindingSha256: string;
}

interface VerifyInstalledZstdNativeOptions {
  readonly sidecarPackageDirectory: string;
  readonly zstdPackageDirectory: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly policy?: ZstdNativePolicy;
}

interface VerifyFromSidecarManifestOptions {
  readonly sidecarManifestPath: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly policy?: ZstdNativePolicy;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function requireExactKeys(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  const record = requireRecord(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must contain exactly ${keys.join(", ")}`);
  }
  return record;
}

function requireExactValue<T>(value: unknown, expected: T, label: string): T {
  if (value !== expected) {
    throw new Error(`${label} must be ${JSON.stringify(expected)}`);
  }
  return expected;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
}

export function validateZstdNativePolicy(raw: unknown): ZstdNativePolicy {
  const policy = requireExactKeys(
    raw,
    ["schemaVersion", "dependency", "source", "runtimeVerifier", "platforms"],
    "zstd native policy"
  );
  requireExactValue(policy["schemaVersion"], "1", "policy schemaVersion");

  const dependency = requireExactKeys(
    policy["dependency"],
    Object.keys(EXPECTED_DEPENDENCY),
    "policy dependency"
  );
  for (const [field, expected] of Object.entries(EXPECTED_DEPENDENCY)) {
    requireExactValue(
      dependency[field],
      expected,
      `policy dependency.${field}`
    );
  }

  const source = requireExactKeys(
    policy["source"],
    Object.keys(EXPECTED_SOURCE),
    "policy source"
  );
  for (const [field, expected] of Object.entries(EXPECTED_SOURCE)) {
    requireExactValue(source[field], expected, `policy source.${field}`);
  }

  const runtimeVerifier = requireExactKeys(
    policy["runtimeVerifier"],
    ["archiveEntry", "sha256"],
    "policy runtimeVerifier"
  );
  requireExactValue(
    runtimeVerifier["archiveEntry"],
    "node_modules/@tokenmonster/token-tracker-runtime/dist/zstd-native-verifier.js",
    "policy runtimeVerifier.archiveEntry"
  );
  requireSha256(
    runtimeVerifier["sha256"],
    "policy runtimeVerifier.sha256"
  );

  const platforms = requireExactKeys(
    policy["platforms"],
    EXPECTED_PLATFORM_KEYS,
    "policy platforms"
  );
  for (const platformKey of EXPECTED_PLATFORM_KEYS) {
    const entry = requireExactKeys(
      platforms[platformKey],
      [
        "platform",
        "arch",
        "archiveName",
        "archiveBytes",
        "archiveSha256",
        "bindingPath",
        "bindingBytes",
        "bindingSha256"
      ],
      `policy platforms.${platformKey}`
    );
    const [expectedPlatform, expectedArch] = platformKey.split("-");
    requireExactValue(
      entry["platform"],
      expectedPlatform,
      `policy platforms.${platformKey}.platform`
    );
    requireExactValue(
      entry["arch"],
      expectedArch,
      `policy platforms.${platformKey}.arch`
    );
    const expectedArchiveName =
      `zstd-${EXPECTED_SOURCE.releaseTag}-napi-v${EXPECTED_SOURCE.napiVersion}-${platformKey}.tar.gz`;
    requireExactValue(
      entry["archiveName"],
      expectedArchiveName,
      `policy platforms.${platformKey}.archiveName`
    );
    requirePositiveInteger(
      entry["archiveBytes"],
      `policy platforms.${platformKey}.archiveBytes`
    );
    requireSha256(
      entry["archiveSha256"],
      `policy platforms.${platformKey}.archiveSha256`
    );
    requireExactValue(
      entry["bindingPath"],
      EXPECTED_BINDING_PATH,
      `policy platforms.${platformKey}.bindingPath`
    );
    requirePositiveInteger(
      entry["bindingBytes"],
      `policy platforms.${platformKey}.bindingBytes`
    );
    requireSha256(
      entry["bindingSha256"],
      `policy platforms.${platformKey}.bindingSha256`
    );
  }
  deepFreeze(policy);
  return policy as unknown as ZstdNativePolicy;
}

export const ZSTD_NATIVE_POLICY = validateZstdNativePolicy(rawPolicy);

async function readRegularFile(path: string, label: string): Promise<Buffer> {
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error(`${label} must be a regular non-symbolic file`);
  }
  return readFile(path);
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  const bytes = await readRegularFile(path, label);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
}

async function requireDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error(`${label} must be a regular non-symbolic directory`);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectStream);
    stream.once("end", resolveStream);
  });
  return hash.digest("hex");
}

export function loadZstdNativePolicy(): ZstdNativePolicy {
  return ZSTD_NATIVE_POLICY;
}

export function zstdNativePlatformKey(
  platform: string = process.platform,
  arch: string = process.arch
): string {
  return `${platform}-${arch}`;
}

export function zstdNativePlatformPolicy(
  policy: ZstdNativePolicy,
  platform: string,
  arch: string
): Readonly<{
  platformKey: ZstdNativePlatformKey;
  entry: ZstdNativePlatformPolicy;
}> {
  const validatedPolicy = validateZstdNativePolicy(policy);
  const platformKey = zstdNativePlatformKey(platform, arch);
  const entry = (validatedPolicy.platforms as Readonly<Record<string, ZstdNativePlatformPolicy>>)[
    platformKey
  ];
  if (entry === undefined) {
    throw new Error(
      `Unsupported zstd native platform ${platformKey}; expected one of ${EXPECTED_PLATFORM_KEYS.join(", ")}`
    );
  }
  return Object.freeze({
    platformKey: platformKey as ZstdNativePlatformKey,
    entry
  });
}

export function zstdNativeArchiveUrl(
  policy: ZstdNativePolicy,
  platformEntry: ZstdNativePlatformPolicy
): string {
  const validatedPolicy = validateZstdNativePolicy(policy);
  if (!Object.values(validatedPolicy.platforms).includes(platformEntry)) {
    throw new Error(
      "zstd platform entry does not belong to the validated policy"
    );
  }
  return `${validatedPolicy.source.releaseAssetBaseUrl}/${platformEntry.archiveName}`;
}

export async function verifyInstalledZstdNative({
  sidecarPackageDirectory,
  zstdPackageDirectory,
  platform = process.platform,
  arch = process.arch,
  policy = ZSTD_NATIVE_POLICY
}: VerifyInstalledZstdNativeOptions): Promise<InstalledZstdNativeEvidence> {
  if (
    sidecarPackageDirectory.length === 0 ||
    zstdPackageDirectory.length === 0
  ) {
    throw new Error(
      "Installed zstd verification requires both package directories"
    );
  }
  const validatedPolicy = validateZstdNativePolicy(policy);
  const { platformKey, entry } = zstdNativePlatformPolicy(
    validatedPolicy,
    platform,
    arch
  );

  await requireDirectory(sidecarPackageDirectory, "installed sidecar package");
  await requireDirectory(zstdPackageDirectory, "installed zstd package");
  const sidecarManifest = requireRecord(
    await readJsonFile(
      join(sidecarPackageDirectory, "package.json"),
      "installed sidecar package manifest"
    ),
    "installed sidecar package manifest"
  );
  const zstdManifest = requireRecord(
    await readJsonFile(
      join(zstdPackageDirectory, "package.json"),
      "installed zstd package manifest"
    ),
    "installed zstd package manifest"
  );
  const dependency = validatedPolicy.dependency;
  requireExactValue(
    sidecarManifest["name"],
    dependency.sidecarPackage,
    "installed sidecar package name"
  );
  requireExactValue(
    sidecarManifest["version"],
    dependency.sidecarVersion,
    "installed sidecar package version"
  );
  const sidecarDependencies = requireRecord(
    sidecarManifest["dependencies"],
    "installed sidecar dependencies"
  );
  requireExactValue(
    sidecarDependencies[dependency.nativePackage],
    dependency.sidecarDependencySpecifier,
    `installed sidecar dependency ${dependency.nativePackage}`
  );
  requireExactValue(
    zstdManifest["name"],
    dependency.nativePackage,
    "installed zstd package name"
  );
  requireExactValue(
    zstdManifest["version"],
    dependency.nativeVersion,
    "installed zstd package version"
  );

  const bindingSegments = entry.bindingPath.split("/");
  let bindingParent = zstdPackageDirectory;
  for (const segment of bindingSegments.slice(0, -1)) {
    bindingParent = join(bindingParent, segment);
    await requireDirectory(
      bindingParent,
      `installed zstd binding directory ${segment}`
    );
  }
  const bindingPath = join(zstdPackageDirectory, ...bindingSegments);
  const bindingMetadata = await lstat(bindingPath).catch(() => null);
  if (
    bindingMetadata === null ||
    !bindingMetadata.isFile() ||
    bindingMetadata.isSymbolicLink()
  ) {
    throw new Error(
      "installed zstd native binding must be a regular non-symbolic file"
    );
  }
  if (bindingMetadata.size !== entry.bindingBytes) {
    throw new Error(
      `installed zstd native binding byte length differs from policy for ${platformKey}`
    );
  }
  const digest = await sha256File(bindingPath);
  if (digest !== entry.bindingSha256) {
    throw new Error(
      `installed zstd native binding SHA-256 differs from policy for ${platformKey}`
    );
  }

  return Object.freeze({
    platformKey,
    sidecar: "tokentracker-cli@0.80.0",
    nativePackage: "@mongodb-js/zstd@2.0.1",
    bindingPath: entry.bindingPath,
    bindingBytes: entry.bindingBytes,
    bindingSha256: digest
  });
}

export async function verifyInstalledZstdNativeFromSidecarManifest({
  sidecarManifestPath,
  platform = process.platform,
  arch = process.arch,
  policy = ZSTD_NATIVE_POLICY
}: VerifyFromSidecarManifestOptions): Promise<InstalledZstdNativeEvidence> {
  await readRegularFile(sidecarManifestPath, "installed sidecar package manifest");
  let zstdManifestPath: string;
  try {
    const require = createRequire(sidecarManifestPath);
    zstdManifestPath = require.resolve("@mongodb-js/zstd/package.json");
  } catch {
    throw new Error("installed sidecar cannot resolve its zstd dependency");
  }
  return verifyInstalledZstdNative({
    sidecarPackageDirectory: dirname(sidecarManifestPath),
    zstdPackageDirectory: dirname(zstdManifestPath),
    platform,
    arch,
    policy
  });
}
