"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { constants } = require("node:fs");
const {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} = require("node:fs/promises");
const { createRequire } = require("node:module");
const { basename, dirname, join, relative, resolve, sep } = require("node:path");

const RELEASE_PACKAGE_NAME = "tokenmonster";
const SIDECAR_PACKAGE_NAME = "tokentracker-cli";
const SIDECAR_PACKAGE_VERSION = "0.80.0";
const ZSTD_PACKAGE_NAME = "@mongodb-js/zstd";
const ZSTD_PACKAGE_VERSION = "2.0.1";
const ZSTD_DEPENDENCY_SPECIFIER = "^2.0.1";
const ZSTD_RELEASE_DEPENDENCY_SPECIFIER = "2.0.1";
const PREINSTALL_COMMAND = "node preinstall-zstd.cjs";
const PREBUILD_DIRECTORY_NAME = "prebuilds";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_SIDECAR_MANIFEST_BYTES = 64 * 1024;
const SIDECAR_MANIFEST_POLICY = Object.freeze({
  bytes: 2_779,
  sha256: "392d6b29616c0f431914ecd5a5620b251fdb79144dd972fd55bb5ab248228824",
});
const READ_ONLY_NOFOLLOW_FLAGS =
  constants.O_RDONLY |
  (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);

const UPSTREAM_ZSTD_FILE_POLICY = Object.freeze({
  "LICENSE.md": Object.freeze({
    bytes: 11_304,
    sha256: "a5fa667ca7b41aa4c715772c98c7c0794364bfc6b2a6dab35cb18a341a4d03e3",
  }),
  "README.md": Object.freeze({
    bytes: 4_150,
    sha256: "ce184ff17b2fadf42b48e58ba1d642e70d4723a38a0ad889b818c364e173bb6d",
  }),
  "addon/compression.cpp": Object.freeze({
    bytes: 3_395,
    sha256: "9523921eee480d49bc765a3482a49f27af2b5706b65d562b1e3dc62896e0e2ee",
  }),
  "addon/compression.h": Object.freeze({
    bytes: 378,
    sha256: "1be369082c6687e69deb628de4669e24c1dfa134e8f4b63f9a18a3287e8d9eb7",
  }),
  "addon/compression_worker.h": Object.freeze({
    bytes: 1_344,
    sha256: "189738e73eeff2dd3e32b6d02dff062c047769798bd6dca287559dc94f5654e0",
  }),
  "addon/zstd.cpp": Object.freeze({
    bytes: 1_853,
    sha256: "b84c831d22a3395a7877523c79238e9c6acbc222edff388d105d0843fb636e27",
  }),
  "binding.gyp": Object.freeze({
    bytes: 1_824,
    sha256: "41b2ee58144f4ccf9b55be3a5e889e3a1a4b4cb2930f83554f00133907e7ae1a",
  }),
  "index.d.ts": Object.freeze({
    bytes: 167,
    sha256: "a95ef88da3927452fb39ce57581f5f8116f01ca3c1ad0629137561031f5de4ad",
  }),
  "lib/index.js": Object.freeze({
    bytes: 1_445,
    sha256: "d25e32c958ee68deceb5037e298fce1908ecafee78924221271f463bfb7b1513",
  }),
  "package.json": Object.freeze({
    bytes: 1_578,
    sha256: "44f9a4da0f2294f36892dc3331642038c0fe5b51d5bdb7d7357fc29894595aad",
  }),
});

const ZSTD_PREBUILD_POLICY = Object.freeze({
  "darwin-arm64": Object.freeze({
    platform: "darwin",
    arch: "arm64",
    archiveName: "zstd-v2.0.1-napi-v4-darwin-arm64.tar.gz",
    archiveBytes: 579_039,
    archiveSha256:
      "1ce2361053c84792c29d4fa0bcea0242d7c7ce4c0c2867d8529f6175bb2a253c",
  }),
  "linux-x64": Object.freeze({
    platform: "linux",
    arch: "x64",
    archiveName: "zstd-v2.0.1-napi-v4-linux-x64.tar.gz",
    archiveBytes: 399_393,
    archiveSha256:
      "92c56d6e7b2cdd3614c98e08e7c28caef208977a943f44b3ddeca690ed25da4b",
  }),
  "win32-x64": Object.freeze({
    platform: "win32",
    arch: "x64",
    archiveName: "zstd-v2.0.1-napi-v4-win32-x64.tar.gz",
    archiveBytes: 240_073,
    archiveSha256:
      "10aa97840eaf7449806c4e600cb8f48f7926dc89bf08fdc5d99295fa7e21729e",
  }),
});

