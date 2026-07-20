import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { pipeline } from "node:stream/promises";

import { extractAll, getRawHeader } from "@electron/asar";
import yauzl from "yauzl";

import { MAX_PACKAGED_COLLECTOR_RESOURCE_BYTES } from "../apps/companion/packaging/package-bounds.mjs";
import {
  authenticodeEvidenceFromInspection,
  isWindowsSignablePath,
  packageJsonWithReleaseVersion,
  requireReleaseVersion,
  requireSignedWindowsSquirrelInventory,
  requireSquirrelReleaseEntry,
  requireWindowsSignerSubject,
  SOURCE_COMPANION_VERSION,
  squirrelVersionFor
} from "../apps/companion/packaging/release-policy.mjs";
import {
  assertSquirrelSidecarInventory,
  declaredSidecarPackageFiles,
  packageNameFromLockPath,
  SIDECAR_MAX_FILE_COUNT,
  SIDECAR_MAX_TOTAL_BYTES,
  SIDECAR_MAX_TREE_DEPTH,
  SIDECAR_ROOT_LOCK_PATH,
  sidecarDependencyClosure,
  stagedSidecarPackagePaths
} from "./companion-packaging-policy.mjs";
import { rootDirectory } from "./repository-files.mjs";

const arguments_ = process.argv.slice(2);
const modeIndex = arguments_.indexOf("--mode");
const mode = modeIndex === -1 ? undefined : arguments_[modeIndex + 1];
const requireMaker = arguments_.includes("--require-maker");
if (mode !== "internal" && mode !== "signed") {
  throw new Error(
    "Usage: verify-companion-package.mjs --mode internal|signed [--require-maker]"
  );
}
const releaseVersion = requireReleaseVersion(process.env);
if (
  mode === "signed" &&
  process.platform !== "darwin" &&
  process.platform !== "win32"
) {
  throw new Error(
    "Signed companion verification requires native macOS or Windows."
  );
}
const expectedWindowsSignerSubject =
  mode === "signed" && process.platform === "win32"
    ? requireWindowsSignerSubject(process.env)
    : null;

const companionDirectory = join(rootDirectory, "apps", "companion");
const outDirectory = join(companionDirectory, "out");
const manifestPath = join(
  companionDirectory,
  "packaging",
  "runtime-bundle-manifest.json"
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const packageLock = JSON.parse(
  await readFile(join(rootDirectory, "package-lock.json"), "utf8")
);
const blockedExtensions = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".map",
  ".mp3",
  ".mp4",
  ".ogg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".wav",
  ".webm",
  ".webp"
]);
const sourceExtensions = new Set([".cts", ".mts", ".ts", ".tsx"]);
const allowedBareImports = ["electron", "node:*"];
const expectedFuseStates = [
  false,
  true,
  false,
  false,
  true,
  true,
  true,
  false,
  true
];
const fuseSentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
const secretPatterns = [
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:CLOUDFLARE|CF)_API_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bGOCSPX-[0-9A-Za-z_-]{20,}\b/u,
  /\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{16,}\b/u,
  /\bnpm_[A-Za-z0-9]{36}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u
];
const forbiddenAssetTransportMarkers = [
  "https://cdn.ted-h.com/tokenmonster/characters/v1",
  "TOKENMONSTER_CHARACTER_CDN",
  "CompanionCharacterFetch",
  "DownloadSemaphore",
  "asset fetch failed"
];
const requiredDefaultPetByokMarkers = [
  "startPetByokSecretSlot",
  "createElectronAsyncSafeStoragePort",
  "createPetStartupLifecycle",
  "drainPetStartupLifecycle",
  "adoptPetStartupOwner",
  'PET_BYOK_SECRET_FILE = "openai-byok.json"',
  "startPetServices(petByokSecretSlot)",
  'var BYOK_STATUS_PATH = "/api/byok/status"',
  "store: false"
];

function portablePath(path) {
  return path.split(sep).join("/");
}

async function walkFiles(directory, options = {}) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      if (options.rejectLinks === true) {
        throw new Error(
          `Packaged ASAR contains a symbolic link: ${entry.name}`
        );
      }
      continue;
    }
    if (metadata.isDirectory()) {
      files.push(...(await walkFiles(path, options)));
    } else if (metadata.isFile()) {
      files.push(path);
    } else if (options.rejectLinks === true) {
      throw new Error(
        `Packaged ASAR contains a non-regular entry: ${entry.name}`
      );
    }
  }
  return files;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function hashFile(path, algorithm = "sha256") {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function linuxLibcSuffix() {
  const report = process.report?.getReport();
  return typeof report?.header?.glibcVersionRuntime === "string"
    ? "gnu"
    : "musl";
}

function collectorTargetKey() {
  if (
    process.platform === "darwin" &&
    (process.arch === "x64" || process.arch === "arm64")
  ) {
    return `${process.platform}-${process.arch}`;
  }
  if (
    process.platform === "linux" &&
    (process.arch === "x64" || process.arch === "arm64")
  ) {
    return `${process.platform}-${process.arch}-${linuxLibcSuffix()}`;
  }
  if (
    process.platform === "win32" &&
    (process.arch === "x64" || process.arch === "arm64")
  ) {
    return `${process.platform}-${process.arch}-msvc`;
  }
  throw new Error(
    `No audited collector verification target exists for ${process.platform}-${process.arch}.`
  );
}

function selectedCollectorTarget() {
  const key = collectorTargetKey();
  const target = manifest.collector?.targets?.[key];
  if (
    target === null ||
    typeof target !== "object" ||
    target.runtimeEnabled !== true ||
    typeof target.package !== "string" ||
    target.packageVersion !== manifest.collector.sourceVersion ||
    typeof target.lockIntegrity !== "string" ||
    !Array.isArray(target.files) ||
    target.files.length < 1 ||
    target.files.length > 2
  ) {
    throw new Error(`Collector verification target ${key} is not enabled.`);
  }
  return { key, target };
}

async function verifyCollectorExtraResource(asarPath) {
  const disabledKey = collectorTargetKey();
  const disabledTarget = manifest.collector?.targets?.[disabledKey];
  if (
    disabledTarget !== null &&
    typeof disabledTarget === "object" &&
    disabledTarget.runtimeEnabled === false &&
    typeof disabledTarget.blockedReason === "string"
  ) {
    // The packager skips bundling on explicitly-disabled targets (no audited
    // no-egress sandbox); the package must then contain no collector at all.
    const absentDirectory = join(
      dirname(asarPath),
      ...manifest.collector.extraResourceTarget.split("/")
    );
    let extraResourcePresent = true;
    try {
      await lstat(absentDirectory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      extraResourcePresent = false;
    }
    if (extraResourcePresent) {
      throw new Error(
        `Collector target ${disabledKey} is disabled but the extraResource was packaged.`
      );
    }
    return {
      status: manifest.collector.status,
      target: disabledKey,
      package: null,
      packageVersion: null,
      packageLockIntegrity: null,
      expectedVersionOutput: null,
      versionEvidence: "explicitly-disabled-target",
      binaryExecutedDuringVerification: false,
      extraResourcePresent: false,
      files: [],
      releaseBlocker: disabledTarget.blockedReason
    };
  }
  const { key, target } = selectedCollectorTarget();
  const targetDirectory = join(
    dirname(asarPath),
    ...manifest.collector.extraResourceTarget.split("/")
  );
  const rootMetadata = await lstat(targetDirectory);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Collector extraResource root is not a regular directory.");
  }
  const files = await walkFiles(targetDirectory, { rejectLinks: true });
  const expectedNames = target.files.map(({ target: name }) => name).sort();
  const actualNames = files
    .map((path) => portablePath(relative(targetDirectory, path)))
    .sort();
  if (
    new Set(expectedNames).size !== expectedNames.length ||
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames)
  ) {
    throw new Error(
      `Collector extraResource inventory mismatch: ${JSON.stringify(actualNames)}.`
    );
  }

  const inventory = [];
  for (const specification of target.files) {
    if (
      typeof specification.target !== "string" ||
      !/^[A-Za-z0-9._-]+$/u.test(specification.target) ||
      typeof specification.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(specification.sha256) ||
      (specification.mode !== "0755" && specification.mode !== "0644") ||
      typeof specification.executable !== "boolean"
    ) {
      throw new Error("Collector manifest file evidence is malformed.");
    }
    const path = join(targetDirectory, specification.target);
    const metadata = await lstat(path);
    const digest = await hashFile(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== Number.parseInt(specification.mode, 8) ||
      digest !== specification.sha256 ||
      metadata.size < 1 ||
      metadata.size > MAX_PACKAGED_COLLECTOR_RESOURCE_BYTES
    ) {
      throw new Error(`Collector evidence failed for ${specification.target}.`);
    }
    inventory.push({
      path: portablePath(relative(rootDirectory, path)),
      bytes: metadata.size,
      sha256: digest,
      mode: specification.mode,
      executable: specification.executable
    });
  }

  if (target.files.filter(({ executable }) => executable).length !== 1) {
    throw new Error("Collector target must contain exactly one executable.");
  }
  return {
    status: manifest.collector.status,
    target: key,
    package: target.package,
    packageVersion: target.packageVersion,
    packageLockIntegrity: target.lockIntegrity,
    expectedVersionOutput: manifest.collector.versionOutput,
    versionEvidence: "package-lock+package-manifest+audited-file-sha256",
    binaryExecutedDuringVerification: false,
    extraResourcePresent: true,
    files: inventory,
    releaseBlocker: null
  };
}

