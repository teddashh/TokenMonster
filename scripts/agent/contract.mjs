import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const rootDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const manifestPath = resolve(rootDirectory, "agent-release.json");
export const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const PRIVATE_FILE_CAP = 16 * 1024;
export const SAFE_LOG_CAP = 8 * 1024;

const OBJECT_KEYS = {
  top: [
    "$schema",
    "contractVersion",
    "entrypoints",
    "exitCodes",
    "kind",
    "permissions",
    "privacy",
    "product",
    "requirements",
    "runtime",
    "schemaVersion",
    "sideEffects",
    "skills",
    "trust",
  ],
  product: [
    "distributionLane",
    "name",
    "not",
    "package",
    "platforms",
    "repository",
    "runtime",
  ],
  trust: ["invocation", "source", "warning"],
  entrypoints: ["audit", "doctor", "launch", "status", "stop"],
  entrypoint: ["argv", "flags", "sideEffect"],
  requirements: ["common", "linux", "macos", "windows"],
  permissions: [
    "allowedByScripts",
    "deniedBySkill",
    "requiresSeparateExplicitApproval",
  ],
  sideEffects: [
    "applicationData",
    "automaticRollback",
    "hostConfigurationByScripts",
    "repositoryLocal",
    "userCaches",
  ],
  repositorySideEffect: ["path", "removal", "when"],
  runtime: [
    "auditAfter",
    "auditBefore",
    "directory",
    "launchLock",
    "launchReceipt",
    "logFile",
    "readyMarker",
    "stateFile",
    "states",
  ],
  exitCodes: ["0", "1", "2", "3"],
  skills: [
    "claude",
    "codex",
    "codexMetadata",
    "implicitInvocation",
    "version",
  ],
  privacy: [
    "auditUpload",
    "childOutput",
    "credentials",
    "localOnly",
    "logUpload",
    "persistentState",
  ],
};

export function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function nonEmptyStrings(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.length > 0)
  );
}

function allObjectsHaveKeys(values, expected) {
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.every(
      (value) =>
        exactKeys(value, expected) &&
        Object.values(value).every(
          (item) => typeof item === "string" && item.length > 0,
        ),
    )
  );
}

