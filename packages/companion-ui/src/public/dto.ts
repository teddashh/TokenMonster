export const COMPANION_API_ENDPOINT = "/api/companion" as const;
export const COLLECTOR_STATUS_ENDPOINT = "/api/companion/status" as const;
export const COLLECTOR_REFRESH_ENDPOINT = "/api/companion/refresh" as const;
export const USAGE_FAMILIES_API_ENDPOINT = "/api/usage/families" as const;
export const USAGE_MODELS_API_ENDPOINT = "/api/usage/models" as const;
export const USAGE_QUOTA_API_ENDPOINT = "/api/usage/quota" as const;
export const USAGE_QUOTA_PLAN_API_ENDPOINT = "/api/usage/quota/plan" as const;

export const QUOTA_FAMILIES = ["anthropic", "openai", "google", "xai"] as const;
export type QuotaFamily = (typeof QUOTA_FAMILIES)[number];

export const QUOTA_PLAN_OPTIONS = Object.freeze({
  anthropic: Object.freeze([
    Object.freeze({ planId: "claude-pro", labelZh: "Claude Pro" }),
    Object.freeze({ planId: "claude-max-5x", labelZh: "Claude Max 5x" }),
    Object.freeze({ planId: "claude-max-20x", labelZh: "Claude Max 20x" }),
  ]),
  openai: Object.freeze([
    Object.freeze({ planId: "chatgpt-plus", labelZh: "ChatGPT Plus" }),
    Object.freeze({ planId: "chatgpt-pro", labelZh: "ChatGPT Pro" }),
  ]),
  google: Object.freeze([
    Object.freeze({ planId: "gemini-free", labelZh: "Gemini 免費版" }),
    Object.freeze({ planId: "gemini-ai-pro", labelZh: "Google AI Pro" }),
  ]),
  xai: Object.freeze([
    Object.freeze({ planId: "supergrok", labelZh: "SuperGrok" }),
  ]),
} as const satisfies Readonly<
  Record<QuotaFamily, readonly Readonly<{ planId: string; labelZh: string }>[]>
>);

export interface QuotaFamilyEstimate {
  readonly family: QuotaFamily;
  readonly planId: string | null;
  readonly windowHours: number;
  readonly windowKind: "rolling" | "utc-day";
  readonly usedTokens: number;
  readonly budgetTokens: number | null;
  readonly estimate: true;
}

export interface QuotaSnapshot {
  readonly status: "ok";
  readonly generatedAt: string;
  readonly families: readonly QuotaFamilyEstimate[];
}

export const USAGE_WINDOWS = [7, 28, 90] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

export const USAGE_FAMILIES = [
  "openai",
  "anthropic",
  "google",
  "xai",
  "deepseek",
  "qwen",
  "mistral",
  "venice",
  "sakana",
  "perplexity",
  "glm",
  "other",
] as const;

export type UsageFamily = (typeof USAGE_FAMILIES)[number];
export type UsageFamilyTotals = Readonly<Record<UsageFamily, number>>;

export interface UsageFamilyDay {
  readonly utcDate: string;
  readonly families: UsageFamilyTotals;
}

export interface UsageFamiliesResponse {
  readonly window: UsageWindow;
  readonly days: readonly UsageFamilyDay[];
}

