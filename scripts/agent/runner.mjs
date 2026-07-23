import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
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
import { terminateProcessTree } from "./process-control.mjs";
import { validRunnerToken } from "./process-identity.mjs";

const MAX_PENDING_BYTES = 4 * 1024;
const WINDOWS_READINESS_STREAM_CAP = 768;
const WINDOWS_READINESS_PREAUTH_TIMEOUT_MS = 5_000;
const WINDOWS_READINESS_AUTHENTICATED_TIMEOUT_MS = 120_000;
const WINDOWS_READINESS_PIPE_PREFIX =
  "\\\\.\\pipe\\tokenmonster-agent-ready-";
const WINDOWS_READINESS_PIPE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const WINDOWS_READINESS_CAPABILITY_PATTERN = /^[0-9a-f]{64}$/u;
const WINDOWS_ELECTRON_CONNECTED_MARKER =
  "[TOKENMONSTER_AGENT] STATUS electron_connected";
export const WINDOWS_READINESS_PHASES = Object.freeze([
  "state",
  "window",
  "initialized",
  "shell",
  "credentials",
  "services",
  "bootstrap",
  "view",
  "ready-shell",
]);
export const WINDOWS_READINESS_FAILURES = Object.freeze([
  "gateway",
  "sidecar-invalid-configuration",
  "sidecar-runtime-not-found",
  "sidecar-version-mismatch",
  "sidecar-spawn-failed",
  "sidecar-startup-timeout",
  "sidecar-sidecar-exited",
  "sidecar-sidecar-unavailable",
  "sidecar-sidecar-incompatible",
  "sidecar-refresh-failed",
  "sidecar-refresh-timeout",
  "sidecar-unknown",
]);
const WINDOWS_READINESS_PHASE_MARKERS = Object.freeze({
  state: "[TOKENMONSTER_AGENT] STATUS companion_state",
  window: "[TOKENMONSTER_AGENT] STATUS companion_window",
  initialized:
    "[TOKENMONSTER_AGENT] STATUS companion_initialized",
  shell: "[TOKENMONSTER_AGENT] STATUS companion_shell",
  credentials:
    "[TOKENMONSTER_AGENT] STATUS companion_credentials",
  services: "[TOKENMONSTER_AGENT] STATUS companion_services",
  bootstrap:
    "[TOKENMONSTER_AGENT] STATUS companion_bootstrap",
  view: "[TOKENMONSTER_AGENT] STATUS companion_view",
  "ready-shell":
    "[TOKENMONSTER_AGENT] STATUS companion_ready_shell",
});
const WINDOWS_READINESS_FAILURE_MARKERS = Object.freeze({
  gateway: "[TOKENMONSTER_AGENT] ERROR companion_gateway",
  "sidecar-invalid-configuration":
    "[TOKENMONSTER_AGENT] ERROR companion_sidecar_invalid_configuration",
  "sidecar-runtime-not-found":
    "[TOKENMONSTER_AGENT] ERROR companion_sidecar_runtime_not_found",
  "sidecar-version-mismatch":
    "[TOKENMONSTER_AGENT] ERROR companion_sidecar_version_mismatch",
  "sidecar-spawn-failed":
    "[TOKENMONSTER_AGENT] ERROR companion_sidecar_spawn_failed",
  "sidecar-startup-timeout":
    "[TOKENMONSTER_AGENT] ERROR companion_sidecar_startup_timeout",
  "sidecar-sidecar-exited":
    "[TOKENMONSTER_AGENT] ERROR companion_sidecar_exited",
  "sidecar-sidecar-unavailable":
    "[TOKENMONSTER_AGENT] ERROR companion_sidecar_unavailable",
  "sidecar-sidecar-incompatible":
    "[TOKENMONSTER_AGENT] ERROR companion_sidecar_incompatible",
  "sidecar-refresh-failed":
    "[TOKENMONSTER_AGENT] ERROR companion_sidecar_refresh_failed",
  "sidecar-refresh-timeout":
    "[TOKENMONSTER_AGENT] ERROR companion_sidecar_refresh_timeout",
  "sidecar-unknown":
    "[TOKENMONSTER_AGENT] ERROR companion_sidecar_unknown",
});
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
  #expected;

  constructor(report, expected = readyMarker) {
    this.#report = report;
    this.#expected = Buffer.from(expected, "utf8");
  }

  #accept(line) {
    if (!this.#reported && line.equals(this.#expected)) {
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

export function createWindowsReadinessConfiguration(
  random = randomBytes,
) {
  const pipeId = random(16);
  const capability = random(32);
  if (
    !Buffer.isBuffer(pipeId) ||
    pipeId.length !== 16 ||
    !Buffer.isBuffer(capability) ||
    capability.length !== 32
  ) {
    throw new Error("agent_ready_channel_invalid");
  }
  const identifier = pipeId.toString("hex");
  const encodedCapability = capability.toString("hex");
  if (
    !WINDOWS_READINESS_PIPE_ID_PATTERN.test(identifier) ||
    !WINDOWS_READINESS_CAPABILITY_PATTERN.test(encodedCapability)
  ) {
    throw new Error("agent_ready_channel_invalid");
  }
  return Object.freeze({
    pipeId: identifier,
    pipePath: `${WINDOWS_READINESS_PIPE_PREFIX}${identifier}`,
    capability: encodedCapability,
  });
}

export function windowsPrivateHelloMarker(
  processId,
  capability,
) {
  if (
    !Number.isSafeInteger(processId) ||
    processId <= 0 ||
    processId > 2_147_483_647 ||
    typeof capability !== "string" ||
    !WINDOWS_READINESS_CAPABILITY_PATTERN.test(capability)
  ) {
    throw new Error("agent_ready_marker_invalid");
  }
  return (
    `[TOKENMONSTER_AGENT_PRIVATE] HELLO companion ` +
    `pid=${processId} cap=${capability}`
  );
}

export function windowsPrivatePhaseMarker(phase) {
  if (!WINDOWS_READINESS_PHASES.includes(phase)) {
    throw new Error("agent_ready_marker_invalid");
  }
  return `[TOKENMONSTER_AGENT_PRIVATE] PHASE ${phase}`;
}

export function windowsPrivateFailureMarker(failure) {
  if (!WINDOWS_READINESS_FAILURES.includes(failure)) {
    throw new Error("agent_ready_marker_invalid");
  }
  return `[TOKENMONSTER_AGENT_PRIVATE] FAILURE ${failure}`;
}

export class WindowsReadinessStreamGate {
  #authenticated = false;
  #closed = false;
  #expectedHello;
  #failureReceived = false;
  #onAuthenticated;
  #onFatal;
  #onPhase;
  #onReady;
  #onRejected;
  #onStartupFailure;
  #pending = Buffer.alloc(0);
  #phaseIndex = 0;
  #readyReceived = false;
  #totalBytes = 0;

  constructor(
    expectedHello,
    {
      onAuthenticated,
      onFatal,
      onPhase,
      onReady,
      onRejected,
      onStartupFailure,
    },
  ) {
    this.#expectedHello = Buffer.from(expectedHello, "utf8");
    this.#onAuthenticated = onAuthenticated;
    this.#onFatal = onFatal;
    this.#onPhase = onPhase;
    this.#onReady = onReady;
    this.#onRejected = onRejected;
    this.#onStartupFailure = onStartupFailure;
  }

  #terminate(kind) {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending = Buffer.alloc(0);
    if (kind === "fatal") this.#onFatal();
    else this.#onRejected();
  }

  #accept(line) {
    if (!this.#authenticated) {
      if (!line.equals(this.#expectedHello)) {
        this.#terminate("rejected");
        return;
      }
      this.#authenticated = true;
      if (this.#onAuthenticated() !== true) {
        this.#terminate("fatal");
      }
      return;
    }
    if (this.#readyReceived || this.#failureReceived) {
      this.#terminate("fatal");
      return;
    }
    const failure = WINDOWS_READINESS_FAILURES.find((candidate) =>
      line.equals(
        Buffer.from(windowsPrivateFailureMarker(candidate), "utf8"),
      ),
    );
    if (failure !== undefined) {
      if (this.#onStartupFailure(failure) !== true) {
        this.#terminate("fatal");
        return;
      }
      this.#failureReceived = true;
      return;
    }
    const phase = WINDOWS_READINESS_PHASES[this.#phaseIndex];
    if (phase !== undefined) {
      if (
        !line.equals(
          Buffer.from(windowsPrivatePhaseMarker(phase), "utf8"),
        ) ||
        this.#onPhase(phase) !== true
      ) {
        this.#terminate("fatal");
        return;
      }
      this.#phaseIndex += 1;
      return;
    }
    if (!line.equals(Buffer.from(readyMarker, "utf8"))) {
      this.#terminate("fatal");
      return;
    }
    this.#readyReceived = true;
  }

  push(chunk) {
    if (this.#closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length === 0) return;
    if (this.#readyReceived || this.#failureReceived) {
      this.#terminate("fatal");
      return;
    }
    this.#totalBytes += bytes.length;
    if (this.#totalBytes > WINDOWS_READINESS_STREAM_CAP) {
      this.#terminate(this.#authenticated ? "fatal" : "rejected");
      return;
    }
    this.#pending = Buffer.concat([this.#pending, bytes]);
    while (!this.#closed) {
      const newline = this.#pending.indexOf(0x0a);
      if (newline === -1) return;
      const line = this.#pending.subarray(0, newline);
      this.#pending = this.#pending.subarray(newline + 1);
      this.#accept(line);
      if (
        (this.#readyReceived || this.#failureReceived) &&
        this.#pending.length > 0
      ) {
        this.#terminate("fatal");
      }
    }
  }

  finish() {
    if (this.#closed) return;
    if (this.#failureReceived && this.#pending.length === 0) {
      this.#terminate("fatal");
      return;
    }
    if (
      !this.#authenticated ||
      !this.#readyReceived ||
      this.#pending.length !== 0
    ) {
      this.#terminate(this.#authenticated ? "fatal" : "rejected");
      return;
    }
    this.#closed = true;
    if (this.#onReady() !== true) this.#onFatal();
  }

  fail() {
    if (this.#closed) return;
    this.#terminate(this.#authenticated ? "fatal" : "rejected");
  }
}

function closeWindowsReadinessServer(controller) {
  controller?.close();
}

function listenWindowsReadinessServer(
  configuration,
  {
    getChild,
    onConnected,
    onFailure,
    onPhase,
    onReady,
    onStartupFailure,
  },
) {
  return new Promise((resolvePromise, reject) => {
    const sockets = new Set();
    let authenticatedSocket;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      try {
        server.close();
      } catch {
        // A startup error or prior close may already own server shutdown.
      }
    };
    const fail = () => {
      if (closed) return;
      close();
      onFailure();
    };
    const server = createServer(
      { allowHalfOpen: true, pauseOnConnect: false },
      (socket) => {
        const child = getChild();
        if (
          closed ||
          authenticatedSocket !== undefined ||
          child === undefined ||
          child.exitCode !== null ||
          child.signalCode !== null ||
          !Number.isSafeInteger(child.pid)
        ) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        let deadline;
        let ended = false;
        let gate;
        const armDeadline = (milliseconds) => {
          if (deadline !== undefined) clearTimeout(deadline);
          deadline = setTimeout(() => {
            gate.fail();
            socket.destroy();
          }, milliseconds);
          deadline.unref();
        };
        gate = new WindowsReadinessStreamGate(
          windowsPrivateHelloMarker(
            child.pid,
            configuration.capability,
          ),
          {
            onAuthenticated: () => {
              const currentChild = getChild();
              if (
                closed ||
                authenticatedSocket !== undefined ||
                currentChild !== child ||
                currentChild.pid !== child.pid ||
                child.exitCode !== null ||
                child.signalCode !== null
              ) {
                return false;
              }
              authenticatedSocket = socket;
              for (const candidate of sockets) {
                if (candidate !== socket) candidate.destroy();
              }
              try {
                server.close();
              } catch {
                return false;
              }
              armDeadline(
                WINDOWS_READINESS_AUTHENTICATED_TIMEOUT_MS,
              );
              return onConnected() === true;
            },
            onFatal: fail,
            onPhase,
            onReady: () => {
              const currentChild = getChild();
              if (
                closed ||
                authenticatedSocket !== socket ||
                currentChild !== child ||
                currentChild.pid !== child.pid ||
                child.exitCode !== null ||
                child.signalCode !== null
              ) {
                return false;
              }
              const reported = onReady() === true;
              if (reported) close();
              return reported;
            },
            onRejected: () => socket.destroy(),
            onStartupFailure,
          },
        );
        armDeadline(WINDOWS_READINESS_PREAUTH_TIMEOUT_MS);
        socket.on("data", (chunk) => gate.push(chunk));
        socket.once("end", () => {
          ended = true;
          gate.finish();
        });
        socket.once("error", () => gate.fail());
        socket.once("close", () => {
          if (deadline !== undefined) clearTimeout(deadline);
          sockets.delete(socket);
          if (!ended) gate.fail();
        });
      },
    );
    const controller = Object.freeze({ close });
    const startupFailure = (error) => {
      close();
      reject(error);
    };
    server.once("error", startupFailure);
    server.listen(
      {
        path: configuration.pipePath,
        exclusive: true,
        readableAll: false,
        writableAll: false,
      },
      () => {
        server.off("error", startupFailure);
        server.on("error", fail);
        resolvePromise(controller);
      },
    );
  });
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

async function runElectronChild(runtime, runnerToken) {
  let settled = false;
  let spawnFailed = false;
  let readyReported = false;
  let readinessCleanupStarted = false;
  let child;
  let windowsReadinessServer;
  const windowsReadiness =
    process.platform === "win32"
      ? createWindowsReadinessConfiguration()
      : undefined;
  let resolveOutcome;
  const outcome = new Promise((resolvePromise) => {
    resolveOutcome = resolvePromise;
  });
  const reportConnected = () =>
    safeAppendOwned(WINDOWS_ELECTRON_CONNECTED_MARKER, runnerToken);
  const reportPhase = (phase) => {
    const marker = WINDOWS_READINESS_PHASE_MARKERS[phase];
    return (
      typeof marker === "string" &&
      safeAppendOwned(marker, runnerToken)
    );
  };
  const reportStartupFailure = (failure) => {
    const marker = WINDOWS_READINESS_FAILURE_MARKERS[failure];
    return (
      typeof marker === "string" &&
      safeAppendOwned(marker, runnerToken)
    );
  };
  const reportReady = () => {
    readyReported = safeAppendOwned(readyMarker, runnerToken);
    return readyReported;
  };
  const readyGate = new ReadinessLineGate(reportReady);
  const markSpawnFailed = () => {
    if (spawnFailed) return;
    spawnFailed = true;
    safeAppendOwned(
      "[TOKENMONSTER_AGENT] ERROR electron_spawn_failed",
      runnerToken,
    );
  };
  const finish = (code, signal) => {
    if (settled) return;
    settled = true;
    readyGate.finish();
    closeWindowsReadinessServer(windowsReadinessServer);
    const marker = spawnFailed
      ? "[TOKENMONSTER_AGENT] EXIT code=1"
      : safeExitMarker(code, signal);
    resolveOutcome({
      exitCode:
        !spawnFailed && Number.isInteger(code) && code === 0 ? 0 : 1,
      terminalMarker: marker,
    });
  };
  const failReadinessChannel = () => {
    if (readyReported || readinessCleanupStarted) return;
    readinessCleanupStarted = true;
    markSpawnFailed();
    if (child === undefined) {
      finish(1, null);
      return;
    }
    const childPid = child.pid;
    void terminateProcessTree(
      childPid,
      () =>
        child.pid === childPid &&
        child.exitCode === null &&
        child.signalCode === null,
    )
      .then((stopped) => {
        if (stopped) finish(1, null);
      })
      .catch(() => undefined);
  };
  if (windowsReadiness !== undefined) {
    try {
      windowsReadinessServer =
        await listenWindowsReadinessServer(windowsReadiness, {
          getChild: () => child,
          onConnected: reportConnected,
          onFailure: failReadinessChannel,
          onPhase: reportPhase,
          onReady: reportReady,
          onStartupFailure: reportStartupFailure,
        });
    } catch {
      failReadinessChannel();
      return await outcome;
    }
  }
  try {
    child = spawn(
      runtime.executable,
      [".", "--tokenmonster-agent-launch"],
      {
        cwd: runtime.companionDirectory,
        env: projectSafeEnvironment(process.env, {
          agentLaunch: true,
          agentReadyCapability: windowsReadiness?.capability,
          agentReadyPipeId: windowsReadiness?.pipeId,
        }),
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: false,
      },
    );
  } catch {
    markSpawnFailed();
    finish(1, null);
    return await outcome;
  }
  child.once("error", markSpawnFailed);
  child.once("close", finish);
  child.stdout.on("data", (chunk) => {
    if (process.platform !== "win32") readyGate.push(chunk);
  });
  child.stderr.on("data", () => {
    // Drain and discard. stderr is never a readiness channel.
  });
  return await outcome;
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
    const outcome = await runElectronChild(runtime, runnerToken);
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
