import type {
  CharacterRosterEntry,
  CharacterThemeId
} from "./dto.js";
import { getUiLocale, localizeUiText } from "./localization.js";

const THEME_LABEL_ZH = Object.freeze({
  tech: "科技", finance: "金融", politics: "政治", education: "教育",
  health: "健康", environment: "環境", law: "法律", relationship: "關係",
  family: "家庭", workplace: "職場", science: "科學", culture: "文化",
  sports: "運動", food: "美食", travel: "旅行", psychology: "心理",
  philosophy: "哲學", international: "國際", media: "媒體", festival: "節慶",
} as const satisfies Readonly<Record<CharacterThemeId, string>>);

export function characterThemeLabel(themeId: CharacterThemeId): string {
  return localizeUiText(THEME_LABEL_ZH[themeId]);
}

export function characterThemeStageGreetingLabel(
  displayName: string,
  themeId: CharacterThemeId,
): string {
  return getUiLocale() === "en"
    ? `Tap to say hello to ${displayName}, ${characterThemeAccessibleLabel(themeId)}`
    : `點一下和 ${displayName} 打招呼，${characterThemeAccessibleLabel(themeId)}`;
}

export function characterThemeWearLabel(themeId: CharacterThemeId): string {
  return getUiLocale() === "en"
    ? `Wear ${characterThemeLabel(themeId)} outfit`
    : `換上${characterThemeLabel(themeId)}服裝`;
}

export function characterThemeUnavailableLabel(
  themeId: CharacterThemeId,
): string {
  return getUiLocale() === "en"
    ? `${characterThemeAccessibleLabel(themeId)} is temporarily unavailable until the character state settles.`
    : `${characterThemeAccessibleLabel(themeId)}暫時停用，角色狀態完成後即可選擇。`;
}

export function characterThemeLockedLabel(
  themeId: CharacterThemeId,
  explanation?: string,
): string {
  if (getUiLocale() === "en") {
    return explanation === undefined
      ? `${characterThemeAccessibleLabel(themeId)} is locked and unlocks naturally through local usage milestones.`
      : `${characterThemeAccessibleLabel(themeId)} is locked. ${explanation}`;
  }
  return explanation === undefined
    ? `${characterThemeAccessibleLabel(themeId)}尚未解鎖，會隨本機使用里程自然解鎖。`
    : `${characterThemeLabel(themeId)}服裝尚未解鎖。${explanation}`;
}

export function characterThemeAccessibleLabel(themeId: CharacterThemeId): string {
  const label = characterThemeLabel(themeId);
  return getUiLocale() === "en" ? `${label} outfit` : `${label}服裝`;
}

export function characterUnlockExplanation(
  character: CharacterRosterEntry
): string {
  if (getUiLocale() === "en") {
    return "She will get ready at her own pace. No extra token use is needed to unlock her.";
  }
  return (
    character.progress?.explain ??
    "她會照自己的步調準備好，不需要為了解鎖多用 token。"
  );
}
