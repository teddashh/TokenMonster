#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { requireWindowsReleaseVersion } from "./release-version-contract.mjs";
import {
  createWindowsSquirrelCandidate,
  fullSquirrelPackageNameForVersion,
  requireSquirrelReleasesFile,
  sha1File,
  sha256File,
  verifyPreparedWindowsSquirrelCandidate,
  WINDOWS_SQUIRREL_FULL_PACKAGE_MAX_BYTES,
  WINDOWS_SQUIRREL_RELEASES_MAX_BYTES,
} from "./windows-squirrel-promotion-policy.mjs";

const MIN_INSTALLER_BYTES = 1 * 1_024 * 1_024;
const MAX_INSTALLER_BYTES = 512 * 1_024 * 1_024;
const PUBLIC_RELEASE_BINDING = "TOKENMONSTER_PUBLIC_RELEASE_JSON";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !["--artifact-dir", "--output-dir", "--version"].includes(name) ||
      value === undefined ||
      value.startsWith("--") ||
      values.has(name)
    ) {
      throw new Error(
        "Usage: prepare-windows-promotion.mjs --artifact-dir <dir> --output-dir <dir> --version <version>",
      );
    }
    values.set(name, value);
  }
  if (values.size !== 3) {
    throw new Error(
      "Usage: prepare-windows-promotion.mjs --artifact-dir <dir> --output-dir <dir> --version <version>",
    );
  }
  return {
    artifactDirectory: resolve(values.get("--artifact-dir")),
    outputDirectory: resolve(values.get("--output-dir")),
    version: requireWindowsReleaseVersion(
      values.get("--version"),
      "Windows promotion version",
    ),
  };
}

async function requireExactArtifactInventory(directory, version) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Windows artifact root must be a physical directory");
  }
  const fullPackageFileName = fullSquirrelPackageNameForVersion(version);
  const expectedNames = [
    "RELEASES",
    "TokenMonsterSetup.exe",
    fullPackageFileName,
  ].sort();
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    JSON.stringify(entries.map((entry) => entry.name).sort()) !==
    JSON.stringify(expectedNames)
  ) {
    throw new Error(
      "Windows artifact inventory must contain exactly RELEASES, TokenMonsterSetup.exe, and one version-bound full .nupkg",
    );
  }
  const paths = new Map();
  for (const name of expectedNames) {
    const path = join(directory, name);
    const entryMetadata = await lstat(path);
    if (!entryMetadata.isFile() || entryMetadata.isSymbolicLink()) {
      throw new Error(
        "Windows artifact inventory entries must be physical regular files",
      );
    }
    paths.set(name, path);
  }
  return Object.freeze({
    releases: paths.get("RELEASES"),
    installer: paths.get("TokenMonsterSetup.exe"),
    fullPackage: paths.get(fullPackageFileName),
    fullPackageFileName,
  });
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

