// @ts-check

"use strict";

const { createHash } = require("node:crypto");
const { constants } = require("node:fs");
const { accessSync, lstatSync, readFileSync } = require("node:fs");
const { extname, isAbsolute, join, resolve, sep } = require("node:path");

const { sign } = require("@electron/windows-sign");

/**
 * @typedef {Readonly<{
 *   bindingBytes: number,
 *   bindingSha256: string
 * }>} RawBoundZstdExpectation
 */

/**
 * @typedef {Readonly<{
 *   automaticallySelectCertificate: false,
 *   debug: false,
 *   description: "TokenMonster",
 *   hashes: readonly ["sha256"],
 *   signJavaScript: false,
 *   timestampServer: "https://timestamp.digicert.com"
 * }>} AuditedWindowsSignOptions
 */

/**
 * @typedef {AuditedWindowsSignOptions & { files: string[] }} AuditedPhysicalSignOptions
 */

/** @typedef {(options: AuditedPhysicalSignOptions) => Promise<void>} AuditedSigner */

const ZSTD_POLICY_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "packages",
  "token-tracker-runtime",
  "src",
  "zstd-native-policy.json",
);
const RAW_BOUND_ZSTD_RELATIVE_PATH = join(
  "resources",
  "sidecar",
  "node_modules",
  "@mongodb-js",
  "zstd",
  "build",
  "Release",
  "zstd.node",
);
const FORBIDDEN_SIGNING_ENVIRONMENT = Object.freeze([
  "DEBUG",
  "NODE_DEBUG",
  "NODE_OPTIONS",
  "TOKENMONSTER_WINDOWS_CERTIFICATE_PASSWORD",
  "TOKENMONSTER_WINDOWS_CERTIFICATE_PATH",
  "WINDOWS_SIGN_DESCRIPTION",
  "WINDOWS_SIGN_HOOK_MODULE_PATH",
  "WINDOWS_SIGN_JAVASCRIPT",
  "WINDOWS_SIGN_WEBSITE",
  "WINDOWS_SIGN_WITH_PARAMS",
  "WINDOWS_SIGNTOOL_PATH",
  "WINDOWS_TIMESTAMP_SERVER",
]);

/** @type {AuditedWindowsSignOptions} */
const AUDITED_WINDOWS_SIGN_OPTIONS = Object.freeze({
  automaticallySelectCertificate: false,
  debug: false,
  description: "TokenMonster",
  hashes: Object.freeze(/** @type {readonly ["sha256"]} */ (["sha256"])),
  signJavaScript: false,
  timestampServer: "https://timestamp.digicert.com",
});

/**
 * Bridge the package's duplicate CJS/ESM const-enum declarations. Runtime
 * accepts the exact string values above; this hook never accepts arbitrary
 * signing options from a caller or environment variable.
 *
 * @type {AuditedSigner}
 */
const auditedSign = /** @type {AuditedSigner} */ (
  /** @type {unknown} */ (sign)
);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @returns {RawBoundZstdExpectation} */
function loadRawBoundZstdExpectation() {
  /** @type {unknown} */
  const policy = JSON.parse(readFileSync(ZSTD_POLICY_PATH, "utf8"));
  if (!isRecord(policy) || policy["schemaVersion"] !== "1") {
    throw new Error("Windows signing hook rejected the zstd policy schema.");
  }
  const dependency = policy["dependency"];
  const platforms = policy["platforms"];
  if (
    !isRecord(dependency) ||
    dependency["sidecarPackage"] !== "tokentracker-cli" ||
    dependency["sidecarVersion"] !== "0.80.0" ||
    dependency["nativePackage"] !== "@mongodb-js/zstd" ||
    dependency["nativeVersion"] !== "2.0.1" ||
    !isRecord(platforms)
  ) {
    throw new Error(
      "Windows signing hook rejected the zstd dependency policy.",
    );
  }
  const target = platforms["win32-x64"];
  if (
    !isRecord(target) ||
    target["platform"] !== "win32" ||
    target["arch"] !== "x64" ||
    target["bindingPath"] !== "build/Release/zstd.node" ||
    typeof target["bindingBytes"] !== "number" ||
    !Number.isSafeInteger(target["bindingBytes"]) ||
    target["bindingBytes"] < 1 ||
    target["bindingBytes"] > 16 * 1024 * 1024 ||
    typeof target["bindingSha256"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(target["bindingSha256"])
  ) {
    throw new Error("Windows signing hook rejected the win32-x64 zstd policy.");
  }
  return Object.freeze({
    bindingBytes: target["bindingBytes"],
    bindingSha256: target["bindingSha256"],
  });
}

const RAW_BOUND_ZSTD_EXPECTATION = loadRawBoundZstdExpectation();

/**
 * @param {unknown} file
 * @returns {file is string}
 */
function isRawBoundZstdPath(file) {
  return (
    typeof file === "string" &&
    isAbsolute(file) &&
    resolve(file) === file &&
    file.endsWith(`${sep}${RAW_BOUND_ZSTD_RELATIVE_PATH}`)
  );
}

/**
 * @param {unknown} file
 * @returns {{ path: string, metadata: import("node:fs").Stats }}
 */
function requirePhysicalAbsoluteFile(file) {
  if (typeof file !== "string" || !isAbsolute(file) || resolve(file) !== file) {
    throw new Error(
      "Windows signing hook requires a normalized absolute path.",
    );
  }
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Windows signing hook requires a physical regular file.");
  }
  return { path: file, metadata };
}

