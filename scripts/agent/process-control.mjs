import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";

import { projectSafeEnvironment } from "./environment.mjs";
import { processAlive, validProcessId } from "./process-identity.mjs";

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

function wait(milliseconds) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

export async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await wait(100);
  }
  return !processAlive(pid);
}

export function processGroupAlive(
  processGroupId,
  kill = process.kill.bind(process),
) {
  if (!validProcessId(processGroupId)) return false;
  try {
    kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function waitForProcessGroupExit(
  processGroupId,
  timeoutMs = 5_000,
  groupAlive = processGroupAlive,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupAlive(processGroupId)) return true;
    await wait(100);
  }
  return !groupAlive(processGroupId);
}

export function deadProcessTreeAbsent(
  pid,
  {
    platform = process.platform,
    alive = processAlive,
    groupAlive = processGroupAlive,
  } = {},
) {
  if (!validProcessId(pid) || alive(pid)) return false;
  if (platform === "win32") return false;
  return !groupAlive(pid);
}

const TERMINAL_MARKER =
  /^\[TOKENMONSTER_AGENT\] EXIT (?:code=(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])|signal=(?:SIGABRT|SIGBUS|SIGFPE|SIGHUP|SIGILL|SIGINT|SIGKILL|SIGPIPE|SIGQUIT|SIGSEGV|SIGTERM|SIGTRAP))$/u;

export function stoppedRuntimeCanBeCleared(
  pid,
  markers,
  {
    platform = process.platform,
    alive = processAlive,
    groupAlive = processGroupAlive,
  } = {},
) {
  if (!validProcessId(pid) || alive(pid)) return false;
  if (platform === "win32") {
    return (
      Array.isArray(markers) &&
      markers.length > 0 &&
      TERMINAL_MARKER.test(markers.at(-1))
    );
  }
  return deadProcessTreeAbsent(pid, {
    platform,
    alive,
    groupAlive,
  });
}

export function taskkillSucceeded(result) {
  return (
    result !== undefined &&
    result.status === 0 &&
    result.signal === null &&
    result.error === undefined
  );
}

export async function terminateProcessTree(
  pid,
  verifyIdentity,
  dependencies = {},
) {
  const alive = dependencies.alive ?? processAlive;
  const kill = dependencies.kill ?? process.kill.bind(process);
  const waitForExit =
    dependencies.waitForExit ?? waitForProcessExit;
  const groupAlive =
    dependencies.groupAlive ??
    ((processGroupId) => processGroupAlive(processGroupId, kill));
  const waitForGroupExit =
    dependencies.waitForGroupExit ??
    ((processGroupId, timeoutMs) =>
      waitForProcessGroupExit(
        processGroupId,
        timeoutMs,
        groupAlive,
      ));
  const platform = dependencies.platform ?? process.platform;
  if (
    !validProcessId(pid) ||
    pid === process.pid ||
    typeof verifyIdentity !== "function"
  ) {
    return false;
  }
  if (!alive(pid)) {
    return deadProcessTreeAbsent(pid, {
      platform,
      alive,
      groupAlive,
    });
  }
  if (!verifyIdentity()) return false;
  if (platform === "win32") {
    const taskkill = fixedTaskkill();
    if (taskkill === undefined) return false;
    const runTaskkill = dependencies.runTaskkill ?? spawnSync;
    const result = runTaskkill(
      taskkill,
      ["/pid", String(pid), "/t", "/f"],
      {
        env: projectSafeEnvironment(process.env, { gui: false }),
        stdio: "ignore",
        timeout: 15_000,
        windowsHide: true,
      },
    );
    if (!taskkillSucceeded(result)) return false;
    return await waitForExit(pid);
  }
  try {
    kill(-pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") return false;
  }
  if (await waitForGroupExit(pid, 3_000)) return true;
  if (!groupAlive(pid)) return true;
  if (alive(pid) && !verifyIdentity()) return false;
  try {
    kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") return false;
  }
  return await waitForGroupExit(pid, 2_000);
}
