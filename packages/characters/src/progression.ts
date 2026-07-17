import {
  MONSTER_TRAIT_IDS_V1,
  MonsterTraitIdV1Schema,
  type MonsterTraitIdV1,
} from "@tokenmonster/monster-engine";
import { z } from "zod";

import { CharacterIdSchema, type CharacterId } from "./catalog.js";
import {
  STARTER_CHARACTER_BY_PROVIDER_FAMILY,
  selectStarterCharacter,
} from "./starter-selection.js";

export const PROGRESSION_SCHEMA_VERSION = "1" as const;

export const PROGRESSION_PROVIDER_IDS = [
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

export type ProgressionProviderId = (typeof PROGRESSION_PROVIDER_IDS)[number];
export const ProgressionProviderIdSchema = z.enum(PROGRESSION_PROVIDER_IDS);

export const PROGRESSION_CHARACTER_IDS = [
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
  "reserved",
] as const;

export type ProgressionCharacterId =
  (typeof PROGRESSION_CHARACTER_IDS)[number];
export const ProgressionCharacterIdSchema = z.enum(PROGRESSION_CHARACTER_IDS);

export const WARDROBE_THEME_IDS = [
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

export type WardrobeThemeId = (typeof WARDROBE_THEME_IDS)[number];
export const WardrobeThemeIdSchema = z.enum(WARDROBE_THEME_IDS);

export const PROGRESSION_POSE_SET_IDS = [
  "supported",
  "challenged",
  "victory",
] as const;
export type ProgressionPoseSetId = (typeof PROGRESSION_POSE_SET_IDS)[number];
export const ProgressionPoseSetIdSchema = z.enum(PROGRESSION_POSE_SET_IDS);

export const PROGRESSION_ACTION_IDS = [
  "preen",
  "check_phone",
  "tidy_hair",
  "sip",
  "stretch",
  "nod",
  "shake",
  "laugh",
  "smirk",
  "frown",
  "pout",
  "arms_crossed",
  "lean_in",
  "eyeroll",
  "applause",
  "tilt",
] as const;
export type ProgressionActionId = (typeof PROGRESSION_ACTION_IDS)[number];
export const ProgressionActionIdSchema = z.enum(PROGRESSION_ACTION_IDS);

const SAFE_COUNT_MAX = Number.MAX_SAFE_INTEGER;
const SafeCountSchema = z.number().int().nonnegative().max(SAFE_COUNT_MAX);

function isUtcDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

function isUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export const UtcDateSchema = z.string().refine(isUtcDate, {
  message: "Expected a valid UTC date in YYYY-MM-DD form.",
});

export const UtcTimestampSchema = z.string().refine(isUtcTimestamp, {
  message: "Expected a canonical UTC timestamp.",
});

export const PartialProviderTotalsSchema = z.partialRecord(
  ProgressionProviderIdSchema,
  SafeCountSchema,
);

export type PartialProviderTotals = Readonly<
  Partial<Record<ProgressionProviderId, number>>
>;

const FullProviderTotalsShape = Object.fromEntries(
  PROGRESSION_PROVIDER_IDS.map((providerId) => [providerId, SafeCountSchema]),
) as Record<ProgressionProviderId, typeof SafeCountSchema>;

export const ProviderTotalsSchema = z.object(FullProviderTotalsShape).strict();
export type ProviderTotals = Readonly<Record<ProgressionProviderId, number>>;

export const DailyProviderBucketSchema = z
  .object({
    utcDate: UtcDateSchema,
    providerTotals: PartialProviderTotalsSchema,
  })
  .strict();

export type DailyProviderBucket = Readonly<{
  utcDate: string;
  providerTotals: PartialProviderTotals;
}>;

const ProviderCumulativeRuleSchema = z
  .object({
    signal: z.literal("provider-cumulative-total"),
    providerId: ProgressionProviderIdSchema,
    threshold: SafeCountSchema.positive(),
  })
  .strict();

const BreadthRuleSchema = z
  .object({
    signal: z.literal("distinct-active-provider-breadth"),
    threshold: z.number().int().positive().max(PROGRESSION_PROVIDER_IDS.length),
  })
  .strict();

const StreakRuleSchema = z
  .object({
    signal: z.literal("active-day-streak"),
    threshold: z.number().int().positive().max(366),
  })
  .strict();

const LifetimeRuleSchema = z
  .object({
    signal: z.literal("lifetime-total"),
    threshold: SafeCountSchema.positive(),
  })
  .strict();

export const CharacterUnlockRuleSchema = z.discriminatedUnion("signal", [
  ProviderCumulativeRuleSchema,
  BreadthRuleSchema,
  StreakRuleSchema,
  LifetimeRuleSchema,
]);
export type CharacterUnlockRule = z.infer<typeof CharacterUnlockRuleSchema>;

const ProgressionCharacterDefinitionSchema = z
  .object({
    id: ProgressionCharacterIdSchema,
    displayName: z.string().min(1).max(40),
    kind: z.enum(["sister", "friend", "reserved"]),
    providerId: ProgressionProviderIdSchema,
    unlockRule: CharacterUnlockRuleSchema,
  })
  .strict();

const WardrobeThemeDefinitionSchema = z
  .object({
    themeId: WardrobeThemeIdSchema,
    tier: z.number().int().positive().max(WARDROBE_THEME_IDS.length),
    providerCumulativeThreshold: SafeCountSchema.positive(),
    recommendedWhenTraitAny: z.array(MonsterTraitIdV1Schema).min(1),
  })
  .strict();

const ActionUnlockDefinitionSchema = z
  .object({
    actionId: ProgressionActionIdSchema,
    activeDayStreak: z.number().int().nonnegative().max(366),
  })
  .strict();

export const ProgressionManifestSchema = z
  .object({
    schemaVersion: z.literal(PROGRESSION_SCHEMA_VERSION),
    localOnly: z.literal(true),
    monotonicUnlocks: z.literal(true),
    purchasable: z.literal(false),
    characters: z.array(ProgressionCharacterDefinitionSchema).length(
      PROGRESSION_CHARACTER_IDS.length,
    ),
    wardrobe: z
      .object({
        themes: z.array(WardrobeThemeDefinitionSchema).length(
          WARDROBE_THEME_IDS.length,
        ),
        recommendedTraitFastTrackTiers: z.literal(1),
      })
      .strict(),
    poses: z
      .object({
        availableAtCharacterUnlock: z
          .array(ProgressionPoseSetIdSchema)
          .length(2),
        victoryActiveDayStreak: z.number().int().positive().max(366),
      })
      .strict(),
    actions: z
      .array(ActionUnlockDefinitionSchema)
      .length(PROGRESSION_ACTION_IDS.length),
  })
  .strict()
  .superRefine((manifest, context) => {
    const characterIds = manifest.characters.map(({ id }) => id);
    if (
      new Set(characterIds).size !== PROGRESSION_CHARACTER_IDS.length ||
      PROGRESSION_CHARACTER_IDS.some((id) => !characterIds.includes(id))
    ) {
      context.addIssue({
        code: "custom",
        path: ["characters"],
        message: "Every progression character must appear exactly once.",
      });
    }

    const friendMilestones = manifest.characters
      .filter(({ kind }) => kind !== "sister")
      .map(({ unlockRule }) => JSON.stringify(unlockRule));
    if (new Set(friendMilestones).size !== friendMilestones.length) {
      context.addIssue({
        code: "custom",
        path: ["characters"],
        message: "Friend milestones must be distinct.",
      });
    }

    const themeIds = manifest.wardrobe.themes.map(({ themeId }) => themeId);
    const tiers = manifest.wardrobe.themes.map(({ tier }) => tier);
    if (
      WARDROBE_THEME_IDS.some((id, index) => themeIds[index] !== id) ||
      tiers.some((tier, index) => tier !== index + 1)
    ) {
      context.addIssue({
        code: "custom",
        path: ["wardrobe", "themes"],
        message: "Wardrobe themes and tiers must retain source-map order.",
      });
    }

    const actionIds = manifest.actions.map(({ actionId }) => actionId);
    if (
      new Set(actionIds).size !== PROGRESSION_ACTION_IDS.length ||
      PROGRESSION_ACTION_IDS.some((id) => !actionIds.includes(id))
    ) {
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "Every allowlisted action must appear exactly once.",
      });
    }
  });

