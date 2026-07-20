import type { TokenMonsterCompanionBridge } from "./share-card.js";

export type AutomaticUpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export type AutomaticUpdateErrorCode =
  | "updater-unavailable"
  | "feed-unavailable"
  | "clock-unavailable"
  | "scheduler-unavailable"
  | "check-failed"
  | "download-failed"
  | "invalid-update"
  | "install-failed";

export interface AutomaticUpdateState {
  readonly contractVersion: 1;
  readonly currentVersion: string;
  readonly channel: "latest" | "next";
  readonly status: AutomaticUpdatePhase;
  readonly lastCheckedAt: string | null;
  readonly availableVersion: string | null;
  readonly errorCode: AutomaticUpdateErrorCode | null;
}

export interface AutomaticUpdateStatus {
  readonly contractVersion: 1;
  readonly revision: string;
  readonly preferenceStorage: "ready" | "unavailable";
  readonly automaticChecksEnabled: boolean;
  readonly update: AutomaticUpdateState;
}

export type AutomaticUpdatePreferenceResponse =
  | Readonly<{ ok: true; status: AutomaticUpdateStatus }>
  | Readonly<{
      ok: false;
      error:
        | "invalid-request"
        | "conflict"
        | "storage-unavailable"
        | "disposed";
      status: AutomaticUpdateStatus;
    }>;

export type AutomaticUpdateCommandCode =
  | "check-started"
  | "check-busy"
  | "install-started"
  | "install-busy"
  | "not-ready"
  | "unsupported"
  | "disposed"
  | "failed";

export interface AutomaticUpdateCommandResponse {
  readonly ok: boolean;
  readonly code: AutomaticUpdateCommandCode;
  readonly status: AutomaticUpdateStatus;
}

const VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([A-Za-z][0-9A-Za-z-]*)(?:\.(0|[1-9][0-9]*))?)?$/u;
const REVISION_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u;
const INSTANT_PATTERN =
  /^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;
const UPDATE_PHASES = new Set<AutomaticUpdatePhase>([
  "unsupported",
  "idle",
  "checking",
  "available",
  "downloading",
  "ready",
  "error",
]);
const UPDATE_ERRORS = new Set<AutomaticUpdateErrorCode>([
  "updater-unavailable",
  "feed-unavailable",
  "clock-unavailable",
  "scheduler-unavailable",
  "check-failed",
  "download-failed",
  "invalid-update",
  "install-failed",
]);
const COMMAND_CODES = new Set<AutomaticUpdateCommandCode>([
  "check-started",
  "check-busy",
  "install-started",
  "install-busy",
  "not-ready",
  "unsupported",
  "disposed",
  "failed",
]);

function exactRecord(
  input: unknown,
  keys: readonly string[],
): Record<PropertyKey, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const actual = Reflect.ownKeys(input);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return null;
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) return null;
  }
  return input as Record<PropertyKey, unknown>;
}

function ownValue(
  record: Record<PropertyKey, unknown>,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor === undefined || !("value" in descriptor)
    ? undefined
    : descriptor.value;
}

function validRevision(value: unknown): value is string {
  return (
    typeof value === "string" &&
    REVISION_PATTERN.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n
  );
}

function validVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    return false;
  }
  const match = VERSION_PATTERN.exec(value);
  return (
    match !== null &&
    !/\d$/u.test(match[4] ?? "") &&
    [match[1], match[2], match[3], match[5]]
      .filter((part): part is string => part !== undefined)
      .every((part) => BigInt(part) <= 65_535n)
  );
}

function validInstant(value: unknown): value is string {
  if (typeof value !== "string" || !INSTANT_PATTERN.test(value)) return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
}

