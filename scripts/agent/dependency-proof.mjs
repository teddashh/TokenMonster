import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { join } from "node:path";

import {
  contractVersion,
  exactKeys,
  readPrivateJson,
  receiptPath,
  removePrivateFile,
  rootDirectory,
  writePrivateJson,
} from "./contract.mjs";
import { resolveElectronInstaller } from "./electron-runtime.mjs";

const LOCKFILE_CAP = 64 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RECEIPT_KEYS = [
  "contractVersion",
  "createdAt",
  "dependencyProof",
  "outcome",
  "schemaVersion",
];
const PROOF_KEYS = ["installedTreeSha256", "rootLockSha256"];

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertStableFile(metadata, cap) {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("agent_dependency_file_invalid");
  }
  if (metadata.size > cap) {
    throw new Error("agent_dependency_file_oversized");
  }
}

export function hashRegularFile(path, cap = LOCKFILE_CAP) {
  const initial = lstatIfPresent(path);
  if (initial === undefined) return undefined;
  assertStableFile(initial, cap);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor);
    assertStableFile(before, cap);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > cap) {
        throw new Error("agent_dependency_file_oversized");
      }
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor);
    assertStableFile(after, cap);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      total !== after.size
    ) {
      throw new Error("agent_dependency_file_changed");
    }
    return hash.digest("hex");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function inspectInstallTarget(
  path = join(rootDirectory, "node_modules"),
) {
  const metadata = lstatIfPresent(path);
  if (metadata === undefined) return { exists: false };
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("agent_dependency_target_invalid");
  }
  return { exists: true };
}

export function currentDependencyProof() {
  const rootLockSha256 = hashRegularFile(
    join(rootDirectory, "package-lock.json"),
  );
  if (rootLockSha256 === undefined) {
    throw new Error("agent_root_lock_missing");
  }
  const target = inspectInstallTarget();
  let electronPackageVerified = false;
  if (target.exists) {
    try {
      resolveElectronInstaller();
      electronPackageVerified = true;
    } catch {
      electronPackageVerified = false;
    }
  }
  const installedTreeSha256 =
    target.exists && electronPackageVerified
      ? hashRegularFile(
          join(rootDirectory, "node_modules", ".package-lock.json"),
        )
      : undefined;
  return {
    rootLockSha256,
    installedTreeSha256,
  };
}

export function validDependencyReceipt(value) {
  return (
    exactKeys(value, RECEIPT_KEYS) &&
    value.schemaVersion === 1 &&
    value.contractVersion === contractVersion &&
    ["dependencies_verified", "accepted"].includes(value.outcome) &&
    typeof value.createdAt === "string" &&
    !Number.isNaN(new Date(value.createdAt).valueOf()) &&
    exactKeys(value.dependencyProof, PROOF_KEYS) &&
    SHA256_PATTERN.test(value.dependencyProof.rootLockSha256) &&
    SHA256_PATTERN.test(value.dependencyProof.installedTreeSha256)
  );
}

function readReceipt() {
  try {
    const value = readPrivateJson(receiptPath);
    return validDependencyReceipt(value) ? value : undefined;
  } catch (error) {
    if (error?.message === "agent_runtime_json_invalid") return undefined;
    throw error;
  }
}

export function dependencyPlan() {
  const current = currentDependencyProof();
  const receipt = readReceipt();
  const verified =
    receipt !== undefined &&
    current.installedTreeSha256 !== undefined &&
    receipt.dependencyProof.rootLockSha256 === current.rootLockSha256 &&
    receipt.dependencyProof.installedTreeSha256 ===
      current.installedTreeSha256;
  return {
    installRequired: !verified,
    reason: verified ? "proof_verified" : "proof_missing_or_drifted",
    current,
  };
}

export function invalidateDependencyReceipt() {
  removePrivateFile(receiptPath);
}

export function verifyInstalledDependencies(expectedRootLockSha256) {
  const proof = currentDependencyProof();
  if (
    proof.rootLockSha256 !== expectedRootLockSha256 ||
    proof.installedTreeSha256 === undefined
  ) {
    throw new Error("agent_dependency_proof_invalid");
  }
  return proof;
}

export function writeDependencyReceipt(
  dependencyProof,
  outcome,
  createdAt = new Date().toISOString(),
) {
  if (
    !["dependencies_verified", "accepted"].includes(outcome) ||
    !SHA256_PATTERN.test(dependencyProof.rootLockSha256) ||
    !SHA256_PATTERN.test(dependencyProof.installedTreeSha256)
  ) {
    throw new Error("agent_dependency_receipt_invalid");
  }
  writePrivateJson(receiptPath, {
    schemaVersion: 1,
    contractVersion,
    outcome,
    createdAt,
    dependencyProof,
  });
}
