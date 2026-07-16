import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";
import { type Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  resolveTokenTrackerEntry,
  type TokenTrackerExecutable,
  type TokenTrackerSpawn
} from "@tokenmonster/token-tracker-runtime";

export const UTILITY_PROCESS_COMMAND = "electron:utility-process";

// Local-stderr lifecycle tracing for the sidecar process facade. The packaged
// app's failure page hides all detail by design, so without this a field
// report of "sidecar 無法啟動" is undiagnosable.
const SIDECAR_DEBUG = process.env["TOKENMONSTER_SIDECAR_DEBUG"] === "1";

function debugLog(message: string): void {
  if (SIDECAR_DEBUG) process.stderr.write(`[sidecar] ${message}\n`);
}

type UtilityProcessStdio = ["ignore", "pipe", "pipe"] | "ignore";

interface UtilityProcessForkOptions {
  readonly stdio: UtilityProcessStdio;
  readonly env: Record<string, string>;
  readonly serviceName: "tokentracker-sidecar";
}

export interface UtilityProcessLike {
  readonly pid: number | undefined;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(): boolean;
  on(event: "error", listener: (error: unknown) => void): this;
  on(event: "spawn", listener: () => void): this;
  once(event: "exit", listener: (code: number | null) => void): this;
}

export type UtilityProcessFork = (
  modulePath: string,
  args: string[],
  options: UtilityProcessForkOptions
) => UtilityProcessLike;

class UtilityChildProcess extends EventEmitter {
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public readonly stdout: Readable | null;
  public readonly stderr: Readable | null;

  private exitObserved = false;
  private closeEmitted = false;
  private observedExitCode: number | null = null;
  private stdoutEnded: boolean;
  private stderrEnded: boolean;

  public constructor(
    private readonly utility: UtilityProcessLike,
    stdout: Readable | null,
    stderr: Readable | null
  ) {
    super();
    this.stdout = stdout;
    this.stderr = stderr;
    this.stdoutEnded = this.observeStream(stdout, () => {
      this.stdoutEnded = true;
      debugLog("stdout ended");
    });
    this.stderrEnded = this.observeStream(stderr, () => {
      this.stderrEnded = true;
      debugLog("stderr ended");
    });
    if (SIDECAR_DEBUG) {
      utility.on("spawn", () => debugLog(`spawned pid=${this.pid}`));
      stdout?.on("data", (chunk: Buffer) =>
        debugLog(`stdout: ${JSON.stringify(chunk.toString("utf8"))}`)
      );
      stderr?.on("data", (chunk: Buffer) =>
        debugLog(`stderr: ${JSON.stringify(chunk.toString("utf8"))}`)
      );
    }
    utility.on("error", (error) => {
      debugLog(`error: ${String(error)}`);
      this.emit(
        "error",
        error instanceof Error
          ? error
          : new Error("Electron utility process failed.")
      );
    });
    utility.once("exit", (code) => {
      debugLog(`exit code=${String(code)}`);
      if (this.exitObserved) return;
      this.exitObserved = true;
      // Electron reports null when the utility process dies abnormally, and
      // the facade cannot recover the signal. Reporting success (0) would let
      // the runtime misclassify a crash as a clean exit, so map unknown to 1.
      const normalized = typeof code === "number" ? code : 1;
      this.observedExitCode = normalized;
      this.exitCode = normalized;
      this.signalCode = null;
      this.emit("exit", normalized, null);
      this.emitCloseIfReady();
      // Electron's utilityProcess stdout/stderr never signal EOF after the
      // child exits — no 'end'/'close' on the parent-side streams, and even
      // destroy() emits nothing (observed on Electron 43/linux). Waiting on
      // those events would leave 'close' unemitted forever. The shim flushes
      // before exiting and chunks were observed to arrive before the exit
      // event, so give in-flight data one turn to deliver, then complete the
      // state machine directly instead of trusting foreign stream events.
      setImmediate(() => {
        for (const stream of [this.stdout, this.stderr]) {
          if (stream !== null && !stream.destroyed) stream.destroy();
        }
        if (!this.stdoutEnded || !this.stderrEnded) {
          debugLog("force-releasing streams after exit");
          this.stdoutEnded = true;
          this.stderrEnded = true;
          this.emitCloseIfReady();
        }
      });
    });
  }

  public get pid(): number | undefined {
    return this.utility.pid;
  }