const EXPECTED_PLATFORM_KEYS = Object.freeze([
  "darwin-arm64",
  "linux-x64",
  "win32-x64",
]);
const UPSTREAM_ZSTD_FILE_PATHS = Object.freeze(
  Object.keys(UPSTREAM_ZSTD_FILE_POLICY).sort(),
);
const UPSTREAM_ZSTD_DIRECTORIES = Object.freeze(["addon", "lib"]);

function fail(message) {
  throw new Error(message);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function samePlatformPath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") ===
        normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function sameStringArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileMetadataIdentity(metadata) {
  return [
    metadata.dev,
    metadata.ino,
    metadata.nlink,
    metadata.size,
    metadata.mtimeNs,
    metadata.ctimeNs,
  ].join(":");
}

function directoryMetadataIdentity(metadata) {
  return `${metadata.dev}:${metadata.ino}`;
}

function hasErrorCode(error, expectedCode) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === expectedCode
  );
}

async function snapshotPhysicalDirectory(requestedPath, label) {
  const path = resolve(requestedPath);
  let before;
  let physicalPathBefore;
  let after;
  let physicalPathAfter;
  try {
    before = await lstat(path, { bigint: true });
    physicalPathBefore = await realpath(path);
    after = await lstat(path, { bigint: true });
    physicalPathAfter = await realpath(path);
  } catch {
    fail(`${label} must be a physical directory`);
  }
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    !samePlatformPath(path, physicalPathBefore) ||
    !samePlatformPath(path, physicalPathAfter) ||
    directoryMetadataIdentity(before) !== directoryMetadataIdentity(after)
  ) {
    fail(`${label} must be a physical directory`);
  }
  return Object.freeze({
    path,
    identity: directoryMetadataIdentity(after),
  });
}

async function requirePhysicalDirectory(requestedPath, label) {
  return (await snapshotPhysicalDirectory(requestedPath, label)).path;
}

async function revalidatePhysicalDirectory(snapshot, label) {
  const current = await snapshotPhysicalDirectory(snapshot.path, label);
  if (current.identity !== snapshot.identity) {
    fail(`${label} changed during zstd preinstall`);
  }
}

async function readExactPhysicalFile(
  path,
  expected,
  label,
  { allowHardlinks = false } = {},
) {
  let before;
  let physicalPathBefore;
  let handle;
  let handleBefore;
  let bytes;
  let handleAfter;
  let after;
  let physicalPathAfter;
  try {
    before = await lstat(path, { bigint: true });
    physicalPathBefore = await realpath(path);
    handle = await open(path, READ_ONLY_NOFOLLOW_FLAGS);
    handleBefore = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !handleBefore.isFile() ||
      handleBefore.isSymbolicLink() ||
      (!allowHardlinks && before.nlink !== 1n) ||
      !samePlatformPath(path, physicalPathBefore) ||
      before.size !== BigInt(expected.bytes) ||
      fileMetadataIdentity(before) !== fileMetadataIdentity(handleBefore)
    ) {
      fail(`${label} must be an exact physical file`);
    }
    bytes = await handle.readFile();
    handleAfter = await handle.stat({ bigint: true });
    after = await lstat(path, { bigint: true });
    physicalPathAfter = await realpath(path);
  } catch {
    fail(`${label} must be an exact physical file`);
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !handleBefore.isFile() ||
    handleBefore.isSymbolicLink() ||
    !handleAfter.isFile() ||
    handleAfter.isSymbolicLink() ||
    !after.isFile() ||
    after.isSymbolicLink() ||
    (!allowHardlinks && before.nlink !== 1n) ||
    !samePlatformPath(path, physicalPathBefore) ||
    !samePlatformPath(path, physicalPathAfter) ||
    before.size !== BigInt(expected.bytes) ||
    bytes.length !== expected.bytes ||
    fileMetadataIdentity(before) !== fileMetadataIdentity(handleBefore) ||
    fileMetadataIdentity(before) !== fileMetadataIdentity(handleAfter) ||
    fileMetadataIdentity(before) !== fileMetadataIdentity(after) ||
    sha256(bytes) !== expected.sha256
  ) {
    fail(`${label} must be an exact physical file`);
  }
  return bytes;
}

