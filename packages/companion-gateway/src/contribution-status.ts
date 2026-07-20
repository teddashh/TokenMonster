import type { ContributionRuntimeStatus } from "@tokenmonster/contribution-runtime";

import type {
  CompanionContributionController,
  CompanionContributionStatusResponse,
  CompanionContributionStatusSource,
} from "./types.js";

const SOURCE_KEYS = new Set<PropertyKey>(["status"]);
const CONTROLLER_KEYS = new Set<PropertyKey>([
  "status",
  "preparePreview",
  "enable",
  "stop",
  "requestDeletion",
  "recover",
]);
const RUNTIME_STATUS_KEYS = new Set<PropertyKey>([
  "configured",
  "secureStorage",
  "state",
  "enabled",
  "canEnable",
  "canDelete",
  "canRecover",
  "outboxPending",
  "consentDocumentRevision",
  "deletion",
]);
const DELETION_KEYS = new Set<PropertyKey>([
  "jobId",
  "status",
  "requestedAt",
  "finishedAt",
  "anonymousHistoricalTotalsRetained",
]);
const CONTRIBUTION_STATES = new Set([
  "off",
  "active",
  "stopped",
  "deletion-pending",
  "deletion-complete",
  "deletion-failed",
  "unavailable",
]);
const DELETION_STATUSES = new Set(["queued", "running", "complete", "failed"]);
const CONSENT_REVISION_PATTERN =
  /^contribution-20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const DELETION_JOB_ID_PATTERN = /^del_[A-Za-z0-9_-]{22}$/u;
const ISO_INSTANT_PATTERN =
  /^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;

export const UNAVAILABLE_COMPANION_CONTRIBUTION_STATUS: CompanionContributionStatusResponse =
  Object.freeze({
    status: "ok",
    availability: "unavailable",
    unavailableReason: "secure-storage-unavailable",
    secureStorage: "unavailable",
    state: "unavailable",
    enabled: false,
    canPreview: false,
    canStop: false,
    canDelete: false,
    canRecover: false,
    outboxPending: 0,
    deletionStatus: null,
    anonymousHistoricalTotalsRetained: null,
  });

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<PropertyKey, unknown>,
  expected: ReadonlySet<PropertyKey>,
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.size && keys.every((key) => expected.has(key))
  );
}

function ownDataValue(
  value: Record<PropertyKey, unknown>,
  key: PropertyKey,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) throw new Error();
  return descriptor.value;
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value))
    return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function validDeletion(
  value: unknown,
): value is NonNullable<ContributionRuntimeStatus["deletion"]> {
  if (!isPlainRecord(value) || !hasExactKeys(value, DELETION_KEYS))
    return false;
  try {
    const jobId = ownDataValue(value, "jobId");
    const status = ownDataValue(value, "status");
    const requestedAt = ownDataValue(value, "requestedAt");
    const finishedAt = ownDataValue(value, "finishedAt");
    return (
      typeof jobId === "string" &&
      DELETION_JOB_ID_PATTERN.test(jobId) &&
      typeof status === "string" &&
      DELETION_STATUSES.has(status) &&
      isIsoInstant(requestedAt) &&
      (finishedAt === null || isIsoInstant(finishedAt)) &&
      ownDataValue(value, "anonymousHistoricalTotalsRetained") === true &&
      (status === "complete" || status === "failed"
        ? finishedAt !== null
        : finishedAt === null)
    );
  } catch {
    return false;
  }
}

function validStateInvariants(
  input: Readonly<{
    configured: boolean;
    secureStorage: "os-backed" | "unavailable";
    state: ContributionRuntimeStatus["state"];
    enabled: boolean;
    canEnable: boolean;
    canDelete: boolean;
    canRecover: boolean;
    deletion: ContributionRuntimeStatus["deletion"];
  }>,
): boolean {
  if (input.enabled !== (input.state === "active")) return false;
  if (
    (!input.configured || input.secureStorage === "unavailable") &&
    input.state !== "unavailable"
  ) {
    return false;
  }
  if (
    input.state === "unavailable" &&
    (input.enabled ||
      input.canEnable ||
      input.canDelete ||
      input.deletion !== null)
  ) {
    return false;
  }
  if (input.state.startsWith("deletion-") !== (input.deletion !== null)) {
    return false;
  }
  if (
    input.deletion === null &&
    (input.canDelete !==
      (input.state === "active" || input.state === "stopped") ||
      (input.canEnable &&
        input.state !== "off" &&
        input.state !== "stopped"))
  ) {
    return false;
  }
  if (input.canRecover) {
    if (!input.configured || input.secureStorage !== "os-backed") {
      return false;
    }
    if (
      input.state !== "unavailable" &&
      input.state !== "active" &&
      input.state !== "stopped" &&
      !input.state.startsWith("deletion-")
    ) {
      return false;
    }
  }
  if (input.deletion === null) return true;
  if (input.canDelete) {
    return false;
  }
  if (
    input.canEnable &&
    (input.state !== "deletion-complete" || input.canRecover)
  ) {
    return false;
  }
  if (
    input.state === "deletion-complete" &&
    !input.canEnable &&
    !input.canRecover
  ) {
    return false;
  }
  return (
    (input.state === "deletion-pending" &&
      (input.deletion.status === "queued" ||
        input.deletion.status === "running")) ||
    (input.state === "deletion-complete" &&
      input.deletion.status === "complete") ||
    (input.state === "deletion-failed" && input.deletion.status === "failed")
  );
}

