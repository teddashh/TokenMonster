import { z } from "zod";

import {
  MAX_TOKEN_TRACKER_RANGE_DAYS,
  TOKEN_TRACKER_PROGRESSION_SOURCE_MAP,
  TOKEN_TRACKER_PROVIDER_SOURCE_MAP
} from "./constants.js";
import { TokenTrackerAdapterError } from "./errors.js";
import type {
  TokenMonsterDailyAggregateResponse,
  TokenMonsterProgressionFamilyTotals,
  TokenMonsterProviderTotals,
  TokenMonsterTokenLedger
} from "./types.js";

const SafeCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const UtcDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  });

const EmptyExcludedSourcesSchema = z.array(z.never()).max(0);

const UpstreamTokenFields = {
  total_tokens: SafeCountSchema,
  billable_total_tokens: SafeCountSchema,
  input_tokens: SafeCountSchema,
  output_tokens: SafeCountSchema,
  cached_input_tokens: SafeCountSchema,
  cache_creation_input_tokens: SafeCountSchema,
  reasoning_output_tokens: SafeCountSchema,
  conversation_count: SafeCountSchema
} as const;

const RollingTotalsSchema = z.strictObject({
  billable_total_tokens: SafeCountSchema,
  conversation_count: SafeCountSchema
});

const RollingWindowSchema = z.strictObject({
  from: UtcDateSchema,
  to: UtcDateSchema,
  active_days: SafeCountSchema.max(30),
  totals: RollingTotalsSchema
});

const ModelTotalsSchema = z
  .record(z.string().min(1).max(256), SafeCountSchema)
  .refine((models) => Object.keys(models).length <= 512);

const ModelIdentifierSchema = z.string().min(1).max(256);

const ModelBreakdownTokenFields = {
  total_tokens: SafeCountSchema,
  billable_total_tokens: SafeCountSchema,
  input_tokens: SafeCountSchema,
  output_tokens: SafeCountSchema,
  cached_input_tokens: SafeCountSchema,
  cache_creation_input_tokens: SafeCountSchema,
  reasoning_output_tokens: SafeCountSchema
} as const;

const ModelBreakdownTotalsSchema = z.strictObject({
  ...ModelBreakdownTokenFields,
  total_cost_usd: z.string().regex(/^\d+\.\d{6}$/u)
});

const UpstreamModelBreakdownModelSchema = z
  .strictObject({
    model: ModelIdentifierSchema,
    model_id: ModelIdentifierSchema,
    totals: ModelBreakdownTotalsSchema
  })
  .superRefine((model, context) => {
    if (model.model !== model.model_id) {
      context.addIssue({
        code: "custom",
        path: ["model_id"],
        message: "model_id must match model for TokenTracker 0.80.0."
      });
    }
  });

const UpstreamModelBreakdownSourceSchema = z.strictObject({
  source: z
    .string()
    .min(1)
    .max(128)
    .refine((source) => source.trim().length > 0),
  source_scope: z.enum(["local", "account"]),
  totals: ModelBreakdownTotalsSchema,
  models: z.array(UpstreamModelBreakdownModelSchema).min(1).max(512)
});

const UpstreamDailyRowSchema = z.strictObject({
  day: UtcDateSchema,
  ...UpstreamTokenFields,
  total_cost_usd: z.number().finite().nonnegative(),
  models: ModelTotalsSchema.optional()
});

export const UpstreamSummaryResponseSchema = z.strictObject({
  from: UtcDateSchema,
  to: UtcDateSchema,
  days: SafeCountSchema.max(MAX_TOKEN_TRACKER_RANGE_DAYS),
  scope: z.literal("all"),
  excluded_sources: EmptyExcludedSourcesSchema,
  totals: z.strictObject({
    ...UpstreamTokenFields,
    total_cost_usd: z.string().regex(/^\d+\.\d{6}$/u)
  }),
  rolling: z.strictObject({
    last_7d: RollingWindowSchema,
    last_30d: RollingWindowSchema.extend({
      avg_per_active_day: SafeCountSchema
    })
  })
});

export const UpstreamDailyResponseSchema = z.strictObject({
  from: UtcDateSchema,
  to: UtcDateSchema,
  scope: z.literal("all"),
  excluded_sources: EmptyExcludedSourcesSchema,
  data: z.array(UpstreamDailyRowSchema).max(MAX_TOKEN_TRACKER_RANGE_DAYS)
});