async function readBoundedPhysicalFile(path, maximumBytes, label) {
  let before;
  let physicalPathBefore;
  let handle;
  let handleBefore;
  let bytes;
  let handleAfter;
  let after;
  let physicalPathAfter;
  try {
    before = await lstat(path, { bigint: true });
    physicalPathBefore = await realpath(path);
    handle = await open(path, READ_ONLY_NOFOLLOW_FLAGS);
    handleBefore = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !handleBefore.isFile() ||
      handleBefore.isSymbolicLink() ||
      before.nlink !== 1n ||
      !samePlatformPath(path, physicalPathBefore) ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes) ||
      fileMetadataIdentity(before) !== fileMetadataIdentity(handleBefore)
    ) {
      fail(`${label} must be a bounded physical file`);
    }
    bytes = await handle.readFile();
    handleAfter = await handle.stat({ bigint: true });
    after = await lstat(path, { bigint: true });
    physicalPathAfter = await realpath(path);
  } catch {
    fail(`${label} must be a bounded physical file`);
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !handleBefore.isFile() ||
    handleBefore.isSymbolicLink() ||
    !handleAfter.isFile() ||
    handleAfter.isSymbolicLink() ||
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.nlink !== 1n ||
    !samePlatformPath(path, physicalPathBefore) ||
    !samePlatformPath(path, physicalPathAfter) ||
    before.size < 1n ||
    before.size > BigInt(maximumBytes) ||
    bytes.length !== Number(before.size) ||
    fileMetadataIdentity(before) !== fileMetadataIdentity(handleBefore) ||
    fileMetadataIdentity(before) !== fileMetadataIdentity(handleAfter) ||
    fileMetadataIdentity(before) !== fileMetadataIdentity(after)
  ) {
    fail(`${label} must be a bounded physical file`);
  }
  return bytes;
}

async function collectPackageInventory(packageRoot, label) {
  const pending = [packageRoot];
  const files = [];
  const directories = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      fail(`${label} inventory could not be read`);
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const portablePath = relative(packageRoot, path).split(sep).join("/");
      let metadata;
      let physicalPath;
      try {
        metadata = await lstat(path);
        physicalPath = await realpath(path);
      } catch {
        fail(`${label} inventory contains an invalid entry`);
      }
      if (metadata.isSymbolicLink() || !samePlatformPath(path, physicalPath)) {
        fail(`${label} inventory contains an invalid entry`);
      }
      if (metadata.isDirectory()) {
        if (portablePath === "node_modules") {
          continue;
        }
        directories.push(portablePath);
        pending.push(path);
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1) {
          fail(`${label} inventory contains an invalid entry`);
        }
        files.push(portablePath);
      } else {
        fail(`${label} inventory contains an invalid entry`);
      }
    }
  }
  return Object.freeze({
    directories: Object.freeze(directories.sort()),
    files: Object.freeze(files.sort()),
  });
}

function requirePrebuildPolicy(rawPolicy) {
  if (!isPlainRecord(rawPolicy)) {
    fail("zstd preinstall policy must be exact");
  }
  const keys = Object.keys(rawPolicy).sort();
  if (!sameStringArray(keys, EXPECTED_PLATFORM_KEYS)) {
    fail("zstd preinstall policy must be exact");
  }
  for (const platformKey of EXPECTED_PLATFORM_KEYS) {
    const entry = rawPolicy[platformKey];
    if (!isPlainRecord(entry)) {
      fail("zstd preinstall policy must be exact");
    }
    const expectedKeys = [
      "arch",
      "archiveBytes",
      "archiveName",
      "archiveSha256",
      "platform",
    ];
    if (!sameStringArray(Object.keys(entry).sort(), expectedKeys)) {
      fail("zstd preinstall policy must be exact");
    }
    const [expectedPlatform, expectedArch] = platformKey.split("-");
    if (
      entry.platform !== expectedPlatform ||
      entry.arch !== expectedArch ||
      entry.archiveName !==
        `zstd-v2.0.1-napi-v4-${platformKey}.tar.gz` ||
      !Number.isSafeInteger(entry.archiveBytes) ||
      entry.archiveBytes < 1 ||
      typeof entry.archiveSha256 !== "string" ||
      !SHA256_PATTERN.test(entry.archiveSha256)
    ) {
      fail("zstd preinstall policy must be exact");
    }
  }
  return rawPolicy;
}

function platformEntry(policy, platform, arch) {
  const platformKey = `${platform}-${arch}`;
  const entry = policy[platformKey];
  if (entry === undefined) {
    fail("zstd preinstall does not support this platform");
  }
  return Object.freeze({ platformKey, entry });
}