const RAW_PROGRESSION_MANIFEST = {
  schemaVersion: PROGRESSION_SCHEMA_VERSION,
  localOnly: true,
  monotonicUnlocks: true,
  purchasable: false,
  characters: [
    {
      id: "chatgpt",
      displayName: "ChatGPT",
      kind: "sister",
      providerId: "openai",
      unlockRule: {
        signal: "provider-cumulative-total",
        providerId: "openai",
        threshold: 1,
      },
    },
    {
      id: "claude",
      displayName: "Claude",
      kind: "sister",
      providerId: "anthropic",
      unlockRule: {
        signal: "provider-cumulative-total",
        providerId: "anthropic",
        threshold: 1,
      },
    },
    {
      id: "gemini",
      displayName: "Gemini",
      kind: "sister",
      providerId: "google",
      unlockRule: {
        signal: "provider-cumulative-total",
        providerId: "google",
        threshold: 1,
      },
    },
    {
      id: "grok",
      displayName: "Grok",
      kind: "sister",
      providerId: "xai",
      unlockRule: {
        signal: "provider-cumulative-total",
        providerId: "xai",
        threshold: 1,
      },
    },
    {
      id: "deepseek",
      displayName: "DeepSeek",
      kind: "friend",
      providerId: "deepseek",
      unlockRule: {
        signal: "provider-cumulative-total",
        providerId: "deepseek",
        threshold: 100_000,
      },
    },
    {
      id: "qwen",
      displayName: "Qwen",
      kind: "friend",
      providerId: "qwen",
      unlockRule: {
        signal: "provider-cumulative-total",
        providerId: "qwen",
        threshold: 250_000,
      },
    },
    {
      id: "mistral",
      displayName: "Mistral",
      kind: "friend",
      providerId: "mistral",
      unlockRule: { signal: "active-day-streak", threshold: 3 },
    },
    {
      id: "venice",
      displayName: "Llama",
      kind: "friend",
      providerId: "venice",
      unlockRule: { signal: "lifetime-total", threshold: 500_000 },
    },
    {
      id: "sakana",
      displayName: "Sakana",
      kind: "friend",
      providerId: "sakana",
      unlockRule: {
        signal: "distinct-active-provider-breadth",
        threshold: 4,
      },
    },
    {
      id: "perplexity",
      displayName: "Perplexity",
      kind: "friend",
      providerId: "perplexity",
      unlockRule: { signal: "active-day-streak", threshold: 7 },
    },
    {
      id: "glm",
      displayName: "GLM",
      kind: "friend",
      providerId: "glm",
      unlockRule: { signal: "lifetime-total", threshold: 5_000_000 },
    },
    {
      id: "reserved",
      displayName: "Reserved friend",
      kind: "reserved",
      providerId: "other",
      unlockRule: {
        signal: "distinct-active-provider-breadth",
        threshold: 8,
      },
    },
  ],
  wardrobe: {
    themes: [
      ["tech", 1, "cli-focused"],
      ["finance", 5_000, "cache-savvy"],
      ["politics", 10_000, "multi-provider"],
      ["education", 25_000, "tool-focused"],
      ["health", 50_000, "balanced"],
      ["environment", 100_000, "cache-savvy"],
      ["law", 175_000, "provider-focused"],
      ["relationship", 250_000, "multi-provider"],
      ["family", 400_000, "balanced"],
      ["workplace", 600_000, "cli-focused"],
      ["science", 850_000, "tool-focused"],
      ["culture", 1_200_000, "multi-tool"],
      ["sports", 1_700_000, "output-heavy"],
      ["food", 2_300_000, "balanced"],
      ["travel", 3_000_000, "multi-tool"],
      ["psychology", 4_000_000, "night-oriented"],
      ["philosophy", 5_500_000, "provider-focused"],
      ["international", 7_000_000, "multi-provider"],
      ["media", 9_000_000, "output-heavy"],
      ["festival", 12_000_000, "output-heavy"],
    ].map(([themeId, providerCumulativeThreshold, trait], index) => ({
      themeId,
      tier: index + 1,
      providerCumulativeThreshold,
      recommendedWhenTraitAny: [trait],
    })),
    recommendedTraitFastTrackTiers: 1,
  },
  poses: {
    availableAtCharacterUnlock: ["supported", "challenged"],
    victoryActiveDayStreak: 3,
  },
  actions: PROGRESSION_ACTION_IDS.map((actionId) => ({
    actionId,
    activeDayStreak:
      actionId === "laugh" ? 7 : actionId === "applause" ? 14 : 0,
  })),
} as const;

