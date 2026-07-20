import { z } from "zod";

export const MONSTER_ENGINE_VERSION_V1 = "0.1.5" as const;
export const MONSTER_FOOTPRINT_SCHEMA_VERSION_V1 = "1" as const;
export const MAX_SAFE_TOKEN_DECIMAL_V1 = "9007199254740991" as const;
export const FOOTPRINT_WINDOW_DAYS_V1 = 28;

const MILLISECONDS_PER_DAY = 86_400_000;
const LOCAL_DATE_PATTERN = /^(20[2-9]\d)-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const IANA_TIMEZONE_PATTERN =
  /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,15})$/;

function isRuntimeSupportedIanaTimezone(value: string): boolean {
  if (value === "UTC") {
    return true;
  }
  if (!IANA_TIMEZONE_PATTERN.test(value)) {
    return false;
  }

  try {
    // Intl performs a lookup in the runtime's IANA timezone database. Merely
    // matching the slash-separated shape would let invented zones claim exact
    // local/DST quality and incorrectly unlock time-derived traits.
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch (error: unknown) {
    if (error instanceof RangeError) {
      return false;
    }
    throw error;
  }
}

function localDateTimestamp(value: string): number | null {
  if (!LOCAL_DATE_PATTERN.test(value)) {
    return null;
  }

  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : null;
}

export const SafeTokenDecimalV1Schema = z
  .string()
  .regex(
    DECIMAL_PATTERN,
    "Token counts must be canonical non-negative base-10 integer strings.",
  )
  .refine(
    (value) =>
      !DECIMAL_PATTERN.test(value) ||
      BigInt(value) <= BigInt(MAX_SAFE_TOKEN_DECIMAL_V1),
    "Token counts must not exceed Number.MAX_SAFE_INTEGER.",
  );

export type SafeTokenDecimalV1 = z.infer<typeof SafeTokenDecimalV1Schema>;

const TokenCountsV1BaseSchema = z.strictObject({
  input: SafeTokenDecimalV1Schema,
  output: SafeTokenDecimalV1Schema,
  cacheRead: SafeTokenDecimalV1Schema,
  cacheWrite: SafeTokenDecimalV1Schema,
  reasoning: SafeTokenDecimalV1Schema,
  other: SafeTokenDecimalV1Schema,
  total: SafeTokenDecimalV1Schema,
});

export type MonsterTokenCountsV1 = z.infer<typeof TokenCountsV1BaseSchema>;

export const MonsterTokenCountsV1Schema = TokenCountsV1BaseSchema.superRefine(
  (counts, context) => {
    const values = Object.values(counts);
    if (
      values.some(
        (value) =>
          !DECIMAL_PATTERN.test(value) ||
          BigInt(value) > BigInt(MAX_SAFE_TOKEN_DECIMAL_V1),
      )
    ) {
      return;
    }

    if (BigInt(counts.reasoning) > BigInt(counts.output)) {
      context.addIssue({
        code: "custom",
        path: ["reasoning"],
        message: "reasoning must be an informational subset of output.",
      });
    }

    const expectedTotal =
      BigInt(counts.input) +
      BigInt(counts.output) +
      BigInt(counts.cacheRead) +
      BigInt(counts.cacheWrite) +
      BigInt(counts.other);

    if (expectedTotal !== BigInt(counts.total)) {
      context.addIssue({
        code: "custom",
        path: ["total"],
        message:
          "total must equal input + output + cacheRead + cacheWrite + other; reasoning is already included in output.",
      });
    }
  },
);

export const MONSTER_CHARACTER_IDS_V1 = [
  "chatgpt",
  "claude",
  "gemini",
  "grok",
] as const;

export const MonsterCharacterIdV1Schema = z.enum(MONSTER_CHARACTER_IDS_V1);
export type MonsterCharacterIdV1 = z.infer<typeof MonsterCharacterIdV1Schema>;

export const MONSTER_PROVIDERS_V1 = [
  "anthropic",
  "google",
  "openai",
  "openrouter",
  "xai",
  "other",
] as const;

export const MonsterProviderV1Schema = z.enum(MONSTER_PROVIDERS_V1);
export type MonsterProviderV1 = z.infer<typeof MonsterProviderV1Schema>;

export const MONSTER_MODEL_FAMILIES_V1 = [
  "claude-haiku",
  "claude-sonnet",
  "claude-opus",
  "anthropic-other",
  "gemini-flash",
  "gemini-pro",
  "google-other",
  "openai-codex",
  "gpt-5",
  "gpt-4o",
  "gpt-4",
  "o1",
  "o3",
  "o4",
  "openai-other",
  "grok",
  "xai-other",
  "openrouter-other",
  "other",
] as const;

export const MonsterModelFamilyV1Schema = z.enum(MONSTER_MODEL_FAMILIES_V1);
export type MonsterModelFamilyV1 = z.infer<typeof MonsterModelFamilyV1Schema>;

export const MONSTER_TOOLS_V1 = [
  "claude-code",
  "codex-cli",
  "gemini-cli",
  "grok-build",
  "cursor",
  "vscode-copilot",
  "jetbrains-ai",
  "browser",
  "other",
] as const;

export const MonsterToolV1Schema = z.enum(MONSTER_TOOLS_V1);
export type MonsterToolV1 = z.infer<typeof MonsterToolV1Schema>;

export const MONSTER_CLI_TOOLS_V1 = [
  "claude-code",
  "codex-cli",
  "gemini-cli",
  "grok-build",
] as const satisfies readonly MonsterToolV1[];

export const LocalDateV1Schema = z
  .string()
  .refine(
    (value) => localDateTimestamp(value) !== null,
    "Dates must be valid YYYY-MM-DD local calendar dates from 2020 through 2099.",
  );

export const FootprintWindowV1Schema = z
  .strictObject({
    from: LocalDateV1Schema,
    to: LocalDateV1Schema,
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine(
        isRuntimeSupportedIanaTimezone,
        "timezone must be UTC or an IANA timezone supported by this runtime.",
      ),
  })
  .superRefine((window, context) => {
    const from = localDateTimestamp(window.from);
    const to = localDateTimestamp(window.to);
    if (from === null || to === null) {
      return;
    }

    if ((to - from) / MILLISECONDS_PER_DAY !== FOOTPRINT_WINDOW_DAYS_V1 - 1) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "The identity footprint window must span exactly 28 dates.",
      });
    }
  });

export type FootprintWindowV1 = z.infer<typeof FootprintWindowV1Schema>;