export interface UsageModel {
  readonly model: string;
  readonly family: UsageFamily;
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface UsageModelsResponse {
  readonly window: UsageWindow;
  readonly models: readonly UsageModel[];
}

export const COMPANION_ERROR_CODES = [
  "sidecar-unavailable",
  "sidecar-incompatible",
] as const;

export type CompanionErrorCode = (typeof COMPANION_ERROR_CODES)[number];

export const COMPANION_CHARACTER_IDS = [
  "chatgpt",
  "claude",
  "gemini",
  "grok",
] as const;

export type CompanionCharacterId = (typeof COMPANION_CHARACTER_IDS)[number];

export const COMPANION_PROVIDER_FAMILIES = [
  "openai",
  "anthropic",
  "google",
  "xai",
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
  CompanionHealthySnapshot | CompanionErrorSnapshot;

export const COMPANION_COLLECTOR_PHASES = [
  "starting",
  "syncing",
  "ready",
  "ready-no-data",
  "refresh-failed",
  "stale",
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
export const CHARACTER_PROFILE_ENDPOINT = "/api/characters/profile" as const;
export const CHARACTER_SELECT_ENDPOINT = "/api/characters/select" as const;
export const CHARACTER_PROGRESSION_LOCK_REPAIR_ENDPOINT =
  "/api/characters/progression-lock/repair" as const;
export const BYOK_STATUS_ENDPOINT = "/api/byok/status" as const;
export const BYOK_CONFIGURE_ENDPOINT = "/api/byok/configure" as const;
export const BYOK_CLEAR_ENDPOINT = "/api/byok/clear" as const;
export const BYOK_CHAT_ENDPOINT = "/api/byok/chat" as const;
export const UI_LOCALE_PREFERENCE_ENDPOINT = "/api/preferences/locale" as const;
export const CHARACTER_INTERACT_ENDPOINT = "/api/characters/interact" as const;
export const CHARACTER_WARDROBE_ENDPOINT = "/api/characters/wardrobe" as const;
export const CHARACTER_ASSET_PACK_STATUS_ENDPOINT =
  "/api/characters/assets" as const;
export const CHARACTER_ASSET_PACK_CONSENT_ENDPOINT =
  "/api/characters/assets/consent" as const;

export const CHARACTER_ASSET_PACK_PHASES = [
  "unavailable",
  "available",
  "installing",
  "repair-needed",
  "installed",
] as const;
export type CharacterAssetPackPhase =
  (typeof CHARACTER_ASSET_PACK_PHASES)[number];

export const CHARACTER_ASSET_PACK_ERRORS = [
  "download-failed",
  "cache-unavailable",
  "local-state-unavailable",
] as const;
export type CharacterAssetPackError =
  (typeof CHARACTER_ASSET_PACK_ERRORS)[number];

export interface CharacterAssetPackStatus {
  readonly status: "ok";
  readonly phase: CharacterAssetPackPhase;
  readonly consented: boolean;
  readonly enabled: boolean;
  readonly releaseId: string | null;
  readonly downloadBytes: number | null;
  readonly lastError: CharacterAssetPackError | null;
}

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
  "glm",
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
  "festival",
] as const;

export type CharacterThemeId = (typeof CHARACTER_THEME_IDS)[number];
export const CHARACTER_LETTER_PATTERN_IDS = [
  "circuit-grid",
  "ledger-grid",
  "civic-ribbons",
  "notebook-lines",
  "pulse-steps",
  "leaf-canopy",
  "balanced-scales",
  "interlocking-rings",
  "woven-home",
  "checklist-grid",
  "constellation",
  "story-weave",
  "speed-stripes",
  "table-check",
  "route-dashes",
  "soft-waves",
  "nested-circles",
  "linked-arcs",
  "broadcast-rings",
  "confetti",
] as const;
export type CharacterLetterPatternId =
  (typeof CHARACTER_LETTER_PATTERN_IDS)[number];

export const CHARACTER_LETTER_ACCENT_IDS = [
  "terminal-caret",
  "steady-coin",
  "dialogue-star",
  "open-book",
  "care-cross",
  "new-leaf",
  "law-seal",
  "listening-knot",
  "home-heart",
  "task-check",
  "research-spark",
  "story-mark",
  "victory-chevron",
  "shared-plate",
  "compass-point",
  "reflection-orbit",
  "question-ring",
  "world-link",
  "signal-dot",
  "celebration-star",
] as const;
export type CharacterLetterAccentId =
  (typeof CHARACTER_LETTER_ACCENT_IDS)[number];
export type CharacterLetterPatternDensity = "light" | "medium" | "bold";
export type CharacterLetterAccentPlacement =
  "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type CharacterPose = "supported" | "challenged" | "victory";
export type VoiceTrigger = "greeting" | "unlock" | "quiet" | "active" | "error";

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

export interface CharacterLetterTheme {
  readonly themeId: CharacterThemeId;
  readonly displayName: string;
  readonly accessibleLabel: string;
  readonly unlocked: boolean;
  readonly palette: Readonly<{
    background: string;
    foreground: string;
    accent: string;
  }>;
  readonly pattern: Readonly<{
    id: CharacterLetterPatternId;
    label: string;
    density: CharacterLetterPatternDensity;
  }>;
  readonly accent: Readonly<{
    id: CharacterLetterAccentId;
    label: string;
    placement: CharacterLetterAccentPlacement;
  }>;
}

export type CharacterVisual =
  | Readonly<{
      mode: "letter";
      glyph: string;
      background: string;
      foreground: string;
      accent: string;
      themes: readonly CharacterLetterTheme[];
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

export interface CharacterStarterPersona {
  readonly alias: string;
  readonly taglineZhTw: string;
}

export interface CharacterRosterEntry {
  readonly characterId: CharacterId;
  readonly displayName: string;
  readonly kind: "sister" | "friend";
  readonly unlocked: boolean;
  readonly unlockedAt: string | null;
  readonly isStarter: boolean;
  readonly starterPersona: CharacterStarterPersona | null;
  readonly activeThemeId: CharacterThemeId | null;
  readonly visual: CharacterVisual;
  readonly progress: CharacterProgress | null;
  readonly voiceLines: readonly CharacterVoiceLine[];
}

export interface CharactersSnapshot {
  readonly status: "ok";
  readonly generatedAt: string;
  readonly unlockBatchId?: string | null;
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

export type CharacterProgressionLockRepairOutcome = "repaired" | "not-needed";

export interface CharacterProgressionLockRepairResponse {
  readonly status: "ok";
  readonly outcome: CharacterProgressionLockRepairOutcome;
}

export type ByokAvailability = "available" | "unavailable";
export type ByokPersistence = "os-backed" | "memory-only";

export interface ByokStatusResponse {
  readonly status: "ok";
  readonly availability: ByokAvailability;
  readonly configured: boolean;
  readonly persistence: ByokPersistence;
  readonly canPersist: boolean;
  readonly provider: "OpenAI";
  readonly model: "gpt-5.6-luna";
}

export interface ByokChatMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export type ByokChatErrorCode =
  | "unavailable"
  | "not-configured"
  | "busy"
  | "request-timeout"
  | "request-aborted"
  | "network-error"
  | "provider-authentication-failed"
  | "provider-rate-limited"
  | "provider-request-rejected"
  | "provider-unavailable"
  | "provider-error"
  | "response-too-large"
  | "malformed-response"
  | "incomplete-response"
  | "unsupported-response"
  | "empty-response"
  | "local-service-error";

export type ByokChatResponse =
  | Readonly<{
      status: "ok";
      characterId: "chatgpt" | "claude" | "gemini" | "grok";
      text: string;
    }>
  | Readonly<{
      status: "error";
      characterId: "chatgpt" | "claude" | "gemini" | "grok";
      error: ByokChatErrorCode;
    }>;

export interface CharacterWardrobeResponse {
  readonly status: "ok";
  readonly characterId: CharacterId;
  readonly activeThemeId: CharacterThemeId;
}

export type CharacterInteractionLocale = "zh-TW" | "en";

export type UiLocale = CharacterInteractionLocale;

export interface UiLocalePreferenceResponse {
  readonly status: "ok";
  readonly locale: UiLocale;
  readonly revision: number;
}

export type UiLocalePreferenceErrorResponse = Readonly<{
  status: "error";
  error: "invalid-request" | "revision-conflict" | "storage-unavailable";
}>;

export function parseUiLocalePreferenceResponse(
  value: unknown,
): UiLocalePreferenceResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["status", "locale", "revision"]) ||
    value["status"] !== "ok" ||
    (value["locale"] !== "zh-TW" && value["locale"] !== "en") ||
    !Number.isSafeInteger(value["revision"]) ||
    (value["revision"] as number) < 0
  ) {
    throw new TypeError("Invalid UI locale preference response");
  }
  return Object.freeze({
    status: "ok",
    locale: value["locale"],
    revision: value["revision"] as number,
  });
}

// "tap" spends the gateway's daily tap allowance; "idle" is the stateless
// ambient-chatter action, so background speech never consumes that budget.
export type CharacterInteractionAction = "tap" | "idle";

export type CharacterInteractionResponse =
  | Readonly<{
      status: "ok";
      action: CharacterInteractionAction;
      characterId: CharacterId;
      locale: CharacterInteractionLocale;
      outcome: "line";
      line: Readonly<{ lineId: string; text: string }>;
      cooldownMs: number;
    }>
  | Readonly<{
      status: "ok";
      action: CharacterInteractionAction;
      characterId: CharacterId;
      locale: CharacterInteractionLocale;
      outcome: "animation-only";
      retryAfterMs: number;
    }>;

export const CHARACTER_PROFILE_TRAIT_IDS = [
  "cli-focused",
  "tool-focused",
  "multi-tool",
  "cache-savvy",
  "output-heavy",
  "night-oriented",
] as const;
export type CharacterProfileTraitId =
  (typeof CHARACTER_PROFILE_TRAIT_IDS)[number];

export const CHARACTER_PROFILE_MOOD_IDS = [
  "learning",
  "unknown",
  "resting",
  "quiet",
  "steady",
  "lively",
] as const;
export type CharacterProfileMoodId =
  (typeof CHARACTER_PROFILE_MOOD_IDS)[number];

export const CHARACTER_PROFILE_COVERAGE_BANDS = [
  "insufficient",
  "partial",
  "good",
  "full",
] as const;
export type CharacterProfileCoverageBand =
  (typeof CHARACTER_PROFILE_COVERAGE_BANDS)[number];

export const CHARACTER_PROFILE_ENERGY_BANDS = [
  "dormant",
  "low",
  "medium",
  "high",
] as const;
export type CharacterProfileEnergyBand =
  (typeof CHARACTER_PROFILE_ENERGY_BANDS)[number];

export const CHARACTER_PROFILE_EVOLUTION_CADENCES = [
  "weekly",
  "event",
  "none",
] as const;
export type CharacterProfileEvolutionCadence =
  (typeof CHARACTER_PROFILE_EVOLUTION_CADENCES)[number];

export const CHARACTER_PROFILE_EVOLUTION_EVENTS = [
  "awaiting-coverage",
  "initial-profile",
  "coverage-complete",
  "identity-shift",
  "weekly-review",
  "no-change",
] as const;
export type CharacterProfileEvolutionEvent =
  (typeof CHARACTER_PROFILE_EVOLUTION_EVENTS)[number];

export const CHARACTER_PROFILE_REASON_SUBJECTS = [
  "identity",
  "trait",
  "mood",
  "evolution",
] as const;
export type CharacterProfileReasonSubject =
  (typeof CHARACTER_PROFILE_REASON_SUBJECTS)[number];

/**
 * Provider-concentration reasons are intentionally absent: the daily sidecar
 * projection cannot attest to those traits, so the renderer must fail closed
 * if a future gateway accidentally exposes them.
 */
export const CHARACTER_PROFILE_REASON_CODES = [
  "IDENTITY_LEARNING_COVERAGE_28D",
  "IDENTITY_LEARNING_EVIDENCE_28D",
  "IDENTITY_READY_COVERAGE_28D",
  "IDENTITY_HELD_SAME_WINDOW",
  "IDENTITY_HELD_EVIDENCE_GRACE_7D",
  "IDENTITY_PROVISIONAL_DAILY_LIMIT",
  "TRAIT_CLI_FOCUS_28D",
  "TRAIT_TOOL_FOCUS_28D",
  "TRAIT_MULTI_TOOL_28D",
  "TRAIT_CACHE_SAVVY_28D",
  "TRAIT_OUTPUT_HEAVY_28D",
  "TRAIT_NIGHT_ORIENTED_LOCAL_28D",
  "TRAIT_HELD_SAME_WINDOW",
  "TRAIT_HELD_EVIDENCE_GRACE_7D",
  "TRAIT_HELD_DAILY_LIMIT",
  "MOOD_LEARNING_COVERAGE_28D",
  "MOOD_TODAY_UNAVAILABLE",
  "MOOD_RESTING_TODAY",
  "MOOD_RELATIVE_ACTIVITY_LOW",
  "MOOD_RELATIVE_ACTIVITY_STABLE",
  "MOOD_RELATIVE_ACTIVITY_HIGH",
  "EVOLUTION_AWAITING_COVERAGE",
  "EVOLUTION_INITIAL_PROFILE",
  "EVOLUTION_COVERAGE_COMPLETE",
  "EVOLUTION_IDENTITY_SHIFT",
  "EVOLUTION_WEEKLY_REVIEW",
  "EVOLUTION_NO_CHANGE",
] as const;
export type CharacterProfileReasonCode =
  (typeof CHARACTER_PROFILE_REASON_CODES)[number];

export const CHARACTER_PROFILE_TEMPLATE_IDS = [
  "monster.identity.learning.v1",
  "monster.identity.learningEvidence.v1",
  "monster.identity.ready.v1",
  "monster.identity.heldSameWindow.v1",
  "monster.identity.heldEvidenceGrace.v1",
  "monster.identity.provisionalDailyLimit.v1",
  "monster.trait.cliFocused.v1",
  "monster.trait.toolFocused.v1",
  "monster.trait.multiTool.v1",
  "monster.trait.cacheSavvy.v1",
  "monster.trait.outputHeavy.v1",
  "monster.trait.nightOriented.v1",
  "monster.trait.heldSameWindow.v1",
  "monster.trait.heldEvidenceGrace.v1",
  "monster.trait.heldDailyLimit.v1",
  "monster.mood.learning.v1",
  "monster.mood.unknown.v1",
  "monster.mood.resting.v1",
  "monster.mood.quiet.v1",
  "monster.mood.steady.v1",
  "monster.mood.lively.v1",
  "monster.evolution.awaitingCoverage.v1",
  "monster.evolution.initialProfile.v1",
  "monster.evolution.coverageComplete.v1",
  "monster.evolution.identityShift.v1",
  "monster.evolution.weeklyReview.v1",
  "monster.evolution.noChange.v1",
] as const;
export type CharacterProfileTemplateId =
  (typeof CHARACTER_PROFILE_TEMPLATE_IDS)[number];

export const CHARACTER_PROFILE_METRICS = [
  "observed-days",
  "active-days",
  "cli-share",
  "top-tool-share",
  "tool-diversity",
  "cache-observation",
  "cache-share",
  "output-share",
  "local-hour-coverage",
  "local-hour-quality",
  "local-night-share",
  "relative-daily-activity",
  "trait-structure",
] as const;
export type CharacterProfileMetric = (typeof CHARACTER_PROFILE_METRICS)[number];

export const CHARACTER_PROFILE_VALUE_BANDS = [
  "insufficient",
  "low",
  "medium",
  "high",
  "concentrated",
  "diverse",
  "balanced",
  "available",
  "unavailable",
  "inactive",
  "below-baseline",
  "near-baseline",
  "above-baseline",
  "initial",
  "changed",
  "stable",
  "held",
  "provisional",
] as const;
export type CharacterProfileValueBand =
  (typeof CHARACTER_PROFILE_VALUE_BANDS)[number];

export interface CharacterProfileReasonInput {
  readonly metric: CharacterProfileMetric;
  readonly valueBand: CharacterProfileValueBand;
  readonly coverage: CharacterProfileCoverageBand;
}

export interface CharacterProfileReason {
  readonly subject: CharacterProfileReasonSubject;
  readonly reasonCode: CharacterProfileReasonCode;
  readonly templateId: CharacterProfileTemplateId;
  readonly inputs: readonly CharacterProfileReasonInput[];
}

export interface CharacterProfileResponse {
  readonly status: "ok";
  readonly schemaVersion: "1";
  readonly generatedAt: string;
  readonly freshness: "fresh" | "stale";
  readonly dataQuality: "estimated-positive-days";
  readonly window: Readonly<{
    fromUtcDate: string;
    toUtcDate: string;
    timezone: "UTC";
  }>;
  readonly identity: Readonly<{
    status: "learning" | "ready";
    coverageBand: CharacterProfileCoverageBand;
    provisional: boolean;
    traitIds: readonly CharacterProfileTraitId[];
  }>;
  readonly mood: Readonly<{
    id: CharacterProfileMoodId;
    energyBand: CharacterProfileEnergyBand;
  }>;
  readonly evolution: Readonly<{
    cadence: CharacterProfileEvolutionCadence;
    event: CharacterProfileEvolutionEvent;
  }>;
  readonly reasons: readonly CharacterProfileReason[];
}

export interface CharacterUnlock {
  readonly key: string;
  readonly batchId: string;
  readonly kind: "character" | "theme";
  readonly characterId: CharacterId;
  readonly displayName: string;
  readonly themeId: CharacterThemeId | null;
  readonly summary?: Readonly<{
    readonly characterCount: number;
    readonly themeCount: number;
  }>;
}

export type CharacterConnectionState =
  "healthy" | "stale" | "refresh-failed" | "other";

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
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length &&
    [...expectedKeys].sort().every((key, index) => keys[index] === key)
  );
}