/**
 * @param {import("node:fs").Stats} before
 * @param {import("node:fs").Stats} after
 */
function sameFileIdentity(before, after) {
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.size === before.size &&
    after.mtimeMs === before.mtimeMs &&
    after.ctimeMs === before.ctimeMs
  );
}

/**
 * @param {unknown} file
 * @param {RawBoundZstdExpectation} expectation
 */
function validateRawBoundZstd(file, expectation) {
  if (!isRawBoundZstdPath(file)) {
    throw new Error("Windows signing hook refused a non-zstd exemption path.");
  }
  if (
    !Number.isSafeInteger(expectation.bindingBytes) ||
    expectation.bindingBytes < 1 ||
    typeof expectation.bindingSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(expectation.bindingSha256)
  ) {
    throw new Error("Windows signing hook rejected its zstd expectation.");
  }
  const { path, metadata: before } = requirePhysicalAbsoluteFile(file);
  const contents = readFileSync(path);
  const after = lstatSync(path);
  if (
    !sameFileIdentity(before, after) ||
    contents.byteLength !== expectation.bindingBytes ||
    createHash("sha256").update(contents).digest("hex") !==
      expectation.bindingSha256
  ) {
    throw new Error("Windows signing hook rejected raw-bound zstd bytes.");
  }
}

function requireAuditedSigningEnvironment() {
  for (const name of FORBIDDEN_SIGNING_ENVIRONMENT) {
    if (process.env[name] !== undefined) {
      throw new Error("Windows signing hook rejected an unaudited override.");
    }
  }
  const certificatePath = process.env["WINDOWS_CERTIFICATE_FILE"];
  const certificatePassword = process.env["WINDOWS_CERTIFICATE_PASSWORD"];
  if (
    typeof certificatePath !== "string" ||
    certificatePath.length < 1 ||
    certificatePath.length > 1_024 ||
    certificatePath !== certificatePath.trim() ||
    /[\0\r\n]/u.test(certificatePath) ||
    !isAbsolute(certificatePath) ||
    extname(certificatePath).toLowerCase() !== ".pfx"
  ) {
    throw new Error(
      "Windows signing hook requires an audited certificate file.",
    );
  }
  const certificateMetadata = lstatSync(certificatePath);
  if (!certificateMetadata.isFile() || certificateMetadata.isSymbolicLink()) {
    throw new Error(
      "Windows signing hook requires a physical certificate file.",
    );
  }
  accessSync(certificatePath, constants.R_OK);
  if (
    typeof certificatePassword !== "string" ||
    certificatePassword.length < 1 ||
    certificatePassword.length > 1_024 ||
    /[\0\r\n]/u.test(certificatePassword)
  ) {
    throw new Error(
      "Windows signing hook requires an audited certificate password.",
    );
  }
}

/**
 * @param {unknown} file
 * @param {RawBoundZstdExpectation} expectation
 * @param {AuditedSigner} signer
 * @returns {Promise<"signed" | "skipped-raw-bound-zstd">}
 */
async function signPhysicalFile(file, expectation, signer) {
  requireAuditedSigningEnvironment();
  const physical = requirePhysicalAbsoluteFile(file);
  if (isRawBoundZstdPath(physical.path)) {
    validateRawBoundZstd(physical.path, expectation);
    return "skipped-raw-bound-zstd";
  }
  await signer({
    ...AUDITED_WINDOWS_SIGN_OPTIONS,
    files: [physical.path],
  });
  return "signed";
}

/**
 * @param {unknown} file
 * @param {RawBoundZstdExpectation} [expectation]
 * @param {AuditedSigner} [signer]
 */
async function windowsSigningHook(
  file,
  expectation = RAW_BOUND_ZSTD_EXPECTATION,
  signer = auditedSign,
) {
  try {
    return await signPhysicalFile(file, expectation, signer);
  } catch {
    // @electron/windows-sign 1.2.2 logs and swallows a hook rejection. Preserve
    // its callback contract but leave an observable non-zero process status so
    // both direct Packager and electron-winstaller's SEA fail closed.
    process.exitCode = 1;
    throw new Error("Audited Windows signing hook failed closed.");
  }
}

/**
 * @typedef {typeof windowsSigningHook & {
 *   auditedWindowsSignOptions: AuditedWindowsSignOptions,
 *   forbiddenSigningEnvironment: readonly string[],
 *   isRawBoundZstdPath: typeof isRawBoundZstdPath,
 *   rawBoundZstdExpectation: RawBoundZstdExpectation,
 *   rawBoundZstdRelativePath: string,
 *   signPhysicalFile: typeof signPhysicalFile,
 *   validateRawBoundZstd: typeof validateRawBoundZstd
 * }} WindowsSigningHookModule
 */

/** @type {WindowsSigningHookModule} */
const exportedHook = Object.assign(windowsSigningHook, {
  auditedWindowsSignOptions: AUDITED_WINDOWS_SIGN_OPTIONS,
  forbiddenSigningEnvironment: FORBIDDEN_SIGNING_ENVIRONMENT,
  isRawBoundZstdPath,
  rawBoundZstdExpectation: RAW_BOUND_ZSTD_EXPECTATION,
  rawBoundZstdRelativePath: RAW_BOUND_ZSTD_RELATIVE_PATH,
  signPhysicalFile,
  validateRawBoundZstd,
});

module.exports = exportedHook;