async function requireZstdPackage(
  packageRoot,
  prebuildPolicy,
  prebuildMode,
  label,
) {
  if (!new Set(["all", "none", "subset"]).has(prebuildMode)) {
    fail(`${label} inventory mode must be exact`);
  }
  const rootDirectory = await snapshotPhysicalDirectory(packageRoot, label);
  const root = rootDirectory.path;
  const archiveNames = EXPECTED_PLATFORM_KEYS.map(
    (key) => prebuildPolicy[key].archiveName,
  ).sort();
  const inventory = await collectPackageInventory(root, label);
  const presentArchiveNames = inventory.files
    .filter((path) => path.startsWith(`${PREBUILD_DIRECTORY_NAME}/`))
    .map((path) => path.slice(PREBUILD_DIRECTORY_NAME.length + 1))
    .sort();
  const expectedFiles = [
    ...UPSTREAM_ZSTD_FILE_PATHS,
    ...presentArchiveNames.map(
      (name) => `${PREBUILD_DIRECTORY_NAME}/${name}`,
    ),
  ].sort();
  const expectedDirectories = [
    ...UPSTREAM_ZSTD_DIRECTORIES,
    ...(presentArchiveNames.length > 0 ||
    inventory.directories.includes(PREBUILD_DIRECTORY_NAME)
      ? [PREBUILD_DIRECTORY_NAME]
      : []),
  ].sort();
  const prebuildInventoryIsAllowed = presentArchiveNames.every((name) =>
    archiveNames.includes(name),
  );
  const prebuildModeIsSatisfied =
    (prebuildMode === "all" &&
      sameStringArray(presentArchiveNames, archiveNames)) ||
    (prebuildMode === "none" && presentArchiveNames.length === 0) ||
    prebuildMode === "subset";
  if (
    !prebuildInventoryIsAllowed ||
    !prebuildModeIsSatisfied ||
    !sameStringArray(inventory.files, expectedFiles) ||
    !sameStringArray(inventory.directories, expectedDirectories) ||
    (prebuildMode === "none" &&
      inventory.directories.includes(PREBUILD_DIRECTORY_NAME))
  ) {
    fail(`${label} inventory must be exact`);
  }
  const prebuildDirectory = inventory.directories.includes(
    PREBUILD_DIRECTORY_NAME,
  )
    ? await snapshotPhysicalDirectory(
        join(root, PREBUILD_DIRECTORY_NAME),
        `${label} prebuild directory`,
      )
    : null;

  const upstreamFiles = new Map();
  for (const relativePath of UPSTREAM_ZSTD_FILE_PATHS) {
    const bytes = await readExactPhysicalFile(
      join(root, ...relativePath.split("/")),
      UPSTREAM_ZSTD_FILE_POLICY[relativePath],
      `${label} upstream file`,
    );
    upstreamFiles.set(relativePath, bytes);
  }
  let manifest;
  try {
    manifest = JSON.parse(upstreamFiles.get("package.json").toString("utf8"));
  } catch {
    fail(`${label} manifest must be exact`);
  }
  if (
    !isPlainRecord(manifest) ||
    manifest.name !== ZSTD_PACKAGE_NAME ||
    manifest.version !== ZSTD_PACKAGE_VERSION
  ) {
    fail(`${label} manifest must be exact`);
  }

  const archives = new Map();
  for (const platformKey of EXPECTED_PLATFORM_KEYS) {
    const entry = prebuildPolicy[platformKey];
    if (presentArchiveNames.includes(entry.archiveName)) {
      const bytes = await readExactPhysicalFile(
        join(root, PREBUILD_DIRECTORY_NAME, entry.archiveName),
        { bytes: entry.archiveBytes, sha256: entry.archiveSha256 },
        `${label} native archive`,
      );
      archives.set(entry.archiveName, bytes);
    }
  }
  if (prebuildDirectory !== null) {
    await revalidatePhysicalDirectory(
      prebuildDirectory,
      `${label} prebuild directory`,
    );
  }
  await revalidatePhysicalDirectory(rootDirectory, label);
  return Object.freeze({
    root,
    rootDirectory,
    prebuildDirectory,
    archives,
  });
}

