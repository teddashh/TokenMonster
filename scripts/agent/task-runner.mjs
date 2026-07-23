import { spawn, spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { rootDirectory } from "./contract.mjs";
import {
  npmCommandArgs,
  projectSafeEnvironment,
  resolveNpmInvocation,
} from "./environment.mjs";
import { resolveElectronInstaller } from "./electron-runtime.mjs";
import { acknowledgeAbandonedLaunchTask } from "./launch-lock.mjs";
import {
  processAlive,
  processMatchesExactWindowsInvocation,
  validRunnerToken,
} from "./process-identity.mjs";

const TASKS = new Set([
  "dependency_install",
  "electron_install",
  "build",
]);
const PROCESS_SNAPSHOT_CAP = 64 * 1024;
const QUIESCENCE_TIMEOUT_MS = 60_000;
const QUIESCENCE_POLL_MS = 50;
const QUIESCENCE_STABLE_PROBES = 3;

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function fixedTaskkill() {
  const systemRoot = process.env.SystemRoot;
  if (
    typeof systemRoot !== "string" ||
    !/^[A-Za-z]:\\Windows$/iu.test(systemRoot)
  ) {
    return undefined;
  }
  const candidate = join(systemRoot, "System32", "taskkill.exe");
  try {
    const metadata = lstatSync(candidate);
    return metadata.isSymbolicLink() || !metadata.isFile()
      ? undefined
      : candidate;
  } catch {
    return undefined;
  }
}

function fixedPowerShell() {
  const systemRoot = process.env.SystemRoot;
  if (
    typeof systemRoot !== "string" ||
    !/^[A-Za-z]:\\Windows$/iu.test(systemRoot)
  ) {
    return undefined;
  }
  const candidate = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    const metadata = lstatSync(candidate);
    return metadata.isSymbolicLink() || !metadata.isFile()
      ? undefined
      : candidate;
  } catch {
    return undefined;
  }
}

function fixedPosixPs() {
  for (const candidate of ["/bin/ps", "/usr/bin/ps"]) {
    try {
      const metadata = lstatSync(candidate);
      if (!metadata.isSymbolicLink() && metadata.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next fixed operating-system location.
    }
  }
  return undefined;
}

function verifiedWindowsTaskWrapperPath() {
  const candidate = join(
    rootDirectory,
    "scripts",
    "agent",
    "windows-task-tree.ps1",
  );
  const metadata = lstatSync(candidate);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("agent_windows_task_wrapper_invalid");
  }
  return candidate;
}

export function quoteWindowsArgument(value) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("agent_windows_argument_invalid");
  }
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === "\\") {
      slashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += `${"\\".repeat(slashes * 2 + 1)}"`;
      slashes = 0;
      continue;
    }
    quoted += `${"\\".repeat(slashes)}${character}`;
    slashes = 0;
  }
  return `${quoted}${"\\".repeat(slashes * 2)}"`;
}

function windowsTaskCommand(command) {
  const powerShell = fixedPowerShell();
  if (powerShell === undefined) return undefined;
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      command: command.command,
      argumentLine: command.args.map(quoteWindowsArgument).join(" "),
      workingDirectory: rootDirectory,
    }),
    "utf8",
  ).toString("base64");
  return {
    command: powerShell,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      verifiedWindowsTaskWrapperPath(),
      "-Payload",
      payload,
    ],
    environment: command.environment,
  };
}

export function parseProcessGroupSnapshot(
  contents,
  { processGroupId, runnerPid, probePid },
) {
  if (
    typeof contents !== "string" ||
    Buffer.byteLength(contents) > PROCESS_SNAPSHOT_CAP
  ) {
    return undefined;
  }
  const rows = contents.trim() === "" ? [] : contents.trim().split("\n");
  let runnerSeen = false;
  let busy = false;
  for (const row of rows) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(row);
    if (match === null) return undefined;
    const pid = Number(match[1]);
    const group = Number(match[2]);
    const state = match[3];
    if (
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(group) ||
      group !== processGroupId
    ) {
      return undefined;
    }
    if (pid === runnerPid) runnerSeen = true;
    if (
      pid !== runnerPid &&
      pid !== probePid &&
      !state.startsWith("Z")
    ) {
      busy = true;
    }
  }
  return runnerSeen ? !busy : undefined;
}

function processGroupQuiescent() {
  const command = fixedPosixPs();
  if (command === undefined) return undefined;
  const result = spawnSync(
    command,
    [
      "-o",
      "pid=,pgid=,stat=",
      "-g",
      String(process.pid),
    ],
    {
      encoding: "utf8",
      env: projectSafeEnvironment(process.env, { gui: false }),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: PROCESS_SNAPSHOT_CAP,
    },
  );
  if (
    result.status !== 0 ||
    result.signal !== null ||
    result.error !== undefined ||
    !Number.isSafeInteger(result.pid)
  ) {
    return undefined;
  }
  return parseProcessGroupSnapshot(String(result.stdout ?? ""), {
    processGroupId: process.pid,
    runnerPid: process.pid,
    probePid: result.pid,
  });
}