export function isCompanionContributionStatusSource(
  value: unknown,
): value is CompanionContributionStatusSource {
  if (!isPlainRecord(value) || !hasExactKeys(value, SOURCE_KEYS)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "status");
  return (
    descriptor !== undefined &&
    "value" in descriptor &&
    typeof descriptor.value === "function"
  );
}

export function isCompanionContributionController(
  value: unknown,
): value is CompanionContributionController {
  if (!isPlainRecord(value) || !hasExactKeys(value, CONTROLLER_KEYS)) {
    return false;
  }
  for (const key of CONTROLLER_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      return false;
    }
  }
  return true;
}

export function projectCompanionContributionStatus(
  value: unknown,
  controlsAvailable = false,
): CompanionContributionStatusResponse {
  if (!isPlainRecord(value) || !hasExactKeys(value, RUNTIME_STATUS_KEYS)) {
    return UNAVAILABLE_COMPANION_CONTRIBUTION_STATUS;
  }
  try {
    const configured = ownDataValue(value, "configured");
    const secureStorage = ownDataValue(value, "secureStorage");
    const state = ownDataValue(value, "state");
    const enabled = ownDataValue(value, "enabled");
    const canEnable = ownDataValue(value, "canEnable");
    const canDelete = ownDataValue(value, "canDelete");
    const canRecover = ownDataValue(value, "canRecover");
    const outboxPending = ownDataValue(value, "outboxPending");
    const consentDocumentRevision = ownDataValue(
      value,
      "consentDocumentRevision",
    );
    const deletion = ownDataValue(value, "deletion");
    if (
      typeof configured !== "boolean" ||
      (secureStorage !== "os-backed" && secureStorage !== "unavailable") ||
      typeof state !== "string" ||
      !CONTRIBUTION_STATES.has(state) ||
      typeof enabled !== "boolean" ||
      typeof canEnable !== "boolean" ||
      typeof canDelete !== "boolean" ||
      typeof canRecover !== "boolean" ||
      typeof outboxPending !== "number" ||
      !Number.isSafeInteger(outboxPending) ||
      outboxPending < 0 ||
      (consentDocumentRevision !== null &&
        (typeof consentDocumentRevision !== "string" ||
          !CONSENT_REVISION_PATTERN.test(consentDocumentRevision))) ||
      (deletion !== null && !validDeletion(deletion))
    ) {
      return UNAVAILABLE_COMPANION_CONTRIBUTION_STATUS;
    }
    const projectedInput = Object.freeze({
      configured,
      secureStorage,
      state: state as ContributionRuntimeStatus["state"],
      enabled,
      canEnable,
      canDelete,
      canRecover,
      deletion: deletion as ContributionRuntimeStatus["deletion"],
    });
    if (!validStateInvariants(projectedInput)) {
      return UNAVAILABLE_COMPANION_CONTRIBUTION_STATUS;
    }
    const projectedCanRecover = controlsAvailable && canRecover;
    const available = state !== "unavailable";
    return Object.freeze({
      status: "ok",
      availability: available ? "available" : "unavailable",
      unavailableReason: available
        ? null
        : projectedCanRecover
          ? "recovery-required"
          : secureStorage === "unavailable"
          ? "secure-storage-unavailable"
          : "runtime-unavailable",
      secureStorage,
      state: projectedInput.state,
      enabled,
      canPreview: controlsAvailable && canEnable,
      canStop: controlsAvailable && state === "active",
      canDelete: controlsAvailable && canDelete,
      canRecover: projectedCanRecover,
      outboxPending,
      deletionStatus: projectedInput.deletion?.status ?? null,
      anonymousHistoricalTotalsRetained:
        projectedInput.deletion?.anonymousHistoricalTotalsRetained ?? null,
    });
  } catch {
    return UNAVAILABLE_COMPANION_CONTRIBUTION_STATUS;
  }
}

export function readCompanionContributionStatus(
  source:
    | CompanionContributionStatusSource
    | CompanionContributionController
    | null,
): CompanionContributionStatusResponse {
  if (source === null) return UNAVAILABLE_COMPANION_CONTRIBUTION_STATUS;
  try {
    return projectCompanionContributionStatus(
      source.status(),
      isCompanionContributionController(source),
    );
  } catch {
    return UNAVAILABLE_COMPANION_CONTRIBUTION_STATUS;
  }
}