/** Strictly validates the local fixed-pack consent/status contract. */
export function parseCharacterAssetPackStatus(
  value: unknown,
): CharacterAssetPackStatus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "status",
      "phase",
      "consented",
      "enabled",
      "releaseId",
      "downloadBytes",
      "lastError",
    ]) ||
    value["status"] !== "ok" ||
    !CHARACTER_ASSET_PACK_PHASES.some(
      (candidate) => candidate === value["phase"],
    ) ||
    typeof value["consented"] !== "boolean" ||
    typeof value["enabled"] !== "boolean" ||
    !(
      value["lastError"] === null ||
      CHARACTER_ASSET_PACK_ERRORS.some(
        (candidate) => candidate === value["lastError"],
      )
    )
  ) {
    throw new TypeError("Invalid character asset pack response");
  }
  const phase = value["phase"] as CharacterAssetPackPhase;
  const consented = value["consented"];
  const enabled = value["enabled"];
  const lastError = value["lastError"] as CharacterAssetPackError | null;
  if (phase === "unavailable") {
    if (
      consented ||
      enabled ||
      value["releaseId"] !== null ||
      value["downloadBytes"] !== null ||
      lastError !== null
    ) {
      throw new TypeError("Invalid character asset pack response");
    }
  } else if (
    typeof value["releaseId"] !== "string" ||
    value["releaseId"].length > 120 ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(value["releaseId"]) ||
    typeof value["downloadBytes"] !== "number" ||
    !Number.isSafeInteger(value["downloadBytes"]) ||
    value["downloadBytes"] < 22 ||
    value["downloadBytes"] > 256 * 1_024 * 1_024 ||
    (phase === "installed" &&
      (!consented || !enabled || lastError !== null)) ||
    (phase === "available" && (consented || enabled)) ||
    (phase === "repair-needed" &&
      (enabled ||
        (!consented && lastError !== "cache-unavailable"))) ||
    (phase === "installing" && (enabled || lastError !== null))
  ) {
    throw new TypeError("Invalid character asset pack response");
  }
  return Object.freeze({
    status: "ok",
    phase,
    consented,
    enabled,
    releaseId: value["releaseId"] as string | null,
    downloadBytes: value["downloadBytes"] as number | null,
    lastError,
  });
}

function isQuotaFamily(value: unknown): value is QuotaFamily {
  return QUOTA_FAMILIES.some((family) => family === value);
}

/** Strictly validates the complete on-device quota estimate DTO. */
export function parseQuotaSnapshot(value: unknown): QuotaSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["status", "generatedAt", "families"]) ||
    value["status"] !== "ok" ||
    parseGeneratedAtWithMilliseconds(value["generatedAt"]) === undefined ||
    !Array.isArray(value["families"]) ||
    value["families"].length !== QUOTA_FAMILIES.length
  ) {
    throw new TypeError("Invalid quota response");
  }
  const families: QuotaFamilyEstimate[] = [];
  const seen = new Set<QuotaFamily>();
  for (const candidate of value["families"]) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, [
        "family",
        "planId",
        "windowHours",
        "windowKind",
        "usedTokens",
        "budgetTokens",
        "estimate",
      ]) ||
      !isQuotaFamily(candidate["family"]) ||
      seen.has(candidate["family"]) ||
      candidate["windowHours"] !== 24 ||
      candidate["windowKind"] !== "utc-day" ||
      !isSafeTokenCount(candidate["usedTokens"]) ||
      candidate["estimate"] !== true
    ) {
      throw new TypeError("Invalid quota response");
    }
    const family = candidate["family"];
    const planId = candidate["planId"];
    const budgetTokens = candidate["budgetTokens"];
    if (
      (planId !== null &&
        (typeof planId !== "string" ||
          !QUOTA_PLAN_OPTIONS[family].some(
            (plan) => plan.planId === planId,
          ))) ||
      (planId === null
        ? budgetTokens !== null
        : !isSafeTokenCount(budgetTokens) || budgetTokens === 0)
    ) {
      throw new TypeError("Invalid quota response");
    }
    seen.add(family);
    families.push(
      Object.freeze({
        family,
        planId,
        windowHours: 24,
        windowKind: "utc-day",
        usedTokens: candidate["usedTokens"],
        budgetTokens: budgetTokens as number | null,
        estimate: true,
      }),
    );
  }
  if (QUOTA_FAMILIES.some((family) => !seen.has(family))) {
    throw new TypeError("Invalid quota response");
  }
  return Object.freeze({
    status: "ok",
    generatedAt: value["generatedAt"] as string,
    families: Object.freeze(families),
  });
}

function isSafeTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
const CHARACTER_LINE_ID_PATTERN =
  /^(?:fixed-line\/1\.0\.0\/[a-z0-9-]+\/(?:zh-TW|en)\/[a-z0-9-]+\/(?:general|active|quiet)|tap-line\/1\.0\.0\/[a-z0-9-]+\/(?:zh-TW|en)\/(?:hello|observe|cheer))$/u;

export function isCharacterId(value: unknown): value is CharacterId {
  return CHARACTER_IDS.some((candidate) => candidate === value);
}

export function isCharacterThemeId(value: unknown): value is CharacterThemeId {
  return CHARACTER_THEME_IDS.some((candidate) => candidate === value);
}

function isCharacterLetterPatternId(
  value: unknown,
): value is CharacterLetterPatternId {
  return CHARACTER_LETTER_PATTERN_IDS.some((candidate) => candidate === value);
}

function isCharacterLetterAccentId(
  value: unknown,
): value is CharacterLetterAccentId {
  return CHARACTER_LETTER_ACCENT_IDS.some((candidate) => candidate === value);
}

function isShortText(value: unknown, maximumLength = 240): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

