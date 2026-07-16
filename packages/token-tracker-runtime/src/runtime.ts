import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions
} from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

import {
  DEFAULT_TOKEN_TRACKER_REFRESH_INTERVAL_MS,
  DEFAULT_TOKEN_TRACKER_REFRESH_TIMEOUT_MS,
  DEFAULT_TOKEN_TRACKER_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_TOKEN_TRACKER_STARTUP_TIMEOUT_MS,
  MAX_TOKEN_TRACKER_REFRESH_TIMEOUT_MS,
  MAX_TOKEN_TRACKER_SHUTDOWN_TIMEOUT_MS,
  MAX_TOKEN_TRACKER_STARTUP_TIMEOUT_MS,
  MIN_TOKEN_TRACKER_REFRESH_INTERVAL_MS,
  MIN_TOKEN_TRACKER_REFRESH_RETRIGGER_MS,
  PINNED_TOKEN_TRACKER_VERSION
} from "./constants.js";
import { TokenTrackerRuntimeError } from "./errors.js";
import type {
  ManagedTokenTracker,
  ManagedTokenTrackerExit,
  StartManagedTokenTrackerOptions,
  TokenTrackerDataAvailabilityProbe,
  TokenTrackerExecutable,
  TokenTrackerExecutableResolver,
  TokenTrackerReadinessProbe,
  TokenTrackerRuntimeClock,
  TokenTrackerRuntimePhase,
  TokenTrackerRuntimeScheduler,
  TokenTrackerRuntimeStatus,
  TokenTrackerSpawn,
  TokenTrackerSpawnOptions
} from "./types.js";

const MAX_VERSION_OUTPUT_BYTES = 64;
const MAX_STARTUP_OUTPUT_BYTES = 256 * 1_024;
const URL_TAIL_CHARACTERS = 64;
const MAX_ENVIRONMENT_VALUE_CHARACTERS = 32_768;
const MAX_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const VERSION_TIMEOUT_MS = 5_000;
const ANNOUNCED_URL_PATTERN =
  /http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(?=[/\s])/u;

const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
  "CODEBUDDY_HOME",
  "CODEX_HOME",
  "CODE_HOME",
  "COPILOT_HOME",
  "CRAFT_CONFIG_DIR",
  "DROID_SESSIONS_DIR",
  "FACTORY_DIR",
  "GEMINI_HOME",
  "GOOSE_PATH_ROOT",
  "GROK_HOME",
  "KILO_HOME",
  "KIMI_CODE_HOME",
  "KIMI_HOME",
  "KIRO_CLI_DB_PATH",
  "KIRO_HOME",
  "MIMO_HOME",
  "OMP_HOME",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_STATE_DIR",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
  "OPENCODE_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "TOKENTRACKER_ANTIGRAVITY_HOME",
  "TOKENTRACKER_ANYTHINGLLM_DB",
  "TOKENTRACKER_COPILOT_SESSION_STORE_DB",
  "TOKENTRACKER_GOOSE_DB",
  "TOKENTRACKER_GROK_HOME",
  "TOKENTRACKER_HERMES_HOME",
  "TOKENTRACKER_KILOCODE_ROOTS",
  "TOKENTRACKER_OMP_AGENT_DIR",
  "TOKENTRACKER_OPENCLAW_HOME",
  "TOKENTRACKER_PI_AGENT_DIR",
  "TOKENTRACKER_ZCODE_APP_PATH",
  "TOKENTRACKER_ZCODE_HOME",
  "TOKENTRACKER_ZED_DB",
  "WORKBUDDY_HOME",
  "ZCODE_HOME"
] as const);

