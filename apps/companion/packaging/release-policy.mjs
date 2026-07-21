import { constants } from "node:fs";
import { accessSync, lstatSync } from "node:fs";
import { extname, isAbsolute } from "node:path";

import {
  ciWindowsReleaseVersionForRunId,
  requireWindowsReleaseVersion,
} from "../../../scripts/release/release-version-contract.mjs";

export const SOURCE_COMPANION_VERSION = "0.1.0";
export const WINDOWS_RFC3161_TIMESTAMP_SERVER =
  "https://timestamp.digicert.com";

const WINDOWS_SIGNING_OVERRIDE_ENVIRONMENT = [
  "WINDOWS_CERTIFICATE_FILE",
  "WINDOWS_CERTIFICATE_PASSWORD",
  "WINDOWS_SIGN_DESCRIPTION",
  "WINDOWS_SIGN_HOOK_MODULE_PATH",
  "WINDOWS_SIGN_JAVASCRIPT",
  "WINDOWS_SIGN_WEBSITE",
  "WINDOWS_SIGN_WITH_PARAMS",
  "WINDOWS_SIGNTOOL_PATH",
  "WINDOWS_TIMESTAMP_SERVER"
];
const WINDOWS_SIGNABLE_EXTENSION = /\.(?:dll|efi|exe|node|scr|sys)$/iu;
export const WINDOWS_RAW_BOUND_ZSTD_SIDECAR_PATH =
  "node_modules/@mongodb-js/zstd/build/Release/zstd.node";
const WINDOWS_RAW_BOUND_ZSTD_RESOURCE_SUFFIX =
  `resources/sidecar/${WINDOWS_RAW_BOUND_ZSTD_SIDECAR_PATH}`;
function requiredText(environment, name, options = {}) {
  const value = environment[name];
  const maximumLength = options.maximumLength ?? 1_024;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    /[\0\r\n]/u.test(value) ||
    (options.preserveBoundaryWhitespace !== true && value !== value.trim())
  ) {
    throw new Error(`Signed Windows release requires a valid ${name}.`);
  }
  return value;
}

export function requireReleaseVersion(environment = process.env) {
  return requireWindowsReleaseVersion(
    environment.TOKENMONSTER_RELEASE_VERSION,
    "TOKENMONSTER_RELEASE_VERSION"
  );
}

export function ciReleaseVersionForRunId(runId) {
  return ciWindowsReleaseVersionForRunId(SOURCE_COMPANION_VERSION, runId);
}

export function squirrelVersionFor(releaseVersion) {
  const version = requireReleaseVersion({
    TOKENMONSTER_RELEASE_VERSION: releaseVersion
  });
  const [mainVersion, ...preRelease] = version.split("-");
  return preRelease.length === 0
    ? mainVersion
    : `${mainVersion}-${preRelease.join("-").replaceAll(".", "")}`;
}

export function requireSquirrelReleaseEntry(
  parts,
  { fileName, byteSize, sha1 }
) {
  if (
    !Array.isArray(parts) ||
    parts.length !== 3 ||
    typeof fileName !== "string" ||
    fileName.length < 1 ||
    /[\0\r\n\s/\\]/u.test(fileName) ||
    !Number.isSafeInteger(byteSize) ||
    byteSize < 0 ||
    typeof sha1 !== "string" ||
    !/^[a-f0-9]{40}$/iu.test(sha1) ||
    typeof parts[0] !== "string" ||
    parts[0].toLowerCase() !== sha1.toLowerCase() ||
    parts[1] !== fileName ||
    parts[2] !== String(byteSize)
  ) {
    throw new Error(
      "Squirrel RELEASES does not bind the full package SHA-1, name, and byte size."
    );
  }
  return Object.freeze({
    sha1: sha1.toLowerCase(),
    fileName,
    byteSize
  });
}

