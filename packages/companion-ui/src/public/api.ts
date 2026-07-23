import {
  BYOK_CHAT_ENDPOINT,
  BYOK_CLEAR_ENDPOINT,
  BYOK_CONFIGURE_ENDPOINT,
  BYOK_STATUS_ENDPOINT,
  CHARACTER_ASSET_PACK_CONSENT_ENDPOINT,
  CHARACTER_ASSET_PACK_STATUS_ENDPOINT,
  CHARACTER_INTERACT_ENDPOINT,
  CHARACTER_PROFILE_ENDPOINT,
  CHARACTER_PROGRESSION_LOCK_REPAIR_ENDPOINT,
  CHARACTER_SELECT_ENDPOINT,
  CHARACTER_WARDROBE_ENDPOINT,
  USAGE_QUOTA_API_ENDPOINT,
  USAGE_QUOTA_PLAN_API_ENDPOINT,
  USAGE_FAMILIES_API_ENDPOINT,
  USAGE_MODELS_API_ENDPOINT,
  UI_LOCALE_PREFERENCE_ENDPOINT,
  hasExactKeys,
  isCharacterId,
  isCharacterThemeId,
  isRecord,
  parseCharacterInteractionResponse,
  parseCharacterAssetPackStatus,
  parseCharacterProfileResponse,
  parseCompanionSnapshot,
  parseQuotaSnapshot,
  parseUsageFamiliesResponse,
  parseUsageModelsResponse,
  parseUiLocalePreferenceResponse,
  type CharacterId,
  type CharacterAssetPackStatus,
  type CharacterInteractionAction,
  type CharacterInteractionLocale,
  type CharacterInteractionResponse,
  type CharacterProfileResponse,
  type CharacterProgressionLockRepairResponse,
  type CharacterSelectionResponse,
  type CharactersSnapshot,
  type CharacterThemeId,
  type CharacterWardrobeResponse,
  type ByokChatErrorCode,
  type ByokChatMessage,
  type ByokChatResponse,
  type ByokStatusResponse,
  type QuotaFamily,
  type QuotaSnapshot,
  type UsageFamiliesResponse,
  type UsageModelsResponse,
  type UsageWindow,
  type UiLocale,
  type UiLocalePreferenceResponse,
} from "./dto.js";
import type { ByokChatCharacterId } from "./byok-chat.js";

