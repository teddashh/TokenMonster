import type {
  CharacterRosterEntry,
  CharacterThemeId
} from "./dto.js";

export const CHARACTER_THEME_LABELS = Object.freeze({
  tech: "科技",
  finance: "金融",
  politics: "政治",
  education: "教育",
  health: "健康",
  environment: "環境",
  law: "法律",
  relationship: "關係",
  family: "家庭",
  workplace: "職場",
  science: "科學",
  culture: "文化",
  sports: "運動",
  food: "美食",
  travel: "旅行",
  psychology: "心理",
  philosophy: "哲學",
  international: "國際",
  media: "媒體",
  festival: "節慶"
} as const satisfies Readonly<Record<CharacterThemeId, string>>);

export function characterUnlockExplanation(
  character: CharacterRosterEntry
): string {
  return (
    character.progress?.explain ??
    "她會照自己的步調準備好，不需要為了解鎖多用 token。"
  );
}
