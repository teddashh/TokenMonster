import {
  automaticUpdateChannelForVersion,
  isAutomaticUpdateVersion,
  parseAutomaticUpdateDto,
  windowsSquirrelFeedUrl,
  type AutomaticUpdateCommandCode,
  type AutomaticUpdateCommandResult,
  type AutomaticUpdateDto,
  type AutomaticUpdateErrorCode,
  type AutomaticUpdateStatus,
} from "../shared/automatic-updates.js";

export const AUTOMATIC_UPDATE_SCHEDULE = Object.freeze({
  initialDelayMs: 30_000,
  minimumInitialDelayMs: 1_000,
  maximumInitialDelayMs: 5 * 60_000,
  periodicIntervalMs: 6 * 60 * 60_000,
  minimumPeriodicIntervalMs: 15 * 60_000,
  maximumPeriodicIntervalMs: 24 * 60 * 60_000,
});

export const AUTOMATIC_UPDATE_TIMEOUTS = Object.freeze({
  checkMs: 2 * 60_000,
  minimumCheckMs: 30_000,
  maximumCheckMs: 10 * 60_000,
  downloadMs: 2 * 60 * 60_000,
  minimumDownloadMs: 5 * 60_000,
  maximumDownloadMs: 6 * 60 * 60_000,
});

export type WindowsSquirrelUpdaterEventName =
  | "before-quit-for-update"
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "update-downloaded"
  | "error";

export type WindowsSquirrelUpdaterListener = (...args: unknown[]) => void;

export interface WindowsSquirrelUpdaterPort {
  setFeedURL(options: Readonly<{ url: string }>): void;
  checkForUpdates(): void | Promise<unknown>;
  quitAndInstall(): void;
  on(
    event: WindowsSquirrelUpdaterEventName,
    listener: WindowsSquirrelUpdaterListener,
  ): void;
  removeListener(
    event: WindowsSquirrelUpdaterEventName,
    listener: WindowsSquirrelUpdaterListener,
  ): void;
}

export interface AutomaticUpdateClockPort {
  now(): Date;
}

