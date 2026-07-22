import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const CHARACTERS_DIRECTORY = join(REPOSITORY_ROOT, "packages", "characters");
const MAX_BUILD_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_BUILD_LOCK_BYTES = 512;
const MAX_BUILD_STAMP_BYTES = 512;
const MAX_BUILD_LOCK_WAIT_MS = 60_000;
const INVALID_BUILD_LOCK_STALE_MS = 30_000;
const BUILD_LOCK_RETRY_MS = 50;
const BUILD_LOCK_PATH = join(
  tmpdir(),
  `tokenmonster-characters-build-${createHash("sha256")
    .update(REPOSITORY_ROOT)
    .digest("hex")
    .slice(0, 24)}.lock`,
);
const BUILD_STAMP_PATH = `${BUILD_LOCK_PATH}.stamp`;
const FINGERPRINT_ROOTS = Object.freeze([
  join(CHARACTERS_DIRECTORY, "src"),
  join(CHARACTERS_DIRECTORY, "package.json"),
  join(CHARACTERS_DIRECTORY, "tsconfig.build.json"),
  join(REPOSITORY_ROOT, "tsconfig.base.json"),
  join(CHARACTERS_DIRECTORY, "scripts", "copy-release-slots.mjs"),
  join(REPOSITORY_ROOT, "node_modules", "typescript", "package.json"),
]);
const REQUIRED_COMPILED_FILES = Object.freeze([
  "asset-release.js",
  "asset-pack.js",
]);
const RELEASE_SLOT_FILES = Object.freeze([
  "approved-release-v2.json",
  "approved-asset-pack-descriptor-v1.json",
  "approved-asset-pack-allowlist-v1.json",
]);
const BUILD_LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function isMissing(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyPresent(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readStablePhysicalFile(path) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("@tokenmonster/characters build input must be a physical file");
  }
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  if (!sameFile(before, after) || bytes.byteLength !== before.size) {
    throw new Error("@tokenmonster/characters build input changed while hashing");
  }
  return bytes;
}

function collectFingerprintFiles(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    throw new Error("@tokenmonster/characters build input must not be a symlink");
  }
  if (metadata.isFile()) return [path];
  if (!metadata.isDirectory()) {
    throw new Error("@tokenmonster/characters build input has an unsupported type");
  }
  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => collectFingerprintFiles(join(path, entry.name)));
}

function buildInputFingerprint() {
  const hash = createHash("sha256");
  const files = FINGERPRINT_ROOTS.flatMap(collectFingerprintFiles).sort();
  for (const path of files) {
    hash.update(relative(REPOSITORY_ROOT, path));
    hash.update("\0");
    hash.update(readStablePhysicalFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function compiledOutputFingerprint() {
  const outputRoot = join(CHARACTERS_DIRECTORY, "dist");
  const files = collectFingerprintFiles(outputRoot)
    .filter((path) => path.endsWith(".js"))
    .sort();
  if (files.length < REQUIRED_COMPILED_FILES.length) {
    throw new Error("@tokenmonster/characters compiled output is incomplete");
  }
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(outputRoot, path));
    hash.update("\0");
    hash.update(readStablePhysicalFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function compiledOutputIsCurrent(fingerprint) {
  let stampMetadata;
  try {
    stampMetadata = lstatSync(BUILD_STAMP_PATH);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (
    !stampMetadata.isFile() ||
    stampMetadata.isSymbolicLink() ||
    stampMetadata.size < 1 ||
    stampMetadata.size > MAX_BUILD_STAMP_BYTES
  ) {
    return false;
  }
  let stamp;
  try {
    stamp = JSON.parse(readStablePhysicalFile(BUILD_STAMP_PATH).toString("utf8"));
  } catch {
    return false;
  }
  if (
    stamp === null ||
    typeof stamp !== "object" ||
    Array.isArray(stamp) ||
    Reflect.ownKeys(stamp).length !== 3 ||
    stamp.schemaVersion !== "1" ||
    stamp.fingerprint !== fingerprint ||
    !/^[0-9a-f]{64}$/u.test(stamp.outputFingerprint)
  ) {
    return false;
  }
  try {
    for (const fileName of REQUIRED_COMPILED_FILES) {
      const metadata = lstatSync(join(CHARACTERS_DIRECTORY, "dist", fileName));
      if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    }
    for (const fileName of RELEASE_SLOT_FILES) {
      const source = readStablePhysicalFile(
        join(CHARACTERS_DIRECTORY, "src", fileName),
      );
      const compiled = readStablePhysicalFile(
        join(CHARACTERS_DIRECTORY, "dist", fileName),
      );
      if (!compiled.equals(source)) return false;
    }
    if (compiledOutputFingerprint() !== stamp.outputFingerprint) return false;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  return true;
}

function writeBuildStamp(fingerprint) {
  let existing;
  try {
    existing = lstatSync(BUILD_STAMP_PATH);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (existing !== undefined) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("@tokenmonster/characters build stamp is not a physical file");
    }
    unlinkSync(BUILD_STAMP_PATH);
  }
  const descriptor = openSync(BUILD_STAMP_PATH, "wx", 0o600);
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        schemaVersion: "1",
        fingerprint,
        outputFingerprint: compiledOutputFingerprint(),
      })}\n`,
      "utf8",
    );
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function removeLockIfUnchanged(before) {
  let after;
  try {
    after = lstatSync(BUILD_LOCK_PATH);
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  if (!sameFile(before, after)) return false;
  try {
    unlinkSync(BUILD_LOCK_PATH);
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  return true;
}

function removeStaleBuildLock() {
  let before;
  try {
    before = lstatSync(BUILD_LOCK_PATH);
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    before.size > MAX_BUILD_LOCK_BYTES
  ) {
    if (
      !before.isSymbolicLink() &&
      before.isFile() &&
      Date.now() - before.mtimeMs >= INVALID_BUILD_LOCK_STALE_MS
    ) {
      return removeLockIfUnchanged(before);
    }
    return false;
  }

  let owner;
  try {
    owner = JSON.parse(readFileSync(BUILD_LOCK_PATH, "utf8"));
  } catch {
    if (Date.now() - before.mtimeMs < INVALID_BUILD_LOCK_STALE_MS) return false;
    return removeLockIfUnchanged(before);
  }
  const validOwner =
    owner !== null &&
    typeof owner === "object" &&
    !Array.isArray(owner) &&
    Reflect.ownKeys(owner).length === 2 &&
    owner.schemaVersion === "1" &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0;
  if (!validOwner) {
    if (Date.now() - before.mtimeMs < INVALID_BUILD_LOCK_STALE_MS) return false;
    return removeLockIfUnchanged(before);
  }
  if (processIsAlive(owner.pid)) return false;
  return removeLockIfUnchanged(before);
}

function acquireBuildLock() {
  const deadline = Date.now() + MAX_BUILD_LOCK_WAIT_MS;
  const owner = Object.freeze({
    schemaVersion: "1",
    pid: process.pid,
  });
  const serializedOwner = `${JSON.stringify(owner)}\n`;
  while (true) {
    let descriptor;
    try {
      descriptor = openSync(BUILD_LOCK_PATH, "wx", 0o600);
      writeFileSync(descriptor, serializedOwner, "utf8");
      fsyncSync(descriptor);
      return Object.freeze({
        descriptor,
        identity: fstatSync(descriptor),
        serializedOwner,
      });
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        try {
          unlinkSync(BUILD_LOCK_PATH);
        } catch {
          // The original write failure is the actionable error.
        }
      }
      if (!isAlreadyPresent(error)) {
        throw new Error(
          `Could not acquire @tokenmonster/characters build lock: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (removeStaleBuildLock()) continue;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          "Could not acquire @tokenmonster/characters build lock before timeout",
        );
      }
      Atomics.wait(
        BUILD_LOCK_WAIT_BUFFER,
        0,
        0,
        Math.min(BUILD_LOCK_RETRY_MS, remainingMs),
      );
    }
  }
}

