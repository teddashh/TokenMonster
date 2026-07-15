import {
  CHARACTER_IDS,
  getCharacterDefinition,
  type CharacterId,
} from "./catalog.js";

export type PlaceholderVisual = Readonly<{
  kind: "placeholder";
  characterId: CharacterId;
  renderer: "tokenmonster-letter-avatar-v1";
  glyph: string;
  theme: Readonly<{
    background: string;
    foreground: string;
    accent: string;
  }>;
  ariaLabel: string;
}>;

/**
 * The v1 runtime has no asset-bearing visual variant. Adding one requires a
 * new manifest schema with the complete rights gate and an explicit reviewed
 * runtime allowlist change.
 */
export type CharacterVisual = PlaceholderVisual;

const PLACEHOLDER_THEMES = {
  chatgpt: {
    background: "#DDF5EA",
    foreground: "#173F35",
    accent: "#4A9D84",
  },
  claude: {
    background: "#F7E5D5",
    foreground: "#553323",
    accent: "#C47C55",
  },
  gemini: {
    background: "#E4EBFF",
    foreground: "#263C74",
    accent: "#6D83D7",
  },
  grok: {
    background: "#ECEDEF",
    foreground: "#25282D",
    accent: "#777D87",
  },
} as const satisfies Record<CharacterId, PlaceholderVisual["theme"]>;

const PLACEHOLDERS = Object.fromEntries(
  CHARACTER_IDS.map((characterId) => {
    const character = getCharacterDefinition(characterId);
    const placeholder: PlaceholderVisual = Object.freeze({
      kind: "placeholder",
      characterId,
      renderer: "tokenmonster-letter-avatar-v1",
      glyph: character.glyph,
      theme: Object.freeze({ ...PLACEHOLDER_THEMES[characterId] }),
      ariaLabel: `${character.alias} letter character placeholder`,
    });
    return [characterId, placeholder] as const;
  }),
) as Record<CharacterId, PlaceholderVisual>;

export function getPlaceholderVisual(characterId: CharacterId): PlaceholderVisual {
  return PLACEHOLDERS[characterId];
}

/**
 * Legacy v1 candidate manifests are repository-only audit inputs. Their
 * status fields are not a complete rights grant, so runtime resolution is
 * intentionally fail-closed for every possible v1 document.
 */
export function resolveCharacterVisualFromManifest(
  characterId: CharacterId,
  _candidateManifest: unknown,
): CharacterVisual {
  return getPlaceholderVisual(characterId);
}

export function resolveCharacterVisual(characterId: CharacterId): CharacterVisual {
  return getPlaceholderVisual(characterId);
}