async function walkSidecarTree(path, budget, files = [], depth = 0) {
  if (depth > SIDECAR_MAX_TREE_DEPTH) {
    throw new Error("Packaged sidecar exceeded its directory depth bound.");
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Packaged sidecar contains a symbolic link: ${path}.`);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o7022) !== 0) {
    throw new Error(`Packaged sidecar contains an unsafe file mode: ${path}.`);
  }
  if (metadata.isDirectory()) {
    for (const entry of (await readdir(path)).sort((left, right) =>
      left.localeCompare(right)
    )) {
      await walkSidecarTree(join(path, entry), budget, files, depth + 1);
    }
    return files;
  }
  if (!metadata.isFile()) {
    throw new Error(`Packaged sidecar contains a non-regular entry: ${path}.`);
  }
  budget.fileCount += 1;
  budget.totalBytes += metadata.size;
  if (
    budget.fileCount > SIDECAR_MAX_FILE_COUNT ||
    budget.totalBytes > SIDECAR_MAX_TOTAL_BYTES
  ) {
    throw new Error("Packaged sidecar exceeded its file or byte bound.");
  }
  files.push(path);
  return files;
}

function assertLockEntry(lockPath, lockEntry) {
  if (
    lockEntry === null ||
    typeof lockEntry !== "object" ||
    typeof lockEntry.version !== "string" ||
    lockEntry.version.length < 1 ||
    typeof lockEntry.resolved !== "string" ||
    !lockEntry.resolved.startsWith("https://registry.npmjs.org/") ||
    typeof lockEntry.integrity !== "string" ||
    !lockEntry.integrity.startsWith("sha512-")
  ) {
    throw new Error(
      `Sidecar package-lock metadata is incomplete: ${lockPath}.`
    );
  }
}

async function verifySidecarExtraResource(asarPath) {
  if (
    manifest.sidecar?.package !== "tokentracker-cli" ||
    manifest.sidecar?.version !== "0.80.0" ||
    manifest.sidecar?.extraResourceTarget !== "sidecar"
  ) {
    throw new Error("Sidecar runtime manifest does not match release policy.");
  }
  const targetDirectory = resolve(
    dirname(asarPath),
    ...manifest.sidecar.extraResourceTarget.split("/")
  );
  let rootMetadata;
  try {
    rootMetadata = await lstat(targetDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Required packaged sidecar extraResource is missing.");
    }
    throw error;
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Sidecar extraResource root is not a regular directory.");
  }

  const budget = { fileCount: 0, totalBytes: 0 };
  const files = await walkSidecarTree(targetDirectory, budget);
  const expectedPackagePaths = sidecarDependencyClosure(packageLock);
  const actualPackagePaths = await stagedSidecarPackagePaths(targetDirectory);
  if (
    JSON.stringify(actualPackagePaths) !== JSON.stringify(expectedPackagePaths)
  ) {
    const missing = expectedPackagePaths.filter(
      (path) => !actualPackagePaths.includes(path)
    );
    const unexpected = actualPackagePaths.filter(
      (path) => !expectedPackagePaths.includes(path)
    );
    throw new Error(
      `Staged sidecar production dependency closure mismatch; missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}.`
    );
  }
  for (const lockPath of expectedPackagePaths) {
    const lockEntry = packageLock.packages?.[lockPath];
    assertLockEntry(lockPath, lockEntry);
    const expectedName = packageNameFromLockPath(lockPath);
    const stagedPackageManifest = JSON.parse(
      await readFile(
        resolve(targetDirectory, ...lockPath.split("/"), "package.json"),
        "utf8"
      )
    );
    if (
      stagedPackageManifest.name !== expectedName ||
      stagedPackageManifest.version !== lockEntry.version
    ) {
      throw new Error(`Staged sidecar package identity mismatch: ${lockPath}.`);
    }
  }
  const sidecarInventory = new Map();
  for (const stagedPath of files) {
    const stagedRelativePath = relative(targetDirectory, stagedPath);
    const sourcePath = resolve(rootDirectory, stagedRelativePath);
    if (!sourcePath.startsWith(`${rootDirectory}${sep}`)) {
      throw new Error("Sidecar workspace counterpart escaped the repository.");
    }
    let sourceMetadata;
    try {
      sourceMetadata = await lstat(sourcePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(
          `Packaged sidecar file has no workspace counterpart: ${portablePath(stagedRelativePath)}.`
        );
      }
      throw error;
    }
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
      throw new Error(
        `Sidecar workspace counterpart is not a regular file: ${portablePath(stagedRelativePath)}.`
      );
    }
    const stagedSha256 = await hashFile(stagedPath);
    if (stagedSha256 !== (await hashFile(sourcePath))) {
      throw new Error(
        `Packaged sidecar file differs from its workspace counterpart: ${portablePath(stagedRelativePath)}.`
      );
    }
    sidecarInventory.set(portablePath(stagedRelativePath), {
      bytes: (await stat(stagedPath)).size,
      sha256: stagedSha256
    });
  }

  const rootPackageDirectory = resolve(
    targetDirectory,
    ...SIDECAR_ROOT_LOCK_PATH.split("/")
  );
  const workspaceRootPackageDirectory = resolve(
    rootDirectory,
    ...SIDECAR_ROOT_LOCK_PATH.split("/")
  );
  const workspacePackageManifest = JSON.parse(
    await readFile(join(workspaceRootPackageDirectory, "package.json"), "utf8")
  );
  const expectedRootFiles = await declaredSidecarPackageFiles(
    workspaceRootPackageDirectory,
    workspacePackageManifest
  );
  const expectedRootTopLevelEntries = new Set(
    expectedRootFiles.map((path) => path.split("/")[0])
  );
  if (
    expectedPackagePaths.some((path) =>
      path.startsWith(`${SIDECAR_ROOT_LOCK_PATH}/node_modules/`)
    )
  ) {
    expectedRootTopLevelEntries.add("node_modules");
  }
  const actualRootTopLevelEntries = (
    await readdir(rootPackageDirectory)
  ).sort();
  const expectedRootTopLevelNames = [...expectedRootTopLevelEntries].sort();
  if (
    JSON.stringify(actualRootTopLevelEntries) !==
    JSON.stringify(expectedRootTopLevelNames)
  ) {
    throw new Error(
      `Sidecar root package top-level inventory mismatch; expected=${JSON.stringify(expectedRootTopLevelNames)}, actual=${JSON.stringify(actualRootTopLevelEntries)}.`
    );
  }
  // Relativize before filtering: the root package itself lives under the
  // staged sidecar's node_modules/, so an absolute-path node_modules filter
  // would drop every file.
  const stagedRootFiles = (
    await walkFiles(rootPackageDirectory, {
      rejectLinks: true
    })
  )
    .map((path) => portablePath(relative(rootPackageDirectory, path)))
    .filter((path) => !path.startsWith("node_modules/"))
    .sort();
  if (JSON.stringify(stagedRootFiles) !== JSON.stringify(expectedRootFiles)) {
    const missing = expectedRootFiles.filter(
      (path) => !stagedRootFiles.includes(path)
    );
    const unexpected = stagedRootFiles.filter(
      (path) => !expectedRootFiles.includes(path)
    );
    throw new Error(
      `Sidecar root package inventory does not match files/bin declarations; missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}.`
    );
  }

  const packageManifest = JSON.parse(
    await readFile(join(rootPackageDirectory, "package.json"), "utf8")
  );
  if (
    packageManifest.name !== manifest.sidecar.package ||
    packageManifest.version !== manifest.sidecar.version ||
    workspacePackageManifest.name !== manifest.sidecar.package ||
    workspacePackageManifest.version !== manifest.sidecar.version ||
    packageLock.packages?.[SIDECAR_ROOT_LOCK_PATH]?.version !==
      manifest.sidecar.version
  ) {
    throw new Error("Staged sidecar package identity is invalid.");
  }
  const entryDeclaration = packageManifest.bin?.["tokentracker-cli"];
  if (typeof entryDeclaration !== "string") {
    throw new Error(
      "Staged sidecar package has no tokentracker-cli bin entry."
    );
  }
  const entryBinPath = resolve(rootPackageDirectory, entryDeclaration);
  if (!entryBinPath.startsWith(`${rootPackageDirectory}${sep}`)) {
    throw new Error("Staged sidecar bin entry escaped its package directory.");
  }
  const entryMetadata = await lstat(entryBinPath);
  if (!entryMetadata.isFile() || entryMetadata.isSymbolicLink()) {
    throw new Error("Staged sidecar bin entry is not a regular file.");
  }

  const workspaceZstdDirectory = join(
    rootDirectory,
    "node_modules",
    "@mongodb-js",
    "zstd"
  );
  const nativeBindings = (
    await walkFiles(workspaceZstdDirectory, {
      rejectLinks: true
    })
  ).filter((path) => extname(path) === ".node");
  if (nativeBindings.length === 0) {
    throw new Error(
      "The workspace @mongodb-js/zstd package has no native .node binding; the sidecar cannot run."
    );
  }
  for (const workspaceBinding of nativeBindings) {
    const bindingRelativePath = relative(rootDirectory, workspaceBinding);
    const stagedBinding = resolve(targetDirectory, bindingRelativePath);
    const stagedMetadata = await lstat(stagedBinding);
    if (!stagedMetadata.isFile() || stagedMetadata.isSymbolicLink()) {
      throw new Error("A staged @mongodb-js/zstd native binding is missing.");
    }
    if (
      (await hashFile(stagedBinding)) !== (await hashFile(workspaceBinding))
    ) {
      throw new Error(
        "A staged @mongodb-js/zstd native binding differs from source."
      );
    }
  }

  return {
    sidecarVersion: manifest.sidecar.version,
    fileCount: budget.fileCount,
    totalBytes: budget.totalBytes,
    entryBin: portablePath(relative(targetDirectory, entryBinPath)),
    packageCount: expectedPackagePaths.length,
    inventory: sidecarInventory
  };
}

function isAllowedBareImport(specifier) {
  return specifier === "electron" || specifier.startsWith("node:");
}

function importedSpecifiers(text) {
  const patterns = [
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu
  ];
  const specifiers = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function isBareSpecifier(specifier) {
  return !(
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/")
  );
}

async function expectedAsarFiles() {
  const files = [];
  for (const staticFile of manifest.asar.staticFiles) {
    files.push(join(companionDirectory, staticFile));
  }
  files.push(
    ...(await walkFiles(join(companionDirectory, manifest.asar.generatedRoot)))
  );
  // The utilityProcess shim and its egress guard must both ship inside the
  // ASAR. They reach dist via a Vite copy step, so a silently skipped copy
  // would otherwise disappear from both sides of the staged comparison.
  for (const requiredSidecarFile of ["sidecar-shim.cjs", "network-deny.cjs"]) {
    const path = join(
      companionDirectory,
      "dist",
      "main",
      "main",
      requiredSidecarFile
    );
    if (!files.includes(path)) {
      throw new Error(
        `Packaged ASAR staging is missing ${requiredSidecarFile}.`
      );
    }
  }
  const companionPreload = join(
    companionDirectory,
    "dist",
    "main",
    "preload",
    "companion.cjs"
  );
  if (!files.includes(companionPreload)) {
    throw new Error("Packaged ASAR staging is missing companion.cjs.");
  }
  return files.sort();
}

function assertManifestPolicy() {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.application?.productName !== "TokenMonster" ||
    manifest.application?.bundleId !== "com.tokenmonster.companion" ||
    manifest.application?.main !== "dist/main/main/main.js" ||
    manifest.application?.preload !== "dist/main/preload/index.cjs" ||
    manifest.application?.renderer !== "dist/renderer/index.html" ||
    manifest.asar?.enabled !== true ||
    manifest.asar?.allowUnpackedFiles !== false ||
    manifest.sidecar?.package !== "tokentracker-cli" ||
    manifest.sidecar?.version !== "0.80.0" ||
    manifest.sidecar?.extraResourceTarget !== "sidecar" ||
    manifest.collector?.status !== "ready" ||
    typeof manifest.collector?.signedReleaseStatus !== "string" ||
    manifest.collector?.name !== "tokscale" ||
    manifest.collector?.sourceVersion !== "4.5.2" ||
    manifest.collector?.versionOutput !== "tokscale 4.5.2" ||
    manifest.collector?.license !== "MIT" ||
    manifest.collector?.licenseFile !== "packaging/TOKSCALE_LICENSE.txt" ||
    manifest.collector?.licenseSha256 !==
      "24a794f325f7625b5f124945dedb6dcec8188f88e76bf4b99557b52d6cc77be9" ||
    !manifest.asar.staticFiles.includes(manifest.collector.licenseFile) ||
    manifest.collector?.extraResourceTarget !== "collector/tokscale" ||
    manifest.collector?.runtimeBase !== "process.resourcesPath" ||
    JSON.stringify(manifest.application?.runtimeExternals) !==
      JSON.stringify(allowedBareImports)
  ) {
    throw new Error("Runtime bundle manifest does not match release policy.");
  }
}

function asarHeaderFile(header, relativePath) {
  let directory = header;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const entry = directory?.files?.[segments[index]];
    if (entry === undefined) return undefined;
    if (index === segments.length - 1) return entry;
    directory = entry;
  }
  return undefined;
}

async function findAppAsars() {
  try {
    return (await walkFiles(outDirectory)).filter(
      (path) => basename(path) === "app.asar"
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Companion package output is missing.");
    }
    throw error;
  }
}

function packageRootForAsar(asarPath) {
  let current = dirname(asarPath);
  while (current !== dirname(current)) {
    if (basename(current).endsWith(".app")) return current;
    current = dirname(current);
  }
  return dirname(dirname(asarPath));
}

async function verifyPackagePermissionTree(
  directory,
  depth = 0,
  counter = { value: 0 }
) {
  // Runaway guard, not a tight count: macOS .app bundles carry an order of
  // magnitude more entries than the Linux/Windows layouts, and the sidecar
  // extraResource adds ~850 files on every platform.
  if (depth > 16 || counter.value > SIDECAR_MAX_FILE_COUNT) {
    throw new Error("Packaged permission inventory exceeded its bound.");
  }
  counter.value += 1;
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink()) {
    if (process.platform !== "darwin") {
      throw new Error(
        "Packaged application contains an unexpected symbolic link."
      );
    }
    return;
  }
  if (!metadata.isDirectory() && !metadata.isFile()) {
    throw new Error("Packaged application contains a non-regular entry.");
  }
  // POSIX mode bits are synthetic on Windows (node reports 0o666; ACLs are
  // the real permission model there), so the bit check only runs on unix.
  if (process.platform !== "win32" && (metadata.mode & 0o7022) !== 0) {
    throw new Error("Packaged application contains an unsafe file mode.");
  }
  if (metadata.isDirectory()) {
    for (const entry of await readdir(directory)) {
      await verifyPackagePermissionTree(
        join(directory, entry),
        depth + 1,
        counter
      );
    }
  }
}

async function verifyPackagePathsAndSnapshots(asarPath) {
  const packageRoot = packageRootForAsar(asarPath);
  const sidecarDirectory = resolve(
    dirname(asarPath),
    ...manifest.sidecar.extraResourceTarget.split("/")
  );
  await verifyPackagePermissionTree(packageRoot);
  const files = await walkFiles(packageRoot);
  for (const path of files) {
    if (path.startsWith(`${sidecarDirectory}${sep}`)) continue;
    const relativePath = portablePath(relative(packageRoot, path));
    const lowerPath = relativePath.toLowerCase();
    const extension = extname(lowerPath);
    const segments = lowerPath.split("/");
    if (
      blockedExtensions.has(extension) ||
      sourceExtensions.has(extension) ||
      segments.includes("node_modules") ||
      segments.some(
        (segment) => segment === ".env" || segment.startsWith(".env.")
      )
    ) {
      throw new Error(`Forbidden packaged application path: ${relativePath}`);
    }
  }

  const sharedSnapshots = files.filter((path) =>
    // macOS names the shared snapshot per-arch (v8_context_snapshot.arm64.bin).
    /^v8_context_snapshot(?:\.(?:arm64|x86_64))?\.bin$/u.test(basename(path))
  );
  const browserSnapshots = files.filter(
    (path) => basename(path) === "browser_v8_context_snapshot.bin"
  );
  if (
    sharedSnapshots.length < 1 ||
    sharedSnapshots.length > 2 ||
    browserSnapshots.length !== sharedSnapshots.length
  ) {
    throw new Error(
      `Electron browser snapshot inventory mismatch: shared=${sharedSnapshots.length}, browser=${browserSnapshots.length}.`
    );
  }

  const evidence = [];
  for (const sharedPath of sharedSnapshots.sort()) {
    const browserPath = join(
      dirname(sharedPath),
      "browser_v8_context_snapshot.bin"
    );
    if (!browserSnapshots.includes(browserPath)) {
      throw new Error(
        "Electron browser snapshot is not beside its shared snapshot."
      );
    }
    const shared = await readFile(sharedPath);
    const browser = await readFile(browserPath);
    if (!shared.equals(browser)) {
      throw new Error(
        "Electron browser and shared snapshots are not byte-identical."
      );
    }
    evidence.push({
      sharedPath: portablePath(relative(rootDirectory, sharedPath)),
      browserPath: portablePath(relative(rootDirectory, browserPath)),
      bytes: shared.byteLength,
      sha256: sha256(shared)
    });
  }
  return evidence;
}

async function assertAsarInventory(asarPath, extractedDirectory) {
  const unpackedPath = `${asarPath}.unpacked`;
  try {
    await stat(unpackedPath);
    throw new Error("app.asar.unpacked is forbidden for the companion bundle.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  extractAll(asarPath, extractedDirectory);
  const extractedFiles = await walkFiles(extractedDirectory, {
    rejectLinks: true
  });
  const rawHeader = getRawHeader(asarPath).header;
  const expectedFiles = await expectedAsarFiles();
  const extractedNames = extractedFiles
    .map((path) => portablePath(relative(extractedDirectory, path)))
    .sort();
  const expectedNames = expectedFiles
    .map((path) => portablePath(relative(companionDirectory, path)))
    .sort();
  if (JSON.stringify(extractedNames) !== JSON.stringify(expectedNames)) {
    const unexpected = extractedNames.filter(
      (path) => !expectedNames.includes(path)
    );
    const missing = expectedNames.filter(
      (path) => !extractedNames.includes(path)
    );
    throw new Error(
      `ASAR inventory mismatch; unexpected=${JSON.stringify(unexpected)}, missing=${JSON.stringify(missing)}`
    );
  }
  const packagedMainSource = await readFile(
    join(extractedDirectory, manifest.application.main),
    "utf8"
  );
  if (
    requiredDefaultPetByokMarkers.some(
      (marker) => !packagedMainSource.includes(marker)
    )
  ) {
    throw new Error(
      "Packaged Electron main process lost the default pet BYOK composition."
    );
  }
  if (extractedFiles.length > 64) {
    throw new Error("ASAR inventory exceeds the 64-file release bound.");
  }

  const inventory = [];
  let totalBytes = 0;
  for (let index = 0; index < extractedFiles.length; index += 1) {
    const extractedPath = extractedFiles[index];
    const expectedPath = expectedFiles.find(
      (path) =>
        portablePath(relative(companionDirectory, path)) ===
        portablePath(relative(extractedDirectory, extractedPath))
    );
    if (expectedPath === undefined) {
      throw new Error("ASAR inventory comparison lost an expected path.");
    }
    const relativePath = portablePath(
      relative(extractedDirectory, extractedPath)
    );
    const contents = await readFile(extractedPath);
    const expectedContents = await readFile(expectedPath);
    totalBytes += contents.byteLength;
    if (contents.byteLength > 8 * 1024 * 1024) {
      throw new Error(`ASAR file exceeds the 8 MiB bound: ${relativePath}`);
    }
    const packageManifestMatchesRelease =
      relativePath === "package.json" &&
      JSON.stringify(JSON.parse(contents.toString("utf8"))) ===
        JSON.stringify(
          packageJsonWithReleaseVersion(
            JSON.parse(expectedContents.toString("utf8")),
            releaseVersion
          )
        );
    if (!contents.equals(expectedContents) && !packageManifestMatchesRelease) {
      const bound = Math.min(contents.byteLength, expectedContents.byteLength);
      let difference = 0;
      while (
        difference < bound &&
        contents[difference] === expectedContents[difference]
      ) {
        difference += 1;
      }
      throw new Error(
        `Packaged file differs from built input: ${relativePath} ` +
          `(packaged ${contents.byteLength}B vs built ${expectedContents.byteLength}B; ` +
          `first difference at byte ${difference}: ` +
          `${contents.subarray(difference, difference + 8).toString("hex")} vs ` +
          `${expectedContents.subarray(difference, difference + 8).toString("hex")})`
      );
    }

    const lowerPath = relativePath.toLowerCase();
    const extension = extname(lowerPath);
    const segments = lowerPath.split("/");
    if (
      segments.includes("node_modules") ||
      segments.includes("src") ||
      segments.includes("test") ||
      segments.includes("tests") ||
      sourceExtensions.has(extension) ||
      blockedExtensions.has(extension) ||
      segments.some(
        (segment) => segment === ".env" || segment.startsWith(".env.")
      )
    ) {
      throw new Error(`Forbidden packaged path: ${relativePath}`);
    }
    if (contents.includes(0)) {
      throw new Error(`Unknown binary content in ASAR: ${relativePath}`);
    }
    const text = contents.toString("utf8");
    if (text.includes("data:image/")) {
      throw new Error(`Embedded image data is forbidden: ${relativePath}`);
    }
    for (const marker of forbiddenAssetTransportMarkers) {
      if (text.includes(marker)) {
        throw new Error(
          `State-selected asset transport is forbidden: ${relativePath}`
        );
      }
    }
    for (const pattern of secretPatterns) {
      if (pattern.test(text)) {
        throw new Error(`Possible secret in ASAR: ${relativePath}`);
      }
    }
    if (new Set([".cjs", ".js", ".mjs"]).has(extension)) {
      for (const specifier of importedSpecifiers(text)) {
        if (isBareSpecifier(specifier) && !isAllowedBareImport(specifier)) {
          throw new Error(
            `Forbidden runtime bare import ${JSON.stringify(specifier)} in ${relativePath}`
          );
        }
      }
    }
    const headerFile = asarHeaderFile(rawHeader, relativePath);
    const integrity = headerFile?.integrity;
    if (
      headerFile?.size !== contents.byteLength ||
      integrity?.algorithm !== "SHA256" ||
      integrity.hash !== sha256(contents) ||
      !Number.isSafeInteger(integrity.blockSize) ||
      integrity.blockSize < 1 ||
      integrity.blockSize > 4 * 1024 * 1024 ||
      !Array.isArray(integrity.blocks)
    ) {
      throw new Error(
        `ASAR header integrity metadata is invalid: ${relativePath}`
      );
    }
    const expectedBlocks = [];
    for (
      let offset = 0;
      offset < contents.byteLength;
      offset += integrity.blockSize
    ) {
      expectedBlocks.push(
        sha256(contents.subarray(offset, offset + integrity.blockSize))
      );
    }
    if (JSON.stringify(integrity.blocks) !== JSON.stringify(expectedBlocks)) {
      throw new Error(`ASAR block integrity mismatch: ${relativePath}`);
    }
    inventory.push({
      path: relativePath,
      bytes: contents.byteLength,
      sha256: sha256(contents)
    });
  }
  if (totalBytes > 20 * 1024 * 1024) {
    throw new Error("ASAR inventory exceeds the 20 MiB release bound.");
  }

  const packagedManifest = JSON.parse(
    await readFile(
      join(extractedDirectory, "packaging", "runtime-bundle-manifest.json"),
      "utf8"
    )
  );
  if (JSON.stringify(packagedManifest) !== JSON.stringify(manifest)) {
    throw new Error("Packaged runtime manifest differs from source policy.");
  }
  const collectorLicense = await readFile(
    join(extractedDirectory, manifest.collector.licenseFile)
  );
  if (sha256(collectorLicense) !== manifest.collector.licenseSha256) {
    throw new Error(
      "Packaged collector license differs from the pinned notice."
    );
  }
  const packageManifest = JSON.parse(
    await readFile(join(extractedDirectory, "package.json"), "utf8")
  );
  if (
    packageManifest.main !== manifest.application.main ||
    packageManifest.productName !== manifest.application.productName ||
    packageManifest.version !== releaseVersion
  ) {
    throw new Error(
      "Packaged package.json has an unexpected entry point or release version."
    );
  }
  for (const entry of [
    manifest.application.main,
    manifest.application.preload,
    manifest.application.renderer,
    "dist/main/preload/companion.cjs"
  ]) {
    if (!extractedNames.includes(entry)) {
      throw new Error(`Declared runtime entry is absent from ASAR: ${entry}`);
    }
  }
  return inventory;
}

function fuseBinaryPath(asarPath) {
  const resourcesDirectory = dirname(asarPath);
  if (portablePath(resourcesDirectory).includes(".app/Contents/Resources")) {
    const contentsDirectory = dirname(resourcesDirectory);
    return join(
      contentsDirectory,
      "Frameworks",
      "Electron Framework.framework",
      "Electron Framework"
    );
  }
  const packageDirectory = dirname(resourcesDirectory);
  return process.platform === "win32"
    ? join(packageDirectory, "TokenMonster.exe")
    : join(packageDirectory, "TokenMonster");
}

async function verifyRawFuseWires(binaryPath) {
  const executable = await readFile(binaryPath);
  const wires = [];
  let offset = 0;
  while (offset < executable.byteLength) {
    const sentinelIndex = executable.indexOf(fuseSentinel, offset);
    if (sentinelIndex === -1) break;
    const wirePosition = sentinelIndex + fuseSentinel.byteLength;
    const version = executable[wirePosition];
    const length = executable[wirePosition + 1];
    if (version !== 1 || length !== expectedFuseStates.length) {
      throw new Error(
        `Unexpected Electron fuse wire version/length: ${version}/${length}`
      );
    }
    const rawStates = [
      ...executable.subarray(wirePosition + 2, wirePosition + 2 + length)
    ];
    const expectedRawStates = expectedFuseStates.map((enabled) =>
      enabled ? "1".charCodeAt(0) : "0".charCodeAt(0)
    );
    if (JSON.stringify(rawStates) !== JSON.stringify(expectedRawStates)) {
      throw new Error(
        `Electron fuse wire mismatch: ${JSON.stringify(rawStates)}`
      );
    }
    wires.push(rawStates.map((state) => state === "1".charCodeAt(0)));
    offset = wirePosition + 2 + length;
  }
  if (wires.length === 0 || wires.length > 2) {
    throw new Error(
      `Expected one or two Electron fuse wires, found ${wires.length}.`
    );
  }
  return wires;
}

function openZip(path, options = {}) {
  // PowerShell 5.1 Compress-Archive (cross-zip's win32 backend) writes
  // non-conformant backslash separators. Lenient mode lets yauzl normalize
  // them to "/" before its own traversal/absolute-path validation and before
  // safeZipEntryName re-checks the normalized name.
  const allowBackslashSeparators = options.allowBackslashSeparators === true;
  return new Promise((resolvePromise, reject) => {
    yauzl.open(
      path,
      {
        autoClose: false,
        decodeStrings: true,
        lazyEntries: true,
        strictFileNames: !allowBackslashSeparators,
        validateEntrySizes: true
      },
      (error, zip) => {
        if (error !== null) {
          reject(error);
          return;
        }
        if (zip === undefined) {
          reject(new Error("ZIP reader returned no archive."));
          return;
        }
        resolvePromise(zip);
      }
    );
  });
}

function safeZipEntryName(input) {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    Buffer.byteLength(input, "utf8") > 4_096 ||
    input.includes("\0") ||
    input.includes("\\") ||
    input.startsWith("/") ||
    /^[A-Za-z]:/u.test(input)
  ) {
    return false;
  }
  const directory = input.endsWith("/");
  const segments = input.split("/");
  if (directory) segments.pop();
  return (
    segments.length >= 1 &&
    segments.every(
      (segment) => segment.length >= 1 && segment !== "." && segment !== ".."
    )
  );
}

// The darwin/win32 zip toolchains cannot round-trip POSIX modes (PowerShell
// zips carry DOS attributes; .app zips carry framework symlinks), so foreign
// platforms verify entry safety and sizes without unix type/mode assertions.
function lenientZipEntryKind(entry) {
  if (!safeZipEntryName(entry.fileName)) {
    throw new Error("Maker ZIP contains an unsafe entry path.");
  }
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new Error("Encrypted maker ZIP entries are forbidden.");
  }
  const isDirectory = entry.fileName.endsWith("/");
  if (
    !isDirectory &&
    (!Number.isSafeInteger(entry.uncompressedSize) ||
      entry.uncompressedSize < 0 ||
      entry.uncompressedSize > SIDECAR_MAX_TOTAL_BYTES)
  ) {
    throw new Error("Maker ZIP file size is outside the release bound.");
  }
  return { kind: isDirectory ? "directory" : "file", mode: null };
}

function zipEntryKindAndMode(entry) {
  if (!safeZipEntryName(entry.fileName)) {
    throw new Error("Maker ZIP contains an unsafe entry path.");
  }
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new Error("Encrypted maker ZIP entries are forbidden.");
  }
  if (entry.versionMadeBy >>> 8 !== 3) {
    throw new Error(
      "Maker ZIP entries must preserve Unix file types and modes."
    );
  }
  const unixMode = entry.externalFileAttributes >>> 16;
  const fileType = unixMode & 0o170000;
  const isDirectory = entry.fileName.endsWith("/");
  if ((unixMode & 0o7022) !== 0) {
    throw new Error("Maker ZIP contains an unsafe file mode.");
  }
  if (isDirectory) {
    if (fileType !== 0o040000 || entry.uncompressedSize !== 0) {
      throw new Error("Maker ZIP directory metadata is invalid.");
    }
    return { kind: "directory", mode: unixMode & 0o777 };
  }
  if (fileType !== 0o100000) {
    throw new Error("Maker ZIP contains a link or non-regular entry.");
  }
  if (
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.uncompressedSize < 0 ||
    entry.uncompressedSize > SIDECAR_MAX_TOTAL_BYTES
  ) {
    throw new Error("Maker ZIP file size is outside the release bound.");
  }
  // Zero-byte regular files are legitimate: the sidecar dependency tree
  // ships several (npm package fixtures like node-addon-api/nothing.c).
  return { kind: "file", mode: unixMode & 0o777 };
}

function hashZipEntry(zip, entry) {
  return new Promise((resolvePromise, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        reject(error);
        return;
      }
      if (stream === undefined) {
        reject(new Error("ZIP reader returned no entry stream."));
        return;
      }
      const hash = createHash("sha256");
      let bytes = 0;
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > entry.uncompressedSize || bytes > SIDECAR_MAX_TOTAL_BYTES) {
          stream.destroy(new Error("Maker ZIP entry exceeded its size bound."));
          return;
        }
        hash.update(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => {
        if (bytes !== entry.uncompressedSize) {
          reject(new Error("Maker ZIP entry size changed while reading."));
          return;
        }
        resolvePromise({ bytes, sha256: hash.digest("hex") });
      });
    });
  });
}

async function zipInventory(path, options = {}) {
  const lenientModes = options.lenientModes === true;
  // The sidecar extraResource adds ~850 entries to every maker zip.
  const entryBound = SIDECAR_MAX_FILE_COUNT;
  const byteBound = (lenientModes ? 2 : 1) * 1_024 * 1_024 * 1_024;
  const zip = await openZip(path, { allowBackslashSeparators: lenientModes });
  try {
    return await new Promise((resolvePromise, reject) => {
      const files = new Map();
      const directories = new Map();
      const names = new Set();
      const caseFoldedNames = new Set();
      let entries = 0;
      let totalBytes = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      zip.once("error", fail);
      zip.once("end", () => {
        if (settled) return;
        settled = true;
        resolvePromise({ files, directories, entries, totalBytes });
      });
      zip.on("entry", (entry) => {
        void (async () => {
          entries += 1;
          if (entries > entryBound) {
            throw new Error(
              `Maker ZIP exceeds the ${entryBound}-entry release bound.`
            );
          }
          const folded = entry.fileName.toLocaleLowerCase("en-US");
          if (names.has(entry.fileName) || caseFoldedNames.has(folded)) {
            throw new Error(
              "Maker ZIP contains duplicate or case-colliding paths."
            );
          }
          names.add(entry.fileName);
          caseFoldedNames.add(folded);
          const metadata = lenientModes
            ? lenientZipEntryKind(entry)
            : zipEntryKindAndMode(entry);
          if (metadata.kind === "directory") {
            directories.set(entry.fileName.slice(0, -1), metadata.mode);
          } else {
            totalBytes += entry.uncompressedSize;
            if (totalBytes > byteBound) {
              throw new Error("Maker ZIP exceeds the uncompressed byte bound.");
            }
            files.set(entry.fileName, {
              ...(await hashZipEntry(zip, entry)),
              mode: metadata.mode
            });
          }
          if (!settled) zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

function readZipEntryBuffer(zip, entry, maximumBytes) {
  return new Promise((resolvePromise, reject) => {
    if (entry.uncompressedSize > maximumBytes) {
      reject(new Error("Selected ZIP entry exceeds its inspection bound."));
      return;
    }
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        reject(error);
        return;
      }
      if (stream === undefined) {
        reject(new Error("ZIP reader returned no selected entry stream."));
        return;
      }
      const chunks = [];
      let bytes = 0;
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > entry.uncompressedSize || bytes > maximumBytes) {
          stream.destroy(
            new Error("Selected ZIP entry exceeded its size bound.")
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => {
        if (bytes !== entry.uncompressedSize) {
          reject(new Error("Selected ZIP entry size changed while reading."));
          return;
        }
        resolvePromise(Buffer.concat(chunks, bytes));
      });
    });
  });
}

async function inspectSquirrelArchive(path, extractionDirectory) {
  const zip = await openZip(path, { allowBackslashSeparators: true });
  try {
    return await new Promise((resolvePromise, reject) => {
      const names = new Set();
      const caseFoldedNames = new Set();
      const nuspecs = [];
      const portableExecutables = [];
      let entries = 0;
      let extractedBytes = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      zip.once("error", fail);
      zip.once("end", () => {
        if (settled) return;
        settled = true;
        resolvePromise({ nuspecs, portableExecutables });
      });
      zip.on("entry", (entry) => {
        void (async () => {
          entries += 1;
          if (entries > SIDECAR_MAX_FILE_COUNT) {
            throw new Error(
              "Squirrel archive inspection exceeded its entry bound."
            );
          }
          const folded = entry.fileName.toLocaleLowerCase("en-US");
          if (names.has(entry.fileName) || caseFoldedNames.has(folded)) {
            throw new Error(
              "Squirrel archive contains duplicate or case-colliding paths."
            );
          }
          names.add(entry.fileName);
          caseFoldedNames.add(folded);
          const metadata = lenientZipEntryKind(entry);
          if (metadata.kind === "file") {
            if (extname(entry.fileName).toLowerCase() === ".nuspec") {
              nuspecs.push({
                archivePath: entry.fileName,
                contents: await readZipEntryBuffer(zip, entry, 1_024 * 1_024)
              });
            } else if (
              extractionDirectory !== null &&
              isWindowsSignablePath(entry.fileName)
            ) {
              if (portableExecutables.length >= 512) {
                throw new Error(
                  "Squirrel archive contains too many signable PE payloads."
                );
              }
              extractedBytes += entry.uncompressedSize;
              if (extractedBytes > 512 * 1_024 * 1_024) {
                throw new Error(
                  "Squirrel signable PE payload exceeds its extraction bound."
                );
              }
              const extractedPath = join(
                extractionDirectory,
                `${String(portableExecutables.length).padStart(4, "0")}${extname(entry.fileName).toLowerCase()}`
              );
              await new Promise((resolveStream, rejectStream) => {
                zip.openReadStream(entry, (error, stream) => {
                  if (error !== null) {
                    rejectStream(error);
                    return;
                  }
                  if (stream === undefined) {
                    rejectStream(
                      new Error("ZIP reader returned no PE payload stream.")
                    );
                    return;
                  }
                  pipeline(
                    stream,
                    createWriteStream(extractedPath, {
                      flags: "wx",
                      mode: 0o600
                    })
                  ).then(resolveStream, rejectStream);
                });
              });
              if ((await stat(extractedPath)).size !== entry.uncompressedSize) {
                throw new Error("Extracted Squirrel PE payload size mismatch.");
              }
              portableExecutables.push({
                archivePath: entry.fileName,
                extractedPath
              });
            }
          }
          if (!settled) zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

async function stagedPackageInventory(asarPath) {
  const packageRoot = packageRootForAsar(asarPath);
  const inventory = new Map();
  const directories = new Map();
  async function visit(path, depth = 0) {
    // The sidecar extraResource adds ~850 files; depth 32 covers its
    // nested node_modules trees.
    if (
      depth > SIDECAR_MAX_TREE_DEPTH ||
      inventory.size + directories.size > SIDECAR_MAX_FILE_COUNT
    ) {
      throw new Error("Staged maker inventory exceeded its bound.");
    }
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        "Maker ZIP verification does not yet support macOS framework symlinks."
      );
    }
    const relativePath = portablePath(relative(packageRoot, path));
    if (metadata.isDirectory()) {
      directories.set(relativePath, metadata.mode & 0o777);
      for (const entry of await readdir(path)) {
        await visit(join(path, entry), depth + 1);
      }
      return;
    }
    if (!metadata.isFile()) {
      throw new Error("Staged maker inventory contains a non-regular entry.");
    }
    inventory.set(relativePath, {
      bytes: metadata.size,
      sha256: await hashFile(path),
      mode: metadata.mode & 0o777
    });
  }
  await visit(packageRoot);
  return { packageRoot, inventory, directories };
}

function sameInventory(left, right) {
  return (
    left.bytes === right.bytes &&
    left.sha256 === right.sha256 &&
    left.mode === right.mode
  );
}

const authenticodeInspectionScript = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security

function Add-CmsDigestOids {
  param(
    [byte[]] $EncodedCms,
    [System.Collections.Generic.List[string]] $Digests,
    [System.Collections.Generic.List[string]] $TimestampAttributes,
    [int] $Depth
  )
  if ($Depth -gt 4) {
    throw "Nested Authenticode signature depth exceeded."
  }
  $cms = New-Object System.Security.Cryptography.Pkcs.SignedCms
  $cms.Decode($EncodedCms)
  if ($cms.SignerInfos.Count -lt 1) {
    throw "Authenticode CMS has no signer."
  }
  foreach ($signer in $cms.SignerInfos) {
    [void] $Digests.Add($signer.DigestAlgorithm.Value)
    foreach ($attribute in $signer.UnsignedAttributes) {
      if (
        $attribute.Oid.Value -eq "1.3.6.1.4.1.311.3.3.1" -or
        $attribute.Oid.Value -eq "1.2.840.113549.1.9.6"
      ) {
        [void] $TimestampAttributes.Add($attribute.Oid.Value)
      }
      if ($attribute.Oid.Value -eq "1.3.6.1.4.1.311.2.4.1") {
        foreach ($value in $attribute.Values) {
          Add-CmsDigestOids -EncodedCms $value.RawData -Digests $Digests -TimestampAttributes $TimestampAttributes -Depth ($Depth + 1)
        }
      }
    }
  }
}

$target = $env:TOKENMONSTER_AUTHENTICODE_TARGET
if ([string]::IsNullOrWhiteSpace($target)) {
  throw "Missing verification target."
}
$signature = Get-AuthenticodeSignature -LiteralPath $target
$versionInfo = (Get-Item -LiteralPath $target).VersionInfo
$bytes = [System.IO.File]::ReadAllBytes($target)
if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
  throw "Target is not a bounded PE image."
}
$peOffset = [System.BitConverter]::ToInt32($bytes, 0x3c)
if (
  $peOffset -lt 0x40 -or
  $peOffset + 152 -gt $bytes.Length -or
  $bytes[$peOffset] -ne 0x50 -or
  $bytes[$peOffset + 1] -ne 0x45 -or
  $bytes[$peOffset + 2] -ne 0 -or
  $bytes[$peOffset + 3] -ne 0
) {
  throw "Target has an invalid PE header."
}
$optionalHeader = $peOffset + 24
$magic = [System.BitConverter]::ToUInt16($bytes, $optionalHeader)
if ($magic -eq 0x10b) {
  $dataDirectories = $optionalHeader + 96
} elseif ($magic -eq 0x20b) {
  $dataDirectories = $optionalHeader + 112
} else {
  throw "Target has an unsupported PE optional header."
}
$securityDirectory = $dataDirectories + 32
if ($securityDirectory + 8 -gt $bytes.Length) {
  throw "Target has no PE security directory."
}
$certificateOffset = [System.BitConverter]::ToUInt32($bytes, $securityDirectory)
$certificateBytes = [System.BitConverter]::ToUInt32($bytes, $securityDirectory + 4)
if (
  $certificateOffset -eq 0 -or
  $certificateBytes -lt 8 -or
  [uint64]$certificateOffset + [uint64]$certificateBytes -gt [uint64]$bytes.Length
) {
  throw "Target has no bounded Authenticode certificate table."
}

$digests = New-Object "System.Collections.Generic.List[string]"
$timestampAttributes = New-Object "System.Collections.Generic.List[string]"
$cursor = [uint64]$certificateOffset
$certificateEnd = [uint64]$certificateOffset + [uint64]$certificateBytes
$containerCount = 0
while ($cursor -lt $certificateEnd) {
  if ($cursor + 8 -gt $certificateEnd) {
    throw "Truncated WIN_CERTIFICATE header."
  }
  $length = [System.BitConverter]::ToUInt32($bytes, [int]$cursor)
  $revision = [System.BitConverter]::ToUInt16($bytes, [int]$cursor + 4)
  $certificateType = [System.BitConverter]::ToUInt16($bytes, [int]$cursor + 6)
  if (
    $length -lt 8 -or
    $cursor + $length -gt $certificateEnd -or
    $revision -ne 0x200 -or
    $certificateType -ne 2
  ) {
    throw "Invalid WIN_CERTIFICATE entry."
  }
  $encodedCms = New-Object byte[] ($length - 8)
  [System.Buffer]::BlockCopy($bytes, [int]$cursor + 8, $encodedCms, 0, $length - 8)
  Add-CmsDigestOids -EncodedCms $encodedCms -Digests $digests -TimestampAttributes $timestampAttributes -Depth 0
  $containerCount += 1
  $alignedLength = [uint64](($length + 7) -band (-bnot 7))
  $cursor += $alignedLength
}
if ($cursor -ne $certificateEnd) {
  throw "WIN_CERTIFICATE alignment did not consume the security directory."
}

$result = [ordered]@{
  status = [string]$signature.Status
  signerSubject = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.Subject }
  signerThumbprint = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.Thumbprint }
  timestampSubject = if ($null -eq $signature.TimeStamperCertificate) { $null } else { $signature.TimeStamperCertificate.Subject }
  timestampThumbprint = if ($null -eq $signature.TimeStamperCertificate) { $null } else { $signature.TimeStamperCertificate.Thumbprint }
  signatureContainerCount = $containerCount
  digestOids = @($digests.ToArray())
  timestampAttributeOids = @($timestampAttributes.ToArray())
  productVersion = $versionInfo.ProductVersion
  fileVersion = $versionInfo.FileVersion
}
$result | ConvertTo-Json -Compress
`;

