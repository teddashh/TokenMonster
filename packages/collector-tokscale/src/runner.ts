import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  TOKSCALE_STDERR_MAX_BYTES,
  TOKSCALE_STDOUT_MAX_BYTES,
  TOKSCALE_TIMEOUT_MS
} from "./constants.js";
import { CollectorTokscaleError } from "./errors.js";
import {
  Tier1ClientSchema,
  UtcDateSchema,
  buildSanitizedTokscaleEnv,
  buildTokscaleReportArgs,
  type Tier1Client
} from "./policy.js";
import {
  projectTokscaleJsonToIngestSnapshotV1,
  type ProjectionInput
} from "./projection.js";

const require = createRequire(import.meta.url);

export interface TokscaleProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly timeoutMs: number;
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
}

export interface TokscaleProcessResult {
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputTooLarge: boolean;
}

export type TokscaleProcessExecutor = (
  request: TokscaleProcessRequest
) => Promise<TokscaleProcessResult>;

export interface IsolatedSpawnInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

export interface RunTokscaleReportInput {
  readonly client: Tier1Client;
  readonly utcDate: string;
  readonly configDir: string;
}

export interface RunnerDependencies {
  readonly execute?: TokscaleProcessExecutor;
  readonly now?: () => Date;
  readonly parentEnv?: NodeJS.ProcessEnv;
  readonly binaryPath?: string;
}

export interface CollectTokscaleDailyInput extends ProjectionInput {
  readonly configDir: string;
}

const RunInputSchema = z.strictObject({
  client: Tier1ClientSchema,
  utcDate: UtcDateSchema,
  configDir: z.string()
});

const CollectInputSchema = z.strictObject({
  client: Tier1ClientSchema,
  utcDate: UtcDateSchema,
  configDir: z.string(),
  batchId: z.uuid(),
  generatedAt: z.string(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
});

function linuxLibcPackageSuffix(): "gnu" | "musl" {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: unknown } }
    | undefined;
  const header = report?.header;
  return typeof header?.glibcVersionRuntime === "string" ? "gnu" : "musl";
}

function pinnedBinaryPath(input: string): string {
  if (
    input.length < 1 ||
    input.length > 4_096 ||
    input.includes("\0") ||
    !isAbsolute(input)
  ) {
    throw new CollectorTokscaleError(
      "invalid-input",
      "The packaged Tokscale binary path is invalid."
    );
  }
  return input;
}

function platformPackageName(): string {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "@tokscale/cli-darwin-arm64";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "@tokscale/cli-darwin-x64";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "@tokscale/cli-linux-arm64-" + linuxLibcPackageSuffix();
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "@tokscale/cli-linux-x64-" + linuxLibcPackageSuffix();
  }
  if (process.platform === "win32" && process.arch === "arm64") {
    return "@tokscale/cli-win32-arm64-msvc";
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return "@tokscale/cli-win32-x64-msvc";
  }
  throw new CollectorTokscaleError(
    "unsupported-platform",
    "Tokscale 4.5.2 has no audited binary for this platform."
  );
}

export function resolveTokscaleBinaryPath(): string {
  try {
    const binaryPath = require.resolve(platformPackageName());
    if (!isAbsolute(binaryPath)) {
      throw new Error("Resolved binary path is not absolute.");
    }
    return binaryPath;
  } catch {
    throw new CollectorTokscaleError(
      "unsupported-platform",
      "The audited Tokscale 4.5.2 platform binary is unavailable."
    );
  }
}

type ExecutableExists = (path: string) => boolean;

/**
 * Build a shell-free, denied-egress invocation around the audited binary.
 * This helper is internal to the package; the public API never accepts a
 * command, sandbox profile, or platform override.
 */
export function buildIsolatedSpawnInvocation(
  request: TokscaleProcessRequest,
  platform: NodeJS.Platform = process.platform,
  executableExists: ExecutableExists = existsSync
): IsolatedSpawnInvocation {
  if (platform === "linux") {
    const bubblewrap = ["/usr/bin/bwrap", "/bin/bwrap"].find(
      executableExists
    );
    if (bubblewrap === undefined) {
      throw new CollectorTokscaleError(
        "network-isolation-unavailable",
        "Tokscale collection requires the audited Linux network sandbox."
      );
    }
    return Object.freeze({
      command: bubblewrap,
      args: Object.freeze([
        "--unshare-net",
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--",
        request.command,
        ...request.args
      ])
    });
  }

  if (platform === "darwin") {
    const sandboxExec = "/usr/bin/sandbox-exec";
    if (!executableExists(sandboxExec)) {
      throw new CollectorTokscaleError(
        "network-isolation-unavailable",
        "Tokscale collection requires the audited macOS network sandbox."
      );
    }
    return Object.freeze({
      command: sandboxExec,
      args: Object.freeze([
        "-p",
        "(version 1) (allow default) (deny network*)",
        request.command,
        ...request.args
      ])
    });
  }

  throw new CollectorTokscaleError(
    "network-isolation-unavailable",
    "This platform has no audited TokenMonster network-isolation adapter yet."
  );
}

