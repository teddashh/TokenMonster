import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { accessSync, readFileSync, statSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

const APP_BUNDLE_ID = "com.tokenmonster.companion";
const RELEASE_MODE = process.env.TOKENMONSTER_RELEASE_MODE ?? "internal";
const require = createRequire(import.meta.url);

if (RELEASE_MODE !== "internal" && RELEASE_MODE !== "signed") {
  throw new Error("TOKENMONSTER_RELEASE_MODE must be internal or signed.");
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Signed release requires ${name}.`);
  }
  if (value !== value.trim() || /[\r\n\0]/u.test(value)) {
    throw new Error(`Signed release rejected malformed ${name}.`);
  }
  return value;
}

function signedMacConfiguration() {
  if (RELEASE_MODE !== "signed") return {};
  if (process.platform !== "darwin") {
    throw new Error("Signed companion releases must be produced on macOS.");
  }

  const identity = requiredEnvironment("TOKENMONSTER_MAC_DEVELOPER_ID");
  const appleApiKey = requiredEnvironment("TOKENMONSTER_APPLE_API_KEY_PATH");
  const appleApiKeyId = requiredEnvironment("TOKENMONSTER_APPLE_API_KEY_ID");
  const appleApiIssuer = requiredEnvironment(
    "TOKENMONSTER_APPLE_API_ISSUER_ID"
  );
  const teamId = requiredEnvironment("TOKENMONSTER_APPLE_TEAM_ID");

  if (!/^[A-Z0-9]{10}$/u.test(teamId)) {
    throw new Error("TOKENMONSTER_APPLE_TEAM_ID has an invalid shape.");
  }
  if (!/^[A-Z0-9]{10}$/u.test(appleApiKeyId)) {
    throw new Error("TOKENMONSTER_APPLE_API_KEY_ID has an invalid shape.");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      appleApiIssuer
    )
  ) {
    throw new Error("TOKENMONSTER_APPLE_API_ISSUER_ID has an invalid shape.");
  }
  if (
    !identity.startsWith("Developer ID Application: ") ||
    !identity.endsWith(` (${teamId})`) ||
    identity.length > 256
  ) {
    throw new Error(
      "TOKENMONSTER_MAC_DEVELOPER_ID must be a Developer ID Application identity for the configured team."
    );
  }
  if (!isAbsolute(appleApiKey)) {
    throw new Error("TOKENMONSTER_APPLE_API_KEY_PATH must be absolute.");
  }
  accessSync(appleApiKey, constants.R_OK);
  const keyStat = statSync(appleApiKey);
  if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0) {
    throw new Error(
      "TOKENMONSTER_APPLE_API_KEY_PATH must name a private regular file with mode 0600 or stricter."
    );
  }

  return {
    osxSign: {
      identity,
      hardenedRuntime: true
    },
    osxNotarize: {
      tool: "notarytool",
      appleApiKey,
      appleApiKeyId,
      appleApiIssuer
    }
  };
}

function ignoreOutsideRuntime(path) {
  const normalized = path.replaceAll("\\", "/");
  return !(
    normalized === "" ||
    normalized === "/" ||
    normalized === "/README.md" ||
    normalized === "/package.json" ||
    normalized === "/dist" ||
    normalized.startsWith("/dist/") ||
    normalized === "/packaging" ||
    normalized === "/packaging/runtime-bundle-manifest.json" ||
    normalized === "/packaging/TOKSCALE_LICENSE.txt"
  );
}

async function findRuntimeSnapshots(directory, depth = 0) {
  if (depth > 8) {
    throw new Error("Electron runtime snapshot search exceeded its depth bound.");
  }
  const snapshots = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) continue;
    if (metadata.isDirectory()) {
      snapshots.push(...(await findRuntimeSnapshots(path, depth + 1)));
    } else if (
      metadata.isFile() &&
      entry.name === "v8_context_snapshot.bin"
    ) {
      snapshots.push(path);
    }
  }
  return snapshots;
}

async function prepareBrowserProcessSnapshots(
  _forgeConfig,
  resourcesAppPath,
  electronVersion
) {
  if (electronVersion !== "43.1.1") {
    throw new Error("Electron snapshot preparation requires exact 43.1.1.");
  }
  const bundleRoot = resolve(resourcesAppPath, "..", "..");
  const sources = await findRuntimeSnapshots(bundleRoot);
  if (sources.length < 1 || sources.length > 2) {
    throw new Error(
      `Expected one or two Electron V8 context snapshots, found ${sources.length}.`
    );
  }
  for (const source of sources) {
    const destination = join(dirname(source), "browser_v8_context_snapshot.bin");
    try {
      await lstat(destination);
      throw new Error("Electron browser V8 snapshot already exists unexpectedly.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  }
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function linuxLibcSuffix() {
  const report = process.report?.getReport();
  return typeof report?.header?.glibcVersionRuntime === "string"
    ? "gnu"
    : "musl";
}

function collectorTargetKey(platform, arch) {
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(
      "Collector packaging requires a native host build so its exact version can be executed and verified."
    );
  }
  if (platform === "darwin" && (arch === "x64" || arch === "arm64")) {
    return `${platform}-${arch}`;
  }
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    return `${platform}-${arch}-${linuxLibcSuffix()}`;
  }
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) {
    return `${platform}-${arch}-msvc`;
  }
  throw new Error(`No audited collector package target exists for ${platform}-${arch}.`);
}

function safeManifestTarget(targetKey) {
  const target = runtimeManifest.collector?.targets?.[targetKey];
  if (
    target === null ||
    typeof target !== "object" ||
    target.runtimeEnabled !== true ||
    typeof target.package !== "string" ||
    !/^@tokscale\/cli-[a-z0-9-]+$/u.test(target.package) ||
    target.packageVersion !== runtimeManifest.collector.sourceVersion ||
    typeof target.lockIntegrity !== "string" ||
    !Array.isArray(target.files) ||
    target.files.length < 1 ||
    target.files.length > 2
  ) {
    const reason =
      typeof target?.blockedReason === "string"
        ? ` ${target.blockedReason}`
        : "";
    throw new Error(`Collector target ${targetKey} is not release-enabled.${reason}`);
  }
  return target;
}

function assertLockedCollectorPackage(target) {
  const lockEntry = packageLock.packages?.[`node_modules/${target.package}`];
  if (
    lockEntry === null ||
    typeof lockEntry !== "object" ||
    lockEntry.version !== target.packageVersion ||
    lockEntry.integrity !== target.lockIntegrity
  ) {
    throw new Error(
      `Collector package-lock evidence does not match ${target.package}@${target.packageVersion}.`
    );
  }
}

async function verifiedPackageFile(packageDirectory, specification) {
  if (
    specification === null ||
    typeof specification !== "object" ||
    typeof specification.source !== "string" ||
    !/^bin\/[A-Za-z0-9._-]+$/u.test(specification.source) ||
    typeof specification.target !== "string" ||
    !/^[A-Za-z0-9._-]+$/u.test(specification.target) ||
    typeof specification.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(specification.sha256) ||
    (specification.mode !== "0755" && specification.mode !== "0644") ||
    typeof specification.executable !== "boolean"
  ) {
    throw new Error("Collector runtime manifest contains an unsafe file entry.");
  }
  const packageRoot = await realpath(packageDirectory);
  const source = resolve(packageDirectory, specification.source);
  const sourceRealPath = await realpath(source);
  if (!sourceRealPath.startsWith(`${packageRoot}${sep}`)) {
    throw new Error("Collector package file escaped its package root.");
  }
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Collector package file is not a regular file.");
  }
  if (specification.executable && (metadata.mode & 0o111) === 0) {
    throw new Error("Collector package binary is not executable.");
  }
  const contents = readFileSync(source);
  if (sha256(contents) !== specification.sha256) {
    throw new Error(
      `Collector package checksum mismatch for ${specification.source}.`
    );
  }
  return { source, specification };
}

async function prepareVerifiedCollectorExtraResource(
  resourcesAppPath,
  platform,
  arch
) {
  if (runtimeManifest.collector?.status !== "ready") {
    throw new Error("Collector runtime manifest is not release-ready.");
  }
  const targetKey = collectorTargetKey(platform, arch);
  const target = safeManifestTarget(targetKey);
  assertLockedCollectorPackage(target);

  let packageManifestPath;
  try {
    packageManifestPath = require.resolve(`${target.package}/package.json`);
  } catch {
    throw new Error(
      `The exact optional collector package ${target.package}@${target.packageVersion} is not installed.`
    );
  }
  const packageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
  if (
    packageManifest.name !== target.package ||
    packageManifest.version !== target.packageVersion
  ) {
    throw new Error("Installed collector package identity is invalid.");
  }
  const packageDirectory = dirname(packageManifestPath);
  const files = [];
  const targetNames = new Set();
  for (const specification of target.files) {
    if (targetNames.has(specification.target)) {
      throw new Error("Collector runtime manifest contains duplicate targets.");
    }
    targetNames.add(specification.target);
    files.push(await verifiedPackageFile(packageDirectory, specification));
  }

  const resourcesDirectory = resolve(resourcesAppPath, "..");
  const targetDirectory = resolve(
    resourcesDirectory,
    ...runtimeManifest.collector.extraResourceTarget.split("/")
  );
  if (!targetDirectory.startsWith(`${resourcesDirectory}${sep}`)) {
    throw new Error("Collector extraResource target escaped the app resources.");
  }
  await rm(targetDirectory, { force: true, recursive: true });
  await mkdir(targetDirectory, { mode: 0o755, recursive: true });
  for (const { source, specification } of files) {
    const destination = join(targetDirectory, specification.target);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await chmod(destination, Number.parseInt(specification.mode, 8));
    const copied = readFileSync(destination);
    if (sha256(copied) !== specification.sha256) {
      throw new Error("Copied collector resource failed checksum verification.");
    }
  }

  if (target.files.filter(({ executable }) => executable).length !== 1) {
    throw new Error("Collector target must declare exactly one executable.");
  }
}

async function prepareRuntimeResources(
  forgeConfig,
  resourcesAppPath,
  electronVersion,
  platform,
  arch
) {
  await prepareBrowserProcessSnapshots(
    forgeConfig,
    resourcesAppPath,
    electronVersion
  );
  await prepareVerifiedCollectorExtraResource(
    resourcesAppPath,
    platform,
    arch
  );
}

async function removeGroupWorldWrite(path, depth = 0, counter = { value: 0 }) {
  if (depth > 16 || counter.value > 512) {
    throw new Error("Packaged permission hardening exceeded its inventory bound.");
  }
  counter.value += 1;
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    for (const entry of await readdir(path)) {
      await removeGroupWorldWrite(join(path, entry), depth + 1, counter);
    }
  } else if (!metadata.isFile()) {
    throw new Error("Packaged application contains a non-regular entry.");
  }
  if ((metadata.mode & 0o7000) !== 0) {
    throw new Error("Packaged application requested a privileged mode bit.");
  }
  const hardenedMode = metadata.mode & 0o777 & ~0o022;
  await chmod(path, hardenedMode);
}

async function hardenPackagedPermissions(_forgeConfig, packageResult) {
  if (!Array.isArray(packageResult?.outputPaths) || packageResult.outputPaths.length < 1) {
    throw new Error("Forge returned no package output for permission hardening.");
  }
  for (const outputPath of packageResult.outputPaths) {
    await removeGroupWorldWrite(outputPath);
  }
}

const signedConfiguration = signedMacConfiguration();
const runtimeManifest = JSON.parse(
  readFileSync(
    new URL("packaging/runtime-bundle-manifest.json", import.meta.url),
    "utf8"
  )
);
const packageLock = JSON.parse(
  readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8")
);
if (
  RELEASE_MODE === "signed" &&
  (runtimeManifest.collector?.status !== "ready" ||
    runtimeManifest.collector?.signedReleaseStatus !== "ready")
) {
  throw new Error(
    `Signed release blocked by collector state: ${runtimeManifest.collector?.signedReleaseStatus ?? runtimeManifest.collector?.status ?? "missing"}.`
  );
}

const config = {
  hooks: {
    packageAfterCopy: prepareRuntimeResources,
    postPackage: hardenPackagedPermissions
  },
  packagerConfig: {
    appBundleId: APP_BUNDLE_ID,
    appCategoryType: "public.app-category.utilities",
    asar: true,
    executableName: "TokenMonster",
    ignore: ignoreOutsideRuntime,
    name: "TokenMonster",
    overwrite: true,
    prune: false,
    ...signedConfiguration
  },
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin", "linux", "win32"]
    },
    {
      name: "@electron-forge/maker-dmg",
      config: {
        format: "ULFO",
        name: "TokenMonster"
      },
      platforms: ["darwin"]
    }
  ],
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      strictlyRequireAllFuses: false,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
    })
  ]
};

export default config;
