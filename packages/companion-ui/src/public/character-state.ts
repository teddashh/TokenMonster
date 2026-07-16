import type {
  CharacterConnectionState,
  CharacterId,
  CharacterPose,
  CharactersSnapshot,
  CharacterUnlock
} from "./dto.js";

export function diffCharacterUnlocks(
  previous: CharactersSnapshot | undefined,
  current: CharactersSnapshot
): readonly CharacterUnlock[] {
  if (previous === undefined) return Object.freeze([]);
  const previousById = new Map(
    previous.characters.map((character) => [character.characterId, character])
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
          kind: "character",
          characterId: character.characterId,
          displayName: character.displayName,
          themeId: null
        })
      );
    }
    if (character.visual.mode !== "doll") continue;
    const priorThemes = new Map(
      prior?.visual.mode === "doll"
        ? prior.visual.themes.map((theme) => [theme.themeId, theme])
        : []
    );
    for (const theme of character.visual.themes) {
      if (theme.unlocked && !priorThemes.get(theme.themeId)?.unlocked) {
        unlocks.push(
          Object.freeze({
            key: `theme:${character.characterId}:${theme.themeId}`,
            kind: "theme",
            characterId: character.characterId,
            displayName: character.displayName,
            themeId: theme.themeId
          })
        );
      }
    }
  }
  return Object.freeze(unlocks);
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
      for (const unlock of unlocks) {
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
    }
  });
}

export function resolveCharacterPose(
  connection: CharacterConnectionState,
  todayTokens: number,
  celebrating: boolean
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
        failedOnPoll: pollNumber
      });
    },
    recordSuccess(characterId: CharacterId, path: string): void {
      failures.delete(keyFor(characterId, path));
    }
  });
}