function releaseBuildLock(lock) {
  try {
    const currentIdentity = lstatSync(BUILD_LOCK_PATH);
    if (!sameFile(lock.identity, currentIdentity)) {
      throw new Error("@tokenmonster/characters build lock identity changed");
    }
    const current = readFileSync(BUILD_LOCK_PATH, "utf8");
    if (current !== lock.serializedOwner) {
      throw new Error("@tokenmonster/characters build lock owner changed");
    }
    unlinkSync(BUILD_LOCK_PATH);
  } finally {
    closeSync(lock.descriptor);
  }
}

function failureDetail(result) {
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (stderr !== "") return stderr;
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (stdout !== "") return stdout;
  if (result.error instanceof Error) return result.error.message;
  if (result.signal !== null) return `terminated by signal ${result.signal}`;
  return `exited with status ${String(result.status)}`;
}

function runBuildStep(arguments_, failureMessage) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: CHARACTERS_DIRECTORY,
    encoding: "utf8",
    maxBuffer: MAX_BUILD_OUTPUT_BYTES,
  });
  if (result.status !== 0) {
    throw new Error(`${failureMessage}: ${failureDetail(result)}`);
  }
}

/**
 * Build the characters package synchronously, then restore the exact reviewed
 * release-slot bytes that TypeScript's JSON emitter otherwise reformats.
 */
export function buildCharactersPackage() {
  const lock = acquireBuildLock();
  let buildFailure;
  try {
    const fingerprint = buildInputFingerprint();
    if (!compiledOutputIsCurrent(fingerprint)) {
      runBuildStep(
        [
          join(REPOSITORY_ROOT, "node_modules", "typescript", "bin", "tsc"),
          "-p",
          "tsconfig.build.json",
        ],
        "Could not build @tokenmonster/characters before validation",
      );
      runBuildStep(
        [join(CHARACTERS_DIRECTORY, "scripts", "copy-release-slots.mjs")],
        "Could not restore exact @tokenmonster/characters release slots",
      );
      if (buildInputFingerprint() !== fingerprint) {
        throw new Error(
          "@tokenmonster/characters build inputs changed during compilation",
        );
      }
      writeBuildStamp(fingerprint);
    }
  } catch (error) {
    buildFailure = error;
  }
  try {
    releaseBuildLock(lock);
  } catch (releaseFailure) {
    if (buildFailure !== undefined) {
      const buildDetail =
        buildFailure instanceof Error
          ? buildFailure.message
          : String(buildFailure);
      const releaseDetail =
        releaseFailure instanceof Error
          ? releaseFailure.message
          : String(releaseFailure);
      throw new AggregateError(
        [buildFailure, releaseFailure],
        `${buildDetail}; build lock cleanup also failed: ${releaseDetail}`,
      );
    }
    throw releaseFailure;
  }
  if (buildFailure !== undefined) throw buildFailure;
}