export function requireSignedWindowsSquirrelInventory(
  fileNames,
  fullPackageName
) {
  const expected = [
    "RELEASES",
    "TokenMonsterSetup.exe",
    fullPackageName
  ].sort();
  if (
    !Array.isArray(fileNames) ||
    typeof fullPackageName !== "string" ||
    !/^TokenMonster-[0-9A-Za-z.-]+-full\.nupkg$/u.test(fullPackageName) ||
    fileNames.some(
      (fileName) =>
        typeof fileName !== "string" ||
        fileName.length < 1 ||
        /[\0\r\n/\\]/u.test(fileName)
    ) ||
    JSON.stringify([...fileNames].sort()) !== JSON.stringify(expected)
  ) {
    throw new Error(
      "Signed Windows publication requires exactly RELEASES, TokenMonsterSetup.exe, and one version-bound full .nupkg."
    );
  }
  return Object.freeze([...expected]);
}

export function packageJsonWithReleaseVersion(packageJson, releaseVersion) {
  requireReleaseVersion({ TOKENMONSTER_RELEASE_VERSION: releaseVersion });
  if (
    packageJson === null ||
    typeof packageJson !== "object" ||
    Array.isArray(packageJson) ||
    packageJson.version !== SOURCE_COMPANION_VERSION
  ) {
    throw new Error(
      `Companion source package version must remain ${SOURCE_COMPANION_VERSION}.`
    );
  }
  return { ...packageJson, version: releaseVersion };
}

export function isWindowsSignablePath(path) {
  return typeof path === "string" && WINDOWS_SIGNABLE_EXTENSION.test(path);
}

