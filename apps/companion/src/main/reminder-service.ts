import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import {
  DEFAULT_REMINDER_SETTINGS,
  dailyReminderNotification,
  isReminderTime,
  isReminderRevision,
  isWithinReminderQuietHours,
  parseReminderSettings,
  parseReminderSettingsRequest,
  reminderMinuteOfDay,
  testReminderNotification,
  type ReminderLocale,
  type ReminderMutationResult,
  type ReminderNotification,
  type ReminderServiceStatus,
  type ReminderSettingsV1,
  type ReminderTestResult,
  type ReminderTickResult,
} from "../shared/reminders.js";

const STORE_SCHEMA_VERSION = "2" as const;
const LEGACY_STORE_SCHEMA_VERSION = "1" as const;
const MAX_STORE_BYTES = 64 * 1_024;
const MAX_LEDGER_ENTRIES = 30;
const CHECK_INTERVAL_MS = 60_000;
const INITIAL_CHECK_DELAY_MS = 1;
const CROSS_MIDNIGHT_CATCH_UP_MINUTES = 60;
const DAILY_TRIGGER_PREFIX = "daily-summary:";
const UTC_INSTANT_PATTERN =
  /^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;
const LOCAL_DATE_PATTERN =
  /^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/u;

type ReminderLedgerEntry =
  | Readonly<{
      triggerId: string;
      localDate: string;
      scheduledTime: string;
      state: "pending";
      recordedAt: string;
    }>
  | Readonly<{
      triggerId: string;
      localDate: string;
      scheduledTime: string;
      state: "handled";
      attemptedAt: string;
      outcome: "attempted" | "shown" | "failed" | "expired";
    }>;

interface ReminderStoreV2 {
  readonly schemaVersion: typeof STORE_SCHEMA_VERSION;
  readonly revision: string;
  readonly settings: ReminderSettingsV1;
  readonly ledger: readonly ReminderLedgerEntry[];
}

interface LoadedReminderStore {
  readonly store: ReminderStoreV2;
  readonly migrated: boolean;
}

export interface ReminderLocalDateTime {
  readonly localDate: string;
  readonly hour: number;
  readonly minute: number;
}

export interface ReminderClockPort {
  now(): Date;
  localDateTime(instant: Date): ReminderLocalDateTime;
}

export interface ReminderTimerPort {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export interface ReminderNotificationPort {
  isSupported(): boolean;
  show(notification: ReminderNotification): Promise<void>;
}

export interface ReminderServiceOptions {
  readonly path: string;
  readonly notification: ReminderNotificationPort;
  readonly clock?: ReminderClockPort;
  readonly timer?: ReminderTimerPort;
  readonly locale?: () => ReminderLocale;
}

export interface ReminderService {
  status(): ReminderServiceStatus;
  updateSettings(input: unknown): Promise<ReminderMutationResult>;
  testNotification(): Promise<ReminderTestResult>;
  tick(): Promise<ReminderTickResult>;
  resume(): Promise<ReminderTickResult>;
  dispose(): void;
}

function frozenDefaultStore(): ReminderStoreV2 {
  return Object.freeze({
    schemaVersion: STORE_SCHEMA_VERSION,
    revision: "0",
    settings: DEFAULT_REMINDER_SETTINGS,
    ledger: Object.freeze([]),
  });
}

function validLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !LOCAL_DATE_PATTERN.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function validInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    UTC_INSTANT_PATTERN.test(value) &&
    new Date(value).toISOString() === value
  );
}

function ownRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => !expectedKeys.includes(key))
  ) {
    return null;
  }
  return record;
}