async function verifyWindowsAuthenticode(path, expectedSignerSubject) {
  if (process.platform !== "win32") {
    throw new Error("Authenticode verification requires native Windows.");
  }
  const systemRoot = process.env.SystemRoot;
  if (
    typeof systemRoot !== "string" ||
    systemRoot.length < 3 ||
    systemRoot.length > 260 ||
    /[\0\r\n]/u.test(systemRoot) ||
    !isAbsolute(systemRoot)
  ) {
    throw new Error(
      "Windows SystemRoot is unavailable for signature verification."
    );
  }
  const powerShell = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const powerShellMetadata = await stat(powerShell);
  if (!powerShellMetadata.isFile()) {
    throw new Error("Native Windows PowerShell is unavailable.");
  }

  let rawResult;
  try {
    rawResult = execFileSync(
      powerShell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(authenticodeInspectionScript, "utf16le").toString("base64")
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TOKENMONSTER_AUTHENTICODE_TARGET: path
        },
        maxBuffer: 1_024 * 1_024,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
  } catch {
    throw new Error("Native Authenticode verification failed closed.");
  }

  let result;
  try {
    result = JSON.parse(rawResult.replace(/^\uFEFF/u, "").trim());
  } catch {
    throw new Error(
      "Native Authenticode verification returned invalid evidence."
    );
  }
  return authenticodeEvidenceFromInspection(result, expectedSignerSubject);
}