async function waitForProcessGroupQuiescence() {
  if (!["linux", "darwin"].includes(process.platform)) return false;
  const deadline = Date.now() + QUIESCENCE_TIMEOUT_MS;
  let stable = 0;
  while (Date.now() < deadline) {
    const quiet = processGroupQuiescent();
    if (quiet === undefined) return false;
    stable = quiet ? stable + 1 : 0;
    if (stable >= QUIESCENCE_STABLE_PROBES) return true;
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, QUIESCENCE_POLL_MS);
    });
  }
  return false;
}

export function taskkillResultSucceeded(result) {
  return (
    result !== undefined &&
    result.status === 0 &&
    result.signal === null &&
    result.error === undefined
  );
}

function killOwnProcessTree() {
  if (process.platform === "win32") {
    const taskkill = fixedTaskkill();
    if (taskkill === undefined) return false;
    const result = spawnSync(
      taskkill,
      ["/pid", String(process.pid), "/t", "/f"],
      {
        env: projectSafeEnvironment(process.env, { gui: false }),
        stdio: "ignore",
        timeout: 15_000,
        windowsHide: true,
      },
    );
    if (!taskkillResultSucceeded(result)) return false;
    process.exit(1);
  }
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.exit(1);
  }
}

function runWindowsTaskkill(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const taskkill = fixedTaskkill();
  if (taskkill === undefined) return false;
  return spawnSync(
    taskkill,
    ["/pid", String(pid), "/t", "/f"],
    {
      env: projectSafeEnvironment(process.env, { gui: false }),
      stdio: "ignore",
      timeout: 15_000,
      windowsHide: true,
    },
  );
}

export function terminateVerifiedWindowsChildTree(
  child,
  identity,
  {
    matchesInvocation = processMatchesExactWindowsInvocation,
    runTaskkill = runWindowsTaskkill,
    alive = processAlive,
  } = {},
) {
  if (
    !Number.isSafeInteger(child?.pid) ||
    child.pid <= 0 ||
    child.exitCode !== null ||
    child.signalCode !== null ||
    typeof identity?.executablePath !== "string" ||
    !Array.isArray(identity?.argv) ||
    !matchesInvocation(
      child.pid,
      identity.executablePath,
      identity.argv,
    ) ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return false;
  }
  const result = runTaskkill(child.pid);
  return taskkillResultSucceeded(result) && !alive(child.pid);
}

export function installParentDisconnectWatchdog({
  channel = process,
  killTree = killOwnProcessTree,
} = {}) {
  let armed = channel.connected === true;
  let cleanupStarted = false;
  let retry;
  const attemptCleanup = () => {
    if (!armed) return;
    cleanupStarted = true;
    if (killTree() === false) {
      retry = setTimeout(attemptCleanup, 250);
      return;
    }
    armed = false;
  };
  const onDisconnect = () => {
    if (!armed) return;
    attemptCleanup();
  };
  if (armed) channel.once("disconnect", onDisconnect);
  return {
    get armed() {
      return armed;
    },
    get cleanupStarted() {
      return cleanupStarted;
    },
    trigger() {
      attemptCleanup();
    },
    disarm() {
      if (!armed) return;
      armed = false;
      if (retry !== undefined) clearTimeout(retry);
      channel.removeListener("disconnect", onDisconnect);
    },
  };
}

function taskCommand(task) {
  if (task === "dependency_install") {
    const invocation = resolveNpmInvocation();
    if (invocation === undefined) return undefined;
    return {
      ...npmCommandArgs(invocation, [
        "ci",
        "--no-audit",
        "--no-fund",
        "--logs-max=0",
      ]),
      environment: projectSafeEnvironment(process.env, {
        gui: false,
        npm: true,
      }),
    };
  }
  if (task === "electron_install") {
    return {
      command: process.execPath,
      args: [resolveElectronInstaller()],
      environment: projectSafeEnvironment(process.env, {
        gui: false,
      }),
    };
  }
  if (task === "build") {
    return {
      command: process.execPath,
      args: [
        join(rootDirectory, "scripts", "run-workspaces.mjs"),
        "build",
        "@tokenmonster/companion",
      ],
      environment: projectSafeEnvironment(process.env, {
        gui: false,
        npm: true,
      }),
    };
  }
  return undefined;
}