const defaultScheduler: TokenTrackerRuntimeScheduler = Object.freeze({
  setInterval: (callback: () => void, delayMs: number) =>
    setInterval(callback, delayMs),
  clearInterval: (timer: NodeJS.Timeout) => clearInterval(timer),
  setTimeout: (callback: () => void, delayMs: number) =>
    setTimeout(callback, delayMs),
  clearTimeout: (timer: NodeJS.Timeout) => clearTimeout(timer),
  setImmediate: (callback: () => void) => setImmediate(callback),
  clearImmediate: (immediate: NodeJS.Immediate) => clearImmediate(immediate)
});

const defaultSpawn: TokenTrackerSpawn = (command, arguments_, options) =>
  nodeSpawn(command, [...arguments_], options as SpawnOptions);

interface NormalizedOptions {
  readonly readinessProbe: TokenTrackerReadinessProbe;
  readonly dataAvailabilityProbe: TokenTrackerDataAvailabilityProbe;
  readonly clock: TokenTrackerRuntimeClock;
  readonly startupTimeoutMs: number;
  readonly refreshTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly refreshIntervalMs: number | false;
  readonly spawn: TokenTrackerSpawn;
  readonly resolveExecutable: TokenTrackerExecutableResolver;
  readonly environment: NodeJS.ProcessEnv;
  readonly scheduler: TokenTrackerRuntimeScheduler;
}

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError: boolean;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function readOwnString(
  source: Readonly<NodeJS.ProcessEnv>,
  key: string
): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  const value = descriptor.value as unknown;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ENVIRONMENT_VALUE_CHARACTERS ||
    value.includes("\0")
  ) {
    return undefined;
  }
  return value;
}

export function buildTokenTrackerEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env
): Readonly<NodeJS.ProcessEnv> {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new TokenTrackerRuntimeError("invalid-configuration");
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = readOwnString(source, key);
    if (value !== undefined) environment[key] = value;
  }
  environment["TOKENTRACKER_NO_TELEMETRY"] = "1";
  environment["DO_NOT_TRACK"] = "1";
  environment["TOKENTRACKER_SKIP_FIRST_SYNC"] = "1";
  environment["TOKENTRACKER_AUTO_RETRY_NO_SPAWN"] = "1";
  environment["TOKENTRACKER_NO_STAR_PROMPT"] = "1";
  environment["NO_COLOR"] = "1";
  return Object.freeze(environment);
}

function normalizeDuration(
  value: unknown,
  fallback: number,
  maximum: number
): number {
  const normalized = value ?? fallback;
  if (
    typeof normalized !== "number" ||
    !Number.isInteger(normalized) ||
    normalized < 1 ||
    normalized > maximum
  ) {
    throw new TokenTrackerRuntimeError("invalid-configuration");
  }
  return normalized;
}

