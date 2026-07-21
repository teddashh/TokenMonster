import type {
  ContributionActionResult,
  ContributionDeletionResult,
  ContributionPreview,
  ContributionRuntimeStatus,
  ContributionSyncResult,
} from "@tokenmonster/contribution-runtime";

export type {
  ContributionActionCode,
  ContributionActionResult,
  ContributionDeletionResult,
  ContributionPreview,
  ContributionRuntimeStatus,
  ContributionState,
  ContributionSyncResult,
} from "@tokenmonster/contribution-runtime";

export const TOKENMONSTER_APP_ORIGIN = "tokenmonster://app" as const;
export const IPC_CHANNELS = {
  bootstrap: "tokenmonster:bootstrap",
  usageInsights: "tokenmonster:usage-insights",
  selectCharacter: "tokenmonster:select-character",
  fixedInteraction: "tokenmonster:fixed-interaction",
  configureByok: "tokenmonster:configure-byok",
  clearByok: "tokenmonster:clear-byok",
  byokChat: "tokenmonster:byok-chat",
  scanUsage: "tokenmonster:scan-usage",
  saveShareCard: "tokenmonster:save-share-card",
  exportLocalData: "tokenmonster:export-local-data",
  exportSupportDiagnostic: "tokenmonster:export-support-diagnostic",
  resetLocalSourceData: "tokenmonster:reset-local-source-data",
  contributionStatus: "tokenmonster:contribution-status",
  contributionPreview: "tokenmonster:contribution-preview",
  contributionEnable: "tokenmonster:contribution-enable",
  contributionSync: "tokenmonster:contribution-sync",
  contributionStop: "tokenmonster:contribution-stop",
  contributionDelete: "tokenmonster:contribution-delete",
  contributionDeletionStatus: "tokenmonster:contribution-deletion-status"
} as const;

export type UsageInsightWindowDays = 7 | 28;

export interface UsageInsightsRequest {
  readonly windowDays: UsageInsightWindowDays;
}

export type UsageInsightProviderId =
  | "anthropic"
  | "google"
  | "openai"
  | "openrouter"
  | "xai"
  | "other";

export type UsageInsightToolId =
  | "claude-code"
  | "codex-cli"
  | "gemini-cli"
  | "grok-build"
  | "other";

export interface UsageInsightRow<Id extends string> {
  readonly id: Id;
  readonly totalTokens: string;
  readonly shareBasisPoints: number;
}

export interface LocalUsageInsights {
  readonly schemaVersion: "1";
  readonly windowDays: UsageInsightWindowDays;
  readonly fromInclusive: string;
  readonly toExclusive: string;
  readonly totalTokens: string;
  readonly providers: readonly UsageInsightRow<UsageInsightProviderId>[];
  readonly tools: readonly UsageInsightRow<UsageInsightToolId>[];
}

export interface ShareCardSaveRequest extends UsageInsightsRequest {
  readonly characterId: CharacterSummary["id"];
}

export type LocalFileSaveResponse = Readonly<{
  status:
    | "saved"
    | "cancelled"
    | "already-exists"
    | "invalid-selection"
    | "failed";
}>;

export interface LocalSourceResetRequest {
  readonly confirmation: "clear-collector-derived-data";
}

export type LocalSourceResetResponse = Readonly<{
  status: "reset";
  byokPreserved: true;
}>;

export type ByokPersistence = "os-backed" | "memory-only";

export interface ByokRuntimeStatus {
  readonly configured: boolean;
  readonly persistence: ByokPersistence;
  readonly canPersist: boolean;
  readonly backend: string;
  readonly provider: "OpenAI";
  readonly model: "gpt-5.6-luna";
}

export interface LocalRuntimeStatus {
  readonly storage: "ready";
  readonly state: "not-configured" | "stopped" | "running" | "degraded";
  readonly dailyAggregateRows: number;
  readonly lastSuccessfulScanAt: string | null;
}

export interface ContributionPreviewRequest {
  readonly confirmation: "preview-content-blind-contribution";
}

export interface ContributionEnableRequest {
  readonly confirmation: "enable-content-blind-contribution";
  readonly previewId: string;
}

export interface ContributionSyncRequest {
  readonly confirmation: "sync-content-blind-contribution";
}

export interface ContributionStopRequest {
  readonly confirmation: "stop-content-blind-contribution";
}

export interface ContributionDeleteRequest {
  readonly confirmation: "delete-identifiable-contribution-data";
}

export interface ContributionDeletionStatusRequest {
  readonly confirmation: "check-contribution-deletion-status";
}

export type CollectorClient = "claude" | "codex" | "gemini" | "grok";
export type CollectorDay = "today" | "previous";

export interface CollectorScanRequest {
  readonly client: CollectorClient;
  readonly day: CollectorDay;
}

export type CollectorScanErrorCode =
  | "authority-conflict"
  | "busy"
  | "collector-unavailable"
  | "invalid-output"
  | "local-service-error"
  | "storage-error";