async function stagedWindowsAuthenticodeEvidence(asarPath) {
  if (mode !== "signed" || process.platform !== "win32") return [];
  const packageRoot = packageRootForAsar(asarPath);
  const signablePaths = (await walkFiles(packageRoot))
    .filter(isWindowsSignablePath)
    .sort();
  const mainExecutable = join(packageRoot, "TokenMonster.exe");
  if (
    signablePaths.length < 1 ||
    !signablePaths.includes(mainExecutable) ||
    expectedWindowsSignerSubject === null
  ) {
    throw new Error("Signed Windows staging has no main executable inventory.");
  }
  const evidence = [];
  for (const path of signablePaths) {
    const authenticode = await verifyWindowsAuthenticode(
      path,
      expectedWindowsSignerSubject
    );
    if (
      path === mainExecutable &&
      authenticode.productVersion !== releaseVersion
    ) {
      throw new Error(
        "Staged Windows executable ProductVersion differs from the release version."
      );
    }
    evidence.push({
      path: portablePath(relative(rootDirectory, path)),
      ...authenticode
    });
  }
  return evidence;
}

// Foreign-platform zips cannot support the linux byte/mode inventory diff
// (PowerShell zips drop unix modes; .app staging trees contain framework
// symlinks), so they get bounded structural checks plus proof that the
// packaged executable is present.
async function verifyForeignPlatformZip(path) {
  const zip = await zipInventory(path, { lenientModes: true });
  const executableSuffix =
    process.platform === "win32"
      ? "TokenMonster.exe"
      : "Contents/MacOS/TokenMonster";
  const containsExecutable = [...zip.files.keys()].some((name) =>
    name.endsWith(executableSuffix)
  );
  if (!containsExecutable) {
    throw new Error("Maker ZIP does not contain the packaged executable.");
  }
  return {
    verification: "entry-safety-and-executable-presence",
    fileCount: zip.files.size,
    entryCount: zip.entries,
    uncompressedBytes: zip.totalBytes
  };
}

