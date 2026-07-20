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
import { fileURLToPath } from "node:url";

import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

import {
  declaredSidecarPackageFiles,
  SIDECAR_MAX_FILE_COUNT,
  SIDECAR_MAX_TOTAL_BYTES,
  SIDECAR_MAX_TREE_DEPTH,
  SIDECAR_ROOT_LOCK_PATH,
  sidecarDependencyClosure
} from "../../scripts/companion-packaging-policy.mjs";
import {
  packageJsonWithReleaseVersion,
  prepareWindowsSigningEnvironment,
  requireReleaseVersion
} from "./packaging/release-policy.mjs";

const APP_BUNDLE_ID = "com.tokenmonster.companion";
const RELEASE_MODE = process.env.TOKENMONSTER_RELEASE_MODE ?? "internal";
const require = createRequire(import.meta.url);
const packageManifest = JSON.parse(
  readFileSync(new URL("package.json", import.meta.url), "utf8")
);
const APP_DESCRIPTION =
  typeof packageManifest.description === "string" &&
  packageManifest.description.trim().length > 0
    ? packageManifest.description
    : `${packageManifest.productName} local-first AI usage companion`;

if (RELEASE_MODE !== "internal" && RELEASE_MODE !== "signed") {
  throw new Error("TOKENMONSTER_RELEASE_MODE must be internal or signed.");
}
const RELEASE_VERSION = requireReleaseVersion(process.env);

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

function signedPlatformConfiguration() {
  if (RELEASE_MODE !== "signed") {
    return { makerWindowsSign: undefined, packager: {} };
  }
  if (process.platform === "darwin") {
    return { makerWindowsSign: undefined, packager: signedMacConfiguration() };
  }
  if (process.platform === "win32") {
    const { windowsSign } = prepareWindowsSigningEnvironment(process.env);
    return {
      makerWindowsSign: windowsSign,
      packager: { windowsSign }
    };
  }
  throw new Error(
    "Signed companion releases require a native macOS or Windows host."
  );
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
    throw new Error(
      "Electron runtime snapshot search exceeded its depth bound."
    );
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
      // macOS names the snapshot per-arch (v8_context_snapshot.arm64.bin)
      // inside Electron Framework.framework; Linux/Windows use the bare name.
      /^v8_context_snapshot(?:\.(?:arm64|x86_64))?\.bin$/u.test(entry.name)
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
    // The LoadBrowserProcessSpecificV8Snapshot fuse reads this literal name
    // on every platform, without the macOS arch infix.
    const destination = join(
      dirname(source),
      "browser_v8_context_snapshot.bin"
    );
    try {
      await lstat(destination);
      throw new Error(
        "Electron browser V8 snapshot already exists unexpectedly."
      );
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
  throw new Error(
    `No audited collector package target exists for ${platform}-${arch}.`
  );
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
    throw new Error(
      `Collector target ${targetKey} is not release-enabled.${reason}`
    );
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
    throw new Error(
      "Collector runtime manifest contains an unsafe file entry."
    );
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
  const manifestTarget = runtimeManifest.collector?.targets?.[targetKey];
  if (
    manifestTarget !== null &&
    typeof manifestTarget === "object" &&
    manifestTarget.runtimeEnabled === false &&
    typeof manifestTarget.blockedReason === "string"
  ) {
    // The runtime refuses this platform (no audited no-egress sandbox), so
    // the package ships without the collector instead of shipping a binary
    // the runtime will never execute. The app degrades to the
    // collector-unavailable status it already shows in development here.
    console.warn(
      `Skipping collector bundle for ${targetKey}: ${manifestTarget.blockedReason}`
    );
    return;
  }
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
    throw new Error(
      "Collector extraResource target escaped the app resources."
    );
  }
  await rm(targetDirectory, { force: true, recursive: true });
  await mkdir(targetDirectory, { mode: 0o755, recursive: true });
  for (const { source, specification } of files) {
    const destination = join(targetDirectory, specification.target);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await chmod(destination, Number.parseInt(specification.mode, 8));
    const copied = readFileSync(destination);
    if (sha256(copied) !== specification.sha256) {
      throw new Error(
        "Copied collector resource failed checksum verification."
      );
    }
  }

  if (target.files.filter(({ executable }) => executable).length !== 1) {
    throw new Error("Collector target must declare exactly one executable.");
  }
}

