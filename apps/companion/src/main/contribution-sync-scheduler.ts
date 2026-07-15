import type {
  ContributionRuntimeStatus,
  ContributionSyncResult,
} from "../shared/ipc.js";

const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_WAKE_DELAY_MS = 5_000;
const DEFAULT_BUSY_RETRY_DELAY_MS = 60_000;
const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MAX_DELAY_MS = 24 * 60 * 60_000;

interface BackgroundContributionPort {
  status(): ContributionRuntimeStatus;
  sync(): Promise<ContributionSyncResult>;
}

interface ContributionSyncSchedulerOptions {
  readonly contribution: BackgroundContributionPort;
  readonly initialDelayMs?: number;
  readonly wakeDelayMs?: number;
  readonly busyRetryDelayMs?: number;
  readonly intervalMs?: number;
}

export interface ContributionSyncScheduler {
  start(): void;
  wake(): void;
  pause(): void;
  dispose(): void;
}

function boundedDelay(value: number | undefined, fallback: number): number {
  const delay = value ?? fallback;
  if (
    !Number.isSafeInteger(delay) ||
    delay < 1 ||
    delay > MAX_DELAY_MS
  ) {
    throw new Error("BACKGROUND_SYNC_DELAY_INVALID");
  }
  return delay;
}

export function createContributionSyncScheduler(
  options: ContributionSyncSchedulerOptions,
): ContributionSyncScheduler {
  const initialDelayMs = boundedDelay(
    options.initialDelayMs,
    DEFAULT_INITIAL_DELAY_MS,
  );
  const wakeDelayMs = boundedDelay(options.wakeDelayMs, DEFAULT_WAKE_DELAY_MS);
  const busyRetryDelayMs = boundedDelay(
    options.busyRetryDelayMs,
    DEFAULT_BUSY_RETRY_DELAY_MS,
  );
  const intervalMs = boundedDelay(options.intervalMs, DEFAULT_INTERVAL_MS);
  let started = false;
  let disposed = false;
  let paused = false;
  let running = false;
  let wakeAfterRun = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const enabled = (): boolean => {
    try {
      return options.contribution.status().enabled === true;
    } catch {
      return false;
    }
  };

  const cancelTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delayMs: number, replace: boolean): void => {
    if (disposed || !started || paused || !enabled()) {
      cancelTimer();
      return;
    }
    if (timer !== null) {
      if (!replace) return;
      cancelTimer();
    }
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delayMs);
  };

  const tick = async (): Promise<void> => {
    if (disposed || !started || paused || running || !enabled()) return;
    running = true;
    let nextDelayMs = intervalMs;
    try {
      const result = await options.contribution.sync();
      if (!result.ok && result.code === "busy") {
        nextDelayMs = busyRetryDelayMs;
      }
    } catch {
      // The next bounded interval is the only retry side effect. Background
      // failures never log payloads, weaken consent, or keep the app alive.
    } finally {
      running = false;
      if (disposed || !started || paused || !enabled()) return;
      if (wakeAfterRun) {
        wakeAfterRun = false;
        schedule(wakeDelayMs, true);
      } else {
        schedule(nextDelayMs, true);
      }
    }
  };

  const pause = (): void => {
    paused = true;
    wakeAfterRun = false;
    cancelTimer();
  };

  return Object.freeze({
    start(): void {
      if (disposed || started) return;
      started = true;
      paused = false;
      schedule(initialDelayMs, false);
    },
    wake(): void {
      if (disposed) return;
      if (!started) started = true;
      paused = false;
      if (!enabled()) {
        pause();
        return;
      }
      if (running) {
        wakeAfterRun = true;
        return;
      }
      schedule(wakeDelayMs, true);
    },
    pause,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      started = false;
      paused = true;
      wakeAfterRun = false;
      cancelTimer();
    },
  });
}

export type { ContributionSyncSchedulerOptions };