async function verifyZipMakerArtifact(path, asarPath) {
  if (process.platform !== "linux") {
    return verifyForeignPlatformZip(path);
  }
  const staged = await stagedPackageInventory(asarPath);
  const zip = await zipInventory(path);
  const prefixes = ["", `${basename(staged.packageRoot)}/`];
  const prefix = prefixes.find((candidate) => {
    const expectedNames = [...staged.inventory.keys()]
      .map((name) => `${candidate}${name}`)
      .sort();
    return (
      JSON.stringify([...zip.files.keys()].sort()) ===
      JSON.stringify(expectedNames)
    );
  });
  if (prefix === undefined) {
    throw new Error(
      "Maker ZIP file inventory differs from the verified package."
    );
  }
  for (const [name, expected] of staged.inventory) {
    const actual = zip.files.get(`${prefix}${name}`);
    if (actual === undefined || !sameInventory(actual, expected)) {
      throw new Error(
        `Maker ZIP content differs from the verified package: ${name}`
      );
    }
  }
  const expectedDirectories = new Map(
    [...staged.directories].map(([name, mode]) => [
      name === "" ? prefix.slice(0, -1) : `${prefix}${name}`,
      mode
    ])
  );
  if (
    expectedDirectories.size !== zip.directories.size ||
    [...expectedDirectories].some(
      ([name, mode]) => zip.directories.get(name) !== mode
    )
  ) {
    throw new Error(
      "Maker ZIP directory inventory or mode differs from staging."
    );
  }
  for (const directory of zip.directories.keys()) {
    if (!expectedDirectories.has(directory)) {
      throw new Error("Maker ZIP contains an unrelated directory.");
    }
  }
  const canonical = [...zip.files]
    .map(([name, value]) => [name.slice(prefix.length), value])
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    verification: "full-byte-mode-inventory",
    fileCount: zip.files.size,
    entryCount: zip.entries,
    uncompressedBytes: zip.totalBytes,
    contentInventorySha256: sha256(
      Buffer.from(JSON.stringify(canonical), "utf8")
    )
  };
}