const CHARACTER_PROFILE_REASON_RULES = {
  IDENTITY_LEARNING_COVERAGE_28D: {
    subject: "identity",
    templateId: "monster.identity.learning.v1",
  },
  IDENTITY_LEARNING_EVIDENCE_28D: {
    subject: "identity",
    templateId: "monster.identity.learningEvidence.v1",
  },
  IDENTITY_READY_COVERAGE_28D: {
    subject: "identity",
    templateId: "monster.identity.ready.v1",
  },
  IDENTITY_HELD_SAME_WINDOW: {
    subject: "identity",
    templateId: "monster.identity.heldSameWindow.v1",
  },
  IDENTITY_HELD_EVIDENCE_GRACE_7D: {
    subject: "identity",
    templateId: "monster.identity.heldEvidenceGrace.v1",
  },
  IDENTITY_PROVISIONAL_DAILY_LIMIT: {
    subject: "identity",
    templateId: "monster.identity.provisionalDailyLimit.v1",
  },
  TRAIT_CLI_FOCUS_28D: {
    subject: "trait",
    templateId: "monster.trait.cliFocused.v1",
  },
  TRAIT_TOOL_FOCUS_28D: {
    subject: "trait",
    templateId: "monster.trait.toolFocused.v1",
  },
  TRAIT_MULTI_TOOL_28D: {
    subject: "trait",
    templateId: "monster.trait.multiTool.v1",
  },
  TRAIT_CACHE_SAVVY_28D: {
    subject: "trait",
    templateId: "monster.trait.cacheSavvy.v1",
  },
  TRAIT_OUTPUT_HEAVY_28D: {
    subject: "trait",
    templateId: "monster.trait.outputHeavy.v1",
  },
  TRAIT_NIGHT_ORIENTED_LOCAL_28D: {
    subject: "trait",
    templateId: "monster.trait.nightOriented.v1",
  },
  TRAIT_HELD_SAME_WINDOW: {
    subject: "trait",
    templateId: "monster.trait.heldSameWindow.v1",
  },
  TRAIT_HELD_EVIDENCE_GRACE_7D: {
    subject: "trait",
    templateId: "monster.trait.heldEvidenceGrace.v1",
  },
  TRAIT_HELD_DAILY_LIMIT: {
    subject: "trait",
    templateId: "monster.trait.heldDailyLimit.v1",
  },
  MOOD_LEARNING_COVERAGE_28D: {
    subject: "mood",
    templateId: "monster.mood.learning.v1",
  },
  MOOD_TODAY_UNAVAILABLE: {
    subject: "mood",
    templateId: "monster.mood.unknown.v1",
  },
  MOOD_RESTING_TODAY: {
    subject: "mood",
    templateId: "monster.mood.resting.v1",
  },
  MOOD_RELATIVE_ACTIVITY_LOW: {
    subject: "mood",
    templateId: "monster.mood.quiet.v1",
  },
  MOOD_RELATIVE_ACTIVITY_STABLE: {
    subject: "mood",
    templateId: "monster.mood.steady.v1",
  },
  MOOD_RELATIVE_ACTIVITY_HIGH: {
    subject: "mood",
    templateId: "monster.mood.lively.v1",
  },
  EVOLUTION_AWAITING_COVERAGE: {
    subject: "evolution",
    templateId: "monster.evolution.awaitingCoverage.v1",
  },
  EVOLUTION_INITIAL_PROFILE: {
    subject: "evolution",
    templateId: "monster.evolution.initialProfile.v1",
  },
  EVOLUTION_COVERAGE_COMPLETE: {
    subject: "evolution",
    templateId: "monster.evolution.coverageComplete.v1",
  },
  EVOLUTION_IDENTITY_SHIFT: {
    subject: "evolution",
    templateId: "monster.evolution.identityShift.v1",
  },
  EVOLUTION_WEEKLY_REVIEW: {
    subject: "evolution",
    templateId: "monster.evolution.weeklyReview.v1",
  },
  EVOLUTION_NO_CHANGE: {
    subject: "evolution",
    templateId: "monster.evolution.noChange.v1",
  },
} as const satisfies Readonly<
  Record<
    CharacterProfileReasonCode,
    Readonly<{
      subject: CharacterProfileReasonSubject;
      templateId: CharacterProfileTemplateId;
    }>
  >
>;

type CharacterProfileReasonVisibleValue =
  | CharacterProfileTraitId
  | CharacterProfileMoodId
  | CharacterProfileEvolutionEvent
  | "learning"
  | "ready";

const CHARACTER_PROFILE_REASON_VISIBLE_VALUES = {
  IDENTITY_LEARNING_COVERAGE_28D: ["learning"],
  IDENTITY_LEARNING_EVIDENCE_28D: ["learning"],
  IDENTITY_READY_COVERAGE_28D: ["ready"],
  IDENTITY_HELD_SAME_WINDOW: ["learning", "ready"],
  IDENTITY_HELD_EVIDENCE_GRACE_7D: ["ready"],
  IDENTITY_PROVISIONAL_DAILY_LIMIT: ["ready"],
  TRAIT_CLI_FOCUS_28D: ["cli-focused"],
  TRAIT_TOOL_FOCUS_28D: ["tool-focused"],
  TRAIT_MULTI_TOOL_28D: ["multi-tool"],
  TRAIT_CACHE_SAVVY_28D: ["cache-savvy"],
  TRAIT_OUTPUT_HEAVY_28D: ["output-heavy"],
  TRAIT_NIGHT_ORIENTED_LOCAL_28D: ["night-oriented"],
  TRAIT_HELD_SAME_WINDOW: CHARACTER_PROFILE_TRAIT_IDS,
  TRAIT_HELD_EVIDENCE_GRACE_7D: CHARACTER_PROFILE_TRAIT_IDS,
  TRAIT_HELD_DAILY_LIMIT: CHARACTER_PROFILE_TRAIT_IDS,
  MOOD_LEARNING_COVERAGE_28D: ["learning"],
  MOOD_TODAY_UNAVAILABLE: ["unknown"],
  MOOD_RESTING_TODAY: ["resting"],
  MOOD_RELATIVE_ACTIVITY_LOW: ["quiet"],
  MOOD_RELATIVE_ACTIVITY_STABLE: ["steady"],
  MOOD_RELATIVE_ACTIVITY_HIGH: ["lively"],
  EVOLUTION_AWAITING_COVERAGE: ["awaiting-coverage"],
  EVOLUTION_INITIAL_PROFILE: ["initial-profile"],
  EVOLUTION_COVERAGE_COMPLETE: ["coverage-complete"],
  EVOLUTION_IDENTITY_SHIFT: ["identity-shift"],
  EVOLUTION_WEEKLY_REVIEW: ["weekly-review"],
  EVOLUTION_NO_CHANGE: ["no-change"],
} as const satisfies Readonly<
  Record<
    CharacterProfileReasonCode,
    readonly CharacterProfileReasonVisibleValue[]
  >
>;

const CHARACTER_PROFILE_ENERGY_BY_MOOD = {
  learning: "dormant",
  unknown: "dormant",
  resting: "dormant",
  quiet: "low",
  steady: "medium",
  lively: "high",
} as const satisfies Readonly<
  Record<CharacterProfileMoodId, CharacterProfileEnergyBand>
>;

const CHARACTER_PROFILE_HELD_TRAIT_REASONS: ReadonlySet<CharacterProfileReasonCode> =
  new Set([
    "TRAIT_HELD_SAME_WINDOW",
    "TRAIT_HELD_EVIDENCE_GRACE_7D",
    "TRAIT_HELD_DAILY_LIMIT",
  ]);

const CHARACTER_PROFILE_IDENTITY_REASONS_REQUIRING_PROVISIONAL: ReadonlySet<CharacterProfileReasonCode> =
  new Set([
    "IDENTITY_HELD_EVIDENCE_GRACE_7D",
    "IDENTITY_PROVISIONAL_DAILY_LIMIT",
  ]);

const CHARACTER_PROFILE_IDENTITY_REASONS_FORBIDDING_PROVISIONAL: ReadonlySet<CharacterProfileReasonCode> =
  new Set([
    "IDENTITY_LEARNING_COVERAGE_28D",
    "IDENTITY_LEARNING_EVIDENCE_28D",
    "IDENTITY_READY_COVERAGE_28D",
  ]);

interface CharacterProfileReasonInputRule {
  readonly metric: CharacterProfileMetric;
  readonly allowedBands: readonly (readonly [
    CharacterProfileValueBand,
    CharacterProfileCoverageBand,
  ])[];
}

const PROFILE_ANY_COVERAGE = [
  "insufficient",
  "partial",
  "good",
  "full",
] as const satisfies readonly CharacterProfileCoverageBand[];
const PROFILE_READY_COVERAGE = [
  "partial",
  "good",
  "full",
] as const satisfies readonly CharacterProfileCoverageBand[];

function profileAllowedInputBands(
  valueBand: CharacterProfileValueBand,
  coverageBands: readonly CharacterProfileCoverageBand[],
): readonly (readonly [
  CharacterProfileValueBand,
  CharacterProfileCoverageBand,
])[] {
  return coverageBands.map(
    (coverageBand) => [valueBand, coverageBand] as const,
  );
}

const PROFILE_INSUFFICIENT_INPUT = profileAllowedInputBands("insufficient", [
  "insufficient",
]);
const PROFILE_AVAILABLE_READY_INPUT = profileAllowedInputBands(
  "available",
  PROFILE_READY_COVERAGE,
);
const PROFILE_AVAILABLE_OR_INSUFFICIENT_INPUT = [
  ...PROFILE_INSUFFICIENT_INPUT,
  ...PROFILE_AVAILABLE_READY_INPUT,
] as const;