function normalizeOptions(
  options: StartManagedTokenTrackerOptions
): NormalizedOptions {
  if (!isPlainRecord(options)) {
    throw new TokenTrackerRuntimeError("invalid-configuration");
  }
  const allowedKeys = new Set<PropertyKey>([
    "readinessProbe",
    "dataAvailabilityProbe",
    "clock",
    "startupTimeoutMs",
    "refreshTimeoutMs",
    "shutdownTimeoutMs",
    "refreshIntervalMs",
    "spawn",
    "resolveExecutable",
    "sourceEnvironment",
    "scheduler"
  ]);
  if (Reflect.ownKeys(options).some((key) => !allowedKeys.has(key))) {
    throw new TokenTrackerRuntimeError("invalid-configuration");
  }
  const readinessProbe = options.readinessProbe;
  const dataAvailabilityProbe =
    options.dataAvailabilityProbe ?? (() => true);
  const clock = options.clock ?? (() => new Date());
  const spawn = options.spawn ?? defaultSpawn;
  const resolveExecutable =
    options.resolveExecutable ?? resolveTokenTrackerExecutable;
  const scheduler = options.scheduler ?? defaultScheduler;
  const sourceEnvironment = options.sourceEnvironment ?? process.env;
  const rawRefreshInterval =
    options.refreshIntervalMs ?? DEFAULT_TOKEN_TRACKER_REFRESH_INTERVAL_MS;
  if (
    typeof readinessProbe !== "function" ||
    typeof dataAvailabilityProbe !== "function" ||
    typeof clock !== "function" ||
    typeof spawn !== "function" ||
    typeof resolveExecutable !== "function" ||
    typeof scheduler !== "object" ||
    scheduler === null ||
    typeof scheduler.setInterval !== "function" ||
    typeof scheduler.clearInterval !== "function" ||
    typeof scheduler.setTimeout !== "function" ||
    typeof scheduler.clearTimeout !== "function" ||
    typeof scheduler.setImmediate !== "function" ||
    typeof scheduler.clearImmediate !== "function" ||
    (rawRefreshInterval !== false &&
      (typeof rawRefreshInterval !== "number" ||
        !Number.isInteger(rawRefreshInterval) ||
        rawRefreshInterval < MIN_TOKEN_TRACKER_REFRESH_INTERVAL_MS ||
        rawRefreshInterval > MAX_REFRESH_INTERVAL_MS))
  ) {
    throw new TokenTrackerRuntimeError("invalid-configuration");
  }
  return Object.freeze({
    readinessProbe,
    dataAvailabilityProbe,
    clock,
    startupTimeoutMs: normalizeDuration(
      options.startupTimeoutMs,
      DEFAULT_TOKEN_TRACKER_STARTUP_TIMEOUT_MS,
      MAX_TOKEN_TRACKER_STARTUP_TIMEOUT_MS
    ),
    refreshTimeoutMs: normalizeDuration(
      options.refreshTimeoutMs,
      DEFAULT_TOKEN_TRACKER_REFRESH_TIMEOUT_MS,
      MAX_TOKEN_TRACKER_REFRESH_TIMEOUT_MS
    ),
    shutdownTimeoutMs: normalizeDuration(
      options.shutdownTimeoutMs,
      DEFAULT_TOKEN_TRACKER_SHUTDOWN_TIMEOUT_MS,
      MAX_TOKEN_TRACKER_SHUTDOWN_TIMEOUT_MS
    ),
    refreshIntervalMs: rawRefreshInterval,
    spawn,
    resolveExecutable,
    environment: { ...buildTokenTrackerEnvironment(sourceEnvironment) },
    scheduler
  });
}

function isContainedPath(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
  );
}

export async function resolveTokenTrackerExecutable(): Promise<TokenTrackerExecutable> {
  try {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve("tokentracker-cli/package.json");
    const manifestRoot = dirname(manifestPath);
    const rawManifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (!isPlainRecord(rawManifest)) {
      throw new TokenTrackerRuntimeError("runtime-not-found");
    }
    const name = rawManifest["name"];
    const version = rawManifest["version"];
    const rawBin = rawManifest["bin"];
    if (
      name !== "tokentracker-cli" ||
      version !== PINNED_TOKEN_TRACKER_VERSION ||
      !isPlainRecord(rawBin)
    ) {
      throw new TokenTrackerRuntimeError("version-mismatch");
    }
    const declaredBin = rawBin["tokentracker-cli"];
    if (
      typeof declaredBin !== "string" ||
      declaredBin.length === 0 ||
      isAbsolute(declaredBin)
    ) {
      throw new TokenTrackerRuntimeError("runtime-not-found");
    }
    const [realRoot, realBin] = await Promise.all([
      realpath(manifestRoot),
      realpath(resolve(manifestRoot, declaredBin))
    ]);
    if (!isContainedPath(realRoot, realBin) || !(await stat(realBin)).isFile()) {
      throw new TokenTrackerRuntimeError("runtime-not-found");
    }
    return Object.freeze({
      command: process.execPath,
      argumentPrefix: Object.freeze([realBin])
    });
  } catch (error) {
    if (error instanceof TokenTrackerRuntimeError) throw error;
    throw new TokenTrackerRuntimeError("runtime-not-found");
  }
}

