import {
  CHARACTER_IDS,
  listCharacters,
  type CharacterId,
} from "@tokenmonster/characters/catalog";

const DESCRIPTION_BY_ID = {
  chatgpt: "冷靜整理選項，陪你照自己的速度前進。",
  claude: "留意細節與停頓，不把忙碌程度當成成績。",
  gemini: "好奇觀察跨工具節奏，只描述、不評分。",
  grok: "直接而輕快，用短句說明今天的本地足跡。",
} as const satisfies Record<CharacterId, string>;

const catalog = listCharacters();
if (
  catalog.length !== CHARACTER_IDS.length ||
  CHARACTER_IDS.some((characterId, index) => catalog[index]?.id !== characterId)
) {
  throw new Error("Character catalog does not match the stable four-character release set.");
}

export type PublicCharacterChoice = Readonly<{
  id: CharacterId;
  alias: string;
  glyph: string;
  description: string;
}>;

export const PUBLIC_CHARACTER_CHOICES: readonly PublicCharacterChoice[] = Object.freeze(
  catalog.map((character) =>
    Object.freeze({
      id: character.id,
      alias: character.alias,
      glyph: character.glyph,
      description: DESCRIPTION_BY_ID[character.id],
    }),
  ),
);

export type { CharacterId };