export type ProgressionManifest = Readonly<
  z.infer<typeof ProgressionManifestSchema>
>;

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const PROGRESSION_MANIFEST: ProgressionManifest = deepFreeze(
  ProgressionManifestSchema.parse(RAW_PROGRESSION_MANIFEST),
);

export const PersistedSelectionSchema = z
  .object({
    manualCharacterId: CharacterIdSchema.nullable(),
    manualSelectedAt: UtcTimestampSchema.nullable(),
    autoStarterCharacterId: CharacterIdSchema.nullable(),
    autoStarterSelectedAt: UtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((selection, context) => {
    if (
      (selection.manualCharacterId === null) !==
      (selection.manualSelectedAt === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["manualSelectedAt"],
        message: "Manual selection ID and timestamp must both be set or null.",
      });
    }
    if (
      (selection.autoStarterCharacterId === null) !==
      (selection.autoStarterSelectedAt === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["autoStarterSelectedAt"],
        message: "Auto-starter ID and timestamp must both be set or null.",
      });
    }
  });

export type PersistedSelection = Readonly<
  z.infer<typeof PersistedSelectionSchema>
>;

export const EMPTY_PERSISTED_SELECTION: PersistedSelection = deepFreeze({
  manualCharacterId: null,
  manualSelectedAt: null,
  autoStarterCharacterId: null,
  autoStarterSelectedAt: null,
});