export const DailyDimensionAggregateV1Schema = z
  .strictObject({
    provider: MonsterProviderV1Schema,
    modelFamily: MonsterModelFamilyV1Schema,
    tool: MonsterToolV1Schema,
    valueQuality: z.enum(["exact", "estimated"]),
    cacheReadAvailability: z.enum(["observed", "unavailable"]),
    tokens: MonsterTokenCountsV1Schema,
  })
  .superRefine((aggregate, context) => {
    const validModelFamiliesByProvider: Readonly<
      Record<MonsterProviderV1, readonly MonsterModelFamilyV1[]>
    > = {
      anthropic: [
        "claude-haiku",
        "claude-sonnet",
        "claude-opus",
        "anthropic-other",
      ],
      google: ["gemini-flash", "gemini-pro", "google-other"],
      openai: [
        "openai-codex",
        "gpt-5",
        "gpt-4o",
        "gpt-4",
        "o1",
        "o3",
        "o4",
        "openai-other",
      ],
      openrouter: ["openrouter-other"],
      xai: ["grok", "xai-other"],
      other: ["other"],
    };
    if (
      !validModelFamiliesByProvider[aggregate.provider].includes(
        aggregate.modelFamily,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["modelFamily"],
        message:
          "modelFamily must be a coarse family allowed for its normalized provider.",
      });
    }

    if (
      aggregate.cacheReadAvailability === "unavailable" &&
      aggregate.tokens.cacheRead !== "0"
    ) {
      context.addIssue({
        code: "custom",
        path: ["tokens", "cacheRead"],
        message: "cacheRead must be zero when cache coverage is unavailable.",
      });
    }
  });

export type DailyDimensionAggregateV1 = z.infer<
  typeof DailyDimensionAggregateV1Schema
>;

export const FootprintDayV1Schema = z
  .strictObject({
    localDate: LocalDateV1Schema,
    coverage: z.enum(["observed", "unavailable"]),
    aggregates: z.array(DailyDimensionAggregateV1Schema).max(64),
  })
  .superRefine((day, context) => {
    if (day.coverage === "unavailable" && day.aggregates.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["aggregates"],
        message: "Unavailable days cannot contain usage aggregates.",
      });
    }

    const seen = new Set<string>();
    day.aggregates.forEach((aggregate, index) => {
      const key = [
        aggregate.provider,
        aggregate.modelFamily,
        aggregate.tool,
      ].join("|");
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["aggregates", index],
          message: "A day cannot contain duplicate aggregate dimensions.",
        });
      }
      seen.add(key);
    });
  });

export type FootprintDayV1 = z.infer<typeof FootprintDayV1Schema>;

export const LocalHourlyRhythmV1Schema = z
  .strictObject({
    schemaVersion: z.literal("1"),
    coverage: z.literal("complete-local-days"),
    timeQuality: z.enum(["exact-iana-local", "estimated-local", "utc-only"]),
    dstQuality: z.enum(["timezone-aware", "fixed-offset", "unknown"]),
    observedDays: z.number().int().min(0).max(FOOTPRINT_WINDOW_DAYS_V1),
    hours: z
      .array(
        z.strictObject({
          hour: z.number().int().min(0).max(23),
          tokens: SafeTokenDecimalV1Schema,
        }),
      )
      .length(24),
  })
  .superRefine((rhythm, context) => {
    rhythm.hours.forEach((hour, index) => {
      if (hour.hour !== index) {
        context.addIssue({
          code: "custom",
          path: ["hours", index, "hour"],
          message: "Hourly rhythm buckets must be canonical and ordered 0–23.",
        });
      }
    });

    if (
      rhythm.observedDays === 0 &&
      rhythm.hours.some((hour) => hour.tokens !== "0")
    ) {
      context.addIssue({
        code: "custom",
        path: ["hours"],
        message: "Hourly tokens require at least one completely observed day.",
      });
    }
  });

export type LocalHourlyRhythmV1 = z.infer<typeof LocalHourlyRhythmV1Schema>;

const DAILY_FOOTPRINT_SHAPE = {
  schemaVersion: z.literal(MONSTER_FOOTPRINT_SCHEMA_VERSION_V1),
  characterId: MonsterCharacterIdV1Schema,
  window: FootprintWindowV1Schema,
  days: z.array(FootprintDayV1Schema).length(FOOTPRINT_WINDOW_DAYS_V1),
} as const;

function validateDailyFootprint(
  footprint: {
    window: FootprintWindowV1;
    days: FootprintDayV1[];
  },
  context: z.core.$RefinementCtx,
): void {
  const from = localDateTimestamp(footprint.window.from);
  if (from === null) {
    return;
  }

  footprint.days.forEach((day, index) => {
    const expectedDate = new Date(from + index * MILLISECONDS_PER_DAY)
      .toISOString()
      .slice(0, 10);
    if (day.localDate !== expectedDate) {
      context.addIssue({
        code: "custom",
        path: ["days", index, "localDate"],
        message: "Footprint days must be canonical, contiguous, and ordered.",
      });
    }
  });
}

/**
 * Daily-only analytical form. It intentionally has no hourly field. This is
 * not the public ingestion wire contract; cloud upload must use
 * @tokenmonster/contracts instead.
 */
export const DailyContentBlindFootprintV1Schema = z
  .strictObject(DAILY_FOOTPRINT_SHAPE)
  .superRefine(validateDailyFootprint);

export type DailyContentBlindFootprintV1 = z.infer<
  typeof DailyContentBlindFootprintV1Schema
>;

export const ContentBlindFootprintV1Schema = z
  .strictObject({
    ...DAILY_FOOTPRINT_SHAPE,
    latestDayCompleteness: z.enum(["complete", "partial"]),
    localHourlyRhythm: LocalHourlyRhythmV1Schema.optional(),
  })
  .superRefine((footprint, context) => {
    validateDailyFootprint(footprint, context);
    const observedDays = footprint.days.filter(
      (day) => day.coverage === "observed",
    ).length;
    if (
      footprint.localHourlyRhythm !== undefined &&
      footprint.localHourlyRhythm.observedDays > observedDays
    ) {
      context.addIssue({
        code: "custom",
        path: ["localHourlyRhythm", "observedDays"],
        message:
          "Hourly complete-day coverage cannot exceed observed daily coverage.",
      });
    }
  });

export type ContentBlindFootprintV1 = z.infer<
  typeof ContentBlindFootprintV1Schema
>;

export const MONSTER_TRAIT_IDS_V1 = [
  "cli-focused",
  "tool-focused",
  "multi-tool",
  "provider-focused",
  "multi-provider",
  "cache-savvy",
  "output-heavy",
  "night-oriented",
  "balanced",
] as const;

