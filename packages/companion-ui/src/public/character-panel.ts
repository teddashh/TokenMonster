import { resolveCharacterPose } from "./character-state.js";
import type {
  CharacterConnectionState,
  CharacterId,
  CharacterProfileResponse,
  CharacterRosterEntry,
  CharactersSnapshot,
  CharacterTheme,
} from "./dto.js";
import { getUiLocale } from "./localization.js";

export type CompanionView = "dashboard" | "pet";

/** The floating pet surface opts into its compact layout with a query flag. */
export function resolveCompanionView(search: string): CompanionView {
  return new URLSearchParams(search).get("view") === "pet"
    ? "pet"
    : "dashboard";
}

export interface VisibleCharacterRoster {
  readonly unlocked: readonly CharacterRosterEntry[];
  readonly selectable: readonly CharacterRosterEntry[];
  readonly lockedCount: number;
}

export interface CharacterRosterCardIdentity {
  readonly name: string;
  readonly taglineZhTw: string | null;
}

export type CharacterProfileRequestState =
  "idle" | "loading" | "ready" | "stale" | "unavailable";

export const CHARACTER_PROFILE_SUCCESS_REFRESH_MS = 15 * 60_000;
export const CHARACTER_PROFILE_FAILURE_RETRY_MS = 60_000;

export interface CharacterProfileRequestGate {
  readonly state: (observedAt: number) => CharacterProfileRequestState;
  readonly sequence: () => number;
  readonly begin: (attemptedAt: number, force?: boolean) => number | undefined;
  readonly succeed: (sequence: number, completedAt: number) => boolean;
  readonly fail: (sequence: number, completedAt: number) => boolean;
}

/**
 * Keeps profile refreshes single-authority: only the newest request may settle,
 * successful reads age for 15 minutes, and failures become retryable in one
 * settled collector poll rather than inheriting the long success interval.
 */
export function createCharacterProfileRequestGate(): CharacterProfileRequestGate {
  let state: CharacterProfileRequestState = "idle";
  let sequence = 0;
  let nextAttemptAt = 0;

  return Object.freeze({
    state: (observedAt: number) =>
      state === "ready" && observedAt >= nextAttemptAt ? "stale" : state,
    sequence: () => sequence,
    begin: (attemptedAt: number, force = false) => {
      if (!force && attemptedAt < nextAttemptAt) return undefined;
      sequence += 1;
      state = "loading";
      nextAttemptAt = Number.POSITIVE_INFINITY;
      return sequence;
    },
    succeed: (candidateSequence: number, completedAt: number) => {
      if (candidateSequence !== sequence) return false;
      state = "ready";
      nextAttemptAt = completedAt + CHARACTER_PROFILE_SUCCESS_REFRESH_MS;
      return true;
    },
    fail: (candidateSequence: number, completedAt: number) => {
      if (candidateSequence !== sequence) return false;
      state = "unavailable";
      nextAttemptAt = completedAt + CHARACTER_PROFILE_FAILURE_RETRY_MS;
      return true;
    },
  });
}

export type CharacterMutationKind = "selection" | "wardrobe";

export interface CharacterMutationToken {
  readonly kind: CharacterMutationKind;
  readonly sequence: number;
}

export interface CharacterMutationGate {
  readonly revision: () => number;
  readonly pending: () => boolean;
  readonly begin: (kind: CharacterMutationKind) => CharacterMutationToken;
  readonly beginWhenIdle: (
    kind: CharacterMutationKind,
  ) => CharacterMutationToken | undefined;
  readonly isCurrent: (token: CharacterMutationToken) => boolean;
  readonly finish: (
    token: CharacterMutationToken,
  ) => Readonly<{ current: boolean; idle: boolean }>;
  readonly canAcceptRead: (capturedRevision: number) => boolean;
}

/**
 * Coordinates the character GET snapshot with local POST mutations. Every
 * begin/finish changes the revision, so a GET captured on either side of a
 * mutation can never overwrite the player's newer choice. Each mutation kind
 * is latest-wins while all unfinished requests keep sharing disabled.
 */
