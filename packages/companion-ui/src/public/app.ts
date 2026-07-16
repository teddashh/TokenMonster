export const COMPANION_API_ENDPOINT = "/api/companion" as const;
export const COLLECTOR_STATUS_ENDPOINT = "/api/companion/status" as const;
export const COLLECTOR_REFRESH_ENDPOINT = "/api/companion/refresh" as const;

export const COMPANION_ERROR_CODES = [
  "sidecar-unavailable",
  "sidecar-incompatible"
] as const;

export type CompanionErrorCode = (typeof COMPANION_ERROR_CODES)[number];

export const COMPANION_CHARACTER_IDS = [
  "chatgpt",
  "claude",
  "gemini",
  "grok"
] as const;

export type CompanionCharacterId = (typeof COMPANION_CHARACTER_IDS)[number];

export const COMPANION_PROVIDER_FAMILIES = [
  "openai",
  "anthropic",
  "google",
  "xai"
] as const;

export type CompanionProviderFamily =
  (typeof COMPANION_PROVIDER_FAMILIES)[number];

export type CompanionStarterSelection =
  | Readonly<{
      outcome: "selected";
      selectedBy: "manual";
      characterId: CompanionCharacterId;
    }>
  | Readonly<{
      outcome: "selected";
      selectedBy: "unique-provider-total";
      characterId: CompanionCharacterId;
      providerFamily: CompanionProviderFamily;
    }>
  | Readonly<{
      outcome: "user-choice-required";
      reason: "no-positive-provider-data" | "highest-provider-total-tie";
      tiedProviderFamilies: readonly CompanionProviderFamily[];
    }>;

export interface CompanionDailyPoint {
  readonly utcDate: string;
  readonly totalTokens: number;
}

export interface CompanionHealthySnapshot {
  readonly status: "healthy";
  readonly generatedAt: string;
  readonly starter: CompanionStarterSelection;
  readonly totals: Readonly<{
    today: number;
    last7Days: number;
    last28Days: number;
  }>;
  readonly daily: readonly CompanionDailyPoint[];
}

export interface CompanionErrorSnapshot {
  readonly status: "error";
  readonly error: CompanionErrorCode;
}

export type CompanionSnapshot =
  | CompanionHealthySnapshot
  | CompanionErrorSnapshot;

export const COMPANION_COLLECTOR_PHASES = [
  "starting",
  "syncing",
  "ready",
  "ready-no-data",
  "refresh-failed",
  "stale"
] as const;

export type CompanionCollectorPhase =
  (typeof COMPANION_COLLECTOR_PHASES)[number];

export interface CompanionCollectorStatus {
  readonly phase: CompanionCollectorPhase;
  readonly lastSuccessAt: string | null;
  readonly consecutiveFailures: number;
  readonly canRetry: boolean;
}

export const CHARACTERS_API_ENDPOINT = "/api/characters" as const;
export const CHARACTER_SELECT_ENDPOINT = "/api/characters/select" as const;
export const CHARACTER_WARDROBE_ENDPOINT =
  "/api/characters/wardrobe" as const;

export const CHARACTER_IDS = [
  "chatgpt",
  "claude",
  "gemini",
  "grok",
  "deepseek",
  "qwen",
  "mistral",
  "venice",
  "sakana",
  "perplexity",
  "glm"
] as const;

export type CharacterId = (typeof CHARACTER_IDS)[number];

export const CHARACTER_THEME_IDS = [
  "tech",
  "finance",
  "politics",
  "education",
  "health",
  "environment",
  "law",
  "relationship",
  "family",
  "workplace",
  "science",
  "culture",
  "sports",
  "food",
  "travel",
  "psychology",
  "philosophy",
  "international",
  "media",
  "festival"
] as const;

export type CharacterThemeId = (typeof CHARACTER_THEME_IDS)[number];
export type CharacterPose = "supported" | "challenged" | "victory";
export type VoiceTrigger =
  | "greeting"
  | "unlock"
  | "quiet"
  | "active"
  | "error";

export interface CharacterPosePaths {
  readonly supported: string | null;
  readonly challenged: string | null;
  readonly victory: string | null;
}

export interface CharacterTheme {
  readonly themeId: CharacterThemeId;
  readonly unlocked: boolean;
  readonly outfitPath: string;
  readonly posePaths: CharacterPosePaths;
}

export type CharacterVisual =
  | Readonly<{
      mode: "letter";
      glyph: string;
      background: string;
      foreground: string;
      accent: string;
    }>
  | Readonly<{
      mode: "doll";
      avatarPath: string;
      themes: readonly CharacterTheme[];
    }>;

export interface CharacterProgress {
  readonly value: number;
  readonly explain: string;
}

export interface CharacterVoiceLine {
  readonly id: string;
  readonly trigger: VoiceTrigger;
  readonly path: string;
  readonly durationMs: number;
}

export interface CharacterRosterEntry {
  readonly characterId: CharacterId;
  readonly displayName: string;
  readonly kind: "sister" | "friend";
  readonly unlocked: boolean;
  readonly unlockedAt: string | null;
  readonly isStarter: boolean;
  readonly activeThemeId: CharacterThemeId | null;
  readonly visual: CharacterVisual;
  readonly progress: CharacterProgress | null;
  readonly voiceLines: readonly CharacterVoiceLine[];
}

export interface CharactersSnapshot {
  readonly status: "ok";
  readonly generatedAt: string;
  readonly selection: Readonly<{
    characterId: CharacterId | null;
    selectedBy: "manual" | "auto-starter" | null;
  }>;
  readonly voiceEnabled: boolean;
  readonly characters: readonly CharacterRosterEntry[];
}

export interface CharacterSelectionResponse {
  readonly status: "ok";
  readonly selection: Readonly<{
    characterId: CharacterId;
    selectedBy: "manual";
  }>;
}

export interface CharacterWardrobeResponse {
  readonly status: "ok";
  readonly characterId: CharacterId;
  readonly activeThemeId: CharacterThemeId;
}

export interface CharacterUnlock {
  readonly key: string;
  readonly kind: "character" | "theme";
  readonly characterId: CharacterId;
  readonly displayName: string;
  readonly themeId: CharacterThemeId | null;
}

export type CharacterConnectionState =
  | "healthy"
  | "stale"
  | "refresh-failed"
  | "other";

const UTC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const UTC_TIMESTAMP_MS_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length &&
    [...expectedKeys].sort().every((key, index) => keys[index] === key)
  );
}

function isSafeTokenCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function parseUtcDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !UTC_DATE_PATTERN.test(value)) {
    return undefined;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

function parseGeneratedAt(value: unknown): string | undefined {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) {
    return undefined;
  }
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function parseGeneratedAtWithMilliseconds(value: unknown): string | undefined {
  return typeof value === "string" && UTC_TIMESTAMP_MS_PATTERN.test(value)
    ? parseGeneratedAt(value)
    : undefined;
}

const CHARACTER_ASSET_IMAGE_PATTERN =
  /^\/assets\/characters\/objects\/[0-9a-f]{64}\.(?:webp|png)$/u;
const CHARACTER_ASSET_AUDIO_PATTERN =
  /^\/assets\/characters\/objects\/[0-9a-f]{64}\.wav$/u;
const CSS_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/u;
const VOICE_LINE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function isCharacterId(value: unknown): value is CharacterId {
  return CHARACTER_IDS.some((candidate) => candidate === value);
}

function isCharacterThemeId(value: unknown): value is CharacterThemeId {
  return CHARACTER_THEME_IDS.some((candidate) => candidate === value);
}

function isShortText(value: unknown, maximumLength = 240): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function parseNullableImagePath(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && CHARACTER_ASSET_IMAGE_PATTERN.test(value)
    ? value
    : undefined;
}

function parsePosePaths(value: unknown): CharacterPosePaths | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["supported", "challenged", "victory"])
  ) {
    return undefined;
  }
  const supported = parseNullableImagePath(value["supported"]);
  const challenged = parseNullableImagePath(value["challenged"]);
  const victory = parseNullableImagePath(value["victory"]);
  if (
    supported === undefined ||
    challenged === undefined ||
    victory === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ supported, challenged, victory });
}