export const MonsterTraitIdV1Schema = z.enum(MONSTER_TRAIT_IDS_V1);
export type MonsterTraitIdV1 = z.infer<typeof MonsterTraitIdV1Schema>;

export const MONSTER_MOOD_IDS_V1 = [
  "learning",
  "unknown",
  "resting",
  "quiet",
  "steady",
  "lively",
] as const;

export const MonsterMoodIdV1Schema = z.enum(MONSTER_MOOD_IDS_V1);
export type MonsterMoodIdV1 = z.infer<typeof MonsterMoodIdV1Schema>;

export const MONSTER_REASON_CODES_V1 = [
  "IDENTITY_LEARNING_COVERAGE_28D",
  "IDENTITY_LEARNING_EVIDENCE_28D",
  "IDENTITY_READY_COVERAGE_28D",
  "IDENTITY_HELD_SAME_WINDOW",
  "IDENTITY_HELD_EVIDENCE_GRACE_7D",
  "IDENTITY_PROVISIONAL_DAILY_LIMIT",
  "TRAIT_CLI_FOCUS_28D",
  "TRAIT_TOOL_FOCUS_28D",
  "TRAIT_MULTI_TOOL_28D",
  "TRAIT_PROVIDER_FOCUS_28D",
  "TRAIT_MULTI_PROVIDER_28D",
  "TRAIT_CACHE_SAVVY_28D",
  "TRAIT_OUTPUT_HEAVY_28D",
  "TRAIT_NIGHT_ORIENTED_LOCAL_28D",
  "TRAIT_BALANCED_FALLBACK_28D",
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

export const MonsterReasonCodeV1Schema = z.enum(MONSTER_REASON_CODES_V1);
export type MonsterReasonCodeV1 = z.infer<typeof MonsterReasonCodeV1Schema>;

export const MONSTER_TEMPLATE_IDS_V1 = [
  "monster.identity.learning.v1",
  "monster.identity.learningEvidence.v1",
  "monster.identity.ready.v1",
  "monster.identity.heldSameWindow.v1",
  "monster.identity.heldEvidenceGrace.v1",
  "monster.identity.provisionalDailyLimit.v1",
  "monster.trait.cliFocused.v1",
  "monster.trait.toolFocused.v1",
  "monster.trait.multiTool.v1",
  "monster.trait.providerFocused.v1",
  "monster.trait.multiProvider.v1",
  "monster.trait.cacheSavvy.v1",
  "monster.trait.outputHeavy.v1",
  "monster.trait.nightOriented.v1",
  "monster.trait.balanced.v1",
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

export const MonsterTemplateIdV1Schema = z.enum(MONSTER_TEMPLATE_IDS_V1);
export type MonsterTemplateIdV1 = z.infer<typeof MonsterTemplateIdV1Schema>;

export const MonsterCoverageBandV1Schema = z.enum([
  "insufficient",
  "partial",
  "good",
  "full",
]);
export type MonsterCoverageBandV1 = z.infer<typeof MonsterCoverageBandV1Schema>;

export const MonsterMetricV1Schema = z.enum([
  "observed-days",
  "active-days",
  "cli-share",
  "top-tool-share",
  "tool-diversity",
  "top-provider-share",
  "provider-diversity",
  "cache-observation",
  "cache-share",
  "output-share",
  "local-hour-coverage",
  "local-hour-quality",
  "local-night-share",
  "relative-daily-activity",
  "trait-structure",
]);
export type MonsterMetricV1 = z.infer<typeof MonsterMetricV1Schema>;

export const MonsterValueBandV1Schema = z.enum([
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
]);
export type MonsterValueBandV1 = z.infer<typeof MonsterValueBandV1Schema>;

export const MonsterExplanationInputV1Schema = z.strictObject({
  metric: MonsterMetricV1Schema,
  valueBand: MonsterValueBandV1Schema,
  coverage: MonsterCoverageBandV1Schema,
});

export type MonsterExplanationInputV1 = z.infer<
  typeof MonsterExplanationInputV1Schema
>;

export const MonsterExplanationIdV1Schema = z
  .string()
  .regex(/^monster-v1:[0-9]{4}-[0-9]{2}-[0-9]{2}:[a-z]+:[0-9]+$/);

export const MONSTER_EXPLANATION_STATE_VALUES_V1 = [
  "learning",
  "ready",
  ...MONSTER_TRAIT_IDS_V1,
  ...MONSTER_MOOD_IDS_V1,
  "awaiting-coverage",
  "initial-profile",
  "coverage-complete",
  "identity-shift",
  "weekly-review",
  "no-change",
] as const;

export const MonsterExplanationStateValueV1Schema = z.enum(
  MONSTER_EXPLANATION_STATE_VALUES_V1,
);
export type MonsterExplanationStateValueV1 = z.infer<
  typeof MonsterExplanationStateValueV1Schema
>;

type MonsterExplanationSubjectV1 = "identity" | "trait" | "mood" | "evolution";

const MONSTER_EXPLANATION_SEMANTIC_RULES_V1 = {
  IDENTITY_LEARNING_COVERAGE_28D: {
    subject: "identity",
    templateId: "monster.identity.learning.v1",
    allowedAfter: ["learning"],
  },
  IDENTITY_LEARNING_EVIDENCE_28D: {
    subject: "identity",
    templateId: "monster.identity.learningEvidence.v1",
    allowedAfter: ["learning"],
  },
  IDENTITY_READY_COVERAGE_28D: {
    subject: "identity",
    templateId: "monster.identity.ready.v1",
    allowedAfter: ["ready"],
  },
  IDENTITY_HELD_SAME_WINDOW: {
    subject: "identity",
    templateId: "monster.identity.heldSameWindow.v1",
    allowedAfter: ["learning", "ready"],
  },
  IDENTITY_HELD_EVIDENCE_GRACE_7D: {
    subject: "identity",
    templateId: "monster.identity.heldEvidenceGrace.v1",
    allowedAfter: ["ready"],
  },
  IDENTITY_PROVISIONAL_DAILY_LIMIT: {
    subject: "identity",
    templateId: "monster.identity.provisionalDailyLimit.v1",
    allowedAfter: ["ready"],
  },
  TRAIT_CLI_FOCUS_28D: {
    subject: "trait",
    templateId: "monster.trait.cliFocused.v1",
    allowedAfter: ["cli-focused"],
  },
  TRAIT_TOOL_FOCUS_28D: {
    subject: "trait",
    templateId: "monster.trait.toolFocused.v1",
    allowedAfter: ["tool-focused"],
  },
  TRAIT_MULTI_TOOL_28D: {
    subject: "trait",
    templateId: "monster.trait.multiTool.v1",
    allowedAfter: ["multi-tool"],
  },
  TRAIT_PROVIDER_FOCUS_28D: {
    subject: "trait",
    templateId: "monster.trait.providerFocused.v1",
    allowedAfter: ["provider-focused"],
  },
  TRAIT_MULTI_PROVIDER_28D: {
    subject: "trait",
    templateId: "monster.trait.multiProvider.v1",
    allowedAfter: ["multi-provider"],
  },
  TRAIT_CACHE_SAVVY_28D: {
    subject: "trait",
    templateId: "monster.trait.cacheSavvy.v1",
    allowedAfter: ["cache-savvy"],
  },
  TRAIT_OUTPUT_HEAVY_28D: {
    subject: "trait",
    templateId: "monster.trait.outputHeavy.v1",
    allowedAfter: ["output-heavy"],
  },
  TRAIT_NIGHT_ORIENTED_LOCAL_28D: {
    subject: "trait",
    templateId: "monster.trait.nightOriented.v1",
    allowedAfter: ["night-oriented"],
  },
  TRAIT_BALANCED_FALLBACK_28D: {
    subject: "trait",
    templateId: "monster.trait.balanced.v1",
    allowedAfter: ["balanced"],
  },
  TRAIT_HELD_SAME_WINDOW: {
    subject: "trait",
    templateId: "monster.trait.heldSameWindow.v1",
    allowedAfter: MONSTER_TRAIT_IDS_V1,
  },
  TRAIT_HELD_EVIDENCE_GRACE_7D: {
    subject: "trait",
    templateId: "monster.trait.heldEvidenceGrace.v1",
    allowedAfter: MONSTER_TRAIT_IDS_V1,
  },
  TRAIT_HELD_DAILY_LIMIT: {
    subject: "trait",
    templateId: "monster.trait.heldDailyLimit.v1",
    allowedAfter: MONSTER_TRAIT_IDS_V1,
  },
  MOOD_LEARNING_COVERAGE_28D: {
    subject: "mood",
    templateId: "monster.mood.learning.v1",
    allowedAfter: ["learning"],
  },
  MOOD_TODAY_UNAVAILABLE: {
    subject: "mood",
    templateId: "monster.mood.unknown.v1",
    allowedAfter: ["unknown"],
  },
  MOOD_RESTING_TODAY: {
    subject: "mood",
    templateId: "monster.mood.resting.v1",
    allowedAfter: ["resting"],
  },
  MOOD_RELATIVE_ACTIVITY_LOW: {
    subject: "mood",
    templateId: "monster.mood.quiet.v1",
    allowedAfter: ["quiet"],
  },
  MOOD_RELATIVE_ACTIVITY_STABLE: {
    subject: "mood",
    templateId: "monster.mood.steady.v1",
    allowedAfter: ["steady"],
  },
  MOOD_RELATIVE_ACTIVITY_HIGH: {
    subject: "mood",
    templateId: "monster.mood.lively.v1",
    allowedAfter: ["lively"],
  },
  EVOLUTION_AWAITING_COVERAGE: {
    subject: "evolution",
    templateId: "monster.evolution.awaitingCoverage.v1",
    allowedAfter: ["awaiting-coverage"],
  },
  EVOLUTION_INITIAL_PROFILE: {
    subject: "evolution",
    templateId: "monster.evolution.initialProfile.v1",
    allowedAfter: ["initial-profile"],
  },
  EVOLUTION_COVERAGE_COMPLETE: {
    subject: "evolution",
    templateId: "monster.evolution.coverageComplete.v1",
    allowedAfter: ["coverage-complete"],
  },
  EVOLUTION_IDENTITY_SHIFT: {
    subject: "evolution",
    templateId: "monster.evolution.identityShift.v1",
    allowedAfter: ["identity-shift"],
  },
  EVOLUTION_WEEKLY_REVIEW: {
    subject: "evolution",
    templateId: "monster.evolution.weeklyReview.v1",
    allowedAfter: ["weekly-review"],
  },
  EVOLUTION_NO_CHANGE: {
    subject: "evolution",
    templateId: "monster.evolution.noChange.v1",
    allowedAfter: ["no-change"],
  },
} as const satisfies Readonly<
  Record<
    MonsterReasonCodeV1,
    Readonly<{
      subject: MonsterExplanationSubjectV1;
      templateId: MonsterTemplateIdV1;
      allowedAfter: readonly MonsterExplanationStateValueV1[];
    }>
  >
>;

interface MonsterExplanationInputSemanticRuleV1 {
  readonly metric: MonsterMetricV1;
  readonly allowedBands: readonly (readonly [
    MonsterValueBandV1,
    MonsterCoverageBandV1,
  ])[];
}

const ANY_COVERAGE_BANDS_V1 = [
  "insufficient",
  "partial",
  "good",
  "full",
] as const satisfies readonly MonsterCoverageBandV1[];
const READY_COVERAGE_BANDS_V1 = [
  "partial",
  "good",
  "full",
] as const satisfies readonly MonsterCoverageBandV1[];

function allowedInputBands(
  valueBand: MonsterValueBandV1,
  coverageBands: readonly MonsterCoverageBandV1[],
): readonly (readonly [MonsterValueBandV1, MonsterCoverageBandV1])[] {
  return coverageBands.map(
    (coverageBand) => [valueBand, coverageBand] as const,
  );
}

const INSUFFICIENT_INPUT_BAND_V1 = allowedInputBands("insufficient", [
  "insufficient",
]);
const AVAILABLE_READY_INPUT_BANDS_V1 = allowedInputBands(
  "available",
  READY_COVERAGE_BANDS_V1,
);
const AVAILABLE_OR_INSUFFICIENT_INPUT_BANDS_V1 = [
  ...INSUFFICIENT_INPUT_BAND_V1,
  ...AVAILABLE_READY_INPUT_BANDS_V1,
] as const;

const MONSTER_EXPLANATION_INPUT_RULES_V1 = {
  IDENTITY_LEARNING_COVERAGE_28D: {
    inputs: [
      { metric: "observed-days", allowedBands: INSUFFICIENT_INPUT_BAND_V1 },
      { metric: "active-days", allowedBands: INSUFFICIENT_INPUT_BAND_V1 },
    ],
    equalCoverageGroups: [[0, 1]],
  },
  IDENTITY_LEARNING_EVIDENCE_28D: {
    inputs: [
      { metric: "observed-days", allowedBands: AVAILABLE_READY_INPUT_BANDS_V1 },
      { metric: "active-days", allowedBands: AVAILABLE_READY_INPUT_BANDS_V1 },
      {
        metric: "trait-structure",
        allowedBands: allowedInputBands("unavailable", ["insufficient"]),
      },
    ],
    equalCoverageGroups: [[0, 1]],
  },
  IDENTITY_READY_COVERAGE_28D: {
    inputs: [
      { metric: "observed-days", allowedBands: AVAILABLE_READY_INPUT_BANDS_V1 },
      { metric: "active-days", allowedBands: AVAILABLE_READY_INPUT_BANDS_V1 },
    ],
    equalCoverageGroups: [[0, 1]],
  },
  IDENTITY_HELD_SAME_WINDOW: {
    inputs: [
      { metric: "observed-days", allowedBands: AVAILABLE_READY_INPUT_BANDS_V1 },
      { metric: "active-days", allowedBands: AVAILABLE_READY_INPUT_BANDS_V1 },
      {
        metric: "trait-structure",
        allowedBands: allowedInputBands("held", ANY_COVERAGE_BANDS_V1),
      },
    ],
    equalCoverageGroups: [[0, 1]],
  },
  IDENTITY_HELD_EVIDENCE_GRACE_7D: {
    inputs: [
      {
        metric: "observed-days",
        allowedBands: AVAILABLE_OR_INSUFFICIENT_INPUT_BANDS_V1,
      },
      {
        metric: "active-days",
        allowedBands: AVAILABLE_OR_INSUFFICIENT_INPUT_BANDS_V1,
      },
      {
        metric: "trait-structure",
        allowedBands: allowedInputBands("held", ANY_COVERAGE_BANDS_V1),
      },
    ],
    equalCoverageGroups: [[0, 1, 2]],
  },
  IDENTITY_PROVISIONAL_DAILY_LIMIT: {
    inputs: [
      { metric: "observed-days", allowedBands: AVAILABLE_READY_INPUT_BANDS_V1 },
      { metric: "active-days", allowedBands: AVAILABLE_READY_INPUT_BANDS_V1 },
      {
        metric: "trait-structure",
        allowedBands: allowedInputBands("provisional", READY_COVERAGE_BANDS_V1),
      },
    ],
    equalCoverageGroups: [[0, 1, 2]],
  },
  TRAIT_CLI_FOCUS_28D: {
    inputs: [
      {
        metric: "cli-share",
        allowedBands: allowedInputBands("high", READY_COVERAGE_BANDS_V1),
      },
    ],
  },
  TRAIT_TOOL_FOCUS_28D: {
    inputs: [
      {
        metric: "top-tool-share",
        allowedBands: [
          ...allowedInputBands("high", READY_COVERAGE_BANDS_V1),
          ...allowedInputBands("concentrated", READY_COVERAGE_BANDS_V1),
        ],
      },
    ],
  },
  TRAIT_MULTI_TOOL_28D: {
    inputs: [
      {
        metric: "tool-diversity",
        allowedBands: allowedInputBands("diverse", READY_COVERAGE_BANDS_V1),
      },
    ],
  },
  TRAIT_PROVIDER_FOCUS_28D: {
    inputs: [
      {
        metric: "top-provider-share",
        allowedBands: allowedInputBands("high", READY_COVERAGE_BANDS_V1),
      },
    ],
  },
  TRAIT_MULTI_PROVIDER_28D: {
    inputs: [
      {
        metric: "provider-diversity",
        allowedBands: allowedInputBands("diverse", READY_COVERAGE_BANDS_V1),
      },
    ],
  },
  TRAIT_CACHE_SAVVY_28D: {
    inputs: [
      {
        metric: "cache-share",
        allowedBands: allowedInputBands("high", READY_COVERAGE_BANDS_V1),
      },
      {
        metric: "cache-observation",
        allowedBands: AVAILABLE_READY_INPUT_BANDS_V1,
      },
    ],
    equalCoverageGroups: [[0, 1]],
  },
  TRAIT_OUTPUT_HEAVY_28D: {
    inputs: [
      {
        metric: "output-share",
        allowedBands: allowedInputBands("high", READY_COVERAGE_BANDS_V1),
      },
    ],
  },
  TRAIT_NIGHT_ORIENTED_LOCAL_28D: {
    inputs: [
      {
        metric: "local-night-share",
        allowedBands: allowedInputBands("high", READY_COVERAGE_BANDS_V1),
      },
      {
        metric: "local-hour-coverage",
        allowedBands: AVAILABLE_READY_INPUT_BANDS_V1,
      },
      {
        metric: "local-hour-quality",
        allowedBands: AVAILABLE_READY_INPUT_BANDS_V1,
      },
    ],
    equalCoverageGroups: [[0, 1, 2]],
  },
  TRAIT_BALANCED_FALLBACK_28D: {
    inputs: [
      {
        metric: "top-provider-share",
        allowedBands: allowedInputBands("balanced", READY_COVERAGE_BANDS_V1),
      },
    ],
  },
  TRAIT_HELD_SAME_WINDOW: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: allowedInputBands("held", READY_COVERAGE_BANDS_V1),
      },
    ],
  },
  TRAIT_HELD_EVIDENCE_GRACE_7D: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: allowedInputBands("held", ANY_COVERAGE_BANDS_V1),
      },
    ],
  },
  TRAIT_HELD_DAILY_LIMIT: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: allowedInputBands("provisional", READY_COVERAGE_BANDS_V1),
      },
    ],
  },
  MOOD_LEARNING_COVERAGE_28D: {
    inputs: [
      {
        metric: "relative-daily-activity",
        allowedBands: INSUFFICIENT_INPUT_BAND_V1,
      },
    ],
  },
  MOOD_TODAY_UNAVAILABLE: {
    inputs: [
      {
        metric: "relative-daily-activity",
        allowedBands: allowedInputBands("unavailable", ANY_COVERAGE_BANDS_V1),
      },
    ],
  },
  MOOD_RESTING_TODAY: {
    inputs: [
      {
        metric: "relative-daily-activity",
        allowedBands: allowedInputBands("inactive", ANY_COVERAGE_BANDS_V1),
      },
    ],
  },
  MOOD_RELATIVE_ACTIVITY_LOW: {
    inputs: [
      {
        metric: "relative-daily-activity",
        allowedBands: allowedInputBands(
          "below-baseline",
          ANY_COVERAGE_BANDS_V1,
        ),
      },
    ],
  },
  MOOD_RELATIVE_ACTIVITY_STABLE: {
    inputs: [
      {
        metric: "relative-daily-activity",
        allowedBands: allowedInputBands("near-baseline", ANY_COVERAGE_BANDS_V1),
      },
    ],
  },
  MOOD_RELATIVE_ACTIVITY_HIGH: {
    inputs: [
      {
        metric: "relative-daily-activity",
        allowedBands: allowedInputBands(
          "above-baseline",
          ANY_COVERAGE_BANDS_V1,
        ),
      },
    ],
  },
  EVOLUTION_AWAITING_COVERAGE: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: INSUFFICIENT_INPUT_BAND_V1,
      },
    ],
  },
  EVOLUTION_INITIAL_PROFILE: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: allowedInputBands("initial", READY_COVERAGE_BANDS_V1),
      },
    ],
  },
  EVOLUTION_COVERAGE_COMPLETE: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: allowedInputBands("changed", READY_COVERAGE_BANDS_V1),
      },
    ],
  },
  EVOLUTION_IDENTITY_SHIFT: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: allowedInputBands("changed", READY_COVERAGE_BANDS_V1),
      },
    ],
  },
  EVOLUTION_WEEKLY_REVIEW: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: allowedInputBands("stable", READY_COVERAGE_BANDS_V1),
      },
    ],
  },
  EVOLUTION_NO_CHANGE: {
    inputs: [
      {
        metric: "trait-structure",
        allowedBands: [
          ...allowedInputBands("held", ANY_COVERAGE_BANDS_V1),
          ...allowedInputBands("stable", ANY_COVERAGE_BANDS_V1),
        ],
      },
    ],
  },
} as const satisfies Readonly<
  Record<
    MonsterReasonCodeV1,
    Readonly<{
      inputs: readonly MonsterExplanationInputSemanticRuleV1[];
      equalCoverageGroups?: readonly (readonly number[])[];
    }>
  >