export function createCharacterMutationGate(): CharacterMutationGate {
  let revision = 0;
  let nextSequence = 0;
  const pendingSequences = new Set<number>();
  const latestByKind = new Map<CharacterMutationKind, number>();
  const begin = (kind: CharacterMutationKind): CharacterMutationToken => {
    revision += 1;
    nextSequence += 1;
    pendingSequences.add(nextSequence);
    latestByKind.set(kind, nextSequence);
    return Object.freeze({ kind, sequence: nextSequence });
  };

  return Object.freeze({
    revision: () => revision,
    pending: () => pendingSequences.size > 0,
    begin,
    beginWhenIdle: (kind: CharacterMutationKind) =>
      pendingSequences.size === 0 ? begin(kind) : undefined,
    isCurrent: (token: CharacterMutationToken) =>
      latestByKind.get(token.kind) === token.sequence,
    finish: (token: CharacterMutationToken) => {
      const current = latestByKind.get(token.kind) === token.sequence;
      if (pendingSequences.delete(token.sequence)) revision += 1;
      return Object.freeze({ current, idle: pendingSequences.size === 0 });
    },
    canAcceptRead: (capturedRevision: number) =>
      capturedRevision === revision && pendingSequences.size === 0,
  });
}

/**
 * A superseded request can be the last network operation to settle. Re-render
 * when that happens so controls leave their pending state even if the follow-up
 * roster read is unavailable.
 */
export function shouldRenderAfterCharacterMutation(
  settled: Readonly<{ current: boolean; idle: boolean }>,
): boolean {
  return settled.current || settled.idle;
}

/** Letter stages do not pass through the async doll transition effect hook. */
export function shouldPlayImmediateUnlockSparkles(
  character: CharacterRosterEntry | undefined,
): boolean {
  return character?.visual.mode === "letter";
}

export function millisecondsUntilNextUtcDate(nowMs: number): number {
  const now = new Date(nowMs);
  const nextUtcDate = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(1, nextUtcDate - nowMs);
}

/** A null selection is an explicit user-choice state, never a starter fallback. */
export function selectedRosterCharacter(
  snapshot: CharactersSnapshot,
): CharacterRosterEntry | undefined {
  const selectedId = snapshot.selection.characterId;
  if (selectedId === null) return undefined;
  return snapshot.characters.find(
    (character) => character.characterId === selectedId && character.unlocked,
  );
}

/** Unlock celebrations may replace only the portrait stage, not selection. */
export function presentedRosterCharacter(
  snapshot: CharactersSnapshot,
  celebrationCharacterId?: CharacterId,
): CharacterRosterEntry | undefined {
  const selected = selectedRosterCharacter(snapshot);
  if (selected === undefined) return undefined;
  if (celebrationCharacterId === undefined) return selected;
  return (
    snapshot.characters.find(
      (character) =>
        character.characterId === celebrationCharacterId && character.unlocked,
    ) ?? selected
  );
}

/** Only changing the selected character invalidates an in-flight tap response. */
export function isCurrentCharacterInteraction(
  requestEpoch: number,
  currentEpoch: number,
  requestedCharacterId: CharacterId,
  selectedCharacterId: CharacterId | undefined,
  responseCharacterId: CharacterId,
): boolean {
  return (
    requestEpoch === currentEpoch &&
    selectedCharacterId === requestedCharacterId &&
    responseCharacterId === requestedCharacterId
  );
}

/** A share card must use the newest, current-day profile response. */
export function canShareCharacterProfile(
  profile: CharacterProfileResponse | undefined,
  requestState: CharacterProfileRequestState,
  currentUtcDate: string,
): boolean {
  return (
    requestState === "ready" &&
    profile?.freshness === "fresh" &&
    profile.window.toUtcDate === currentUtcDate
  );
}