export function validateManifest(value) {
  const entrypoints = value?.entrypoints;
  const runtime = value?.runtime;
  if (
    !exactKeys(value, OBJECT_KEYS.top) ||
    !exactKeys(value.product, OBJECT_KEYS.product) ||
    !exactKeys(value.trust, OBJECT_KEYS.trust) ||
    !exactKeys(entrypoints, OBJECT_KEYS.entrypoints) ||
    !Object.values(entrypoints).every((entrypoint) =>
      exactKeys(entrypoint, OBJECT_KEYS.entrypoint),
    ) ||
    !exactKeys(value.requirements, OBJECT_KEYS.requirements) ||
    !exactKeys(value.permissions, OBJECT_KEYS.permissions) ||
    !exactKeys(value.sideEffects, OBJECT_KEYS.sideEffects) ||
    !exactKeys(runtime, OBJECT_KEYS.runtime) ||
    !exactKeys(value.exitCodes, OBJECT_KEYS.exitCodes) ||
    !exactKeys(value.skills, OBJECT_KEYS.skills) ||
    !exactKeys(value.privacy, OBJECT_KEYS.privacy)
  ) {
    throw new Error("agent_manifest_invalid");
  }
  if (
    value.$schema !== "./agent-release.schema.json" ||
    value.schemaVersion !== 1 ||
    value.contractVersion !== "1.0.0" ||
    value.kind !== "agent-ready-source-release" ||
    value.product.package !== "@tokenmonster/companion" ||
    value.product.distributionLane !== "source-development" ||
    value.trust.invocation !== "explicit-only" ||
    value.skills.implicitInvocation !== false ||
    value.privacy.localOnly !== true ||
    value.privacy.logUpload !== "never" ||
    value.privacy.auditUpload !== "never" ||
    !value.permissions.deniedBySkill.includes(
      "packaging, installer generation, signing, release creation or publishing",
    )
  ) {
    throw new Error("agent_manifest_invalid");
  }
  if (
    !nonEmptyStrings(value.product.platforms) ||
    !nonEmptyStrings(value.product.not) ||
    !Object.values(value.requirements).every(nonEmptyStrings) ||
    !Object.values(value.permissions).every(nonEmptyStrings) ||
    !nonEmptyStrings(value.sideEffects.userCaches) ||
    !nonEmptyStrings(value.sideEffects.applicationData) ||
    !allObjectsHaveKeys(
      value.sideEffects.repositoryLocal,
      OBJECT_KEYS.repositorySideEffect,
    ) ||
    !Object.values(value.exitCodes).every(
      (description) =>
        typeof description === "string" && description.length > 0,
    )
  ) {
    throw new Error("agent_manifest_invalid");
  }
  for (const entrypoint of Object.values(entrypoints)) {
    if (
      !nonEmptyStrings(entrypoint.argv) ||
      !Array.isArray(entrypoint.flags) ||
      !entrypoint.flags.every(
        (flag) => typeof flag === "string" && flag.length > 0,
      ) ||
      typeof entrypoint.sideEffect !== "string" ||
      entrypoint.sideEffect.length === 0
    ) {
      throw new Error("agent_manifest_invalid");
    }
  }
  if (
    runtime.directory !== ".agent-runtime" ||
    runtime.stateFile !== ".agent-runtime/tokenmonster-desktop.json" ||
    runtime.launchLock !== ".agent-runtime/launch.lock" ||
    runtime.logFile !== ".agent-runtime/tokenmonster-desktop.log" ||
    runtime.launchReceipt !== ".agent-runtime/last-launch.json" ||
    runtime.auditBefore !== ".agent-runtime/audit-before.json" ||
    runtime.auditAfter !== ".agent-runtime/audit-after.json" ||
    runtime.readyMarker !== "[TOKENMONSTER_AGENT] READY companion" ||
    JSON.stringify(runtime.states) !==
      JSON.stringify([
        "not_started",
        "building",
        "ready",
        "failed",
        "exited",
        "invalid_state",
        "foreign_process",
      ])
  ) {
    throw new Error("agent_manifest_invalid");
  }
  return value;
}

validateManifest(manifest);

export const contractVersion = manifest.contractVersion;
export const readyMarker = manifest.runtime.readyMarker;

export function runtimeRelativePathIsSafe(
  relativePath,
  runtimeName = manifest.runtime.directory,
) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    typeof runtimeName !== "string" ||
    runtimeName.length === 0 ||
    isAbsolute(relativePath) ||
    isAbsolute(runtimeName) ||
    relativePath.includes("\\") ||
    runtimeName.includes("\\")
  ) {
    return false;
  }
  const parts = relativePath.split("/");
  const runtimeParts = runtimeName.split("/");
  if (
    parts.some((part) => part === "" || part === "." || part === "..") ||
    runtimeParts.some((part) => part === "" || part === "." || part === "..")
  ) {
    return false;
  }
  return (
    relativePath === runtimeName || relativePath.startsWith(`${runtimeName}/`)
  );
}

export function resolveContainedRuntimePath(
  baseDirectory,
  relativePath,
  runtimeName = manifest.runtime.directory,
) {
  if (!runtimeRelativePathIsSafe(relativePath, runtimeName)) {
    throw new Error("agent_runtime_path_invalid");
  }
  const candidate = resolve(baseDirectory, relativePath);
  const runtimeRoot = resolve(baseDirectory, runtimeName);
  if (
    candidate !== runtimeRoot &&
    !candidate.startsWith(`${runtimeRoot}${sep}`)
  ) {
    throw new Error("agent_runtime_path_invalid");
  }
  return candidate;
}

function resolveRuntimePath(relativePath, allowDirectory = false) {
  if (!allowDirectory && relativePath === manifest.runtime.directory) {
    throw new Error("agent_runtime_path_invalid");
  }
  return resolveContainedRuntimePath(rootDirectory, relativePath);
}

