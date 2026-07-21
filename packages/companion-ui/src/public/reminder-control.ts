import type { TokenMonsterCompanionBridge } from "./share-card.js";
import { localizeUiText } from "./localization.js";

export interface ReminderQuietHours {
  readonly start: string;
  readonly end: string;
}

export interface ReminderStatus {
  readonly contractVersion: 1;
  readonly revision: string;
  readonly storage: "ready" | "unavailable";
  readonly notificationSupported: boolean;
  readonly enabled: boolean;
  readonly dailySummaryTime: string;
  readonly quietHours: ReminderQuietHours;
  readonly scheduled: boolean;
  readonly nextCheckAt: string | null;
  readonly lastHandledLocalDate: string | null;
}

export type ReminderMutationResponse =
  | Readonly<{ ok: true; status: ReminderStatus }>
  | Readonly<{
      ok: false;
      error:
        | "invalid-request"
        | "conflict"
        | "storage-unavailable"
        | "disposed";
      status: ReminderStatus;
    }>;

export interface ReminderTestResponse {
  readonly outcome: "shown" | "unsupported" | "failed" | "disposed";
  readonly status: ReminderStatus;
}

const TIME_PATTERN = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REVISION_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u;

function isValidRevision(value: unknown): value is string {
  return (
    typeof value === "string" &&
    REVISION_PATTERN.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n
  );
}

function isValidInstant(value: string): boolean {
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
}

function isValidLocalDate(value: string): boolean {
  const instant = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(instant.getTime()) &&
    instant.toISOString().slice(0, 10) === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

export function parseReminderStatus(value: unknown): ReminderStatus {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
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
    ]) ||
    value["contractVersion"] !== 1 ||
    !isValidRevision(value["revision"]) ||
    (value["storage"] !== "ready" && value["storage"] !== "unavailable") ||
    typeof value["notificationSupported"] !== "boolean" ||
    typeof value["enabled"] !== "boolean" ||
    typeof value["dailySummaryTime"] !== "string" ||
    !TIME_PATTERN.test(value["dailySummaryTime"]) ||
    !isRecord(value["quietHours"]) ||
    !exactKeys(value["quietHours"], ["start", "end"]) ||
    typeof value["quietHours"]["start"] !== "string" ||
    !TIME_PATTERN.test(value["quietHours"]["start"]) ||
    typeof value["quietHours"]["end"] !== "string" ||
    !TIME_PATTERN.test(value["quietHours"]["end"]) ||
    typeof value["scheduled"] !== "boolean" ||
    (value["nextCheckAt"] !== null &&
      (typeof value["nextCheckAt"] !== "string" ||
        !INSTANT_PATTERN.test(value["nextCheckAt"]) ||
        !isValidInstant(value["nextCheckAt"]))) ||
    (value["lastHandledLocalDate"] !== null &&
      (typeof value["lastHandledLocalDate"] !== "string" ||
        !DATE_PATTERN.test(value["lastHandledLocalDate"]) ||
        !isValidLocalDate(value["lastHandledLocalDate"]))) ||
    (value["storage"] === "unavailable" &&
      (value["enabled"] || value["scheduled"])) ||
    (value["scheduled"] && (!value["enabled"] || value["nextCheckAt"] === null)) ||
    (!value["scheduled"] && value["nextCheckAt"] !== null)
  ) {
    throw new TypeError("Invalid reminder status");
  }
  return Object.freeze({
    contractVersion: 1,
    revision: value["revision"],
    storage: value["storage"],
    notificationSupported: value["notificationSupported"],
    enabled: value["enabled"],
    dailySummaryTime: value["dailySummaryTime"],
    quietHours: Object.freeze({
      start: value["quietHours"]["start"],
      end: value["quietHours"]["end"],
    }),
    scheduled: value["scheduled"],
    nextCheckAt: value["nextCheckAt"],
    lastHandledLocalDate: value["lastHandledLocalDate"],
  });
}

