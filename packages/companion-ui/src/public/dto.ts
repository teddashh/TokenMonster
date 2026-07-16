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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
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

export function isCharacterId(value: unknown): value is CharacterId {
  return CHARACTER_IDS.some((candidate) => candidate === value);
}

export function isCharacterThemeId(value: unknown): value is CharacterThemeId {
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
    (visual.mode === "letter" &&
      (characterId !== "glm" || activeThemeId !== null)) ||
    (characterId === "glm" && visual.mode !== "letter")
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
