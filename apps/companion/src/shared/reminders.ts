export const REMINDER_SETTINGS_SCHEMA_VERSION = "1" as const;

export const REMINDER_IPC_CHANNELS = Object.freeze({
  status: "tokenmonster:companion:reminder-status",
  update: "tokenmonster:companion:update-reminders",
  test: "tokenmonster:companion:test-reminder",
} as const);

export type ReminderLocale = "zh-TW" | "en";

export type ReminderRevision = string;

export interface ReminderQuietHours {
  readonly start: string;
  readonly end: string;
}

export interface ReminderSettingsV1 {
  readonly schemaVersion: typeof REMINDER_SETTINGS_SCHEMA_VERSION;
  readonly enabled: boolean;
  readonly dailySummaryTime: string;
  readonly quietHours: ReminderQuietHours;
}

export interface ReminderSettingsRequest {
  readonly expectedRevision: ReminderRevision;
  readonly enabled: boolean;
  readonly dailySummaryTime: string;
  readonly quietHours: ReminderQuietHours;
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettingsV1 = Object.freeze({
  schemaVersion: REMINDER_SETTINGS_SCHEMA_VERSION,
  enabled: false,
  dailySummaryTime: "18:00",
  quietHours: Object.freeze({ start: "22:00", end: "08:00" }),
});

export type ReminderStorageStatus = "ready" | "unavailable";

export interface ReminderServiceStatus {
  readonly contractVersion: 1;
  readonly revision: ReminderRevision;
  readonly storage: ReminderStorageStatus;
  readonly notificationSupported: boolean;
  readonly enabled: boolean;
  readonly dailySummaryTime: string;
  readonly quietHours: ReminderQuietHours;
  readonly scheduled: boolean;
  readonly nextCheckAt: string | null;
  readonly lastHandledLocalDate: string | null;
}

export type ReminderMutationError =
  | "invalid-request"
  | "conflict"
  | "storage-unavailable"
  | "disposed";

export type ReminderMutationResult =
  | Readonly<{
      ok: true;
      status: ReminderServiceStatus;
    }>
  | Readonly<{
      ok: false;
      error: ReminderMutationError;
      status: ReminderServiceStatus;
    }>;

export type ReminderTestOutcome =
  "shown" | "unsupported" | "failed" | "disposed";

export interface ReminderTestResult {
  readonly outcome: ReminderTestOutcome;
  readonly status: ReminderServiceStatus;
}

export interface TokenMonsterReminderBridge {
  getReminderStatus(): Promise<ReminderServiceStatus>;
  updateReminderSettings(
    input: ReminderSettingsRequest,
  ): Promise<ReminderMutationResult>;
  testReminder(): Promise<ReminderTestResult>;
}

export type ReminderTickOutcome =
  | "shown"
  | "failed"
  | "unsupported"
  | "disabled"
  | "not-due"
  | "quiet"
  | "duplicate"
  | "expired"
  | "storage-unavailable"
  | "disposed";

export interface ReminderTickResult {
  readonly outcome: ReminderTickOutcome;
  readonly triggerId: string | null;
  readonly status: ReminderServiceStatus;
}

export interface ReminderNotification {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly silent: boolean;
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Renderer values cross an Electron context boundary and have another realm's
 * Object prototype. Accept only a genuine plain object from either realm. */
function isCrossRealmPlainRecord(
  value: unknown,
): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype === null) return true;
    const constructor = Object.getOwnPropertyDescriptor(
      prototype,
      "constructor",
    )?.value;
    return (
      Object.prototype.toString.call(value) === "[object Object]" &&
      Object.getPrototypeOf(prototype) === null &&
      typeof constructor === "function" &&
      constructor.name === "Object"
    );
  } catch {
    return false;
  }
}

function exactOwnDataRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<PropertyKey, unknown> | null {
  if (!isPlainRecord(input)) return null;
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return null;
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) return null;
  }
  return input;
}

function exactCrossRealmDataRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<PropertyKey, unknown> | null {
  if (!isCrossRealmPlainRecord(input)) return null;
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return null;
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) return null;
  }
  return input;
}

function ownValue(record: Record<PropertyKey, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor === undefined || !("value" in descriptor)
    ? undefined
    : descriptor.value;
}

export function isReminderTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u.test(value)
  );
}

export function isReminderRevision(value: unknown): value is ReminderRevision {
  return (
    typeof value === "string" &&
    /^(?:0|[1-9][0-9]{0,19})$/u.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n
  );
}