function parseLedgerEntry(value: unknown): ReminderLedgerEntry {
  const base = ownRecord(value, [
    "triggerId",
    "localDate",
    "scheduledTime",
    "state",
    "recordedAt",
  ]);
  const handled = ownRecord(value, [
    "triggerId",
    "localDate",
    "scheduledTime",
    "state",
    "attemptedAt",
    "outcome",
  ]);
  const record = base ?? handled;
  if (
    record === null ||
    !validLocalDate(record["localDate"]) ||
    record["triggerId"] !== `${DAILY_TRIGGER_PREFIX}${record["localDate"]}` ||
    !isReminderTime(record["scheduledTime"])
  ) {
    throw new TypeError("INVALID_REMINDER_STORE");
  }
  if (
    base !== null &&
    base["state"] === "pending" &&
    validInstant(base["recordedAt"])
  ) {
    return Object.freeze({
      triggerId: base["triggerId"] as string,
      localDate: base["localDate"] as string,
      scheduledTime: base["scheduledTime"] as string,
      state: "pending",
      recordedAt: base["recordedAt"],
    });
  }
  if (
    handled !== null &&
    handled["state"] === "handled" &&
    validInstant(handled["attemptedAt"]) &&
    (handled["outcome"] === "attempted" ||
      handled["outcome"] === "shown" ||
      handled["outcome"] === "failed" ||
      handled["outcome"] === "expired")
  ) {
    return Object.freeze({
      triggerId: handled["triggerId"] as string,
      localDate: handled["localDate"] as string,
      scheduledTime: handled["scheduledTime"] as string,
      state: "handled",
      attemptedAt: handled["attemptedAt"],
      outcome: handled["outcome"],
    });
  }
  throw new TypeError("INVALID_REMINDER_STORE");
}

function parsedLedger(input: unknown): readonly ReminderLedgerEntry[] {
  if (!Array.isArray(input) || input.length > MAX_LEDGER_ENTRIES) {
    throw new TypeError("INVALID_REMINDER_STORE");
  }
  const ledger = input.map(parseLedgerEntry);
  if (new Set(ledger.map(({ localDate }) => localDate)).size !== ledger.length) {
    throw new TypeError("INVALID_REMINDER_STORE");
  }
  return Object.freeze(ledger);
}

function parseStore(input: unknown): LoadedReminderStore {
  const current = ownRecord(input, [
    "schemaVersion",
    "revision",
    "settings",
    "ledger",
  ]);
  if (
    current !== null &&
    current["schemaVersion"] === STORE_SCHEMA_VERSION &&
    isReminderRevision(current["revision"])
  ) {
    return Object.freeze({
      store: Object.freeze({
        schemaVersion: STORE_SCHEMA_VERSION,
        revision: current["revision"],
        settings: parseReminderSettings(current["settings"]),
        ledger: parsedLedger(current["ledger"]),
      }),
      migrated: false,
    });
  }

  const legacy = ownRecord(input, ["schemaVersion", "settings", "ledger"]);
  if (
    legacy === null ||
    legacy["schemaVersion"] !== LEGACY_STORE_SCHEMA_VERSION
  ) {
    throw new TypeError("INVALID_REMINDER_STORE");
  }
  return Object.freeze({
    store: Object.freeze({
      schemaVersion: STORE_SCHEMA_VERSION,
      revision: "0",
      settings: parseReminderSettings(legacy["settings"]),
      ledger: parsedLedger(legacy["ledger"]),
    }),
    migrated: true,
  });
}

function systemClock(): ReminderClockPort {
  return Object.freeze({
    now: () => new Date(),
    localDateTime(instant: Date): ReminderLocalDateTime {
      const year = instant.getFullYear().toString().padStart(4, "0");
      const month = (instant.getMonth() + 1).toString().padStart(2, "0");
      const day = instant.getDate().toString().padStart(2, "0");
      return Object.freeze({
        localDate: `${year}-${month}-${day}`,
        hour: instant.getHours(),
        minute: instant.getMinutes(),
      });
    },
  });
}