export type CharacterFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function requestUiLocalePreference(
  fetcher: CharacterFetch = fetch,
  signal?: AbortSignal,
): Promise<UiLocalePreferenceResponse> {
  const response = await fetcher(UI_LOCALE_PREFERENCE_ENDPOINT, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error("UI locale preference unavailable");
  return parseUiLocalePreferenceResponse(await readCharacterJson(response));
}

export async function saveUiLocalePreference(
  locale: UiLocale,
  expectedRevision: number,
  fetcher: CharacterFetch = fetch,
  signal?: AbortSignal,
): Promise<UiLocalePreferenceResponse> {
  const response = await fetcher(UI_LOCALE_PREFERENCE_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ locale, expectedRevision }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error("UI locale preference update failed");
  return parseUiLocalePreferenceResponse(await readCharacterJson(response));
}

export type CharacterProgressionWriteErrorCode =
  | "store-busy"
  | "request-failed";

export class CharacterProgressionWriteError extends Error {
  public constructor(public readonly code: CharacterProgressionWriteErrorCode) {
    super(code);
    this.name = "CharacterProgressionWriteError";
  }
}

export type ByokRequestErrorCode =
  | "invalid-key"
  | "storage-failed"
  | "unavailable"
  | "request-failed";

export class ByokRequestError extends Error {
  public constructor(public readonly code: ByokRequestErrorCode) {
    super(code);
    this.name = "ByokRequestError";
  }
}

export interface UsageAnalyticsSnapshot {
  readonly families: UsageFamiliesResponse;
  readonly models: UsageModelsResponse;
}

export type UsageAnalyticsErrorCode =
  | "request-rejected"
  | "sidecar-unavailable"
  | "sidecar-incompatible"
  | "invalid-response";

export class UsageAnalyticsError extends Error {
  public constructor(public readonly code: UsageAnalyticsErrorCode) {
    super(code);
    this.name = "UsageAnalyticsError";
  }
}

// Reads at most maximumBytes before giving up, so a hostile loopback peer
// cannot make the renderer buffer an unbounded body ahead of the size check.
async function readBodyWithinLimit(
  response: Response,
  maximumBytes: number,
): Promise<string | undefined> {
  if (response.body === null) {
    const body = await response.text();
    return body.length > maximumBytes ? undefined : body;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export async function readCharacterJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (
    !contentType.toLowerCase().startsWith("application/json") ||
    (Number.isFinite(declaredLength) && declaredLength > 262_144)
  ) {
    throw new TypeError("Invalid characters response");
  }
  const body = await readBodyWithinLimit(response, 262_144);
  if (body === undefined) {
    throw new TypeError("Invalid characters response");
  }
  return JSON.parse(body) as unknown;
}

async function readUsageJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (
    !contentType.toLowerCase().startsWith("application/json") ||
    (Number.isFinite(declaredLength) && declaredLength > 65_536)
  ) {
    throw new UsageAnalyticsError("invalid-response");
  }
  const body = await readBodyWithinLimit(response, 65_536);
  if (body === undefined) {
    throw new UsageAnalyticsError("invalid-response");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new UsageAnalyticsError("invalid-response");
  }
}

function throwUsageResponseError(value: unknown): never {
  if (
    isRecord(value) &&
    hasExactKeys(value, ["error"]) &&
    value["error"] === "request-rejected"
  ) {
    throw new UsageAnalyticsError("request-rejected");
  }
  try {
    const parsed = parseCompanionSnapshot(value);
    if (parsed.status === "error") {
      throw new UsageAnalyticsError(parsed.error);
    }
  } catch (error) {
    if (error instanceof UsageAnalyticsError) throw error;
  }
  throw new UsageAnalyticsError("invalid-response");
}

export async function requestUsageAnalytics(
  window: UsageWindow,
  signal: AbortSignal,
  fetcher: CharacterFetch = fetch,
  todayUtcDate = new Date().toISOString().slice(0, 10),
): Promise<UsageAnalyticsSnapshot> {
  const [familiesResponse, modelsResponse] = await Promise.all([
    fetcher(`${USAGE_FAMILIES_API_ENDPOINT}?window=${window}`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal,
    }),
    fetcher(`${USAGE_MODELS_API_ENDPOINT}?window=${window}&limit=10`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal,
    }),
  ]);
  const [familiesValue, modelsValue] = await Promise.all([
    readUsageJson(familiesResponse),
    readUsageJson(modelsResponse),
  ]);
  if (!familiesResponse.ok) throwUsageResponseError(familiesValue);
  if (!modelsResponse.ok) throwUsageResponseError(modelsValue);
  try {
    return Object.freeze({
      families: parseUsageFamiliesResponse(familiesValue, todayUtcDate, window),
      models: parseUsageModelsResponse(modelsValue, window, 10),
    });
  } catch (error) {
    if (error instanceof UsageAnalyticsError) throw error;
    throw new UsageAnalyticsError("invalid-response");
  }
}

export async function requestQuotaSnapshot(
  signal: AbortSignal,
  fetcher: CharacterFetch = fetch,
): Promise<QuotaSnapshot> {
  const response = await fetcher(USAGE_QUOTA_API_ENDPOINT, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error("Quota estimate unavailable");
  return parseQuotaSnapshot(await readUsageJson(response));
}

export async function updateQuotaPlan(
  family: QuotaFamily,
  planId: string | null,
  fetcher: CharacterFetch = fetch,
): Promise<QuotaSnapshot> {
  const response = await fetcher(USAGE_QUOTA_PLAN_API_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ family, planId }),
  });
  if (!response.ok) throw new Error("Quota plan update failed");
  return parseQuotaSnapshot(await readUsageJson(response));
}

function parseSelectionResponse(value: unknown): CharacterSelectionResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["status", "selection"]) ||
    value["status"] !== "ok" ||
    !isRecord(value["selection"]) ||
    !hasExactKeys(value["selection"], ["characterId", "selectedBy"]) ||
    !isCharacterId(value["selection"]["characterId"]) ||
    value["selection"]["selectedBy"] !== "manual"
  ) {
    throw new TypeError("Invalid character selection response");
  }
  return Object.freeze({
    status: "ok",
    selection: Object.freeze({
      characterId: value["selection"]["characterId"],
      selectedBy: "manual",
    }),
  });
}

function parseProgressionLockRepairResponse(
  value: unknown,
): CharacterProgressionLockRepairResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["status", "outcome"]) ||
    value["status"] !== "ok" ||
    (value["outcome"] !== "repaired" && value["outcome"] !== "not-needed")
  ) {
    throw new TypeError("Invalid progression lock repair response");
  }
  return Object.freeze({
    status: "ok",
    outcome: value["outcome"],
  });
}

