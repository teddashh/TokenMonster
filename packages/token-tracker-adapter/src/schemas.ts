import { z } from "zod";
import { FOOTPRINT_WINDOW_DAYS_V1 } from "@tokenmonster/monster-engine";

import {
  MAX_TOKEN_TRACKER_MODEL_NAME_LENGTH,
  MAX_TOKEN_TRACKER_RANGE_DAYS,
  TOKEN_MONSTER_USAGE_FAMILIES,
  TOKEN_TRACKER_PROGRESSION_SOURCE_MAP,
  TOKEN_TRACKER_PROVIDER_SOURCE_MAP
} from "./constants.js";
import { TokenTrackerAdapterError } from "./errors.js";
import type {
  TokenMonsterDailyAggregateResponse,
  TokenMonsterModelUsageEntry,
  TokenMonsterModelUsageResponse,
  TokenMonsterProgressionFamilyTotals,
  TokenMonsterProviderTotals,
  TokenMonsterTokenLedger,
  TokenMonsterUsageFamily,
  TokenMonsterUsageFamilyTotals
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

// tokentracker-cli@0.80.0 has exactly one account-level source (`cursor`).
// `scope=personal` filters it from usage rows and reports this bounded metadata
// in `excluded_sources`. A new account-level source is compatibility drift and
// must be reviewed alongside a future exact sidecar pin.
const PersonalExcludedSourcesSchema = z
  .array(
    z.strictObject({
      source: z.literal("cursor"),
      source_scope: z.literal("account"),
      reason: z.literal("account_level_source")
    })
  )
  .max(1);

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

const ModelIdentifierSchema = z.string().max(256);

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

const UpstreamPersonalModelBreakdownSourceSchema =
  UpstreamModelBreakdownSourceSchema.extend({
    source_scope: z.literal("local")
  }).refine((source) => source.source !== "cursor", {
    path: ["source"],
    message: "scope=personal must exclude TokenTracker account sources."
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

export const UpstreamPersonalDailyResponseSchema = z.strictObject({
  from: UtcDateSchema,
  to: UtcDateSchema,
  scope: z.literal("personal"),
  excluded_sources: PersonalExcludedSourcesSchema,
  data: z
    .array(UpstreamDailyRowSchema)
    .max(FOOTPRINT_WINDOW_DAYS_V1)
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

export const UpstreamPersonalModelBreakdownResponseSchema = z.strictObject({
  from: UtcDateSchema,
  to: UtcDateSchema,
  days: z.literal(0),
  scope: z.literal("personal"),
  excluded_sources: PersonalExcludedSourcesSchema,
  sources: z.array(UpstreamPersonalModelBreakdownSourceSchema).max(128),
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

export type UpstreamPersonalDailyResponse = z.infer<
  typeof UpstreamPersonalDailyResponseSchema
>;

export type UpstreamPersonalModelBreakdownResponse = z.infer<
  typeof UpstreamPersonalModelBreakdownResponseSchema
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

export function emptyUsageFamilyTotals(): TokenMonsterUsageFamilyTotals {
  return Object.freeze(
    Object.fromEntries(TOKEN_MONSTER_USAGE_FAMILIES.map((family) => [family, 0]))
  ) as TokenMonsterUsageFamilyTotals;
}

function analyticsFamilyForSource(
  source: UpstreamModelBreakdownResponse["sources"][number]
): TokenMonsterUsageFamily {
  if (!Object.hasOwn(TOKEN_TRACKER_PROGRESSION_SOURCE_MAP, source.source)) {
    return "other";
  }
  if (source.source_scope !== "local") {
    throw new TokenTrackerAdapterError("incompatible-schema");
  }
  const sourceId =
    source.source as keyof typeof TOKEN_TRACKER_PROGRESSION_SOURCE_MAP;
  return TOKEN_TRACKER_PROGRESSION_SOURCE_MAP[sourceId];
}

function checkedTokenSum(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new TokenTrackerAdapterError("incompatible-schema");
  }
  return total;
}

function assertUniqueSources(response: UpstreamModelBreakdownResponse): void {
  const seenSources = new Set<string>();
  for (const source of response.sources) {
    if (seenSources.has(source.source)) {
      throw new TokenTrackerAdapterError("incompatible-schema");
    }
    seenSources.add(source.source);
  }
}

export function projectUsageFamilyTotals(
  response: UpstreamModelBreakdownResponse
): TokenMonsterUsageFamilyTotals {
  assertUniqueSources(response);
  const totals = { ...emptyUsageFamilyTotals() };
  for (const source of response.sources) {
    const family = analyticsFamilyForSource(source);
    totals[family] = checkedTokenSum(
      totals[family],
      source.totals.total_tokens
    );
  }
  return Object.freeze(totals);
}

export function projectModelUsage(
  response: UpstreamModelBreakdownResponse,
  limit: number
): TokenMonsterModelUsageResponse {
  assertUniqueSources(response);
  const aggregated = new Map<
    string,
    {
      model: string;
      family: TokenMonsterUsageFamily;
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
    }
  >();

  for (const source of response.sources) {
    const family = analyticsFamilyForSource(source);
    for (const upstreamModel of source.models) {
      const model = upstreamModel.model
        .trim()
        .slice(0, MAX_TOKEN_TRACKER_MODEL_NAME_LENGTH)
        .trimEnd();
      if (model.length === 0) continue;
      const key = `${family}\u0000${model}`;
      const existing = aggregated.get(key);
      if (existing === undefined) {
        aggregated.set(key, {
          model,
          family,
          totalTokens: upstreamModel.totals.total_tokens,
          inputTokens: upstreamModel.totals.input_tokens,
          outputTokens: upstreamModel.totals.output_tokens
        });
        continue;
      }
      existing.totalTokens = checkedTokenSum(
        existing.totalTokens,
        upstreamModel.totals.total_tokens
      );
      existing.inputTokens = checkedTokenSum(
        existing.inputTokens,
        upstreamModel.totals.input_tokens
      );
      existing.outputTokens = checkedTokenSum(
        existing.outputTokens,
        upstreamModel.totals.output_tokens
      );
    }
  }

  const models = [...aggregated.values()]
    .sort(
      (left, right) =>
        right.totalTokens - left.totalTokens ||
        left.family.localeCompare(right.family) ||
        left.model.localeCompare(right.model)
    )
    .slice(0, limit)
    .map(
      (model): TokenMonsterModelUsageEntry =>
        Object.freeze({
          model: model.model,
          family: model.family,
          totalTokens: model.totalTokens,
          inputTokens: model.inputTokens,
          outputTokens: model.outputTokens
        })
    );

  return Object.freeze({ models: Object.freeze(models) });
}