>;

const MONSTER_EXPLANATION_BEFORE_VALUES_BY_SUBJECT_V1 = {
  identity: ["learning", "ready"],
  trait: MONSTER_TRAIT_IDS_V1,
  mood: MONSTER_MOOD_IDS_V1,
  evolution: [
    "awaiting-coverage",
    "initial-profile",
    "coverage-complete",
    "identity-shift",
    "weekly-review",
    "no-change",
  ],
} as const satisfies Readonly<
  Record<MonsterExplanationSubjectV1, readonly MonsterExplanationStateValueV1[]>
>;

type MonsterExplanationBeforeSemanticRuleV1 =
  | Readonly<{ kind: "equals-after" }>
  | Readonly<{
      kind: "one-of";
      values: readonly (MonsterExplanationStateValueV1 | null)[];
    }>;

const MONSTER_EXPLANATION_BEFORE_RULES_V1: Readonly<
  Partial<Record<MonsterReasonCodeV1, MonsterExplanationBeforeSemanticRuleV1>>
> = {
  IDENTITY_HELD_SAME_WINDOW: { kind: "equals-after" },
  IDENTITY_HELD_EVIDENCE_GRACE_7D: {
    kind: "one-of",
    values: ["ready"],
  },
  IDENTITY_PROVISIONAL_DAILY_LIMIT: {
    kind: "one-of",
    values: ["ready"],
  },
  TRAIT_HELD_SAME_WINDOW: { kind: "equals-after" },
  TRAIT_HELD_EVIDENCE_GRACE_7D: { kind: "equals-after" },
  TRAIT_HELD_DAILY_LIMIT: { kind: "equals-after" },
  EVOLUTION_INITIAL_PROFILE: { kind: "one-of", values: [null] },
  EVOLUTION_COVERAGE_COMPLETE: {
    kind: "one-of",
    values: ["awaiting-coverage"],
  },
  EVOLUTION_WEEKLY_REVIEW: { kind: "one-of", values: ["no-change"] },
};