function parseCharacterTheme(value: unknown): CharacterTheme | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["themeId", "unlocked", "outfitPath", "posePaths"])
  ) {
    return undefined;
  }
  const themeId = value["themeId"];
  const outfitPath = value["outfitPath"];
  const posePaths = parsePosePaths(value["posePaths"]);
  if (
    !isCharacterThemeId(themeId) ||
    typeof value["unlocked"] !== "boolean" ||
    typeof outfitPath !== "string" ||
    !CHARACTER_ASSET_IMAGE_PATTERN.test(outfitPath) ||
    posePaths === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    themeId,
    unlocked: value["unlocked"],
    outfitPath,
    posePaths
  });
}

function parseCharacterVisual(value: unknown): CharacterVisual | undefined {
  if (!isRecord(value) || typeof value["mode"] !== "string") {
    return undefined;
  }
  if (value["mode"] === "letter") {
    if (
      !hasExactKeys(value, [
        "mode",
        "glyph",
        "background",
        "foreground",
        "accent"
      ]) ||
      typeof value["glyph"] !== "string" ||
      [...value["glyph"]].length !== 1 ||
      typeof value["background"] !== "string" ||
      !CSS_COLOR_PATTERN.test(value["background"]) ||
      typeof value["foreground"] !== "string" ||
      !CSS_COLOR_PATTERN.test(value["foreground"]) ||
      typeof value["accent"] !== "string" ||
      !CSS_COLOR_PATTERN.test(value["accent"])
    ) {
      return undefined;
    }
    return Object.freeze({
      mode: "letter",
      glyph: value["glyph"],
      background: value["background"],
      foreground: value["foreground"],
      accent: value["accent"]
    });
  }
  if (
    value["mode"] !== "doll" ||
    !hasExactKeys(value, ["mode", "avatarPath", "themes"]) ||
    typeof value["avatarPath"] !== "string" ||
    !CHARACTER_ASSET_IMAGE_PATTERN.test(value["avatarPath"]) ||
    !Array.isArray(value["themes"]) ||
    value["themes"].length > 20
  ) {
    return undefined;
  }
  const themes: CharacterTheme[] = [];
  const themeIds = new Set<CharacterThemeId>();
  for (const candidate of value["themes"]) {
    const theme = parseCharacterTheme(candidate);
    if (theme === undefined || themeIds.has(theme.themeId)) return undefined;
    themeIds.add(theme.themeId);
    themes.push(theme);
  }
  return Object.freeze({
    mode: "doll",
    avatarPath: value["avatarPath"],
    themes: Object.freeze(themes)
  });
}

function parseCharacterProgress(
  value: unknown
): CharacterProgress | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["value", "explain"]) ||
    typeof value["value"] !== "number" ||
    !Number.isFinite(value["value"]) ||
    value["value"] < 0 ||
    value["value"] > 1 ||
    !isShortText(value["explain"])
  ) {
    return undefined;
  }
  return Object.freeze({
    value: value["value"],
    explain: value["explain"]
  });
}

function isVoiceTrigger(value: unknown): value is VoiceTrigger {
  return (
    value === "greeting" ||
    value === "unlock" ||
    value === "quiet" ||
    value === "active" ||
    value === "error"
  );
}

function parseVoiceLine(value: unknown): CharacterVoiceLine | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "trigger", "path", "durationMs"]) ||
    typeof value["id"] !== "string" ||
    !VOICE_LINE_ID_PATTERN.test(value["id"]) ||
    value["id"].length > 80 ||
    !isVoiceTrigger(value["trigger"]) ||
    typeof value["path"] !== "string" ||
    !CHARACTER_ASSET_AUDIO_PATTERN.test(value["path"]) ||
    !Number.isSafeInteger(value["durationMs"]) ||
    (value["durationMs"] as number) < 1 ||
    (value["durationMs"] as number) > 60_000
  ) {
    return undefined;
  }
  return Object.freeze({
    id: value["id"],
    trigger: value["trigger"],
    path: value["path"],
    durationMs: value["durationMs"] as number
  });
}

function parseRosterEntry(value: unknown): CharacterRosterEntry | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "characterId",
      "displayName",
      "kind",
      "unlocked",
      "unlockedAt",
      "isStarter",
      "activeThemeId",
      "visual",
      "progress",
      "voiceLines"
    ])
  ) {
    return undefined;
  }
  const characterId = value["characterId"];
  const unlockedAt = value["unlockedAt"];
  const activeThemeId = value["activeThemeId"];
  const visual = parseCharacterVisual(value["visual"]);
  const progress = parseCharacterProgress(value["progress"]);
  if (
    !isCharacterId(characterId) ||
    !isShortText(value["displayName"], 80) ||
    (value["kind"] !== "sister" && value["kind"] !== "friend") ||
    typeof value["unlocked"] !== "boolean" ||
    (unlockedAt !== null && parseGeneratedAt(unlockedAt) === undefined) ||
    typeof value["isStarter"] !== "boolean" ||
    (activeThemeId !== null && !isCharacterThemeId(activeThemeId)) ||
    visual === undefined ||
    progress === undefined ||
    (!value["unlocked"] && progress === null) ||
    !Array.isArray(value["voiceLines"]) ||
    value["voiceLines"].length > 16
  ) {
    return undefined;
  }
  if (
    visual.mode === "letter" &&
    activeThemeId !== null
  ) {
    return undefined;
  }
  if (
    visual.mode === "doll" &&
    activeThemeId !== null &&
    !visual.themes.some(
      (theme) => theme.themeId === activeThemeId && theme.unlocked
    )
  ) {
    return undefined;
  }
  const voiceLines: CharacterVoiceLine[] = [];
  const voiceLineIds = new Set<string>();
  for (const candidate of value["voiceLines"]) {
    const voiceLine = parseVoiceLine(candidate);
    if (voiceLine === undefined || voiceLineIds.has(voiceLine.id)) {
      return undefined;
    }
    voiceLineIds.add(voiceLine.id);
    voiceLines.push(voiceLine);
  }
  return Object.freeze({
    characterId,
    displayName: value["displayName"],
    kind: value["kind"],
    unlocked: value["unlocked"],
    unlockedAt: unlockedAt as string | null,
    isStarter: value["isStarter"],
    activeThemeId: activeThemeId as CharacterThemeId | null,
    visual,
    progress,
    voiceLines: Object.freeze(voiceLines)
  });
}

/** Strictly validates the complete character roster DTO. */
export function parseCharactersSnapshot(value: unknown): CharactersSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "status",
      "generatedAt",
      "selection",
      "voiceEnabled",
      "characters"
    ]) ||
    value["status"] !== "ok" ||
    parseGeneratedAtWithMilliseconds(value["generatedAt"]) === undefined ||
    !isRecord(value["selection"]) ||
    !hasExactKeys(value["selection"], ["characterId", "selectedBy"]) ||
    typeof value["voiceEnabled"] !== "boolean" ||
    !Array.isArray(value["characters"]) ||
    value["characters"].length > 16
  ) {
    throw new TypeError("Invalid characters response");
  }
  const selectedCharacterId = value["selection"]["characterId"];
  const selectedBy = value["selection"]["selectedBy"];
  if (
    (selectedCharacterId !== null && !isCharacterId(selectedCharacterId)) ||
    (selectedBy !== null &&
      selectedBy !== "manual" &&
      selectedBy !== "auto-starter") ||
    ((selectedCharacterId === null) !== (selectedBy === null))
  ) {
    throw new TypeError("Invalid characters response");
  }
  const characters: CharacterRosterEntry[] = [];
  const characterIds = new Set<CharacterId>();
  for (const candidate of value["characters"]) {
    const character = parseRosterEntry(candidate);
    if (
      character === undefined ||
      characterIds.has(character.characterId)
    ) {
      throw new TypeError("Invalid characters response");
    }
    characterIds.add(character.characterId);
    characters.push(character);
  }
  if (
    selectedCharacterId !== null &&
    !characters.some(
      (character) =>
        character.characterId === selectedCharacterId && character.unlocked
    )
  ) {
    throw new TypeError("Invalid characters response");
  }
  return Object.freeze({
    status: "ok",
    generatedAt: value["generatedAt"] as string,
    selection: Object.freeze({
      characterId: selectedCharacterId as CharacterId | null,
      selectedBy: selectedBy as "manual" | "auto-starter" | null
    }),
    voiceEnabled: value["voiceEnabled"],
    characters: Object.freeze(characters)
  });
}

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