export const runtimeDirectory = resolveRuntimePath(
  manifest.runtime.directory,
  true,
);
export const statePath = resolveRuntimePath(manifest.runtime.stateFile);
export const launchLockPath = resolveRuntimePath(manifest.runtime.launchLock);
export const logPath = resolveRuntimePath(manifest.runtime.logFile);
export const receiptPath = resolveRuntimePath(manifest.runtime.launchReceipt);
export const auditBeforePath = resolveRuntimePath(manifest.runtime.auditBefore);
export const auditAfterPath = resolveRuntimePath(manifest.runtime.auditAfter);

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertPrivateMode(metadata, expected) {
  if (
    process.platform !== "win32" &&
    (metadata.mode & 0o777) !== expected
  ) {
    throw new Error("agent_runtime_permissions_invalid");
  }
}

export function inspectPrivateDirectoryAt(path, { allowMissing = false } = {}) {
  const metadata = lstatIfPresent(path);
  if (metadata === undefined) {
    if (allowMissing) return { exists: false };
    throw new Error("agent_runtime_directory_missing");
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("agent_runtime_directory_invalid");
  }
  assertPrivateMode(metadata, 0o700);
  return { exists: true };
}

export function ensurePrivateDirectoryAt(path) {
  const metadata = lstatIfPresent(path);
  if (metadata !== undefined) {
    inspectPrivateDirectoryAt(path);
    return;
  }
  mkdirSync(path, { mode: 0o700 });
  inspectPrivateDirectoryAt(path);
}

export function ensureRuntimeDirectory() {
  ensurePrivateDirectoryAt(runtimeDirectory);
}

function assertFileMetadata(metadata, cap) {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("agent_runtime_file_invalid");
  }
  if (metadata.size > cap) {
    throw new Error("agent_runtime_file_oversized");
  }
  assertPrivateMode(metadata, 0o600);
}

export function inspectPrivateFileAt(
  path,
  cap = PRIVATE_FILE_CAP,
  { parentDirectory = dirname(path), allowMissingParent = true } = {},
) {
  const parent = inspectPrivateDirectoryAt(parentDirectory, {
    allowMissing: allowMissingParent,
  });
  if (!parent.exists) return { exists: false };
  const metadata = lstatIfPresent(path);
  if (metadata === undefined) return { exists: false };
  assertFileMetadata(metadata, cap);
  return { exists: true, size: metadata.size };
}

function readBounded(descriptor, cap) {
  const buffer = Buffer.alloc(cap + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (count === 0) break;
    offset += count;
  }
  if (offset > cap) {
    throw new Error("agent_runtime_file_oversized");
  }
  return buffer.subarray(0, offset).toString("utf8");
}

function readPrivateTextAt(path, cap = PRIVATE_FILE_CAP, options = {}) {
  const status = inspectPrivateFileAt(path, cap, options);
  if (!status.exists) return undefined;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor);
    assertFileMetadata(before, cap);
    const contents = readBounded(descriptor, cap);
    const after = fstatSync(descriptor);
    assertFileMetadata(after, cap);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("agent_runtime_file_changed");
    }
    return contents;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function privateFileExists(path, cap = PRIVATE_FILE_CAP) {
  return inspectPrivateFileAt(path, cap).exists;
}

export function readPrivateText(path, cap = PRIVATE_FILE_CAP) {
  return readPrivateTextAt(path, cap);
}

export function readPrivateJson(path, cap = PRIVATE_FILE_CAP) {
  const contents = readPrivateText(path, cap);
  if (contents === undefined) return undefined;
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error("agent_runtime_json_invalid");
  }
}

function temporaryPath(path) {
  return `${path}.tmp-${process.pid}-${randomUUID()}`;
}

export function writePrivateText(path, contents, cap = PRIVATE_FILE_CAP) {
  ensureRuntimeDirectory();
  if (typeof contents !== "string" || Buffer.byteLength(contents) > cap) {
    throw new Error("agent_runtime_write_invalid");
  }
  inspectPrivateFileAt(path, cap, { allowMissingParent: false });
  const temporary = temporaryPath(path);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        noFollow,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    const temporaryMetadata = fstatSync(descriptor);
    assertFileMetadata(temporaryMetadata, cap);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      renameSync(temporary, path);
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EEXIST", "EPERM"].includes(error?.code)
      ) {
        throw error;
      }
      removePrivateFile(path);
      renameSync(temporary, path);
    }
    const written = readPrivateTextAt(path, cap, {
      allowMissingParent: false,
    });
    if (written !== contents) {
      throw new Error("agent_runtime_write_invalid");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    const temporaryMetadata = lstatIfPresent(temporary);
    if (
      temporaryMetadata !== undefined &&
      !temporaryMetadata.isSymbolicLink() &&
      temporaryMetadata.isFile()
    ) {
      rmSync(temporary, { force: true });
    }
  }
}