export const UpstreamModelBreakdownResponseSchema = z.strictObject({
  from: UtcDateSchema,
  to: UtcDateSchema,
  days: z.literal(0),
  scope: z.literal("all"),
  excluded_sources: EmptyExcludedSourcesSchema,
  sources: z.array(UpstreamModelBreakdownSourceSchema).max(128),
  pricing: z.strictObject({
    model: z.literal("per-model"),
    pricing_mode: z.literal("per_token_type"),
    source: z.literal("litellm"),
    effective_from: UtcDateSchema
  })
});

export type UpstreamSummaryResponse = z.infer<
  typeof UpstreamSummaryResponseSchema
>;

export type UpstreamDailyResponse = z.infer<
  typeof UpstreamDailyResponseSchema
>;

export type UpstreamModelBreakdownResponse = z.infer<
  typeof UpstreamModelBreakdownResponseSchema
>;

export function projectTokenLedger(fields: {
  readonly total_tokens: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly reasoning_output_tokens: number;
}): TokenMonsterTokenLedger {
  return Object.freeze({
    inputTokens: fields.input_tokens,
    outputTokens: fields.output_tokens,
    cachedInputTokens: fields.cached_input_tokens,
    cacheCreationInputTokens: fields.cache_creation_input_tokens,
    reasoningOutputTokens: fields.reasoning_output_tokens,
    totalTokens: fields.total_tokens
  });
}

export function projectDailyResponse(
  response: UpstreamDailyResponse
): TokenMonsterDailyAggregateResponse {
  let previousDate = "";
  const days = response.data.map((row) => {
    if (
      row.day < response.from ||
      row.day > response.to ||
      (previousDate !== "" && row.day <= previousDate)
    ) {
      throw new TokenTrackerAdapterError("incompatible-schema");
    }
    previousDate = row.day;
    return Object.freeze({
      utcDate: row.day,
      tokens: projectTokenLedger(row)
    });
  });

  return Object.freeze({
    fromUtcDate: response.from,
    toUtcDate: response.to,
    days: Object.freeze(days)
  });
}

export function projectProviderTotals(
  response: UpstreamModelBreakdownResponse
): TokenMonsterProviderTotals {
  const totals = {
    openai: 0,
    anthropic: 0,
    google: 0,
    xai: 0
  };
  const seenMappedSources = new Set<string>();

  for (const source of response.sources) {
    if (!Object.hasOwn(TOKEN_TRACKER_PROVIDER_SOURCE_MAP, source.source)) {
      continue;
    }
    if (seenMappedSources.has(source.source) || source.source_scope !== "local") {
      throw new TokenTrackerAdapterError("incompatible-schema");
    }
    seenMappedSources.add(source.source);
    const sourceId = source.source as keyof typeof TOKEN_TRACKER_PROVIDER_SOURCE_MAP;
    const providerFamily = TOKEN_TRACKER_PROVIDER_SOURCE_MAP[sourceId];
    totals[providerFamily] = source.totals.total_tokens;
  }

  return Object.freeze(totals);
}

export function projectProgressionFamilyTotals(
  response: UpstreamModelBreakdownResponse
): TokenMonsterProgressionFamilyTotals {
  const totals: Record<keyof TokenMonsterProgressionFamilyTotals, number> = {
    openai: 0,
    anthropic: 0,
    google: 0,
    xai: 0,
    deepseek: 0,
    qwen: 0,
    mistral: 0,
    venice: 0,
    sakana: 0,
    perplexity: 0,
    glm: 0,
    other: 0
  };
  const seenSources = new Set<string>();

  for (const source of response.sources) {
    if (seenSources.has(source.source)) {
      throw new TokenTrackerAdapterError("incompatible-schema");
    }
    seenSources.add(source.source);

    let providerFamily: keyof TokenMonsterProgressionFamilyTotals = "other";
    if (Object.hasOwn(TOKEN_TRACKER_PROGRESSION_SOURCE_MAP, source.source)) {
      if (source.source_scope !== "local") {
        throw new TokenTrackerAdapterError("incompatible-schema");
      }
      const sourceId =
        source.source as keyof typeof TOKEN_TRACKER_PROGRESSION_SOURCE_MAP;
      providerFamily = TOKEN_TRACKER_PROGRESSION_SOURCE_MAP[sourceId];
    }
    const nextTotal = totals[providerFamily] + source.totals.total_tokens;
    if (!Number.isSafeInteger(nextTotal)) {
      throw new TokenTrackerAdapterError("incompatible-schema");
    }
    totals[providerFamily] = nextTotal;
  }

  return Object.freeze(totals);
}