function normalizeExecutable(value: TokenTrackerExecutable): TokenTrackerExecutable {
  if (
    !isPlainRecord(value) ||
    typeof value.command !== "string" ||
    value.command.length === 0 ||
    value.command.includes("\0") ||
    !Array.isArray(value.argumentPrefix) ||
    value.argumentPrefix.length !== 1 ||
    typeof value.argumentPrefix[0] !== "string" ||
    value.argumentPrefix[0].length === 0 ||
    value.argumentPrefix[0].includes("\0")
  ) {
    throw new TokenTrackerRuntimeError("runtime-not-found");
  }
  return Object.freeze({
    command: value.command,
    argumentPrefix: Object.freeze([...value.argumentPrefix])
  });
}

function spawnOwned(
  normalized: NormalizedOptions,
  executable: TokenTrackerExecutable,
  arguments_: readonly string[],
  stdio: readonly ["ignore", "pipe", "pipe"] | "ignore"
): ChildProcess {
  const options: TokenTrackerSpawnOptions = Object.freeze({
    env: { ...normalized.environment },
    shell: false,
    detached: false,
    windowsHide: true,
    stdio
  });
  try {
    return normalized.spawn(
      executable.command,
      [...executable.argumentPrefix, ...arguments_],
      options
    );
  } catch {
    throw new TokenTrackerRuntimeError("spawn-failed");
  }
}

function observeChildExit(child: ChildProcess): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(
      Object.freeze({
        code: child.exitCode,
        signal: child.signalCode,
        spawnError: false
      })
    );
  }
  return new Promise<ChildExit>((resolveExit) => {
    let settled = false;
    const finish = (value: ChildExit): void => {
      if (settled) return;
      settled = true;
      child.off("exit", onExit);
      child.off("error", onError);
      resolveExit(Object.freeze(value));
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null
    ): void => finish({ code, signal, spawnError: false });
    const onError = (): void =>
      finish({ code: null, signal: null, spawnError: true });
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function observeChildClose(child: ChildProcess): Promise<ChildExit> {
  return new Promise<ChildExit>((resolveClose) => {
    let settled = false;
    const finish = (value: ChildExit): void => {
      if (settled) return;
      settled = true;
      child.off("close", onClose);
      child.off("error", onError);
      resolveClose(Object.freeze(value));
    };
    const onClose = (
      code: number | null,
      signal: NodeJS.Signals | null
    ): void => finish({ code, signal, spawnError: false });
    const onError = (): void =>
      finish({ code: null, signal: null, spawnError: true });
    child.once("close", onClose);
    child.once("error", onError);
  });
}

function createTimerPromise(
  scheduler: TokenTrackerRuntimeScheduler,
  delayMs: number
): Readonly<{ promise: Promise<void>; cancel: () => void }> {
  const deferred = createDeferred<void>();
  const timer = scheduler.setTimeout(() => deferred.resolve(), delayMs);
  timer.unref?.();
  return Object.freeze({
    promise: deferred.promise,
    cancel: () => scheduler.clearTimeout(timer)
  });
}

async function terminateOwnedChild(
  child: ChildProcess,
  timeoutMs: number,
  scheduler: TokenTrackerRuntimeScheduler,
  exitPromise: Promise<ChildExit> = observeChildExit(child)
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // The child may already have exited between the state check and signal.
  }
  const gracefulTimer = createTimerPromise(scheduler, timeoutMs);
  const graceful = await Promise.race([
    exitPromise.then(() => true),
    gracefulTimer.promise.then(() => false)
  ]);
  gracefulTimer.cancel();
  if (graceful) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // Best effort is bounded and applies only to this owned child object.
  }
  const forcedTimer = createTimerPromise(scheduler, timeoutMs);
  await Promise.race([exitPromise.then(() => undefined), forcedTimer.promise]);
  forcedTimer.cancel();
}

