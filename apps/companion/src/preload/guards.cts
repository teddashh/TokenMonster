import type {
  ByokChatRequest,
  CharacterSummary,
  CollectorScanRequest,
  ConfigureByokRequest,
  ContributionDeleteRequest,
  ContributionDeletionStatusRequest,
  ContributionEnableRequest,
  ContributionPreviewRequest,
  ContributionStopRequest,
  ContributionSyncRequest,
  FixedInteractionRequest,
  LocalSourceResetRequest,
  ShareCardSaveRequest,
  UsageInsightsRequest
} from "../shared/ipc.js";

const CHARACTER_IDS = new Set(["chatgpt", "claude", "gemini", "grok"]);
const TRIGGERS = new Set(["greeting", "idle"]);
const COLLECTOR_CLIENTS = new Set(["claude", "codex", "gemini", "grok"]);
const COLLECTOR_DAYS = new Set(["today", "previous"]);
const USAGE_INSIGHT_WINDOWS = new Set([7, 28]);
const API_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{16,509}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const encoder = new TextEncoder();

function plainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Record<PropertyKey, unknown> {
  if (!plainRecord(value)) throw new Error("IPC_REQUEST_REJECTED");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("IPC_REQUEST_REJECTED");
    }
  }
  return value;
}

function valueOf(record: Record<PropertyKey, unknown>, key: string): unknown {
  return (Object.getOwnPropertyDescriptor(record, key) as PropertyDescriptor)
    .value as unknown;
}

function validatedCharacterId(value: unknown): CharacterSummary["id"] {
  if (typeof value !== "string" || !CHARACTER_IDS.has(value)) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  return value as CharacterSummary["id"];
}

function fixedRequest(value: unknown): FixedInteractionRequest {
  const record = exactDataRecord(value, ["characterId", "trigger"]);
  const trigger = valueOf(record, "trigger");
  if (typeof trigger !== "string" || !TRIGGERS.has(trigger)) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  return Object.freeze({
    characterId: validatedCharacterId(valueOf(record, "characterId")),
    trigger: trigger as FixedInteractionRequest["trigger"]
  });
}

function configureRequest(value: unknown): ConfigureByokRequest {
  const record = exactDataRecord(value, ["apiKey", "persist"]);
  const apiKey = valueOf(record, "apiKey");
  const persist = valueOf(record, "persist");
  if (
    typeof apiKey !== "string" ||
    !API_KEY_PATTERN.test(apiKey) ||
    typeof persist !== "boolean"
  ) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  return Object.freeze({ apiKey, persist });
}

function chatRequest(value: unknown): ByokChatRequest {
  const record = exactDataRecord(value, ["characterId", "message"]);
  const message = valueOf(record, "message");
  if (
    typeof message !== "string" ||
    message.trim().length === 0 ||
    message.includes("\0") ||
    encoder.encode(message).byteLength > 4_096
  ) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  return Object.freeze({
    characterId: validatedCharacterId(valueOf(record, "characterId")),
    message
  });
}

function collectorScanRequest(value: unknown): CollectorScanRequest {
  const record = exactDataRecord(value, ["client", "day"]);
  const client = valueOf(record, "client");
  const day = valueOf(record, "day");
  if (
    typeof client !== "string" ||
    !COLLECTOR_CLIENTS.has(client) ||
    typeof day !== "string" ||
    !COLLECTOR_DAYS.has(day)
  ) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  return Object.freeze({
    client: client as CollectorScanRequest["client"],
    day: day as CollectorScanRequest["day"]
  });
}

function usageInsightsRequest(value: unknown): UsageInsightsRequest {
  const record = exactDataRecord(value, ["windowDays"]);
  const windowDays = valueOf(record, "windowDays");
  if (
    typeof windowDays !== "number" ||
    !USAGE_INSIGHT_WINDOWS.has(windowDays)
  ) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  return Object.freeze({
    windowDays: windowDays as UsageInsightsRequest["windowDays"]
  });
}

function shareCardSaveRequest(value: unknown): ShareCardSaveRequest {
  const record = exactDataRecord(value, ["windowDays", "characterId"]);
  const windowDays = valueOf(record, "windowDays");
  if (
    typeof windowDays !== "number" ||
    !USAGE_INSIGHT_WINDOWS.has(windowDays)
  ) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  return Object.freeze({
    windowDays: windowDays as ShareCardSaveRequest["windowDays"],
    characterId: validatedCharacterId(valueOf(record, "characterId"))
  });
}

function localSourceResetRequest(value: unknown): LocalSourceResetRequest {
  const record = exactDataRecord(value, ["confirmation"]);
  if (valueOf(record, "confirmation") !== "clear-collector-derived-data") {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  return Object.freeze({
    confirmation: "clear-collector-derived-data" as const
  });
}

function fixedConfirmation<T extends string>(
  value: unknown,
  confirmation: T
): Readonly<{ confirmation: T }> {
  const record = exactDataRecord(value, ["confirmation"]);
  if (valueOf(record, "confirmation") !== confirmation) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  return Object.freeze({ confirmation });
}

function contributionPreviewRequest(value: unknown): ContributionPreviewRequest {
  return fixedConfirmation(value, "preview-content-blind-contribution");
}

function contributionEnableRequest(value: unknown): ContributionEnableRequest {
  const record = exactDataRecord(value, ["confirmation", "previewId"]);
  const previewId = valueOf(record, "previewId");
  if (
    valueOf(record, "confirmation") !== "enable-content-blind-contribution" ||
    typeof previewId !== "string" ||
    !UUID_PATTERN.test(previewId)
  ) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  return Object.freeze({
    confirmation: "enable-content-blind-contribution" as const,
    previewId
  });
}

function contributionSyncRequest(value: unknown): ContributionSyncRequest {
  return fixedConfirmation(value, "sync-content-blind-contribution");
}

function contributionStopRequest(value: unknown): ContributionStopRequest {
  return fixedConfirmation(value, "stop-content-blind-contribution");
}

function contributionDeleteRequest(value: unknown): ContributionDeleteRequest {
  return fixedConfirmation(value, "delete-identifiable-contribution-data");
}

function contributionDeletionStatusRequest(
  value: unknown
): ContributionDeletionStatusRequest {
  return fixedConfirmation(value, "check-contribution-deletion-status");
}

type PreloadInvoke = (
  channel: string,
  argument?: unknown
) => Promise<unknown>;

function createInvokeGuard(invoke: PreloadInvoke): PreloadInvoke {
  const inFlight = new Set<string>();
  return async (channel, argument) => {
    if (inFlight.has(channel)) throw new Error("IPC_REQUEST_BUSY");
    inFlight.add(channel);
    try {
      return await invoke(channel, argument);
    } finally {
      inFlight.delete(channel);
    }
  };
}

export = Object.freeze({
  chatRequest,
  collectorScanRequest,
  configureRequest,
  contributionDeleteRequest,
  contributionDeletionStatusRequest,
  contributionEnableRequest,
  contributionPreviewRequest,
  contributionStopRequest,
  contributionSyncRequest,
  createInvokeGuard,
  fixedRequest,
  localSourceResetRequest,
  shareCardSaveRequest,
  usageInsightsRequest,
  validatedCharacterId
});