function systemTimer(): ReminderTimerPort {
  return Object.freeze({
    set: (delayMs: number, callback: () => void) =>
      setTimeout(callback, delayMs),
    clear: (handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("REMINDER_STORAGE_UNAVAILABLE");
  }
  await chmod(path, 0o700);
}

async function atomicWriteStore(
  path: string,
  store: ReminderStoreV2,
): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporaryPath = join(
    directory,
    `.${randomBytes(16).toString("hex")}.reminder.tmp`,
  );
  const body = `${JSON.stringify(store)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_STORE_BYTES) {
    throw new Error("REMINDER_STORAGE_UNAVAILABLE");
  }
  const file = await open(temporaryPath, "wx", 0o600);
  let renamed = false;
  try {
    await file.writeFile(body, "utf8");
    await file.sync();
    await file.close();
    await rename(temporaryPath, path);
    renamed = true;
    await chmod(path, 0o600);
  } finally {
    await file.close().catch(() => undefined);
    if (!renamed)
      await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function loadOrCreateStore(path: string): Promise<ReminderStoreV2> {
  if (!isAbsolute(path)) throw new Error("REMINDER_STORAGE_UNAVAILABLE");
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 2 ||
      metadata.size > MAX_STORE_BYTES
    ) {
      throw new Error("REMINDER_STORAGE_UNAVAILABLE");
    }
    await chmod(path, 0o600);
    const body = await readFile(path, "utf8");
    const loaded = parseStore(JSON.parse(body) as unknown);
    if (loaded.migrated) await atomicWriteStore(path, loaded.store);
    return loaded.store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const store = frozenDefaultStore();
    await atomicWriteStore(path, store);
    return store;
  }
}

function localMinute(parts: ReminderLocalDateTime): number {
  if (
    !validLocalDate(parts.localDate) ||
    !Number.isInteger(parts.hour) ||
    parts.hour < 0 ||
    parts.hour > 23 ||
    !Number.isInteger(parts.minute) ||
    parts.minute < 0 ||
    parts.minute > 59
  ) {
    throw new Error("REMINDER_CLOCK_INVALID");
  }
  return parts.hour * 60 + parts.minute;
}

function triggerId(localDate: string): string {
  return `${DAILY_TRIGGER_PREFIX}${localDate}`;
}

function followingLocalDate(localDate: string): string {
  if (!validLocalDate(localDate)) throw new Error("REMINDER_CLOCK_INVALID");
  const instant = new Date(`${localDate}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString().slice(0, 10);
}

function pendingCanStillBeDelivered(
  entry: Extract<ReminderLedgerEntry, { readonly state: "pending" }>,
  parts: ReminderLocalDateTime,
  minute: number,
  settings: ReminderSettingsV1,
): boolean {
  if (entry.localDate === parts.localDate) return true;
  const quietStart = reminderMinuteOfDay(settings.quietHours.start);
  const quietEnd = reminderMinuteOfDay(settings.quietHours.end);
  const catchUpDeadline = Math.min(
    quietStart,
    quietEnd + CROSS_MIDNIGHT_CATCH_UP_MINUTES,
  );
  return (
    quietStart > quietEnd &&
    parts.localDate === followingLocalDate(entry.localDate) &&
    reminderMinuteOfDay(entry.scheduledTime) >= quietStart &&
    minute < catchUpDeadline
  );
}

function pruneLedger(
  entries: readonly ReminderLedgerEntry[],
): readonly ReminderLedgerEntry[] {
  return Object.freeze(
    [...entries]
      .sort((left, right) => left.localDate.localeCompare(right.localDate))
      .slice(-MAX_LEDGER_ENTRIES),
  );
}

function withLedgerEntry(
  store: ReminderStoreV2,
  entry: ReminderLedgerEntry,
): ReminderStoreV2 {
  return Object.freeze({
    schemaVersion: STORE_SCHEMA_VERSION,
    revision: store.revision,
    settings: store.settings,
    ledger: pruneLedger([
      ...store.ledger.filter(({ localDate }) => localDate !== entry.localDate),
      entry,
    ]),
  });
}

function latestHandledLocalDate(store: ReminderStoreV2): string | null {
  return (
    store.ledger
      .filter(({ state }) => state === "handled")
      .map(({ localDate }) => localDate)
      .sort((left, right) => right.localeCompare(left))[0] ?? null
  );
}

function sameSettings(
  left: ReminderSettingsV1,
  right: ReminderSettingsV1,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.dailySummaryTime === right.dailySummaryTime &&
    left.quietHours.start === right.quietHours.start &&
    left.quietHours.end === right.quietHours.end
  );
}

