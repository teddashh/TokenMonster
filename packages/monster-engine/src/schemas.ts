import { z } from "zod";

export const MONSTER_ENGINE_VERSION_V1 = "0.1.0" as const;
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
    "Token counts must be canonical non-negative base-10 integer strings."
  )
  .refine(
    (value) =>
      !DECIMAL_PATTERN.test(value) ||
      BigInt(value) <= BigInt(MAX_SAFE_TOKEN_DECIMAL_V1),
    "Token counts must not exceed Number.MAX_SAFE_INTEGER."
  );

export type SafeTokenDecimalV1 = z.infer<typeof SafeTokenDecimalV1Schema>;

const TokenCountsV1BaseSchema = z.strictObject({
  input: SafeTokenDecimalV1Schema,
  output: SafeTokenDecimalV1Schema,
  cacheRead: SafeTokenDecimalV1Schema,
  cacheWrite: SafeTokenDecimalV1Schema,
  reasoning: SafeTokenDecimalV1Schema,
  other: SafeTokenDecimalV1Schema,
  total: SafeTokenDecimalV1Schema
});

export type MonsterTokenCountsV1 = z.infer<typeof TokenCountsV1BaseSchema>;

export const MonsterTokenCountsV1Schema = TokenCountsV1BaseSchema.superRefine(
  (counts, context) => {
    const values = Object.values(counts);
    if (
      values.some(
        (value) =>
          !DECIMAL_PATTERN.test(value) ||
          BigInt(value) > BigInt(MAX_SAFE_TOKEN_DECIMAL_V1)
      )
    ) {
      return;
    }

    if (BigInt(counts.reasoning) > BigInt(counts.output)) {
      context.addIssue({
        code: "custom",
        path: ["reasoning"],
        message: "reasoning must be an informational subset of output."
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
          "total must equal input + output + cacheRead + cacheWrite + other; reasoning is already included in output."
      });
    }
  }
);

export const MONSTER_CHARACTER_IDS_V1 = [
  "chatgpt",
  "claude",
  "gemini",
  "grok"
] as const;

export const MonsterCharacterIdV1Schema = z.enum(MONSTER_CHARACTER_IDS_V1);
export type MonsterCharacterIdV1 = z.infer<
  typeof MonsterCharacterIdV1Schema
>;

export const MONSTER_PROVIDERS_V1 = [
  "anthropic",
  "google",
  "openai",
  "openrouter",
  "xai",
  "other"
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
  "other"
] as const;

export const MonsterModelFamilyV1Schema = z.enum(
  MONSTER_MODEL_FAMILIES_V1
);
export type MonsterModelFamilyV1 = z.infer<
  typeof MonsterModelFamilyV1Schema
>;

export const MONSTER_TOOLS_V1 = [
  "claude-code",
  "codex-cli",
  "gemini-cli",
  "grok-build",
  "cursor",
  "vscode-copilot",
  "jetbrains-ai",
  "browser",
  "other"
] as const;

export const MonsterToolV1Schema = z.enum(MONSTER_TOOLS_V1);
export type MonsterToolV1 = z.infer<typeof MonsterToolV1Schema>;

export const MONSTER_CLI_TOOLS_V1 = [
  "claude-code",
  "codex-cli",
  "gemini-cli",
  "grok-build"
] as const satisfies readonly MonsterToolV1[];