const CHARACTER_PROFILE_REASON_INPUT_RULES = {
  IDENTITY_LEARNING_COVERAGE_28D: {
    inputs: [
      { metric: "observed-days", allowedBands: PROFILE_INSUFFICIENT_INPUT },
      { metric: "active-days", allowedBands: PROFILE_INSUFFICIENT_INPUT },
    ],
    equalCoverageGroups: [[0, 1]],
  },
  IDENTITY_LEARNING_EVIDENCE_28D: {
    inputs: [
      { metric: "observed-days", allowedBands: PROFILE_AVAILABLE_READY_INPUT },
      { metric: "active-days", allowedBands: PROFILE_AVAILABLE_READY_INPUT },
      {
        metric: "trait-structure",
        allowedBands: profileAllowedInputBands("unavailable", ["insufficient"]),
      },
    ],
    equalCoverageGroups: [[0, 1]],
  },
  IDENTITY_READY_COVERAGE_28D: {
    inputs: [
      { metric: "observed-days", allowedBands: PROFILE_AVAILABLE_READY_INPUT },
      { metric: "active-days", allowedBands: PROFILE_AVAILABLE_READY_INPUT },
    ],
    equalCoverageGroups: [[0, 1]],
  },
  IDENTITY_HELD_SAME_WINDOW: {
    inputs: [
      { metric: "observed-days", allowedBands: PROFILE_AVAILABLE_READY_INPUT },
      { metric: "active-days", allowedBands: PROFILE_AVAILABLE_READY_INPUT },
      {
        metric: "trait-structure",
        allowedBands: profileAllowedInputBands("held", PROFILE_ANY_COVERAGE),
      },
    ],
    equalCoverageGroups: [[0, 1]],
  },
  IDENTITY_HELD_EVIDENCE_GRACE_7D: {
    inputs: [
      {
        metric: "observed-days",
        allowedBands: PROFILE_AVAILABLE_OR_INSUFFICIENT_INPUT,
      },
      {
        metric: "active-days",
        allowedBands: PROFILE_AVAILABLE_OR_INSUFFICIENT_INPUT,
      },
      {
        metric: "trait-structure",
        allowedBands: profileAllowedInputBands("held", PROFILE_ANY_COVERAGE),
      },
    ],
    equalCoverageGroups: [[0, 1, 2]],
  },
  IDENTITY_PROVISIONAL_DAILY_LIMIT: {
    inputs: [
      { metric: "observed-days", allowedBands: PROFILE_AVAILABLE_READY_INPUT },
      { metric: "active-days", allowedBands: PROFILE_AVAILABLE_READY_INPUT },
      {
        metric: "trait-structure",
        allowedBands: profileAllowedInputBands(
          "provisional",
          PROFILE_READY_COVERAGE,
        ),
      },
    ],
    equalCoverageGroups: [[0, 1, 2]],
  },
  TRAIT_CLI_FOCUS_28D: {
    inputs: [
      {
        metric: "cli-share",
        allowedBands: profileAllowedInputBands("high", PROFILE_READY_COVERAGE),
      },
    ],
  },
  TRAIT_TOOL_FOCUS_28D: {
    inputs: [
      {
        metric: "top-tool-share",
        allowedBands: [
          ...profileAllowedInputBands("high", PROFILE_READY_COVERAGE),
          ...profileAllowedInputBands("concentrated", PROFILE_READY_COVERAGE),
        ],
      },
    ],
  },
  TRAIT_MULTI_TOOL_28D: {
    inputs: [
      {
        metric: "tool-diversity",
        allowedBands: profileAllowedInputBands(
          "diverse",
          PROFILE_READY_COVERAGE,
        ),
      },
    ],
  },
  TRAIT_CACHE_SAVVY_28D: {
    inputs: [
      {
        metric: "cache-share",
        allowedBands: profileAllowedInputBands("high", PROFILE_READY_COVERAGE),
      },
      {
        metric: "cache-observation",
        allowedBands: PROFILE_AVAILABLE_READY_INPUT,
      },
    ],
    equalCoverageGroups: [[0, 1]],
  },
  TRAIT_OUTPUT_HEAVY_28D: {
    inputs: [
      {
        metric: "output-share",
        allowedBands: profileAllowedInputBands("high", PROFILE_READY_COVERAGE),
      },
    ],
  },
  TRAIT_NIGHT_ORIENTED_LOCAL_28D: {
    inputs: [
      {
        metric: "local-night-share",
        allowedBands: profileAllowedInputBands("high", PROFILE_READY_COVERAGE),
      },
      {
        metric: "local-hour-coverage",
        allowedBands: PROFILE_AVAILABLE_READY_INPUT,
      },
      {
        metric: "local-hour-quality",
        allowedBands: PROFILE_AVAILABLE_READY_INPUT,
      },
    ],
    equalCoverageGroups: [[0, 1, 2]],
  },
  TRAIT_HELD_SAME_WINDOW: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: profileAllowedInputBands("held", PROFILE_READY_COVERAGE),
      },
    ],
  },
  TRAIT_HELD_EVIDENCE_GRACE_7D: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: profileAllowedInputBands("held", PROFILE_ANY_COVERAGE),
      },
    ],
  },
  TRAIT_HELD_DAILY_LIMIT: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: profileAllowedInputBands(
          "provisional",
          PROFILE_READY_COVERAGE,
        ),
      },
    ],
  },
  MOOD_LEARNING_COVERAGE_28D: {
    inputs: [
      {
        metric: "relative-daily-activity",
        allowedBands: PROFILE_INSUFFICIENT_INPUT,
      },
    ],
  },
  MOOD_TODAY_UNAVAILABLE: {
    inputs: [
      {
        metric: "relative-daily-activity",
        allowedBands: profileAllowedInputBands(
          "unavailable",
          PROFILE_ANY_COVERAGE,
        ),
      },
    ],
  },
  MOOD_RESTING_TODAY: {
    inputs: [
      {
        metric: "relative-daily-activity",
        allowedBands: profileAllowedInputBands(
          "inactive",
          PROFILE_ANY_COVERAGE,
        ),
      },
    ],
  },
  MOOD_RELATIVE_ACTIVITY_LOW: {
    inputs: [
      {
        metric: "relative-daily-activity",
        allowedBands: profileAllowedInputBands(
          "below-baseline",
          PROFILE_ANY_COVERAGE,
        ),
      },
    ],
  },
  MOOD_RELATIVE_ACTIVITY_STABLE: {
    inputs: [
      {
        metric: "relative-daily-activity",
        allowedBands: profileAllowedInputBands(
          "near-baseline",
          PROFILE_ANY_COVERAGE,
        ),
      },
    ],
  },
  MOOD_RELATIVE_ACTIVITY_HIGH: {
    inputs: [
      {
        metric: "relative-daily-activity",
        allowedBands: profileAllowedInputBands(
          "above-baseline",
          PROFILE_ANY_COVERAGE,
        ),
      },
    ],
  },
  EVOLUTION_AWAITING_COVERAGE: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: PROFILE_INSUFFICIENT_INPUT,
      },
    ],
  },
  EVOLUTION_INITIAL_PROFILE: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: profileAllowedInputBands(
          "initial",
          PROFILE_READY_COVERAGE,
        ),
      },
    ],
  },
  EVOLUTION_COVERAGE_COMPLETE: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: profileAllowedInputBands(
          "changed",
          PROFILE_READY_COVERAGE,
        ),
      },
    ],
  },
  EVOLUTION_IDENTITY_SHIFT: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: profileAllowedInputBands(
          "changed",
          PROFILE_READY_COVERAGE,
        ),
      },
    ],
  },
  EVOLUTION_WEEKLY_REVIEW: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: profileAllowedInputBands(
          "stable",
          PROFILE_READY_COVERAGE,
        ),
      },
    ],
  },
  EVOLUTION_NO_CHANGE: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: [
          ...profileAllowedInputBands("held", PROFILE_ANY_COVERAGE),
          ...profileAllowedInputBands("stable", PROFILE_ANY_COVERAGE),
        ],
      },
    ],
  },
} as const satisfies Readonly<
  Record<
    CharacterProfileReasonCode,
    Readonly<{
      inputs: readonly CharacterProfileReasonInputRule[];
      equalCoverageGroups?: readonly (readonly number[])[];
    }>
  >
>;

function isAllowlistedProfileValue<T extends string>(
  value: unknown,
  allowlist: readonly T[],
): value is T {
  return (
    typeof value === "string" &&
    allowlist.some((candidate) => candidate === value)
  );
}

function parseCharacterProfileReasonInput(
  value: unknown,
): CharacterProfileReasonInput | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["metric", "valueBand", "coverage"]) ||
    !isAllowlistedProfileValue(value["metric"], CHARACTER_PROFILE_METRICS) ||
    !isAllowlistedProfileValue(
      value["valueBand"],
      CHARACTER_PROFILE_VALUE_BANDS,
    ) ||
    !isAllowlistedProfileValue(
      value["coverage"],
      CHARACTER_PROFILE_COVERAGE_BANDS,
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    metric: value["metric"],
    valueBand: value["valueBand"],
    coverage: value["coverage"],
  });
}

function parseCharacterProfileReason(
  value: unknown,
): CharacterProfileReason | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["subject", "reasonCode", "templateId", "inputs"]) ||
    !isAllowlistedProfileValue(
      value["reasonCode"],
      CHARACTER_PROFILE_REASON_CODES,
    ) ||
    !Array.isArray(value["inputs"]) ||
    value["inputs"].length < 1 ||
    value["inputs"].length > 3
  ) {
    return undefined;
  }
  const rule = CHARACTER_PROFILE_REASON_RULES[value["reasonCode"]];
  if (
    value["subject"] !== rule.subject ||
    value["templateId"] !== rule.templateId
  ) {
    return undefined;
  }
  const inputs: CharacterProfileReasonInput[] = [];
  for (const candidate of value["inputs"]) {
    const input = parseCharacterProfileReasonInput(candidate);
    if (input === undefined) return undefined;
    inputs.push(input);
  }
  const inputRule = CHARACTER_PROFILE_REASON_INPUT_RULES[value["reasonCode"]];
  if (inputs.length !== inputRule.inputs.length) return undefined;
  for (const [index, input] of inputs.entries()) {
    const expected = inputRule.inputs[index]!;
    if (
      input.metric !== expected.metric ||
      !expected.allowedBands.some(
        ([valueBand, coverageBand]) =>
          input.valueBand === valueBand && input.coverage === coverageBand,
      )
    ) {
      return undefined;
    }
  }
  if ("equalCoverageGroups" in inputRule) {
    for (const group of inputRule.equalCoverageGroups) {
      const coverage = inputs[group[0]!]?.coverage;
      if (
        coverage === undefined ||
        group.some((index) => inputs[index]?.coverage !== coverage)
      ) {
        return undefined;
      }
    }
  }
  return Object.freeze({
    subject: rule.subject,
    reasonCode: value["reasonCode"],
    templateId: rule.templateId,
    inputs: Object.freeze(inputs),
  });
}

