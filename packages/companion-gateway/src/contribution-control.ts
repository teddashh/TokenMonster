import { Buffer } from "node:buffer";

import { SupportedIngestSnapshotSchema } from "@tokenmonster/contracts";
import {
  CONTRIBUTION_CONSENT_SUMMARY_MAX_LENGTH,
  CONTRIBUTION_CONSENT_TITLE_MAX_LENGTH,
  CONTRIBUTION_FIELD_ALLOWLIST,
  CONTRIBUTION_RETENTION_DISCLOSURE_MAX_LENGTH,
} from "@tokenmonster/contribution-runtime";

import {
  UNAVAILABLE_COMPANION_CONTRIBUTION_STATUS,
  projectCompanionContributionStatus,
  readCompanionContributionStatus,
} from "./contribution-status.js";
import type {
  CompanionContributionAction,
  CompanionContributionControlCode,
  CompanionContributionControlResponse,
  CompanionContributionController,
  CompanionContributionPreviewResponse,
} from "./types.js";

const PREVIEW_KEYS = new Set<PropertyKey>([
  "previewId",
  "expiresAt",
  "document",
  "fieldAllowlist",
  "forbidden",
  "payload",
  "eligibleBucketCount",
  "remainingEligibleBucketCount",
]);
const DOCUMENT_KEYS = new Set<PropertyKey>([
  "revision",
  "title",
  "summary",
  "retentionDisclosure",
]);
const ACTION_RESULT_KEYS = new Set<PropertyKey>(["ok", "code", "status"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONSENT_REVISION_PATTERN =
  /^contribution-20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const ISO_INSTANT_PATTERN =
  /^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;
const MAX_PREVIEW_BYTES = 128 * 1_024;
const FIXED_FORBIDDEN = Object.freeze([
  "prompt / response / message content",
  "source code / filename / project path",
  "API key / OAuth token / provider credential",
  "raw log / event / session / hourly bucket",
] as const);
const COMMON_ERROR_CODES = new Set<CompanionContributionControlCode>([
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
]);
const ACTION_SUCCESS_CODES: Readonly<
  Record<Exclude<CompanionContributionAction, "preview">, ReadonlySet<string>>
> = Object.freeze({
  enable: new Set(["enabled", "resumed"]),
  stop: new Set(["stopped", "pause-pending"]),
  delete: new Set(["deletion-requested"]),
  recover: new Set(["enabled", "stopped", "deletion-status-updated"]),
});

function plainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<PropertyKey, unknown>,
  expected: ReadonlySet<PropertyKey>,
): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function own(value: Record<PropertyKey, unknown>, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) throw new Error();
  return descriptor.value;
}

function isoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  );
}

