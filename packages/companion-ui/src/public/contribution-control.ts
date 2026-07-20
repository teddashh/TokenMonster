import { localizeUiText, uiCopy } from "./localization.js";

export const CONTRIBUTION_STATUS_ENDPOINT = "/api/contribution/status" as const;
export const CONTRIBUTION_PREVIEW_ENDPOINT =
  "/api/contribution/preview" as const;
export const CONTRIBUTION_ENABLE_ENDPOINT = "/api/contribution/enable" as const;
export const CONTRIBUTION_STOP_ENDPOINT = "/api/contribution/stop" as const;
export const CONTRIBUTION_DELETE_ENDPOINT = "/api/contribution/delete" as const;
export const CONTRIBUTION_RECOVER_ENDPOINT =
  "/api/contribution/recover" as const;

const STATUS_KEYS = [
  "status",
  "availability",
  "unavailableReason",
  "secureStorage",
  "state",
  "enabled",
  "canPreview",
  "canStop",
  "canDelete",
  "canRecover",
  "outboxPending",
  "deletionStatus",
  "anonymousHistoricalTotalsRetained",
] as const;
const PREVIEW_KEYS = [
  "previewId",
  "expiresAt",
  "document",
  "fieldAllowlist",
  "forbidden",
  "payload",
  "eligibleBucketCount",
  "remainingEligibleBucketCount",
] as const;
const FIELD_ALLOWLIST = Object.freeze([
  "schemaVersion",
  "batchId",
  "generatedAt",
  "collector.kind",
  "collector.adapterVersion",
  "collector.sourceVersion",
  "buckets.bucketStart",
  "buckets.provider",
  "buckets.modelFamily",
  "buckets.tool",
  "buckets.valueQuality",
  "buckets.revision",
  "buckets.tokens.input",
  "buckets.tokens.output",
  "buckets.tokens.cacheRead",
  "buckets.tokens.cacheWrite",
  "buckets.tokens.reasoning",
  "buckets.tokens.other",
  "buckets.tokens.total",
] as const);
const FORBIDDEN = Object.freeze([
  "prompt / response / message content",
  "source code / filename / project path",
  "API key / OAuth token / provider credential",
  "raw log / event / session / hourly bucket",
] as const);
const STATES = new Set([
  "off",
  "active",
  "stopped",
  "deletion-pending",
  "deletion-complete",
  "deletion-failed",
  "unavailable",
]);
const ACTIONS = new Set(["preview", "enable", "stop", "delete", "recover"]);
const ACTION_CODES = new Set([
  "enabled",
  "resumed",
  "stopped",
  "pause-pending",
  "deletion-requested",
  "deletion-status-updated",
  "api-not-configured",
  "secure-storage-unavailable",
  "secure-storage-failed",
  "contract-mismatch",
  "network-error",
  "timeout",
  "rate-limited",
  "server-unavailable",
  "request-rejected",
  "local-data-too-large",
  "authority-conflict",
  "local-service-error",
  "preview-expired",
  "state-conflict",
  "not-enabled",
  "consent-stale",
  "deletion-credential-unavailable",
  "deletion-status-unavailable",
  "busy",
  "invalid-request",
  "runtime-unavailable",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_PATTERN =
  /^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;
const REVISION_PATTERN =
  /^contribution-(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;
const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,15})$/u;
const REQUEST_TIMEOUT_MS = 20_000;
export const CONTRIBUTION_CONSENT_TITLE_MAX_LENGTH = 200;
export const CONTRIBUTION_CONSENT_SUMMARY_MAX_LENGTH = 2_000;
export const CONTRIBUTION_RETENTION_DISCLOSURE_MAX_LENGTH = 4_000;

export type ContributionState =
  | "off"
  | "active"
  | "stopped"
  | "deletion-pending"
  | "deletion-complete"
  | "deletion-failed"
  | "unavailable";

export interface ContributionStatus {
  readonly status: "ok";
  readonly availability: "available" | "unavailable";
  readonly unavailableReason:
    | "secure-storage-unavailable"
    | "runtime-unavailable"
    | "recovery-required"
    | null;
  readonly secureStorage: "os-backed" | "unavailable";
  readonly state: ContributionState;
  readonly enabled: boolean;
  readonly canPreview: boolean;
  readonly canStop: boolean;
  readonly canDelete: boolean;
  readonly canRecover: boolean;
  readonly outboxPending: number;
  readonly deletionStatus: "queued" | "running" | "complete" | "failed" | null;
  readonly anonymousHistoricalTotalsRetained: true | null;
}

export interface ContributionPreview {
  readonly previewId: string;
  readonly expiresAt: string;
  readonly document: Readonly<{
    revision: string;
    title: string;
    summary: string;
    retentionDisclosure: string;
  }>;
  readonly fieldAllowlist: readonly string[];
  readonly forbidden: readonly string[];
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly eligibleBucketCount: number;
  readonly remainingEligibleBucketCount: number;
}

export interface ContributionActionResponse {
  readonly status: "ok" | "error";
  readonly action: "preview" | "enable" | "stop" | "delete" | "recover";
  readonly code: string;
  readonly contribution: ContributionStatus;
}

export interface ContributionControlView {
  readonly statusText: string;
  readonly canPreview: boolean;
  readonly canStop: boolean;
  readonly canDelete: boolean;
  readonly canRecover: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function exactDataKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isoInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function boundedText(value: unknown, maximum = 2_048): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  );
}