export async function runTask(task, lifecycle = {}) {
  const requested = taskCommand(task);
  if (requested === undefined) return 1;
  const command =
    process.platform === "win32"
      ? windowsTaskCommand(requested)
      : requested;
  if (command === undefined) return 1;
  return await new Promise((resolvePromise) => {
    let settled = false;
    let spawnFailed = false;
    const child = spawn(command.command, command.args, {
      cwd: rootDirectory,
      env: command.environment,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    const identity = Object.freeze({
      executablePath: command.command,
      argv: Object.freeze([command.command, ...command.args]),
    });
    lifecycle.onSpawn?.(child, identity);
    child.once("error", () => {
      spawnFailed = true;
    });
    child.once("close", async (code) => {
      if (settled) return;
      settled = true;
      const quiet =
        process.platform === "win32"
          ? true
          : await waitForProcessGroupQuiescence();
      lifecycle.onClose?.(child, quiet);
      resolvePromise(!spawnFailed && code === 0 && quiet ? 0 : 1);
    });
  });
}

export function sendTaskResult(
  runnerToken,
  task,
  result,
  channel = process,
) {
  return new Promise((resolvePromise) => {
    if (
      !validRunnerToken(runnerToken) ||
      !TASKS.has(task) ||
      !["succeeded", "failed"].includes(result) ||
      channel.connected !== true ||
      typeof channel.send !== "function"
    ) {
      resolvePromise(false);
      return;
    }
    try {
      channel.send(
        { type: "task_result", runnerToken, task, result },
        (error) => resolvePromise(error == null),
      );
    } catch {
      resolvePromise(false);
    }
  });
}

function waitForAuthorization(runnerToken, task) {
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      process.removeListener("message", onMessage);
      resolvePromise(false);
    }, 10_000);
    const onMessage = (message) => {
      if (
        exactKeys(message, ["runnerToken", "task", "type"]) &&
        message.type === "authorize" &&
        message.runnerToken === runnerToken &&
        message.task === task
      ) {
        clearTimeout(timeout);
        process.removeListener("message", onMessage);
        resolvePromise(true);
      }
    };
    process.on("message", onMessage);
  });
}

export function createWindowsAbandonedTaskCleanup(
  activeTask,
  {
    terminateChildTree = terminateVerifiedWindowsChildTree,
    acknowledge = acknowledgeAbandonedLaunchTask,
    exit = (code) => process.exit(code),
  } = {},
) {
  let activeChild;
  let activeIdentity;
  let childTreeProvenEmpty = true;
  let terminationRequested = false;
  return Object.freeze({
    onSpawn(child, identity) {
      if (
        Number.isSafeInteger(child?.pid) &&
        child.pid > 0 &&
        typeof identity?.executablePath === "string" &&
        Array.isArray(identity?.argv)
      ) {
        activeChild = child;
        activeIdentity = identity;
        childTreeProvenEmpty = false;
        terminationRequested = false;
      }
    },
    onClose(child, quiet) {
      if (activeChild === child && quiet) {
        activeChild = undefined;
        activeIdentity = undefined;
        childTreeProvenEmpty = true;
        terminationRequested = false;
      }
    },
    cleanup() {
      if (activeChild !== undefined) {
        if (
          activeChild.exitCode !== null ||
          activeChild.signalCode !== null ||
          activeIdentity === undefined ||
          terminationRequested ||
          !terminateChildTree(activeChild, activeIdentity)
        ) {
          return false;
        }
        terminationRequested = true;
        return false;
      }
      if (!childTreeProvenEmpty) return false;
      const acknowledgement = acknowledge(activeTask);
      if (
        acknowledgement !== "acknowledged" &&
        acknowledgement !== "already_absent"
      ) {
        return false;
      }
      exit(1);
      return true;
    },
  });
}

async function main() {
  const [runnerToken, task, ...rest] = process.argv.slice(2);
  if (
    rest.length > 0 ||
    !validRunnerToken(runnerToken) ||
    !TASKS.has(task)
  ) {
    process.exitCode = 2;
    return;
  }
  if (process.connected !== true) {
    process.exitCode = 1;
    return;
  }
  const activeTask = {
    pid: process.pid,
    runnerToken,
    task,
  };
  const windowsCleanup = createWindowsAbandonedTaskCleanup(activeTask);
  const watchdog = installParentDisconnectWatchdog({
    killTree:
      process.platform === "win32"
        ? windowsCleanup.cleanup
        : killOwnProcessTree,
  });
  const authorized = await waitForAuthorization(runnerToken, task);
  if (!authorized) {
    watchdog.trigger();
    return;
  }
  let result;
  try {
    result =
      (await runTask(task, {
        onSpawn(child, identity) {
          windowsCleanup.onSpawn(child, identity);
        },
        onClose(child, quiet) {
          windowsCleanup.onClose(child, quiet);
        },
      })) === 0
        ? "succeeded"
        : "failed";
  } catch {
    result = "failed";
  }
  if (!(await sendTaskResult(runnerToken, task, result))) {
    watchdog.trigger();
  }
  await new Promise(() => {
    // The launcher terminates this owned process group after task_result.
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
