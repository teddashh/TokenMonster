import type { TokenTrackerAdapter } from "@tokenmonster/token-tracker-adapter";
import type { EncryptedSecretSlot } from "@tokenmonster/secret-vault";
import type {
  ContributionActionCode,
  ContributionActionResult,
  ContributionPreview,
  ContributionRuntimeStatus,
} from "@tokenmonster/contribution-runtime";
import type { SupportedIngestSnapshot } from "@tokenmonster/contracts";
import type {
  TokenMonsterUsageFamily,
  TokenMonsterUsageFamilyTotals,
} from "@tokenmonster/token-tracker-adapter";
import type {
  ApprovedAssetPackConfiguration,
  AssetManifest,
  LetterWardrobeTheme,
  WardrobeThemeId,
  StarterCharacterSelection,
} from "@tokenmonster/characters";
import type {
  MonsterCoverageBandV1,
  MonsterMetricV1,
  MonsterMoodIdV1,
  MonsterReasonCodeV1,
  MonsterTemplateIdV1,
  MonsterTraitIdV1,
  MonsterValueBandV1,
} from "@tokenmonster/monster-engine";

export type CompanionGatewayClock = () => Date;

export type CompanionUiLocale = "zh-TW" | "en";

export interface CompanionUiLocalePreferenceResponse {
  readonly status: "ok";
  readonly locale: CompanionUiLocale;
  readonly revision: number;
}

export type CompanionUiLocalePreferenceErrorCode =
  | "invalid-request"
  | "revision-conflict"
  | "storage-unavailable";

export interface CompanionUiLocalePreferenceErrorResponse {
  readonly status: "error";
  readonly error: CompanionUiLocalePreferenceErrorCode;
}

export type CompanionByokAvailability = "available" | "unavailable";
export type CompanionByokPersistence = "os-backed" | "memory-only";

export type CompanionContributionAvailability = "available" | "unavailable";

export type CompanionContributionUnavailableReason =
  | "secure-storage-unavailable"
  | "runtime-unavailable"
  | "recovery-required";

/**
 * The gateway accepts only this read-only facade. Mutation methods and cloud
 * transport configuration are deliberately outside the loopback boundary.
 */
export interface CompanionContributionStatusSource {
  status(): ContributionRuntimeStatus;
}

/**
 * Exact, content-blind browser facade. The host must wrap the runtime instead
 * of exposing sync, disposal, credential slots, or cloud configuration.
 */
export interface CompanionContributionController
  extends CompanionContributionStatusSource {
  preparePreview(): Promise<ContributionPreview>;
  enable(previewId: string): Promise<ContributionActionResult>;
  stop(): Promise<ContributionActionResult>;
  requestDeletion(): Promise<ContributionActionResult>;
  recover(): Promise<ContributionActionResult>;
}

export interface CompanionContributionStatusResponse {
  readonly status: "ok";
  readonly availability: CompanionContributionAvailability;
  readonly unavailableReason: CompanionContributionUnavailableReason | null;
  readonly secureStorage: "os-backed" | "unavailable";
  readonly state:
    | "off"
    | "active"
    | "stopped"
    | "deletion-pending"
    | "deletion-complete"
    | "deletion-failed"
    | "unavailable";
  readonly enabled: boolean;
  readonly canPreview: boolean;
  readonly canStop: boolean;
  readonly canDelete: boolean;
  readonly canRecover: boolean;
  readonly outboxPending: number;
  readonly deletionStatus: "queued" | "running" | "complete" | "failed" | null;
  readonly anonymousHistoricalTotalsRetained: true | null;
}

export interface CompanionContributionPreviewResponse {
  readonly status: "ok";
  readonly preview: Readonly<{
    previewId: string;
    expiresAt: string;
    document: Readonly<{
      revision: string;
      title: string;
      summary: string;
      retentionDisclosure: string;
    }>;
    fieldAllowlist: readonly string[];
    forbidden: readonly string[];
    payload: SupportedIngestSnapshot | null;
    eligibleBucketCount: number;
    remainingEligibleBucketCount: number;
  }>;
}