export const PersistedUnlockedAtSchema = z.record(
  z.string(),
  UtcTimestampSchema,
);
export type PersistedUnlockedAt = Readonly<Record<string, string>>;

export const ProgressionInputSchema = z
  .object({
    schemaVersion: z.literal(PROGRESSION_SCHEMA_VERSION),
    evaluatedAt: UtcTimestampSchema,
    evaluationUtcDate: UtcDateSchema.optional(),
    baseline: ProviderTotalsSchema.optional(),
    baselineActiveDays: SafeCountSchema.optional(),
    dailyProviderBuckets: z
      .array(DailyProviderBucketSchema)
      .superRefine((buckets, context) => {
        const dates = buckets.map(({ utcDate }) => utcDate);
        if (new Set(dates).size !== dates.length) {
          context.addIssue({
            code: "custom",
            message: "Daily provider bucket dates must be unique.",
          });
        }
      }),
    traitIds: z
      .array(MonsterTraitIdV1Schema)
      .max(MONSTER_TRAIT_IDS_V1.length)
      .refine((traits) => new Set(traits).size === traits.length, {
        message: "Trait IDs must be unique.",
      }),
    persistedUnlockedAt: PersistedUnlockedAtSchema,
    selection: PersistedSelectionSchema,
  })
  .strict();

export type ProgressionInput = Readonly<{
  schemaVersion: typeof PROGRESSION_SCHEMA_VERSION;
  evaluatedAt: string;
  evaluationUtcDate?: string | undefined;
  baseline?: ProviderTotals | undefined;
  baselineActiveDays?: number | undefined;
  dailyProviderBuckets: readonly DailyProviderBucket[];
  traitIds: readonly MonsterTraitIdV1[];
  persistedUnlockedAt: PersistedUnlockedAt;
  selection: PersistedSelection;
}>;

export const UnlockProgressSchema = z
  .object({
    value: z.number().min(0).max(1),
    explanation: z.string().min(1).max(240),
  })
  .strict();
export type UnlockProgress = Readonly<z.infer<typeof UnlockProgressSchema>>;

const BaseUnlockStatusShape = {
  unlocked: z.boolean(),
  unlockedAt: UtcTimestampSchema.nullable(),
  progress: UnlockProgressSchema,
} as const;

export const ThemeUnlockStatusSchema = z
  .object({
    themeId: WardrobeThemeIdSchema,
    fastTrackedByTrait: z.boolean(),
    ...BaseUnlockStatusShape,
  })
  .strict();

export const PoseUnlockStatusSchema = z
  .object({
    poseSetId: ProgressionPoseSetIdSchema,
    ...BaseUnlockStatusShape,
  })
  .strict();

export const ActionUnlockStatusSchema = z
  .object({
    actionId: ProgressionActionIdSchema,
    ...BaseUnlockStatusShape,
  })
  .strict();

export const CharacterProgressionStatusSchema = z
  .object({
    characterId: ProgressionCharacterIdSchema,
    displayName: z.string().min(1).max(40),
    kind: z.enum(["sister", "friend", "reserved"]),
    providerId: ProgressionProviderIdSchema,
    ...BaseUnlockStatusShape,
    themes: z.array(ThemeUnlockStatusSchema).length(WARDROBE_THEME_IDS.length),
    poseSets: z
      .array(PoseUnlockStatusSchema)
      .length(PROGRESSION_POSE_SET_IDS.length),
    actions: z
      .array(ActionUnlockStatusSchema)
      .length(PROGRESSION_ACTION_IDS.length),
  })
  .strict();

export const SelectedSisterSchema = z
  .object({
    characterId: CharacterIdSchema,
    selectedBy: z.enum(["manual", "persisted-auto", "unique-provider-total"]),
    selectedAt: UtcTimestampSchema,
  })
  .strict();

export const NextUnlockSchema = z
  .object({
    kind: z.enum(["character", "theme", "pose", "action"]),
    characterId: ProgressionCharacterIdSchema,
    itemId: z.string().nullable(),
    progress: UnlockProgressSchema,
  })
  .strict();

export const ProgressionStateSchema = z
  .object({
    schemaVersion: z.literal(PROGRESSION_SCHEMA_VERSION),
    evaluatedAt: UtcTimestampSchema,
    unlockBatchId: UtcTimestampSchema.nullable().optional(),
    localOnly: z.literal(true),
    counters: z
      .object({
        providerTotals: ProviderTotalsSchema,
        lifetimeTotal: SafeCountSchema,
        distinctActiveProviders: z
          .number()
          .int()
          .nonnegative()
          .max(PROGRESSION_PROVIDER_IDS.length),
        activeDays: z.number().int().nonnegative(),
        activeDayStreak: z.number().int().nonnegative(),
      })
      .strict(),
    selection: SelectedSisterSchema.nullable(),
    characters: z
      .array(CharacterProgressionStatusSchema)
      .length(PROGRESSION_CHARACTER_IDS.length),
    nextUnlock: NextUnlockSchema.nullable(),
  })
  .strict();