async function verifySquirrelNupkg(
  path,
  expectedSidecarInventory,
  stagedAsarPath
) {
  const zip = await zipInventory(path, { lenientModes: true });
  const sidecarFileCount = assertSquirrelSidecarInventory(
    zip.files,
    expectedSidecarInventory
  );
  const squirrelVersion = squirrelVersionFor(releaseVersion);
  if (basename(path) !== `TokenMonster-${squirrelVersion}-full.nupkg`) {
    throw new Error(
      "Full Squirrel package name does not match the release version."
    );
  }
  const embeddedAsars = [...zip.files].filter(([archivePath]) =>
    /(?:^|\/)resources\/app\.asar$/iu.test(archivePath)
  );
  const stagedAsarMetadata = await stat(stagedAsarPath);
  if (
    embeddedAsars.length !== 1 ||
    embeddedAsars[0][1].bytes !== stagedAsarMetadata.size ||
    embeddedAsars[0][1].sha256 !== (await hashFile(stagedAsarPath))
  ) {
    throw new Error(
      "Full Squirrel package does not embed the verified application ASAR."
    );
  }

  const extractionDirectory =
    mode === "signed" && process.platform === "win32"
      ? await mkdtemp(join(tmpdir(), "tokenmonster-squirrel-signatures-"))
      : null;
  let versionEvidence;
  try {
    const archiveInspection = await inspectSquirrelArchive(
      path,
      extractionDirectory
    );
    if (archiveInspection.nuspecs.length !== 1) {
      throw new Error(
        "Full Squirrel package must contain exactly one .nuspec."
      );
    }
    const nuspecText = archiveInspection.nuspecs[0].contents.toString("utf8");
    const versionMatches = [
      ...nuspecText.matchAll(/<version>([^<]+)<\/version>/giu)
    ];
    if (
      nuspecText.includes("\0") ||
      versionMatches.length !== 1 ||
      versionMatches[0][1] !== squirrelVersion
    ) {
      throw new Error(
        "Squirrel .nuspec version does not match the release version."
      );
    }

    const payloadAuthenticode = [];
    if (extractionDirectory !== null) {
      if (
        archiveInspection.portableExecutables.length < 1 ||
        expectedWindowsSignerSubject === null
      ) {
        throw new Error(
          "Signed Squirrel package has no signable PE payload inventory."
        );
      }
      let mainExecutableCount = 0;
      for (const payload of archiveInspection.portableExecutables) {
        const authenticode = await verifyWindowsAuthenticode(
          payload.extractedPath,
          expectedWindowsSignerSubject
        );
        if (/(?:^|\/)TokenMonster\.exe$/iu.test(payload.archivePath)) {
          mainExecutableCount += 1;
          if (authenticode.productVersion !== releaseVersion) {
            throw new Error(
              "Squirrel application ProductVersion differs from the release version."
            );
          }
        }
        payloadAuthenticode.push({
          archivePath: payload.archivePath,
          ...authenticode
        });
      }
      if (mainExecutableCount !== 1) {
        throw new Error(
          "Full Squirrel package must contain exactly one TokenMonster executable."
        );
      }
    }
    versionEvidence = {
      nuspecPath: archiveInspection.nuspecs[0].archivePath,
      payloadAuthenticode
    };
  } finally {
    if (extractionDirectory !== null) {
      await rm(extractionDirectory, { force: true, recursive: true });
    }
  }
  return {
    verification: "squirrel-full-sidecar-byte-inventory",
    fileCount: zip.files.size,
    entryCount: zip.entries,
    uncompressedBytes: zip.totalBytes,
    sidecarFileCount,
    releaseVersion,
    squirrelVersion,
    nuspecPath: versionEvidence.nuspecPath,
    embeddedAsarSha256: embeddedAsars[0][1].sha256,
    containerAuthenticode: "not-applicable-zip-container",
    payloadAuthenticode: versionEvidence.payloadAuthenticode
  };
}