export type CompanionContributionAction =
  | "preview"
  | "enable"
  | "stop"
  | "delete"
  | "recover";

export type CompanionContributionControlCode =
  | ContributionActionCode
  | "invalid-request"
  | "runtime-unavailable";

export interface CompanionContributionControlResponse {
  readonly status: "ok" | "error";
  readonly action: CompanionContributionAction;
  readonly code: CompanionContributionControlCode;
  readonly contribution: CompanionContributionStatusResponse;
}

export type CompanionContributionPreviewRouteResponse =
  | CompanionContributionPreviewResponse
  | CompanionContributionControlResponse;

export interface CompanionByokStatusResponse {
  readonly status: "ok";
  readonly availability: CompanionByokAvailability;
  readonly configured: boolean;
  readonly persistence: CompanionByokPersistence;
  readonly canPersist: boolean;
  readonly provider: "OpenAI";
  readonly model: "gpt-5.6-luna";
}

export type CompanionByokControlErrorCode =
  "invalid-request" | "invalid-key" | "unavailable" | "storage-failed";

export interface CompanionByokControlErrorResponse {
  readonly status: "error";
  readonly error: CompanionByokControlErrorCode;
}

export type CompanionByokControlResponse =
  CompanionByokStatusResponse | CompanionByokControlErrorResponse;

export interface CompanionByokRequestErrorResponse {
  readonly status: "error";
  readonly error: "invalid-request";
}

export interface CompanionByokChatMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export type CompanionByokChatErrorCode =
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

export type CompanionByokChatResponse =
  | Readonly<{
      status: "ok";
      characterId: "chatgpt" | "claude" | "gemini" | "grok";
      text: string;
    }>
  | Readonly<{
      status: "error";
      characterId: "chatgpt" | "claude" | "gemini" | "grok";
      error: CompanionByokChatErrorCode;
    }>;

export type CompanionByokChatRouteResponse =
  CompanionByokChatResponse | CompanionByokRequestErrorResponse;

export interface CompanionUiAssets {
  readonly html: string | Uint8Array;
  readonly css: string | Uint8Array;
  readonly scripts: Readonly<Record<string, string | Uint8Array>>;
}

export interface CompanionCharacterOptions {
  readonly manifest: AssetManifest | null;
  /**
   * Complete fixed-pack authority. Omission and null are both letter-only;
   * production entry points pass the embedded fail-closed getter result.
   */
  readonly assetPack?: ApprovedAssetPackConfiguration | null;
  readonly cacheDirectory: string;
  readonly cdnBaseUrl: null;
  readonly progressionStorePath: string;
}

export type CompanionAssetPackPhase =
  "unavailable" | "available" | "installing" | "repair-needed" | "installed";

export type CompanionAssetPackError =
  "download-failed" | "cache-unavailable" | "local-state-unavailable";

export interface CompanionAssetPackStatusResponse {
  readonly status: "ok";
  readonly phase: CompanionAssetPackPhase;
  readonly consented: boolean;
  readonly enabled: boolean;
  readonly releaseId: string | null;
  readonly downloadBytes: number | null;
  readonly lastError: CompanionAssetPackError | null;
}

export type CompanionCharacterId =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "grok"
  | "deepseek"
  | "qwen"
  | "mistral"
  | "venice"
  | "sakana"
  | "perplexity"
  | "glm";

export interface CompanionCharacterProgress {
  readonly value: number;
  readonly explain: string;
}

export interface CompanionCharacterLetterVisual {
  readonly mode: "letter";
  readonly glyph: string;
  readonly background: string;
  readonly foreground: string;
  readonly accent: string;
  readonly themes: readonly CompanionCharacterLetterTheme[];
}

export interface CompanionCharacterLetterTheme {
  readonly themeId: WardrobeThemeId;
  readonly displayName: string;
  readonly accessibleLabel: string;
  readonly unlocked: boolean;
  readonly palette: LetterWardrobeTheme["palette"];
  readonly pattern: LetterWardrobeTheme["pattern"];
  readonly accent: LetterWardrobeTheme["accent"];
}

