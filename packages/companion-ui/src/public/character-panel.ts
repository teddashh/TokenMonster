import { resolveCharacterPose } from "./character-state.js";
import type {
  CharacterConnectionState,
  CharacterRosterEntry,
  CharacterTheme
} from "./dto.js";

/** GLM is the sole roster character whose product visual is letter-based. */
export function isGlmLetterCharacter(
  character: CharacterRosterEntry
): boolean {
  return character.characterId === "glm" && character.visual.mode === "letter";
}

export function activeCharacterTheme(
  character: CharacterRosterEntry
): CharacterTheme | undefined {
  if (character.visual.mode !== "doll") return undefined;
  return (
    character.visual.themes.find(
      (theme) =>
        theme.themeId === character.activeThemeId && theme.unlocked
    ) ?? character.visual.themes.find((theme) => theme.unlocked)
  );
}

export function resolveStageImagePath(
  character: CharacterRosterEntry,
  connection: CharacterConnectionState,
  todayTokens: number,
  celebrating: boolean
): string | undefined {
  const theme = activeCharacterTheme(character);
  if (theme === undefined) return undefined;
  const pose = resolveCharacterPose(connection, todayTokens, celebrating);
  return pose === null
    ? theme.outfitPath
    : (theme.posePaths[pose] ?? theme.outfitPath);
}