function validConsentRevision(value: string): boolean {
  const match = REVISION_PATTERN.exec(value);
  if (match === null) return false;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  return new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date;
}

function exactStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function validPayload(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (
    !record(value) ||
    !exactDataKeys(value, [
      "schemaVersion",
      "batchId",
      "generatedAt",
      "collector",
      "buckets",
    ]) ||
    (value["schemaVersion"] !== "1" && value["schemaVersion"] !== "2") ||
    typeof value["batchId"] !== "string" ||
    !UUID_PATTERN.test(value["batchId"]) ||
    !isoInstant(value["generatedAt"]) ||
    !record(value["collector"]) ||
    !exactDataKeys(value["collector"], [
      "kind",
      "adapterVersion",
      "sourceVersion",
    ]) ||
    !SEMVER_PATTERN.test(String(value["collector"]["adapterVersion"])) ||
    !SEMVER_PATTERN.test(String(value["collector"]["sourceVersion"])) ||
    !Array.isArray(value["buckets"]) ||
    value["buckets"].length < 1 ||
    value["buckets"].length > 30
  ) {
    return false;
  }
  const collectorKind = value["collector"]["kind"];
  if (
    (value["schemaVersion"] === "2" &&
      collectorKind !== "tokentracker-sidecar") ||
    (value["schemaVersion"] === "1" &&
      collectorKind !== "tokscale" &&
      collectorKind !== "tokentracker-bridge")
  ) {
    return false;
  }
  const seen = new Set<string>();
  for (const bucket of value["buckets"]) {
    if (
      !record(bucket) ||
      !exactDataKeys(bucket, [
        "bucketStart",
        "provider",
        "modelFamily",
        "tool",
        "valueQuality",
        "revision",
        "tokens",
      ]) ||
      typeof bucket["bucketStart"] !== "string" ||
      !/^20\d{2}-\d{2}-\d{2}T00:00:00\.000Z$/u.test(bucket["bucketStart"]) ||
      !["anthropic", "google", "openai", "openrouter", "xai", "other"].includes(
        String(bucket["provider"]),
      ) ||
      typeof bucket["modelFamily"] !== "string" ||
      !SLUG_PATTERN.test(bucket["modelFamily"]) ||
      typeof bucket["tool"] !== "string" ||
      !SLUG_PATTERN.test(bucket["tool"]) ||
      (bucket["valueQuality"] !== "exact" &&
        bucket["valueQuality"] !== "estimated") ||
      !Number.isSafeInteger(bucket["revision"]) ||
      (bucket["revision"] as number) < 1 ||
      !record(bucket["tokens"]) ||
      !exactDataKeys(bucket["tokens"], [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "reasoning",
        "other",
        "total",
      ])
    ) {
      return false;
    }
    const tokenFields = [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "reasoning",
      "other",
      "total",
    ];
    const counts = bucket["tokens"] as Record<string, string>;
    if (
      tokenFields.some((field) => !DECIMAL_PATTERN.test(String(counts[field])))
    ) {
      return false;
    }
    if (
      BigInt(counts["reasoning"]!) > BigInt(counts["output"]!) ||
      BigInt(counts["input"]!) +
        BigInt(counts["output"]!) +
        BigInt(counts["cacheRead"]!) +
        BigInt(counts["cacheWrite"]!) +
        BigInt(counts["other"]!) !==
        BigInt(counts["total"]!)
    ) {
      return false;
    }
    const key = [
      bucket["bucketStart"],
      bucket["provider"],
      bucket["modelFamily"],
      bucket["tool"],
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return JSON.stringify(value).length <= 128 * 1_024;
}

export function parseContributionStatus(value: unknown): ContributionStatus {
  if (!record(value) || !exactDataKeys(value, STATUS_KEYS)) {
    throw new TypeError("Invalid contribution status");
  }
  const state = value["state"];
  const deletionStatus = value["deletionStatus"];
  const deletionState =
    typeof state === "string" && state.startsWith("deletion-");
  if (
    value["status"] !== "ok" ||
    (value["availability"] !== "available" &&
      value["availability"] !== "unavailable") ||
    (value["secureStorage"] !== "os-backed" &&
      value["secureStorage"] !== "unavailable") ||
    typeof state !== "string" ||
    !STATES.has(state) ||
    typeof value["enabled"] !== "boolean" ||
    typeof value["canPreview"] !== "boolean" ||
    typeof value["canStop"] !== "boolean" ||
    typeof value["canDelete"] !== "boolean" ||
    typeof value["canRecover"] !== "boolean" ||
    !safeInteger(value["outboxPending"]) ||
    (deletionStatus !== null &&
      !["queued", "running", "complete", "failed"].includes(
        String(deletionStatus),
      )) ||
    deletionState !== (deletionStatus !== null) ||
    deletionState !== (value["anonymousHistoricalTotalsRetained"] === true) ||
    value["enabled"] !== (state === "active") ||
    (value["canStop"] === true && state !== "active") ||
    (value["canPreview"] === true &&
      state !== "off" &&
      state !== "stopped" &&
      state !== "deletion-complete") ||
    (value["canDelete"] === true &&
      state !== "active" &&
      state !== "stopped") ||
    (value["canRecover"] === true &&
      state !== "unavailable" &&
      state !== "active" &&
      state !== "stopped" &&
      !deletionState) ||
    (state === "unavailable") !== (value["availability"] === "unavailable")
  ) {
    throw new TypeError("Invalid contribution status");
  }
  const reason = value["unavailableReason"];
  if (
    (value["availability"] === "available" && reason !== null) ||
    (value["availability"] === "unavailable" &&
      ![
        "secure-storage-unavailable",
        "runtime-unavailable",
        "recovery-required",
      ].includes(String(reason))) ||
    (reason === "secure-storage-unavailable" &&
      value["secureStorage"] !== "unavailable") ||
    (value["secureStorage"] === "unavailable" &&
      (state !== "unavailable" ||
        reason !== "secure-storage-unavailable" ||
        value["canPreview"] ||
        value["canStop"] ||
        value["canDelete"] ||
        value["canRecover"])) ||
    (state !== "unavailable" && value["secureStorage"] !== "os-backed") ||
    (reason === "recovery-required" && value["canRecover"] !== true) ||
    (value["canRecover"] === true &&
      state === "unavailable" &&
      reason !== "recovery-required") ||
    (state === "deletion-pending" &&
      deletionStatus !== "queued" &&
      deletionStatus !== "running") ||
    (state === "deletion-complete" && deletionStatus !== "complete") ||
    (state === "deletion-failed" && deletionStatus !== "failed")
  ) {
    throw new TypeError("Invalid contribution status");
  }
  return Object.freeze({
    status: "ok",
    availability: value["availability"] as ContributionStatus["availability"],
    unavailableReason: reason as ContributionStatus["unavailableReason"],
    secureStorage: value[
      "secureStorage"
    ] as ContributionStatus["secureStorage"],
    state: state as ContributionState,
    enabled: value["enabled"] as boolean,
    canPreview: value["canPreview"] as boolean,
    canStop: value["canStop"] as boolean,
    canDelete: value["canDelete"] as boolean,
    canRecover: value["canRecover"] as boolean,
    outboxPending: value["outboxPending"] as number,
    deletionStatus: deletionStatus as ContributionStatus["deletionStatus"],
    anonymousHistoricalTotalsRetained: value[
      "anonymousHistoricalTotalsRetained"
    ] as true | null,
  });
}

export function parseContributionPreview(value: unknown): ContributionPreview {
  if (!record(value) || !exactDataKeys(value, PREVIEW_KEYS)) {
    throw new TypeError("Invalid contribution preview");
  }
  const document = value["document"];
  const payload = value["payload"];
  if (
    typeof value["previewId"] !== "string" ||
    !UUID_PATTERN.test(value["previewId"]) ||
    !isoInstant(value["expiresAt"]) ||
    !record(document) ||
    !exactDataKeys(document, [
      "revision",
      "title",
      "summary",
      "retentionDisclosure",
    ]) ||
    typeof document["revision"] !== "string" ||
    !validConsentRevision(document["revision"]) ||
    !boundedText(document["title"], CONTRIBUTION_CONSENT_TITLE_MAX_LENGTH) ||
    !boundedText(
      document["summary"],
      CONTRIBUTION_CONSENT_SUMMARY_MAX_LENGTH,
    ) ||
    !boundedText(
      document["retentionDisclosure"],
      CONTRIBUTION_RETENTION_DISCLOSURE_MAX_LENGTH,
    ) ||
    !exactStrings(value["fieldAllowlist"], FIELD_ALLOWLIST) ||
    !exactStrings(value["forbidden"], FORBIDDEN) ||
    !safeInteger(value["eligibleBucketCount"]) ||
    !safeInteger(value["remainingEligibleBucketCount"]) ||
    (payload !== null && !validPayload(payload)) ||
    (payload === null ? 0 : (payload["buckets"] as unknown[]).length) !==
      value["eligibleBucketCount"]
  ) {
    throw new TypeError("Invalid contribution preview");
  }
  return Object.freeze({
    previewId: value["previewId"],
    expiresAt: value["expiresAt"] as string,
    document: Object.freeze({
      revision: document["revision"],
      title: document["title"],
      summary: document["summary"],
      retentionDisclosure: document["retentionDisclosure"],
    }),
    fieldAllowlist: FIELD_ALLOWLIST,
    forbidden: FORBIDDEN,
    payload,
    eligibleBucketCount: value["eligibleBucketCount"],
    remainingEligibleBucketCount: value["remainingEligibleBucketCount"],
  });
}

export function parseContributionAction(
  value: unknown,
): ContributionActionResponse {
  if (
    !record(value) ||
    !exactDataKeys(value, ["status", "action", "code", "contribution"]) ||
    (value["status"] !== "ok" && value["status"] !== "error") ||
    typeof value["action"] !== "string" ||
    !ACTIONS.has(value["action"]) ||
    typeof value["code"] !== "string" ||
    !ACTION_CODES.has(value["code"])
  ) {
    throw new TypeError("Invalid contribution action");
  }
  const action = value["action"] as ContributionActionResponse["action"];
  const code = value["code"];
  const contribution = parseContributionStatus(value["contribution"]);
  const successCodes: Readonly<Record<string, readonly string[]>> = {
    enable: ["enabled", "resumed"],
    stop: ["stopped", "pause-pending"],
    delete: ["deletion-requested"],
    recover: ["enabled", "stopped", "deletion-status-updated"],
    preview: [],
  };
  const isSuccessCode = successCodes[action]!.includes(code);
  const validSuccessPostcondition = (() => {
    if (!isSuccessCode) return true;
    if (action === "enable") {
      return contribution.state === "active" && contribution.enabled;
    }
    if (action === "stop") {
      return contribution.state === "stopped" && !contribution.enabled;
    }
    if (action === "delete") {
      return (
        contribution.state === "deletion-pending" &&
        (contribution.deletionStatus === "queued" ||
          contribution.deletionStatus === "running")
      );
    }
    if (action === "recover" && code === "enabled") {
      return (
        contribution.state === "active" &&
        contribution.enabled &&
        !contribution.canRecover
      );
    }
    if (action === "recover" && code === "stopped") {
      return (
        contribution.state === "stopped" &&
        !contribution.enabled &&
        !contribution.canRecover
      );
    }
    return (
      action === "recover" &&
      code === "deletion-status-updated" &&
      contribution.state.startsWith("deletion-")
    );
  })();
  if (
    (value["status"] === "ok") !== isSuccessCode ||
    !validSuccessPostcondition
  ) {
    throw new TypeError("Invalid contribution action");
  }
  return Object.freeze({
    status: value["status"],
    action,
    code,
    contribution,
  });
}

async function readJson(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!type.startsWith("application/json") || declared > 262_144) {
    throw new TypeError("Invalid contribution response");
  }
  const maximum = 262_144;
  let text: string;
  if (response.body === null) {
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximum) {
      throw new TypeError("Invalid contribution response");
    }
  } else {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new TypeError("Invalid contribution response");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder().decode(body);
  }
  return JSON.parse(text) as unknown;
}