function expectedEvolutionCadence(
  event: CharacterProfileEvolutionEvent,
): CharacterProfileEvolutionCadence {
  if (event === "weekly-review") return "weekly";
  return event === "no-change" ? "none" : "event";
}

/** Strictly validates the complete, content-blind local character profile. */
export function parseCharacterProfileResponse(
  value: unknown,
): CharacterProfileResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "status",
      "schemaVersion",
      "generatedAt",
      "freshness",
      "dataQuality",
      "window",
      "identity",
      "mood",
      "evolution",
      "reasons",
    ]) ||
    value["status"] !== "ok" ||
    value["schemaVersion"] !== "1" ||
    parseGeneratedAtWithMilliseconds(value["generatedAt"]) === undefined ||
    (value["freshness"] !== "fresh" && value["freshness"] !== "stale") ||
    value["dataQuality"] !== "estimated-positive-days" ||
    !isRecord(value["window"]) ||
    !hasExactKeys(value["window"], ["fromUtcDate", "toUtcDate", "timezone"]) ||
    value["window"]["timezone"] !== "UTC" ||
    parseUtcDate(value["window"]["fromUtcDate"]) === undefined ||
    parseUtcDate(value["window"]["toUtcDate"]) === undefined ||
    !isRecord(value["identity"]) ||
    !hasExactKeys(value["identity"], [
      "status",
      "coverageBand",
      "provisional",
      "traitIds",
    ]) ||
    (value["identity"]["status"] !== "learning" &&
      value["identity"]["status"] !== "ready") ||
    !isAllowlistedProfileValue(
      value["identity"]["coverageBand"],
      CHARACTER_PROFILE_COVERAGE_BANDS,
    ) ||
    typeof value["identity"]["provisional"] !== "boolean" ||
    !Array.isArray(value["identity"]["traitIds"]) ||
    value["identity"]["traitIds"].length > 3 ||
    !isRecord(value["mood"]) ||
    !hasExactKeys(value["mood"], ["id", "energyBand"]) ||
    !isAllowlistedProfileValue(
      value["mood"]["id"],
      CHARACTER_PROFILE_MOOD_IDS,
    ) ||
    !isAllowlistedProfileValue(
      value["mood"]["energyBand"],
      CHARACTER_PROFILE_ENERGY_BANDS,
    ) ||
    !isRecord(value["evolution"]) ||
    !hasExactKeys(value["evolution"], ["cadence", "event"]) ||
    !isAllowlistedProfileValue(
      value["evolution"]["cadence"],
      CHARACTER_PROFILE_EVOLUTION_CADENCES,
    ) ||
    !isAllowlistedProfileValue(
      value["evolution"]["event"],
      CHARACTER_PROFILE_EVOLUTION_EVENTS,
    ) ||
    !Array.isArray(value["reasons"]) ||
    value["reasons"].length < 3 ||
    value["reasons"].length > 6
  ) {
    throw new TypeError("Invalid character profile response");
  }

  const fromUtcDate = value["window"]["fromUtcDate"] as string;
  const toUtcDate = value["window"]["toUtcDate"] as string;
  if (
    Date.parse(`${toUtcDate}T00:00:00.000Z`) -
      Date.parse(`${fromUtcDate}T00:00:00.000Z`) !==
    27 * 86_400_000
  ) {
    throw new TypeError("Invalid character profile response");
  }

  const traitIds: CharacterProfileTraitId[] = [];
  const seenTraitIds = new Set<CharacterProfileTraitId>();
  for (const candidate of value["identity"]["traitIds"]) {
    if (
      !isAllowlistedProfileValue(candidate, CHARACTER_PROFILE_TRAIT_IDS) ||
      seenTraitIds.has(candidate)
    ) {
      throw new TypeError("Invalid character profile response");
    }
    seenTraitIds.add(candidate);
    traitIds.push(candidate);
  }
  if (
    value["identity"]["status"] === "learning" &&
    (traitIds.length !== 0 ||
      value["identity"]["coverageBand"] !== "insufficient" ||
      value["mood"]["id"] !== "learning" ||
      value["mood"]["energyBand"] !== "dormant" ||
      value["evolution"]["event"] !== "awaiting-coverage")
  ) {
    throw new TypeError("Invalid character profile response");
  }
  if (value["identity"]["status"] === "ready" && traitIds.length < 1) {
    throw new TypeError("Invalid character profile response");
  }
  if (
    value["mood"]["energyBand"] !==
    CHARACTER_PROFILE_ENERGY_BY_MOOD[value["mood"]["id"]]
  ) {
    throw new TypeError("Invalid character profile response");
  }
  if (
    value["evolution"]["cadence"] !==
    expectedEvolutionCadence(value["evolution"]["event"])
  ) {
    throw new TypeError("Invalid character profile response");
  }

  const reasons: CharacterProfileReason[] = [];
  for (const candidate of value["reasons"]) {
    const reason = parseCharacterProfileReason(candidate);
    if (reason === undefined) {
      throw new TypeError("Invalid character profile response");
    }
    reasons.push(reason);
  }
  const subjectCount = (subject: CharacterProfileReasonSubject): number =>
    reasons.filter((reason) => reason.subject === subject).length;
  if (
    reasons.length !== traitIds.length + 3 ||
    subjectCount("identity") !== 1 ||
    subjectCount("trait") !== traitIds.length ||
    subjectCount("mood") !== 1 ||
    subjectCount("evolution") !== 1
  ) {
    throw new TypeError("Invalid character profile response");
  }

  const reasonForSubject = (
    subject: Exclude<CharacterProfileReasonSubject, "trait">,
  ): CharacterProfileReason =>
    reasons.find((reason) => reason.subject === subject)!;
  const identityReason = reasonForSubject("identity");
  const moodReason = reasonForSubject("mood");
  const evolutionReason = reasonForSubject("evolution");
  if (
    !(
      CHARACTER_PROFILE_REASON_VISIBLE_VALUES[
        identityReason.reasonCode
      ] as readonly CharacterProfileReasonVisibleValue[]
    ).includes(value["identity"]["status"]) ||
    !(
      CHARACTER_PROFILE_REASON_VISIBLE_VALUES[
        moodReason.reasonCode
      ] as readonly CharacterProfileReasonVisibleValue[]
    ).includes(value["mood"]["id"]) ||
    !(
      CHARACTER_PROFILE_REASON_VISIBLE_VALUES[
        evolutionReason.reasonCode
      ] as readonly CharacterProfileReasonVisibleValue[]
    ).includes(value["evolution"]["event"])
  ) {
    throw new TypeError("Invalid character profile response");
  }

  if (
    (value["identity"]["status"] === "ready" &&
      identityReason.inputs[0]?.coverage !==
        value["identity"]["coverageBand"]) ||
    (CHARACTER_PROFILE_IDENTITY_REASONS_REQUIRING_PROVISIONAL.has(
      identityReason.reasonCode,
    ) &&
      value["identity"]["provisional"] !== true) ||
    (CHARACTER_PROFILE_IDENTITY_REASONS_FORBIDDING_PROVISIONAL.has(
      identityReason.reasonCode,
    ) &&
      value["identity"]["provisional"] !== false)
  ) {
    throw new TypeError("Invalid character profile response");
  }

  if (
    identityReason.reasonCode === "IDENTITY_HELD_SAME_WINDOW" &&
    identityReason.inputs[2]?.coverage !==
      (value["identity"]["status"] === "ready"
        ? identityReason.inputs[0]?.coverage
        : "insufficient")
  ) {
    throw new TypeError("Invalid character profile response");
  }
  const evidenceGraceActive =
    identityReason.reasonCode === "IDENTITY_HELD_EVIDENCE_GRACE_7D";
  const evidenceGraceTraitReasons = reasons.filter(
    (reason) => reason.reasonCode === "TRAIT_HELD_EVIDENCE_GRACE_7D",
  ).length;
  if (
    (evidenceGraceActive &&
      (value["identity"]["provisional"] !== true ||
        evidenceGraceTraitReasons !== traitIds.length)) ||
    (!evidenceGraceActive && evidenceGraceTraitReasons !== 0)
  ) {
    throw new TypeError("Invalid character profile response");
  }

  const unmatchedTraitIds = new Set(traitIds);
  const heldTraitReasons: CharacterProfileReason[] = [];
  for (const reason of reasons.filter(
    (candidate) => candidate.subject === "trait",
  )) {
    if (CHARACTER_PROFILE_HELD_TRAIT_REASONS.has(reason.reasonCode)) {
      heldTraitReasons.push(reason);
      continue;
    }
    const matchingTraitId = traitIds.find(
      (traitId) =>
        unmatchedTraitIds.has(traitId) &&
        (
          CHARACTER_PROFILE_REASON_VISIBLE_VALUES[
            reason.reasonCode
          ] as readonly CharacterProfileReasonVisibleValue[]
        ).includes(traitId),
    );
    if (matchingTraitId === undefined) {
      throw new TypeError("Invalid character profile response");
    }
    unmatchedTraitIds.delete(matchingTraitId);
  }
  if (heldTraitReasons.length !== unmatchedTraitIds.size) {
    throw new TypeError("Invalid character profile response");
  }

  return Object.freeze({
    status: "ok",
    schemaVersion: "1",
    generatedAt: value["generatedAt"] as string,
    freshness: value["freshness"],
    dataQuality: "estimated-positive-days",
    window: Object.freeze({ fromUtcDate, toUtcDate, timezone: "UTC" }),
    identity: Object.freeze({
      status: value["identity"]["status"],
      coverageBand: value["identity"]["coverageBand"],
      provisional: value["identity"]["provisional"],
      traitIds: Object.freeze(traitIds),
    }),
    mood: Object.freeze({
      id: value["mood"]["id"],
      energyBand: value["mood"]["energyBand"],
    }),
    evolution: Object.freeze({
      cadence: value["evolution"]["cadence"],
      event: value["evolution"]["event"],
    }),
    reasons: Object.freeze(reasons),
  });
}