function isStoreBusyResponse(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["status", "error"]) &&
    value["status"] === "error" &&
    value["error"] === "store-busy"
  );
}

async function throwProgressionWriteError(response: Response): Promise<never> {
  try {
    if (isStoreBusyResponse(await readCharacterJson(response))) {
      throw new CharacterProgressionWriteError("store-busy");
    }
  } catch (error) {
    if (error instanceof CharacterProgressionWriteError) throw error;
  }
  throw new CharacterProgressionWriteError("request-failed");
}

function parseWardrobeResponse(value: unknown): CharacterWardrobeResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["status", "characterId", "activeThemeId"]) ||
    value["status"] !== "ok" ||
    !isCharacterId(value["characterId"]) ||
    !isCharacterThemeId(value["activeThemeId"])
  ) {
    throw new TypeError("Invalid character wardrobe response");
  }
  return Object.freeze({
    status: "ok",
    characterId: value["characterId"],
    activeThemeId: value["activeThemeId"],
  });
}

export async function requestCharacterSelection(
  characterId: CharacterId,
  fetcher: CharacterFetch = fetch,
  signal?: AbortSignal,
): Promise<CharacterSelectionResponse> {
  const response = await fetcher(CHARACTER_SELECT_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ characterId }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) return throwProgressionWriteError(response);
  return parseSelectionResponse(await readCharacterJson(response));
}

/**
 * Repairs only the old-version progression lock. The caller must obtain the
 * player's explicit confirmation that every older TokenMonster process is
 * closed before invoking this request.
 */
export async function requestCharacterProgressionLockRepair(
  fetcher: CharacterFetch = fetch,
  signal?: AbortSignal,
): Promise<CharacterProgressionLockRepairResponse> {
  const response = await fetcher(CHARACTER_PROGRESSION_LOCK_REPAIR_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ confirmedOldVersionsClosed: true }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) return throwProgressionWriteError(response);
  return parseProgressionLockRepairResponse(await readCharacterJson(response));
}

const BYOK_CHAT_ERROR_CODES = new Set<ByokChatErrorCode>([
  "unavailable",
  "not-configured",
  "busy",
  "request-timeout",
  "request-aborted",
  "network-error",
  "provider-authentication-failed",
  "provider-rate-limited",
  "provider-request-rejected",
  "provider-unavailable",
  "provider-error",
  "response-too-large",
  "malformed-response",
  "incomplete-response",
  "unsupported-response",
  "empty-response",
  "local-service-error",
]);

function parseByokStatus(value: unknown): ByokStatusResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "status",
      "availability",
      "configured",
      "persistence",
      "canPersist",
      "provider",
      "model",
    ]) ||
    value["status"] !== "ok" ||
    (value["availability"] !== "available" &&
      value["availability"] !== "unavailable") ||
    typeof value["configured"] !== "boolean" ||
    (value["persistence"] !== "os-backed" &&
      value["persistence"] !== "memory-only") ||
    typeof value["canPersist"] !== "boolean" ||
    value["provider"] !== "OpenAI" ||
    value["model"] !== "gpt-5.6-luna" ||
    (value["availability"] === "unavailable" &&
      (value["configured"] ||
        value["canPersist"] ||
        value["persistence"] !== "memory-only")) ||
    (!value["configured"] && value["persistence"] !== "memory-only") ||
    (value["persistence"] === "os-backed" && !value["canPersist"])
  ) {
    throw new TypeError("Invalid BYOK status response");
  }
  return Object.freeze({
    status: "ok",
    availability: value["availability"],
    configured: value["configured"],
    persistence: value["persistence"],
    canPersist: value["canPersist"],
    provider: "OpenAI",
    model: "gpt-5.6-luna",
  });
}

function parseByokError(value: unknown): ByokRequestErrorCode {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["status", "error"]) ||
    value["status"] !== "error"
  ) {
    return "request-failed";
  }
  return value["error"] === "invalid-key" ||
    value["error"] === "storage-failed" ||
    value["error"] === "unavailable"
    ? value["error"]
    : "request-failed";
}