export async function requestContributionStatus(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ContributionStatus> {
  const response = await fetcher(CONTRIBUTION_STATUS_ENDPOINT, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error("Contribution status unavailable");
  return parseContributionStatus(await readJson(response));
}

async function contributionPost(
  endpoint: string,
  body: Readonly<Record<string, string>>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetcher(endpoint, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  return readJson(response);
}

export async function requestContributionPreview(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ContributionPreview | ContributionActionResponse> {
  const value = await contributionPost(
    CONTRIBUTION_PREVIEW_ENDPOINT,
    { confirmation: "preview-contribution-data" },
    fetcher,
    signal,
  );
  if (
    record(value) &&
    value["status"] === "ok" &&
    exactDataKeys(value, ["status", "preview"])
  ) {
    return parseContributionPreview(value["preview"]);
  }
  return parseContributionAction(value);
}

export async function requestContributionAction(
  action: "enable" | "stop" | "delete" | "recover",
  previewId: string | null,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ContributionActionResponse> {
  const request =
    action === "enable"
      ? {
          endpoint: CONTRIBUTION_ENABLE_ENDPOINT,
          body: {
            previewId: previewId ?? "",
            confirmation: "enable-anonymous-contribution",
          },
        }
      : action === "stop"
        ? {
            endpoint: CONTRIBUTION_STOP_ENDPOINT,
            body: { confirmation: "stop-anonymous-contribution" },
          }
        : action === "delete"
          ? {
              endpoint: CONTRIBUTION_DELETE_ENDPOINT,
              body: { confirmation: "delete-contribution-data" },
            }
          : {
              endpoint: CONTRIBUTION_RECOVER_ENDPOINT,
              body: { confirmation: "recover-contribution-state" },
            };
  const parsed = parseContributionAction(
    await contributionPost(request.endpoint, request.body, fetcher, signal),
  );
  if (parsed.action !== action)
    throw new TypeError("Invalid contribution action");
  return parsed;
}

export interface ContributionActionAttempt {
  readonly result: ContributionActionResponse | null;
  readonly contribution: ContributionStatus | null;
}

export function contributionActionAttemptSucceeded(
  attempt: ContributionActionAttempt,
): boolean {
  return attempt.result === null
    ? attempt.contribution !== null
    : attempt.result.status === "ok";
}

export function contributionActionStatusConverged(
  action: "enable" | "stop" | "delete" | "recover",
  status: ContributionStatus,
  previousStatus: ContributionStatus | null = null,
): boolean {
  if (action === "enable") {
    return (
      (status.state === "active" && status.enabled) ||
      (status.state === "unavailable" && status.canRecover) ||
      (status.state.startsWith("deletion-") &&
        previousStatus?.state !== status.state)
    );
  }
  if (action === "stop") {
    return !status.enabled && status.state !== "active";
  }
  if (action === "delete") {
    return !status.enabled && status.state.startsWith("deletion-");
  }
  if (!status.canRecover) return true;
  return (
    previousStatus !== null &&
    (status.state !== previousStatus.state ||
      status.deletionStatus !== previousStatus.deletionStatus)
  );
}

async function waitForContributionPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 100);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * A browser timeout does not cancel the gateway's bounded mutation. Re-read
 * the authoritative state with a separate deadline before controls re-enable.
 */
export async function requestContributionActionWithStatusRecovery(
  action: "enable" | "stop" | "delete" | "recover",
  previewId: string | null,
  fetcher: typeof fetch = fetch,
  actionSignal?: AbortSignal,
  statusSignal?: AbortSignal,
  previousStatus: ContributionStatus | null = null,
): Promise<ContributionActionAttempt> {
  try {
    const result = await requestContributionAction(
      action,
      previewId,
      fetcher,
      actionSignal,
    );
    return Object.freeze({ result, contribution: result.contribution });
  } catch {
    const recoverySignal =
      statusSignal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    while (!recoverySignal.aborted) {
      try {
        const contribution = await requestContributionStatus(
          fetcher,
          recoverySignal,
        );
        if (
          contributionActionStatusConverged(
            action,
            contribution,
            previousStatus,
          )
        ) {
          return Object.freeze({ result: null, contribution });
        }
      } catch {
        // Retry only bounded GETs until the independent status deadline.
      }
      await waitForContributionPoll(recoverySignal);
    }
    return Object.freeze({ result: null, contribution: null });
  }
}

export function contributionControlView(
  status: ContributionStatus,
): ContributionControlView {
  const statusText = (() => {
    if (status.unavailableReason === "secure-storage-unavailable") {
      return uiCopy(
        "匿名貢獻無法啟用：這個啟動方式沒有經稽核的作業系統安全儲存。",
      );
    }
    if (status.unavailableReason === "recovery-required") {
      return uiCopy("上次操作結果不明；可以安全重試復原，不會建立新憑證。");
    }
    if (
      status.canRecover &&
      (status.state === "active" ||
        status.state === "stopped" ||
        status.state === "deletion-complete" ||
        status.state === "deletion-failed")
    ) {
      return uiCopy("上次操作仍需安全完成本機憑證清理；復原不會建立新憑證。");
    }
    if (status.state === "off") return uiCopy("匿名貢獻目前關閉（預設）。");
    if (status.state === "active")
      return uiCopy("匿名貢獻已啟用；只會背景分享內容盲 UTC 日彙總。");
    if (status.state === "stopped")
      return uiCopy("後續匿名貢獻已停止；可識別目前資料仍可刪除。");
    if (status.state === "deletion-pending")
      return uiCopy("刪除要求處理中；匿名歷史總量仍會保留。");
    if (status.state === "deletion-complete")
      return uiCopy("可識別目前貢獻資料已刪除；匿名歷史總量仍會保留。");
    if (status.state === "deletion-failed")
      return uiCopy("刪除狀態失敗；後續上傳仍停用，請聯絡支援。");
    return uiCopy("匿名貢獻目前不可用；本機統計仍正常運作。");
  })();
  return Object.freeze({
    statusText,
    canPreview: status.canPreview,
    canStop: status.canStop,
    canDelete: status.canDelete,
    canRecover: status.canRecover,
  });
}

export function retainContributionPreview(
  status: ContributionStatus | null,
  preview: ContributionPreview | null,
  actionCompleted = false,
): ContributionPreview | null {
  return !actionCompleted && status?.canPreview === true ? preview : null;
}

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null)
    throw new Error(`Missing contribution element: ${selector}`);
  return found;
}

export function startContributionControl(): void {
  const panel = document.querySelector<HTMLElement>(
    "[data-contribution-control]",
  );
  if (panel === null) return;
  const statusElement = element<HTMLElement>("[data-contribution-status]");
  const previewButton = element<HTMLButtonElement>(
    "[data-contribution-preview]",
  );
  const stopButton = element<HTMLButtonElement>("[data-contribution-stop]");
  const deleteButton = element<HTMLButtonElement>("[data-contribution-delete]");
  const recoverButton = element<HTMLButtonElement>(
    "[data-contribution-recover]",
  );
  const previewPanel = element<HTMLElement>(
    "[data-contribution-preview-panel]",
  );
  const previewTitle = element<HTMLElement>(
    "[data-contribution-preview-title]",
  );
  const previewSummary = element<HTMLElement>(
    "[data-contribution-preview-summary]",
  );
  const previewRetention = element<HTMLElement>(
    "[data-contribution-preview-retention]",
  );
  const previewPayload = element<HTMLElement>(
    "[data-contribution-preview-payload]",
  );
  const enableConfirmation = element<HTMLInputElement>(
    "[data-contribution-confirm-enable]",
  );
  const enableButton = element<HTMLButtonElement>("[data-contribution-enable]");
  let currentStatus: ContributionStatus | null = null;
  let currentPreview: ContributionPreview | null = null;
  let busy = false;
  let deleteArmed = false;
  let deleteTimer: number | undefined;

  const clearPreview = (): void => {
    currentPreview = null;
    enableConfirmation.checked = false;
    previewPanel.hidden = true;
  };

  const render = (notice?: string): void => {
    const view =
      currentStatus === null ? null : contributionControlView(currentStatus);
    statusElement.textContent =
      notice ?? view?.statusText ?? uiCopy("正在確認匿名貢獻是否可用。");
    previewButton.disabled = busy || view?.canPreview !== true;
    stopButton.hidden = view?.canStop !== true;
    stopButton.disabled = busy || view?.canStop !== true;
    deleteButton.hidden = view?.canDelete !== true;
    deleteButton.disabled = busy || view?.canDelete !== true;
    recoverButton.hidden = view?.canRecover !== true;
    recoverButton.disabled = busy || view?.canRecover !== true;
    enableButton.disabled =
      busy ||
      view?.canPreview !== true ||
      currentPreview === null ||
      !enableConfirmation.checked;
  };

  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    render(uiCopy("正在處理匿名貢獻設定。"));
    let failureNotice: string | undefined;
    try {
      await operation();
    } catch {
      failureNotice = uiCopy("匿名貢獻控制暫時無法完成；本機統計不受影響。");
    } finally {
      busy = false;
    }
    render(failureNotice);
  };

  const runAction = async (
    action: "enable" | "stop" | "delete" | "recover",
    previewId: string | null,
  ): Promise<void> => {
    const previousStatus = currentStatus;
    // A preview is single-attempt authority. Never leave it actionable while
    // a mutation may still be completing after a browser response timeout.
    clearPreview();
    const attempt = await requestContributionActionWithStatusRecovery(
      action,
      previewId,
      fetch,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      previousStatus,
    );
    currentStatus = attempt.contribution;
    if (!contributionActionAttemptSucceeded(attempt)) {
      throw new Error("Contribution action failed");
    }
  };

  previewButton.addEventListener("click", () => {
    void run(async () => {
      clearPreview();
      const result = await requestContributionPreview(
        fetch,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      );
      if ("contribution" in result) {
        currentStatus = result.contribution;
        throw new Error("Preview unavailable");
      }
      currentPreview = result;
      previewTitle.textContent = result.document.title;
      previewSummary.textContent = result.document.summary;
      previewRetention.textContent = result.document.retentionDisclosure;
      previewPayload.textContent = JSON.stringify(result.payload, null, 2);
      previewPanel.hidden = false;
      enableConfirmation.checked = false;
    });
  });
  enableConfirmation.addEventListener("change", () => render());
  enableButton.addEventListener("click", () => {
    void run(async () => {
      if (currentPreview === null || !enableConfirmation.checked) return;
      const previewId = currentPreview.previewId;
      await runAction("enable", previewId);
    });
  });
  stopButton.addEventListener("click", () => {
    void run(async () => {
      await runAction("stop", null);
    });
  });
  recoverButton.addEventListener("click", () => {
    void run(async () => {
      await runAction("recover", null);
    });
  });
  deleteButton.addEventListener("click", () => {
    if (!deleteArmed) {
      deleteArmed = true;
      deleteButton.textContent = uiCopy("再按一次確認刪除可識別貢獻資料");
      if (deleteTimer !== undefined) window.clearTimeout(deleteTimer);
      deleteTimer = window.setTimeout(() => {
        deleteArmed = false;
        deleteButton.textContent = uiCopy("刪除可識別貢獻資料");
      }, 10_000);
      return;
    }
    deleteArmed = false;
    deleteButton.textContent = uiCopy("刪除可識別貢獻資料");
    void run(async () => {
      await runAction("delete", null);
    });
  });

  render();
  void requestContributionStatus(fetch, AbortSignal.timeout(REQUEST_TIMEOUT_MS))
    .then((status) => {
      currentStatus = status;
      render();
    })
    .catch(() => {
      render(localizeUiText("匿名貢獻狀態暫時無法讀取；本機統計仍正常運作。"));
    });
}