export interface AutomaticUpdateTimerPort {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export interface AutomaticUpdatePlatformPort {
  current(): NodeJS.Platform;
}

export interface AutomaticUpdateCurrentVersionPort {
  current(): string;
}

export interface AutomaticUpdateControllerOptions {
  readonly updater: WindowsSquirrelUpdaterPort;
  readonly timer: AutomaticUpdateTimerPort;
  readonly clock: AutomaticUpdateClockPort;
  readonly platform: AutomaticUpdatePlatformPort;
  readonly currentVersion: AutomaticUpdateCurrentVersionPort;
  /**
   * Must come from an explicit local user preference. Keeping this false
   * preserves the zero-egress startup contract while still allowing checkNow.
   */
  readonly automaticChecksEnabled: boolean;
  /**
   * Runs synchronously when Electron emits before-quit-for-update. The host
   * must use it to allow updater-owned window closure and begin local-only
   * lifecycle cleanup; it must not perform network work or inspect renderer
   * content.
   */
  readonly beforeQuitForUpdate: () => void;
  readonly initialDelayMs?: number;
  readonly periodicIntervalMs?: number;
  readonly checkTimeoutMs?: number;
  readonly downloadTimeoutMs?: number;
}

export interface AutomaticUpdateController {
  status(): AutomaticUpdateDto;
  setAutomaticChecksEnabled(enabled: boolean): void;
  checkNow(): AutomaticUpdateCommandResult;
  quitAndInstall(): AutomaticUpdateCommandResult;
  dispose(): void;
}

interface RegisteredListener {
  readonly event: WindowsSquirrelUpdaterEventName;
  readonly listener: WindowsSquirrelUpdaterListener;
}

interface ParsedEventVersion {
  readonly supplied: boolean;
  readonly version: string | null;
}

interface ParsedSemver {
  readonly major: bigint;
  readonly minor: bigint;
  readonly patch: bigint;
  readonly prerelease: readonly string[];
}

function parseSemver(value: string): ParsedSemver {
  if (!isAutomaticUpdateVersion(value)) {
    throw new TypeError("INVALID_AUTOMATIC_UPDATE_VERSION");
  }
  const separator = value.indexOf("-");
  const core = separator === -1 ? value : value.slice(0, separator);
  const prerelease = separator === -1 ? "" : value.slice(separator + 1);
  const [major = "", minor = "", patch = ""] = core.split(".", 3);
  return Object.freeze({
    major: BigInt(major),
    minor: BigInt(minor),
    patch: BigInt(patch),
    prerelease:
      prerelease.length === 0
        ? Object.freeze([])
        : Object.freeze(prerelease.split(".")),
  });
}

function comparePrerelease(
  left: readonly string[],
  right: readonly string[],
): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^[0-9]+$/u.test(leftPart);
    const rightNumeric = /^[0-9]+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(leftPart);
      const rightNumber = BigInt(rightPart);
      return leftNumber < rightNumber ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function compareSemver(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  for (const field of ["major", "minor", "patch"] as const) {
    if (parsedLeft[field] === parsedRight[field]) continue;
    return parsedLeft[field] < parsedRight[field] ? -1 : 1;
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

function boundDelay(
  input: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(input)));
}

/** Squirrel.Windows removes the separator before the optional numeric
 * prerelease component (`rc.11` becomes `rc11`) in its nupkg/release name.
 * The release contract forbids labels that end in a digit, so this projection
 * is reversible at the updater boundary and must be restored before SemVer
 * downgrade checks. */
function canonicalEventVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-([A-Za-z](?:[0-9A-Za-z-]*[A-Za-z-])?)([0-9]+)$/u.exec(
      value,
    );
  const candidate =
    collapsed === null
      ? value
      : `${collapsed[1]}.${collapsed[2]}.${collapsed[3]}-${collapsed[4]}.${collapsed[5]}`;
  return isAutomaticUpdateVersion(candidate) ? candidate : null;
}

function eventVersion(args: readonly unknown[]): ParsedEventVersion {
  const first = args[0];
  if (typeof first === "string") {
    return Object.freeze({
      supplied: true,
      version: canonicalEventVersion(first),
    });
  }
  if (typeof first === "object" && first !== null && !Array.isArray(first)) {
    const descriptor = Object.getOwnPropertyDescriptor(first, "version");
    if (descriptor !== undefined && "value" in descriptor) {
      return Object.freeze({
        supplied: true,
        version: canonicalEventVersion(descriptor.value),
      });
    }
  }
  if (typeof args[2] === "string") {
    return Object.freeze({
      supplied: true,
      version: canonicalEventVersion(args[2]),
    });
  }
  return Object.freeze({ supplied: false, version: null });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return false;
  }
  try {
    return typeof Reflect.get(value, "then") === "function";
  } catch {
    return false;
  }
}