export type CollectorScanResponse =
  | Readonly<{
      kind: "applied";
      client: CollectorClient;
      day: CollectorDay;
      bucketStart: string;
      observedRows: number;
      appliedRows: number;
      insertedRows: number;
      updatedRows: number;
      inferredZeroRows: number;
      sharing: "disabled";
    }>
  | Readonly<{
      kind: "error";
      client: CollectorClient;
      day: CollectorDay;
      errorCode: CollectorScanErrorCode;
    }>;

export interface CharacterSummary {
  readonly id: "chatgpt" | "claude" | "gemini" | "grok";
  readonly alias: string;
  readonly glyph: string;
  readonly description: string;
  readonly disclosure: string;
  readonly theme: Readonly<{
    background: string;
    foreground: string;
    accent: string;
  }>;
}

export type MonsterTraitId =
  | "balanced"
  | "cache-savvy"
  | "cli-focused"
  | "multi-provider"
  | "multi-tool"
  | "night-oriented"
  | "output-heavy"
  | "provider-focused"
  | "tool-focused";

export interface MonsterRuntimeSummary {
  readonly characterId: CharacterSummary["id"];
  readonly identityStatus: "learning" | "ready";
  readonly coverage: "insufficient" | "partial" | "good" | "full";
  readonly mood: "learning" | "unknown" | "resting" | "quiet" | "steady" | "lively";
  readonly moodLabel: string;
  readonly energy: "dormant" | "low" | "medium" | "high";
  readonly evolution: "awaiting-coverage" | "initial-profile" | "coverage-complete" | "identity-shift" | "weekly-review" | "no-change";
  readonly window: Readonly<{ from: string; to: string; timezone: "UTC" }>;
  readonly traits: readonly Readonly<{
    id: MonsterTraitId;
    label: string;
    reason: string;
  }>[];
  readonly disclosure: string;
}

export interface CompanionBootstrap {
  readonly contractVersion: 1;
  readonly locale: "zh-TW";
  readonly mode: "local-only" | "byok-direct";
  readonly selectedCharacterId: CharacterSummary["id"];
  readonly characters: readonly CharacterSummary[];
  readonly monster: MonsterRuntimeSummary;
  readonly collector: LocalRuntimeStatus;
  readonly contribution: ContributionRuntimeStatus;
  readonly byok: ByokRuntimeStatus;
}

export interface FixedInteractionRequest {
  readonly characterId: CharacterSummary["id"];
  readonly trigger: "greeting" | "idle";
}

export interface FixedInteractionResponse {
  readonly kind: "fixed-line";
  readonly lineId: string;
  readonly characterId: CharacterSummary["id"];
  readonly text: string;
}

export interface ConfigureByokRequest {
  readonly apiKey: string;
  readonly persist: boolean;
}

export interface ConfigureByokResponse {
  readonly ok: boolean;
  readonly errorCode: "invalid-key" | "storage-failed" | null;
  readonly byok: ByokRuntimeStatus;
}

export interface ByokChatRequest {
  readonly characterId: CharacterSummary["id"];
  readonly message: string;
}

export type ByokChatErrorCode =
  | "not-configured"
  | "busy"
  | "invalid-message"
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
      kind: "assistant";
      characterId: CharacterSummary["id"];
      text: string;
      historyMessages: number;
    }>
  | Readonly<{
      kind: "error";
      characterId: CharacterSummary["id"];
      errorCode: ByokChatErrorCode;
    }>;

export interface TokenMonsterBridge {
  getBootstrap(): Promise<CompanionBootstrap>;
  getUsageInsights(request: UsageInsightsRequest): Promise<LocalUsageInsights>;
  selectCharacter(
    characterId: CharacterSummary["id"]
  ): Promise<CompanionBootstrap>;
  interact(request: FixedInteractionRequest): Promise<FixedInteractionResponse>;
  configureByok(request: ConfigureByokRequest): Promise<ConfigureByokResponse>;
  clearByok(): Promise<ConfigureByokResponse>;
  chat(request: ByokChatRequest): Promise<ByokChatResponse>;
  scanUsage(request: CollectorScanRequest): Promise<CollectorScanResponse>;
  saveShareCard(request: ShareCardSaveRequest): Promise<LocalFileSaveResponse>;
  exportLocalData(): Promise<LocalFileSaveResponse>;
  exportSupportDiagnostic(): Promise<LocalFileSaveResponse>;
  resetLocalSourceData(
    request: LocalSourceResetRequest
  ): Promise<LocalSourceResetResponse>;
  getContributionStatus(): Promise<ContributionRuntimeStatus>;
  prepareContributionPreview(
    request: ContributionPreviewRequest
  ): Promise<ContributionPreview>;
  enableContribution(
    request: ContributionEnableRequest
  ): Promise<ContributionActionResult>;
  syncContribution(
    request: ContributionSyncRequest
  ): Promise<ContributionSyncResult>;
  stopContribution(
    request: ContributionStopRequest
  ): Promise<ContributionActionResult>;
  deleteContributionData(
    request: ContributionDeleteRequest
  ): Promise<ContributionDeletionResult>;
  refreshContributionDeletionStatus(
    request: ContributionDeletionStatusRequest
  ): Promise<ContributionDeletionResult>;
}