async function requireSidecarPackage(sidecarRoot, label) {
  const rootDirectory = await snapshotPhysicalDirectory(sidecarRoot, label);
  const manifestBytes = await readExactPhysicalFile(
    join(rootDirectory.path, "package.json"),
    SIDECAR_MANIFEST_POLICY,
    `${label} manifest`,
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail(`${label} manifest must be exact`);
  }
  if (
    !isPlainRecord(manifest) ||
    manifest.name !== SIDECAR_PACKAGE_NAME ||
    manifest.version !== SIDECAR_PACKAGE_VERSION ||
    !isPlainRecord(manifest.dependencies) ||
    manifest.dependencies[ZSTD_PACKAGE_NAME] !== ZSTD_DEPENDENCY_SPECIFIER
  ) {
    fail(`${label} manifest must be exact`);
  }
  await revalidatePhysicalDirectory(rootDirectory, label);
  return rootDirectory;
}

async function requireReleasePackage(releaseRoot) {
  const manifestBytes = await readBoundedPhysicalFile(
    join(releaseRoot, "package.json"),
    MAX_SIDECAR_MANIFEST_BYTES,
    "TokenMonster release manifest",
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("TokenMonster release manifest must be exact");
  }
  if (
    !isPlainRecord(manifest) ||
    manifest.name !== RELEASE_PACKAGE_NAME ||
    !isPlainRecord(manifest.dependencies) ||
    manifest.dependencies[SIDECAR_PACKAGE_NAME] !== SIDECAR_PACKAGE_VERSION ||
    manifest.dependencies[ZSTD_PACKAGE_NAME] !==
      ZSTD_RELEASE_DEPENDENCY_SPECIFIER ||
    !isPlainRecord(manifest.scripts) ||
    !sameStringArray(Object.keys(manifest.scripts), ["preinstall"]) ||
    manifest.scripts.preinstall !== PREINSTALL_COMMAND ||
    !Array.isArray(manifest.bundleDependencies) ||
    manifest.bundleDependencies.filter(
      (dependencyName) => dependencyName === ZSTD_PACKAGE_NAME,
    ).length !== 1
  ) {
    fail("TokenMonster release manifest must be exact");
  }
}

async function requireResolvedPhysicalPackageRoot(
  resolvedManifest,
  candidateRoots,
  label,
) {
  let selectedRoot = null;
  for (const candidateRoot of candidateRoots) {
    const manifestMetadata = await lstatOrNull(
      join(candidateRoot, "package.json"),
      `${label} manifest`,
    );
    if (manifestMetadata === null) continue;
    selectedRoot = (
      await snapshotPhysicalDirectory(candidateRoot, label)
    ).path;
    break;
  }
  if (
    selectedRoot === null ||
    !samePlatformPath(
      resolvedManifest,
      join(selectedRoot, "package.json"),
    )
  ) {
    fail(`${label} resolved outside the fixed npm layout`);
  }
  return selectedRoot;
}

async function resolveInstalledPackages(releasePackageRoot) {
  const releaseDirectory = await snapshotPhysicalDirectory(
    releasePackageRoot,
    "TokenMonster release package",
  );
  const releaseRoot = releaseDirectory.path;
  const parentNodeModules = dirname(releaseRoot);
  if (
    basename(releaseRoot) !== RELEASE_PACKAGE_NAME ||
    basename(parentNodeModules) !== "node_modules"
  ) {
    fail("TokenMonster release package has an invalid npm layout");
  }
  const parentDirectory = await snapshotPhysicalDirectory(
    parentNodeModules,
    "npm package root",
  );
  await requireReleasePackage(releaseRoot);

  const sourceRoot = join(
    releaseRoot,
    "node_modules",
    "@mongodb-js",
    "zstd",
  );
  const allowedSidecarRoots = [
    join(releaseRoot, "node_modules", SIDECAR_PACKAGE_NAME),
    join(parentNodeModules, SIDECAR_PACKAGE_NAME),
  ];
  let resolvedSidecarManifest;
  try {
    resolvedSidecarManifest = createRequire(join(releaseRoot, "package.json"))
      .resolve(`${SIDECAR_PACKAGE_NAME}/package.json`);
  } catch {
    fail("TokenMonster could not resolve its exact sidecar package");
  }
  const sidecarRoot = await requireResolvedPhysicalPackageRoot(
    resolvedSidecarManifest,
    allowedSidecarRoots,
    "sidecar package",
  );
  if (!samePlatformPath(resolvedSidecarManifest, join(sidecarRoot, "package.json"))) {
    fail("sidecar package manifest resolved outside the fixed npm layout");
  }
  const sidecarDirectory = await requireSidecarPackage(
    sidecarRoot,
    "sidecar package",
  );

  const sidecarNestedZstdRoot = join(
    sidecarRoot,
    "node_modules",
    "@mongodb-js",
    "zstd",
  );
  const parentZstdRoot = join(parentNodeModules, "@mongodb-js", "zstd");
  const allowedZstdRoots = samePlatformPath(
    sidecarRoot,
    allowedSidecarRoots[0],
  )
    ? [sidecarNestedZstdRoot, sourceRoot, parentZstdRoot]
    : [sidecarNestedZstdRoot, parentZstdRoot];
  let resolvedZstdManifest;
  try {
    resolvedZstdManifest = createRequire(resolvedSidecarManifest).resolve(
      `${ZSTD_PACKAGE_NAME}/package.json`,
    );
  } catch {
    fail("sidecar package could not resolve its exact zstd dependency");
  }
  const destinationRoot = await requireResolvedPhysicalPackageRoot(
    resolvedZstdManifest,
    allowedZstdRoots,
    "sidecar zstd package",
  );
  if (!samePlatformPath(resolvedZstdManifest, join(destinationRoot, "package.json"))) {
    fail("sidecar zstd manifest resolved outside the fixed npm layout");
  }
  return Object.freeze({
    releaseRoot,
    releaseDirectory,
    parentDirectory,
    sourceRoot,
    sidecarRoot,
    sidecarDirectory,
    destinationRoot,
  });
}