export function reminderMinuteOfDay(value: string): number {
  if (!isReminderTime(value)) throw new TypeError("INVALID_REMINDER_TIME");
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

export function parseReminderSettings(input: unknown): ReminderSettingsV1 {
  const record = exactOwnDataRecord(input, [
    "schemaVersion",
    "enabled",
    "dailySummaryTime",
    "quietHours",
  ]);
  if (record === null) throw new TypeError("INVALID_REMINDER_SETTINGS");
  const quiet = exactOwnDataRecord(ownValue(record, "quietHours"), [
    "start",
    "end",
  ]);
  const enabled = ownValue(record, "enabled");
  const dailySummaryTime = ownValue(record, "dailySummaryTime");
  const start = quiet === null ? undefined : ownValue(quiet, "start");
  const end = quiet === null ? undefined : ownValue(quiet, "end");
  if (
    ownValue(record, "schemaVersion") !== REMINDER_SETTINGS_SCHEMA_VERSION ||
    typeof enabled !== "boolean" ||
    !isReminderTime(dailySummaryTime) ||
    !isReminderTime(start) ||
    !isReminderTime(end)
  ) {
    throw new TypeError("INVALID_REMINDER_SETTINGS");
  }
  return Object.freeze({
    schemaVersion: REMINDER_SETTINGS_SCHEMA_VERSION,
    enabled,
    dailySummaryTime,
    quietHours: Object.freeze({ start, end }),
  });
}

/** Validate the exact compare-and-swap request crossing the renderer boundary. */
export function parseReminderSettingsRequest(
  input: unknown,
): ReminderSettingsRequest {
  const record = exactCrossRealmDataRecord(input, [
    "expectedRevision",
    "enabled",
    "dailySummaryTime",
    "quietHours",
  ]);
  if (record === null) throw new TypeError("INVALID_REMINDER_SETTINGS");
  const quiet = exactCrossRealmDataRecord(ownValue(record, "quietHours"), [
    "start",
    "end",
  ]);
  const expectedRevision = ownValue(record, "expectedRevision");
  const enabled = ownValue(record, "enabled");
  const dailySummaryTime = ownValue(record, "dailySummaryTime");
  const start = quiet === null ? undefined : ownValue(quiet, "start");
  const end = quiet === null ? undefined : ownValue(quiet, "end");
  if (
    !isReminderRevision(expectedRevision) ||
    typeof enabled !== "boolean" ||
    !isReminderTime(dailySummaryTime) ||
    !isReminderTime(start) ||
    !isReminderTime(end)
  ) {
    throw new TypeError("INVALID_REMINDER_SETTINGS");
  }
  return Object.freeze({
    expectedRevision,
    enabled,
    dailySummaryTime,
    quietHours: Object.freeze({ start, end }),
  });
}

function validUtcInstant(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    return false;
  }
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
}

function validLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(instant.getTime()) &&
    instant.toISOString().slice(0, 10) === value
  );
}

export function parseReminderServiceStatus(
  input: unknown,
): ReminderServiceStatus {
  const record = exactOwnDataRecord(input, [
    "contractVersion",
    "revision",
    "storage",
    "notificationSupported",
    "enabled",
    "dailySummaryTime",
    "quietHours",
    "scheduled",
    "nextCheckAt",
    "lastHandledLocalDate",
  ]);
  if (record === null) throw new TypeError("INVALID_REMINDER_STATUS");
  const quiet = exactOwnDataRecord(ownValue(record, "quietHours"), [
    "start",
    "end",
  ]);
  const revision = ownValue(record, "revision");
  const storage = ownValue(record, "storage");
  const notificationSupported = ownValue(record, "notificationSupported");
  const enabled = ownValue(record, "enabled");
  const dailySummaryTime = ownValue(record, "dailySummaryTime");
  const scheduled = ownValue(record, "scheduled");
  const nextCheckAt = ownValue(record, "nextCheckAt");
  const lastHandledLocalDate = ownValue(record, "lastHandledLocalDate");
  const quietStart = quiet === null ? undefined : ownValue(quiet, "start");
  const quietEnd = quiet === null ? undefined : ownValue(quiet, "end");
  if (
    ownValue(record, "contractVersion") !== 1 ||
    !isReminderRevision(revision) ||
    (storage !== "ready" && storage !== "unavailable") ||
    typeof notificationSupported !== "boolean" ||
    typeof enabled !== "boolean" ||
    !isReminderTime(dailySummaryTime) ||
    !isReminderTime(quietStart) ||
    !isReminderTime(quietEnd) ||
    typeof scheduled !== "boolean" ||
    (nextCheckAt !== null && !validUtcInstant(nextCheckAt)) ||
    (lastHandledLocalDate !== null && !validLocalDate(lastHandledLocalDate)) ||
    (storage === "unavailable" && (enabled || scheduled)) ||
    (scheduled && (!enabled || nextCheckAt === null)) ||
    (!scheduled && nextCheckAt !== null)
  ) {
    throw new TypeError("INVALID_REMINDER_STATUS");
  }
  return Object.freeze({
    contractVersion: 1,
    revision,
    storage,
    notificationSupported,
    enabled,
    dailySummaryTime,
    quietHours: Object.freeze({ start: quietStart, end: quietEnd }),
    scheduled,
    nextCheckAt,
    lastHandledLocalDate,
  });
}

