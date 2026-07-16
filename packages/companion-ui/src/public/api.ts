import {
  CHARACTER_SELECT_ENDPOINT,
  CHARACTER_WARDROBE_ENDPOINT,
  USAGE_FAMILIES_API_ENDPOINT,
  USAGE_MODELS_API_ENDPOINT,
  hasExactKeys,
  isCharacterId,
  isCharacterThemeId,
  isRecord,
  parseCompanionSnapshot,
  parseUsageFamiliesResponse,
  parseUsageModelsResponse,
  type CharacterId,
  type CharacterSelectionResponse,
  type CharactersSnapshot,
  type CharacterThemeId,
  type CharacterWardrobeResponse,
  type UsageFamiliesResponse,
  type UsageModelsResponse,
  type UsageWindow
} from "./dto.js";

export type CharacterFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

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
  maximumBytes: number
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
  todayUtcDate = new Date().toISOString().slice(0, 10)
): Promise<UsageAnalyticsSnapshot> {
  const [familiesResponse, modelsResponse] = await Promise.all([
    fetcher(`${USAGE_FAMILIES_API_ENDPOINT}?window=${window}`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal
    }),
    fetcher(`${USAGE_MODELS_API_ENDPOINT}?window=${window}&limit=10`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal
    })
  ]);
  const [familiesValue, modelsValue] = await Promise.all([
    readUsageJson(familiesResponse),
    readUsageJson(modelsResponse)
  ]);
  if (!familiesResponse.ok) throwUsageResponseError(familiesValue);
  if (!modelsResponse.ok) throwUsageResponseError(modelsValue);
  try {
    return Object.freeze({
      families: parseUsageFamiliesResponse(
        familiesValue,
        todayUtcDate,
        window
      ),
      models: parseUsageModelsResponse(modelsValue, window, 10)
    });
  } catch (error) {
    if (error instanceof UsageAnalyticsError) throw error;
    throw new UsageAnalyticsError("invalid-response");
  }
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
      selectedBy: "manual"
    })
  });
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
    activeThemeId: value["activeThemeId"]
  });
}

export async function requestCharacterSelection(
  characterId: CharacterId,
  fetcher: CharacterFetch = fetch
): Promise<CharacterSelectionResponse> {
  const response = await fetcher(CHARACTER_SELECT_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ characterId })
  });
  if (!response.ok) throw new Error("Character selection failed");
  return parseSelectionResponse(await readCharacterJson(response));
}

export async function requestCharacterWardrobe(
  characterId: CharacterId,
  themeId: CharacterThemeId,
  fetcher: CharacterFetch = fetch
): Promise<CharacterWardrobeResponse> {
  const response = await fetcher(CHARACTER_WARDROBE_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ characterId, themeId })
  });
  if (!response.ok) throw new Error("Character wardrobe update failed");
  return parseWardrobeResponse(await readCharacterJson(response));
}

export function applyCharacterSelection(
  snapshot: CharactersSnapshot,
  response: CharacterSelectionResponse
): CharactersSnapshot {
  const character = snapshot.characters.find(
    (candidate) =>
      candidate.characterId === response.selection.characterId &&
      candidate.unlocked
  );
  if (character === undefined) {
    throw new TypeError("Invalid character selection response");
  }
  return Object.freeze({
    ...snapshot,
    selection: response.selection
  });
}

export function applyCharacterWardrobe(
  snapshot: CharactersSnapshot,
  response: CharacterWardrobeResponse
): CharactersSnapshot {
  let matched = false;
  const characters = snapshot.characters.map((character) => {
    if (character.characterId !== response.characterId) return character;
    if (
      character.visual.mode !== "doll" ||
      !character.visual.themes.some(
        (theme) =>
          theme.themeId === response.activeThemeId && theme.unlocked
      )
    ) {
      throw new TypeError("Invalid character wardrobe response");
    }
    matched = true;
    return Object.freeze({
      ...character,
      activeThemeId: response.activeThemeId
    });
  });
  if (!matched) throw new TypeError("Invalid character wardrobe response");
  return Object.freeze({
    ...snapshot,
    characters: Object.freeze(characters)
  });
}