export interface VoicePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface VoicePlaybackGate {
  arm(): void;
  isArmed(): boolean;
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  allow(trigger: VoiceTrigger, characterId: CharacterId, now: number): boolean;
}

export function createVoicePlaybackGate(
  storage: VoicePreferenceStorage
): VoicePlaybackGate {
  let armed = false;
  let enabled = false;
  try {
    enabled = storage.getItem("tokenmonster-voice") === "on";
  } catch {
    enabled = false;
  }
  const greetedCharacters = new Set<CharacterId>();
  const hourlyTriggers = new Map<string, number>();
  return Object.freeze({
    arm(): void {
      armed = true;
    },
    isArmed(): boolean {
      return armed;
    },
    isEnabled(): boolean {
      return enabled;
    },
    setEnabled(nextEnabled: boolean): void {
      enabled = nextEnabled;
      try {
        storage.setItem(
          "tokenmonster-voice",
          nextEnabled ? "on" : "off"
        );
      } catch {
        // A blocked storage area only makes this preference session-local.
      }
    },
    allow(
      trigger: VoiceTrigger,
      characterId: CharacterId,
      now: number
    ): boolean {
      if (!armed || !enabled) return false;
      if (trigger === "greeting") {
        if (greetedCharacters.has(characterId)) return false;
        greetedCharacters.add(characterId);
        return true;
      }
      if (trigger === "quiet" || trigger === "active") {
        const key = trigger;
        const lastPlayedAt = hourlyTriggers.get(key);
        if (lastPlayedAt !== undefined && now - lastPlayedAt < 3_600_000) {
          return false;
        }
        hourlyTriggers.set(key, now);
      }
      return true;
    }
  });
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

export type CharacterFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

async function readCharacterJson(response: Response): Promise<unknown> {
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

function utcDateOffset(utcDate: string, days: number): string {
  const timestamp = Date.parse(`${utcDate}T00:00:00.000Z`);
  return new Date(timestamp + days * 86_400_000).toISOString().slice(0, 10);
}

function checkedAdd(left: number, right: number): number | undefined {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : undefined;
}

function isCompanionErrorCode(value: unknown): value is CompanionErrorCode {
  return (
    value === "sidecar-unavailable" || value === "sidecar-incompatible"
  );
}

function isCompanionCharacterId(
  value: unknown
): value is CompanionCharacterId {
  return COMPANION_CHARACTER_IDS.some((candidate) => candidate === value);
}

function isCompanionProviderFamily(
  value: unknown
): value is CompanionProviderFamily {
  return COMPANION_PROVIDER_FAMILIES.some((candidate) => candidate === value);
}

const CHARACTER_BY_PROVIDER = Object.freeze({
  openai: "chatgpt",
  anthropic: "claude",
  google: "gemini",
  xai: "grok"
} as const satisfies Readonly<
  Record<CompanionProviderFamily, CompanionCharacterId>
>);

function parseStarterSelection(
  value: unknown
): CompanionStarterSelection | undefined {
  if (!isRecord(value) || typeof value["outcome"] !== "string") {
    return undefined;
  }
  if (value["outcome"] === "selected") {
    const selectedBy = value["selectedBy"];
    const characterId = value["characterId"];
    if (!isCompanionCharacterId(characterId)) return undefined;
    if (
      selectedBy === "manual" &&
      hasExactKeys(value, ["outcome", "selectedBy", "characterId"])
    ) {
      return Object.freeze({ outcome: "selected", selectedBy, characterId });
    }
    const providerFamily = value["providerFamily"];
    if (
      selectedBy === "unique-provider-total" &&
      hasExactKeys(value, [
        "outcome",
        "selectedBy",
        "characterId",
        "providerFamily"
      ]) &&
      isCompanionProviderFamily(providerFamily) &&
      CHARACTER_BY_PROVIDER[providerFamily] === characterId
    ) {
      return Object.freeze({
        outcome: "selected",
        selectedBy,
        characterId,
        providerFamily
      });
    }
    return undefined;
  }
  if (
    value["outcome"] !== "user-choice-required" ||
    !hasExactKeys(value, ["outcome", "reason", "tiedProviderFamilies"]) ||
    !Array.isArray(value["tiedProviderFamilies"])
  ) {
    return undefined;
  }
  const reason = value["reason"];
  const tiedProviderFamilies = value["tiedProviderFamilies"];
  if (
    !tiedProviderFamilies.every(isCompanionProviderFamily) ||
    new Set(tiedProviderFamilies).size !== tiedProviderFamilies.length ||
    !tiedProviderFamilies.every(
      (providerFamily, index) =>
        COMPANION_PROVIDER_FAMILIES.indexOf(providerFamily) >
        (index === 0
          ? -1
          : COMPANION_PROVIDER_FAMILIES.indexOf(
              tiedProviderFamilies[index - 1]!
            ))
    ) ||
    (reason === "no-positive-provider-data" &&
      tiedProviderFamilies.length !== 0) ||
    (reason === "highest-provider-total-tie" &&
      tiedProviderFamilies.length < 2)
  ) {
    return undefined;
  }
  if (
    reason !== "no-positive-provider-data" &&
    reason !== "highest-provider-total-tie"
  ) {
    return undefined;
  }
  return Object.freeze({
    outcome: "user-choice-required",
    reason,
    tiedProviderFamilies: Object.freeze([...tiedProviderFamilies])
  });
}

function parseErrorSnapshot(
  value: Record<string, unknown>
): CompanionErrorSnapshot | undefined {
  if (!hasExactKeys(value, ["status", "error"])) return undefined;
  const error = value["error"];
  if (!isCompanionErrorCode(error)) return undefined;
  return Object.freeze({ status: "error", error });
}

function parseHealthySnapshot(
  value: Record<string, unknown>
): CompanionHealthySnapshot | undefined {
  if (
    !hasExactKeys(value, [
      "status",
      "generatedAt",
      "starter",
      "totals",
      "daily"
    ])
  ) {
    return undefined;
  }

  const generatedAt = parseGeneratedAt(value["generatedAt"]);
  const starter = parseStarterSelection(value["starter"]);
  const totals = value["totals"];
  const daily = value["daily"];
  if (
    generatedAt === undefined ||
    starter === undefined ||
    !isRecord(totals) ||
    !hasExactKeys(totals, ["today", "last7Days", "last28Days"]) ||
    !isSafeTokenCount(totals["today"]) ||
    !isSafeTokenCount(totals["last7Days"]) ||
    !isSafeTokenCount(totals["last28Days"]) ||
    !Array.isArray(daily) ||
    daily.length > 28
  ) {
    return undefined;
  }

  const todayUtcDate = generatedAt.slice(0, 10);
  const firstUtcDate = utcDateOffset(todayUtcDate, -27);
  const firstSevenDayUtcDate = utcDateOffset(todayUtcDate, -6);
  const points: CompanionDailyPoint[] = [];
  let previousUtcDate = "";
  let todayTotal = 0;
  let sevenDayTotal = 0;
  let twentyEightDayTotal = 0;

  for (const candidate of daily) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["utcDate", "totalTokens"])
    ) {
      return undefined;
    }
    const utcDate = parseUtcDate(candidate["utcDate"]);
    const totalTokens = candidate["totalTokens"];
    if (
      utcDate === undefined ||
      !isSafeTokenCount(totalTokens) ||
      utcDate < firstUtcDate ||
      utcDate > todayUtcDate ||
      (previousUtcDate !== "" && utcDate <= previousUtcDate)
    ) {
      return undefined;
    }

    const nextTwentyEightDayTotal = checkedAdd(
      twentyEightDayTotal,
      totalTokens
    );
    if (nextTwentyEightDayTotal === undefined) return undefined;
    twentyEightDayTotal = nextTwentyEightDayTotal;

    if (utcDate >= firstSevenDayUtcDate) {
      const nextSevenDayTotal = checkedAdd(sevenDayTotal, totalTokens);
      if (nextSevenDayTotal === undefined) return undefined;
      sevenDayTotal = nextSevenDayTotal;
    }
    if (utcDate === todayUtcDate) todayTotal = totalTokens;

    previousUtcDate = utcDate;
    points.push(Object.freeze({ utcDate, totalTokens }));
  }

  if (
    totals["today"] !== todayTotal ||
    totals["last7Days"] !== sevenDayTotal ||
    totals["last28Days"] !== twentyEightDayTotal
  ) {
    return undefined;
  }

  return Object.freeze({
    status: "healthy",
    generatedAt,
    starter,
    totals: Object.freeze({
      today: totals["today"],
      last7Days: totals["last7Days"],
      last28Days: totals["last28Days"]
    }),
    daily: Object.freeze(points)
  });
}