export function isWindowsRawPolicyBoundPath(path) {
  if (typeof path !== "string" || path.includes("\0")) return false;
  const normalized = path.replaceAll("\\", "/").toLocaleLowerCase("en-US");
  const expected = WINDOWS_RAW_BOUND_ZSTD_RESOURCE_SUFFIX.toLocaleLowerCase(
    "en-US"
  );
  return normalized === expected || normalized.endsWith(`/${expected}`);
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

export function authenticodeEvidenceFromInspection(
  result,
  expectedSignerSubject
) {
  if (
    typeof expectedSignerSubject !== "string" ||
    expectedSignerSubject.length < 3 ||
    expectedSignerSubject.length > 512 ||
    expectedSignerSubject !== expectedSignerSubject.trim() ||
    /[\0\r\n]/u.test(expectedSignerSubject) ||
    !/(?:^|,)\s*(?:CN|O)=/iu.test(expectedSignerSubject) ||
    !hasExactKeys(result, [
      "status",
      "signerSubject",
      "signerThumbprint",
      "timestampSubject",
      "timestampThumbprint",
      "signatureContainerCount",
      "digestOids",
      "timestampAttributeOids",
      "productVersion",
      "fileVersion"
    ]) ||
    result.status !== "Valid" ||
    result.signerSubject !== expectedSignerSubject ||
    typeof result.signerThumbprint !== "string" ||
    !/^[A-F0-9]{40,128}$/iu.test(result.signerThumbprint) ||
    typeof result.timestampSubject !== "string" ||
    result.timestampSubject.length < 3 ||
    typeof result.timestampThumbprint !== "string" ||
    !/^[A-F0-9]{40,128}$/iu.test(result.timestampThumbprint) ||
    result.signatureContainerCount !== 1 ||
    !Array.isArray(result.digestOids) ||
    result.digestOids.length < 1 ||
    result.digestOids.some(
      (digestOid) => digestOid !== "2.16.840.1.101.3.4.2.1"
    ) ||
    !Array.isArray(result.timestampAttributeOids) ||
    result.timestampAttributeOids.length < 1 ||
    result.timestampAttributeOids.some(
      (attributeOid) => attributeOid !== "1.3.6.1.4.1.311.3.3.1"
    )
  ) {
    throw new Error(
      "Authenticode status, signer, RFC3161 timestamp, or SHA-256 policy did not match."
    );
  }
  return {
    status: result.status,
    signerSubject: result.signerSubject,
    signerThumbprint: result.signerThumbprint.toUpperCase(),
    timestampPresent: true,
    timestampSubject: result.timestampSubject,
    timestampThumbprint: result.timestampThumbprint.toUpperCase(),
    digestAlgorithm: "sha256",
    digestOid: "2.16.840.1.101.3.4.2.1",
    timestampProtocol: "RFC3161",
    timestampAttributeOid: "1.3.6.1.4.1.311.3.3.1",
    timestampServer: WINDOWS_RFC3161_TIMESTAMP_SERVER,
    productVersion:
      typeof result.productVersion === "string" ? result.productVersion : null,
    fileVersion:
      typeof result.fileVersion === "string" ? result.fileVersion : null
  };
}

export function requireWindowsSignerSubject(environment = process.env) {
  const subject = requiredText(
    environment,
    "TOKENMONSTER_WINDOWS_SIGNER_SUBJECT",
    { maximumLength: 512 }
  );
  if (!/(?:^|,)\s*(?:CN|O)=/iu.test(subject)) {
    throw new Error(
      "TOKENMONSTER_WINDOWS_SIGNER_SUBJECT must be an exact certificate subject."
    );
  }
  return subject;
}

export function prepareWindowsSigningEnvironment(environment = process.env) {
  for (const name of WINDOWS_SIGNING_OVERRIDE_ENVIRONMENT) {
    if (environment[name] !== undefined) {
      throw new Error(
        "Signed Windows release rejects unaudited WINDOWS_* signing overrides."
      );
    }
  }

  const certificatePath = requiredText(
    environment,
    "TOKENMONSTER_WINDOWS_CERTIFICATE_PATH"
  );
  const certificatePassword = requiredText(
    environment,
    "TOKENMONSTER_WINDOWS_CERTIFICATE_PASSWORD",
    { preserveBoundaryWhitespace: true }
  );
  const expectedSignerSubject = requireWindowsSignerSubject(environment);

  let certificateMetadata;
  try {
    if (
      !isAbsolute(certificatePath) ||
      extname(certificatePath).toLowerCase() !== ".pfx"
    ) {
      throw new Error("invalid certificate path");
    }
    certificateMetadata = lstatSync(certificatePath);
    accessSync(certificatePath, constants.R_OK);
  } catch {
    throw new Error(
      "TOKENMONSTER_WINDOWS_CERTIFICATE_PATH must name a readable absolute .pfx file."
    );
  }
  if (!certificateMetadata.isFile() || certificateMetadata.isSymbolicLink()) {
    throw new Error(
      "TOKENMONSTER_WINDOWS_CERTIFICATE_PATH must name a regular non-symbolic .pfx file."
    );
  }

  // @electron/windows-sign's debug path serializes its option object. Keep the
  // PFX path/password out of that object and let the signer read only these two
  // audited standard variables. Remove Node/debug injection that could print a
  // spawned signtool command line (which necessarily contains the PFX password).
  environment.WINDOWS_CERTIFICATE_FILE = certificatePath;
  environment.WINDOWS_CERTIFICATE_PASSWORD = certificatePassword;
  delete environment.TOKENMONSTER_WINDOWS_CERTIFICATE_PATH;
  delete environment.TOKENMONSTER_WINDOWS_CERTIFICATE_PASSWORD;
  delete environment.DEBUG;
  delete environment.NODE_DEBUG;
  delete environment.NODE_OPTIONS;

  return {
    expectedSignerSubject,
    windowsSign: {
      automaticallySelectCertificate: false,
      debug: false,
      description: "TokenMonster",
      hashes: ["sha256"],
      signJavaScript: false,
      timestampServer: WINDOWS_RFC3161_TIMESTAMP_SERVER
    }
  };
}

export function environmentWithoutWindowsSigningSecrets(
  environment = process.env
) {
  const result = { ...environment };
  for (const name of [
    ...WINDOWS_SIGNING_OVERRIDE_ENVIRONMENT,
    "TOKENMONSTER_WINDOWS_CERTIFICATE_PATH",
    "TOKENMONSTER_WINDOWS_CERTIFICATE_PASSWORD"
  ]) {
    delete result[name];
  }
  return result;
}