async function requireExistingPrebuilds(
  destinationRoot,
  policy,
  sourceArchives,
  { complete = false } = {},
) {
  const destination = await requireZstdPackage(
    destinationRoot,
    policy,
    complete ? "all" : "subset",
    "sidecar zstd package",
  );
  for (const [archiveName, destinationBytes] of destination.archives) {
    const sourceBytes = sourceArchives.get(archiveName);
    if (
      sourceBytes === undefined ||
      !destinationBytes.equals(sourceBytes)
    ) {
      fail("sidecar zstd prebuild inventory must match bundled authority");
    }
  }
  return destination;
}

async function lstatOrNull(path, label) {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    fail(`${label} could not be inspected`);
  }
}

async function removeKnownStage(
  stageDirectory,
  archiveNames,
  sourceArchives,
) {
  const stageRoot = stageDirectory.path;
  for (const archiveName of archiveNames) {
    await revalidatePhysicalDirectory(
      stageDirectory,
      "zstd preinstall staging directory",
    );
    const path = join(stageRoot, archiveName);
    const metadata = await lstatOrNull(path, "zstd preinstall staging file");
    if (metadata === null) continue;
    const sourceBytes = sourceArchives.get(archiveName);
    if (sourceBytes === undefined) {
      fail("zstd preinstall staging cleanup was not safe");
    }
    const bytes = await readExactPhysicalFile(
      path,
      { bytes: sourceBytes.length, sha256: sha256(sourceBytes) },
      "zstd preinstall staging file",
      { allowHardlinks: true },
    );
    if (!bytes.equals(sourceBytes)) {
      fail("zstd preinstall staging cleanup was not safe");
    }
    await revalidatePhysicalDirectory(
      stageDirectory,
      "zstd preinstall staging directory",
    );
    try {
      await unlink(path);
    } catch {
      fail("zstd preinstall staging cleanup failed");
    }
    await revalidatePhysicalDirectory(
      stageDirectory,
      "zstd preinstall staging directory",
    );
  }
  await revalidatePhysicalDirectory(
    stageDirectory,
    "zstd preinstall staging directory",
  );
  try {
    await rmdir(stageRoot);
  } catch {
    fail("zstd preinstall staging cleanup failed");
  }
}

