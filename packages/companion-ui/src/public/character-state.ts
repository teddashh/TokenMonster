import type {
  CharacterConnectionState,
  CharacterId,
  CharacterPose,
  CharactersSnapshot,
  CharacterUnlock,
} from "./dto.js";
import { characterThemeLabel } from "./wardrobe.js";
import { localizeUiText } from "./localization.js";

const INDIVIDUAL_UNLOCK_TOAST_LIMIT = 3;

export function diffCharacterUnlocks(
  previous: CharactersSnapshot | undefined,
  current: CharactersSnapshot,
): readonly CharacterUnlock[] {
  if (previous === undefined) return Object.freeze([]);
  const batchId = current.unlockBatchId ?? current.generatedAt;
  const previousById = new Map(
    previous.characters.map((character) => [character.characterId, character]),
  );
  const unlocks: CharacterUnlock[] = [];
  for (const character of current.characters) {
    const prior = previousById.get(character.characterId);
    if (
      character.unlocked &&
      character.unlockedAt !== null &&
      (!prior?.unlocked || prior.unlockedAt !== character.unlockedAt)
    ) {
      unlocks.push(
        Object.freeze({
          key: `character:${character.characterId}:${character.unlockedAt}`,
          batchId,
          kind: "character",
          characterId: character.characterId,
          displayName: character.displayName,
          themeId: null,
        }),
      );
    }
    const priorThemes = new Map(
      (prior?.visual.themes ?? []).map((theme) => [theme.themeId, theme]),
    );
    for (const theme of character.visual.themes) {
      if (theme.unlocked && !priorThemes.get(theme.themeId)?.unlocked) {
        unlocks.push(
          Object.freeze({
            key: `theme:${character.characterId}:${theme.themeId}`,
            batchId,
            kind: "theme",
            characterId: character.characterId,
            displayName: character.displayName,
            themeId: theme.themeId,
          }),
        );
      }
    }
  }
  return Object.freeze(unlocks);
}

export function coalesceCharacterUnlocks(
  unlocks: readonly CharacterUnlock[],
): readonly CharacterUnlock[] {
  if (unlocks.length <= INDIVIDUAL_UNLOCK_TOAST_LIMIT) return unlocks;
  const first = unlocks[0]!;
  const characterCount = unlocks.filter(
    (unlock) => unlock.kind === "character",
  ).length;
  const themeCount = unlocks.length - characterCount;
  return Object.freeze([
    Object.freeze({
      ...first,
      key: `summary:${first.batchId}`,
      summary: Object.freeze({ characterCount, themeCount }),
    }),
  ]);
}

export function characterUnlockToastText(unlock: CharacterUnlock): string {
  let raw: string;
  if (unlock.summary !== undefined) {
    const { characterCount, themeCount } = unlock.summary;
    if (characterCount > 0 && themeCount > 0) {
      raw = `解鎖了 ${characterCount} 位夥伴與 ${themeCount} 件服裝，到衣櫃看看`;
      return localizeUiText(raw);
    }
    if (themeCount > 0) {
      raw = `解鎖了 ${themeCount} 件新服裝，到衣櫃看看`;
      return localizeUiText(raw);
    }
    raw = `解鎖了 ${characterCount} 位新夥伴，到衣櫃看看`;
    return localizeUiText(raw);
  }
  raw = unlock.kind === "character"
    ? `${unlock.displayName} 來了！`
    : `${unlock.displayName} 的${characterThemeLabel(unlock.themeId!)}服裝準備好了！`;
  return localizeUiText(raw);
}

export interface CharacterUnlockQueue {
  enqueue(unlocks: readonly CharacterUnlock[]): CharacterUnlock | undefined;
  current(): CharacterUnlock | undefined;
  finish(): CharacterUnlock | undefined;
  pendingCount(): number;
}

export function createCharacterUnlockQueue(): CharacterUnlockQueue {
  const queued: CharacterUnlock[] = [];
  const seen = new Set<string>();
  let active: CharacterUnlock | undefined;
  return Object.freeze({
    enqueue(unlocks: readonly CharacterUnlock[]): CharacterUnlock | undefined {
      for (const unlock of coalesceCharacterUnlocks(unlocks)) {
        if (!seen.has(unlock.key)) {
          seen.add(unlock.key);
          queued.push(unlock);
        }
      }
      active ??= queued.shift();
      return active;
    },
    current(): CharacterUnlock | undefined {
      return active;
    },
    finish(): CharacterUnlock | undefined {
      active = queued.shift();
      return active;
    },
    pendingCount(): number {
      return queued.length;
    },
  });
}

export function resolveCharacterPose(
  connection: CharacterConnectionState,
  todayTokens: number,
  celebrating: boolean,
): CharacterPose | null {
  if (connection === "refresh-failed" || connection === "stale") {
    return "challenged";
  }
  if (celebrating) return "victory";
  if (connection === "healthy" && todayTokens > 0) return "supported";
  return null;
}

interface ImageFailure {
  failureCount: number;
  failedOnPoll: number;
}

export interface CharacterImageFallbackTracker {
  advancePoll(): void;
  reset(): void;
  canAttempt(characterId: CharacterId, path: string): boolean;
  recordFailure(characterId: CharacterId, path: string): void;
  recordSuccess(characterId: CharacterId, path: string): void;
}

export function createCharacterImageFallbackTracker(): CharacterImageFallbackTracker {
  let pollNumber = 0;
  const failures = new Map<string, ImageFailure>();
  const keyFor = (characterId: CharacterId, path: string): string =>
    `${characterId}:${path}`;
  return Object.freeze({
    advancePoll(): void {
      pollNumber += 1;
    },
    reset(): void {
      failures.clear();
    },
    canAttempt(characterId: CharacterId, path: string): boolean {
      const failure = failures.get(keyFor(characterId, path));
      return (
        failure === undefined ||
        (failure.failureCount === 1 && failure.failedOnPoll < pollNumber)
      );
    },
    recordFailure(characterId: CharacterId, path: string): void {
      const key = keyFor(characterId, path);
      const previous = failures.get(key);
      failures.set(key, {
        failureCount: (previous?.failureCount ?? 0) + 1,
        failedOnPoll: pollNumber,
      });
    },
    recordSuccess(characterId: CharacterId, path: string): void {
      failures.delete(keyFor(characterId, path));
    },
  });
}