export function writePrivateJson(path, value, cap = PRIVATE_FILE_CAP) {
  writePrivateText(path, `${JSON.stringify(value, null, 2)}\n`, cap);
}

export function createExclusivePrivateJson(
  path,
  value,
  cap = PRIVATE_FILE_CAP,
) {
  ensureRuntimeDirectory();
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(contents) > cap) {
    throw new Error("agent_runtime_write_invalid");
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        noFollow,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    assertFileMetadata(fstatSync(descriptor), cap);
    closeSync(descriptor);
    descriptor = undefined;
    const written = readPrivateTextAt(path, cap, {
      allowMissingParent: false,
    });
    if (written !== contents) {
      throw new Error("agent_runtime_write_invalid");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function removePrivateFile(path, cap = PRIVATE_FILE_CAP) {
  const status = inspectPrivateFileAt(path, cap);
  if (status.exists) rmSync(path);
}

const SAFE_FIXED_MARKERS = new Set([
  readyMarker,
  "[TOKENMONSTER_AGENT] STATUS dependency_install",
  "[TOKENMONSTER_AGENT] STATUS electron_install",
  "[TOKENMONSTER_AGENT] STATUS build",
  "[TOKENMONSTER_AGENT] STATUS electron_start",
  "[TOKENMONSTER_AGENT] STATUS accepted",
  "[TOKENMONSTER_AGENT] STATUS electron_connected",
  "[TOKENMONSTER_AGENT] ERROR dependency_install_failed",
  "[TOKENMONSTER_AGENT] ERROR electron_install_failed",
  "[TOKENMONSTER_AGENT] ERROR build_failed",
  "[TOKENMONSTER_AGENT] ERROR electron_missing",
  "[TOKENMONSTER_AGENT] ERROR process_start_failed",
  "[TOKENMONSTER_AGENT] ERROR state_write_failed",
  "[TOKENMONSTER_AGENT] ERROR electron_spawn_failed",
]);
const SAFE_EXIT_MARKER =
  /^\[TOKENMONSTER_AGENT\] EXIT (?:code=(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])|signal=(?:SIGABRT|SIGBUS|SIGFPE|SIGHUP|SIGILL|SIGINT|SIGKILL|SIGPIPE|SIGQUIT|SIGSEGV|SIGTERM|SIGTRAP))$/u;

export function safeLifecycleMarker(value) {
  return (
    typeof value === "string" &&
    (SAFE_FIXED_MARKERS.has(value) || SAFE_EXIT_MARKER.test(value))
  );
}

export function resetSafeLog() {
  writePrivateText(logPath, "", SAFE_LOG_CAP);
}

export function appendSafeLog(marker) {
  if (!safeLifecycleMarker(marker)) {
    throw new Error("agent_log_marker_invalid");
  }
  const lines = readSafeLog();
  writePrivateText(
    logPath,
    `${[...lines, marker].join("\n")}\n`,
    SAFE_LOG_CAP,
  );
}

export function readSafeLog() {
  const contents = readPrivateText(logPath, SAFE_LOG_CAP) ?? "";
  if (contents !== "" && !contents.endsWith("\n")) {
    throw new Error("agent_log_contents_invalid");
  }
  const lines =
    contents === "" ? [] : contents.slice(0, -1).split("\n");
  if (lines.some((line) => !safeLifecycleMarker(line))) {
    throw new Error("agent_log_contents_invalid");
  }
  return lines;
}

export function commandPayload(command, payload) {
  return {
    schemaVersion: 1,
    contractVersion,
    command,
    ...payload,
  };
}