function asBytes(chunk: unknown): Uint8Array | null {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return null;
}

async function verifyExecutableVersion(
  normalized: NormalizedOptions,
  executable: TokenTrackerExecutable
): Promise<void> {
  const child = spawnOwned(normalized, executable, ["--version"], [
    "ignore",
    "pipe",
    "pipe"
  ]);
  const exitPromise = observeChildExit(child);
  const closePromise = observeChildClose(child);
  child.stderr?.resume();
  let output = "";
  let oversized = false;
  child.stdout?.on("data", (chunk: unknown) => {
    const bytes = asBytes(chunk);
    if (bytes === null) {
      oversized = true;
      return;
    }
    if (Buffer.byteLength(output, "utf8") + bytes.byteLength > MAX_VERSION_OUTPUT_BYTES) {
      oversized = true;
      return;
    }
    output += Buffer.from(bytes).toString("utf8");
  });
  const timer = createTimerPromise(
    normalized.scheduler,
    Math.min(VERSION_TIMEOUT_MS, normalized.startupTimeoutMs)
  );
  const outcome = await Promise.race([
    closePromise.then((exit) => ({ type: "exit" as const, exit })),
    timer.promise.then(() => ({ type: "timeout" as const }))
  ]);
  timer.cancel();
  if (outcome.type === "timeout") {
    await terminateOwnedChild(
      child,
      normalized.shutdownTimeoutMs,
      normalized.scheduler,
      exitPromise
    );
    throw new TokenTrackerRuntimeError("startup-timeout");
  }
  if (
    outcome.exit.spawnError ||
    outcome.exit.code !== 0 ||
    outcome.exit.signal !== null ||
    oversized ||
    output.trim() !== `v${PINNED_TOKEN_TRACKER_VERSION}`
  ) {
    throw new TokenTrackerRuntimeError("version-mismatch");
  }
}

function waitForAnnouncedBaseUrl(
  child: ChildProcess,
  exitPromise: Promise<ChildExit>,
  signal: AbortSignal
): Promise<string> {
  const stdout = child.stdout;
  if (stdout === null) {
    return Promise.reject(new TokenTrackerRuntimeError("spawn-failed"));
  }
  return new Promise<string>((resolveUrl, rejectUrl) => {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let tail = "";
    let observedBytes = 0;
    let settled = false;

    const cleanup = (): void => {
      stdout.off("data", onData);
      signal.removeEventListener("abort", onAbort);
      stdout.resume();
    };
    const finish = (result: string | TokenTrackerRuntimeError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof result === "string") resolveUrl(result);
      else rejectUrl(result);
    };
    const onData = (chunk: unknown): void => {
      const bytes = asBytes(chunk);
      if (bytes === null) {
        finish(new TokenTrackerRuntimeError("sidecar-incompatible"));
        return;
      }
      observedBytes += bytes.byteLength;
      if (observedBytes > MAX_STARTUP_OUTPUT_BYTES) {
        finish(new TokenTrackerRuntimeError("sidecar-incompatible"));
        return;
      }
      const text = decoder.decode(bytes, { stream: true });
      const candidate = `${tail}${text}`;
      const match = ANNOUNCED_URL_PATTERN.exec(candidate);
      if (match !== null) {
        const port = Number(match[1]);
        if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
          finish(`http://127.0.0.1:${port}`);
          return;
        }
      }
      tail = candidate.slice(-URL_TAIL_CHARACTERS);
    };
    const onAbort = (): void =>
      finish(new TokenTrackerRuntimeError("startup-timeout"));

    stdout.on("data", onData);
    child.stderr?.resume();
    signal.addEventListener("abort", onAbort, { once: true });
    void exitPromise.then((exit) => {
      if (!settled) {
        finish(
          new TokenTrackerRuntimeError(
            exit.spawnError ? "spawn-failed" : "sidecar-exited"
          )
        );
      }
    });
  });
}