const IDENTITY_REASONS_REQUIRING_PROVISIONAL_V1 = [
  "IDENTITY_HELD_EVIDENCE_GRACE_7D",
  "IDENTITY_PROVISIONAL_DAILY_LIMIT",
] as const satisfies readonly MonsterReasonCodeV1[];

const IDENTITY_REASONS_FORBIDDING_PROVISIONAL_V1 = [
  "IDENTITY_LEARNING_COVERAGE_28D",
  "IDENTITY_LEARNING_EVIDENCE_28D",
  "IDENTITY_READY_COVERAGE_28D",
] as const satisfies readonly MonsterReasonCodeV1[];

export const MonsterExplanationV1Schema = z
  .strictObject({
    explanationId: MonsterExplanationIdV1Schema,
    engineVersion: z.literal(MONSTER_ENGINE_VERSION_V1),
    subject: z.enum(["identity", "trait", "mood", "evolution"]),
    reasonCode: MonsterReasonCodeV1Schema,
    window: FootprintWindowV1Schema,
    inputs: z.array(MonsterExplanationInputV1Schema).min(1).max(3),
    before: MonsterExplanationStateValueV1Schema.nullable(),
    after: MonsterExplanationStateValueV1Schema,
    templateId: MonsterTemplateIdV1Schema,
  })
  .superRefine((explanation, context) => {
    const rule = MONSTER_EXPLANATION_SEMANTIC_RULES_V1[explanation.reasonCode];
    if (explanation.subject !== rule.subject) {
      context.addIssue({
        code: "custom",
        path: ["subject"],
        message: "Explanation subject must match its reason code.",
      });
    }
    if (explanation.templateId !== rule.templateId) {
      context.addIssue({
        code: "custom",
        path: ["templateId"],
        message: "Explanation template must match its reason code.",
      });
    }
    if (
      !(
        rule.allowedAfter as readonly MonsterExplanationStateValueV1[]
      ).includes(explanation.after)
    ) {
      context.addIssue({
        code: "custom",
        path: ["after"],
        message: "Explanation result must match its reason code.",
      });
    }

    if (
      explanation.before !== null &&
      !(
        MONSTER_EXPLANATION_BEFORE_VALUES_BY_SUBJECT_V1[
          explanation.subject
        ] as readonly MonsterExplanationStateValueV1[]
      ).includes(explanation.before)
    ) {
      context.addIssue({
        code: "custom",
        path: ["before"],
        message: "Explanation prior state must match its subject.",
      });
    }

    const beforeRule =
      MONSTER_EXPLANATION_BEFORE_RULES_V1[explanation.reasonCode];
    if (
      (beforeRule?.kind === "equals-after" &&
        explanation.before !== explanation.after) ||
      (beforeRule?.kind === "one-of" &&
        !beforeRule.values.includes(explanation.before))
    ) {
      context.addIssue({
        code: "custom",
        path: ["before"],
        message: "Explanation prior state must match its reason code.",
      });
    }

    const inputRule =
      MONSTER_EXPLANATION_INPUT_RULES_V1[explanation.reasonCode];
    if (explanation.inputs.length !== inputRule.inputs.length) {
      context.addIssue({
        code: "custom",
        path: ["inputs"],
        message: "Explanation evidence must match its reason code.",
      });
      return;
    }
    explanation.inputs.forEach((input, index) => {
      const expected = inputRule.inputs[index]!;
      if (
        input.metric !== expected.metric ||
        !expected.allowedBands.some(
          ([valueBand, coverageBand]) =>
            input.valueBand === valueBand && input.coverage === coverageBand,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["inputs", index],
          message: "Explanation evidence must match its reason code.",
        });
      }
    });
    if ("equalCoverageGroups" in inputRule) {
      for (const group of inputRule.equalCoverageGroups) {
        const coverage = explanation.inputs[group[0]!]?.coverage;
        if (
          coverage === undefined ||
          group.some(
            (index) => explanation.inputs[index]?.coverage !== coverage,
          )
        ) {
          context.addIssue({
            code: "custom",
            path: ["inputs"],
            message:
              "Explanation evidence produced by one coverage authority must agree.",
          });
        }
      }
    }

    if (
      explanation.reasonCode === "IDENTITY_HELD_SAME_WINDOW" &&
      ((explanation.after === "ready" &&
        explanation.inputs[2]?.coverage !== explanation.inputs[0]?.coverage) ||
        (explanation.after === "learning" &&
          explanation.inputs[2]?.coverage !== "insufficient"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["inputs", 2, "coverage"],
        message:
          "Held identity evidence must match the visible identity state.",
      });
    }
  });