async function makerEvidence(asarPath, expectedSidecarInventory) {
  const makeDirectory = join(outDirectory, "make");
  const signedMakerRequired = mode === "signed";
  let files;
  try {
    files = await walkFiles(makeDirectory, {
      rejectLinks: mode === "signed"
    });
  } catch (error) {
    if (error?.code === "ENOENT" && !requireMaker && !signedMakerRequired) {
      process.stdout.write(
        "No Squirrel maker output found; skipping .nupkg sidecar verification.\n"
      );
      return [];
    }
    if (error?.code === "ENOENT") {
      throw new Error("Forge maker output is required but missing.");
    }
    throw error;
  }
  const squirrelReleases = files.filter(
    (path) => basename(path).toUpperCase() === "RELEASES"
  );
  const squirrelPackages = files.filter(
    (path) => extname(path).toLowerCase() === ".nupkg"
  );
  const squirrelSetups = files.filter((path) =>
    /Setup\.exe$/iu.test(basename(path))
  );
  const hasSquirrelOutput =
    squirrelReleases.length + squirrelPackages.length + squirrelSetups.length >
    0;
  if (!hasSquirrelOutput) {
    if (mode === "signed" && process.platform === "win32") {
      throw new Error(
        "Signed Windows release requires complete Squirrel output."
      );
    }
    process.stdout.write(
      "No Squirrel maker output found; skipping .nupkg sidecar verification.\n"
    );
  } else if (
    squirrelReleases.length !== 1 ||
    squirrelSetups.length !== 1 ||
    squirrelPackages.length < 1
  ) {
    throw new Error(
      `Incomplete Squirrel maker output: RELEASES=${squirrelReleases.length}, nupkg=${squirrelPackages.length}, Setup.exe=${squirrelSetups.length}.`
    );
  }
  const fullSquirrelPackages = squirrelPackages.filter((path) =>
    /-full\.nupkg$/iu.test(basename(path))
  );
  if (hasSquirrelOutput && fullSquirrelPackages.length !== 1) {
    throw new Error(
      `Expected exactly one full Squirrel .nupkg, found ${fullSquirrelPackages.length}.`
    );
  }
  if (
    hasSquirrelOutput &&
    (basename(squirrelSetups[0]) !== "TokenMonsterSetup.exe" ||
      basename(fullSquirrelPackages[0]) !==
        `TokenMonster-${squirrelVersionFor(releaseVersion)}-full.nupkg`)
  ) {
    throw new Error(
      "Squirrel maker paths do not match the release version policy."
    );
  }
  if (hasSquirrelOutput && mode === "signed" && process.platform === "win32") {
    const squirrelDirectory = dirname(squirrelReleases[0]);
    if (
      dirname(squirrelSetups[0]) !== squirrelDirectory ||
      dirname(fullSquirrelPackages[0]) !== squirrelDirectory
    ) {
      throw new Error("Signed Squirrel publication files must share one directory.");
    }
    const squirrelFiles = files.filter(
      (path) =>
        path === squirrelDirectory || path.startsWith(`${squirrelDirectory}${sep}`)
    );
    requireSignedWindowsSquirrelInventory(
      squirrelFiles.map((path) => basename(path)),
      basename(fullSquirrelPackages[0])
    );
  }
  if (hasSquirrelOutput) {
    const releasesContents = await readFile(squirrelReleases[0], "utf8");
    if (
      releasesContents.length < 1 ||
      releasesContents.length > 64 * 1_024 ||
      releasesContents.includes("\0")
    ) {
      throw new Error("Squirrel RELEASES metadata is malformed.");
    }
    const fullName = basename(fullSquirrelPackages[0]);
    const fullLines = releasesContents
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim().split(/\s+/u))
      .filter((parts) => parts[1] === fullName);
    if (fullLines.length !== 1) {
      throw new Error(
        "Squirrel RELEASES must contain exactly one full package entry."
      );
    }
    const fullPackageMetadata = await stat(fullSquirrelPackages[0]);
    const fullPackageSha1 = await hashFile(fullSquirrelPackages[0], "sha1");
    requireSquirrelReleaseEntry(fullLines[0], {
      fileName: fullName,
      byteSize: fullPackageMetadata.size,
      sha1: fullPackageSha1
    });
  }
  const artifacts = files.filter((path) => {
    const extension = extname(path).toLowerCase();
    return (
      extension === ".dmg" ||
      extension === ".zip" ||
      extension === ".nupkg" ||
      basename(path).toUpperCase() === "RELEASES" ||
      /Setup\.exe$/iu.test(basename(path))
    );
  });
  if (requireMaker && artifacts.length === 0) {
    throw new Error("Forge maker produced no supported artifact.");
  }
  if (
    mode === "signed" &&
    process.platform === "darwin" &&
    !artifacts.some((path) => extname(path).toLowerCase() === ".dmg")
  ) {
    throw new Error("Signed macOS release requires a DMG artifact.");
  }
  const evidence = [];
  for (const path of artifacts.sort()) {
    const extension = extname(path).toLowerCase();
    const contentVerification =
      extension === ".zip"
        ? await verifyZipMakerArtifact(path, asarPath)
        : extension === ".nupkg" && fullSquirrelPackages.includes(path)
          ? await verifySquirrelNupkg(path, expectedSidecarInventory, asarPath)
          : extension === ".dmg"
            ? { verification: "signed-dmg-native-verification-required" }
            : extension === ".exe" &&
                mode === "signed" &&
                process.platform === "win32"
              ? {
                  verification: "native-authenticode",
                  ...(await verifyWindowsAuthenticode(
                    path,
                    expectedWindowsSignerSubject
                  ))
                }
              : extension === ".nupkg"
                ? { verification: "squirrel-delta-package-hash-only" }
                : { verification: "squirrel-maker-marker-hash-only" };
    if (extension === ".dmg") {
      throw new Error(
        "DMG release verification is blocked until native mount, nested app identity, and stapled-ticket verification are implemented."
      );
    }
    evidence.push({
      path: portablePath(relative(rootDirectory, path)),
      bytes: (await stat(path)).size,
      sha256: await hashFile(path),
      ...contentVerification
    });
  }
  return evidence;
}

