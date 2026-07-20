import type { CharacterRosterEntry } from "./dto.js";

export interface CharacterCollectionView {
  readonly unlockedCount: number;
  readonly totalCount: number;
  readonly lockedCount: number;
  readonly nextProgressPercent: number | null;
}

/**
 * Summarizes the local collection without exposing a locked identity. The next
 * percentage is the closest naturally advancing character, not an instruction
 * to generate more usage.
 */
export function characterCollectionView(
  characters: readonly CharacterRosterEntry[],
): CharacterCollectionView {
  const unlockedCount = characters.filter(
    (character) => character.unlocked,
  ).length;
  const lockedProgress = characters.flatMap((character) =>
    character.unlocked || character.progress === null
      ? []
      : [character.progress.value],
  );
  const nextProgress =
    lockedProgress.length === 0 ? null : Math.max(...lockedProgress);
  return Object.freeze({
    unlockedCount,
    totalCount: characters.length,
    lockedCount: characters.length - unlockedCount,
    nextProgressPercent:
      nextProgress === null
        ? null
        : Math.min(99, Math.round(nextProgress * 100)),
  });
}