function incrementRevision(revision: string): string {
  const next = (BigInt(revision) + 1n).toString();
  if (!isReminderRevision(next)) throw new Error("REMINDER_REVISION_EXHAUSTED");
  return next;
}

export async function createReminderService(
  options: ReminderServiceOptions,
): Promise<ReminderService> {
  const clock = options.clock ?? systemClock();
  const timer = options.timer ?? systemTimer();
  const locale = options.locale ?? (() => "zh-TW" as const);
  let store = frozenDefaultStore();
  let storage: "ready" | "unavailable" = "ready";
  try {
    store = await loadOrCreateStore(options.path);
  } catch {
    storage = "unavailable";
  }
  let disposed = false;
  let timerHandle: unknown | null = null;
  let nextCheckAt: string | null = null;
  let operation = Promise.resolve();

  const notificationSupported = (): boolean => {
    try {
      return options.notification.isSupported() === true;
    } catch {
      return false;
    }
  };

  const status = (): ReminderServiceStatus =>
    Object.freeze({
      contractVersion: 1,
      revision: store.revision,
      storage,
      notificationSupported: notificationSupported(),
      enabled: storage === "ready" && store.settings.enabled,
      dailySummaryTime: store.settings.dailySummaryTime,
      quietHours: Object.freeze({ ...store.settings.quietHours }),
      scheduled: timerHandle !== null,
      nextCheckAt,
      lastHandledLocalDate: latestHandledLocalDate(store),
    });

  const cancelTimer = (): void => {
    const handle = timerHandle;
    timerHandle = null;
    nextCheckAt = null;
    if (handle !== null) {
      try {
        timer.clear(handle);
      } catch {
        // A timer adapter cannot keep the service logically scheduled after
        // local state has been cancelled.
      }
    }
  };

  const schedule = (delayMs = CHECK_INTERVAL_MS): void => {
    cancelTimer();
    if (disposed || storage !== "ready" || !store.settings.enabled) {
      return;
    }
    const boundedDelay = Math.max(1, Math.min(CHECK_INTERVAL_MS, delayMs));
    try {
      const now = clock.now();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) return;
      nextCheckAt = new Date(now.getTime() + boundedDelay).toISOString();
      let settingTimer = true;
      let firedSynchronously = false;
      const handle = timer.set(boundedDelay, () => {
        if (settingTimer) {
          firedSynchronously = true;
          return;
        }
        timerHandle = null;
        nextCheckAt = null;
        void runTick().catch(() => undefined);
      });
      settingTimer = false;
      if (firedSynchronously) {
        nextCheckAt = null;
        try {
          timer.clear(handle);
        } catch {
          // A synchronously firing timer is invalid for this scheduler. Keep
          // the logical state unscheduled and do not create a retry loop.
        }
        return;
      }
      timerHandle = handle;
    } catch {
      timerHandle = null;
      nextCheckAt = null;
    }
  };

  const persist = async (next: ReminderStoreV2): Promise<boolean> => {
    try {
      await atomicWriteStore(options.path, next);
      store = next;
      return true;
    } catch {
      storage = "unavailable";
      cancelTimer();
      return false;
    }
  };

  const handledEntry = async (
    entry: ReminderLedgerEntry,
    now: Date,
    deliveryLocalDate: string,
  ): Promise<ReminderTickResult> => {
    if (!notificationSupported()) {
      return Object.freeze({
        outcome: "unsupported",
        triggerId: entry.triggerId,
        status: status(),
      });
    }
    const claimed: ReminderLedgerEntry = Object.freeze({
      triggerId: entry.triggerId,
      localDate: entry.localDate,
      scheduledTime: entry.scheduledTime,
      state: "handled",
      attemptedAt: now.toISOString(),
      outcome: "attempted",
    });
    if (!(await persist(withLedgerEntry(store, claimed)))) {
      return Object.freeze({
        outcome: "storage-unavailable",
        triggerId: entry.triggerId,
        status: status(),
      });
    }
    let outcome: "shown" | "failed" = "shown";
    try {
      const selectedLocale = locale();
      await options.notification.show(
        dailyReminderNotification(
          entry.triggerId,
          selectedLocale === "en" ? "en" : "zh-TW",
          entry.localDate === deliveryLocalDate ? "same-day" : "catch-up",
        ),
      );
    } catch {
      outcome = "failed";
    }
    const completed: ReminderLedgerEntry = Object.freeze({
      ...claimed,
      outcome,
    });
    await persist(withLedgerEntry(store, completed));
    return Object.freeze({
      outcome,
      triggerId: entry.triggerId,
      status: status(),
    });
  };

  const tickUnlocked = async (): Promise<ReminderTickResult> => {
    if (disposed) {
      return Object.freeze({
        outcome: "disposed",
        triggerId: null,
        status: status(),
      });
    }
    if (storage !== "ready") {
      return Object.freeze({
        outcome: "storage-unavailable",
        triggerId: null,
        status: status(),
      });
    }
    if (!store.settings.enabled) {
      return Object.freeze({
        outcome: "disabled",
        triggerId: null,
        status: status(),
      });
    }
    let now: Date;
    let parts: ReminderLocalDateTime;
    let minute: number;
    try {
      now = clock.now();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error("REMINDER_CLOCK_INVALID");
      }
      parts = clock.localDateTime(now);
      minute = localMinute(parts);
    } catch {
      return Object.freeze({
        outcome: "failed",
        triggerId: null,
        status: status(),
      });
    }
    const quiet = isWithinReminderQuietHours(minute, store.settings.quietHours);
    const pending = store.ledger.find(
      (
        entry,
      ): entry is Extract<ReminderLedgerEntry, { readonly state: "pending" }> =>
        entry.state === "pending",
    );
    if (pending !== undefined) {
      if (!pendingCanStillBeDelivered(pending, parts, minute, store.settings)) {
        const expired: ReminderLedgerEntry = Object.freeze({
          triggerId: pending.triggerId,
          localDate: pending.localDate,
          scheduledTime: pending.scheduledTime,
          state: "handled",
          attemptedAt: now.toISOString(),
          outcome: "expired",
        });
        if (!(await persist(withLedgerEntry(store, expired)))) {
          return Object.freeze({
            outcome: "storage-unavailable",
            triggerId: pending.triggerId,
            status: status(),
          });
        }
        return Object.freeze({
          outcome: "expired",
          triggerId: pending.triggerId,
          status: status(),
        });
      }
      if (quiet) {
        return Object.freeze({
          outcome: "quiet",
          triggerId: pending.triggerId,
          status: status(),
        });
      }
      return handledEntry(pending, now, parts.localDate);
    }
    const id = triggerId(parts.localDate);
    const existing = store.ledger.find(
      ({ localDate }) => localDate === parts.localDate,
    );
    if (existing?.state === "handled") {
      return Object.freeze({
        outcome: "duplicate",
        triggerId: id,
        status: status(),
      });
    }
    if (minute < reminderMinuteOfDay(store.settings.dailySummaryTime)) {
      return Object.freeze({
        outcome: "not-due",
        triggerId: id,
        status: status(),
      });
    }
    const candidate: ReminderLedgerEntry = Object.freeze({
      triggerId: id,
      localDate: parts.localDate,
      scheduledTime: store.settings.dailySummaryTime,
      state: "pending",
      recordedAt: now.toISOString(),
    });
    if (quiet) {
      if (!(await persist(withLedgerEntry(store, candidate)))) {
        return Object.freeze({
          outcome: "storage-unavailable",
          triggerId: id,
          status: status(),
        });
      }
      return Object.freeze({
        outcome: "quiet",
        triggerId: id,
        status: status(),
      });
    }
    return handledEntry(candidate, now, parts.localDate);
  };

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = operation.then(work, work);
    operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const runTick = (): Promise<ReminderTickResult> =>
    enqueue(async () => {
      const result = await tickUnlocked();
      schedule();
      return Object.freeze({ ...result, status: status() });
    });

  if (storage === "ready" && store.settings.enabled) {
    schedule(INITIAL_CHECK_DELAY_MS);
  }

  return Object.freeze({
    status,
    updateSettings(input: unknown): Promise<ReminderMutationResult> {
      let expectedRevision: string;
      let settings: ReminderSettingsV1;
      try {
        const request = parseReminderSettingsRequest(input);
        expectedRevision = request.expectedRevision;
        settings = Object.freeze({
          schemaVersion: "1",
          enabled: request.enabled,
          dailySummaryTime: request.dailySummaryTime,
          quietHours: request.quietHours,
        });
      } catch {
        return Promise.resolve(
          Object.freeze({
            ok: false,
            error: "invalid-request",
            status: status(),
          }),
        );
      }
      return enqueue(async () => {
        if (disposed) {
          return Object.freeze({
            ok: false,
            error: "disposed",
            status: status(),
          });
        }
        if (storage !== "ready") {
          return Object.freeze({
            ok: false,
            error: "storage-unavailable",
            status: status(),
          });
        }
        if (expectedRevision !== store.revision) {
          return Object.freeze({
            ok: false,
            error: "conflict",
            status: status(),
          });
        }
        if (sameSettings(settings, store.settings)) {
          if (settings.enabled && timerHandle === null) {
            schedule(INITIAL_CHECK_DELAY_MS);
          }
          return Object.freeze({ ok: true, status: status() });
        }
        let revision: string;
        try {
          revision = incrementRevision(store.revision);
        } catch {
          return Object.freeze({
            ok: false,
            error: "storage-unavailable",
            status: status(),
          });
        }
        const next: ReminderStoreV2 = Object.freeze({
          schemaVersion: STORE_SCHEMA_VERSION,
          revision,
          settings,
          // A changed schedule cancels an unsent recap. Handled dates remain
          // bounded so toggling off/on cannot duplicate today's notification.
          ledger: pruneLedger(
            store.ledger.filter(({ state }) => state === "handled"),
          ),
        });
        if (!(await persist(next))) {
          return Object.freeze({
            ok: false,
            error: "storage-unavailable",
            status: status(),
          });
        }
        if (settings.enabled) schedule(INITIAL_CHECK_DELAY_MS);
        else cancelTimer();
        return Object.freeze({ ok: true, status: status() });
      });
    },
    testNotification(): Promise<ReminderTestResult> {
      return enqueue(async () => {
        if (disposed) {
          return Object.freeze({ outcome: "disposed", status: status() });
        }
        if (!notificationSupported()) {
          return Object.freeze({ outcome: "unsupported", status: status() });
        }
        try {
          const selectedLocale = locale();
          await options.notification.show(
            testReminderNotification(selectedLocale === "en" ? "en" : "zh-TW"),
          );
          return Object.freeze({ outcome: "shown", status: status() });
        } catch {
          return Object.freeze({ outcome: "failed", status: status() });
        }
      });
    },
    tick: runTick,
    resume(): Promise<ReminderTickResult> {
      cancelTimer();
      return runTick();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelTimer();
    },
  });
}
