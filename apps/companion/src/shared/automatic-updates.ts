export const AUTOMATIC_UPDATE_CONTRACT_VERSION = 1 as const;

export const AUTOMATIC_UPDATE_IPC_CHANNELS = Object.freeze({
  status: "tokenmonster:companion:automatic-update-status",
  preference: "tokenmonster:companion:automatic-update-preference",
  check: "tokenmonster:companion:automatic-update-check",
  install: "tokenmonster:companion:automatic-update-install",
} as const);

export type AutomaticUpdateChannel = "latest" | "next";

export type AutomaticUpdateStatus =
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

export interface AutomaticUpdateDto {
  readonly contractVersion: typeof AUTOMATIC_UPDATE_CONTRACT_VERSION;
  readonly currentVersion: string;
  readonly channel: AutomaticUpdateChannel;
  readonly status: AutomaticUpdateStatus;
  readonly lastCheckedAt: string | null;
  readonly availableVersion: string | null;
  readonly errorCode: AutomaticUpdateErrorCode | null;
}

export type AutomaticUpdateCommandCode =
  | "check-started"
  | "check-busy"
  | "install-started"
  | "install-busy"
  | "not-ready"
  | "unsupported"
  | "disposed"
  | "failed";

export interface AutomaticUpdateCommandResult {
  readonly ok: boolean;
  readonly code: AutomaticUpdateCommandCode;
  readonly update: AutomaticUpdateDto;
}

export type AutomaticUpdateRevision = string;
export type AutomaticUpdatePreferenceStorage = "ready" | "unavailable";

export interface AutomaticUpdateServiceStatus {
  readonly contractVersion: typeof AUTOMATIC_UPDATE_CONTRACT_VERSION;
  readonly revision: AutomaticUpdateRevision;
  readonly preferenceStorage: AutomaticUpdatePreferenceStorage;
  readonly automaticChecksEnabled: boolean;
  readonly update: AutomaticUpdateDto;
}

export interface AutomaticUpdatePreferenceRequest {
  readonly expectedRevision: AutomaticUpdateRevision;
  readonly automaticChecksEnabled: boolean;
}

export type AutomaticUpdatePreferenceMutationError =
  | "invalid-request"
  | "conflict"
  | "storage-unavailable"
  | "disposed";

export type AutomaticUpdatePreferenceMutationResult =
  | Readonly<{ ok: true; status: AutomaticUpdateServiceStatus }>
  | Readonly<{
      ok: false;
      error: AutomaticUpdatePreferenceMutationError;
      status: AutomaticUpdateServiceStatus;
    }>;

export interface AutomaticUpdateServiceCommandResult {
  readonly ok: boolean;
  readonly code: AutomaticUpdateCommandCode;
  readonly status: AutomaticUpdateServiceStatus;
}

export interface TokenMonsterAutomaticUpdateBridge {
  getAutomaticUpdateStatus(): Promise<AutomaticUpdateServiceStatus>;
  updateAutomaticChecks(
    request: AutomaticUpdatePreferenceRequest,
  ): Promise<AutomaticUpdatePreferenceMutationResult>;
  checkForAutomaticUpdate(): Promise<AutomaticUpdateServiceCommandResult>;
  installAutomaticUpdate(): Promise<AutomaticUpdateServiceCommandResult>;
}

/**
 * Mutable channel directories are the only Squirrel feed locations the app
 * accepts. Release automation must publish RELEASES plus its referenced full
 * package into the matching directory; the runtime never accepts a feed URL
 * from renderer input, environment variables, or remote configuration.
 */
export const WINDOWS_SQUIRREL_FEED_URLS: Readonly<
  Record<AutomaticUpdateChannel, string>
> = Object.freeze({
  latest:
    "https://cdn.ted-h.com/tokenmonster/releases/windows/squirrel/latest/",
  next: "https://cdn.ted-h.com/tokenmonster/releases/windows/squirrel/next/",
});

const VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([A-Za-z][0-9A-Za-z-]*)(?:\.(0|[1-9][0-9]*))?)?$/u;
const MAX_WINDOWS_VERSION_COMPONENT = 65_535n;
const UTC_INSTANT_PATTERN =
  /^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;