export function parseAutomaticUpdateState(
  input: unknown,
): AutomaticUpdateState {
  const record = exactRecord(input, [
    "contractVersion",
    "currentVersion",
    "channel",
    "status",
    "lastCheckedAt",
    "availableVersion",
    "errorCode",
  ]);
  if (record === null) throw new TypeError("Invalid automatic update state");
  const currentVersion = ownValue(record, "currentVersion");
  const channel = ownValue(record, "channel");
  const phase = ownValue(record, "status");
  const lastCheckedAt = ownValue(record, "lastCheckedAt");
  const availableVersion = ownValue(record, "availableVersion");
  const errorCode = ownValue(record, "errorCode");
  if (
    ownValue(record, "contractVersion") !== 1 ||
    !validVersion(currentVersion) ||
    (channel !== "latest" && channel !== "next") ||
    channel !== (currentVersion.includes("-") ? "next" : "latest") ||
    typeof phase !== "string" ||
    !UPDATE_PHASES.has(phase as AutomaticUpdatePhase) ||
    (lastCheckedAt !== null && !validInstant(lastCheckedAt)) ||
    (availableVersion !== null && !validVersion(availableVersion)) ||
    (errorCode !== null &&
      (typeof errorCode !== "string" ||
        !UPDATE_ERRORS.has(errorCode as AutomaticUpdateErrorCode))) ||
    (phase === "error") !== (errorCode !== null) ||
    ((phase === "unsupported" ||
      phase === "idle" ||
      phase === "checking") &&
      availableVersion !== null) ||
    (phase === "ready" && availableVersion === null)
  ) {
    throw new TypeError("Invalid automatic update state");
  }
  return Object.freeze({
    contractVersion: 1,
    currentVersion,
    channel,
    status: phase as AutomaticUpdatePhase,
    lastCheckedAt,
    availableVersion,
    errorCode: errorCode as AutomaticUpdateErrorCode | null,
  });
}

export function parseAutomaticUpdateStatus(
  input: unknown,
): AutomaticUpdateStatus {
  const record = exactRecord(input, [
    "contractVersion",
    "revision",
    "preferenceStorage",
    "automaticChecksEnabled",
    "update",
  ]);
  if (record === null) throw new TypeError("Invalid automatic update status");
  const revision = ownValue(record, "revision");
  const preferenceStorage = ownValue(record, "preferenceStorage");
  const automaticChecksEnabled = ownValue(
    record,
    "automaticChecksEnabled",
  );
  if (
    ownValue(record, "contractVersion") !== 1 ||
    !validRevision(revision) ||
    (preferenceStorage !== "ready" && preferenceStorage !== "unavailable") ||
    typeof automaticChecksEnabled !== "boolean" ||
    (preferenceStorage === "unavailable" && automaticChecksEnabled)
  ) {
    throw new TypeError("Invalid automatic update status");
  }
  return Object.freeze({
    contractVersion: 1,
    revision,
    preferenceStorage,
    automaticChecksEnabled,
    update: parseAutomaticUpdateState(ownValue(record, "update")),
  });
}

function parsePreferenceResponse(
  input: unknown,
): AutomaticUpdatePreferenceResponse {
  const success = exactRecord(input, ["ok", "status"]);
  if (success !== null && ownValue(success, "ok") === true) {
    return Object.freeze({
      ok: true,
      status: parseAutomaticUpdateStatus(ownValue(success, "status")),
    });
  }
  const failure = exactRecord(input, ["ok", "error", "status"]);
  const error = failure === null ? undefined : ownValue(failure, "error");
  if (
    failure === null ||
    ownValue(failure, "ok") !== false ||
    (error !== "invalid-request" &&
      error !== "conflict" &&
      error !== "storage-unavailable" &&
      error !== "disposed")
  ) {
    throw new TypeError("Invalid automatic update preference response");
  }
  return Object.freeze({
    ok: false,
    error,
    status: parseAutomaticUpdateStatus(ownValue(failure, "status")),
  });
}

function parseCommandResponse(input: unknown): AutomaticUpdateCommandResponse {
  const record = exactRecord(input, ["ok", "code", "status"]);
  if (record === null) throw new TypeError("Invalid automatic update command");
  const ok = ownValue(record, "ok");
  const code = ownValue(record, "code");
  if (
    typeof ok !== "boolean" ||
    typeof code !== "string" ||
    !COMMAND_CODES.has(code as AutomaticUpdateCommandCode) ||
    ok !== (code === "check-started" || code === "install-started")
  ) {
    throw new TypeError("Invalid automatic update command");
  }
  return Object.freeze({
    ok,
    code: code as AutomaticUpdateCommandCode,
    status: parseAutomaticUpdateStatus(ownValue(record, "status")),
  });
}

