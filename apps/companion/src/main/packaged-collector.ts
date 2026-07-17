import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import { MAX_PACKAGED_COLLECTOR_RESOURCE_BYTES } from "../../packaging/package-bounds.mjs";

const MAX_PATH_BYTES = 4_096;
const MAX_MANIFEST_BYTES = 64 * 1_024;

type ExpectedFile = Readonly<{
  source: string;
  target: string;
  mode: "0755" | "0644";
  executable: boolean;
}>;

const TARGETS = Object.freeze({
  "darwin-x64": Object.freeze({
    package: "@tokscale/cli-darwin-x64",
    files: Object.freeze([
      Object.freeze({
        source: "bin/tokscale",
        target: "tokscale",
        mode: "0755",
        executable: true,
      }),
    ]),
  }),
  "darwin-arm64": Object.freeze({
    package: "@tokscale/cli-darwin-arm64",
    files: Object.freeze([
      Object.freeze({
        source: "bin/tokscale",
        target: "tokscale",
        mode: "0755",
        executable: true,
      }),
      Object.freeze({
        source: "bin/libFoundationModels.dylib",
        target: "libFoundationModels.dylib",
        mode: "0644",
        executable: false,
      }),
    ]),
  }),
  "linux-x64-gnu": Object.freeze({
    package: "@tokscale/cli-linux-x64-gnu",
    files: Object.freeze([
      Object.freeze({
        source: "bin/tokscale",
        target: "tokscale",
        mode: "0755",
        executable: true,
      }),
    ]),
  }),
  "linux-x64-musl": Object.freeze({
    package: "@tokscale/cli-linux-x64-musl",
    files: Object.freeze([
      Object.freeze({
        source: "bin/tokscale",
        target: "tokscale",
        mode: "0755",
        executable: true,
      }),
    ]),
  }),
  "linux-arm64-gnu": Object.freeze({
    package: "@tokscale/cli-linux-arm64-gnu",
    files: Object.freeze([
      Object.freeze({
        source: "bin/tokscale",
        target: "tokscale",
        mode: "0755",
        executable: true,
      }),
    ]),
  }),
  "linux-arm64-musl": Object.freeze({
    package: "@tokscale/cli-linux-arm64-musl",
    files: Object.freeze([
      Object.freeze({
        source: "bin/tokscale",
        target: "tokscale",
        mode: "0755",
        executable: true,
      }),
    ]),
  }),
} as const satisfies Readonly<
  Record<
    string,
    Readonly<{ package: string; files: readonly ExpectedFile[] }>
  >
>);

type SupportedTarget = keyof typeof TARGETS;
type PlainRecord = Record<PropertyKey, unknown>;

function plainRecord(input: unknown): PlainRecord | null {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    return null;
  }
  return input as PlainRecord;
}

function value(record: PlainRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function safeAbsolutePath(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length >= 1 &&
    Buffer.byteLength(input, "utf8") <= MAX_PATH_BYTES &&
    !input.includes("\0") &&
    isAbsolute(input)
  );
}

function currentTarget(): SupportedTarget | null {
  if (
    process.platform === "darwin" &&
    (process.arch === "x64" || process.arch === "arm64")
  ) {
    return `${process.platform}-${process.arch}` as SupportedTarget;
  }
  if (
    process.platform === "linux" &&
    (process.arch === "x64" || process.arch === "arm64")
  ) {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: unknown } }
      | undefined;
    const libc =
      typeof report?.header?.glibcVersionRuntime === "string" ? "gnu" : "musl";
    return `${process.platform}-${process.arch}-${libc}` as SupportedTarget;
  }
  return null;
}

function sameExpectedFile(input: unknown, expected: ExpectedFile): boolean {
  const record = plainRecord(input);
  if (record === null) return false;
  const ownKeys = Object.keys(record).sort();
  return (
    JSON.stringify(ownKeys) ===
      JSON.stringify(["executable", "mode", "sha256", "source", "target"]) &&
    value(record, "source") === expected.source &&
    value(record, "target") === expected.target &&
    value(record, "mode") === expected.mode &&
    value(record, "executable") === expected.executable &&
    typeof value(record, "sha256") === "string" &&
    /^[a-f0-9]{64}$/u.test(value(record, "sha256") as string)
  );
}