export type ProgressionState = Readonly<
  z.infer<typeof ProgressionStateSchema>
>;

export function emptyProviderTotals(): ProviderTotals {
  return Object.freeze(
    Object.fromEntries(PROGRESSION_PROVIDER_IDS.map((id) => [id, 0])) as Record<
      ProgressionProviderId,
      number
    >,
  );
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(SAFE_COUNT_MAX, left + right);
}

export function deriveLifetimeCounters(
  dailyProviderBucketsInput: readonly DailyProviderBucket[],
  options?: Readonly<{
    baseline?: ProviderTotals | undefined;
    baselineActiveDays?: number | undefined;
    evaluationUtcDate?: string | undefined;
  }>,
): Readonly<{
  providerTotals: ProviderTotals;
  lifetimeTotal: number;
  distinctActiveProviders: number;
  activeDays: number;
  activeDayStreak: number;
}>;
export function deriveLifetimeCounters(
  dailyProviderBucketsInput: unknown,
  optionsInput?: unknown,
): Readonly<{
  providerTotals: ProviderTotals;
  lifetimeTotal: number;
  distinctActiveProviders: number;
  activeDays: number;
  activeDayStreak: number;
}>;
export function deriveLifetimeCounters(
  dailyProviderBucketsInput: unknown,
  optionsInput: unknown = {},
) {
  const buckets = z.array(DailyProviderBucketSchema).parse(dailyProviderBucketsInput);
  const options = z
    .object({
      baseline: ProviderTotalsSchema.optional(),
      baselineActiveDays: SafeCountSchema.optional(),
      evaluationUtcDate: UtcDateSchema.optional(),
    })
    .strict()
    .parse(optionsInput);
  const providerTotals = { ...(options.baseline ?? emptyProviderTotals()) };
  const sortedBuckets = [...buckets].sort((left, right) =>
    left.utcDate.localeCompare(right.utcDate),
  );

  for (const bucket of sortedBuckets) {
    for (const providerId of PROGRESSION_PROVIDER_IDS) {
      providerTotals[providerId] = saturatingAdd(
        providerTotals[providerId],
        bucket.providerTotals[providerId] ?? 0,
      );
    }
  }

  let lifetimeTotal = 0;
  let distinctActiveProviders = 0;
  for (const providerId of PROGRESSION_PROVIDER_IDS) {
    const total = providerTotals[providerId];
    lifetimeTotal = saturatingAdd(lifetimeTotal, total);
    if (total > 0) distinctActiveProviders += 1;
  }

  const activeDates = new Set(
    sortedBuckets
      .filter((bucket) =>
        Object.values(bucket.providerTotals).some((total) => total > 0),
      )
      .map(({ utcDate }) => utcDate),
  );
  const activeDays = saturatingAdd(
    options.baselineActiveDays ?? 0,
    activeDates.size,
  );
  let activeDayStreak = 0;
  if (options.evaluationUtcDate === undefined) {
    let expectedTimestamp: number | null = null;
    for (let index = sortedBuckets.length - 1; index >= 0; index -= 1) {
      const bucket = sortedBuckets[index]!;
      const timestamp = Date.parse(`${bucket.utcDate}T00:00:00.000Z`);
      const active = Object.values(bucket.providerTotals).some((total) => total > 0);
      if (!active || (expectedTimestamp !== null && timestamp !== expectedTimestamp)) {
        break;
      }
      activeDayStreak += 1;
      expectedTimestamp = timestamp - 86_400_000;
    }
  } else {
    const evaluationTimestamp = Date.parse(
      `${options.evaluationUtcDate}T00:00:00.000Z`,
    );
    const yesterdayTimestamp = evaluationTimestamp - 86_400_000;
    let expectedTimestamp = activeDates.has(options.evaluationUtcDate)
      ? evaluationTimestamp
      : yesterdayTimestamp;
    let expectedDate = new Date(expectedTimestamp).toISOString().slice(0, 10);
    if (!activeDates.has(expectedDate)) {
      expectedDate = "";
    }
    while (expectedDate !== "" && activeDates.has(expectedDate)) {
      activeDayStreak += 1;
      expectedTimestamp -= 86_400_000;
      expectedDate = new Date(expectedTimestamp).toISOString().slice(0, 10);
    }
  }

  return deepFreeze({
    providerTotals: ProviderTotalsSchema.parse(providerTotals),
    lifetimeTotal,
    distinctActiveProviders,
    activeDays,
    activeDayStreak,
  });
}