export type MonsterExplanationV1 = z.infer<typeof MonsterExplanationV1Schema>;

export const MonsterTraitV1Schema = z.strictObject({
  id: MonsterTraitIdV1Schema,
  explanationId: MonsterExplanationIdV1Schema,
});
export type MonsterTraitV1 = z.infer<typeof MonsterTraitV1Schema>;

export const MonsterStateV1Schema = z
  .strictObject({
    schemaVersion: z.literal("1"),
    engineVersion: z.literal(MONSTER_ENGINE_VERSION_V1),
    characterId: MonsterCharacterIdV1Schema,
    window: FootprintWindowV1Schema,
    identityStatus: z.enum(["learning", "ready"]),
    coverageBand: MonsterCoverageBandV1Schema,
    identityExplanationId: MonsterExplanationIdV1Schema,
    identityContinuity: z.strictObject({
      schemaVersion: z.literal("1"),
      lastIdentityReviewDate: LocalDateV1Schema,
      evidenceLossStartedDate: LocalDateV1Schema.nullable(),
      provisional: z.boolean(),
    }),
    traits: z.array(MonsterTraitV1Schema).max(3),
    mood: z.strictObject({
      id: MonsterMoodIdV1Schema,
      explanationId: MonsterExplanationIdV1Schema,
    }),
    evolution: z.strictObject({
      cadence: z.enum(["weekly", "event", "none"]),
      event: z.enum([
        "awaiting-coverage",
        "initial-profile",
        "coverage-complete",
        "identity-shift",
        "weekly-review",
        "no-change",
      ]),
      explanationId: MonsterExplanationIdV1Schema,
    }),
    appearance: z.strictObject({
      energyBand: z.enum(["dormant", "low", "medium", "high"]),
    }),
  })
  .superRefine((state, context) => {
    const expectedEnergyBand = {
      learning: "dormant",
      unknown: "dormant",
      resting: "dormant",
      quiet: "low",
      steady: "medium",
      lively: "high",
    } as const satisfies Readonly<
      Record<MonsterMoodIdV1, "dormant" | "low" | "medium" | "high">
    >;
    if (state.appearance.energyBand !== expectedEnergyBand[state.mood.id]) {
      context.addIssue({
        code: "custom",
        path: ["appearance", "energyBand"],
        message: "Appearance energy must match the visible mood.",
      });
    }

    const expectedTraitCount = state.identityStatus === "ready";
    if (expectedTraitCount && state.traits.length < 1) {
      context.addIssue({
        code: "custom",
        path: ["traits"],
        message: "Ready identity states require one to three traits.",
      });
    }
    if (!expectedTraitCount && state.traits.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["traits"],
        message: "Learning states do not assert analytical traits.",
      });
    }
    if (
      state.identityStatus === "learning" &&
      state.coverageBand !== "insufficient"
    ) {
      context.addIssue({
        code: "custom",
        path: ["coverageBand"],
        message: "Learning identities require insufficient coverage.",
      });
    }

    if (
      new Set(state.traits.map((trait) => trait.id)).size !==
      state.traits.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["traits"],
        message: "Identity traits must be unique.",
      });
    }

    const reviewDate = localDateTimestamp(
      state.identityContinuity.lastIdentityReviewDate,
    );
    const windowEnd = localDateTimestamp(state.window.to);
    if (reviewDate !== null && windowEnd !== null && reviewDate > windowEnd) {
      context.addIssue({
        code: "custom",
        path: ["identityContinuity", "lastIdentityReviewDate"],
        message: "The last identity review cannot be in the state's future.",
      });
    }
    if (
      state.identityStatus === "ready" &&
      reviewDate !== null &&
      windowEnd !== null &&
      (windowEnd - reviewDate) / MILLISECONDS_PER_DAY > 6
    ) {
      context.addIssue({
        code: "custom",
        path: ["identityContinuity", "lastIdentityReviewDate"],
        message:
          "A ready state must be reviewed at least once within the preceding six local dates.",
      });
    }

    const evidenceLossStartedDate =
      state.identityContinuity.evidenceLossStartedDate;
    const evidenceLossStarted =
      evidenceLossStartedDate === null
        ? null
        : localDateTimestamp(evidenceLossStartedDate);
    if (
      state.identityStatus === "ready" &&
      state.coverageBand === "insufficient" &&
      evidenceLossStartedDate === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["coverageBand"],
        message:
          "A ready identity may report insufficient coverage only during evidence-loss grace.",
      });
    }
    if (
      evidenceLossStarted !== null &&
      (windowEnd === null ||
        evidenceLossStarted > windowEnd ||
        (windowEnd - evidenceLossStarted) / MILLISECONDS_PER_DAY > 6)
    ) {
      context.addIssue({
        code: "custom",
        path: ["identityContinuity", "evidenceLossStartedDate"],
        message:
          "A ready evidence-loss grace may cover at most seven contiguous local dates.",
      });
    }
    if (
      evidenceLossStartedDate !== null &&
      (state.identityStatus !== "ready" ||
        !state.identityContinuity.provisional ||
        state.identityContinuity.lastIdentityReviewDate !==
          evidenceLossStartedDate)
    ) {
      context.addIssue({
        code: "custom",
        path: ["identityContinuity", "evidenceLossStartedDate"],
        message:
          "Evidence-loss grace requires a provisional ready identity reviewed when the grace began.",
      });
    }

    const expectedCadence =
      state.evolution.event === "weekly-review"
        ? "weekly"
        : state.evolution.event === "no-change"
          ? "none"
          : "event";
    if (state.evolution.cadence !== expectedCadence) {
      context.addIssue({
        code: "custom",
        path: ["evolution", "cadence"],
        message: "Evolution cadence must match the event kind.",
      });
    }
  });

