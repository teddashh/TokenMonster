import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";

import { rootDirectory } from "./contract.mjs";
import { projectSafeEnvironment } from "./environment.mjs";
import { terminateProcessTree } from "./process-control.mjs";

const TASKS = new Set([
  "dependency_install",
  "electron_install",
  "build",
]);

function verifiedTaskRunnerPath() {
  const relativePath = join(
    "scripts",
    "agent",
    "task-runner.mjs",
  );
  const metadata = lstatSync(join(rootDirectory, relativePath));
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("agent_task_runner_invalid");
  }
  return relativePath;
}

function spawnTask(task, runnerToken) {
  return spawn(
    process.execPath,
    [verifiedTaskRunnerPath(), runnerToken, task],
    {
      cwd: rootDirectory,
      detached: true,
      env: projectSafeEnvironment(process.env, { gui: false }),
      shell: false,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    },
  );
}

export async function runOwnedTask(
  task,
  timeoutMs,
  dependencies = {},
) {
  if (!TASKS.has(task)) throw new Error("agent_task_invalid");
  const runnerToken = randomUUID();
  const createChild = dependencies.spawnTask ?? spawnTask;
  const terminate = dependencies.terminate ?? terminateProcessTree;
  const child = createChild(task, runnerToken);
  const matches =
    dependencies.matches ??
    ((pid) =>
      child.pid === pid &&
      child.exitCode === null &&
      child.signalCode === null);
  const activeTask = {
    pid: child.pid,
    runnerToken,
    task,
  };
  return await new Promise((resolvePromise) => {
    let settled = false;
    let finishing = false;
    let activeRegistered = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const cleanupOwnedTree = async () => {
      const pid = child.pid;
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        return !activeRegistered;
      }
      return (
        await terminate(pid, () => matches(pid))
      );
    };
    const finishAfterCleanup = async (cleanResult, failedResult) => {
      if (settled || finishing) return;
      finishing = true;
      let cleaned = false;
      try {
        cleaned = await cleanupOwnedTree();
        if (cleaned && activeRegistered) {
          dependencies.onCleaned?.(activeTask);
        }
      } catch {
        cleaned = false;
      }
      settle(cleaned ? cleanResult : failedResult);
    };
    const timer = setTimeout(async () => {
      await finishAfterCleanup("timeout", "timeout_cleanup_failed");
    }, timeoutMs);
    child.once("error", () => {
      void finishAfterCleanup("failed", "cleanup_failed");
    });
    child.once("exit", () => {
      void finishAfterCleanup("failed", "cleanup_failed");
    });
    child.on("message", (message) => {
      if (
        message !== null &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        JSON.stringify(Object.keys(message).sort()) ===
          JSON.stringify(["result", "runnerToken", "task", "type"]) &&
        message.type === "task_result" &&
        message.runnerToken === runnerToken &&
        message.task === task &&
        ["succeeded", "failed"].includes(message.result)
      ) {
        void finishAfterCleanup(message.result, "cleanup_failed");
      }
    });
    child.once("spawn", () => {
      try {
        dependencies.onSpawn?.(activeTask);
        activeRegistered = true;
        child.send(
          { type: "authorize", runnerToken, task },
          (error) => {
            if (error != null) {
              void finishAfterCleanup("failed", "cleanup_failed");
            }
          },
        );
      } catch {
        void finishAfterCleanup("failed", "cleanup_failed");
      }
    });
  });
}
