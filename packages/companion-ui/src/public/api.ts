import {
  CHARACTER_SELECT_ENDPOINT,
  CHARACTER_WARDROBE_ENDPOINT,
  hasExactKeys,
  isCharacterId,
  isCharacterThemeId,
  isRecord,
  type CharacterId,
  type CharacterSelectionResponse,
  type CharactersSnapshot,
  type CharacterThemeId,
  type CharacterWardrobeResponse
} from "./dto.js";

export type CharacterFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export async function readCharacterJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (
    !contentType.toLowerCase().startsWith("application/json") ||
    (Number.isFinite(declaredLength) && declaredLength > 262_144)
  ) {
    throw new TypeError("Invalid characters response");
  }
  const body = await response.text();
  if (body.length > 262_144) {
    throw new TypeError("Invalid characters response");
  }
  return JSON.parse(body) as unknown;
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