function classifyProbeFailure(error: unknown): TokenTrackerRuntimeError {
  if (error instanceof TokenTrackerRuntimeError) return error;
  if (typeof error === "object" && error !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    const code = descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
    if (
      code === "incompatible-schema" ||
      code === "malformed-response" ||
      code === "response-too-large"
    ) {
      return new TokenTrackerRuntimeError("sidecar-incompatible");
    }
  }
  return new TokenTrackerRuntimeError("sidecar-unavailable");
}

async function runReadinessProbe(
  probe: TokenTrackerReadinessProbe,
  baseUrl: string,
  signal: AbortSignal,
  exitPromise: Promise<ChildExit>
): Promise<void> {
  if (signal.aborted) {
    throw new TokenTrackerRuntimeError("startup-timeout");
  }
  let rejectOnAbort!: (error: TokenTrackerRuntimeError) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = (): void =>
    rejectOnAbort(new TokenTrackerRuntimeError("startup-timeout"));
  signal.addEventListener("abort", onAbort, { once: true });
  const exitFailure = exitPromise.then<never>((exit) => {
    throw new TokenTrackerRuntimeError(
      exit.spawnError ? "spawn-failed" : "sidecar-exited"
    );
  });
  try {
    await Promise.race([probe(baseUrl, signal), abortPromise, exitFailure]);
  } catch (error) {
    throw classifyProbeFailure(error);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function waitForRefreshExit(
  child: ChildProcess,
  exitPromise: Promise<ChildExit>,
  normalized: NormalizedOptions
): Promise<void> {
  return (async () => {
    const timer = createTimerPromise(
      normalized.scheduler,
      normalized.refreshTimeoutMs
    );
    const outcome = await Promise.race([
      exitPromise.then((exit) => ({ type: "exit" as const, exit })),
      timer.promise.then(() => ({ type: "timeout" as const }))
    ]);
    timer.cancel();
    if (outcome.type === "timeout") {
      await terminateOwnedChild(
        child,
        normalized.shutdownTimeoutMs,
        normalized.scheduler,
        exitPromise
      );
      throw new TokenTrackerRuntimeError("refresh-timeout");
    }
    if (
      outcome.exit.spawnError ||
      outcome.exit.code !== 0 ||
      outcome.exit.signal !== null
    ) {
      throw new TokenTrackerRuntimeError("refresh-failed");
    }
  })();
}

async function probeDataAvailability(
  normalized: NormalizedOptions,
  baseUrl: string
): Promise<boolean> {
  const timer = createTimerPromise(
    normalized.scheduler,
    normalized.refreshTimeoutMs
  );
  try {
    const result = await Promise.race([
      Promise.resolve(normalized.dataAvailabilityProbe(baseUrl)),
      timer.promise.then(() => {
        throw new TokenTrackerRuntimeError("refresh-timeout");
      })
    ]);
    if (typeof result !== "boolean") {
      throw new TokenTrackerRuntimeError("refresh-failed");
    }
    return result;
  } catch (error) {
    if (error instanceof TokenTrackerRuntimeError) throw error;
    throw new TokenTrackerRuntimeError("refresh-failed");
  } finally {
    timer.cancel();
  }
}

function readRuntimeInstant(clock: TokenTrackerRuntimeClock): Date {
  let instant: Date;
  try {
    instant = clock();
  } catch {
    throw new TokenTrackerRuntimeError("invalid-configuration");
  }
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    throw new TokenTrackerRuntimeError("invalid-configuration");
  }
  return instant;
}

export async function startManagedTokenTracker(
  options: StartManagedTokenTrackerOptions
): Promise<ManagedTokenTracker> {
  const normalized = normalizeOptions(options);
  const executable = normalizeExecutable(await normalized.resolveExecutable());
  await verifyExecutableVersion(normalized, executable);

  const mainChild = spawnOwned(normalized, executable, [
    "serve",
    "--no-open",
    "--no-sync"
  ], ["ignore", "pipe", "pipe"]);
  const mainExitPromise = observeChildExit(mainChild);
  const startupController = new AbortController();
  const startupTimer = normalized.scheduler.setTimeout(
    () => startupController.abort(),
    normalized.startupTimeoutMs
  );
  startupTimer.unref?.();

  let baseUrl: string;
  try {
    baseUrl = await waitForAnnouncedBaseUrl(
      mainChild,
      mainExitPromise,
      startupController.signal
    );
    await runReadinessProbe(
      normalized.readinessProbe,
      baseUrl,
      startupController.signal,
      mainExitPromise
    );
  } catch (error) {
    startupController.abort();
    normalized.scheduler.clearTimeout(startupTimer);
    await terminateOwnedChild(
      mainChild,
      normalized.shutdownTimeoutMs,
      normalized.scheduler,
      mainExitPromise
    );
    if (error instanceof TokenTrackerRuntimeError) throw error;
    throw new TokenTrackerRuntimeError("sidecar-unavailable");
  }
  normalized.scheduler.clearTimeout(startupTimer);

  const closedDeferred = createDeferred<ManagedTokenTrackerExit>();
  const refreshChildren = new Map<ChildProcess, Promise<ChildExit>>();
  let refreshInFlight: Promise<void> | null = null;
  let refreshInterval: NodeJS.Timeout | null = null;
  let initialRefresh: NodeJS.Immediate | null = null;
  let stopRequested = false;
  let stopPromise: Promise<void> | null = null;
  let closedResolved = false;
  let phase: TokenTrackerRuntimePhase = "syncing";
  let lastSuccessAt: string | null = null;
  let consecutiveFailures = 0;
  let lastRefreshStartedAtMs: number | null = null;

  const recordRefreshFailure = (): void => {
    if (stopRequested || closedResolved) return;
    consecutiveFailures += 1;
    phase = lastSuccessAt === null ? "refresh-failed" : "stale";
  };

  const resolveClosed = (exit: ManagedTokenTrackerExit): void => {
    if (closedResolved) return;
    closedResolved = true;
    closedDeferred.resolve(Object.freeze(exit));
  };

  const clearRefreshSchedule = (): void => {
    if (initialRefresh !== null) {
      normalized.scheduler.clearImmediate(initialRefresh);
      initialRefresh = null;
    }
    if (refreshInterval !== null) {
      normalized.scheduler.clearInterval(refreshInterval);
      refreshInterval = null;
    }
  };

  const getStatus = (): TokenTrackerRuntimeStatus =>
    Object.freeze({
      phase,
      lastSuccessAt,
      consecutiveFailures,
      canRetry:
        !stopRequested &&
        !closedResolved &&
        refreshInFlight === null &&
        initialRefresh === null &&
        phase !== "starting" &&
        phase !== "syncing"
    });

  const startRefresh = (delayMs = 0): Promise<void> => {
    if (stopRequested || closedResolved) {
      return Promise.reject(
        new TokenTrackerRuntimeError("sidecar-unavailable")
      );
    }
    if (refreshInFlight !== null) return refreshInFlight;
    if (initialRefresh !== null) {
      normalized.scheduler.clearImmediate(initialRefresh);
      initialRefresh = null;
    }
    phase = "syncing";
    const operation = (async (): Promise<void> => {
      if (delayMs > 0) {
        const delay = createTimerPromise(normalized.scheduler, delayMs);
        await delay.promise;
      }
      if (stopRequested || closedResolved) {
        throw new TokenTrackerRuntimeError("sidecar-unavailable");
      }
      lastRefreshStartedAtMs = readRuntimeInstant(normalized.clock).getTime();
      let child: ChildProcess;
      try {
        child = spawnOwned(normalized, executable, [
          "sync",
          "--auto",
          "--background",
          "--all-local-sources"
        ], "ignore");
      } catch {
        recordRefreshFailure();
        throw new TokenTrackerRuntimeError("refresh-failed");
      }
      const exitPromise = observeChildExit(child);
      refreshChildren.set(child, exitPromise);
      try {
        await waitForRefreshExit(child, exitPromise, normalized);
        const hasData = await probeDataAvailability(normalized, baseUrl);
        lastSuccessAt = readRuntimeInstant(normalized.clock).toISOString();
        consecutiveFailures = 0;
        phase = hasData ? "ready" : "ready-no-data";
      } catch (error) {
        recordRefreshFailure();
        if (error instanceof TokenTrackerRuntimeError) throw error;
        throw new TokenTrackerRuntimeError("refresh-failed");
      } finally {
        refreshChildren.delete(child);
      }
    })();
    const wrappedOperation = operation.finally(() => {
      if (refreshInFlight === wrappedOperation) {
        refreshInFlight = null;
      }
    });
    refreshInFlight = wrappedOperation;
    return wrappedOperation;
  };

  const refreshLocalUsage = (): Promise<void> => startRefresh();

  const requestRefresh = async (): Promise<TokenTrackerRuntimeStatus> => {
    if (refreshInFlight !== null) {
      await refreshInFlight.catch(() => undefined);
      return getStatus();
    }
    const now = readRuntimeInstant(normalized.clock).getTime();
    const delayMs =
      lastRefreshStartedAtMs === null
        ? 0
        : Math.max(
            0,
            MIN_TOKEN_TRACKER_REFRESH_RETRIGGER_MS -
              Math.max(0, now - lastRefreshStartedAtMs)
          );
    await startRefresh(delayMs).catch(() => undefined);
    return getStatus();
  };

  const runScheduledRefresh = (): void => {
    void startRefresh().catch(() => undefined);
  };

  initialRefresh = normalized.scheduler.setImmediate(() => {
    initialRefresh = null;
    runScheduledRefresh();
  });
  initialRefresh.unref?.();
  if (normalized.refreshIntervalMs !== false) {
    refreshInterval = normalized.scheduler.setInterval(
      runScheduledRefresh,
      normalized.refreshIntervalMs
    );
    refreshInterval.unref?.();
  }

  void mainExitPromise.then((exit) => {
    clearRefreshSchedule();
    resolveClosed({
      expected: stopRequested,
      code: exit.code,
      signal: exit.signal
    });
    for (const [child, childExit] of refreshChildren) {
      void terminateOwnedChild(
        child,
        normalized.shutdownTimeoutMs,
        normalized.scheduler,
        childExit
      );
    }
  });

  const stop = (): Promise<void> => {
    if (stopPromise !== null) return stopPromise;
    stopRequested = true;
    clearRefreshSchedule();
    stopPromise = (async (): Promise<void> => {
      await Promise.all([
        ...[...refreshChildren].map(([child, exit]) =>
          terminateOwnedChild(
            child,
            normalized.shutdownTimeoutMs,
            normalized.scheduler,
            exit
          )
        ),
        terminateOwnedChild(
          mainChild,
          normalized.shutdownTimeoutMs,
          normalized.scheduler,
          mainExitPromise
        )
      ]);
      const exit = await Promise.race([
        mainExitPromise,
        Promise.resolve(
          Object.freeze({
            code: mainChild.exitCode,
            signal: mainChild.signalCode,
            spawnError: false
          })
        )
      ]);
      resolveClosed({ expected: true, code: exit.code, signal: exit.signal });
    })();
    return stopPromise;
  };

  return Object.freeze({
    baseUrl,
    version: PINNED_TOKEN_TRACKER_VERSION,
    closed: closedDeferred.promise,
    getStatus,
    requestRefresh,
    refreshLocalUsage,
    stop
  });
}