async function seedDestinationPrebuilds(destinationRoot, policy, sourceArchives) {
  let destination = await requireExistingPrebuilds(
    destinationRoot,
    policy,
    sourceArchives,
  );
  if (destination.archives.size === EXPECTED_PLATFORM_KEYS.length) {
    return destination;
  }

  const destinationPrebuilds = join(destinationRoot, PREBUILD_DIRECTORY_NAME);
  const existing = await lstatOrNull(
    destinationPrebuilds,
    "sidecar zstd prebuild directory",
  );
  if (existing === null) {
    try {
      await mkdir(destinationPrebuilds, { mode: 0o700 });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        fail("sidecar zstd prebuild directory could not be created");
      }
    }
  }
  destination = await requireExistingPrebuilds(
    destinationRoot,
    policy,
    sourceArchives,
  );
  if (destination.prebuildDirectory === null) {
    fail("sidecar zstd prebuild directory must be physical");
  }
  const destinationDirectory = destination.rootDirectory;
  const prebuildDirectory = destination.prebuildDirectory;
  if (destination.archives.size === EXPECTED_PLATFORM_KEYS.length) {
    return destination;
  }

  const archiveNames = EXPECTED_PLATFORM_KEYS.map(
    (key) => policy[key].archiveName,
  )
    .filter((name) => !destination.archives.has(name))
    .sort();
  const stageRoot = join(
    destinationRoot,
    `.tokenmonster-zstd-prebuilds-${randomBytes(16).toString("hex")}`,
  );
  try {
    await mkdir(stageRoot, { mode: 0o700 });
  } catch {
    fail("zstd preinstall staging directory could not be created");
  }
  const stageDirectory = await snapshotPhysicalDirectory(
    stageRoot,
    "zstd preinstall staging directory",
  );

  try {
    for (const archiveName of archiveNames) {
      await revalidatePhysicalDirectory(
        destinationDirectory,
        "sidecar zstd package",
      );
      await revalidatePhysicalDirectory(
        prebuildDirectory,
        "sidecar zstd prebuild directory",
      );
      await revalidatePhysicalDirectory(
        stageDirectory,
        "zstd preinstall staging directory",
      );
      const sourceBytes = sourceArchives.get(archiveName);
      if (sourceBytes === undefined) {
        fail("bundled zstd archive inventory is incomplete");
      }
      const stagePath = join(stageRoot, archiveName);
      let handle;
      try {
        handle = await open(stagePath, "wx", 0o600);
        await handle.writeFile(sourceBytes);
        await handle.sync();
      } catch {
        fail("zstd preinstall staging file could not be written");
      } finally {
        if (handle !== undefined) {
          await handle.close().catch(() => undefined);
        }
      }
      await revalidatePhysicalDirectory(
        stageDirectory,
        "zstd preinstall staging directory",
      );
      const stagedBytes = await readExactPhysicalFile(
        stagePath,
        { bytes: sourceBytes.length, sha256: sha256(sourceBytes) },
        "zstd preinstall staging file",
      );
      if (!stagedBytes.equals(sourceBytes)) {
        fail("zstd preinstall staging file differs from bundled authority");
      }
      await revalidatePhysicalDirectory(
        stageDirectory,
        "zstd preinstall staging directory",
      );
    }

    for (const archiveName of archiveNames) {
      await revalidatePhysicalDirectory(
        destinationDirectory,
        "sidecar zstd package",
      );
      await revalidatePhysicalDirectory(
        prebuildDirectory,
        "sidecar zstd prebuild directory",
      );
      await revalidatePhysicalDirectory(
        stageDirectory,
        "zstd preinstall staging directory",
      );
      const sourceBytes = sourceArchives.get(archiveName);
      if (sourceBytes === undefined) {
        fail("bundled zstd archive inventory is incomplete");
      }
      const stagePath = join(stageRoot, archiveName);
      const destinationPath = join(destinationPrebuilds, archiveName);
      try {
        await link(stagePath, destinationPath);
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) {
          fail("zstd preinstall could not commit native archive");
        }
        const racedBytes = await readExactPhysicalFile(
          destinationPath,
          { bytes: sourceBytes.length, sha256: sha256(sourceBytes) },
          "sidecar zstd native archive",
        );
        if (!racedBytes.equals(sourceBytes)) {
          fail("sidecar zstd native archive differs from bundled authority");
        }
      }
      await revalidatePhysicalDirectory(
        destinationDirectory,
        "sidecar zstd package",
      );
      await revalidatePhysicalDirectory(
        prebuildDirectory,
        "sidecar zstd prebuild directory",
      );
      await revalidatePhysicalDirectory(
        stageDirectory,
        "zstd preinstall staging directory",
      );
      try {
        await unlink(stagePath);
      } catch {
        fail("zstd preinstall staging file could not be removed");
      }
      const committedBytes = await readExactPhysicalFile(
        destinationPath,
        { bytes: sourceBytes.length, sha256: sha256(sourceBytes) },
        "sidecar zstd native archive",
      );
      if (!committedBytes.equals(sourceBytes)) {
        fail("sidecar zstd native archive differs from bundled authority");
      }
      await revalidatePhysicalDirectory(
        destinationDirectory,
        "sidecar zstd package",
      );
      await revalidatePhysicalDirectory(
        prebuildDirectory,
        "sidecar zstd prebuild directory",
      );
      await revalidatePhysicalDirectory(
        stageDirectory,
        "zstd preinstall staging directory",
      );
    }
    await removeKnownStage(stageDirectory, archiveNames, sourceArchives);
    const completed = await requireExistingPrebuilds(
      destinationRoot,
      policy,
      sourceArchives,
      { complete: true },
    );
    await revalidatePhysicalDirectory(
      destinationDirectory,
      "sidecar zstd package",
    );
    await revalidatePhysicalDirectory(
      prebuildDirectory,
      "sidecar zstd prebuild directory",
    );
    return completed;
  } catch (error) {
    const stageMetadata = await lstatOrNull(
      stageRoot,
      "zstd preinstall staging directory",
    );
    if (stageMetadata !== null) {
      await removeKnownStage(stageDirectory, archiveNames, sourceArchives);
    }
    throw error;
  }
}

