import type { ChildProcess } from "node:child_process";

import type { PINNED_TOKEN_TRACKER_VERSION } from "./constants.js";

export interface TokenTrackerExecutable {
  readonly command: string;
  readonly argumentPrefix: readonly string[];
}

export interface TokenTrackerSpawnOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly detached: false;
  readonly windowsHide: true;
  readonly stdio: readonly ["ignore", "pipe", "pipe"] | "ignore";
}

export type TokenTrackerSpawn = (
  command: string,
  arguments_: readonly string[],
  options: TokenTrackerSpawnOptions
) => ChildProcess;

export type TokenTrackerReadinessProbe = (
  baseUrl: string,
  signal: AbortSignal
) => Promise<void>;

export type TokenTrackerDataAvailabilityProbe = (
  baseUrl: string
) => boolean | Promise<boolean>;

export type TokenTrackerRuntimeClock = () => Date;

export type TokenTrackerRuntimePhase =
  | "starting"
  | "syncing"
  | "ready"
  | "ready-no-data"
  | "refresh-failed"
  | "stale";

export interface TokenTrackerRuntimeStatus {
  readonly phase: TokenTrackerRuntimePhase;
  readonly lastSuccessAt: string | null;
  readonly consecutiveFailures: number;
  readonly canRetry: boolean;
}

export type TokenTrackerExecutableResolver = () =>
  | TokenTrackerExecutable
  | Promise<TokenTrackerExecutable>;

export interface TokenTrackerRuntimeScheduler {
  setInterval(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearInterval(timer: NodeJS.Timeout): void;
  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
  setImmediate(callback: () => void): NodeJS.Immediate;
  clearImmediate(immediate: NodeJS.Immediate): void;
}

export interface StartManagedTokenTrackerOptions {
  readonly readinessProbe: TokenTrackerReadinessProbe;
  readonly dataAvailabilityProbe?: TokenTrackerDataAvailabilityProbe;
  readonly clock?: TokenTrackerRuntimeClock;
  readonly startupTimeoutMs?: number;
  readonly refreshTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly refreshIntervalMs?: number | false;
  readonly spawn?: TokenTrackerSpawn;
  readonly resolveExecutable?: TokenTrackerExecutableResolver;
  readonly sourceEnvironment?: Readonly<NodeJS.ProcessEnv>;
  readonly scheduler?: TokenTrackerRuntimeScheduler;
}

export interface ManagedTokenTrackerExit {
  readonly expected: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ManagedTokenTracker {
  readonly baseUrl: string;
  readonly version: typeof PINNED_TOKEN_TRACKER_VERSION;
  readonly closed: Promise<ManagedTokenTrackerExit>;
  getStatus(): TokenTrackerRuntimeStatus;
  requestRefresh(): Promise<TokenTrackerRuntimeStatus>;
  refreshLocalUsage(): Promise<void>;
  stop(): Promise<void>;
}
