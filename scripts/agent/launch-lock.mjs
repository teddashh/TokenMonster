import { randomUUID } from "node:crypto";
import { linkSync, renameSync } from "node:fs";

import {
  contractVersion,
  createExclusivePrivateJson,
  exactKeys,
  launchLockPath,
  readPrivateJson,
  removePrivateFile,
  writePrivateJson,
} from "./contract.mjs";
import {
  processAlive,
  processMatchesTaskRunner,
  validProcessId,
  validRunnerToken,
} from "./process-identity.mjs";
import { processGroupAlive } from "./process-control.mjs";

const LOCK_KEYS = [
  "contractVersion",
  "createdAt",
  "activeTask",
  "ownerToken",
  "pid",
  "schemaVersion",
];
const TASK_KEYS = ["pid", "runnerToken", "task"];

function parseActiveTask(value) {
  if (value === null) return null;
  if (
    !exactKeys(value, TASK_KEYS) ||
    !validProcessId(value.pid) ||
    !validRunnerToken(value.runnerToken) ||
    !["dependency_install", "electron_install", "build"].includes(value.task)
  ) {
    throw new Error("agent_launch_lock_invalid");
  }
  return value;
}

function parseLock(value) {
  if (
    !exactKeys(value, LOCK_KEYS) ||
    value.schemaVersion !== 1 ||
    value.contractVersion !== contractVersion ||
    !validProcessId(value.pid) ||
    !validRunnerToken(value.ownerToken) ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(new Date(value.createdAt).valueOf())
  ) {
    throw new Error("agent_launch_lock_invalid");
  }
  parseActiveTask(value.activeTask);
  return value;
}

function createLock(value) {
  createExclusivePrivateJson(launchLockPath, value);
}

function sameLock(left, right) {
  return (
    left.pid === right.pid &&
    left.ownerToken === right.ownerToken &&
    left.createdAt === right.createdAt &&
    JSON.stringify(left.activeTask) === JSON.stringify(right.activeTask)
  );
}

function sameActiveTask(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function restoreMovedLock(quarantinePath) {
  try {
    linkSync(quarantinePath, launchLockPath);
    removePrivateFile(quarantinePath);
  } catch {
    throw new Error("agent_launch_lock_changed");
  }
}

function reclaimDeadLock(observed, replacement) {
  const quarantinePath = `${launchLockPath}.stale-${randomUUID()}`;
  try {
    renameSync(launchLockPath, quarantinePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error("agent_launch_locked");
    }
    try {
      createLock(replacement);
      return replacement;
    } catch (createError) {
      if (createError?.code === "EEXIST") {
        throw new Error("agent_launch_locked");
      }
      throw createError;
    }
  }
  let moved;
  try {
    moved = parseLock(readPrivateJson(quarantinePath));
  } catch {
    restoreMovedLock(quarantinePath);
    throw new Error("agent_launch_lock_changed");
  }
  if (!sameLock(moved, observed) || processAlive(moved.pid)) {
    restoreMovedLock(quarantinePath);
    throw new Error("agent_launch_locked");
  }
  removePrivateFile(quarantinePath);
  try {
    createLock(replacement);
    return replacement;
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("agent_launch_locked");
    }
    throw error;
  }
}

export function acquireLaunchLock() {
  const value = {
    schemaVersion: 1,
    contractVersion,
    pid: process.pid,
    ownerToken: randomUUID(),
    activeTask: null,
    createdAt: new Date().toISOString(),
  };
  try {
    createLock(value);
    return value;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const existing = parseLock(readPrivateJson(launchLockPath));
  if (processAlive(existing.pid)) {
    throw new Error("agent_launch_locked");
  }
  if (existing.activeTask !== null) {
    if (processAlive(existing.activeTask.pid)) {
      if (
        !processMatchesTaskRunner(
          existing.activeTask.pid,
          existing.activeTask.runnerToken,
        )
      ) {
        throw new Error("agent_launch_lock_changed");
      }
      throw new Error("agent_launch_locked");
    }
    if (
      process.platform === "win32" ||
      processGroupAlive(existing.activeTask.pid)
    ) {
      throw new Error("agent_launch_locked");
    }
  }
  return reclaimDeadLock(existing, value);
}

export function releaseLaunchLock(ownedLock) {
  const current = assertLaunchLockOwned(ownedLock);
  if (current.activeTask !== null) {
    throw new Error("agent_launch_lock_changed");
  }
  removePrivateFile(launchLockPath);
}

export function assertLaunchLockOwned(ownedLock) {
  const current = parseLock(readPrivateJson(launchLockPath));
  if (
    current.pid !== ownedLock.pid ||
    current.ownerToken !== ownedLock.ownerToken
  ) {
    throw new Error("agent_launch_lock_changed");
  }
  return current;
}

export function setLaunchLockActiveTask(
  ownedLock,
  activeTask,
  expectedCurrent = null,
) {
  const current = assertLaunchLockOwned(ownedLock);
  const parsedTask = parseActiveTask(activeTask);
  const parsedExpected = parseActiveTask(expectedCurrent);
  if (
    (parsedTask === null &&
      (parsedExpected === null ||
        !sameActiveTask(current.activeTask, parsedExpected))) ||
    (parsedTask !== null && current.activeTask !== null)
  ) {
    throw new Error("agent_launch_lock_changed");
  }
  writePrivateJson(launchLockPath, {
    ...current,
    activeTask: parsedTask,
  });
  const updated = assertLaunchLockOwned(ownedLock);
  if (!sameActiveTask(updated.activeTask, parsedTask)) {
    throw new Error("agent_launch_lock_changed");
  }
}

export function acknowledgeAbandonedLaunchTask(
  activeTask,
  dependencies = {},
) {
  const platform = dependencies.platform ?? process.platform;
  const selfPid = dependencies.selfPid ?? process.pid;
  const matchesTaskRunner =
    dependencies.matchesTaskRunner ?? processMatchesTaskRunner;
  const ownerAlive = dependencies.ownerAlive ?? processAlive;
  const readLock =
    dependencies.readLock ??
    (() => readPrivateJson(launchLockPath));
  const writeLock =
    dependencies.writeLock ??
    ((value) => writePrivateJson(launchLockPath, value));
  if (platform !== "win32") return "retry";
  let parsedTask;
  try {
    parsedTask = parseActiveTask(activeTask);
  } catch {
    return "retry";
  }
  if (
    parsedTask === null ||
    parsedTask.pid !== selfPid ||
    !matchesTaskRunner(
      parsedTask.pid,
      parsedTask.runnerToken,
    )
  ) {
    return "retry";
  }
  let current;
  try {
    const candidate = readLock();
    if (candidate === undefined) return "already_absent";
    current = parseLock(candidate);
  } catch {
    return "retry";
  }
  if (!sameActiveTask(current.activeTask, parsedTask)) {
    return "already_absent";
  }
  if (ownerAlive(current.pid)) return "retry";
  try {
    writeLock({
      ...current,
      activeTask: null,
    });
    const candidate = readLock();
    if (candidate === undefined) return "retry";
    const updated = parseLock(candidate);
    return sameLock(
      { ...current, activeTask: null },
      updated,
    ) && updated.activeTask === null
      ? "acknowledged"
      : "retry";
  } catch {
    return "retry";
  }
}