async function installBundledZstdPrebuilds(options = {}) {
  const releasePackageRoot = options.releasePackageRoot ?? __dirname;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const policy = requirePrebuildPolicy(
    options.prebuildPolicy ?? ZSTD_PREBUILD_POLICY,
  );
  const { platformKey } = platformEntry(policy, platform, arch);
  const packages = await resolveInstalledPackages(releasePackageRoot);
  const source = await requireZstdPackage(
    packages.sourceRoot,
    policy,
    "all",
    "bundled zstd package",
  );
  const destination = samePlatformPath(
    packages.sourceRoot,
    packages.destinationRoot,
  )
    ? source
    : await seedDestinationPrebuilds(
      packages.destinationRoot,
      policy,
      source.archives,
    );
  if (
    source.prebuildDirectory === null ||
    destination.prebuildDirectory === null
  ) {
    fail("sidecar zstd prebuild directory must be physical");
  }
  await revalidatePhysicalDirectory(
    packages.releaseDirectory,
    "TokenMonster release package",
  );
  await revalidatePhysicalDirectory(
    packages.parentDirectory,
    "npm package root",
  );
  await revalidatePhysicalDirectory(
    packages.sidecarDirectory,
    "sidecar package",
  );
  await revalidatePhysicalDirectory(
    source.rootDirectory,
    "bundled zstd package",
  );
  await revalidatePhysicalDirectory(
    source.prebuildDirectory,
    "bundled zstd prebuild directory",
  );
  await revalidatePhysicalDirectory(
    destination.rootDirectory,
    "sidecar zstd package",
  );
  await revalidatePhysicalDirectory(
    destination.prebuildDirectory,
    "sidecar zstd prebuild directory",
  );
  await requireReleasePackage(packages.releaseRoot);
  const finalSidecarDirectory = await requireSidecarPackage(
    packages.sidecarRoot,
    "sidecar package",
  );
  await revalidatePhysicalDirectory(
    packages.sidecarDirectory,
    "sidecar package",
  );
  await revalidatePhysicalDirectory(finalSidecarDirectory, "sidecar package");
  const finalSource = await requireZstdPackage(
    packages.sourceRoot,
    policy,
    "all",
    "bundled zstd package",
  );
  const finalDestination = samePlatformPath(
    packages.sourceRoot,
    packages.destinationRoot,
  )
    ? finalSource
    : await requireZstdPackage(
        packages.destinationRoot,
        policy,
        "all",
        "sidecar zstd package",
      );
  if (
    finalSource.prebuildDirectory === null ||
    finalDestination.prebuildDirectory === null
  ) {
    fail("sidecar zstd prebuild directory must be physical");
  }
  await revalidatePhysicalDirectory(
    source.rootDirectory,
    "bundled zstd package",
  );
  await revalidatePhysicalDirectory(
    source.prebuildDirectory,
    "bundled zstd prebuild directory",
  );
  await revalidatePhysicalDirectory(
    destination.rootDirectory,
    "sidecar zstd package",
  );
  await revalidatePhysicalDirectory(
    destination.prebuildDirectory,
    "sidecar zstd prebuild directory",
  );
  return Object.freeze({ platformKey });
}

module.exports = Object.freeze({
  installBundledZstdPrebuilds,
  UPSTREAM_ZSTD_FILE_PATHS,
  UPSTREAM_ZSTD_FILE_POLICY,
  ZSTD_PREBUILD_POLICY,
});

if (require.main === module) {
  installBundledZstdPrebuilds()
    .then(({ platformKey }) => {
      process.stdout.write(
        `TOKENMONSTER ZSTD PREINSTALL: PASS (${platformKey})\n`,
      );
    })
    .catch(() => {
      process.stderr.write("TOKENMONSTER ZSTD PREINSTALL: FAIL\n");
      process.exitCode = 1;
    });
}