function exactStringArray(
  value: unknown,
  expected: readonly string[],
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

export function projectCompanionContributionPreview(
  value: unknown,
): CompanionContributionPreviewResponse | null {
  if (!plainRecord(value) || !exactKeys(value, PREVIEW_KEYS)) return null;
  try {
    const previewId = own(value, "previewId");
    const expiresAt = own(value, "expiresAt");
    const document = own(value, "document");
    const fieldAllowlist = own(value, "fieldAllowlist");
    const forbidden = own(value, "forbidden");
    const payload = own(value, "payload");
    const eligibleBucketCount = own(value, "eligibleBucketCount");
    const remainingEligibleBucketCount = own(
      value,
      "remainingEligibleBucketCount",
    );
    if (
      typeof previewId !== "string" ||
      !UUID_PATTERN.test(previewId) ||
      !isoInstant(expiresAt) ||
      !plainRecord(document) ||
      !exactKeys(document, DOCUMENT_KEYS) ||
      !exactStringArray(fieldAllowlist, CONTRIBUTION_FIELD_ALLOWLIST) ||
      !exactStringArray(forbidden, FIXED_FORBIDDEN) ||
      !Number.isSafeInteger(eligibleBucketCount) ||
      (eligibleBucketCount as number) < 0 ||
      !Number.isSafeInteger(remainingEligibleBucketCount) ||
      (remainingEligibleBucketCount as number) < 0
    ) {
      return null;
    }
    const revision = own(document, "revision");
    const title = own(document, "title");
    const summary = own(document, "summary");
    const retentionDisclosure = own(document, "retentionDisclosure");
    if (
      typeof revision !== "string" ||
      !CONSENT_REVISION_PATTERN.test(revision) ||
      !boundedText(title, CONTRIBUTION_CONSENT_TITLE_MAX_LENGTH) ||
      !boundedText(summary, CONTRIBUTION_CONSENT_SUMMARY_MAX_LENGTH) ||
      !boundedText(
        retentionDisclosure,
        CONTRIBUTION_RETENTION_DISCLOSURE_MAX_LENGTH,
      )
    ) {
      return null;
    }
    const parsedPayload =
      payload === null ? null : SupportedIngestSnapshotSchema.safeParse(payload);
    if (
      parsedPayload !== null &&
      !parsedPayload.success
    ) {
      return null;
    }
    const safePayload = parsedPayload === null ? null : parsedPayload.data;
    if (
      (safePayload?.buckets.length ?? 0) !== eligibleBucketCount ||
      Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PREVIEW_BYTES
    ) {
      return null;
    }
    return Object.freeze({
      status: "ok",
      preview: Object.freeze({
        previewId,
        expiresAt,
        document: Object.freeze({
          revision,
          title,
          summary,
          retentionDisclosure,
        }),
        fieldAllowlist: Object.freeze([...CONTRIBUTION_FIELD_ALLOWLIST]),
        forbidden: FIXED_FORBIDDEN,
        payload: safePayload,
        eligibleBucketCount: eligibleBucketCount as number,
        remainingEligibleBucketCount: remainingEligibleBucketCount as number,
      }),
    });
  } catch {
    return null;
  }
}

function errorResponse(
  controller: CompanionContributionController | null,
  action: CompanionContributionAction,
  code: CompanionContributionControlCode,
): CompanionContributionControlResponse {
  return Object.freeze({
    status: "error",
    action,
    code,
    contribution: readCompanionContributionStatus(controller),
  });
}

function validSuccessPostcondition(
  action: Exclude<CompanionContributionAction, "preview">,
  code: string,
  status: ReturnType<typeof projectCompanionContributionStatus>,
): boolean {
  if (
    action === "enable" &&
    (code === "enabled" || code === "resumed")
  ) {
    return status.state === "active" && status.enabled;
  }
  if (
    action === "stop" &&
    (code === "stopped" || code === "pause-pending")
  ) {
    return status.state === "stopped" && !status.enabled;
  }
  if (action === "delete" && code === "deletion-requested") {
    return (
      status.state === "deletion-pending" &&
      (status.deletionStatus === "queued" ||
        status.deletionStatus === "running")
    );
  }
  if (action === "recover" && code === "enabled") {
    return status.state === "active" && status.enabled && !status.canRecover;
  }
  if (action === "recover" && code === "stopped") {
    return status.state === "stopped" && !status.enabled && !status.canRecover;
  }
  if (action === "recover" && code === "deletion-status-updated") {
    return status.state.startsWith("deletion-");
  }
  return false;
}

export async function prepareCompanionContributionPreview(
  controller: CompanionContributionController | null,
): Promise<CompanionContributionPreviewResponse | CompanionContributionControlResponse> {
  if (controller === null) {
    return errorResponse(controller, "preview", "runtime-unavailable");
  }
  try {
    return (
      projectCompanionContributionPreview(await controller.preparePreview()) ??
      errorResponse(controller, "preview", "contract-mismatch")
    );
  } catch {
    return errorResponse(controller, "preview", "local-service-error");
  }
}

export async function runCompanionContributionAction(
  controller: CompanionContributionController | null,
  action: Exclude<CompanionContributionAction, "preview">,
  operation: (controller: CompanionContributionController) => Promise<unknown>,
): Promise<CompanionContributionControlResponse> {
  if (controller === null) {
    return errorResponse(controller, action, "runtime-unavailable");
  }
  try {
    const raw = await operation(controller);
    if (!plainRecord(raw) || !exactKeys(raw, ACTION_RESULT_KEYS)) {
      return errorResponse(controller, action, "contract-mismatch");
    }
    const ok = own(raw, "ok");
    const code = own(raw, "code");
    const resultStatus = own(raw, "status");
    if (
      typeof ok !== "boolean" ||
      typeof code !== "string" ||
      (ok
        ? !ACTION_SUCCESS_CODES[action].has(code)
        : !COMMON_ERROR_CODES.has(code as CompanionContributionControlCode))
    ) {
      return errorResponse(controller, action, "contract-mismatch");
    }
    const projectedResultStatus = projectCompanionContributionStatus(
      resultStatus,
      true,
    );
    if (
      projectedResultStatus === UNAVAILABLE_COMPANION_CONTRIBUTION_STATUS
    ) {
      return errorResponse(controller, action, "contract-mismatch");
    }
    if (
      ok &&
      !validSuccessPostcondition(action, code, projectedResultStatus)
    ) {
      return errorResponse(controller, action, "contract-mismatch");
    }
    return Object.freeze({
      status: ok ? "ok" : "error",
      action,
      code: code as CompanionContributionControlCode,
      contribution: projectedResultStatus,
    });
  } catch {
    return errorResponse(controller, action, "local-service-error");
  }
}

export function contributionControlHttpStatus(
  response:
    | CompanionContributionPreviewResponse
    | CompanionContributionControlResponse,
): number {
  if (response.status === "ok") return 200;
  if (response.code === "busy" || response.code === "state-conflict") return 409;
  if (response.code === "rate-limited") return 429;
  return 503;
}