async function copySidecarPackage(source, destination, budget, depth = 0) {
  if (depth > SIDECAR_MAX_TREE_DEPTH) {
    throw new Error("Sidecar staging exceeded its directory depth bound.");
  }
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Sidecar source contains a symbolic link: ${source}.`);
  }
  if (metadata.isDirectory()) {
    const directoryMode = metadata.mode & 0o7777;
    await mkdir(destination, { mode: directoryMode, recursive: true });
    await chmod(destination, directoryMode);
    for (const entry of (await readdir(source, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name)
    )) {
      const entrySource = join(source, entry.name);
      const entryMetadata = await lstat(entrySource);
      if (entryMetadata.isSymbolicLink()) {
        throw new Error(
          `Sidecar source contains a symbolic link: ${entrySource}.`
        );
      }
      if (
        entryMetadata.isDirectory() &&
        (entry.name === "node_modules" || entry.name === ".bin")
      ) {
        continue;
      }
      await copySidecarPackage(
        entrySource,
        join(destination, entry.name),
        budget,
        depth + 1
      );
    }
    return;
  }
  if (!metadata.isFile()) {
    throw new Error(`Sidecar source contains a non-regular entry: ${source}.`);
  }
  budget.fileCount += 1;
  budget.totalBytes += metadata.size;
  if (
    budget.fileCount > SIDECAR_MAX_FILE_COUNT ||
    budget.totalBytes > SIDECAR_MAX_TOTAL_BYTES
  ) {
    throw new Error("Sidecar staging exceeded its file or byte bound.");
  }
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, metadata.mode & 0o7777);
}

async function copyDeclaredSidecarPackage(
  source,
  destination,
  manifest,
  budget
) {
  await mkdir(destination, { mode: 0o755, recursive: true });
  for (const relativePath of await declaredSidecarPackageFiles(
    source,
    manifest
  )) {
    const sourcePath = resolve(source, ...relativePath.split("/"));
    const destinationPath = resolve(destination, ...relativePath.split("/"));
    await mkdir(dirname(destinationPath), { mode: 0o755, recursive: true });
    await copySidecarPackage(sourcePath, destinationPath, budget);
  }
}

async function prepareSidecarExtraResource(resourcesAppPath) {
  if (
    runtimeManifest.sidecar?.package !== "tokentracker-cli" ||
    runtimeManifest.sidecar?.extraResourceTarget !== "sidecar" ||
    typeof runtimeManifest.sidecar?.version !== "string"
  ) {
    throw new Error("Sidecar runtime manifest does not match release policy.");
  }
  const rootLockPath = SIDECAR_ROOT_LOCK_PATH;
  const rootLockEntry = packageLock.packages?.[rootLockPath];
  if (
    rootLockEntry === null ||
    typeof rootLockEntry !== "object" ||
    rootLockEntry.version !== runtimeManifest.sidecar.version
  ) {
    throw new Error(
      "Sidecar package-lock version does not match the manifest."
    );
  }
  const installedManifestPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    rootLockPath,
    "package.json"
  );
  const installedManifest = JSON.parse(
    readFileSync(installedManifestPath, "utf8")
  );
  if (
    installedManifest.name !== runtimeManifest.sidecar.package ||
    installedManifest.version !== runtimeManifest.sidecar.version
  ) {
    throw new Error("Installed sidecar package identity is invalid.");
  }

  const workspaceDirectory = resolve(
    dirname(installedManifestPath),
    "..",
    ".."
  );
  const resourcesDirectory = resolve(resourcesAppPath, "..");
  const targetDirectory = resolve(
    resourcesDirectory,
    ...runtimeManifest.sidecar.extraResourceTarget.split("/")
  );
  if (!targetDirectory.startsWith(`${resourcesDirectory}${sep}`)) {
    throw new Error("Sidecar extraResource target escaped the app resources.");
  }
  await rm(targetDirectory, { force: true, recursive: true });
  await mkdir(targetDirectory, { mode: 0o755, recursive: true });

  const budget = { fileCount: 0, totalBytes: 0 };
  for (const lockPath of sidecarDependencyClosure(packageLock)) {
    const source = resolve(workspaceDirectory, ...lockPath.split("/"));
    const destination = resolve(targetDirectory, ...lockPath.split("/"));
    if (!destination.startsWith(`${targetDirectory}${sep}`)) {
      throw new Error(
        "Sidecar package destination escaped its extraResource root."
      );
    }
    if (lockPath === rootLockPath) {
      await copyDeclaredSidecarPackage(
        source,
        destination,
        installedManifest,
        budget
      );
    } else {
      await copySidecarPackage(source, destination, budget);
    }
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
  await prepareVerifiedCollectorExtraResource(resourcesAppPath, platform, arch);
  await prepareSidecarExtraResource(resourcesAppPath);
}

async function removeGroupWorldWrite(path, depth = 0, counter = { value: 0 }) {
  // macOS .app bundles carry an order of magnitude more entries than the
  // Linux/Windows layouts (framework lproj dirs, helper apps), and the
  // sidecar extraResource adds ~850 files on every platform, so the bound
  // is a runaway guard, not a tight inventory expectation.
  if (depth > 16 || counter.value > SIDECAR_MAX_FILE_COUNT) {
    throw new Error(
      "Packaged permission hardening exceeded its inventory bound."
    );
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
  if (
    !Array.isArray(packageResult?.outputPaths) ||
    packageResult.outputPaths.length < 1
  ) {
    throw new Error(
      "Forge returned no package output for permission hardening."
    );
  }
  for (const outputPath of packageResult.outputPaths) {
    await removeGroupWorldWrite(outputPath);
  }
}

const signedConfiguration = signedPlatformConfiguration();
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
  process.platform === "darwin" &&
  (runtimeManifest.collector?.status !== "ready" ||
    runtimeManifest.collector?.signedReleaseStatus !== "ready")
) {
  throw new Error(
    `Signed release blocked by collector state: ${runtimeManifest.collector?.signedReleaseStatus ?? runtimeManifest.collector?.status ?? "missing"}.`
  );
}

const packagerConfig = {
  appBundleId: APP_BUNDLE_ID,
  appCategoryType: "public.app-category.utilities",
  appVersion: RELEASE_VERSION,
  asar: true,
  executableName: "TokenMonster",
  ignore: ignoreOutsideRuntime,
  name: "TokenMonster",
  overwrite: true,
  prune: false,
  ...signedConfiguration.packager
};

const config = {
  hooks: {
    packageAfterCopy: prepareRuntimeResources,
    postPackage: hardenPackagedPermissions,
    readPackageJson: (_forgeConfig, input) =>
      packageJsonWithReleaseVersion(input, RELEASE_VERSION)
  },
  packagerConfig,
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
    },
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: packagerConfig.name.replaceAll(" ", ""),
        exe: `${packagerConfig.executableName}.exe`,
        setupExe: `${packagerConfig.name}Setup.exe`,
        authors: "Ted Huang",
        description: APP_DESCRIPTION,
        noDelta: true,
        noMsi: true,
        version: RELEASE_VERSION,
        ...(signedConfiguration.makerWindowsSign === undefined
          ? {}
          : { windowsSign: signedConfiguration.makerWindowsSign })
      },
      platforms: ["win32"]
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