/** Strictly validates the only aggregate DTO accepted by the browser UI. */
export function parseCompanionSnapshot(value: unknown): CompanionSnapshot {
  if (!isRecord(value) || typeof value["status"] !== "string") {
    throw new TypeError("Invalid companion response");
  }
  const parsed =
    value["status"] === "healthy"
      ? parseHealthySnapshot(value)
      : value["status"] === "error"
        ? parseErrorSnapshot(value)
        : undefined;
  if (parsed === undefined) throw new TypeError("Invalid companion response");
  return parsed;
}

function isCompanionCollectorPhase(
  value: unknown
): value is CompanionCollectorPhase {
  return COMPANION_COLLECTOR_PHASES.some((phase) => phase === value);
}

/** Strictly validates the content-blind collector DTO accepted by the UI. */
export function parseCompanionCollectorStatus(
  value: unknown
): CompanionCollectorStatus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "phase",
      "lastSuccessAt",
      "consecutiveFailures",
      "canRetry"
    ])
  ) {
    throw new TypeError("Invalid collector response");
  }
  const phase = value["phase"];
  const lastSuccessAt = value["lastSuccessAt"];
  const consecutiveFailures = value["consecutiveFailures"];
  const canRetry = value["canRetry"];
  if (
    !isCompanionCollectorPhase(phase) ||
    (lastSuccessAt !== null &&
      parseGeneratedAt(lastSuccessAt) === undefined) ||
    !isSafeTokenCount(consecutiveFailures) ||
    typeof canRetry !== "boolean" ||
    ((phase === "ready" || phase === "ready-no-data") &&
      (lastSuccessAt === null || consecutiveFailures !== 0)) ||
    (phase === "refresh-failed" &&
      (lastSuccessAt !== null || consecutiveFailures < 1)) ||
    (phase === "stale" &&
      (lastSuccessAt === null || consecutiveFailures < 1))
  ) {
    throw new TypeError("Invalid collector response");
  }
  return Object.freeze({
    phase,
    lastSuccessAt: lastSuccessAt as string | null,
    consecutiveFailures,
    canRetry
  });
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MAX_RESPONSE_CHARACTERS = 65_536;
const REQUEST_TIMEOUT_MS = 8_000;
const REFRESH_REQUEST_TIMEOUT_MS = 100_000;
const ACTIVE_POLL_MS = 5_000;
const SETTLED_POLL_MS = 60_000;
const UNAVAILABLE_RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;

export interface UnavailableRetryBackoff {
  nextDelayMs(): number;
  reset(): void;
}

export function createUnavailableRetryBackoff(): UnavailableRetryBackoff {
  let failureIndex = 0;
  return Object.freeze({
    nextDelayMs(): number {
      const delay =
        UNAVAILABLE_RETRY_DELAYS_MS[
          Math.min(failureIndex, UNAVAILABLE_RETRY_DELAYS_MS.length - 1)
        ] ?? 60_000;
      failureIndex += 1;
      return delay;
    },
    reset(): void {
      failureIndex = 0;
    }
  });
}

export function shouldAutomaticallyRetry(error: CompanionErrorCode): boolean {
  return error === "sidecar-unavailable";
}