  public kill(signal?: NodeJS.Signals | number): boolean {
    debugLog(`kill signal=${String(signal)} exited=${this.exitObserved}`);
    if (this.exitObserved) return false;
    // Electron's utility.kill() is a graceful request. The runtime escalates
    // SIGTERM → SIGKILL for wedged children; that escalation must bypass the
    // graceful path or a hung sidecar survives both bounded shutdown waits.
    if (signal === "SIGKILL") {
      const pid = this.utility.pid;
      if (typeof pid === "number") {
        try {
          process.kill(pid, "SIGKILL");
          return true;
        } catch {
          return this.utility.kill();
        }
      }
    }
    return this.utility.kill();
  }

  private observeStream(
    stream: Readable | null,
    markEnded: () => void
  ): boolean {
    if (stream === null || stream.readableEnded || stream.closed) return true;
    let completed = false;
    const complete = (): void => {
      if (completed) return;
      completed = true;
      stream.off("end", complete);
      stream.off("close", complete);
      markEnded();
      this.emitCloseIfReady();
    };
    stream.once("end", complete);
    stream.once("close", complete);
    return false;
  }

  private emitCloseIfReady(): void {
    if (
      !this.exitObserved ||
      this.closeEmitted ||
      !this.stdoutEnded ||
      !this.stderrEnded
    ) {
      return;
    }
    this.closeEmitted = true;
    this.emit("close", this.observedExitCode, null);
  }
}

export function createUtilityChildProcess(
  utilityLike: UtilityProcessLike,
  stdoutOrNull: Readable | null,
  stderrOrNull: Readable | null
): ChildProcess {
  return new UtilityChildProcess(
    utilityLike,
    stdoutOrNull,
    stderrOrNull
  ) as unknown as ChildProcess;
}

function definedEnvironment(
  source: Readonly<NodeJS.ProcessEnv>
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export function createUtilityProcessSpawn(
  fork: UtilityProcessFork,
  resolveShimPath: () => string
): TokenTrackerSpawn {
  return (command, arguments_, options) => {
    if (command !== UTILITY_PROCESS_COMMAND) {
      throw new Error("Unexpected TokenTracker utility-process command.");
    }
    const modulePath = arguments_[0];
    if (modulePath === undefined) {
      throw new Error("TokenTracker utility-process module path is missing.");
    }
    // Fork the shim rather than the CLI bin: Electron utility processes never
    // drain their event loop, so run-to-completion commands would hang until
    // the runtime's timeout kills them. The shim exits when run() settles.
    const args = [modulePath, ...arguments_.slice(1)];
    const stdio: UtilityProcessStdio =
      options.stdio === "ignore"
        ? "ignore"
        : ["ignore", "pipe", "pipe"];
    const environment = definedEnvironment(options.env);
    if (SIDECAR_DEBUG) environment["TOKENMONSTER_SIDECAR_DEBUG"] = "1";
    const shimPath = resolveShimPath();
    debugLog(`fork ${shimPath} args=${JSON.stringify(args)} stdio=${JSON.stringify(stdio)}`);
    const utility = fork(shimPath, args, {
      stdio,
      env: environment,
      serviceName: "tokentracker-sidecar"
    });
    return createUtilityChildProcess(
      utility,
      stdio === "ignore" ? null : utility.stdout,
      stdio === "ignore" ? null : utility.stderr
    );
  };
}

function electronApi(): typeof import("electron") {
  return createRequire(import.meta.url)("electron") as typeof import("electron");
}

export async function resolveSidecarExecutable(): Promise<TokenTrackerExecutable> {
  const { app } = electronApi();
  const manifestPath = app.isPackaged
    ? join(
        process.resourcesPath,
        "sidecar",
        "node_modules",
        "tokentracker-cli",
        "package.json"
      )
    : createRequire(
        pathToFileURL(join(app.getAppPath(), "package.json")).href
      ).resolve("tokentracker-cli/package.json");
  const entry = await resolveTokenTrackerEntry(manifestPath);
  return Object.freeze({
    command: UTILITY_PROCESS_COMMAND,
    argumentPrefix: Object.freeze([entry])
  });
}

export function resolveSidecarShimPath(): string {
  const { app } = electronApi();
  return join(app.getAppPath(), "dist", "main", "main", "sidecar-shim.cjs");
}

export const utilityProcessSpawn: TokenTrackerSpawn = createUtilityProcessSpawn(
  (modulePath, args, options) => {
    const { utilityProcess } = electronApi();
    return utilityProcess.fork(modulePath, args, {
      stdio: options.stdio,
      env: options.env,
      serviceName: options.serviceName
    }) as unknown as UtilityProcessLike;
  },
  resolveSidecarShimPath
);