function ratio(value: number, threshold: number): number {
  return Math.max(0, Math.min(1, value / threshold));
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function characterUnlockKey(characterId: ProgressionCharacterId): string {
  return `character:${characterId}`;
}

function itemUnlockKey(
  kind: "theme" | "pose" | "action",
  characterId: ProgressionCharacterId,
  itemId: string,
): string {
  return `${kind}:${characterId}:${itemId}`;
}

function resolveUnlockedAt(
  key: string,
  requirementMet: boolean,
  evaluatedAt: string,
  persistedUnlockedAt: PersistedUnlockedAt,
): string | null {
  return persistedUnlockedAt[key] ?? (requirementMet ? evaluatedAt : null);
}

function monotonicProgress(
  unlockedAt: string | null,
  currentProgress: UnlockProgress,
  label: string,
): UnlockProgress {
  if (unlockedAt === null || currentProgress.value === 1) return currentProgress;
  return {
    value: 1,
    explanation: `${label} 已解鎖；本機解鎖不會倒退。`,
  };
}

function characterRuleProgress(
  displayName: string,
  rule: CharacterUnlockRule,
  counters: ReturnType<typeof deriveLifetimeCounters>,
): UnlockProgress {
  switch (rule.signal) {
    case "provider-cumulative-total": {
      const value = counters.providerTotals[rule.providerId];
      const remaining = Math.max(0, rule.threshold - value);
      return {
        value: ratio(value, rule.threshold),
        explanation:
          remaining === 0
            ? `已累積 ${formatCount(value)} 個本機 provider token，解鎖 ${displayName}。`
            : `已累積 ${formatCount(value)} 個本機 ${rule.providerId} token，再 ${formatCount(remaining)} 個即可解鎖 ${displayName}。`,
      };
    }
    case "distinct-active-provider-breadth": {
      const value = counters.distinctActiveProviders;
      const remaining = Math.max(0, rule.threshold - value);
      return {
        value: ratio(value, rule.threshold),
        explanation:
          remaining === 0
            ? `已使用 ${formatCount(value)} 個不同的 provider，解鎖 ${displayName}。`
            : `已使用 ${formatCount(value)} 個不同的 provider，再使用 ${formatCount(remaining)} 個即可解鎖 ${displayName}。`,
      };
    }
    case "active-day-streak": {
      const value = counters.activeDayStreak;
      const remaining = Math.max(0, rule.threshold - value);
      return {
        value: ratio(value, rule.threshold),
        explanation:
          remaining === 0
            ? `已連續使用 ${formatCount(value)} 天，解鎖 ${displayName}。`
            : `已連續使用 ${formatCount(value)} 天，再連續 ${formatCount(remaining)} 天即可解鎖 ${displayName}。`,
      };
    }
    case "lifetime-total": {
      const value = counters.lifetimeTotal;
      const remaining = Math.max(0, rule.threshold - value);
      return {
        value: ratio(value, rule.threshold),
        explanation:
          remaining === 0
            ? `本機累積用量已達 ${formatCount(value)} tokens，解鎖 ${displayName}。`
            : `本機累積用量已達 ${formatCount(value)} tokens，再 ${formatCount(remaining)} tokens 即可解鎖 ${displayName}。`,
      };
    }
  }
}

function resolveSelection(
  selection: PersistedSelection,
  counters: ReturnType<typeof deriveLifetimeCounters>,
  evaluatedAt: string,
): z.infer<typeof SelectedSisterSchema> | null {
  if (selection.manualCharacterId !== null) {
    return {
      characterId: selection.manualCharacterId,
      selectedBy: "manual",
      selectedAt: selection.manualSelectedAt!,
    };
  }
  if (selection.autoStarterCharacterId !== null) {
    return {
      characterId: selection.autoStarterCharacterId,
      selectedBy: "persisted-auto",
      selectedAt: selection.autoStarterSelectedAt!,
    };
  }
  const candidate = selectStarterCharacter({
    providerTotals28Days: {
      openai: counters.providerTotals.openai,
      anthropic: counters.providerTotals.anthropic,
      google: counters.providerTotals.google,
      xai: counters.providerTotals.xai,
    },
  });
  if (candidate.outcome !== "selected") return null;
  return {
    characterId: candidate.characterId,
    selectedBy: "unique-provider-total",
    selectedAt: evaluatedAt,
  };
}

interface UnlockCandidate {
  readonly kind: "character" | "theme" | "pose" | "action";
  readonly characterId: ProgressionCharacterId;
  readonly itemId: string | null;
  readonly progress: UnlockProgress;
}

/** Evaluate local aggregate milestones. This function performs no I/O. */
export function evaluateProgression(input: ProgressionInput): ProgressionState;
export function evaluateProgression(input: unknown): ProgressionState;
export function evaluateProgression(input: unknown): ProgressionState {
  const parsed = ProgressionInputSchema.parse(input);
  const counters = deriveLifetimeCounters(parsed.dailyProviderBuckets, {
    baseline: parsed.baseline,
    baselineActiveDays: parsed.baselineActiveDays,
    evaluationUtcDate: parsed.evaluationUtcDate,
  });
  const selection = resolveSelection(parsed.selection, counters, parsed.evaluatedAt);
  const traitIds = new Set(parsed.traitIds);
  const lockedCandidates: UnlockCandidate[] = [];

  const characters = PROGRESSION_MANIFEST.characters.map((character) => {
    const progress = characterRuleProgress(
      character.displayName,
      character.unlockRule,
      counters,
    );
    const starterUnlock =
      character.kind === "sister" && selection?.characterId === character.id;
    const characterKey = characterUnlockKey(character.id);
    const unlockedAt = resolveUnlockedAt(
      characterKey,
      progress.value === 1 || starterUnlock,
      selection?.characterId === character.id
        ? selection.selectedAt
        : parsed.evaluatedAt,
      parsed.persistedUnlockedAt,
    );
    const unlocked = unlockedAt !== null;
    const currentCharacterProgress = starterUnlock
      ? {
          value: 1,
          explanation: `${character.displayName} 是你選擇的起始角色。`,
        }
      : progress;
    const characterProgress = monotonicProgress(
      unlockedAt,
      currentCharacterProgress,
      character.displayName,
    );
    if (!unlocked) {
      lockedCandidates.push({
        kind: "character",
        characterId: character.id,
        itemId: null,
        progress: characterProgress,
      });
    }

    const providerTotal = counters.providerTotals[character.providerId];
    const themes = PROGRESSION_MANIFEST.wardrobe.themes.map((theme, index) => {
      const fastTrackedByTrait = theme.recommendedWhenTraitAny.some((trait) =>
        traitIds.has(trait),
      );
      const effectiveIndex = fastTrackedByTrait ? Math.max(0, index - 1) : index;
      const threshold =
        PROGRESSION_MANIFEST.wardrobe.themes[effectiveIndex]!
          .providerCumulativeThreshold;
      const requirementMet = unlocked && providerTotal >= threshold;
      const themeUnlockedAt = resolveUnlockedAt(
        itemUnlockKey("theme", character.id, theme.themeId),
        requirementMet,
        parsed.evaluatedAt,
        parsed.persistedUnlockedAt,
      );
      const remaining = Math.max(0, threshold - providerTotal);
      const currentThemeProgress: UnlockProgress = {
        value: unlocked ? ratio(providerTotal, threshold) : 0,
        explanation: !unlocked
          ? `先解鎖 ${character.displayName}，才能解鎖服裝主題。`
          : remaining === 0
            ? `本機 ${character.providerId} 已達第 ${effectiveIndex + 1} 階，解鎖 ${theme.themeId} 主題。`
            : `已累積 ${formatCount(providerTotal)} 個本機 ${character.providerId} token，再 ${formatCount(remaining)} 個即可解鎖 ${character.displayName} 的 ${theme.themeId} 主題。`,
      };
      const themeProgress = monotonicProgress(
        themeUnlockedAt,
        currentThemeProgress,
        `${character.displayName} 的 ${theme.themeId} 主題`,
      );
      if (themeUnlockedAt === null) {
        lockedCandidates.push({
          kind: "theme",
          characterId: character.id,
          itemId: theme.themeId,
          progress: themeProgress,
        });
      }
      return {
        themeId: theme.themeId,
        fastTrackedByTrait,
        unlocked: themeUnlockedAt !== null,
        unlockedAt: themeUnlockedAt,
        progress: themeProgress,
      };
    });

    const poseSets = PROGRESSION_POSE_SET_IDS.map((poseSetId) => {
      const threshold =
        poseSetId === "victory"
          ? PROGRESSION_MANIFEST.poses.victoryActiveDayStreak
          : 0;
      const requirementMet =
        unlocked &&
        (threshold === 0 || counters.activeDayStreak >= threshold);
      const poseUnlockedAt = resolveUnlockedAt(
        itemUnlockKey("pose", character.id, poseSetId),
        requirementMet,
        parsed.evaluatedAt,
        parsed.persistedUnlockedAt,
      );
      const remaining = Math.max(0, threshold - counters.activeDayStreak);
      const currentPoseProgress: UnlockProgress = {
        value: unlocked
          ? threshold === 0
            ? 1
            : ratio(counters.activeDayStreak, threshold)
          : 0,
        explanation: !unlocked
          ? `先解鎖 ${character.displayName}，才能解鎖姿勢組合。`
          : threshold === 0
            ? `解鎖角色時已開放 ${poseSetId} 姿勢。`
            : remaining === 0
              ? `已連續使用 ${formatCount(threshold)} 天，解鎖 victory 姿勢。`
              : `已連續使用 ${formatCount(counters.activeDayStreak)} 天，再連續 ${formatCount(remaining)} 天即可解鎖 victory 姿勢。`,
      };
      const poseProgress = monotonicProgress(
        poseUnlockedAt,
        currentPoseProgress,
        `${character.displayName} 的 ${poseSetId} 姿勢`,
      );
      if (poseUnlockedAt === null) {
        lockedCandidates.push({
          kind: "pose",
          characterId: character.id,
          itemId: poseSetId,
          progress: poseProgress,
        });
      }
      return {
        poseSetId,
        unlocked: poseUnlockedAt !== null,
        unlockedAt: poseUnlockedAt,
        progress: poseProgress,
      };
    });

    const actions = PROGRESSION_MANIFEST.actions.map((action) => {
      const threshold = action.activeDayStreak;
      const requirementMet =
        unlocked &&
        (threshold === 0 || counters.activeDayStreak >= threshold);
      const actionUnlockedAt = resolveUnlockedAt(
        itemUnlockKey("action", character.id, action.actionId),
        requirementMet,
        parsed.evaluatedAt,
        parsed.persistedUnlockedAt,
      );
      const remaining = Math.max(0, threshold - counters.activeDayStreak);
      const currentActionProgress: UnlockProgress = {
        value: unlocked
          ? threshold === 0
            ? 1
            : ratio(counters.activeDayStreak, threshold)
          : 0,
        explanation: !unlocked
          ? `先解鎖 ${character.displayName}，才能解鎖動作。`
          : threshold === 0
            ? `解鎖角色時已開放 ${action.actionId} 動作。`
            : remaining === 0
              ? `已連續使用 ${formatCount(threshold)} 天，解鎖 ${action.actionId} 動作。`
              : `已連續使用 ${formatCount(counters.activeDayStreak)} 天，再連續 ${formatCount(remaining)} 天即可解鎖 ${action.actionId} 動作。`,
      };
      const actionProgress = monotonicProgress(
        actionUnlockedAt,
        currentActionProgress,
        `${character.displayName} 的 ${action.actionId} 動作`,
      );
      if (actionUnlockedAt === null) {
        lockedCandidates.push({
          kind: "action",
          characterId: character.id,
          itemId: action.actionId,
          progress: actionProgress,
        });
      }
      return {
        actionId: action.actionId,
        unlocked: actionUnlockedAt !== null,
        unlockedAt: actionUnlockedAt,
        progress: actionProgress,
      };
    });

    return {
      characterId: character.id,
      displayName: character.displayName,
      kind: character.kind,
      providerId: character.providerId,
      unlocked,
      unlockedAt,
      progress: characterProgress,
      themes,
      poseSets,
      actions,
    };
  });

  const nextCandidate = [...lockedCandidates].sort(
    (left, right) => right.progress.value - left.progress.value,
  )[0];
  const unlockBatchId = characters
    .flatMap((character) => [
      character.unlockedAt,
      ...character.themes.map((theme) => theme.unlockedAt),
      ...character.poseSets.map((pose) => pose.unlockedAt),
      ...character.actions.map((action) => action.unlockedAt),
    ])
    .filter((unlockedAt): unlockedAt is string => unlockedAt !== null)
    .sort(
      (left, right) => Date.parse(right) - Date.parse(left),
    )[0] ?? null;

  return deepFreeze(
    ProgressionStateSchema.parse({
      schemaVersion: PROGRESSION_SCHEMA_VERSION,
      evaluatedAt: parsed.evaluatedAt,
      unlockBatchId,
      localOnly: true,
      counters,
      selection,
      characters,
      nextUnlock:
        nextCandidate === undefined
          ? null
          : {
              kind: nextCandidate.kind,
              characterId: nextCandidate.characterId,
              itemId: nextCandidate.itemId,
              progress: nextCandidate.progress,
            },
    }),
  );
}

export function progressionCharacterForSister(
  characterId: CharacterId,
): ProgressionCharacterId {
  return characterId;
}

export function providerForSister(characterId: CharacterId): ProgressionProviderId {
  const entry = Object.entries(STARTER_CHARACTER_BY_PROVIDER_FAMILY).find(
    ([, candidate]) => candidate === characterId,
  );
  if (entry === undefined) throw new Error(`Unknown sister: ${characterId}`);
  return entry[0] as ProgressionProviderId;
}
