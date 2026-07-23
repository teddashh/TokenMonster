import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendSafeLog,
  contractVersion,
  removePrivateFile,
  resetSafeLog,
  rootDirectory,
  statePath,
  writePrivateJson,
} from "./contract.mjs";
import {
  dependencyPlan,
  inspectInstallTarget,
  invalidateDependencyReceipt,
  verifyInstalledDependencies,
  writeDependencyReceipt,
} from "./dependency-proof.mjs";
import { resolveElectronRuntime } from "./electron-runtime.mjs";
import {
  collectEnvironmentChecks,
  projectSafeEnvironment,
  resolveNpmInvocation,
} from "./environment.mjs";
import {
  acquireLaunchLock,
  assertLaunchLockOwned,
  releaseLaunchLock,
  setLaunchLockActiveTask,
} from "./launch-lock.mjs";
import { emit, emitUsage } from "./output.mjs";
import { runOwnedTask } from "./owned-task.mjs";
import {
  stoppedRuntimeCanBeCleared,
  terminateProcessTree,
} from "./process-control.mjs";
import {
  validRunnerToken,
} from "./process-identity.mjs";
import { inspectRuntime } from "./runtime-status.mjs";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const CHILD_TIMEOUT_MS = 20 * 60 * 1_000;

export function parseLaunchArguments(args) {
  let json = false;
  let dryRun = false;
  let wait = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let timeoutSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json" && !json) {
      json = true;
    } else if (argument === "--dry-run" && !dryRun) {
      dryRun = true;
    } else if (argument === "--wait" && !wait) {
      wait = true;
    } else if (
      argument === "--timeout-ms" &&
      !timeoutSeen &&
      index + 1 < args.length &&
      /^\d+$/u.test(args[index + 1])
    ) {
      timeoutMs = Number(args[index + 1]);
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < MIN_TIMEOUT_MS ||
        timeoutMs > MAX_TIMEOUT_MS
      ) {
        return undefined;
      }
      timeoutSeen = true;
      index += 1;
    } else {
      return undefined;
    }
  }
  if ((dryRun && wait) || (timeoutSeen && !wait)) return undefined;
  return { json, dryRun, wait, timeoutMs };
}

function fixedFailureCode(error) {
  const value = error?.message;
  if (value === "agent_launch_locked") return "launch_locked";
  if (
    value === "agent_launch_lock_invalid" ||
    value === "agent_launch_lock_changed"
  ) {
    return "launch_lock_invalid";
  }
  if (
    typeof value === "string" &&
    (value.startsWith("agent_runtime_") ||
      value.startsWith("agent_log_"))
  ) {
    return "runtime_state_invalid";
  }
  if (value === "agent_dependency_install_failed") {
    return "dependency_install_failed";
  }
  if (value === "agent_electron_install_failed") {
    return "electron_install_failed";
  }
  if (
    typeof value === "string" &&
    value.startsWith("agent_dependency_")
  ) {
    return "dependency_verification_failed";
  }
  if (value === "agent_root_lock_missing") {
    return "dependency_verification_failed";
  }
  if (
    typeof value === "string" &&
    value.startsWith("agent_electron_")
  ) {
    return "electron_missing";
  }
  if (value === "agent_npm_missing") return "npm_missing";
  if (value === "agent_build_failed") return "build_failed";
  if (value === "agent_process_start_failed") {
    return "process_start_failed";
  }
  if (value === "agent_state_write_failed") {
    return "state_write_failed";
  }
  return "launch_failed";
}

function ownedTaskCallbacks(ownedLock) {
  return {
    onSpawn(activeTask) {
      assertLaunchLockOwned(ownedLock);
      setLaunchLockActiveTask(ownedLock, activeTask);
    },
    onCleaned(activeTask) {
      assertLaunchLockOwned(ownedLock);
      setLaunchLockActiveTask(ownedLock, null, activeTask);
    },
  };
}

