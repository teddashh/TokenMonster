#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { requireWindowsReleaseVersion } from "./release-version-contract.mjs";
import {
  requireWindowsSquirrelCandidate,
  verifyPreparedWindowsSquirrelCandidate,
} from "./windows-squirrel-promotion-policy.mjs";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !["--prepared-dir", "--recalled-file", "--version"].includes(name) ||
      value === undefined ||
      value.startsWith("--") ||
      values.has(name)
    ) {
      throw new Error(
        "Usage: verify-windows-promotion.mjs --prepared-dir <dir> --recalled-file <file> --version <version>",
      );
    }
    values.set(name, value);
  }
  if (values.size !== 3) {
    throw new Error(
      "Usage: verify-windows-promotion.mjs --prepared-dir <dir> --recalled-file <file> --version <version>",
    );
  }
  return {
    preparedDirectory: resolve(values.get("--prepared-dir")),
    recalledFile: resolve(values.get("--recalled-file")),
    version: requireWindowsReleaseVersion(
      values.get("--version"),
      "Windows promotion version",
    ),
  };
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function requireRegularFile(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a physical regular file`);
  }
  return metadata;
}

const { preparedDirectory, recalledFile, version } = parseArguments(
  process.argv.slice(2),
);
const sourceFile = join(preparedDirectory, "TokenMonsterSetup.exe");
const publicReleaseFile = join(preparedDirectory, "public-release-v1.json");
const squirrelCandidateFile = join(
  preparedDirectory,
  "windows-squirrel-candidate-v1.json",
);
await requireRegularFile(sourceFile, "Prepared installer");
await requireRegularFile(recalledFile, "Recalled installer");
await requireRegularFile(publicReleaseFile, "Public release binding");
await requireRegularFile(squirrelCandidateFile, "Windows Squirrel candidate");
const [
  sourceMetadata,
  recalledMetadata,
  sourceSha256,
  recalledSha256,
  publicReleaseText,
  squirrelCandidateText,
] = await Promise.all([
  lstat(sourceFile),
  lstat(recalledFile),
  sha256File(sourceFile),
  sha256File(recalledFile),
  readFile(publicReleaseFile, "utf8"),
  readFile(squirrelCandidateFile, "utf8"),
]);
if (!publicReleaseText.endsWith("\n") || publicReleaseText.endsWith("\n\n")) {
  throw new Error("Public release binding file must have one final newline");
}
const canonicalPublicReleaseJson = publicReleaseText.slice(0, -1);
const release = JSON.parse(canonicalPublicReleaseJson);
if (
  release === null ||
  typeof release !== "object" ||
  Array.isArray(release) ||
  JSON.stringify(release) !== canonicalPublicReleaseJson ||
  JSON.stringify(Object.keys(release)) !==
    JSON.stringify([
      "contractVersion",
      "platform",
      "version",
      "downloadUrl",
      "sha256",
      "bytes",
    ]) ||
  release.contractVersion !== 1 ||
  release.platform !== "windows-x64" ||
  release.version !== version ||
  release.downloadUrl !==
    `https://cdn.ted-h.com/tokenmonster/releases/windows/v${version}/TokenMonsterSetup.exe`
) {
  throw new Error("Prepared public release binding is not canonical");
}
if (
  release.sha256 !== sourceSha256 ||
  release.bytes !== sourceMetadata.size ||
  recalledSha256 !== sourceSha256 ||
  recalledMetadata.size !== sourceMetadata.size
) {
  throw new Error("Full CDN GET does not match the signed source installer");
}
let squirrelCandidate;
try {
  squirrelCandidate = JSON.parse(squirrelCandidateText);
} catch {
  throw new Error("Windows Squirrel candidate must be valid JSON");
}
if (
  squirrelCandidateText !== `${JSON.stringify(squirrelCandidate, null, 2)}\n`
) {
  throw new Error("Windows Squirrel candidate JSON is not canonical");
}
squirrelCandidate = requireWindowsSquirrelCandidate(squirrelCandidate);
if (squirrelCandidate.version !== version) {
  throw new Error("Windows Squirrel candidate version differs from the release");
}
await verifyPreparedWindowsSquirrelCandidate(
  preparedDirectory,
  squirrelCandidate,
);
const evidence = Object.freeze({
  promotionEvidenceContractVersion: 1,
  verification: "full-get-sha256-and-bytes-match",
  release,
  sourceArtifact: Object.freeze({
    fileName: "TokenMonsterSetup.exe",
    sha256: sourceSha256,
    bytes: sourceMetadata.size,
  }),
  fullCdnGet: Object.freeze({
    downloadUrl: release.downloadUrl,
    sha256: recalledSha256,
    bytes: recalledMetadata.size,
  }),
  workerBinding: Object.freeze({
    name: "TOKENMONSTER_PUBLIC_RELEASE_JSON",
    canonicalJsonSha256: sha256Text(canonicalPublicReleaseJson),
  }),
});
await writeFile(
  join(preparedDirectory, "promotion-evidence-v1.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