export function automaticUpdateBridge(
  bridge: TokenMonsterCompanionBridge | undefined,
): Required<
  Pick<
    TokenMonsterCompanionBridge,
    | "getAutomaticUpdateStatus"
    | "updateAutomaticChecks"
    | "checkForAutomaticUpdate"
    | "installAutomaticUpdate"
  >
> | null {
  return typeof bridge?.getAutomaticUpdateStatus === "function" &&
    typeof bridge.updateAutomaticChecks === "function" &&
    typeof bridge.checkForAutomaticUpdate === "function" &&
    typeof bridge.installAutomaticUpdate === "function"
    ? {
        getAutomaticUpdateStatus: bridge.getAutomaticUpdateStatus,
        updateAutomaticChecks: bridge.updateAutomaticChecks,
        checkForAutomaticUpdate: bridge.checkForAutomaticUpdate,
        installAutomaticUpdate: bridge.installAutomaticUpdate,
      }
    : null;
}

export async function readAutomaticUpdateStatus(
  bridge: NonNullable<ReturnType<typeof automaticUpdateBridge>>,
): Promise<AutomaticUpdateStatus> {
  return parseAutomaticUpdateStatus(await bridge.getAutomaticUpdateStatus());
}

export async function saveAutomaticUpdatePreference(
  bridge: NonNullable<ReturnType<typeof automaticUpdateBridge>>,
  request: Readonly<{
    expectedRevision: string;
    automaticChecksEnabled: boolean;
  }>,
): Promise<AutomaticUpdatePreferenceResponse> {
  const record = exactRecord(request, [
    "expectedRevision",
    "automaticChecksEnabled",
  ]);
  const expectedRevision =
    record === null ? undefined : ownValue(record, "expectedRevision");
  const automaticChecksEnabled =
    record === null ? undefined : ownValue(record, "automaticChecksEnabled");
  if (
    !validRevision(expectedRevision) ||
    typeof automaticChecksEnabled !== "boolean"
  ) {
    throw new TypeError("Invalid automatic update preference");
  }
  return parsePreferenceResponse(
    await bridge.updateAutomaticChecks(
      Object.freeze({ expectedRevision, automaticChecksEnabled }),
    ),
  );
}

export async function requestAutomaticUpdateCheck(
  bridge: NonNullable<ReturnType<typeof automaticUpdateBridge>>,
): Promise<AutomaticUpdateCommandResponse> {
  return parseCommandResponse(await bridge.checkForAutomaticUpdate());
}

export async function requestAutomaticUpdateInstall(
  bridge: NonNullable<ReturnType<typeof automaticUpdateBridge>>,
): Promise<AutomaticUpdateCommandResponse> {
  return parseCommandResponse(await bridge.installAutomaticUpdate());
}

export function automaticUpdateStatusText(
  status: AutomaticUpdateStatus,
  notice?: string,
): string {
  const update = status.update;
  const base = (() => {
    if (update.status === "unsupported") {
      return "這個平台目前不支援應用程式內更新。";
    }
    if (update.status === "checking") {
      return "正在安全地檢查新版 TokenMonster。";
    }
    if (update.status === "available" || update.status === "downloading") {
      return "已找到新版，正在背景下載並驗證安裝檔。";
    }
    if (update.status === "ready") {
      return `TokenMonster ${update.availableVersion ?? "新版"} 已準備好安裝。`;
    }
    if (update.status === "error") {
      return update.errorCode === "invalid-update"
        ? "更新資訊未通過版本驗證，這次不會安裝。"
        : update.errorCode === "install-failed"
          ? "無法開始安裝；TokenMonster 會繼續保持開啟。"
          : "這次更新檢查沒有完成；稍後可再手動重試。";
    }
    if (status.preferenceStorage === "unavailable") {
      return "本機更新偏好暫時無法使用；自動檢查保持關閉。";
    }
    return status.automaticChecksEnabled
      ? "自動檢查已開啟；TokenMonster 會定期查看固定的官方更新來源。"
      : "自動檢查目前關閉；只有按下手動檢查才會連線查看更新。";
  })();
  const localizedBase = localizeUiText(base);
  return notice === undefined
    ? localizedBase
    : `${localizeUiText(notice)} ${localizedBase}`;
}
import { localizeUiText } from "./localization.js";