const UPDATE_STATUSES = new Set<AutomaticUpdateStatus>([
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

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

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

function ownValue(
  record: Record<PropertyKey, unknown>,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor === undefined || !("value" in descriptor)
    ? undefined
    : descriptor.value;
}

function isUtcInstant(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_INSTANT_PATTERN.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function isAutomaticUpdateVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    return false;
  }
  const match = VERSION_PATTERN.exec(value);
  return (
    match !== null &&
    !/\d$/u.test(match[4] ?? "") &&
    [match[1], match[2], match[3], match[5]]
      .filter((part): part is string => part !== undefined)
      .every((part) => BigInt(part) <= MAX_WINDOWS_VERSION_COMPONENT)
  );
}

export function automaticUpdateChannelForVersion(
  currentVersion: string,
): AutomaticUpdateChannel {
  if (!isAutomaticUpdateVersion(currentVersion)) {
    throw new TypeError("INVALID_AUTOMATIC_UPDATE_VERSION");
  }
  return currentVersion.includes("-") ? "next" : "latest";
}

export function windowsSquirrelFeedUrl(
  channel: AutomaticUpdateChannel,
): string {
  if (channel !== "latest" && channel !== "next") {
    throw new TypeError("INVALID_AUTOMATIC_UPDATE_CHANNEL");
  }
  return WINDOWS_SQUIRREL_FEED_URLS[channel];
}

export function parseAutomaticUpdateDto(input: unknown): AutomaticUpdateDto {
  const record = exactOwnDataRecord(input, [
    "contractVersion",
    "currentVersion",
    "channel",
    "status",
    "lastCheckedAt",
    "availableVersion",
    "errorCode",
  ]);
  if (record === null) throw new TypeError("INVALID_AUTOMATIC_UPDATE_DTO");

  const currentVersion = ownValue(record, "currentVersion");
  const channel = ownValue(record, "channel");
  const status = ownValue(record, "status");
  const lastCheckedAt = ownValue(record, "lastCheckedAt");
  const availableVersion = ownValue(record, "availableVersion");
  const errorCode = ownValue(record, "errorCode");
  if (
    ownValue(record, "contractVersion") !==
      AUTOMATIC_UPDATE_CONTRACT_VERSION ||
    !isAutomaticUpdateVersion(currentVersion) ||
    (channel !== "latest" && channel !== "next") ||
    channel !== automaticUpdateChannelForVersion(currentVersion) ||
    typeof status !== "string" ||
    !UPDATE_STATUSES.has(status as AutomaticUpdateStatus) ||
    (lastCheckedAt !== null && !isUtcInstant(lastCheckedAt)) ||
    (availableVersion !== null &&
      !isAutomaticUpdateVersion(availableVersion)) ||
    (errorCode !== null &&
      (typeof errorCode !== "string" ||
        !UPDATE_ERRORS.has(errorCode as AutomaticUpdateErrorCode))) ||
    (status === "error") !== (errorCode !== null) ||
    ((status === "unsupported" || status === "idle" || status === "checking") &&
      availableVersion !== null) ||
    (status === "ready" && availableVersion === null)
  ) {
    throw new TypeError("INVALID_AUTOMATIC_UPDATE_DTO");
  }

  return Object.freeze({
    contractVersion: AUTOMATIC_UPDATE_CONTRACT_VERSION,
    currentVersion,
    channel,
    status: status as AutomaticUpdateStatus,
    lastCheckedAt,
    availableVersion,
    errorCode: errorCode as AutomaticUpdateErrorCode | null,
  });
}

const AUTOMATIC_UPDATE_REVISION_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u;
const MAX_AUTOMATIC_UPDATE_REVISION = 18_446_744_073_709_551_615n;
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
const SUCCESS_COMMAND_CODES = new Set<AutomaticUpdateCommandCode>([
  "check-started",
  "install-started",
]);

export function isAutomaticUpdateRevision(
  value: unknown,
): value is AutomaticUpdateRevision {
  return (
    typeof value === "string" &&
    AUTOMATIC_UPDATE_REVISION_PATTERN.test(value) &&
    BigInt(value) <= MAX_AUTOMATIC_UPDATE_REVISION
  );
}

export function parseAutomaticUpdatePreferenceRequest(
  input: unknown,
): AutomaticUpdatePreferenceRequest {
  const record = exactCrossRealmDataRecord(input, [
    "expectedRevision",
    "automaticChecksEnabled",
  ]);
  const expectedRevision =
    record === null ? undefined : ownValue(record, "expectedRevision");
  const automaticChecksEnabled =
    record === null ? undefined : ownValue(record, "automaticChecksEnabled");
  if (
    record === null ||
    !isAutomaticUpdateRevision(expectedRevision) ||
    typeof automaticChecksEnabled !== "boolean"
  ) {
    throw new TypeError("INVALID_AUTOMATIC_UPDATE_PREFERENCE_REQUEST");
  }
  return Object.freeze({ expectedRevision, automaticChecksEnabled });
}

export function parseAutomaticUpdateServiceStatus(
  input: unknown,
): AutomaticUpdateServiceStatus {
  const record = exactOwnDataRecord(input, [
    "contractVersion",
    "revision",
    "preferenceStorage",
    "automaticChecksEnabled",
    "update",
  ]);
  const revision = record === null ? undefined : ownValue(record, "revision");
  const preferenceStorage =
    record === null ? undefined : ownValue(record, "preferenceStorage");
  const automaticChecksEnabled =
    record === null ? undefined : ownValue(record, "automaticChecksEnabled");
  if (
    record === null ||
    ownValue(record, "contractVersion") !== AUTOMATIC_UPDATE_CONTRACT_VERSION ||
    !isAutomaticUpdateRevision(revision) ||
    (preferenceStorage !== "ready" &&
      preferenceStorage !== "unavailable") ||
    typeof automaticChecksEnabled !== "boolean" ||
    (preferenceStorage === "unavailable" && automaticChecksEnabled)
  ) {
    throw new TypeError("INVALID_AUTOMATIC_UPDATE_SERVICE_STATUS");
  }
  return Object.freeze({
    contractVersion: AUTOMATIC_UPDATE_CONTRACT_VERSION,
    revision,
    preferenceStorage,
    automaticChecksEnabled,
    update: parseAutomaticUpdateDto(ownValue(record, "update")),
  });
}

export function parseAutomaticUpdateCommandResult(
  input: unknown,
): AutomaticUpdateCommandResult {
  const record = exactOwnDataRecord(input, ["ok", "code", "update"]);
  const ok = record === null ? undefined : ownValue(record, "ok");
  const code = record === null ? undefined : ownValue(record, "code");
  if (
    record === null ||
    typeof ok !== "boolean" ||
    typeof code !== "string" ||
    !COMMAND_CODES.has(code as AutomaticUpdateCommandCode) ||
    ok !== SUCCESS_COMMAND_CODES.has(code as AutomaticUpdateCommandCode)
  ) {
    throw new TypeError("INVALID_AUTOMATIC_UPDATE_COMMAND_RESULT");
  }
  return Object.freeze({
    ok,
    code: code as AutomaticUpdateCommandCode,
    update: parseAutomaticUpdateDto(ownValue(record, "update")),
  });
}

export function parseAutomaticUpdatePreferenceMutationResult(
  input: unknown,
): AutomaticUpdatePreferenceMutationResult {
  const success = exactOwnDataRecord(input, ["ok", "status"]);
  if (success !== null && ownValue(success, "ok") === true) {
    return Object.freeze({
      ok: true,
      status: parseAutomaticUpdateServiceStatus(ownValue(success, "status")),
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
    throw new TypeError("INVALID_AUTOMATIC_UPDATE_PREFERENCE_RESULT");
  }
  return Object.freeze({
    ok: false,
    error,
    status: parseAutomaticUpdateServiceStatus(ownValue(failure, "status")),
  });
}

export function parseAutomaticUpdateServiceCommandResult(
  input: unknown,
): AutomaticUpdateServiceCommandResult {
  const record = exactOwnDataRecord(input, ["ok", "code", "status"]);
  const ok = record === null ? undefined : ownValue(record, "ok");
  const code = record === null ? undefined : ownValue(record, "code");
  if (
    record === null ||
    typeof ok !== "boolean" ||
    typeof code !== "string" ||
    !COMMAND_CODES.has(code as AutomaticUpdateCommandCode) ||
    ok !== SUCCESS_COMMAND_CODES.has(code as AutomaticUpdateCommandCode)
  ) {
    throw new TypeError("INVALID_AUTOMATIC_UPDATE_SERVICE_COMMAND_RESULT");
  }
  return Object.freeze({
    ok,
    code: code as AutomaticUpdateCommandCode,
    status: parseAutomaticUpdateServiceStatus(ownValue(record, "status")),
  });
}