function verifySignedMacApplication(asarPath) {
  if (mode !== "signed") return;
  if (process.platform === "win32") return;
  const appPath = packageRootForAsar(asarPath);
  if (process.platform !== "darwin" || !basename(appPath).endsWith(".app")) {
    throw new Error("Signed verification requires a packaged macOS app.");
  }
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit"
  });
  execFileSync("spctl", ["--assess", "--type", "execute", appPath], {
    stdio: "inherit"
  });
}

assertManifestPolicy();
if (
  mode === "signed" &&
  process.platform === "darwin" &&
  manifest.collector.signedReleaseStatus !== "ready"
) {
  throw new Error(
    `Signed release blocked by collector state: ${manifest.collector.signedReleaseStatus}.`
  );
}
const appAsars = await findAppAsars();
if (appAsars.length !== 1) {
  throw new Error(
    `Expected exactly one packaged app.asar, found ${appAsars.length}.`
  );
}
const asarPath = appAsars[0];
const runtimeSnapshots = await verifyPackagePathsAndSnapshots(asarPath);
const collectorEvidence = await verifyCollectorExtraResource(asarPath);
const verifiedSidecar = await verifySidecarExtraResource(asarPath);
const { inventory: sidecarInventory, ...sidecarEvidence } = verifiedSidecar;

const extractionDirectory = await mkdtemp(
  join(tmpdir(), "tokenmonster-package-verification-")
);
let inventory;
try {
  inventory = await assertAsarInventory(asarPath, extractionDirectory);
} finally {
  await rm(extractionDirectory, { force: true, recursive: true });
}
const binaryPath = fuseBinaryPath(asarPath);
const fuseWires = await verifyRawFuseWires(binaryPath);
verifySignedMacApplication(asarPath);
const stagedAuthenticode = await stagedWindowsAuthenticodeEvidence(asarPath);
const makerArtifacts = await makerEvidence(asarPath, sidecarInventory);

const evidenceDirectory = join(rootDirectory, "release-evidence");
await mkdir(evidenceDirectory, { recursive: true });
const evidence = {
  schemaVersion: 2,
  mode,
  declaredSigned: mode === "signed",
  releaseVersion: {
    requested: releaseVersion,
    sourcePackageVersion: SOURCE_COMPANION_VERSION,
    packagedApplicationVersion: releaseVersion,
    electronAppGetVersionSource: "packaged-package-json",
    packagerAppVersion: releaseVersion,
    squirrelVersion:
      process.platform === "win32" ? squirrelVersionFor(releaseVersion) : null
  },
  appAsar: {
    path: portablePath(relative(rootDirectory, asarPath)),
    bytes: (await stat(asarPath)).size,
    sha256: await hashFile(asarPath)
  },
  runtimeInventory: inventory,
  asarHeaderIntegrityVerified: true,
  runtimeExternalAllowlist: allowedBareImports,
  fuseWires,
  runtimeSnapshots,
  stagedAuthenticode,
  makerArtifacts,
  collector: collectorEvidence,
  sidecar: sidecarEvidence
};
await writeFile(
  join(evidenceDirectory, "companion-package.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
  { mode: 0o600 }
);

process.stdout.write(
  `Verified ${inventory.length} ASAR files, ${fuseWires.length} fuse wire(s), and ${makerArtifacts.length} maker artifact(s).\n`
);
process.stdout.write(
  `Verified ${collectorEvidence.target} collector ${collectorEvidence.packageVersion} with ${collectorEvidence.files.length} file(s) without executing it.\n`
);
process.stdout.write(
  `Verified sidecar ${sidecarEvidence.sidecarVersion} with ${sidecarEvidence.fileCount} file(s) and ${sidecarEvidence.totalBytes} byte(s).\n`
);