function selectedManifestTarget(
  manifest: unknown,
  targetKey: SupportedTarget,
): Readonly<{ files: readonly PlainRecord[] }> | null {
  const root = plainRecord(manifest);
  const collector = plainRecord(root === null ? null : value(root, "collector"));
  const targets = plainRecord(
    collector === null ? null : value(collector, "targets"),
  );
  const selected = plainRecord(
    targets === null ? null : value(targets, targetKey),
  );
  const expected = TARGETS[targetKey];
  const files = selected === null ? null : value(selected, "files");
  if (
    collector === null ||
    selected === null ||
    value(collector, "status") !== "ready" ||
    value(collector, "name") !== "tokscale" ||
    value(collector, "sourceVersion") !== "4.5.2" ||
    value(collector, "versionOutput") !== "tokscale 4.5.2" ||
    value(collector, "extraResourceTarget") !== "collector/tokscale" ||
    value(collector, "runtimeBase") !== "process.resourcesPath" ||
    value(selected, "runtimeEnabled") !== true ||
    value(selected, "package") !== expected.package ||
    value(selected, "packageVersion") !== "4.5.2" ||
    typeof value(selected, "lockIntegrity") !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(
      value(selected, "lockIntegrity") as string,
    ) ||
    !Array.isArray(files) ||
    files.length !== expected.files.length ||
    files.some((file, index) => !sameExpectedFile(file, expected.files[index]!))
  ) {
    return null;
  }
  return Object.freeze({ files: Object.freeze(files as PlainRecord[]) });
}

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Re-verifies the ASAR-protected release policy and every native extraResource
 * before the main process is allowed to hand one fixed absolute binary path to
 * the collector. Any unsupported platform or integrity error returns null.
 */
export async function verifiedPackagedTokscaleBinary(input: Readonly<{
  appPath: string;
  resourcesPath: string;
}>): Promise<string | null> {
  try {
    if (!safeAbsolutePath(input.appPath) || !safeAbsolutePath(input.resourcesPath)) {
      return null;
    }
    const targetKey = currentTarget();
    if (targetKey === null) return null;
    const manifestBytes = await readFile(
      join(input.appPath, "packaging", "runtime-bundle-manifest.json"),
    );
    if (
      manifestBytes.byteLength < 2 ||
      manifestBytes.byteLength > MAX_MANIFEST_BYTES
    ) {
      return null;
    }
    const selected = selectedManifestTarget(
      JSON.parse(manifestBytes.toString("utf8")) as unknown,
      targetKey,
    );
    if (selected === null) return null;

    const resourceRoot = resolve(
      input.resourcesPath,
      "collector",
      "tokscale",
    );
    const rootMetadata = await lstat(resourceRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      return null;
    }
    const canonicalResources = await realpath(input.resourcesPath);
    const canonicalRoot = await realpath(resourceRoot);
    if (!canonicalRoot.startsWith(`${canonicalResources}${sep}`)) return null;

    const entries = await readdir(resourceRoot, { withFileTypes: true });
    const expectedNames = selected.files
      .map((file) => value(file, "target") as string)
      .sort();
    const actualNames = entries.map(({ name }) => name).sort();
    if (
      new Set(expectedNames).size !== expectedNames.length ||
      JSON.stringify(actualNames) !== JSON.stringify(expectedNames)
    ) {
      return null;
    }

    let binaryPath: string | null = null;
    for (const file of selected.files) {
      const target = value(file, "target") as string;
      const path = join(resourceRoot, target);
      const metadata = await lstat(path);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size < 1 ||
        metadata.size > MAX_PACKAGED_COLLECTOR_RESOURCE_BYTES ||
        (metadata.mode & 0o777) !==
          Number.parseInt(value(file, "mode") as string, 8)
      ) {
        return null;
      }
      const contents = await readFile(path);
      if (sha256(contents) !== value(file, "sha256")) return null;
      if (value(file, "executable") === true) {
        if (binaryPath !== null) return null;
        binaryPath = path;
      }
    }
    return binaryPath;
  } catch {
    return null;
  }
}