export interface CompanionCharacterThemeVisual {
  readonly themeId: string;
  readonly unlocked: boolean;
  readonly outfitPath: string;
  readonly posePaths: Readonly<{
    supported: string | null;
    challenged: string | null;
    victory: string | null;
  }>;
}

export interface CompanionCharacterDollVisual {
  readonly mode: "doll";
  readonly avatarPath: string;
  readonly themes: readonly CompanionCharacterThemeVisual[];
}

export interface CompanionCharacterVoiceLine {
  readonly id: string;
  readonly trigger: "greeting" | "unlock" | "quiet" | "active" | "error";
  readonly path: string;
  readonly durationMs: number;
}

export interface CompanionCharacter {
  readonly characterId: CompanionCharacterId;
  readonly displayName: string;
  readonly kind: "sister" | "friend";
  readonly unlocked: boolean;
  readonly unlockedAt: string | null;
  readonly isStarter: boolean;
  readonly starterPersona: Readonly<{
    alias: string;
    taglineZhTw: string;
  }> | null;
  readonly activeThemeId: string | null;
  readonly visual:
    CompanionCharacterLetterVisual | CompanionCharacterDollVisual;
  readonly progress: CompanionCharacterProgress | null;
  readonly voiceLines: readonly CompanionCharacterVoiceLine[];
}

export interface CompanionCharactersResponse {
  readonly status: "ok";
  readonly generatedAt: string;
  readonly unlockBatchId: string | null;
  readonly selection: Readonly<{
    characterId: CompanionCharacterId | null;
    selectedBy: "manual" | "auto-starter" | null;
  }>;
  readonly voiceEnabled: true;
  readonly characters: readonly CompanionCharacter[];
}

export type CompanionProgressionLockRepairOutcome = "repaired" | "not-needed";

export interface CompanionProgressionLockRepairResponse {
  readonly status: "ok";
  readonly outcome: CompanionProgressionLockRepairOutcome;
}

export interface CompanionCharacterProfileReasonInput {
  readonly metric: MonsterMetricV1;
  readonly valueBand: MonsterValueBandV1;
  readonly coverage: MonsterCoverageBandV1;
}

export interface CompanionCharacterProfileReason {
  readonly subject: "identity" | "trait" | "mood" | "evolution";
  readonly reasonCode: MonsterReasonCodeV1;
  readonly templateId: MonsterTemplateIdV1;
  readonly inputs: readonly CompanionCharacterProfileReasonInput[];
}

export type CompanionCharacterProfileTraitId = Exclude<
  MonsterTraitIdV1,
  "provider-focused" | "multi-provider" | "balanced"
>;

export interface CompanionCharacterProfileResponse {
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
    coverageBand: MonsterCoverageBandV1;
    provisional: boolean;
    traitIds: readonly CompanionCharacterProfileTraitId[];
  }>;
  readonly mood: Readonly<{
    id: MonsterMoodIdV1;
    energyBand: "dormant" | "low" | "medium" | "high";
  }>;
  readonly evolution: Readonly<{
    cadence: "weekly" | "event" | "none";
    event:
      | "awaiting-coverage"
      | "initial-profile"
      | "coverage-complete"
      | "identity-shift"
      | "weekly-review"
      | "no-change";
  }>;
  readonly reasons: readonly CompanionCharacterProfileReason[];
}

export type CompanionCharacterInteractionLocale = "zh-TW" | "en";

export interface CompanionCharacterInteractionLineResponse {
  readonly status: "ok";
  readonly action: "tap";
  readonly characterId: CompanionCharacterId;
  readonly locale: CompanionCharacterInteractionLocale;
  readonly outcome: "line";
  readonly line: Readonly<{
    readonly lineId: string;
    readonly text: string;
  }>;
  readonly cooldownMs: number;
}

export interface CompanionCharacterInteractionCooldownResponse {
  readonly status: "ok";
  readonly action: "tap";
  readonly characterId: CompanionCharacterId;
  readonly locale: CompanionCharacterInteractionLocale;
  readonly outcome: "animation-only";
  readonly retryAfterMs: number;
}

