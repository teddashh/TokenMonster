import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  decideMonotonicReleaseTransition,
  npmDistTagForReleaseVersion,
  requireWindowsReleaseVersion,
} from "./release-version-contract.mjs";

const CDN_ORIGIN = "https://cdn.ted-h.com";
const SQUIRREL_OBJECT_PREFIX =
  "tokenmonster/releases/windows/squirrel";
export const WINDOWS_SQUIRREL_RELEASES_MAX_BYTES = 64 * 1_024;
export const WINDOWS_SQUIRREL_FULL_PACKAGE_MAX_BYTES =
  2 * 1_024 * 1_024 * 1_024;
const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return (
    isRecord(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(keys)
  );
}

function requireHash(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${label} is malformed`);
  }
  return value;
}

function requireByteSize(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} has an invalid byte size`);
  }
  return value;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function sha1File(path) {
  const hash = createHash("sha1");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function squirrelVersionForWindowsRelease(value) {
  const version = requireWindowsReleaseVersion(
    value,
    "Windows Squirrel release version",
  );
  const [core, prerelease] = version.split("-");
  return prerelease === undefined
    ? core
    : `${core}-${prerelease.replaceAll(".", "")}`;
}

export function fullSquirrelPackageNameForVersion(value) {
  return `TokenMonster-${squirrelVersionForWindowsRelease(value)}-full.nupkg`;
}

export function windowsReleaseVersionFromFullSquirrelPackageName(value) {
  const match =
    typeof value === "string"
      ? /^TokenMonster-((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(?:-([A-Za-z][0-9A-Za-z-]*))?-full\.nupkg$/u.exec(
          value,
        )
      : null;
  if (match === null) {
    throw new TypeError("full Squirrel package name is malformed");
  }
  const projectedPrerelease = match[2];
  let version = match[1];
  if (projectedPrerelease !== undefined) {
    const numbered = /^([A-Za-z][0-9A-Za-z-]*?[^0-9])([0-9]+)$/u.exec(
      projectedPrerelease,
    );
    version +=
      numbered === null
        ? `-${projectedPrerelease}`
        : `-${numbered[1]}.${numbered[2]}`;
  }
  const exact = requireWindowsReleaseVersion(
    version,
    "full Squirrel package release version",
  );
  if (fullSquirrelPackageNameForVersion(exact) !== value) {
    throw new TypeError("full Squirrel package name is not canonical");
  }
  return exact;
}

export function windowsSquirrelChannelForVersion(value) {
  return npmDistTagForReleaseVersion(
    requireWindowsReleaseVersion(value, "Windows Squirrel release version"),
  );
}

export function parseSquirrelReleasesFile(contents) {
  if (!(contents instanceof Uint8Array)) {
    throw new TypeError("Squirrel RELEASES must be bytes");
  }
  requireByteSize(
    contents.byteLength,
    WINDOWS_SQUIRREL_RELEASES_MAX_BYTES,
    "Squirrel RELEASES",
  );
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error("Squirrel RELEASES must be valid UTF-8");
  }
  const match =
    /^([A-Fa-f0-9]{40}) ([A-Za-z0-9][A-Za-z0-9.-]*\.nupkg) ([1-9][0-9]*)(?:\r?\n)?$/u.exec(
      text,
    );
  if (match === null) {
    throw new Error(
      "Squirrel RELEASES must contain exactly one full package entry",
    );
  }
  return Object.freeze({
    sha1: match[1].toLowerCase(),
    fileName: match[2],
    bytes: requireByteSize(
      Number(match[3]),
      WINDOWS_SQUIRREL_FULL_PACKAGE_MAX_BYTES,
      "full Squirrel package",
    ),
  });
}

export function requireSquirrelReleasesFile(
  contents,
  { version, fullPackageBytes, fullPackageSha1 },
) {
  const parsed = parseSquirrelReleasesFile(contents);
  const fileName = fullSquirrelPackageNameForVersion(version);
  const expectedSha1 = requireHash(
    fullPackageSha1,
    SHA1_PATTERN,
    "full Squirrel package SHA-1",
  );
  const expectedBytes = requireByteSize(
    fullPackageBytes,
    WINDOWS_SQUIRREL_FULL_PACKAGE_MAX_BYTES,
    "full Squirrel package",
  );
  if (
    parsed.sha1 !== expectedSha1 ||
    parsed.fileName !== fileName ||
    parsed.bytes !== expectedBytes
  ) {
    throw new Error(
      "Squirrel RELEASES must contain exactly one version-bound full package entry with matching SHA-1 and bytes",
    );
  }
  return parsed;
}

export function createWindowsSquirrelCandidate({
  version: untrustedVersion,
  releasesSha256,
  releasesBytes,
  fullPackageSha1,
  fullPackageSha256,
  fullPackageBytes,
}) {
  const version = requireWindowsReleaseVersion(
    untrustedVersion,
    "Windows Squirrel candidate version",
  );
  const channel = windowsSquirrelChannelForVersion(version);
  const fullPackageFileName = fullSquirrelPackageNameForVersion(version);
  const releaseEntry = Object.freeze({
    sha1: requireHash(
      fullPackageSha1,
      SHA1_PATTERN,
      "full Squirrel package SHA-1",
    ),
    fileName: fullPackageFileName,
    bytes: requireByteSize(
      fullPackageBytes,
      WINDOWS_SQUIRREL_FULL_PACKAGE_MAX_BYTES,
      "full Squirrel package",
    ),
  });
  const versionedPrefix = `${SQUIRREL_OBJECT_PREFIX}/v${version}`;
  const channelPrefix = `${SQUIRREL_OBJECT_PREFIX}/${channel}`;
  const objects = Object.freeze([
    Object.freeze({
      role: "releases",
      sourceFileName: "RELEASES",
      sha256: requireHash(
        releasesSha256,
        SHA256_PATTERN,
        "Squirrel RELEASES SHA-256",
      ),
      bytes: requireByteSize(
        releasesBytes,
        WINDOWS_SQUIRREL_RELEASES_MAX_BYTES,
        "Squirrel RELEASES",
      ),
      contentType: "text/plain; charset=utf-8",
      immutableCacheControl: "public, max-age=31536000, immutable",
      channelCacheControl: "no-store, no-cache, must-revalidate",
      immutableKey: `${versionedPrefix}/RELEASES`,
      channelKey: `${channelPrefix}/RELEASES`,
    }),
    Object.freeze({
      role: "full-package",
      sourceFileName: fullPackageFileName,
      sha256: requireHash(
        fullPackageSha256,
        SHA256_PATTERN,
        "full Squirrel package SHA-256",
      ),
      bytes: releaseEntry.bytes,
      contentType: "application/octet-stream",
      immutableCacheControl: "public, max-age=31536000, immutable",
      channelCacheControl: "public, max-age=31536000, immutable",
      immutableKey: `${versionedPrefix}/${fullPackageFileName}`,
      channelKey: `${channelPrefix}/${fullPackageFileName}`,
    }),
  ]);
  return Object.freeze({
    squirrelCandidateContractVersion: 1,
    version,
    channel,
    feedUrl: `${CDN_ORIGIN}/${channelPrefix}/`,
    releaseEntry,
    objects,
  });
}

export function requireWindowsSquirrelCandidate(value, label = "candidate") {
  const objectKeys = [
    "role",
    "sourceFileName",
    "sha256",
    "bytes",
    "contentType",
    "immutableCacheControl",
    "channelCacheControl",
    "immutableKey",
    "channelKey",
  ];
  if (
    !hasExactKeys(value, [
      "squirrelCandidateContractVersion",
      "version",
      "channel",
      "feedUrl",
      "releaseEntry",
      "objects",
    ]) ||
    value.squirrelCandidateContractVersion !== 1 ||
    !hasExactKeys(value.releaseEntry, ["sha1", "fileName", "bytes"]) ||
    !Array.isArray(value.objects) ||
    value.objects.length !== 2 ||
    value.objects.some((object) => !hasExactKeys(object, objectKeys))
  ) {
    throw new TypeError(`Windows Squirrel ${label} is malformed`);
  }
  const releasesObject = value.objects.find(
    (object) => object.role === "releases",
  );
  const fullPackageObject = value.objects.find(
    (object) => object.role === "full-package",
  );
  if (releasesObject === undefined || fullPackageObject === undefined) {
    throw new TypeError(`Windows Squirrel ${label} is malformed`);
  }
  let expected;
  try {
    expected = createWindowsSquirrelCandidate({
      version: value.version,
      releasesSha256: releasesObject.sha256,
      releasesBytes: releasesObject.bytes,
      fullPackageSha1: value.releaseEntry.sha1,
      fullPackageSha256: fullPackageObject.sha256,
      fullPackageBytes: value.releaseEntry.bytes,
    });
  } catch {
    throw new TypeError(`Windows Squirrel ${label} is malformed`);
  }
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new TypeError(
      `Windows Squirrel ${label} has version, channel, key, or byte drift`,
    );
  }
  return expected;
}

export function windowsSquirrelCandidateIdentity(value) {
  const candidate = requireWindowsSquirrelCandidate(value);
  return sha256Text(JSON.stringify(candidate));
}

function candidateObjectByRole(candidate, role) {
  const object = candidate.objects.find((entry) => entry.role === role);
  if (object === undefined) {
    throw new TypeError(`Windows Squirrel candidate is missing ${role}`);
  }
  return object;
}

function promotionObject(object, sequence) {
  return Object.freeze({
    sequence,
    role: object.role,
    sourceFileName: object.sourceFileName,
    sourceSha256: object.sha256,
    bytes: object.bytes,
    destinationKey: object.immutableKey,
    contentType: object.contentType,
    cacheControl: object.immutableCacheControl,
    operation: "create-or-verify-exact",
  });
}

function channelWrite(object, sequence) {
  return Object.freeze({
    sequence,
    role: object.role,
    sourceImmutableKey: object.immutableKey,
    destinationKey: object.channelKey,
    expectedSha256: object.sha256,
    bytes: object.bytes,
    contentType: object.contentType,
    cacheControl: object.channelCacheControl,
  });
}

export function planWindowsSquirrelPromotion(currentValue, candidateValue) {
  const candidate = requireWindowsSquirrelCandidate(
    candidateValue,
    "candidate",
  );
  const current =
    currentValue === null
      ? null
      : requireWindowsSquirrelCandidate(currentValue, "current channel");
  if (current !== null && current.channel !== candidate.channel) {
    throw new Error(
      `Windows Squirrel channel drift: ${candidate.channel} candidate cannot replace ${current.channel}`,
    );
  }
  const candidateIdentity = windowsSquirrelCandidateIdentity(candidate);
  const currentIdentity =
    current === null ? null : windowsSquirrelCandidateIdentity(current);
  const decision = decideMonotonicReleaseTransition({
    currentVersion: current?.version ?? null,
    candidateVersion: candidate.version,
    currentIdentity,
    candidateIdentity,
  });
  const fullPackage = candidateObjectByRole(candidate, "full-package");
  const releases = candidateObjectByRole(candidate, "releases");
  const writesInOrder =
    decision === "advance"
      ? Object.freeze([
          channelWrite(fullPackage, 1),
          channelWrite(releases, 2),
        ])
      : Object.freeze([]);
  const priorFullPackage =
    current === null
      ? null
      : candidateObjectByRole(current, "full-package");
  const retainedForClientOverlap =
    decision === "advance" &&
    priorFullPackage !== null &&
    priorFullPackage.channelKey !== fullPackage.channelKey
      ? Object.freeze([
          Object.freeze({
            destinationKey: priorFullPackage.channelKey,
            expectedSha256: priorFullPackage.sha256,
            bytes: priorFullPackage.bytes,
            operation: "retain-until-separate-retention-aware-gc",
          }),
        ])
      : Object.freeze([]);
  return Object.freeze({
    squirrelPromotionPlanContractVersion: 1,
    decision,
    channel: candidate.channel,
    currentVersion: current?.version ?? null,
    candidateVersion: candidate.version,
    candidateIdentitySha256: candidateIdentity,
    immutableObjects: Object.freeze([
      promotionObject(fullPackage, 1),
      promotionObject(releases, 2),
    ]),
    channelTransition: Object.freeze({
      writesInOrder,
      retainedForClientOverlap,
    }),
  });
}

async function requirePhysicalFile(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a physical regular file`);
  }
  return metadata;
}

export async function verifyPreparedWindowsSquirrelCandidate(
  directory,
  untrustedCandidate,
) {
  const preparedDirectory = resolve(directory);
  const directoryMetadata = await lstat(preparedDirectory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error("Prepared Windows promotion root must be a physical directory");
  }
  const candidate = requireWindowsSquirrelCandidate(untrustedCandidate);
  const releasesObject = candidateObjectByRole(candidate, "releases");
  const fullPackageObject = candidateObjectByRole(candidate, "full-package");
  const releasesPath = join(preparedDirectory, releasesObject.sourceFileName);
  const fullPackagePath = join(
    preparedDirectory,
    fullPackageObject.sourceFileName,
  );
  const [releasesMetadata, fullPackageMetadata] = await Promise.all([
    requirePhysicalFile(releasesPath, "Prepared Squirrel RELEASES"),
    requirePhysicalFile(fullPackagePath, "Prepared full Squirrel package"),
  ]);
  if (
    releasesMetadata.size !== releasesObject.bytes ||
    fullPackageMetadata.size !== fullPackageObject.bytes
  ) {
    throw new Error("Prepared Squirrel promotion byte size differs from its candidate");
  }
  const [releasesContents, releasesSha256, fullPackageSha1, fullPackageSha256] =
    await Promise.all([
      readFile(releasesPath),
      sha256File(releasesPath),
      sha1File(fullPackagePath),
      sha256File(fullPackagePath),
    ]);
  requireSquirrelReleasesFile(releasesContents, {
    version: candidate.version,
    fullPackageBytes: fullPackageMetadata.size,
    fullPackageSha1,
  });
  if (
    releasesSha256 !== releasesObject.sha256 ||
    fullPackageSha256 !== fullPackageObject.sha256 ||
    fullPackageSha1 !== candidate.releaseEntry.sha1
  ) {
    throw new Error("Prepared Squirrel promotion hash differs from its candidate");
  }
  return Object.freeze({
    squirrelCandidateVerificationContractVersion: 1,
    verification: "local-files-and-releases-entry-match",
    candidateIdentitySha256: windowsSquirrelCandidateIdentity(candidate),
    version: candidate.version,
    channel: candidate.channel,
    feedUrl: candidate.feedUrl,
    objects: candidate.objects,
  });
}

export async function verifyCurrentWindowsSquirrelChannel(
  directory,
  untrustedCandidate,
) {
  const currentDirectory = resolve(directory);
  const candidate = requireWindowsSquirrelCandidate(
    untrustedCandidate,
    "current channel",
  );
  const metadata = await lstat(currentDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Current Windows Squirrel channel must be a physical directory");
  }
  const expectedNames = [
    "RELEASES",
    candidate.releaseEntry.fileName,
  ].sort();
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  if (
    JSON.stringify(entries.map((entry) => entry.name).sort()) !==
    JSON.stringify(expectedNames)
  ) {
    throw new Error(
      "Current Windows Squirrel channel must contain exactly RELEASES and its referenced full package",
    );
  }
  return verifyPreparedWindowsSquirrelCandidate(currentDirectory, candidate);
}