export const LocalDateV1Schema = z
  .string()
  .refine(
    (value) => localDateTimestamp(value) !== null,
    "Dates must be valid YYYY-MM-DD local calendar dates from 2020 through 2099."
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
        "timezone must be UTC or an IANA timezone supported by this runtime."
      )
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
        message: "The identity footprint window must span exactly 28 dates."
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
    tokens: MonsterTokenCountsV1Schema
  })
  .superRefine((aggregate, context) => {
    const validModelFamiliesByProvider: Readonly<
      Record<MonsterProviderV1, readonly MonsterModelFamilyV1[]>
    > = {
      anthropic: [
        "claude-haiku",
        "claude-sonnet",
        "claude-opus",
        "anthropic-other"
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
        "openai-other"
      ],
      openrouter: ["openrouter-other"],
      xai: ["grok", "xai-other"],
      other: ["other"]
    };
    if (
      !validModelFamiliesByProvider[aggregate.provider].includes(
        aggregate.modelFamily
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["modelFamily"],
        message:
          "modelFamily must be a coarse family allowed for its normalized provider."
      });
    }

    if (
      aggregate.cacheReadAvailability === "unavailable" &&
      aggregate.tokens.cacheRead !== "0"
    ) {
      context.addIssue({
        code: "custom",
        path: ["tokens", "cacheRead"],
        message: "cacheRead must be zero when cache coverage is unavailable."
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
    aggregates: z.array(DailyDimensionAggregateV1Schema).max(64)
  })
  .superRefine((day, context) => {
    if (day.coverage === "unavailable" && day.aggregates.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["aggregates"],
        message: "Unavailable days cannot contain usage aggregates."
      });
    }

    const seen = new Set<string>();
    day.aggregates.forEach((aggregate, index) => {
      const key = [
        aggregate.provider,
        aggregate.modelFamily,
        aggregate.tool
      ].join("|");
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["aggregates", index],
          message: "A day cannot contain duplicate aggregate dimensions."
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
    timeQuality: z.enum([
      "exact-iana-local",
      "estimated-local",
      "utc-only"
    ]),
    dstQuality: z.enum(["timezone-aware", "fixed-offset", "unknown"]),
    observedDays: z.number().int().min(0).max(FOOTPRINT_WINDOW_DAYS_V1),
    hours: z
      .array(
        z.strictObject({
          hour: z.number().int().min(0).max(23),
          tokens: SafeTokenDecimalV1Schema
        })
      )
      .length(24)
  })
  .superRefine((rhythm, context) => {
    rhythm.hours.forEach((hour, index) => {
      if (hour.hour !== index) {
        context.addIssue({
          code: "custom",
          path: ["hours", index, "hour"],
          message: "Hourly rhythm buckets must be canonical and ordered 0–23."
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
        message: "Hourly tokens require at least one completely observed day."
      });
    }
  });

export type LocalHourlyRhythmV1 = z.infer<
  typeof LocalHourlyRhythmV1Schema
>;

const DAILY_FOOTPRINT_SHAPE = {
  schemaVersion: z.literal(MONSTER_FOOTPRINT_SCHEMA_VERSION_V1),
  characterId: MonsterCharacterIdV1Schema,
  window: FootprintWindowV1Schema,
  days: z.array(FootprintDayV1Schema).length(FOOTPRINT_WINDOW_DAYS_V1)
} as const;

function validateDailyFootprint(
  footprint: {
    window: FootprintWindowV1;
    days: FootprintDayV1[];
  },
  context: z.core.$RefinementCtx
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
        message: "Footprint days must be canonical, contiguous, and ordered."
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
    localHourlyRhythm: LocalHourlyRhythmV1Schema.optional()
  })
  .superRefine((footprint, context) => {
    validateDailyFootprint(footprint, context);
    const observedDays = footprint.days.filter(
      (day) => day.coverage === "observed"
    ).length;
    if (
      footprint.localHourlyRhythm !== undefined &&
      footprint.localHourlyRhythm.observedDays > observedDays
    ) {
      context.addIssue({
        code: "custom",
        path: ["localHourlyRhythm", "observedDays"],
        message:
          "Hourly complete-day coverage cannot exceed observed daily coverage."
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
  "balanced"
] as const;

export const MonsterTraitIdV1Schema = z.enum(MONSTER_TRAIT_IDS_V1);
export type MonsterTraitIdV1 = z.infer<typeof MonsterTraitIdV1Schema>;

export const MONSTER_MOOD_IDS_V1 = [
  "learning",
  "unknown",
  "resting",
  "quiet",
  "steady",
  "lively"
] as const;

export const MonsterMoodIdV1Schema = z.enum(MONSTER_MOOD_IDS_V1);
export type MonsterMoodIdV1 = z.infer<typeof MonsterMoodIdV1Schema>;

export const MONSTER_REASON_CODES_V1 = [
  "IDENTITY_LEARNING_COVERAGE_28D",
  "IDENTITY_READY_COVERAGE_28D",
  "IDENTITY_HELD_SAME_WINDOW",
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
  "EVOLUTION_NO_CHANGE"
] as const;

export const MonsterReasonCodeV1Schema = z.enum(MONSTER_REASON_CODES_V1);
export type MonsterReasonCodeV1 = z.infer<
  typeof MonsterReasonCodeV1Schema
>;

export const MONSTER_TEMPLATE_IDS_V1 = [
  "monster.identity.learning.v1",
  "monster.identity.ready.v1",
  "monster.identity.heldSameWindow.v1",
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
  "monster.evolution.noChange.v1"
] as const;

export const MonsterTemplateIdV1Schema = z.enum(MONSTER_TEMPLATE_IDS_V1);
export type MonsterTemplateIdV1 = z.infer<
  typeof MonsterTemplateIdV1Schema
>;

export const MonsterCoverageBandV1Schema = z.enum([
  "insufficient",
  "partial",
  "good",
  "full"
]);
export type MonsterCoverageBandV1 = z.infer<
  typeof MonsterCoverageBandV1Schema
>;

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
  "trait-structure"
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
  "provisional"
]);
export type MonsterValueBandV1 = z.infer<
  typeof MonsterValueBandV1Schema
>;

export const MonsterExplanationInputV1Schema = z.strictObject({
  metric: MonsterMetricV1Schema,
  valueBand: MonsterValueBandV1Schema,
  coverage: MonsterCoverageBandV1Schema
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
  "no-change"
] as const;

export const MonsterExplanationStateValueV1Schema = z.enum(
  MONSTER_EXPLANATION_STATE_VALUES_V1
);
export type MonsterExplanationStateValueV1 = z.infer<
  typeof MonsterExplanationStateValueV1Schema
>;

export const MonsterExplanationV1Schema = z.strictObject({
  explanationId: MonsterExplanationIdV1Schema,
  engineVersion: z.literal(MONSTER_ENGINE_VERSION_V1),
  subject: z.enum(["identity", "trait", "mood", "evolution"]),
  reasonCode: MonsterReasonCodeV1Schema,
  window: FootprintWindowV1Schema,
  inputs: z.array(MonsterExplanationInputV1Schema).min(1).max(3),
  before: MonsterExplanationStateValueV1Schema.nullable(),
  after: MonsterExplanationStateValueV1Schema,
  templateId: MonsterTemplateIdV1Schema
});

export type MonsterExplanationV1 = z.infer<
  typeof MonsterExplanationV1Schema
>;

export const MonsterTraitV1Schema = z.strictObject({
  id: MonsterTraitIdV1Schema,
  explanationId: MonsterExplanationIdV1Schema
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
      provisional: z.boolean()
    }),
    traits: z.array(MonsterTraitV1Schema).max(3),
    mood: z.strictObject({
      id: MonsterMoodIdV1Schema,
      explanationId: MonsterExplanationIdV1Schema
    }),
    evolution: z.strictObject({
      cadence: z.enum(["weekly", "event", "none"]),
      event: z.enum([
        "awaiting-coverage",
        "initial-profile",
        "coverage-complete",
        "identity-shift",
        "weekly-review",
        "no-change"
      ]),
      explanationId: MonsterExplanationIdV1Schema
    }),
    appearance: z.strictObject({
      energyBand: z.enum(["dormant", "low", "medium", "high"])
    })
  })
  .superRefine((state, context) => {
    const expectedTraitCount = state.identityStatus === "ready";
    if (expectedTraitCount && state.traits.length < 2) {
      context.addIssue({
        code: "custom",
        path: ["traits"],
        message: "Ready identity states require two or three traits."
      });
    }
    if (!expectedTraitCount && state.traits.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["traits"],
        message: "Learning states do not assert analytical traits."
      });
    }

    if (new Set(state.traits.map((trait) => trait.id)).size !== state.traits.length) {
      context.addIssue({
        code: "custom",
        path: ["traits"],
        message: "Identity traits must be unique."
      });
    }

    const reviewDate = localDateTimestamp(
      state.identityContinuity.lastIdentityReviewDate
    );
    const windowEnd = localDateTimestamp(state.window.to);
    if (
      reviewDate !== null &&
      windowEnd !== null &&
      reviewDate > windowEnd
    ) {
      context.addIssue({
        code: "custom",
        path: ["identityContinuity", "lastIdentityReviewDate"],
        message: "The last identity review cannot be in the state's future."
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
          "A ready state must be reviewed at least once within the preceding six local dates."
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
        message: "Evolution cadence must match the event kind."
      });
    }
  });

export type MonsterStateV1 = z.infer<typeof MonsterStateV1Schema>;

export const MonsterRulesV1Schema = z.strictObject({
  engineVersion: z.literal(MONSTER_ENGINE_VERSION_V1)
});
export type MonsterRulesV1 = z.infer<typeof MonsterRulesV1Schema>;

export const DEFAULT_MONSTER_RULES_V1: Readonly<MonsterRulesV1> = Object.freeze({
  engineVersion: MONSTER_ENGINE_VERSION_V1
});

export const MonsterDerivationV1Schema = z
  .strictObject({
    state: MonsterStateV1Schema,
    explanations: z.array(MonsterExplanationV1Schema).min(2).max(6)
  })
  .superRefine((derivation, context) => {
    const explanationsById = new Map(
      derivation.explanations.map((explanation) => [
        explanation.explanationId,
        explanation
      ])
    );
    if (explanationsById.size !== derivation.explanations.length) {
      context.addIssue({
        code: "custom",
        path: ["explanations"],
        message: "Explanation IDs must be unique within a derivation."
      });
    }

    const references: ReadonlyArray<
      readonly [string, MonsterExplanationV1["subject"], readonly PropertyKey[]]
    > = [
      [
        derivation.state.identityExplanationId,
        "identity",
        ["state", "identityExplanationId"]
      ],
      ...derivation.state.traits.map(
        (trait, index) =>
          [
            trait.explanationId,
            "trait",
            ["state", "traits", index, "explanationId"]
          ] as const
      ),
      [
        derivation.state.mood.explanationId,
        "mood",
        ["state", "mood", "explanationId"]
      ],
      [
        derivation.state.evolution.explanationId,
        "evolution",
        ["state", "evolution", "explanationId"]
      ]
    ];

    for (const [id, expectedSubject, path] of references) {
      const explanation = explanationsById.get(id);
      if (explanation?.subject !== expectedSubject) {
        context.addIssue({
          code: "custom",
          path: [...path],
          message: `Referenced ${expectedSubject} explanation is missing or has the wrong subject.`
        });
      }
    }
    if (references.length !== derivation.explanations.length) {
      context.addIssue({
        code: "custom",
        path: ["explanations"],
        message: "Every explanation must be referenced by the visible state."
      });
    }
  });
export type MonsterDerivationV1 = z.infer<typeof MonsterDerivationV1Schema>;