function parseReminderMutation(value: unknown): ReminderMutationResponse {
  if (!isRecord(value)) throw new TypeError("Invalid reminder mutation");
  if (value["ok"] === true && exactKeys(value, ["ok", "status"])) {
    return Object.freeze({ ok: true, status: parseReminderStatus(value["status"]) });
  }
  if (
    value["ok"] === false &&
    exactKeys(value, ["ok", "error", "status"]) &&
    (value["error"] === "invalid-request" ||
      value["error"] === "conflict" ||
      value["error"] === "storage-unavailable" ||
      value["error"] === "disposed")
  ) {
    return Object.freeze({
      ok: false,
      error: value["error"],
      status: parseReminderStatus(value["status"]),
    });
  }
  throw new TypeError("Invalid reminder mutation");
}

function parseReminderTest(value: unknown): ReminderTestResponse {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["outcome", "status"]) ||
    (value["outcome"] !== "shown" &&
      value["outcome"] !== "unsupported" &&
      value["outcome"] !== "failed" &&
      value["outcome"] !== "disposed")
  ) {
    throw new TypeError("Invalid reminder test response");
  }
  return Object.freeze({
    outcome: value["outcome"],
    status: parseReminderStatus(value["status"]),
  });
}

export function reminderBridge(
  bridge: TokenMonsterCompanionBridge | undefined,
): Required<
  Pick<
    TokenMonsterCompanionBridge,
    "getReminderStatus" | "updateReminderSettings" | "testReminder"
  >
> | null {
  return typeof bridge?.getReminderStatus === "function" &&
    typeof bridge.updateReminderSettings === "function" &&
    typeof bridge.testReminder === "function"
    ? {
        getReminderStatus: bridge.getReminderStatus,
        updateReminderSettings: bridge.updateReminderSettings,
        testReminder: bridge.testReminder,
      }
    : null;
}

export async function readReminderStatus(
  bridge: NonNullable<ReturnType<typeof reminderBridge>>,
): Promise<ReminderStatus> {
  return parseReminderStatus(await bridge.getReminderStatus());
}

export async function saveReminderSettings(
  bridge: NonNullable<ReturnType<typeof reminderBridge>>,
  settings: Readonly<{
    expectedRevision: string;
    enabled: boolean;
    dailySummaryTime: string;
    quietHours: ReminderQuietHours;
  }>,
): Promise<ReminderMutationResponse> {
  if (
    !isValidRevision(settings.expectedRevision) ||
    !TIME_PATTERN.test(settings.dailySummaryTime) ||
    !TIME_PATTERN.test(settings.quietHours.start) ||
    !TIME_PATTERN.test(settings.quietHours.end)
  ) {
    throw new TypeError("Invalid reminder settings");
  }
  return parseReminderMutation(await bridge.updateReminderSettings(settings));
}

export async function sendReminderTest(
  bridge: NonNullable<ReturnType<typeof reminderBridge>>,
): Promise<ReminderTestResponse> {
  return parseReminderTest(await bridge.testReminder());
}

export function reminderStatusText(
  status: ReminderStatus,
  notice?: string,
): string {
  const base = (() => {
    if (status.storage === "unavailable") {
      return "提醒設定暫時無法使用；每日提醒保持關閉。";
    }
    if (!status.notificationSupported) {
      return status.enabled
        ? "設定已保存在本機，但這個系統目前不支援通知，因此不會顯示提醒。"
        : "這個系統目前不支援通知；每日提醒仍保持關閉。";
    }
    if (!status.enabled) {
      return "每日提醒目前關閉；設定只會保存在這台裝置。";
    }
    if (!status.scheduled) {
      return "設定已保存在本機，但排程暫時沒有啟動；重新啟動 TokenMonster 後會再嘗試。";
    }
    const quiet =
      status.quietHours.start === status.quietHours.end
        ? "安靜時段已停用"
        : `安靜時段 ${status.quietHours.start}–${status.quietHours.end}`;
    return `每天 ${status.dailySummaryTime} 檢查本機摘要；${quiet}。`;
  })();
  const localizedBase = localizeUiText(base);
  return notice === undefined
    ? localizedBase
    : `${localizeUiText(notice)} ${localizedBase}`;
}