function parseByokChatResponse(value: unknown): ByokChatResponse {
  if (!isRecord(value) || !hasExactKeys(value, ["status", "characterId", value["status"] === "ok" ? "text" : "error"])) {
    throw new TypeError("Invalid BYOK chat response");
  }
  const characterId = value["characterId"];
  if (
    characterId !== "chatgpt" &&
    characterId !== "claude" &&
    characterId !== "gemini" &&
    characterId !== "grok"
  ) {
    throw new TypeError("Invalid BYOK chat response");
  }
  if (value["status"] === "ok") {
    const text = value["text"];
    if (
      typeof text !== "string" ||
      text.trim().length === 0 ||
      text.includes("\0") ||
      new TextEncoder().encode(text).byteLength > 16_384
    ) {
      throw new TypeError("Invalid BYOK chat response");
    }
    return Object.freeze({ status: "ok", characterId, text });
  }
  if (
    value["status"] !== "error" ||
    typeof value["error"] !== "string" ||
    !BYOK_CHAT_ERROR_CODES.has(value["error"] as ByokChatErrorCode)
  ) {
    throw new TypeError("Invalid BYOK chat response");
  }
  return Object.freeze({
    status: "error",
    characterId,
    error: value["error"] as ByokChatErrorCode,
  });
}

export async function requestByokStatus(
  fetcher: CharacterFetch = fetch,
  signal?: AbortSignal,
): Promise<ByokStatusResponse> {
  const response = await fetcher(BYOK_STATUS_ENDPOINT, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new ByokRequestError("request-failed");
  return parseByokStatus(await readCharacterJson(response));
}

export async function configureByok(
  apiKey: string,
  persist: boolean,
  fetcher: CharacterFetch = fetch,
  signal?: AbortSignal,
): Promise<ByokStatusResponse> {
  const response = await fetcher(BYOK_CONFIGURE_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ apiKey, persist }),
    ...(signal === undefined ? {} : { signal }),
  });
  const value = await readCharacterJson(response);
  if (!response.ok) throw new ByokRequestError(parseByokError(value));
  return parseByokStatus(value);
}

export async function clearByok(
  fetcher: CharacterFetch = fetch,
  signal?: AbortSignal,
): Promise<ByokStatusResponse> {
  const response = await fetcher(BYOK_CLEAR_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ confirmation: "clear-openai-byok" }),
    ...(signal === undefined ? {} : { signal }),
  });
  const value = await readCharacterJson(response);
  if (!response.ok) throw new ByokRequestError(parseByokError(value));
  return parseByokStatus(value);
}

export async function requestByokChat(
  characterId: ByokChatCharacterId,
  history: readonly ByokChatMessage[],
  message: string,
  fetcher: CharacterFetch = fetch,
  signal?: AbortSignal,
): Promise<ByokChatResponse> {
  const response = await fetcher(BYOK_CHAT_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ characterId, history, message }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new ByokRequestError("request-failed");
  return parseByokChatResponse(await readCharacterJson(response));
}