export function createAutomaticUpdateController(
  options: AutomaticUpdateControllerOptions,
): AutomaticUpdateController {
  const currentVersion = options.currentVersion.current();
  const channel = automaticUpdateChannelForVersion(currentVersion);
  const supported = options.platform.current() === "win32";
  const initialDelayMs = boundDelay(
    options.initialDelayMs,
    AUTOMATIC_UPDATE_SCHEDULE.initialDelayMs,
    AUTOMATIC_UPDATE_SCHEDULE.minimumInitialDelayMs,
    AUTOMATIC_UPDATE_SCHEDULE.maximumInitialDelayMs,
  );
  const periodicIntervalMs = boundDelay(
    options.periodicIntervalMs,
    AUTOMATIC_UPDATE_SCHEDULE.periodicIntervalMs,
    AUTOMATIC_UPDATE_SCHEDULE.minimumPeriodicIntervalMs,
    AUTOMATIC_UPDATE_SCHEDULE.maximumPeriodicIntervalMs,
  );
  const checkTimeoutMs = boundDelay(
    options.checkTimeoutMs,
    AUTOMATIC_UPDATE_TIMEOUTS.checkMs,
    AUTOMATIC_UPDATE_TIMEOUTS.minimumCheckMs,
    AUTOMATIC_UPDATE_TIMEOUTS.maximumCheckMs,
  );
  const downloadTimeoutMs = boundDelay(
    options.downloadTimeoutMs,
    AUTOMATIC_UPDATE_TIMEOUTS.downloadMs,
    AUTOMATIC_UPDATE_TIMEOUTS.minimumDownloadMs,
    AUTOMATIC_UPDATE_TIMEOUTS.maximumDownloadMs,
  );

  let phase: AutomaticUpdateStatus = supported ? "idle" : "unsupported";
  let lastCheckedAt: string | null = null;
  let availableVersion: string | null = null;
  let errorCode: AutomaticUpdateErrorCode | null = null;
  let timerHandle: unknown | null = null;
  let deadlineHandle: unknown | null = null;
  let feedConfigured = false;
  let updaterReady = false;
  let inFlight = false;
  let installRequested = false;
  let updateQuitPrepared = false;
  let automaticChecksEnabled = options.automaticChecksEnabled;
  let disposed = false;
  const registeredListeners: RegisteredListener[] = [];

  const status = (): AutomaticUpdateDto =>
    parseAutomaticUpdateDto({
      contractVersion: 1,
      currentVersion,
      channel,
      status: phase,
      lastCheckedAt,
      availableVersion,
      errorCode,
    });

  const command = (
    ok: boolean,
    code: AutomaticUpdateCommandCode,
  ): AutomaticUpdateCommandResult =>
    Object.freeze({ ok, code, update: status() });

  const failedSynchronously = (): boolean => phase === "error";

  const cancelTimer = (): void => {
    const handle = timerHandle;
    timerHandle = null;
    if (handle === null) return;
    try {
      options.timer.clear(handle);
    } catch {
      // Logical cancellation must win over an adapter cleanup failure.
    }
  };

  const cancelDeadline = (): void => {
    const handle = deadlineHandle;
    deadlineHandle = null;
    if (handle === null) return;
    try {
      options.timer.clear(handle);
    } catch {
      // Logical cancellation must win over an adapter cleanup failure.
    }
  };

  const setError = (
    code: AutomaticUpdateErrorCode,
    retainAvailableVersion = false,
    operationSettled = true,
  ): void => {
    phase = "error";
    errorCode = code;
    if (operationSettled) inFlight = false;
    installRequested = false;
    updateQuitPrepared = false;
    if (!retainAvailableVersion) availableVersion = null;
  };

  let beginCheck: () => AutomaticUpdateCommandResult;

  const schedule = (delayMs: number): void => {
    cancelTimer();
    if (disposed || !supported || phase === "ready" || installRequested) return;
    try {
      const handle = options.timer.set(delayMs, () => {
        timerHandle = null;
        if (disposed) return;
        beginCheck();
      });
      if (handle === null || handle === undefined) {
        throw new Error("AUTOMATIC_UPDATE_TIMER_UNAVAILABLE");
      }
      timerHandle = handle;
    } catch {
      setError("scheduler-unavailable");
    }
  };

  const schedulePeriodic = (): void => {
    if (!automaticChecksEnabled) return;
    schedule(periodicIntervalMs);
  };

  const recordCheckTime = (): boolean => {
    try {
      const now = options.clock.now();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error("AUTOMATIC_UPDATE_CLOCK_UNAVAILABLE");
      }
      lastCheckedAt = now.toISOString();
      return true;
    } catch {
      setError("clock-unavailable");
      return false;
    }
  };

  const configureFeed = (): boolean => {
    if (feedConfigured) return true;
    try {
      options.updater.setFeedURL(
        Object.freeze({ url: windowsSquirrelFeedUrl(channel) }),
      );
      feedConfigured = true;
      return true;
    } catch {
      setError("feed-unavailable");
      return false;
    }
  };

  const failActiveUpdate = (
    code: AutomaticUpdateErrorCode,
    operationSettled = true,
  ): void => {
    if (disposed) return;
    cancelDeadline();
    const retain = phase === "available" || phase === "downloading";
    setError(code, retain, operationSettled);
    if (operationSettled) schedulePeriodic();
  };

  const startDeadline = (
    delayMs: number,
    code: "check-failed" | "download-failed",
    operationAlreadyActive = true,
  ): boolean => {
    cancelDeadline();
    try {
      const handle = options.timer.set(delayMs, () => {
        deadlineHandle = null;
        if (disposed || !inFlight) return;
        // Electron exposes no cancellation API. Keep the physical operation
        // single-flight after our UI deadline expires; a late terminal updater
        // event may release it, but a second check must never overlap it.
        failActiveUpdate(code, false);
      });
      if (handle === null || handle === undefined) {
        throw new Error("AUTOMATIC_UPDATE_TIMER_UNAVAILABLE");
      }
      deadlineHandle = handle;
      return true;
    } catch {
      failActiveUpdate(code, !operationAlreadyActive);
      return false;
    }
  };

  const validNewerVersion = (version: string | null): version is string =>
    version !== null &&
    isAutomaticUpdateVersion(version) &&
    (channel !== "latest" || !version.includes("-")) &&
    compareSemver(version, currentVersion) > 0;

  const listeners: readonly RegisteredListener[] = [
    Object.freeze({
      event: "before-quit-for-update",
      listener: () => {
        if (
          disposed ||
          !supported ||
          !installRequested ||
          updateQuitPrepared
        ) {
          return;
        }
        try {
          options.beforeQuitForUpdate();
          updateQuitPrepared = true;
        } catch {
          setError("install-failed", true);
        }
      },
    }),
    Object.freeze({
      event: "checking-for-update",
      listener: () => {
        if (disposed || !supported || !inFlight) return;
        cancelTimer();
        phase = "checking";
        errorCode = null;
        availableVersion = null;
        inFlight = true;
        installRequested = false;
        startDeadline(checkTimeoutMs, "check-failed");
      },
    }),
    Object.freeze({
      event: "update-available",
      listener: (...args: unknown[]) => {
        if (disposed || !supported || !inFlight) return;
        cancelTimer();
        const parsed = eventVersion(args);
        if (
          parsed.supplied &&
          !validNewerVersion(parsed.version)
        ) {
          failActiveUpdate("invalid-update");
          return;
        }
        // Electron begins the Squirrel download automatically before emitting
        // this event; there is no separate built-in progress event.
        phase = "downloading";
        errorCode = null;
        availableVersion = parsed.version;
        inFlight = true;
        installRequested = false;
        // Electron's built-in autoUpdater has no download-progress event. This
        // is an absolute fail-closed bound, not a progress-resetting deadline.
        startDeadline(downloadTimeoutMs, "download-failed");
      },
    }),
    Object.freeze({
      event: "update-not-available",
      listener: () => {
        if (disposed || !supported || !inFlight) return;
        cancelDeadline();
        phase = "idle";
        errorCode = null;
        availableVersion = null;
        inFlight = false;
        installRequested = false;
        schedulePeriodic();
      },
    }),
    Object.freeze({
      event: "update-downloaded",
      listener: (...args: unknown[]) => {
        if (disposed || !supported || !inFlight) return;
        cancelTimer();
        cancelDeadline();
        const parsed = eventVersion(args);
        const downloadedVersion = parsed.supplied
          ? parsed.version
          : availableVersion;
        if (!validNewerVersion(downloadedVersion)) {
          failActiveUpdate("invalid-update");
          return;
        }
        phase = "ready";
        errorCode = null;
        availableVersion = downloadedVersion;
        inFlight = false;
        installRequested = false;
      },
    }),
    Object.freeze({
      event: "error",
      listener: () => {
        if (disposed || !supported || !inFlight) return;
        const code =
          phase === "available" || phase === "downloading"
            ? "download-failed"
            : "check-failed";
        failActiveUpdate(code);
      },
    }),
  ];

  const registerListeners = (): boolean => {
    try {
      for (const registration of listeners) {
        options.updater.on(registration.event, registration.listener);
        registeredListeners.push(registration);
      }
      updaterReady = true;
      return true;
    } catch {
      for (const registration of registeredListeners.splice(0)) {
        try {
          options.updater.removeListener(
            registration.event,
            registration.listener,
          );
        } catch {
          // A partial listener registration remains fail-closed.
        }
      }
      setError("updater-unavailable");
      return false;
    }
  };

  beginCheck = (): AutomaticUpdateCommandResult => {
    if (disposed) return command(false, "disposed");
    if (!supported) return command(false, "unsupported");
    if (!updaterReady) {
      setError("updater-unavailable");
      return command(false, "failed");
    }
    if (inFlight || phase === "ready") {
      return command(false, "check-busy");
    }

    cancelTimer();
    availableVersion = null;
    errorCode = null;
    installRequested = false;
    updateQuitPrepared = false;
    if (!recordCheckTime()) {
      schedulePeriodic();
      return command(false, "failed");
    }
    if (!configureFeed()) {
      schedulePeriodic();
      return command(false, "failed");
    }

    phase = "checking";
    inFlight = true;
    if (!startDeadline(checkTimeoutMs, "check-failed", false)) {
      return command(false, "failed");
    }
    try {
      const pending = options.updater.checkForUpdates();
      if (isPromiseLike(pending)) {
        void Promise.resolve(pending).catch(() => {
          if (disposed || !inFlight) return;
          failActiveUpdate(
            phase === "available" || phase === "downloading"
              ? "download-failed"
              : "check-failed",
          );
        });
      }
    } catch {
      failActiveUpdate("check-failed");
      return command(false, "failed");
    }
    return failedSynchronously()
      ? command(false, "failed")
      : command(true, "check-started");
  };

  if (supported && registerListeners()) {
    // Feed configuration stays lazy. In particular, a default-off startup
    // must not touch the updater's network surface until a user explicitly
    // checks or enables the persisted automatic schedule.
    if (automaticChecksEnabled) schedule(initialDelayMs);
  }

  return Object.freeze({
    status,
    setAutomaticChecksEnabled(enabled: boolean): void {
      if (disposed || automaticChecksEnabled === enabled) return;
      automaticChecksEnabled = enabled;
      if (!enabled) {
        cancelTimer();
        return;
      }
      if (supported && updaterReady && !inFlight && phase !== "ready") {
        schedule(initialDelayMs);
      }
    },
    checkNow: beginCheck,
    quitAndInstall(): AutomaticUpdateCommandResult {
      if (disposed) return command(false, "disposed");
      if (!supported) return command(false, "unsupported");
      if (installRequested) return command(false, "install-busy");
      if (phase !== "ready") return command(false, "not-ready");
      installRequested = true;
      updateQuitPrepared = false;
      cancelTimer();
      try {
        options.updater.quitAndInstall();
        return failedSynchronously()
          ? command(false, "failed")
          : command(true, "install-started");
      } catch {
        setError("install-failed", true);
        schedulePeriodic();
        return command(false, "failed");
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      inFlight = false;
      cancelTimer();
      cancelDeadline();
      for (const registration of registeredListeners.splice(0)) {
        try {
          options.updater.removeListener(
            registration.event,
            registration.listener,
          );
        } catch {
          // Disposal is idempotent and never exposes adapter failures.
        }
      }
    },
  });
}