const { artifactDirectory, outputDirectory, version } = parseArguments(
  process.argv.slice(2),
);
const inventory = await requireExactArtifactInventory(
  artifactDirectory,
  version,
);
const installer = inventory.installer;
const installerMetadata = await lstat(installer);
if (
  !installerMetadata.isFile() ||
  installerMetadata.isSymbolicLink() ||
  !Number.isSafeInteger(installerMetadata.size) ||
  installerMetadata.size < MIN_INSTALLER_BYTES ||
  installerMetadata.size > MAX_INSTALLER_BYTES
) {
  throw new Error("Verified TokenMonsterSetup.exe has an invalid byte size");
}
const [releasesMetadata, fullPackageMetadata] = await Promise.all([
  lstat(inventory.releases),
  lstat(inventory.fullPackage),
]);
if (
  !Number.isSafeInteger(releasesMetadata.size) ||
  releasesMetadata.size < 1 ||
  releasesMetadata.size > WINDOWS_SQUIRREL_RELEASES_MAX_BYTES
) {
  throw new Error("Squirrel RELEASES has an invalid byte size");
}
if (
  !Number.isSafeInteger(fullPackageMetadata.size) ||
  fullPackageMetadata.size < 1 ||
  fullPackageMetadata.size > WINDOWS_SQUIRREL_FULL_PACKAGE_MAX_BYTES
) {
  throw new Error("Full Squirrel package has an invalid byte size");
}
const releasesContents = await readFile(inventory.releases);
const [
  sourceInstallerSha256,
  fullPackageSha1,
  fullPackageSha256,
  releasesSha256,
] = await Promise.all([
  sha256File(installer),
  sha1File(inventory.fullPackage),
  sha256File(inventory.fullPackage),
  sha256File(inventory.releases),
]);
requireSquirrelReleasesFile(releasesContents, {
  version,
  fullPackageBytes: fullPackageMetadata.size,
  fullPackageSha1,
});
const squirrelCandidate = createWindowsSquirrelCandidate({
  version,
  releasesSha256,
  releasesBytes: releasesMetadata.size,
  fullPackageSha1,
  fullPackageSha256,
  fullPackageBytes: fullPackageMetadata.size,
});
await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
const preparedInstaller = join(outputDirectory, "TokenMonsterSetup.exe");
const preparedReleases = join(outputDirectory, "RELEASES");
const preparedFullPackage = join(
  outputDirectory,
  inventory.fullPackageFileName,
);
await Promise.all([
  copyFile(installer, preparedInstaller),
  copyFile(inventory.releases, preparedReleases),
  copyFile(inventory.fullPackage, preparedFullPackage),
]);
const preparedMetadata = await lstat(preparedInstaller);
if (
  !preparedMetadata.isFile() ||
  preparedMetadata.isSymbolicLink() ||
  preparedMetadata.size !== installerMetadata.size
) {
  throw new Error("Prepared Setup bytes differ from the signed artifact");
}
const installerSha256 = await sha256File(preparedInstaller);
if (installerSha256 !== sourceInstallerSha256) {
  throw new Error("Prepared Setup bytes differ from the verified artifact");
}
const objectKey =
  `tokenmonster/releases/windows/v${version}/TokenMonsterSetup.exe`;
const downloadUrl = `https://cdn.ted-h.com/${objectKey}`;
const snapshot = Object.freeze({
  contractVersion: 1,
  platform: "windows-x64",
  version,
  downloadUrl,
  sha256: installerSha256,
  bytes: preparedMetadata.size,
});
const canonicalPublicReleaseJson = JSON.stringify(snapshot);
const manifest = Object.freeze({
  promotionContractVersion: 1,
  release: snapshot,
  sourceArtifact: Object.freeze({
    fileName: "TokenMonsterSetup.exe",
    sha256: installerSha256,
    bytes: preparedMetadata.size,
  }),
  cdnObject: Object.freeze({
    key: objectKey,
    downloadUrl,
  }),
  workerBinding: Object.freeze({
    name: PUBLIC_RELEASE_BINDING,
    canonicalJsonSha256: sha256Text(canonicalPublicReleaseJson),
  }),
});

await verifyPreparedWindowsSquirrelCandidate(
  outputDirectory,
  squirrelCandidate,
);

await writeFile(
  join(outputDirectory, "public-release-v1.json"),
  `${canonicalPublicReleaseJson}\n`,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);
await writeFile(
  join(outputDirectory, "promotion-manifest-v1.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);
await writeFile(
  join(outputDirectory, "windows-squirrel-candidate-v1.json"),
  `${JSON.stringify(squirrelCandidate, null, 2)}\n`,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);

process.stdout.write(
  `${JSON.stringify({ objectKey, downloadUrl, sha256: installerSha256, bytes: preparedMetadata.size, squirrelChannel: squirrelCandidate.channel, squirrelFeedUrl: squirrelCandidate.feedUrl })}\n`,
);