export type MonsterStateV1 = z.infer<typeof MonsterStateV1Schema>;

export const MonsterRulesV1Schema = z.strictObject({
  engineVersion: z.literal(MONSTER_ENGINE_VERSION_V1),
});
export type MonsterRulesV1 = z.infer<typeof MonsterRulesV1Schema>;

export const DEFAULT_MONSTER_RULES_V1: Readonly<MonsterRulesV1> = Object.freeze(
  {
    engineVersion: MONSTER_ENGINE_VERSION_V1,
  },
);

export const MonsterDerivationV1Schema = z
  .strictObject({
    state: MonsterStateV1Schema,
    explanations: z.array(MonsterExplanationV1Schema).min(2).max(6),
  })
  .superRefine((derivation, context) => {
    const explanationsById = new Map(
      derivation.explanations.map((explanation) => [
        explanation.explanationId,
        explanation,
      ]),
    );
    if (explanationsById.size !== derivation.explanations.length) {
      context.addIssue({
        code: "custom",
        path: ["explanations"],
        message: "Explanation IDs must be unique within a derivation.",
      });
    }

    derivation.explanations.forEach((explanation, index) => {
      if (
        explanation.window.from !== derivation.state.window.from ||
        explanation.window.to !== derivation.state.window.to ||
        explanation.window.timezone !== derivation.state.window.timezone
      ) {
        context.addIssue({
          code: "custom",
          path: ["explanations", index, "window"],
          message: "Every explanation window must match the visible state.",
        });
      }
    });

    const references: ReadonlyArray<
      readonly [
        string,
        MonsterExplanationV1["subject"],
        MonsterExplanationStateValueV1,
        readonly PropertyKey[],
      ]
    > = [
      [
        derivation.state.identityExplanationId,
        "identity",
        derivation.state.identityStatus,
        ["state", "identityExplanationId"],
      ],
      ...derivation.state.traits.map(
        (trait, index) =>
          [
            trait.explanationId,
            "trait",
            trait.id,
            ["state", "traits", index, "explanationId"],
          ] as const,
      ),
      [
        derivation.state.mood.explanationId,
        "mood",
        derivation.state.mood.id,
        ["state", "mood", "explanationId"],
      ],
      [
        derivation.state.evolution.explanationId,
        "evolution",
        derivation.state.evolution.event,
        ["state", "evolution", "explanationId"],
      ],
    ];

    const referencedIds = new Set<string>();
    for (const [id, expectedSubject, expectedAfter, path] of references) {
      referencedIds.add(id);
      const explanation = explanationsById.get(id);
      if (explanation?.subject !== expectedSubject) {
        context.addIssue({
          code: "custom",
          path: [...path],
          message: `Referenced ${expectedSubject} explanation is missing or has the wrong subject.`,
        });
      } else if (explanation.after !== expectedAfter) {
        context.addIssue({
          code: "custom",
          path: [...path],
          message: `Referenced ${expectedSubject} explanation does not describe the visible state.`,
        });
      }
    }
    derivation.explanations.forEach((explanation, index) => {
      if (!referencedIds.has(explanation.explanationId)) {
        context.addIssue({
          code: "custom",
          path: ["explanations", index, "explanationId"],
          message: "Every explanation must be referenced by the visible state.",
        });
      }
    });

    const identityExplanation = explanationsById.get(
      derivation.state.identityExplanationId,
    );
    if (
      derivation.state.identityStatus === "ready" &&
      identityExplanation?.inputs[0]?.coverage !== derivation.state.coverageBand
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "coverageBand"],
        message:
          "Ready identity coverage must match its structured explanation evidence.",
      });
    }
    if (
      identityExplanation !== undefined &&
      (
        IDENTITY_REASONS_REQUIRING_PROVISIONAL_V1 as readonly MonsterReasonCodeV1[]
      ).includes(identityExplanation.reasonCode) &&
      !derivation.state.identityContinuity.provisional
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "identityContinuity", "provisional"],
        message: "Identity continuity must match its explanation reason.",
      });
    }
    if (
      identityExplanation !== undefined &&
      (
        IDENTITY_REASONS_FORBIDDING_PROVISIONAL_V1 as readonly MonsterReasonCodeV1[]
      ).includes(identityExplanation.reasonCode) &&
      derivation.state.identityContinuity.provisional
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "identityContinuity", "provisional"],
        message: "Identity continuity must match its explanation reason.",
      });
    }
    const traitExplanations = derivation.state.traits
      .map((trait) => explanationsById.get(trait.explanationId))
      .filter(
        (explanation): explanation is MonsterExplanationV1 =>
          explanation !== undefined,
      );
    const evidenceGraceActive =
      derivation.state.identityContinuity.evidenceLossStartedDate !== null;
    const identityUsesEvidenceGrace =
      identityExplanation?.reasonCode === "IDENTITY_HELD_EVIDENCE_GRACE_7D";
    const evidenceGraceTraitCount = traitExplanations.filter(
      (explanation) =>
        explanation.reasonCode === "TRAIT_HELD_EVIDENCE_GRACE_7D",
    ).length;
    if (
      evidenceGraceActive !== identityUsesEvidenceGrace ||
      (evidenceGraceActive &&
        evidenceGraceTraitCount !== derivation.state.traits.length) ||
      (!evidenceGraceActive && evidenceGraceTraitCount !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "identityContinuity", "evidenceLossStartedDate"],
        message:
          "Evidence-loss continuity must match every visible identity explanation.",
      });
    }
  });
export type MonsterDerivationV1 = z.infer<typeof MonsterDerivationV1Schema>;