export async function requestCharacterAssetPackStatus(
  fetcher: CharacterFetch = fetch,
  signal?: AbortSignal,
): Promise<CharacterAssetPackStatus> {
  const response = await fetcher(CHARACTER_ASSET_PACK_STATUS_ENDPOINT, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error("Character asset pack unavailable");
  return parseCharacterAssetPackStatus(await readCharacterJson(response));
}

export async function updateCharacterAssetPackConsent(
  enabled: boolean,
  fetcher: CharacterFetch = fetch,
  signal?: AbortSignal,
): Promise<CharacterAssetPackStatus> {
  const response = await fetcher(CHARACTER_ASSET_PACK_CONSENT_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enabled }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error("Character asset pack update failed");
  return parseCharacterAssetPackStatus(await readCharacterJson(response));
}

export interface CharacterAssetPackMutationSettlement {
  readonly status: CharacterAssetPackStatus;
  readonly responseRecovered: boolean;
  readonly mutationObserved: boolean;
}

function recoveredStatusObservesAssetPackMutation(
  enabled: boolean,
  status: CharacterAssetPackStatus,
): boolean {
  return enabled
    ? status.phase === "installed" && status.consented && status.enabled
    : status.phase === "available" &&
        !status.consented &&
        !status.enabled &&
        status.lastError === null;
}

/**
 * A POST can commit locally even when its response is lost. Re-read the
 * gateway's authoritative state with a fresh timeout, but call the mutation
 * observed only when that recovered state actually reflects the requested
 * consent direction. An unchanged pre-request GET is not success.
 */
export async function settleCharacterAssetPackConsent(
  enabled: boolean,
  fetcher: CharacterFetch = fetch,
  signal?: AbortSignal,
  recoveryTimeoutMs = 8_000,
): Promise<CharacterAssetPackMutationSettlement> {
  try {
    return Object.freeze({
      status: await updateCharacterAssetPackConsent(enabled, fetcher, signal),
      responseRecovered: false,
      mutationObserved: true,
    });
  } catch {
    if (
      !Number.isSafeInteger(recoveryTimeoutMs) ||
      recoveryTimeoutMs < 1 ||
      recoveryTimeoutMs > 30_000
    ) {
      throw new TypeError("Invalid asset pack recovery timeout");
    }
    const recoveryController = new AbortController();
    const timeout = setTimeout(
      () => recoveryController.abort(),
      recoveryTimeoutMs,
    );
    try {
      const status = await requestCharacterAssetPackStatus(
        fetcher,
        recoveryController.signal,
      );
      return Object.freeze({
        status,
        responseRecovered: true,
        mutationObserved: recoveredStatusObservesAssetPackMutation(
          enabled,
          status,
        ),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function requestCharacterInteraction(
  characterId: CharacterId,
  locale: CharacterInteractionLocale = "zh-TW",
  fetcher: CharacterFetch = fetch,
  signal?: AbortSignal,
  action: CharacterInteractionAction = "tap",
): Promise<CharacterInteractionResponse> {
  const response = await fetcher(CHARACTER_INTERACT_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ characterId, action, locale }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error("Character interaction failed");
  return parseCharacterInteractionResponse(await readCharacterJson(response));
}

export async function requestCharacterProfile(
  signal: AbortSignal,
  fetcher: CharacterFetch = fetch,
): Promise<CharacterProfileResponse> {
  const response = await fetcher(CHARACTER_PROFILE_ENDPOINT, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error("Character profile unavailable");
  return parseCharacterProfileResponse(await readCharacterJson(response));
}

export async function requestCharacterWardrobe(
  characterId: CharacterId,
  themeId: CharacterThemeId,
  fetcher: CharacterFetch = fetch,
  signal?: AbortSignal,
): Promise<CharacterWardrobeResponse> {
  const response = await fetcher(CHARACTER_WARDROBE_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ characterId, themeId }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error("Character wardrobe update failed");
  return parseWardrobeResponse(await readCharacterJson(response));
}

export function applyCharacterSelection(
  snapshot: CharactersSnapshot,
  response: CharacterSelectionResponse,
): CharactersSnapshot {
  const character = snapshot.characters.find(
    (candidate) => candidate.characterId === response.selection.characterId,
  );
  const initialStarterChoice =
    snapshot.selection.characterId === null && character?.isStarter === true;
  if (
    character === undefined ||
    (!character.unlocked && !initialStarterChoice)
  ) {
    throw new TypeError("Invalid character selection response");
  }
  const characters = initialStarterChoice
    ? snapshot.characters.map((candidate) =>
        candidate.characterId === character.characterId
          ? Object.freeze({
              ...candidate,
              unlocked: true,
              unlockedAt: snapshot.generatedAt,
              progress: null,
            })
          : candidate,
      )
    : snapshot.characters;
  return Object.freeze({
    ...snapshot,
    selection: response.selection,
    characters: Object.freeze(characters),
  });
}

export function applyCharacterWardrobe(
  snapshot: CharactersSnapshot,
  response: CharacterWardrobeResponse,
): CharactersSnapshot {
  let matched = false;
  const characters = snapshot.characters.map((character) => {
    if (character.characterId !== response.characterId) return character;
    matched = true;
    if (character.visual.mode === "letter") {
      const theme = character.visual.themes.find(
        (candidate) =>
          candidate.themeId === response.activeThemeId && candidate.unlocked,
      );
      if (theme === undefined) {
        throw new TypeError("Invalid character wardrobe response");
      }
      return Object.freeze({
        ...character,
        activeThemeId: response.activeThemeId,
        visual: Object.freeze({
          ...character.visual,
          background: theme.palette.background,
          foreground: theme.palette.foreground,
          accent: theme.palette.accent,
        }),
      });
    }
    if (
      !character.visual.themes.some(
        (candidate) =>
          candidate.themeId === response.activeThemeId && candidate.unlocked,
      )
    ) {
      throw new TypeError("Invalid character wardrobe response");
    }
    return Object.freeze({
      ...character,
      activeThemeId: response.activeThemeId,
    });
  });
  if (!matched) throw new TypeError("Invalid character wardrobe response");
  return Object.freeze({
    ...snapshot,
    characters: Object.freeze(characters),
  });
}
