import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  appendSafeLog,
  contractVersion,
  exactKeys,
  launchLockPath,
  privateFileExists,
  readPrivateJson,
  readSafeLog,
  readyMarker,
  statePath,
} from "./contract.mjs";
import { resolveElectronRuntime } from "./electron-runtime.mjs";
import { projectSafeEnvironment } from "./environment.mjs";
import { validRunnerToken } from "./process-identity.mjs";

const MAX_PENDING_BYTES = 4 * 1024;
const SAFE_SIGNALS = new Set([
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGKILL",
  "SIGPIPE",
  "SIGQUIT",
  "SIGSEGV",
  "SIGTERM",
  "SIGTRAP",
]);

export class ReadinessLineGate {
  #closed = false;
  #discarding = false;
  #pending = Buffer.alloc(0);
  #reported = false;
  #report;

  constructor(report) {
    this.#report = report;
  }

  #accept(line) {
    if (
      !this.#reported &&
      line.equals(Buffer.from(readyMarker, "utf8"))
    ) {
      this.#reported = true;
      this.#report();
    }
  }

  push(chunk) {
    if (this.#closed) return;
    let remaining = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (remaining.length > 0) {
      const newline = remaining.indexOf(0x0a);
      if (this.#discarding) {
        if (newline === -1) return;
        this.#discarding = false;
        remaining = remaining.subarray(newline + 1);
        continue;
      }
      if (newline === -1) {
        if (this.#pending.length + remaining.length > MAX_PENDING_BYTES) {
          this.#pending = Buffer.alloc(0);
          this.#discarding = true;
          return;
        }
        this.#pending = Buffer.concat([this.#pending, remaining]);
        return;
      }
      const fragment = remaining.subarray(0, newline);
      if (this.#pending.length + fragment.length <= MAX_PENDING_BYTES) {
        this.#accept(Buffer.concat([this.#pending, fragment]));
      }
      this.#pending = Buffer.alloc(0);
      remaining = remaining.subarray(newline + 1);
    }
  }

  finish() {
    this.#closed = true;
    this.#pending = Buffer.alloc(0);
  }
}

export function isAgentReadyMessage(value) {
  return (
    exactKeys(value, ["schemaVersion", "type"]) &&
    value.schemaVersion === 1 &&
    value.type === "tokenmonster_agent_ready"
  );
}

export class ReadinessMessageGate {
  #closed = false;
  #reported = false;
  #report;

  constructor(report) {
    this.#report = report;
  }

  push(message) {
    if (
      this.#closed ||
      this.#reported ||
      !isAgentReadyMessage(message)
    ) {
      return false;
    }
    this.#reported = true;
    this.#report();
    return true;
  }

  finish() {
    this.#closed = true;
  }
}

function safeExitMarker(code, signal) {
  if (
    Number.isInteger(code) &&
    code >= 0 &&
    code <= 255
  ) {
    return `[TOKENMONSTER_AGENT] EXIT code=${code}`;
  }
  if (typeof signal === "string" && SAFE_SIGNALS.has(signal)) {
    return `[TOKENMONSTER_AGENT] EXIT signal=${signal}`;
  }
  return "[TOKENMONSTER_AGENT] EXIT code=1";
}

function safeAppendOwned(marker, runnerToken) {
  try {
    const state = readPrivateJson(statePath);
    if (!committedState(state, runnerToken)) return false;
    appendSafeLog(marker);
    return true;
  } catch {
    return false;
  }
}

export function committedState(
  value,
  runnerToken,
  runnerPid = process.pid,
) {
  return (
    exactKeys(value, [
      "contractVersion",
      "pid",
      "runnerToken",
      "schemaVersion",
      "startedAt",
    ]) &&
    value.schemaVersion === 1 &&
    value.contractVersion === contractVersion &&
    value.pid === runnerPid &&
    value.runnerToken === runnerToken
  );
}

export async function runElectron(
  runnerToken = process.argv[2],
) {
  let committed = false;
  let terminalMarker = "[TOKENMONSTER_AGENT] EXIT code=1";
  try {
    committed = await waitForCommittedLaunch(runnerToken);
    if (!committed) return 1;
    let runtime;
    try {
      runtime = resolveElectronRuntime();
    } catch {
      safeAppendOwned(
        "[TOKENMONSTER_AGENT] ERROR electron_missing",
        runnerToken,
      );
      return 1;
    }
    const outcome = await new Promise((resolvePromise) => {
      let settled = false;
      let spawnFailed = false;
      let child;
      const reportReady = () => {
        safeAppendOwned(readyMarker, runnerToken);
      };
      const readyLineGate = new ReadinessLineGate(reportReady);
      const readyMessageGate = new ReadinessMessageGate(reportReady);
      const finish = (code, signal) => {
        if (settled) return;
        settled = true;
        readyLineGate.finish();
        readyMessageGate.finish();
        const marker = spawnFailed
          ? "[TOKENMONSTER_AGENT] EXIT code=1"
          : safeExitMarker(code, signal);
        resolvePromise({
          exitCode:
            !spawnFailed && Number.isInteger(code) && code === 0 ? 0 : 1,
          terminalMarker: marker,
        });
      };
      try {
        child = spawn(
          runtime.executable,
          [".", "--tokenmonster-agent-launch"],
          {
            cwd: runtime.companionDirectory,
            env: projectSafeEnvironment(process.env, {
              agentLaunch: true,
            }),
            shell: false,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            windowsHide: false,
          },
        );
      } catch {
        safeAppendOwned(
          "[TOKENMONSTER_AGENT] ERROR electron_spawn_failed",
          runnerToken,
        );
        resolvePromise({
          exitCode: 1,
          terminalMarker: "[TOKENMONSTER_AGENT] EXIT code=1",
        });
        return;
      }
      child.stdout.on("data", (chunk) => {
        if (process.platform !== "win32") readyLineGate.push(chunk);
      });
      child.stderr.on("data", () => {
        // Drain and discard. stderr is never a readiness channel.
      });
      child.on("message", (message) => {
        if (process.platform === "win32") {
          readyMessageGate.push(message);
        }
      });
      child.once("error", () => {
        spawnFailed = true;
        safeAppendOwned(
          "[TOKENMONSTER_AGENT] ERROR electron_spawn_failed",
          runnerToken,
        );
      });
      child.once("close", finish);
    });
    terminalMarker = outcome.terminalMarker;
    return outcome.exitCode;
  } catch {
    if (committed) {
      safeAppendOwned(
        "[TOKENMONSTER_AGENT] ERROR electron_spawn_failed",
        runnerToken,
      );
    }
    return 1;
  } finally {
    if (committed) {
      safeAppendOwned(terminalMarker, runnerToken);
    }
  }
}

async function waitForCommittedLaunch(runnerToken) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const state = readPrivateJson(statePath);
      const markers = readSafeLog();
      const lockPresent = privateFileExists(launchLockPath);
      if (
        committedState(state, runnerToken) &&
        markers.includes("[TOKENMONSTER_AGENT] STATUS accepted") &&
        !lockPresent
      ) {
        return true;
      }
    } catch {
      return false;
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 50);
    });
  }
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !validRunnerToken(args[0])) {
    process.exitCode = 2;
    return;
  }
  try {
    process.exitCode = await runElectron(args[0]);
  } catch {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