/** Strictly validates the bounded response returned by the local tap route. */
export function parseCharacterInteractionResponse(
  value: unknown,
): CharacterInteractionResponse {
  if (
    !isRecord(value) ||
    value["status"] !== "ok" ||
    (value["action"] !== "tap" && value["action"] !== "idle") ||
    !isCharacterId(value["characterId"]) ||
    (value["locale"] !== "zh-TW" && value["locale"] !== "en")
  ) {
    throw new TypeError("Invalid character interaction response");
  }

  const action = value["action"];
  const characterId = value["characterId"];
  const locale = value["locale"];
  if (value["outcome"] === "line") {
    const line = value["line"];
    const cooldownMs = value["cooldownMs"];
    if (
      !hasExactKeys(value, [
        "status",
        "action",
        "characterId",
        "locale",
        "outcome",
        "line",
        "cooldownMs",
      ]) ||
      !isRecord(line) ||
      !hasExactKeys(line, ["lineId", "text"]) ||
      typeof line["lineId"] !== "string" ||
      !CHARACTER_LINE_ID_PATTERN.test(line["lineId"]) ||
      !isShortText(line["text"]) ||
      !Number.isSafeInteger(cooldownMs) ||
      (cooldownMs as number) < 1 ||
      (cooldownMs as number) > 60_000
    ) {
      throw new TypeError("Invalid character interaction response");
    }
    return Object.freeze({
      status: "ok",
      action,
      characterId,
      locale,
      outcome: "line",
      line: Object.freeze({ lineId: line["lineId"], text: line["text"] }),
      cooldownMs: cooldownMs as number,
    });
  }

  const retryAfterMs = value["retryAfterMs"];
  if (
    value["outcome"] !== "animation-only" ||
    !hasExactKeys(value, [
      "status",
      "action",
      "characterId",
      "locale",
      "outcome",
      "retryAfterMs",
    ]) ||
    !Number.isSafeInteger(retryAfterMs) ||
    (retryAfterMs as number) < 1 ||
    (retryAfterMs as number) > 86_400_000
  ) {
    throw new TypeError("Invalid character interaction response");
  }
  return Object.freeze({
    status: "ok",
    action,
    characterId,
    locale,
    outcome: "animation-only",
    retryAfterMs: retryAfterMs as number,
  });
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
    posePaths,
  });
}

function parseCharacterLetterTheme(
  value: unknown,
): CharacterLetterTheme | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "themeId",
      "displayName",
      "accessibleLabel",
      "unlocked",
      "palette",
      "pattern",
      "accent",
    ]) ||
    !isCharacterThemeId(value["themeId"]) ||
    !isShortText(value["displayName"], 40) ||
    !isShortText(value["accessibleLabel"], 120) ||
    typeof value["unlocked"] !== "boolean" ||
    !isRecord(value["palette"]) ||
    !hasExactKeys(value["palette"], ["background", "foreground", "accent"]) ||
    typeof value["palette"]["background"] !== "string" ||
    !CSS_COLOR_PATTERN.test(value["palette"]["background"]) ||
    typeof value["palette"]["foreground"] !== "string" ||
    !CSS_COLOR_PATTERN.test(value["palette"]["foreground"]) ||
    typeof value["palette"]["accent"] !== "string" ||
    !CSS_COLOR_PATTERN.test(value["palette"]["accent"]) ||
    !isRecord(value["pattern"]) ||
    !hasExactKeys(value["pattern"], ["id", "label", "density"]) ||
    !isCharacterLetterPatternId(value["pattern"]["id"]) ||
    !isShortText(value["pattern"]["label"], 60) ||
    (value["pattern"]["density"] !== "light" &&
      value["pattern"]["density"] !== "medium" &&
      value["pattern"]["density"] !== "bold") ||
    !isRecord(value["accent"]) ||
    !hasExactKeys(value["accent"], ["id", "label", "placement"]) ||
    !isCharacterLetterAccentId(value["accent"]["id"]) ||
    !isShortText(value["accent"]["label"], 60) ||
    (value["accent"]["placement"] !== "top-left" &&
      value["accent"]["placement"] !== "top-right" &&
      value["accent"]["placement"] !== "bottom-left" &&
      value["accent"]["placement"] !== "bottom-right")
  ) {
    return undefined;
  }
  return Object.freeze({
    themeId: value["themeId"],
    displayName: value["displayName"],
    accessibleLabel: value["accessibleLabel"],
    unlocked: value["unlocked"],
    palette: Object.freeze({
      background: value["palette"]["background"],
      foreground: value["palette"]["foreground"],
      accent: value["palette"]["accent"],
    }),
    pattern: Object.freeze({
      id: value["pattern"]["id"],
      label: value["pattern"]["label"],
      density: value["pattern"]["density"],
    }),
    accent: Object.freeze({
      id: value["accent"]["id"],
      label: value["accent"]["label"],
      placement: value["accent"]["placement"],
    }),
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
        "accent",
        "themes",
      ]) ||
      typeof value["glyph"] !== "string" ||
      [...value["glyph"]].length !== 1 ||
      typeof value["background"] !== "string" ||
      !CSS_COLOR_PATTERN.test(value["background"]) ||
      typeof value["foreground"] !== "string" ||
      !CSS_COLOR_PATTERN.test(value["foreground"]) ||
      typeof value["accent"] !== "string" ||
      !CSS_COLOR_PATTERN.test(value["accent"]) ||
      !Array.isArray(value["themes"]) ||
      value["themes"].length < 1 ||
      value["themes"].length > CHARACTER_THEME_IDS.length
    ) {
      return undefined;
    }
    const themes: CharacterLetterTheme[] = [];
    const themeIds = new Set<CharacterThemeId>();
    for (const candidate of value["themes"]) {
      const theme = parseCharacterLetterTheme(candidate);
      if (theme === undefined || themeIds.has(theme.themeId)) return undefined;
      themeIds.add(theme.themeId);
      themes.push(theme);
    }
    return Object.freeze({
      mode: "letter",
      glyph: value["glyph"],
      background: value["background"],
      foreground: value["foreground"],
      accent: value["accent"],
      themes: Object.freeze(themes),
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
    themes: Object.freeze(themes),
  });
}

function parseCharacterProgress(
  value: unknown,
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
    explain: value["explain"],
  });
}

function parseCharacterStarterPersona(
  value: unknown,
): CharacterStarterPersona | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["alias", "taglineZhTw"]) ||
    !isShortText(value["alias"], 40) ||
    value["alias"].trim() !== value["alias"] ||
    !isShortText(value["taglineZhTw"], 120) ||
    value["taglineZhTw"].trim() !== value["taglineZhTw"]
  ) {
    return undefined;
  }
  return Object.freeze({
    alias: value["alias"],
    taglineZhTw: value["taglineZhTw"],
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
    durationMs: value["durationMs"] as number,
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
      "starterPersona",
      "activeThemeId",
      "visual",
      "progress",
      "voiceLines",
    ])
  ) {
    return undefined;
  }
  const characterId = value["characterId"];
  const unlockedAt = value["unlockedAt"];
  const activeThemeId = value["activeThemeId"];
  const starterPersona = parseCharacterStarterPersona(
    value["starterPersona"],
  );
  const visual = parseCharacterVisual(value["visual"]);
  const progress = parseCharacterProgress(value["progress"]);
  if (
    !isCharacterId(characterId) ||
    !isShortText(value["displayName"], 80) ||
    (value["kind"] !== "sister" && value["kind"] !== "friend") ||
    typeof value["unlocked"] !== "boolean" ||
    (unlockedAt !== null && parseGeneratedAt(unlockedAt) === undefined) ||
    typeof value["isStarter"] !== "boolean" ||
    value["isStarter"] !== (value["kind"] === "sister") ||
    starterPersona === undefined ||
    (value["isStarter"] !== (starterPersona !== null)) ||
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
    activeThemeId !== null &&
    !visual.themes.some(
      (theme) => theme.themeId === activeThemeId && theme.unlocked,
    )
  ) {
    return undefined;
  }
  if (visual.mode === "letter" && activeThemeId !== null) {
    const activeTheme = visual.themes.find(
      (theme) => theme.themeId === activeThemeId,
    );
    if (
      activeTheme === undefined ||
      visual.background !== activeTheme.palette.background ||
      visual.foreground !== activeTheme.palette.foreground ||
      visual.accent !== activeTheme.palette.accent
    ) {
      return undefined;
    }
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
    starterPersona,
    activeThemeId: activeThemeId as CharacterThemeId | null,
    visual,
    progress,
    voiceLines: Object.freeze(voiceLines),
  });
}