async function runLockedDependencies(
  expectedRootLockSha256,
  ownedLock,
) {
  inspectInstallTarget();
  invalidateDependencyReceipt();
  if (resolveNpmInvocation() === undefined) {
    throw new Error("agent_npm_missing");
  }
  const result = await runOwnedTask(
    "dependency_install",
    CHILD_TIMEOUT_MS,
    ownedTaskCallbacks(ownedLock),
  );
  if (result !== "succeeded") {
    throw new Error("agent_dependency_install_failed");
  }
  return verifyInstalledDependencies(expectedRootLockSha256);
}

async function buildCompanion(ownedLock) {
  const result = await runOwnedTask(
    "build",
    CHILD_TIMEOUT_MS,
    ownedTaskCallbacks(ownedLock),
  );
  if (result !== "succeeded") throw new Error("agent_build_failed");
  const artifact = lstatSync(
    join(
      rootDirectory,
      "apps",
      "companion",
      "dist",
      "main",
      "main",
      "main.js",
    ),
  );
  if (artifact.isSymbolicLink() || !artifact.isFile()) {
    throw new Error("agent_build_failed");
  }
}

function electronRuntimeAvailable() {
  try {
    resolveElectronRuntime();
    return true;
  } catch {
    return false;
  }
}

async function installElectronRuntime(ownedLock) {
  const result = await runOwnedTask(
    "electron_install",
    CHILD_TIMEOUT_MS,
    ownedTaskCallbacks(ownedLock),
  );
  if (result !== "succeeded") {
    throw new Error("agent_electron_install_failed");
  }
  try {
    resolveElectronRuntime();
  } catch {
    throw new Error("agent_electron_install_failed");
  }
}

function verifiedRunnerPath() {
  const relativePath = join("scripts", "agent", "runner.mjs");
  const metadata = lstatSync(join(rootDirectory, relativePath));
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("agent_process_start_failed");
  }
  return relativePath;
}

async function startRunner(runnerToken) {
  if (!validRunnerToken(runnerToken)) {
    throw new Error("agent_process_start_failed");
  }
  const child = spawn(
    process.execPath,
    [verifiedRunnerPath(), runnerToken],
    {
      cwd: rootDirectory,
      detached: true,
      env: projectSafeEnvironment(process.env, { gui: true }),
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  await new Promise((resolvePromise, reject) => {
    let spawned = false;
    child.on("error", () => {
      if (!spawned) reject(new Error("agent_process_start_failed"));
    });
    child.once("spawn", () => {
      spawned = true;
      resolvePromise();
    });
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw new Error("agent_process_start_failed");
  }
  return child;
}

function activeRuntimeResult(status) {
  if (status.runtime.state === "ready") {
    return {
      ok: true,
      state: "ready",
      action: "already_running",
      pid: status.runtime.pid,
    };
  }
  if (status.runtime.state === "building") {
    return {
      ok: true,
      state: "building",
      action: "already_running",
      pid: status.runtime.pid,
    };
  }
  return undefined;
}

function assertLaunchableRuntime(status) {
  if (
    status.runtime.state === "invalid_state" ||
    status.runtime.state === "foreign_process"
  ) {
    throw new Error("agent_runtime_state_invalid");
  }
}

function sameRuntimeState(actual, expected) {
  return (
    actual !== undefined &&
    actual.pid === expected.pid &&
    actual.runnerToken === expected.runnerToken &&
    actual.startedAt === expected.startedAt
  );
}

async function waitForReady(timeoutMs, expectedState) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = inspectRuntime();
    if (!sameRuntimeState(status.privateState, expectedState)) {
      return {
        ok: false,
        state: "invalid_state",
        errorCode: "state_changed",
      };
    }
    if (status.runtime.state === "ready") {
      return {
        ok: true,
        state: "ready",
        action: "launched",
        pid: status.runtime.pid,
      };
    }
    if (
      ["failed", "exited", "invalid_state", "foreign_process"].includes(
        status.runtime.state,
      )
    ) {
      return {
        ok: false,
        state: status.runtime.state,
        errorCode: "readiness_failed",
      };
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 200);
    });
  }
  return {
    ok: false,
    state: "building",
    errorCode: "readiness_timeout",
  };
}

