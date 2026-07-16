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
    });
    this.stderrEnded = this.observeStream(stderr, () => {
      this.stderrEnded = true;
    });
    utility.on("error", (error) => {
      this.emit(
        "error",
        error instanceof Error
          ? error
          : new Error("Electron utility process failed.")
      );
    });
    utility.once("exit", (code) => {
      if (this.exitObserved) return;
      this.exitObserved = true;
      this.observedExitCode = code;
      this.exitCode = code ?? 0;
      this.signalCode = null;
      this.emit("exit", code, null);
      this.emitCloseIfReady();
    });
  }

  public get pid(): number | undefined {
    return this.utility.pid;
  }

  public kill(_signal?: NodeJS.Signals | number): boolean {
    if (this.exitObserved) return false;
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
  fork: UtilityProcessFork
): TokenTrackerSpawn {
  return (command, arguments_, options) => {
    if (command !== UTILITY_PROCESS_COMMAND) {
      throw new Error("Unexpected TokenTracker utility-process command.");
    }
    const modulePath = arguments_[0];
    if (modulePath === undefined) {
      throw new Error("TokenTracker utility-process module path is missing.");
    }
    const args = arguments_.slice(1);
    const stdio: UtilityProcessStdio =
      options.stdio === "ignore"
        ? "ignore"
        : ["ignore", "pipe", "pipe"];
    const utility = fork(modulePath, args, {
      stdio,
      env: definedEnvironment(options.env),
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

export const utilityProcessSpawn: TokenTrackerSpawn = createUtilityProcessSpawn(
  (modulePath, args, options) => {
    const { utilityProcess } = electronApi();
    return utilityProcess.fork(modulePath, args, {
      stdio: options.stdio,
      env: options.env,
      serviceName: options.serviceName
    }) as unknown as UtilityProcessLike;
  }
);
