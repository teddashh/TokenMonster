#!/usr/bin/env node

// @ts-check

import { spawn, spawnSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve, win32 } from "node:path";

const SMOKE_TIMEOUT_MS = 180_000;
const FORCE_CLOSE_GRACE_MS = 15_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const WINDOWS_SMOKE_EXIT_CODES = Object.freeze({
  ok: 86,
  gateway: 87,
  sidecar: 88,
});
const WINDOWS_SIDECAR_FAILURE_EXIT_CODES = new Map([
  [89, "invalid-configuration"],
  [90, "runtime-not-found"],
  [91, "version-mismatch"],
  [92, "spawn-failed"],
  [93, "startup-timeout"],
  [94, "sidecar-exited"],
  [95, "sidecar-unavailable"],
  [96, "sidecar-incompatible"],
  [97, "refresh-failed"],
  [98, "refresh-timeout"],
]);
const [inputPath, ...extraArguments] = process.argv.slice(2);

if (
  typeof inputPath !== "string" ||
  inputPath.length < 1 ||
  extraArguments.length !== 0
) {
  throw new Error("Usage: smoke-companion-executable.mjs <executable-path>");
}

const requestedPath = resolve(inputPath);
const requestedMetadata = await lstat(requestedPath);
if (requestedMetadata.isSymbolicLink()) {
  throw new Error("Packaged companion smoke target must not be a symlink.");
}
const executablePath = await realpath(requestedPath);
const sameExecutablePath =
  process.platform === "win32"
    ? requestedPath.toLocaleLowerCase("en-US") ===
      executablePath.toLocaleLowerCase("en-US")
    : requestedPath === executablePath;
if (!sameExecutablePath) {
  throw new Error("Packaged companion smoke path must not traverse a symlink.");
}
const metadata = await lstat(executablePath);
if (!metadata.isFile() || metadata.isSymbolicLink()) {
  throw new Error("Packaged companion smoke target must be a physical file.");
}

/** @type {string | undefined} */
let taskkillPath;
if (process.platform === "win32") {
  const systemRoot = process.env["SystemRoot"]?.replace(/[\\/]+$/u, "");
  if (
    typeof systemRoot !== "string" ||
    !/^[A-Za-z]:\\Windows$/iu.test(systemRoot)
  ) {
    throw new Error("Packaged companion smoke requires a canonical SystemRoot.");
  }
  const requestedTaskkillPath = win32.join(
    systemRoot,
    "System32",
    "taskkill.exe",
  );
  const taskkillMetadata = await lstat(requestedTaskkillPath);
  const physicalTaskkillPath = await realpath(requestedTaskkillPath);
  if (
    !taskkillMetadata.isFile() ||
    taskkillMetadata.isSymbolicLink() ||
    requestedTaskkillPath.toLocaleLowerCase("en-US") !==
      physicalTaskkillPath.toLocaleLowerCase("en-US")
  ) {
    throw new Error("Packaged companion smoke requires physical taskkill.exe.");
  }
  taskkillPath = physicalTaskkillPath;
}

/** @param {import("node:child_process").ChildProcess} child */
function forceKillProcessTree(child) {
  const pid = child.pid;
  if (pid !== undefined && process.platform === "win32") {
    if (taskkillPath !== undefined) {
      spawnSync(taskkillPath, ["/pid", String(pid), "/t", "/f"], {
        shell: false,
        stdio: "ignore",
        timeout: FORCE_CLOSE_GRACE_MS,
        windowsHide: true,
      });
    }
  } else if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The direct process may already have exited while a descendant still
      // holds a pipe. Destroying the pipes below still bounds this verifier.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The hard close deadline below remains authoritative if killing fails.
  }
}