export async function launch(options) {
  const checks = collectEnvironmentChecks();
  if (!checks.every((check) => check.ok)) {
    return {
      result: {
        ok: false,
        state: "failed",
        errorCode: "prerequisites_failed",
        checks,
      },
      exitCode: 1,
    };
  }
  const initialStatus = inspectRuntime();
  assertLaunchableRuntime(initialStatus);
  const active = activeRuntimeResult(initialStatus);
  if (active !== undefined) {
    if (options.wait && active.state !== "ready") {
      const result = await waitForReady(
        options.timeoutMs,
        initialStatus.privateState,
      );
      return {
        result,
        exitCode:
          result.ok ? 0 : result.errorCode === "readiness_timeout" ? 3 : 1,
      };
    }
    return { result: active, exitCode: 0 };
  }
  const preflightPlan = dependencyPlan();
  const preflightElectronInstallRequired = !electronRuntimeAvailable();
  if (options.dryRun) {
    return {
      result: {
        ok: true,
        state: "planned",
        action: "dry_run",
        dependencyInstall: preflightPlan.installRequired
          ? "required"
          : "verified",
        electronInstall: preflightElectronInstallRequired
          ? "required"
          : "verified",
        steps: [
          ...(preflightPlan.installRequired
            ? ["dependency_install"]
            : []),
          ...(preflightElectronInstallRequired
            ? ["electron_install"]
            : []),
          "build",
          "launch",
        ],
        checks,
      },
      exitCode: 0,
    };
  }

  const ownedLock = acquireLaunchLock();
  let runnerPid;
  let runnerToken;
  let runnerChild;
  let expectedState;
  let launched = false;
  let lockReleased = false;
  let stateWritten = false;
  const cleanupRunner = async () => {
    if (runnerPid === undefined || runnerToken === undefined) return;
    const stopped = await terminateProcessTree(
      runnerPid,
      () =>
        runnerChild?.pid === runnerPid &&
        runnerChild.exitCode === null &&
        runnerChild.signalCode === null,
    );
    if (!stopped) throw new Error("agent_process_cleanup_failed");
    if (stateWritten) {
      const current = inspectRuntime();
      if (!sameRuntimeState(current.privateState, expectedState)) {
        throw new Error("agent_runtime_state_changed");
      }
      removePrivateFile(statePath);
      stateWritten = false;
    }
  };
  try {
    assertLaunchLockOwned(ownedLock);
    const lockedStatus = inspectRuntime();
    assertLaunchableRuntime(lockedStatus);
    const lockedActive = activeRuntimeResult(lockedStatus);
    if (lockedActive !== undefined) {
      if (options.wait && lockedActive.state !== "ready") {
        releaseLaunchLock(ownedLock);
        lockReleased = true;
        const result = await waitForReady(
          options.timeoutMs,
          lockedStatus.privateState,
        );
        return {
          result,
          exitCode:
            result.ok
              ? 0
              : result.errorCode === "readiness_timeout"
                ? 3
                : 1,
        };
      }
      return { result: lockedActive, exitCode: 0 };
    }
    if (lockedStatus.privateState !== undefined) {
      if (
        !stoppedRuntimeCanBeCleared(
          lockedStatus.privateState.pid,
          lockedStatus.markers,
        )
      ) {
        throw new Error("agent_runtime_state_invalid");
      }
      removePrivateFile(statePath);
    }
    resetSafeLog();

    const lockedPlan = dependencyPlan();
    let proof = lockedPlan.current;
    let dependencyStateChanged = false;
    if (lockedPlan.installRequired) {
      assertLaunchLockOwned(ownedLock);
      appendSafeLog(
        "[TOKENMONSTER_AGENT] STATUS dependency_install",
      );
      try {
        proof = await runLockedDependencies(
          lockedPlan.current.rootLockSha256,
          ownedLock,
        );
      } catch (error) {
        appendSafeLog(
          "[TOKENMONSTER_AGENT] ERROR dependency_install_failed",
        );
        throw error;
      }
      assertLaunchLockOwned(ownedLock);
      dependencyStateChanged = true;
    }

    if (!electronRuntimeAvailable()) {
      assertLaunchLockOwned(ownedLock);
      appendSafeLog(
        "[TOKENMONSTER_AGENT] STATUS electron_install",
      );
      try {
        await installElectronRuntime(ownedLock);
      } catch (error) {
        invalidateDependencyReceipt();
        appendSafeLog(
          "[TOKENMONSTER_AGENT] ERROR electron_install_failed",
        );
        throw error;
      }
      assertLaunchLockOwned(ownedLock);
      dependencyStateChanged = true;
    }
    if (dependencyStateChanged) {
      proof = verifyInstalledDependencies(proof.rootLockSha256);
      writeDependencyReceipt(proof, "dependencies_verified");
    }

    assertLaunchLockOwned(ownedLock);
    appendSafeLog("[TOKENMONSTER_AGENT] STATUS build");
    try {
      await buildCompanion(ownedLock);
    } catch (error) {
      invalidateDependencyReceipt();
      appendSafeLog("[TOKENMONSTER_AGENT] ERROR build_failed");
      throw error;
    }

    assertLaunchLockOwned(ownedLock);
    const finalProof = verifyInstalledDependencies(
      proof.rootLockSha256,
    );
    if (
      finalProof.installedTreeSha256 !==
      proof.installedTreeSha256
    ) {
      throw new Error("agent_dependency_proof_invalid");
    }
    try {
      resolveElectronRuntime();
    } catch (error) {
      appendSafeLog("[TOKENMONSTER_AGENT] ERROR electron_missing");
      throw error;
    }
    appendSafeLog("[TOKENMONSTER_AGENT] STATUS electron_start");
    assertLaunchLockOwned(ownedLock);
    runnerToken = randomUUID();
    try {
      runnerChild = await startRunner(runnerToken);
    } catch (error) {
      appendSafeLog(
        "[TOKENMONSTER_AGENT] ERROR process_start_failed",
      );
      throw error;
    }
    runnerPid = runnerChild.pid;
    assertLaunchLockOwned(ownedLock);
    const startedAt = new Date().toISOString();
    expectedState = {
      pid: runnerPid,
      runnerToken,
      startedAt,
    };
    try {
      writePrivateJson(statePath, {
        schemaVersion: 1,
        contractVersion,
        pid: runnerPid,
        runnerToken,
        startedAt,
      });
      stateWritten = true;
      writeDependencyReceipt(proof, "accepted", startedAt);
    } catch {
      appendSafeLog("[TOKENMONSTER_AGENT] ERROR state_write_failed");
      throw new Error("agent_state_write_failed");
    }
    assertLaunchLockOwned(ownedLock);
    appendSafeLog("[TOKENMONSTER_AGENT] STATUS accepted");
    launched = true;
  } finally {
    if (!launched) {
      await cleanupRunner();
    }
    if (!lockReleased) {
      try {
        releaseLaunchLock(ownedLock);
      } catch {
        if (launched) await cleanupRunner();
        throw new Error("agent_launch_lock_changed");
      }
    }
  }

  runnerChild?.unref();
  if (options.wait) {
    const result = await waitForReady(options.timeoutMs, expectedState);
    return {
      result,
      exitCode:
        result.ok ? 0 : result.errorCode === "readiness_timeout" ? 3 : 1,
    };
  }
  return {
    result: {
      ok: true,
      state: "building",
      action: "launched",
      pid: runnerPid,
    },
    exitCode: 0,
  };
}

async function main() {
  const options = parseLaunchArguments(process.argv.slice(2));
  if (options === undefined) {
    process.exitCode = emitUsage("launch");
    return;
  }
  try {
    const outcome = await launch(options);
    emit("launch", outcome.result, options);
    process.exitCode = outcome.exitCode;
  } catch (error) {
    emit(
      "launch",
      {
        ok: false,
        state: "failed",
        errorCode: fixedFailureCode(error),
      },
      options,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