export function needsColdStartLetterFallback(
  input: Readonly<{
    dollHidden: boolean;
    incomingDollHidden: boolean;
    renderedLetterCharacterId: string | undefined;
    targetCharacterId: string;
  }>,
): boolean {
  return (
    input.dollHidden &&
    input.incomingDollHidden &&
    input.renderedLetterCharacterId !== input.targetCharacterId
  );
}

/**
 * Locked identities stay hidden except for the four starter choices on a null-
 * selection clean install. Those choices remain locked for collection counts
 * until the user selects one and the local gateway confirms it.
 */
export function visibleCharacterRoster(
  input: CharactersSnapshot | readonly CharacterRosterEntry[],
): VisibleCharacterRoster {
  const snapshot = Array.isArray(input)
    ? undefined
    : (input as CharactersSnapshot);
  const characters: readonly CharacterRosterEntry[] =
    snapshot?.characters ?? (input as readonly CharacterRosterEntry[]);
  const unlocked = characters.filter((character) => character.unlocked);
  const initialChoice = snapshot?.selection.characterId === null;
  const selectable = initialChoice
    ? characters.filter(
        (character) => character.unlocked || character.isStarter,
      )
    : unlocked;
  return Object.freeze({
    unlocked: Object.freeze(unlocked),
    selectable: Object.freeze(selectable),
    lockedCount: characters.length - unlocked.length,
  });
}

/** First-choice cards use the catalog persona, never a provider display name. */
export function characterRosterCardIdentity(
  character: CharacterRosterEntry,
  initialStarterChoice: boolean,
): CharacterRosterCardIdentity {
  const persona = initialStarterChoice ? character.starterPersona : null;
  if (getUiLocale() === "en") {
    return Object.freeze({ name: character.displayName, taglineZhTw: null });
  }
  return Object.freeze(
    persona === null
      ? { name: character.displayName, taglineZhTw: null }
      : { name: persona.alias, taglineZhTw: persona.taglineZhTw },
  );
}

export function activeCharacterTheme(
  character: CharacterRosterEntry,
): CharacterTheme | undefined {
  if (character.visual.mode !== "doll") return undefined;
  return (
    character.visual.themes.find(
      (theme) => theme.themeId === character.activeThemeId && theme.unlocked,
    ) ?? character.visual.themes.find((theme) => theme.unlocked)
  );
}

export function resolveStageImagePath(
  character: CharacterRosterEntry,
  connection: CharacterConnectionState,
  todayTokens: number,
  celebrating: boolean,
): string | undefined {
  return resolveStageImageCandidates(
    character,
    connection,
    todayTokens,
    celebrating,
  )[0];
}

/** Prefer a state pose, then the same theme's outfit, before letter fallback. */
export function resolveStageImageCandidates(
  character: CharacterRosterEntry,
  connection: CharacterConnectionState,
  todayTokens: number,
  celebrating: boolean,
): readonly string[] {
  const theme = activeCharacterTheme(character);
  if (theme === undefined) return Object.freeze([]);
  const pose = resolveCharacterPose(connection, todayTokens, celebrating);
  const posePath = pose === null ? null : theme.posePaths[pose];
  return Object.freeze(
    posePath === null || posePath === theme.outfitPath
      ? [theme.outfitPath]
      : [posePath, theme.outfitPath],
  );
}

export type ResolvedCharacterStage =
  Readonly<{ mode: "letter" }> | Readonly<{ mode: "doll"; imagePath: string }>;

/** Resolve the next cache candidate, with an explicit letter terminal state. */
export function resolveCharacterStage(
  character: CharacterRosterEntry,
  connection: CharacterConnectionState,
  todayTokens: number,
  celebrating: boolean,
  canAttempt: (imagePath: string) => boolean = () => true,
): ResolvedCharacterStage {
  const imagePath = resolveStageImageCandidates(
    character,
    connection,
    todayTokens,
    celebrating,
  ).find(canAttempt);
  return imagePath === undefined
    ? Object.freeze({ mode: "letter" })
    : Object.freeze({ mode: "doll", imagePath });
}