export type CompanionCharacterInteractionResponse =
  | CompanionCharacterInteractionLineResponse
  | CompanionCharacterInteractionCooldownResponse;

interface CompanionGatewayBaseOptions {
  readonly adapter: TokenTrackerAdapter;
  readonly collector: CompanionCollectorController;
  readonly characters: CompanionCharacterOptions;
  /**
   * Local BYOK secret authority. Omission and null both disable BYOK; hosts
   * without OS-backed encryption should pass an explicit memory-only slot.
   */
  readonly byok?: EncryptedSecretSlot | null;
  /**
   * Exact contribution facade. A status-only source remains non-mutable;
   * omission and null expose the same canonical unavailable/default-off DTO.
   */
  readonly contribution?:
    | CompanionContributionStatusSource
    | CompanionContributionController
    | null;
  readonly clock?: CompanionGatewayClock;
  readonly apiTimeoutMs?: number;
}

export type CompanionGatewayOptions = CompanionGatewayBaseOptions &
  (
    | {
        readonly assets: CompanionUiAssets;
        readonly assetDirectory?: never;
      }
    | {
        readonly assets?: never;
        readonly assetDirectory: string;
      }
  );

export interface CompanionGatewayAddress {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly origin: string;
  readonly bootstrapUrl: string;
}

export interface CompanionGateway {
  start(port?: number): Promise<CompanionGatewayAddress>;
  close(): Promise<void>;
}

export type CompanionCollectorPhase =
  | "starting"
  | "syncing"
  | "ready"
  | "ready-no-data"
  | "refresh-failed"
  | "stale";

export interface CompanionCollectorStatus {
  readonly phase: CompanionCollectorPhase;
  readonly lastSuccessAt: string | null;
  readonly consecutiveFailures: number;
  readonly canRetry: boolean;
}

export interface CompanionCollectorController {
  getStatus(): CompanionCollectorStatus;
  requestRefresh(): Promise<CompanionCollectorStatus>;
}

export interface CompanionDailyTotal {
  readonly utcDate: string;
  readonly totalTokens: number;
}

export interface CompanionPeriodTotals {
  readonly today: number;
  readonly last7Days: number;
  readonly last28Days: number;
}

export interface CompanionApiHealthyResponse {
  readonly status: "healthy";
  readonly generatedAt: string;
  readonly starter: StarterCharacterSelection;
  readonly totals: CompanionPeriodTotals;
  readonly daily: readonly CompanionDailyTotal[];
}

export type CompanionApiErrorCode =
  "sidecar-unavailable" | "sidecar-incompatible";

export interface CompanionApiErrorResponse {
  readonly status: "error";
  readonly error: CompanionApiErrorCode;
}

export type CompanionApiResponse =
  CompanionApiHealthyResponse | CompanionApiErrorResponse;

export type CompanionUsageWindow = 7 | 28 | 90;

export interface CompanionUsageFamilyDay {
  readonly utcDate: string;
  readonly families: TokenMonsterUsageFamilyTotals;
}

export interface CompanionUsageFamiliesResponse {
  readonly window: CompanionUsageWindow;
  readonly days: readonly CompanionUsageFamilyDay[];
}

export interface CompanionUsageModel {
  readonly model: string;
  readonly family: TokenMonsterUsageFamily;
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface CompanionUsageModelsResponse {
  readonly window: CompanionUsageWindow;
  readonly models: readonly CompanionUsageModel[];
}

export type CompanionQuotaFamily = "anthropic" | "openai" | "google" | "xai";

export interface CompanionQuotaFamilyEstimate {
  readonly family: CompanionQuotaFamily;
  readonly planId: string | null;
  readonly windowHours: number;
  readonly windowKind: "rolling" | "utc-day";
  readonly usedTokens: number;
  readonly budgetTokens: number | null;
  readonly estimate: true;
}

export interface CompanionQuotaResponse {
  readonly status: "ok";
  readonly generatedAt: string;
  readonly families: readonly CompanionQuotaFamilyEstimate[];
}

export type CompanionGatewayErrorCode =
  "invalid-configuration" | "already-started" | "closed";