/** @type {{ closed: boolean; code: number | null; failure: "output" | "spawn" | "stream" | "timeout" | null; signal: NodeJS.Signals | null; stderr: string; stdout: string }} */
const result = await new Promise((resolvePromise, reject) => {
  const child = spawn(executablePath, ["--tokenmonster-smoke"], {
    detached: true,
    env: { ...process.env, TOKENMONSTER_SMOKE: "1" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  /** @type {Buffer[]} */
  const stdoutChunks = [];
  /** @type {Buffer[]} */
  const stderrChunks = [];
  let capturedBytes = 0;
  /** @type {"output" | "spawn" | "stream" | "timeout" | null} */
  let failure = null;
  let settled = false;
  /** @type {NodeJS.Timeout | undefined} */
  let closeGrace;

  /**
   * @param {boolean} closed
   * @param {number | null} code
   * @param {NodeJS.Signals | null} signal
   */
  const finish = (closed, code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (closeGrace !== undefined) clearTimeout(closeGrace);
    resolvePromise({
      closed,
      code,
      failure,
      signal,
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    });
  };

  /** @param {"output" | "stream" | "timeout"} reason */
  const abort = (reason) => {
    if (failure !== null) return;
    failure = reason;
    closeGrace = setTimeout(
      () => finish(false, child.exitCode, child.signalCode),
      FORCE_CLOSE_GRACE_MS,
    );
    forceKillProcessTree(child);
    child.stdout.destroy();
    child.stderr.destroy();
  };

  const timeout = setTimeout(() => {
    abort("timeout");
  }, SMOKE_TIMEOUT_MS);

  /**
   * @param {import("node:stream").Readable} stream
   * @param {Buffer[]} target
   */
  const capture = (stream, target) => {
    stream.on("data", (/** @type {Buffer} */ chunk) => {
      if (failure !== null) return;
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        abort("output");
        return;
      }
      target.push(chunk);
    });
    stream.once("error", () => abort("stream"));
  };
  capture(child.stdout, stdoutChunks);
  capture(child.stderr, stderrChunks);

  child.once("error", () => {
    const failedToSpawn = failure === null;
    if (failedToSpawn) failure = "spawn";
    child.stdout.destroy();
    child.stderr.destroy();
    if (failedToSpawn) finish(false, child.exitCode, child.signalCode);
  });
  child.once("close", (code, signal) => {
    finish(true, code, signal);
  });
}).catch(() => {
  throw new Error("Packaged companion startup smoke could not be started.");
});

if (result.failure === "timeout") {
  throw new Error("Packaged companion startup smoke exceeded its time bound.");
}
if (result.failure === "output") {
  throw new Error("Packaged companion startup smoke exceeded its output bound.");
}
if (result.failure === "spawn") {
  throw new Error("Packaged companion startup smoke could not be started.");
}
if (result.failure === "stream" || !result.closed) {
  throw new Error("Packaged companion startup smoke did not close cleanly.");
}
const expectedExitCode =
  process.platform === "win32" ? WINDOWS_SMOKE_EXIT_CODES.ok : 0;
if (result.code !== expectedExitCode || result.signal !== null) {
  if (process.platform === "win32" && result.signal === null) {
    if (result.code === WINDOWS_SMOKE_EXIT_CODES.gateway) {
      throw new Error(
        "Packaged companion startup smoke reported a gateway failure.",
      );
    }
    if (result.code === WINDOWS_SMOKE_EXIT_CODES.sidecar) {
      throw new Error(
        "Packaged companion startup smoke reported a sidecar failure.",
      );
    }
    const sidecarFailure = WINDOWS_SIDECAR_FAILURE_EXIT_CODES.get(
      result.code ?? -1,
    );
    if (sidecarFailure !== undefined) {
      throw new Error(
        `Packaged companion startup smoke reported sidecar ${sidecarFailure}.`,
      );
    }
  }
  throw new Error("Packaged companion startup smoke exited unsuccessfully.");
}
if (process.platform !== "win32") {
  const stdoutLines = result.stdout.split(/\r?\n/u);
  if (
    stdoutLines.filter((line) => line === "TOKENMONSTER_SMOKE_OK").length !== 1
  ) {
    throw new Error("Packaged companion startup smoke did not emit its marker.");
  }
}
if (`${result.stdout}\n${result.stderr}`.includes("TOKENMONSTER_SMOKE_FAIL:")) {
  throw new Error("Packaged companion startup smoke emitted a failure marker.");
}

process.stdout.write("Verified packaged companion startup smoke.\n");