/** Strictly validates the complete character roster DTO. */
export function parseCharactersSnapshot(value: unknown): CharactersSnapshot {
  const responseKeys = [
    "status",
    "generatedAt",
    "selection",
    "voiceEnabled",
    "characters",
  ] as const;
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, responseKeys) &&
      !hasExactKeys(value, [...responseKeys, "unlockBatchId"])) ||
    value["status"] !== "ok" ||
    parseGeneratedAtWithMilliseconds(value["generatedAt"]) === undefined ||
    ("unlockBatchId" in value &&
      value["unlockBatchId"] !== null &&
      parseGeneratedAt(value["unlockBatchId"]) === undefined) ||
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
    (selectedCharacterId === null) !== (selectedBy === null)
  ) {
    throw new TypeError("Invalid characters response");
  }
  const characters: CharacterRosterEntry[] = [];
  const characterIds = new Set<CharacterId>();
  for (const candidate of value["characters"]) {
    const character = parseRosterEntry(candidate);
    if (character === undefined || characterIds.has(character.characterId)) {
      throw new TypeError("Invalid characters response");
    }
    characterIds.add(character.characterId);
    characters.push(character);
  }
  if (
    selectedCharacterId !== null &&
    !characters.some(
      (character) =>
        character.characterId === selectedCharacterId && character.unlocked,
    )
  ) {
    throw new TypeError("Invalid characters response");
  }
  return Object.freeze({
    status: "ok",
    generatedAt: value["generatedAt"] as string,
    ...(Object.hasOwn(value, "unlockBatchId")
      ? { unlockBatchId: value["unlockBatchId"] as string | null }
      : {}),
    selection: Object.freeze({
      characterId: selectedCharacterId as CharacterId | null,
      selectedBy: selectedBy as "manual" | "auto-starter" | null,
    }),
    voiceEnabled: value["voiceEnabled"],
    characters: Object.freeze(characters),
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
  return value === "sidecar-unavailable" || value === "sidecar-incompatible";
}

function isCompanionCharacterId(value: unknown): value is CompanionCharacterId {
  return COMPANION_CHARACTER_IDS.some((candidate) => candidate === value);
}

function isCompanionProviderFamily(
  value: unknown,
): value is CompanionProviderFamily {
  return COMPANION_PROVIDER_FAMILIES.some((candidate) => candidate === value);
}

const CHARACTER_BY_PROVIDER = Object.freeze({
  openai: "chatgpt",
  anthropic: "claude",
  google: "gemini",
  xai: "grok",
} as const satisfies Readonly<
  Record<CompanionProviderFamily, CompanionCharacterId>
>);

function parseStarterSelection(
  value: unknown,
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
        "providerFamily",
      ]) &&
      isCompanionProviderFamily(providerFamily) &&
      CHARACTER_BY_PROVIDER[providerFamily] === characterId
    ) {
      return Object.freeze({
        outcome: "selected",
        selectedBy,
        characterId,
        providerFamily,
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
              tiedProviderFamilies[index - 1]!,
            )),
    ) ||
    (reason === "no-positive-provider-data" &&
      tiedProviderFamilies.length !== 0) ||
    (reason === "highest-provider-total-tie" && tiedProviderFamilies.length < 2)
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
    tiedProviderFamilies: Object.freeze([...tiedProviderFamilies]),
  });
}

function parseErrorSnapshot(
  value: Record<string, unknown>,
): CompanionErrorSnapshot | undefined {
  if (!hasExactKeys(value, ["status", "error"])) return undefined;
  const error = value["error"];
  if (!isCompanionErrorCode(error)) return undefined;
  return Object.freeze({ status: "error", error });
}

function parseHealthySnapshot(
  value: Record<string, unknown>,
): CompanionHealthySnapshot | undefined {
  if (
    !hasExactKeys(value, [
      "status",
      "generatedAt",
      "starter",
      "totals",
      "daily",
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
      totalTokens,
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
      last28Days: totals["last28Days"],
    }),
    daily: Object.freeze(points),
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
  value: unknown,
): value is CompanionCollectorPhase {
  return COMPANION_COLLECTOR_PHASES.some((phase) => phase === value);
}

/** Strictly validates the content-blind collector DTO accepted by the UI. */
export function parseCompanionCollectorStatus(
  value: unknown,
): CompanionCollectorStatus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "phase",
      "lastSuccessAt",
      "consecutiveFailures",
      "canRetry",
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
    (lastSuccessAt !== null && parseGeneratedAt(lastSuccessAt) === undefined) ||
    !isSafeTokenCount(consecutiveFailures) ||
    typeof canRetry !== "boolean" ||
    ((phase === "ready" || phase === "ready-no-data") &&
      (lastSuccessAt === null || consecutiveFailures !== 0)) ||
    (phase === "refresh-failed" &&
      (lastSuccessAt !== null || consecutiveFailures < 1)) ||
    (phase === "stale" && (lastSuccessAt === null || consecutiveFailures < 1))
  ) {
    throw new TypeError("Invalid collector response");
  }
  return Object.freeze({
    phase,
    lastSuccessAt: lastSuccessAt as string | null,
    consecutiveFailures,
    canRetry,
  });
}

function isUsageWindow(value: unknown): value is UsageWindow {
  return USAGE_WINDOWS.some((candidate) => candidate === value);
}

function isUsageFamily(value: unknown): value is UsageFamily {
  return USAGE_FAMILIES.some((candidate) => candidate === value);
}

/** Strictly validates a contiguous, complete daily family response. */
export function parseUsageFamiliesResponse(
  value: unknown,
  todayUtcDate = new Date().toISOString().slice(0, 10),
  expectedWindow?: UsageWindow,
): UsageFamiliesResponse {
  if (
    parseUtcDate(todayUtcDate) === undefined ||
    !isRecord(value) ||
    !hasExactKeys(value, ["window", "days"]) ||
    !isUsageWindow(value["window"]) ||
    (expectedWindow !== undefined && value["window"] !== expectedWindow) ||
    !Array.isArray(value["days"]) ||
    value["days"].length !== value["window"]
  ) {
    throw new TypeError("Invalid usage families response");
  }

  const window = value["window"];
  const firstUtcDate = utcDateOffset(todayUtcDate, -(window - 1));
  const days: UsageFamilyDay[] = [];
  for (const [index, candidate] of value["days"].entries()) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["utcDate", "families"]) ||
      candidate["utcDate"] !== utcDateOffset(firstUtcDate, index) ||
      !isRecord(candidate["families"]) ||
      !hasExactKeys(candidate["families"], USAGE_FAMILIES)
    ) {
      throw new TypeError("Invalid usage families response");
    }

    const families = candidate["families"];
    if (USAGE_FAMILIES.some((family) => !isSafeTokenCount(families[family]))) {
      throw new TypeError("Invalid usage families response");
    }
    days.push(
      Object.freeze({
        utcDate: candidate["utcDate"] as string,
        families: Object.freeze(
          Object.fromEntries(
            USAGE_FAMILIES.map((family) => [family, families[family]]),
          ),
        ) as UsageFamilyTotals,
      }),
    );
  }

  return Object.freeze({ window, days: Object.freeze(days) });
}

/** Strictly validates the bounded, descending model usage response. */
export function parseUsageModelsResponse(
  value: unknown,
  expectedWindow?: UsageWindow,
  limit = 50,
): UsageModelsResponse {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !isRecord(value) ||
    !hasExactKeys(value, ["window", "models"]) ||
    !isUsageWindow(value["window"]) ||
    (expectedWindow !== undefined && value["window"] !== expectedWindow) ||
    !Array.isArray(value["models"]) ||
    value["models"].length > limit
  ) {
    throw new TypeError("Invalid usage models response");
  }

  const models: UsageModel[] = [];
  let previousTotal = Number.MAX_SAFE_INTEGER;
  const allowedKeys = [
    "model",
    "family",
    "totalTokens",
    "inputTokens",
    "outputTokens",
  ] as const;
  for (const candidate of value["models"]) {
    if (!isRecord(candidate)) {
      throw new TypeError("Invalid usage models response");
    }
    const keys = Object.keys(candidate);
    const model = candidate["model"];
    const totalTokens = candidate["totalTokens"];
    if (
      keys.length < 3 ||
      keys.length > allowedKeys.length ||
      keys.some(
        (key) => !allowedKeys.includes(key as (typeof allowedKeys)[number]),
      ) ||
      !keys.includes("model") ||
      !keys.includes("family") ||
      !keys.includes("totalTokens") ||
      !isShortText(model, 120) ||
      model.trim() !== model ||
      !isUsageFamily(candidate["family"]) ||
      !isSafeTokenCount(totalTokens) ||
      totalTokens > previousTotal ||
      (keys.includes("inputTokens") &&
        !isSafeTokenCount(candidate["inputTokens"])) ||
      (keys.includes("outputTokens") &&
        !isSafeTokenCount(candidate["outputTokens"]))
    ) {
      throw new TypeError("Invalid usage models response");
    }
    previousTotal = totalTokens;
    models.push(
      Object.freeze({
        model,
        family: candidate["family"],
        totalTokens,
        ...(keys.includes("inputTokens")
          ? { inputTokens: candidate["inputTokens"] as number }
          : {}),
        ...(keys.includes("outputTokens")
          ? { outputTokens: candidate["outputTokens"] as number }
          : {}),
      }),
    );
  }

  return Object.freeze({
    window: value["window"],
    models: Object.freeze(models),
  });
}
