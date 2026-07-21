import type {
  DailyContentBlindFootprintV1,
  MonsterCharacterIdV1
} from "@tokenmonster/monster-engine";

import type { SUPPORTED_TOKEN_TRACKER_VERSION } from "./constants.js";

export interface TokenTrackerFetchHeaders {
  get(name: string): string | null;
}

export interface TokenTrackerStreamReadResult {
  readonly done: boolean;
  readonly value?: Uint8Array;
}

export interface TokenTrackerStreamReader {
  read(): Promise<TokenTrackerStreamReadResult>;
  cancel?(reason?: unknown): Promise<void>;
}

export interface TokenTrackerResponseBody {
  getReader(): TokenTrackerStreamReader;
}

export interface TokenTrackerFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: TokenTrackerFetchHeaders;
  readonly body: TokenTrackerResponseBody | null;
}

export interface TokenTrackerFetchRequestInit {
  readonly method: "GET";
  readonly redirect: "error";
  readonly cache: "no-store";
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export type TokenTrackerFetch = (
  endpoint: string,
  init: TokenTrackerFetchRequestInit
) => Promise<TokenTrackerFetchResponse>;

export interface TokenTrackerAdapterOptions {
  readonly baseUrl?: string;
  readonly fetch?: TokenTrackerFetch;
  readonly timeoutMs?: number;
}

export interface TokenTrackerAggregateRange {
  readonly fromUtcDate: string;
  readonly toUtcDate: string;
}

export interface TokenMonsterTokenLedger {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

export interface TokenTrackerProbe {
  readonly reachable: true;
  readonly schemaCompatible: true;
  readonly compatibilityTarget: typeof SUPPORTED_TOKEN_TRACKER_VERSION;
}

export interface TokenMonsterAggregateSummary {
  readonly fromUtcDate: string;
  readonly toUtcDate: string;
  readonly activeDays: number;
  readonly tokens: TokenMonsterTokenLedger;
}

export interface TokenMonsterDailyAggregate {
  readonly utcDate: string;
  readonly tokens: TokenMonsterTokenLedger;
}

export interface TokenMonsterDailyAggregateResponse {
  readonly fromUtcDate: string;
  readonly toUtcDate: string;
  readonly days: readonly TokenMonsterDailyAggregate[];
}

export interface TokenMonsterProviderTotals {
  readonly openai: number;
  readonly anthropic: number;
  readonly google: number;
  readonly xai: number;
}

export interface TokenMonsterProgressionFamilyTotals {
  readonly openai: number;
  readonly anthropic: number;
  readonly google: number;
  readonly xai: number;
  readonly deepseek: number;
  readonly qwen: number;
  readonly mistral: number;
  readonly venice: number;
  readonly sakana: number;
  readonly perplexity: number;
  readonly glm: number;
  readonly other: number;
}

export type TokenMonsterUsageFamily = keyof TokenMonsterProgressionFamilyTotals;

export type TokenMonsterUsageFamilyTotals = Readonly<
  Record<TokenMonsterUsageFamily, number>
>;

export interface TokenMonsterDailyFamilyUsage {
  readonly utcDate: string;
  readonly families: TokenMonsterUsageFamilyTotals;
}

export interface TokenMonsterDailyFamilySeries {
  readonly days: readonly TokenMonsterDailyFamilyUsage[];
}

export interface TokenTrackerModelUsageQuery extends TokenTrackerAggregateRange {
  readonly limit: number;
}

export interface TokenTrackerProfileFootprintQuery
  extends TokenTrackerAggregateRange {
  readonly characterId: MonsterCharacterIdV1;
}

export type TokenMonsterDailyContentBlindFootprint =
  DailyContentBlindFootprintV1;

export interface TokenMonsterModelUsageEntry {
  readonly model: string;
  readonly family: TokenMonsterUsageFamily;
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface TokenMonsterModelUsageResponse {
  readonly models: readonly TokenMonsterModelUsageEntry[];
}

export interface TokenTrackerAdapter {
  probe(): Promise<TokenTrackerProbe>;
  getSummary(
    range: TokenTrackerAggregateRange
  ): Promise<TokenMonsterAggregateSummary>;
  getDaily(
    range: TokenTrackerAggregateRange
  ): Promise<TokenMonsterDailyAggregateResponse>;
  getProviderTotals(
    range: TokenTrackerAggregateRange
  ): Promise<TokenMonsterProviderTotals>;
  getProgressionFamilyTotals(
    range: TokenTrackerAggregateRange
  ): Promise<TokenMonsterProgressionFamilyTotals>;
  getDailyFamilySeries(
    range: TokenTrackerAggregateRange
  ): Promise<TokenMonsterDailyFamilySeries>;
  getDailyContentBlindFootprint(
    query: TokenTrackerProfileFootprintQuery
  ): Promise<TokenMonsterDailyContentBlindFootprint>;
  getModelUsage(
    query: TokenTrackerModelUsageQuery
  ): Promise<TokenMonsterModelUsageResponse>;
}