export const executeTokscaleProcess: TokscaleProcessExecutor = (
  request
): Promise<TokscaleProcessResult> =>
  new Promise((resolve, reject) => {
    const invocation = buildIsolatedSpawnInvocation(request);
    const child = spawn(invocation.command, [...invocation.args], {
      env: request.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputTooLarge = false;
    let settled = false;

    const terminate = (): void => {
      child.kill("SIGKILL");
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.byteLength;
      if (stdoutBytes > request.stdoutMaxBytes) {
        outputTooLarge = true;
        terminate();
        return;
      }
      stdoutChunks.push(buffer);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > request.stderrMaxBytes) {
        outputTooLarge = true;
        terminate();
      }
    });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new CollectorTokscaleError(
          "process-failed",
          "The fixed Tokscale process could not be started."
        )
      );
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        exitCode,
        timedOut,
        outputTooLarge
      });
    });
  });

export async function runTokscaleDailyReport(
  input: RunTokscaleReportInput,
  dependencies: RunnerDependencies = {}
): Promise<string> {
  const parsed = RunInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CollectorTokscaleError(
      "invalid-input",
      "Tokscale runner input contains an unsafe or unknown field."
    );
  }

  const now = (dependencies.now ?? (() => new Date()))();
  const args = buildTokscaleReportArgs(
    parsed.data.client,
    parsed.data.utcDate,
    now
  );
  const env = buildSanitizedTokscaleEnv(
    dependencies.parentEnv ?? process.env,
    parsed.data.configDir
  );
  const request: TokscaleProcessRequest = {
    command:
      dependencies.binaryPath === undefined
        ? resolveTokscaleBinaryPath()
        : pinnedBinaryPath(dependencies.binaryPath),
    args,
    env,
    shell: false,
    timeoutMs: TOKSCALE_TIMEOUT_MS,
    stdoutMaxBytes: TOKSCALE_STDOUT_MAX_BYTES,
    stderrMaxBytes: TOKSCALE_STDERR_MAX_BYTES
  };

  const result = await (dependencies.execute ?? executeTokscaleProcess)(request);
  if (result.timedOut) {
    throw new CollectorTokscaleError(
      "process-timeout",
      "Tokscale exceeded the fixed execution timeout."
    );
  }
  if (
    result.outputTooLarge ||
    Buffer.byteLength(result.stdout) > TOKSCALE_STDOUT_MAX_BYTES
  ) {
    throw new CollectorTokscaleError(
      "output-too-large",
      "Tokscale output exceeded the fixed in-memory byte limit."
    );
  }
  if (result.exitCode !== 0) {
    throw new CollectorTokscaleError(
      "process-failed",
      "Tokscale exited unsuccessfully; raw process output was discarded."
    );
  }
  return result.stdout;
}

export async function collectTokscaleDailySnapshotWithDependencies(
  input: CollectTokscaleDailyInput,
  dependencies: RunnerDependencies = {}
) {
  const parsed = CollectInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CollectorTokscaleError(
      "invalid-input",
      "Collector input contains an unsafe or unknown field."
    );
  }

  const now = (dependencies.now ?? (() => new Date()))();
  const rawStdout = await runTokscaleDailyReport(
    {
      client: parsed.data.client,
      utcDate: parsed.data.utcDate,
      configDir: parsed.data.configDir
    },
    {
      ...dependencies,
      now: () => now
    }
  );

  return projectTokscaleJsonToIngestSnapshotV1(
    rawStdout,
    {
      client: parsed.data.client,
      utcDate: parsed.data.utcDate,
      batchId: parsed.data.batchId,
      generatedAt: parsed.data.generatedAt,
      revision: parsed.data.revision
    },
    now
  );
}

export async function collectTokscaleDailySnapshot(
  input: CollectTokscaleDailyInput
) {
  return collectTokscaleDailySnapshotWithDependencies(input);
}

/**
 * Packaged-app boundary: argv, environment, timeout, and network isolation
 * remain fixed; only the verified absolute extraResource path is injected.
 */
export async function collectTokscaleDailySnapshotFromPinnedBinary(
  input: CollectTokscaleDailyInput,
  binaryPath: string
) {
  return collectTokscaleDailySnapshotWithDependencies(input, { binaryPath });
}