export function parseReminderMutationResult(
  input: unknown,
): ReminderMutationResult {
  const success = exactOwnDataRecord(input, ["ok", "status"]);
  if (success !== null && ownValue(success, "ok") === true) {
    return Object.freeze({
      ok: true,
      status: parseReminderServiceStatus(ownValue(success, "status")),
    });
  }
  const failure = exactOwnDataRecord(input, ["ok", "error", "status"]);
  const error = failure === null ? undefined : ownValue(failure, "error");
  if (
    failure === null ||
    ownValue(failure, "ok") !== false ||
    (error !== "invalid-request" &&
      error !== "conflict" &&
      error !== "storage-unavailable" &&
      error !== "disposed")
  ) {
    throw new TypeError("INVALID_REMINDER_MUTATION_RESULT");
  }
  return Object.freeze({
    ok: false,
    error,
    status: parseReminderServiceStatus(ownValue(failure, "status")),
  });
}

export function parseReminderTestResult(input: unknown): ReminderTestResult {
  const record = exactOwnDataRecord(input, ["outcome", "status"]);
  const outcome = record === null ? undefined : ownValue(record, "outcome");
  if (
    record === null ||
    (outcome !== "shown" &&
      outcome !== "unsupported" &&
      outcome !== "failed" &&
      outcome !== "disposed")
  ) {
    throw new TypeError("INVALID_REMINDER_TEST_RESULT");
  }
  return Object.freeze({
    outcome,
    status: parseReminderServiceStatus(ownValue(record, "status")),
  });
}

/** Equal endpoints explicitly disable quiet hours. End is exclusive. */
export function isWithinReminderQuietHours(
  minuteOfDay: number,
  quietHours: ReminderQuietHours,
): boolean {
  if (
    !Number.isInteger(minuteOfDay) ||
    minuteOfDay < 0 ||
    minuteOfDay >= 24 * 60
  ) {
    throw new TypeError("INVALID_REMINDER_MINUTE");
  }
  const start = reminderMinuteOfDay(quietHours.start);
  const end = reminderMinuteOfDay(quietHours.end);
  if (start === end) return false;
  return start < end
    ? minuteOfDay >= start && minuteOfDay < end
    : minuteOfDay >= start || minuteOfDay < end;
}

export function dailyReminderNotification(
  triggerId: string,
  locale: ReminderLocale,
  timing: "same-day" | "catch-up" = "same-day",
): ReminderNotification {
  if (timing === "catch-up") {
    return locale === "en"
      ? Object.freeze({
          id: triggerId,
          title: "Your TokenMonster companion is here",
          body: "Your previous local AI recap is ready. Come back whenever you feel like seeing how your companion is doing.",
          silent: false,
        })
      : Object.freeze({
          id: triggerId,
          title: "你的 TokenMonster 夥伴來報到",
          body: "上一份本機 AI 足跡摘要已整理好；有空再回來看看夥伴的近況。",
          silent: false,
        });
  }
  return locale === "en"
    ? Object.freeze({
        id: triggerId,
        title: "Your TokenMonster companion is here",
        body: "Your local AI footprint is ready. Come back whenever you feel like seeing how your companion is doing.",
        silent: false,
      })
    : Object.freeze({
        id: triggerId,
        title: "你的 TokenMonster 夥伴來報到",
        body: "今天的本機 AI 足跡已整理好；有空再回來看看夥伴的近況。",
        silent: false,
      });
}

export function testReminderNotification(
  locale: ReminderLocale,
): ReminderNotification {
  return locale === "en"
    ? Object.freeze({
        id: "tokenmonster-reminder-test",
        title: "TokenMonster reminders are ready",
        body: "This is a local test. You can change daily summaries and quiet hours whenever you like.",
        silent: false,
      })
    : Object.freeze({
        id: "tokenmonster-reminder-test",
        title: "TokenMonster 提醒已準備好",
        body: "這是一則本機測試；每日摘要與安靜時段都可以隨時調整。",
        silent: false,
      });
}