const numberFormatter = new Intl.NumberFormat("zh-TW", {
  maximumFractionDigits: 0,
  useGrouping: true
});
const timeFormatter = new Intl.DateTimeFormat("zh-TW", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

const CHARACTER_VIEW = Object.freeze({
  chatgpt: Object.freeze({ glyph: "T", name: "ChatGPT" }),
  claude: Object.freeze({ glyph: "C", name: "Claude" }),
  gemini: Object.freeze({ glyph: "G", name: "Gemini" }),
  grok: Object.freeze({ glyph: "X", name: "Grok" }),
  deepseek: Object.freeze({ glyph: "D", name: "DeepSeek" }),
  qwen: Object.freeze({ glyph: "Q", name: "Qwen" }),
  mistral: Object.freeze({ glyph: "M", name: "Mistral" }),
  venice: Object.freeze({ glyph: "L", name: "Llama" }),
  sakana: Object.freeze({ glyph: "S", name: "Sakana" }),
  perplexity: Object.freeze({ glyph: "P", name: "Perplexity" }),
  glm: Object.freeze({ glyph: "Z", name: "GLM" })
} as const satisfies Readonly<
  Record<CharacterId, Readonly<{ glyph: string; name: string }>>
>);

const THEME_LABELS = Object.freeze({
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

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error("Required UI element is unavailable");
  return element;
}

export function startCompanionUi(): void {
  const statusElement = requiredElement<HTMLElement>("[data-status]");
  const companionLineElement = requiredElement<HTMLElement>(
    "[data-companion-line]"
  );
  const companionVisualElement = requiredElement<HTMLElement>(
    "[data-companion-visual]"
  );
  const companionGlyphElement = requiredElement<HTMLElement>(
    "[data-companion-glyph]"
  );
  const letterLayerElement = requiredElement<HTMLElement>(
    "[data-letter-layer]"
  );
  const dollImageElement = requiredElement<HTMLImageElement>(
    "[data-character-doll]"
  );
  const companionTitleElement = requiredElement<HTMLElement>(
    "[data-companion-title]"
  );
  const characterReasonElement = requiredElement<HTMLElement>(
    "[data-character-reason]"
  );
  const rosterElement = requiredElement<HTMLElement>("[data-roster]");
  const wardrobeToggle = requiredElement<HTMLButtonElement>(
    "[data-wardrobe-toggle]"
  );
  const wardrobeDrawer = requiredElement<HTMLElement>(
    "[data-wardrobe-drawer]"
  );
  const wardrobeList = requiredElement<HTMLElement>("[data-wardrobe-list]");
  const voiceControls = requiredElement<HTMLElement>("[data-voice-controls]");
  const voiceToggle = requiredElement<HTMLButtonElement>("[data-voice-toggle]");
  const voiceHint = requiredElement<HTMLButtonElement>("[data-voice-hint]");
  const voiceAudio = requiredElement<HTMLAudioElement>("[data-voice-audio]");
  const toastElement = requiredElement<HTMLElement>("[data-unlock-toast]");
  const updatedElement = requiredElement<HTMLElement>("[data-updated]");
  const staleBadgeElement = requiredElement<HTMLElement>(
    "[data-stale-badge]"
  );
  const rescanButton = requiredElement<HTMLButtonElement>("[data-rescan]");
  const trendElement = requiredElement<HTMLElement>("[data-trend]");
  const trendEmptyElement = requiredElement<HTMLElement>("[data-trend-empty]");
  const trendAccessibleElement = requiredElement<HTMLOListElement>(
    "[data-trend-accessible]"
  );
  const metricElements = {
    today: requiredElement<HTMLElement>("[data-metric='today']"),
    last7Days: requiredElement<HTMLElement>("[data-metric='last7Days']"),
    last28Days: requiredElement<HTMLElement>("[data-metric='last28Days']")
  };
  const unavailableRetryBackoff = createUnavailableRetryBackoff();
  let lastGoodSnapshot: CompanionHealthySnapshot | undefined;
  let charactersSnapshot: CharactersSnapshot | undefined;
  let latestTodayTokens = 0;
  let characterConnectionState: CharacterConnectionState = "other";
  let previousCharacterConnectionState: CharacterConnectionState = "other";
  let wardrobeOpen = false;
  let celebrationTimer: number | undefined;
  let characterRequestSequence = 0;
  const imageFallback = createCharacterImageFallbackTracker();
  const unlockQueue = createCharacterUnlockQueue();
  const voiceGate = createVoicePlaybackGate({
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value)
  });

  function selectedCharacter(): CharacterRosterEntry | undefined {
    const snapshot = charactersSnapshot;
    if (snapshot === undefined) return undefined;
    const celebration = unlockQueue.current();
    if (celebration !== undefined) {
      const celebratingCharacter = snapshot.characters.find(
        (character) =>
          character.characterId === celebration.characterId &&
          character.unlocked
      );
      if (celebratingCharacter !== undefined) return celebratingCharacter;
    }
    const selectedId = snapshot.selection.characterId;
    return (
      snapshot.characters.find(
        (character) => character.characterId === selectedId && character.unlocked
      ) ??
      snapshot.characters.find(
        (character) => character.isStarter && character.unlocked
      ) ??
      snapshot.characters.find((character) => character.unlocked)
    );
  }

  function setLetterStage(character?: CharacterRosterEntry): void {
    const view =
      character === undefined
        ? CHARACTER_VIEW.chatgpt
        : CHARACTER_VIEW[character.characterId];
    companionGlyphElement.textContent =
      character?.visual.mode === "letter" ? character.visual.glyph : view.glyph;
    const style = companionVisualElement.style;
    if (character?.visual.mode === "letter") {
      style.setProperty("--letter-background", character.visual.background);
      style.setProperty("--letter-foreground", character.visual.foreground);
      style.setProperty("--letter-accent", character.visual.accent);
    } else {
      style.removeProperty("--letter-background");
      style.removeProperty("--letter-foreground");
      style.removeProperty("--letter-accent");
    }
    dollImageElement.onload = null;
    dollImageElement.onerror = null;
    dollImageElement.removeAttribute("src");
    dollImageElement.hidden = true;
    letterLayerElement.hidden = false;
  }

  function activeTheme(
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

  function stageImagePath(character: CharacterRosterEntry): string | undefined {
    const theme = activeTheme(character);
    if (theme === undefined) return undefined;
    const pose = resolveCharacterPose(
      characterConnectionState,
      latestTodayTokens,
      unlockQueue.current()?.characterId === character.characterId
    );
    return pose === null ? theme.outfitPath : (theme.posePaths[pose] ?? theme.outfitPath);
  }

  function playVoice(
    character: CharacterRosterEntry,
    trigger: VoiceTrigger
  ): CharacterVoiceLine | undefined {
    if (charactersSnapshot?.voiceEnabled !== true) return undefined;
    const line = character.voiceLines.find(
      (candidate) => candidate.trigger === trigger
    );
    if (
      line === undefined ||
      !voiceGate.allow(trigger, character.characterId, Date.now())
    ) {
      return undefined;
    }
    voiceAudio.pause();
    voiceAudio.currentTime = 0;
    voiceAudio.src = line.path;
    void voiceAudio.play().catch(() => undefined);
    return line;
  }

  function renderCharacterStage(): void {
    const character = selectedCharacter();
    if (character === undefined) {
      setLetterStage();
      return;
    }
    const view = CHARACTER_VIEW[character.characterId];
    document.documentElement.dataset["character"] = character.characterId;
    companionTitleElement.textContent = `嗨，我是 ${character.displayName}。`;
    companionVisualElement.setAttribute(
      "aria-label",
      `TokenMonster ${character.displayName} 夥伴`
    );
    setLetterStage(character);
    const imagePath = stageImagePath(character);
    if (
      character.visual.mode !== "doll" ||
      imagePath === undefined ||
      !imageFallback.canAttempt(character.characterId, imagePath)
    ) {
      return;
    }
    dollImageElement.onload = () => {
      if (
        selectedCharacter()?.characterId !== character.characterId ||
        dollImageElement.getAttribute("src") !== imagePath
      ) {
        return;
      }
      imageFallback.recordSuccess(character.characterId, imagePath);
      letterLayerElement.hidden = true;
      dollImageElement.hidden = false;
    };
    dollImageElement.onerror = () => {
      if (dollImageElement.getAttribute("src") !== imagePath) return;
      imageFallback.recordFailure(character.characterId, imagePath);
      setLetterStage(character);
    };
    dollImageElement.src = imagePath;
    dollImageElement.alt = "";
  }

  function characterExplain(character: CharacterRosterEntry): string {
    return (
      character.progress?.explain ??
      "她會照自己的步調準備好，不需要為了解鎖多用 token。"
    );
  }

  async function chooseCharacter(characterId: CharacterId): Promise<void> {
    try {
      const response = await requestCharacterSelection(characterId);
      if (charactersSnapshot === undefined) return;
      charactersSnapshot = applyCharacterSelection(
        charactersSnapshot,
        response
      );
      renderCharacterPanel();
    } catch {
      characterReasonElement.textContent =
        "這次沒有換成功，原本的夥伴會繼續陪你。";
    }
  }

  function renderRoster(): void {
    const fragment = document.createDocumentFragment();
    for (const character of charactersSnapshot?.characters ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "roster-chip";
      button.dataset["characterId"] = character.characterId;
      button.setAttribute(
        "aria-pressed",
        charactersSnapshot?.selection.characterId === character.characterId
          ? "true"
          : "false"
      );
      const portrait = document.createElement("span");
      portrait.className = "roster-portrait";
      const glyph = document.createElement("span");
      glyph.className = "roster-glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = CHARACTER_VIEW[character.characterId].glyph;
      portrait.append(glyph);
      if (character.unlocked && character.visual.mode === "doll") {
        const avatar = document.createElement("img");
        avatar.alt = "";
        avatar.loading = "lazy";
        avatar.src = character.visual.avatarPath;
        avatar.addEventListener("load", () => {
          glyph.hidden = true;
        });
        avatar.addEventListener("error", () => {
          avatar.hidden = true;
          glyph.hidden = false;
        });
        portrait.append(avatar);
      }
      if (!character.unlocked && character.progress !== null) {
        const ring = document.createElement("span");
        ring.className = "progress-ring";
        ring.style.setProperty(
          "--progress-turn",
          `${character.progress.value}turn`
        );
        ring.setAttribute("aria-hidden", "true");
        portrait.append(ring);
      }
      const name = document.createElement("span");
      name.className = "roster-name";
      name.textContent = character.displayName;
      button.append(portrait, name);
      if (character.unlocked) {
        button.setAttribute("aria-label", `選擇 ${character.displayName}`);
        button.addEventListener("click", () => {
          void chooseCharacter(character.characterId);
        });
      } else {
        const explain = characterExplain(character);
        const accessibleExplain = document.createElement("span");
        accessibleExplain.className = "visually-hidden";
        accessibleExplain.textContent = explain;
        button.append(accessibleExplain);
        button.title = explain;
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
        button.setAttribute(
          "aria-label",
          `${character.displayName} 尚未解鎖。${explain}`
        );
      }
      fragment.append(button);
    }
    rosterElement.replaceChildren(fragment);
  }

  async function chooseTheme(
    characterId: CharacterId,
    themeId: CharacterThemeId
  ): Promise<void> {
    try {
      const response = await requestCharacterWardrobe(characterId, themeId);
      if (charactersSnapshot === undefined) return;
      charactersSnapshot = applyCharacterWardrobe(
        charactersSnapshot,
        response
      );
      renderCharacterPanel();
    } catch {
      characterReasonElement.textContent =
        "這套服裝暫時沒有換上，先保留現在的樣子。";
    }
  }

  function renderWardrobe(): void {
    wardrobeToggle.setAttribute("aria-expanded", wardrobeOpen ? "true" : "false");
    wardrobeToggle.textContent = wardrobeOpen ? "收起衣櫥" : "打開衣櫥";
    wardrobeDrawer.hidden = !wardrobeOpen;
    const character = selectedCharacter();
    const fragment = document.createDocumentFragment();
    if (character?.visual.mode === "doll") {
      for (const theme of character.visual.themes) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "wardrobe-item";
        button.dataset["themeId"] = theme.themeId;
        button.setAttribute(
          "aria-pressed",
          theme.themeId === character.activeThemeId ? "true" : "false"
        );
        const label = document.createElement("span");
        label.textContent = THEME_LABELS[theme.themeId];
        if (theme.unlocked) {
          const image = document.createElement("img");
          image.src = theme.outfitPath;
          image.alt = "";
          image.loading = "lazy";
          image.addEventListener("error", () => {
            image.hidden = true;
          });
          button.append(image, label);
          button.setAttribute(
            "aria-label",
            `換上${THEME_LABELS[theme.themeId]}服裝`
          );
          button.addEventListener("click", () => {
            void chooseTheme(character.characterId, theme.themeId);
          });
        } else {
          const explain = characterExplain(character);
          const placeholder = document.createElement("span");
          placeholder.className = "wardrobe-placeholder";
          placeholder.setAttribute("aria-hidden", "true");
          placeholder.textContent = CHARACTER_VIEW[character.characterId].glyph;
          button.append(placeholder, label);
          button.classList.add("is-locked");
          button.disabled = true;
          button.title = explain;
          button.setAttribute("aria-disabled", "true");
          button.setAttribute(
            "aria-label",
            `${THEME_LABELS[theme.themeId]}服裝尚未解鎖。${explain}`
          );
        }
        fragment.append(button);
      }
    }
    const hasThemes = fragment.childNodes.length > 0;
    wardrobeList.replaceChildren(fragment);
    wardrobeToggle.hidden = !hasThemes;
  }

  function renderVoiceControls(): void {
    const hasVoiceLines =
      charactersSnapshot?.voiceEnabled === true &&
      charactersSnapshot.characters.some(
        (character) => character.voiceLines.length > 0
      );
    voiceControls.hidden = !hasVoiceLines;
    if (!hasVoiceLines) return;
    const enabled = voiceGate.isEnabled();
    voiceToggle.textContent = enabled ? "關閉角色語音" : "開啟角色語音";
    voiceToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
    voiceHint.hidden = enabled;
  }

  function triggerStageVoices(): void {
    const character = selectedCharacter();
    if (character === undefined || unlockQueue.current() !== undefined) return;
    if (playVoice(character, "greeting") !== undefined) return;
    if (characterConnectionState === "healthy") {
      playVoice(character, latestTodayTokens === 0 ? "quiet" : "active");
    }
  }

  function renderCharacterPanel(): void {
    const character = selectedCharacter();
    if (character !== undefined) {
      characterReasonElement.textContent =
        charactersSnapshot?.selection.selectedBy === "manual"
          ? "這是你選的夥伴；想換人或換衣服都可以慢慢來。"
          : "先由她陪你；你隨時可以換，不需要多用 token。";
    }
    renderCharacterStage();
    renderRoster();
    renderWardrobe();
    renderVoiceControls();
    triggerStageVoices();
  }

  function showCurrentUnlock(): void {
    const unlock = unlockQueue.current();
    if (unlock === undefined) {
      toastElement.hidden = true;
      renderCharacterPanel();
      return;
    }
    const character = charactersSnapshot?.characters.find(
      (candidate) => candidate.characterId === unlock.characterId
    );
    toastElement.textContent =
      unlock.kind === "character"
        ? `${unlock.displayName} 來了！`
        : `${unlock.displayName} 的${THEME_LABELS[unlock.themeId!]}服裝準備好了！`;
    toastElement.hidden = false;
    renderCharacterPanel();
    const line =
      character === undefined ? undefined : playVoice(character, "unlock");
    celebrationTimer = window.setTimeout(
      () => {
        celebrationTimer = undefined;
        unlockQueue.finish();
        showCurrentUnlock();
      },
      Math.max(2_800, Math.min(line?.durationMs ?? 0, 5_000) + 300)
    );
  }

  function enqueueUnlocks(unlocks: readonly CharacterUnlock[]): void {
    const wasIdle = unlockQueue.current() === undefined;
    const current = unlockQueue.enqueue(unlocks);
    if (wasIdle && current !== undefined && celebrationTimer === undefined) {
      showCurrentUnlock();
    }
  }

  async function pollCharacters(): Promise<void> {
    const requestSequence = ++characterRequestSequence;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(CHARACTERS_API_ENDPOINT, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error("Characters unavailable");
      const next = parseCharactersSnapshot(await readCharacterJson(response));
      if (requestSequence !== characterRequestSequence) return;
      const unlocks = diffCharacterUnlocks(charactersSnapshot, next);
      imageFallback.advancePoll();
      charactersSnapshot = next;
      renderCharacterPanel();
      enqueueUnlocks(unlocks);
    } catch {
      if (charactersSnapshot === undefined) setLetterStage();
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function renderCharacter(
    characterId: CompanionCharacterId,
    reason: string
  ): void {
    if (charactersSnapshot !== undefined) {
      renderCharacterPanel();
      return;
    }
    const view = CHARACTER_VIEW[characterId];
    document.documentElement.dataset["character"] = characterId;
    companionGlyphElement.textContent = view.glyph;
    companionTitleElement.textContent = `嗨，我是 ${view.name} 姊姊。`;
    companionVisualElement.setAttribute(
      "aria-label",
      `TokenMonster ${view.name} 字母角色`
    );
    characterReasonElement.textContent = reason;
  }

  function renderStarter(starter: CompanionStarterSelection): void {
    if (charactersSnapshot !== undefined) {
      renderCharacterPanel();
      return;
    }
    if (starter.outcome === "selected") {
      renderCharacter(
        starter.characterId,
        "依近 28 天的本機使用分布先由她陪你；你隨時可以換。"
      );
      return;
    }
    delete document.documentElement.dataset["character"];
    companionGlyphElement.textContent = "T";
    companionTitleElement.textContent = "選一位姊妹開始陪你。";
    companionVisualElement.setAttribute(
      "aria-label",
      "TokenMonster 字母 T 夥伴"
    );
    characterReasonElement.textContent =
      starter.reason === "highest-provider-total-tie"
        ? "近 28 天有兩位並列，這次由你選；之後也能隨時換。"
        : "目前沒有足夠的 provider 分項，由你選；不需要多用 token。";
  }

  wardrobeToggle.addEventListener("click", () => {
    wardrobeOpen = !wardrobeOpen;
    renderWardrobe();
  });

  document.addEventListener(
    "click",
    () => {
      voiceGate.arm();
      triggerStageVoices();
    },
    { capture: true, once: true }
  );

  function toggleVoice(): void {
    voiceGate.setEnabled(!voiceGate.isEnabled());
    if (!voiceGate.isEnabled()) {
      voiceAudio.pause();
      voiceAudio.removeAttribute("src");
    }
    renderVoiceControls();
    triggerStageVoices();
  }

  voiceToggle.addEventListener("click", toggleVoice);
  voiceHint.addEventListener("click", toggleVoice);

  let refreshTimer: number | undefined;
  let currentController: AbortController | undefined;
  let blockedByIncompatibility = false;

  function clearRefreshTimer(): void {
    if (refreshTimer === undefined) return;
    window.clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }

  function setRefreshTimer(delayMs: number): void {
    clearRefreshTimer();
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined;
      void pollCollector();
    }, delayMs);
  }

  function setMetricPlaceholders(): void {
    metricElements.today.textContent = "—";
    metricElements.last7Days.textContent = "—";
    metricElements.last28Days.textContent = "—";
  }

  function prepareRescan(
    label: string,
    enabled: boolean
  ): void {
    rescanButton.textContent = label;
    rescanButton.disabled = !enabled;
  }

  function clearLastGoodDisplay(trendMessage: string): void {
    if (lastGoodSnapshot !== undefined) return;
    setMetricPlaceholders();
    clearTrend(trendMessage, false);
  }

  function updateCharacterConnection(
    nextState: CharacterConnectionState
  ): void {
    previousCharacterConnectionState = characterConnectionState;
    characterConnectionState = nextState;
    renderCharacterStage();
    if (
      nextState === "refresh-failed" &&
      previousCharacterConnectionState !== "refresh-failed"
    ) {
      const character = selectedCharacter();
      if (character !== undefined) playVoice(character, "error");
    }
  }

  function showStarting(): void {
    document.documentElement.dataset["connection"] = "starting";
    statusElement.textContent = "正在啟動";
    companionLineElement.textContent = "本機用量服務正在準備，很快就好。";
    updatedElement.textContent = "";
    staleBadgeElement.hidden = true;
    prepareRescan("重新掃描", false);
    clearLastGoodDisplay("啟動完成後會顯示 UTC 每日趨勢。");
    updateCharacterConnection("other");
  }

  function showSyncing(status: CompanionCollectorStatus): void {
    document.documentElement.dataset["connection"] = "syncing";
    statusElement.textContent = "正在同步";
    companionLineElement.textContent =
      lastGoodSnapshot === undefined
        ? "我正在掃描支援的本機用量來源，先不把空白當成零。"
        : "我正在重新掃描；先保留上次整理好的用量。";
    updatedElement.textContent =
      lastGoodSnapshot === undefined
        ? ""
        : `上次更新於本機時間 ${timeFormatter.format(new Date(lastGoodSnapshot.generatedAt))}`;
    staleBadgeElement.hidden = true;
    prepareRescan("正在掃描", status.canRetry);
    clearLastGoodDisplay("掃描完成後會顯示 UTC 每日趨勢。");
    updateCharacterConnection("other");
  }

  function showRefreshFailed(status: CompanionCollectorStatus): void {
    document.documentElement.dataset["connection"] = "error";
    statusElement.textContent = "掃描未完成";
    companionLineElement.textContent =
      "第一次掃描沒有完成。可以再試一次，我也會繼續留在這裡。";
    updatedElement.textContent = `已嘗試 ${numberFormatter.format(status.consecutiveFailures)} 次`;
    staleBadgeElement.hidden = true;
    prepareRescan("再試一次", status.canRetry);
    setMetricPlaceholders();
    clearTrend("重新掃描成功後會顯示 UTC 每日趨勢。", false);
    updateCharacterConnection("refresh-failed");
  }

  function showUnavailable(): void {
    document.documentElement.dataset["connection"] = "error";
    statusElement.textContent = "暫時中斷";
    companionLineElement.textContent =
      "本機用量服務暫時沒回應，我會稍後再試。";
    updatedElement.textContent =
      lastGoodSnapshot === undefined
        ? ""
        : `保留本機時間 ${timeFormatter.format(new Date(lastGoodSnapshot.generatedAt))} 的資料`;
    staleBadgeElement.hidden = lastGoodSnapshot === undefined;
    prepareRescan("立即重試", true);
    clearLastGoodDisplay("連線恢復後會顯示 UTC 每日趨勢。");
    updateCharacterConnection("other");
  }

  function showIncompatible(): void {
    document.documentElement.dataset["connection"] = "error";
    statusElement.textContent = "需要更新";
    companionLineElement.textContent =
      "目前版本無法讀取用量。請重新啟動或更新 TokenMonster，再重新檢查。";
    updatedElement.textContent = "";
    staleBadgeElement.hidden = lastGoodSnapshot === undefined;
    prepareRescan("重新檢查", true);
    clearLastGoodDisplay("更新完成後會顯示 UTC 每日趨勢。");
    updateCharacterConnection("other");
  }

  function handleUnavailable(): void {
    blockedByIncompatibility = false;
    showUnavailable();
    setRefreshTimer(unavailableRetryBackoff.nextDelayMs());
  }

  function handleIncompatible(): void {
    blockedByIncompatibility = true;
    clearRefreshTimer();
    showIncompatible();
  }

function formatDate(utcDate: string): string {
  return `${utcDate.slice(5, 7)}/${utcDate.slice(8, 10)}`;
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(
  name: K
): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NAMESPACE, name);
}

function clearTrend(message: string, healthy: boolean): void {
  trendElement.replaceChildren();
  trendAccessibleElement.replaceChildren();
  trendEmptyElement.textContent = message;
  trendEmptyElement.hidden = false;
  trendElement.hidden = true;
  trendElement.dataset["healthy"] = healthy ? "true" : "false";
}

function renderAccessibleTrend(points: readonly CompanionDailyPoint[]): void {
  const fragment = document.createDocumentFragment();
  for (const point of points) {
    const item = document.createElement("li");
    item.textContent = `UTC ${point.utcDate}：${numberFormatter.format(point.totalTokens)} tokens`;
    fragment.append(item);
  }
  trendAccessibleElement.replaceChildren(fragment);
}

function renderTrend(snapshot: CompanionHealthySnapshot): void {
  const points = snapshot.daily;
  if (points.length === 0) {
    clearTrend("目前還沒有 UTC 每日用量紀錄。", true);
    return;
  }

  const width = 720;
  const height = 220;
  const plotTop = 18;
  const plotBottom = 176;
  const plotHeight = plotBottom - plotTop;
  const columnWidth = width / 28;
  const barWidth = Math.max(6, columnWidth - 8);
  const maxTokens = Math.max(...points.map((point) => point.totalTokens));
  const todayUtcDate = snapshot.generatedAt.slice(0, 10);
  const todayTimestamp = Date.parse(`${todayUtcDate}T00:00:00.000Z`);
  const firstTimestamp = todayTimestamp - 27 * 86_400_000;

  const svg = createSvgElement("svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    `最近 28 個 UTC 日的每日 token 趨勢，共 ${numberFormatter.format(snapshot.totals.last28Days)} tokens。`
  );
  svg.classList.add("trend-chart");

  const baseline = createSvgElement("line");
  baseline.setAttribute("x1", "0");
  baseline.setAttribute("x2", String(width));
  baseline.setAttribute("y1", String(plotBottom));
  baseline.setAttribute("y2", String(plotBottom));
  baseline.classList.add("trend-baseline");
  svg.append(baseline);

  for (const point of points) {
    const pointTimestamp = Date.parse(`${point.utcDate}T00:00:00.000Z`);
    const dayIndex = Math.round(
      (pointTimestamp - firstTimestamp) / 86_400_000
    );
    const barHeight =
      maxTokens === 0 ? 0 : (point.totalTokens / maxTokens) * plotHeight;
    const bar = createSvgElement("rect");
    bar.setAttribute(
      "x",
      String(dayIndex * columnWidth + (columnWidth - barWidth) / 2)
    );
    bar.setAttribute("y", String(plotBottom - barHeight));
    bar.setAttribute("width", String(barWidth));
    bar.setAttribute("height", String(barHeight));
    bar.setAttribute("rx", "4");
    bar.classList.add("trend-bar");
    const title = createSvgElement("title");
    title.textContent = `${point.utcDate}：${numberFormatter.format(point.totalTokens)} tokens`;
    bar.append(title);
    svg.append(bar);
  }

  const firstLabel = createSvgElement("text");
  firstLabel.setAttribute("x", "0");
  firstLabel.setAttribute("y", "210");
  firstLabel.classList.add("trend-label");
  firstLabel.textContent = formatDate(
    new Date(firstTimestamp).toISOString().slice(0, 10)
  );
  const lastLabel = createSvgElement("text");
  lastLabel.setAttribute("x", String(width));
  lastLabel.setAttribute("y", "210");
  lastLabel.setAttribute("text-anchor", "end");
  lastLabel.classList.add("trend-label");
  lastLabel.textContent = formatDate(todayUtcDate);
  svg.append(firstLabel, lastLabel);

  trendElement.replaceChildren(svg);
  renderAccessibleTrend(points);
  trendEmptyElement.hidden = true;
  trendElement.hidden = false;
  trendElement.dataset["healthy"] = "true";
}

  function renderSnapshotData(snapshot: CompanionHealthySnapshot): void {
    lastGoodSnapshot = snapshot;
    latestTodayTokens = snapshot.totals.today;
    renderStarter(snapshot.starter);
    metricElements.today.textContent = numberFormatter.format(
      snapshot.totals.today
    );
    metricElements.last7Days.textContent = numberFormatter.format(
      snapshot.totals.last7Days
    );
    metricElements.last28Days.textContent = numberFormatter.format(
      snapshot.totals.last28Days
    );
    renderTrend(snapshot);
  }

  function showSettled(
    snapshot: CompanionHealthySnapshot,
    collector: CompanionCollectorStatus
  ): void {
    blockedByIncompatibility = false;
    unavailableRetryBackoff.reset();
    renderSnapshotData(snapshot);
    prepareRescan("重新掃描", collector.canRetry);
    if (collector.phase === "stale") {
      document.documentElement.dataset["connection"] = "stale";
      statusElement.textContent = "資料稍舊";
      companionLineElement.textContent =
        "這是上次成功整理的用量；這次掃描沒完成，你可以再試一次。";
      updatedElement.textContent = `上次成功於本機時間 ${timeFormatter.format(new Date(collector.lastSuccessAt!))}`;
      staleBadgeElement.hidden = false;
      updateCharacterConnection("stale");
      return;
    }
    staleBadgeElement.hidden = true;
    if (collector.phase === "ready-no-data") {
      document.documentElement.dataset["connection"] = "no-data";
      statusElement.textContent = "掃描完成";
      companionLineElement.textContent =
        "還沒找到支援的本機用量來源；這不是安靜的一天，你可以隨時重新掃描。";
    } else {
      document.documentElement.dataset["connection"] = "healthy";
      statusElement.textContent = "已連線";
      companionLineElement.textContent =
        snapshot.totals.today === 0
          ? "今天（UTC）還很安靜，我會在這裡陪你。"
          : "今天（UTC）的用量已經整理好了。";
    }
    updatedElement.textContent = `更新於本機時間 ${timeFormatter.format(new Date(collector.lastSuccessAt!))}`;
    updateCharacterConnection("healthy");
    triggerStageVoices();
  }

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (
    !contentType.toLowerCase().startsWith("application/json") ||
    (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_CHARACTERS)
  ) {
    throw new TypeError("Invalid companion response");
  }
  const body = await response.text();
  if (body.length > MAX_RESPONSE_CHARACTERS) {
    throw new TypeError("Invalid companion response");
  }
  return JSON.parse(body) as unknown;
}

  function handleApiError(error: CompanionErrorCode): void {
    if (shouldAutomaticallyRetry(error)) {
      handleUnavailable();
    } else {
      handleIncompatible();
    }
  }

  function parseCollectorPayload(
    value: unknown
  ): CompanionCollectorStatus | CompanionErrorSnapshot {
    try {
      return parseCompanionCollectorStatus(value);
    } catch {
      const error = parseCompanionSnapshot(value);
      if (error.status !== "error") {
        throw new TypeError("Invalid collector response");
      }
      return error;
    }
  }

  async function readMetrics(
    controller: AbortController
  ): Promise<CompanionHealthySnapshot | undefined> {
    const response = await fetch(COMPANION_API_ENDPOINT, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    const payload = parseCompanionSnapshot(await readBoundedJson(response));
    if (payload.status === "error") {
      handleApiError(payload.error);
      return undefined;
    }
    if (!response.ok) {
      handleUnavailable();
      return undefined;
    }
    return payload;
  }

  async function applyCollectorStatus(
    collector: CompanionCollectorStatus,
    controller: AbortController
  ): Promise<void> {
    if (collector.phase === "starting") {
      blockedByIncompatibility = false;
      showStarting();
      setRefreshTimer(ACTIVE_POLL_MS);
      return;
    }
    if (collector.phase === "syncing") {
      blockedByIncompatibility = false;
      showSyncing(collector);
      setRefreshTimer(ACTIVE_POLL_MS);
      return;
    }
    if (collector.phase === "refresh-failed") {
      blockedByIncompatibility = false;
      showRefreshFailed(collector);
      setRefreshTimer(SETTLED_POLL_MS);
      return;
    }
    const snapshot = await readMetrics(controller);
    if (snapshot === undefined) return;
    showSettled(snapshot, collector);
    await pollCharacters();
    setRefreshTimer(SETTLED_POLL_MS);
  }

  async function pollCollector(): Promise<void> {
    clearRefreshTimer();
    currentController?.abort();
    const controller = new AbortController();
    currentController = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(COLLECTOR_STATUS_ENDPOINT, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      const payload = parseCollectorPayload(await readBoundedJson(response));
      if ("status" in payload) {
        handleApiError(payload.error);
        return;
      }
      if (!response.ok) {
        handleUnavailable();
        return;
      }
      await applyCollectorStatus(payload, controller);
    } catch {
      if (!controller.signal.aborted || currentController === controller) {
        handleUnavailable();
      }
    } finally {
      window.clearTimeout(timeout);
      if (currentController === controller) currentController = undefined;
    }
  }

  async function requestRescan(): Promise<void> {
    clearRefreshTimer();
    currentController?.abort();
    unavailableRetryBackoff.reset();
    blockedByIncompatibility = false;
    showSyncing(
      Object.freeze({
        phase: "syncing",
        lastSuccessAt: lastGoodSnapshot?.generatedAt ?? null,
        consecutiveFailures: 0,
        canRetry: false
      })
    );
    const controller = new AbortController();
    currentController = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      REFRESH_REQUEST_TIMEOUT_MS
    );
    try {
      const response = await fetch(COLLECTOR_REFRESH_ENDPOINT, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      const payload = parseCollectorPayload(await readBoundedJson(response));
      if ("status" in payload) {
        handleApiError(payload.error);
        return;
      }
      await applyCollectorStatus(payload, controller);
    } catch {
      if (!controller.signal.aborted || currentController === controller) {
        handleUnavailable();
      }
    } finally {
      window.clearTimeout(timeout);
      if (currentController === controller) currentController = undefined;
    }
  }

  rescanButton.addEventListener("click", () => {
    if (!rescanButton.disabled) void requestRescan();
  });

  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      !blockedByIncompatibility
    ) {
      void pollCollector();
    }
  });

  showStarting();
  void pollCharacters();
  void pollCollector();
}

if (typeof document !== "undefined") startCompanionUi();
