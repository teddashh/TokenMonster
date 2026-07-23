import { fileURLToPath } from "node:url";

import { removePrivateFile, statePath } from "./contract.mjs";
import {
  acquireLaunchLock,
  assertLaunchLockOwned,
  releaseLaunchLock,
} from "./launch-lock.mjs";
import { emit, emitUsage } from "./output.mjs";
import {
  stoppedRuntimeCanBeCleared,
  terminateProcessTree,
} from "./process-control.mjs";
import {
  processMatchesRunner,
  processAlive,
} from "./process-identity.mjs";
import { inspectRuntime } from "./runtime-status.mjs";

function parseArguments(args) {
  if (args.some((argument) => argument !== "--json")) return undefined;
  if (args.filter((argument) => argument === "--json").length > 1) {
    return undefined;
  }
  return { json: args.includes("--json") };
}

async function stopWhileLocked(ownedLock) {
  assertLaunchLockOwned(ownedLock);
  const status = inspectRuntime();
  if (status.runtime.state === "not_started") {
    return {
      result: { ok: true, state: "not_started", action: "none" },
      exitCode: 0,
    };
  }
  if (
    status.runtime.state === "invalid_state" ||
    status.runtime.state === "foreign_process"
  ) {
    return {
      result: {
        ok: false,
        state: status.runtime.state,
        errorCode: "ownership_unverified",
      },
      exitCode: 1,
    };
  }
  const privateState = status.privateState;
  if (privateState === undefined) {
    return {
      result: {
        ok: false,
        state: "invalid_state",
        errorCode: "ownership_unverified",
      },
      exitCode: 1,
    };
  }
  if (!processAlive(privateState.pid)) {
    if (
      !stoppedRuntimeCanBeCleared(
        privateState.pid,
        status.markers,
      )
    ) {
      return {
        result: {
          ok: false,
          state: "failed",
          errorCode: "process_group_still_alive",
        },
        exitCode: 1,
      };
    }
    assertLaunchLockOwned(ownedLock);
    removePrivateFile(statePath);
    return {
      result: { ok: true, state: "stopped", action: "cleaned" },
      exitCode: 0,
    };
  }
  const verifyIdentity = () =>
    processMatchesRunner(
      privateState.pid,
      privateState.runnerToken,
    );
  if (!verifyIdentity()) {
    return {
      result: {
        ok: false,
        state: "foreign_process",
        errorCode: "ownership_unverified",
      },
      exitCode: 1,
    };
  }
  assertLaunchLockOwned(ownedLock);
  const stopped = await terminateProcessTree(
    privateState.pid,
    verifyIdentity,
  );
  if (!stopped) {
    return {
      result: {
        ok: false,
        state: "failed",
        errorCode: "stop_failed",
      },
      exitCode: 1,
    };
  }
  assertLaunchLockOwned(ownedLock);
  const current = inspectRuntime();
  if (
    current.privateState?.pid !== privateState.pid ||
    current.privateState?.runnerToken !== privateState.runnerToken ||
    processAlive(privateState.pid)
  ) {
    return {
      result: {
        ok: false,
        state: "invalid_state",
        errorCode: "state_changed",
      },
      exitCode: 1,
    };
  }
  assertLaunchLockOwned(ownedLock);
  removePrivateFile(statePath);
  return {
    result: { ok: true, state: "stopped", action: "terminated" },
    exitCode: 0,
  };
}

export async function stop() {
  const ownedLock = acquireLaunchLock();
  try {
    return await stopWhileLocked(ownedLock);
  } finally {
    releaseLaunchLock(ownedLock);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options === undefined) {
    process.exitCode = emitUsage("stop");
    return;
  }
  try {
    const outcome = await stop();
    emit("stop", outcome.result, options);
    process.exitCode = outcome.exitCode;
  } catch {
    emit(
      "stop",
      {
        ok: false,
        state: "failed",
        errorCode: "stop_failed",
      },
      options,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
