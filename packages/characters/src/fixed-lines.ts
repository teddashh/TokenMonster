import { z } from "zod";
import {
  MONSTER_MOOD_IDS_V1,
  MONSTER_TRAIT_IDS_V1,
  MonsterMoodIdV1Schema,
  MonsterTraitIdV1Schema,
  type MonsterDerivationV1,
  type MonsterMoodIdV1,
  type MonsterTraitIdV1,
} from "@tokenmonster/monster-engine";

import {
  CHARACTER_IDS,
  CharacterIdSchema,
  type CharacterId,
} from "./catalog.js";
import { readonlyTraitViewFromMonsterDerivation } from "./monster-view.js";

export const FIXED_LINE_SCHEMA_VERSION = "1" as const;
export const FIXED_LINE_CONTENT_VERSION = "1.0.0" as const;
export const FIXED_LINE_CONTENT_RATING = "general-audience" as const;
export const FIXED_LINE_LICENSE_STATUS = "project-license-pending" as const;

export const FIXED_LINE_LOCALES = ["zh-TW", "en"] as const;
export type FixedLineLocale = (typeof FIXED_LINE_LOCALES)[number];
export const FixedLineLocaleSchema = z.enum(FIXED_LINE_LOCALES);

export const FIXED_LINE_TRIGGERS = [
  "greeting",
  "idle",
  "above-baseline",
  "below-baseline",
  "new-tool",
  "night",
  "collector-error",
] as const;
export type FixedLineTrigger = (typeof FIXED_LINE_TRIGGERS)[number];
export const FixedLineTriggerSchema = z.enum(FIXED_LINE_TRIGGERS);

export const MONSTER_MOODS = MONSTER_MOOD_IDS_V1;
export type MonsterMood = MonsterMoodIdV1;
export const MonsterMoodSchema = MonsterMoodIdV1Schema;

export const MONSTER_TRAITS = MONSTER_TRAIT_IDS_V1;
export type MonsterTrait = MonsterTraitIdV1;
export const MonsterTraitSchema = MonsterTraitIdV1Schema;

const UniqueTraitsSchema = z
  .array(MonsterTraitSchema)
  .max(3)
  .refine((traits) => new Set(traits).size === traits.length, {
    message: "traits must be unique",
  });

export const FixedLineSelectionInputSchema = z
  .object({
    characterId: CharacterIdSchema,
    locale: z.string().trim().min(1).max(35),
    trigger: FixedLineTriggerSchema,
    mood: MonsterMoodSchema,
    traits: UniqueTraitsSchema,
    seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type FixedLineSelectionInput = Readonly<{
  characterId: CharacterId;
  locale: string;
  trigger: FixedLineTrigger;
  mood: MonsterMood;
  traits: readonly MonsterTrait[];
  seed: number;
}>;

export const FixedLineDerivationContextSchema = z
  .object({
    characterId: CharacterIdSchema,
    locale: z.string().trim().min(1).max(35),
    trigger: FixedLineTriggerSchema,
    seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type FixedLineDerivationContext = Readonly<
  z.infer<typeof FixedLineDerivationContextSchema>
>;

export const CooldownMetadataSchema = z
  .object({
    scope: z.literal("character-trigger"),
    key: z.string().regex(/^[a-z0-9-]+:[a-z0-9-]+$/u),
    durationMs: z.number().int().positive().max(86_400_000),
    dailyCap: z.number().int().positive().max(8),
  })
  .strict();

export type CooldownMetadata = Readonly<
  z.infer<typeof CooldownMetadataSchema>
>;

const LineVariantSchema = z.enum(["general", "active", "quiet"]);
type LineVariant = z.infer<typeof LineVariantSchema>;

export const FixedLineDefinitionSchema = z
  .object({
    schemaVersion: z.literal(FIXED_LINE_SCHEMA_VERSION),
    contentVersion: z.literal(FIXED_LINE_CONTENT_VERSION),
    lineId: z
      .string()
      .regex(/^fixed-line\/1\.0\.0\/[a-z0-9-]+\/(?:zh-TW|en)\/[a-z0-9-]+\/(?:general|active|quiet)$/u),
    characterId: CharacterIdSchema,
    locale: FixedLineLocaleSchema,
    trigger: FixedLineTriggerSchema,
    variant: LineVariantSchema,
    eligibleMoods: z
      .array(MonsterMoodSchema)
      .refine((moods) => new Set(moods).size === moods.length, {
        message: "eligible moods must be unique",
      }),
    eligibleTraits: z
      .array(MonsterTraitSchema)
      .refine((traits) => new Set(traits).size === traits.length, {
        message: "eligible traits must be unique",
      }),
    text: z.string().trim().min(1).max(240),
    cooldown: CooldownMetadataSchema,
    contentRating: z.literal(FIXED_LINE_CONTENT_RATING),
    provenance: z
      .object({
        kind: z.literal("tokenmonster-original-copy"),
        sourceId: z.literal("tokenmonster-fixed-lines-v1"),
        licenseStatus: z.literal(FIXED_LINE_LICENSE_STATUS),
      })
      .strict(),
    fallbackLineId: z.string().nullable(),
  })
  .strict()
  .superRefine((line, context) => {
    const expectedPrefix = `fixed-line/${FIXED_LINE_CONTENT_VERSION}/${line.characterId}/${line.locale}/${line.trigger}/`;
    if (line.lineId !== `${expectedPrefix}${line.variant}`) {
      context.addIssue({
        code: "custom",
        path: ["lineId"],
        message: "lineId must exactly match the declared dimensions.",
      });
    }
    const expectedFallback =
      line.variant === "general" ? null : `${expectedPrefix}general`;
    if (line.fallbackLineId !== expectedFallback) {
      context.addIssue({
        code: "custom",
        path: ["fallbackLineId"],
        message: "tone variants must point to their general fallback.",
      });
    }
  });

export type FixedLineDefinition = Readonly<
  z.infer<typeof FixedLineDefinitionSchema>
>;

export type FixedLineSelection = Readonly<{
  schemaVersion: typeof FIXED_LINE_SCHEMA_VERSION;
  contentVersion: typeof FIXED_LINE_CONTENT_VERSION;
  lineId: string;
  characterId: CharacterId;
  requestedLocale: string;
  locale: FixedLineLocale;
  trigger: FixedLineTrigger;
  text: string;
  cooldown: CooldownMetadata;
}>;

const TRIGGER_POLICIES = {
  greeting: { durationMs: 6 * 60 * 60 * 1_000, dailyCap: 2 },
  idle: { durationMs: 30 * 60 * 1_000, dailyCap: 4 },
  "above-baseline": { durationMs: 12 * 60 * 60 * 1_000, dailyCap: 1 },
  "below-baseline": { durationMs: 12 * 60 * 60 * 1_000, dailyCap: 1 },
  "new-tool": { durationMs: 24 * 60 * 60 * 1_000, dailyCap: 2 },
  night: { durationMs: 12 * 60 * 60 * 1_000, dailyCap: 1 },
  "collector-error": { durationMs: 15 * 60 * 1_000, dailyCap: 3 },
} as const satisfies Record<
  FixedLineTrigger,
  Readonly<{ durationMs: number; dailyCap: number }>
>;

export const FIXED_LINE_COOLDOWNS: Readonly<
  Record<FixedLineTrigger, Readonly<{ durationMs: number; dailyCap: number }>>
> = Object.freeze(
  Object.fromEntries(
    FIXED_LINE_TRIGGERS.map((trigger) => [
      trigger,
      Object.freeze({ ...TRIGGER_POLICIES[trigger] }),
    ]),
  ) as Record<FixedLineTrigger, Readonly<{ durationMs: number; dailyCap: number }>>,
);

type VariantCopy = Readonly<Record<LineVariant, string>>;

const COPY = {
  "zh-TW": {
    greeting: {
      general: "隨時可以開始。",
      active: "可以照自己的步調探索。",
      quiet: "安靜地開始也很好。",
    },
    idle: {
      general: "停一下很自然，我會安靜待在這裡。",
      active: "可以先休息，想回來時再繼續。",
      quiet: "不用急，這個本機畫面會留在這裡。",
    },
    "above-baseline": {
      general: "今天的本機活動高於近期個人基準；照舒服的步調就好。",
      active: "最近的節奏比自己的基準活躍一些；下一步由你決定。",
      quiet: "活動高於近期基準，想停一下也完全可以。",
    },
    "below-baseline": {
      general: "今天的本機活動低於近期個人基準；自然節奏本來就會變化。",
      active: "本機節奏比自己的基準安靜一些，不需要特別改變。",
      quiet: "安靜的一天也是個人模式中自然的一部分。",
    },
    "new-tool": {
      general: "本機摘要出現新的工具類別；可以慢慢觀察它是否適合你的習慣。",
      active: "有新的工具類別，覺得有幫助時再探索就好。",
      quiet: "已記下新的類別，留待之後看看也完全可以。",
    },
    night: {
      general: "夜深了；如果想休息，本機進度會留在這裡。",
      active: "今天隨時可以在這裡告一段落。",
      quiet: "這個時間適合安靜停一停；本機內容都可以等。",
    },
    "collector-error": {
      general: "最新摘要不完整；可以稍後再試，本機功能仍可使用。",
      active: "收集器這次沒有完成；現在不需要處理任何事。",
      quiet: "目前有些摘要資料無法取得，之後再回來也可以。",
    },
  },
  en: {
    greeting: {
      general: "Ready whenever you are.",
      active: "There is room to explore at your own pace.",
      quiet: "A quiet start is welcome too.",
    },
    idle: {
      general: "A pause is perfectly fine; I will stay quietly nearby.",
      active: "You can pause here and return when it feels right.",
      quiet: "No rush. This local view will be here when you return.",
    },
    "above-baseline": {
      general:
        "Today's local activity is above your recent personal baseline. Follow the pace that feels comfortable.",
      active:
        "The recent rhythm is livelier than your own baseline; you choose what happens next.",
      quiet:
        "Activity is above your recent baseline, and taking a pause is always fine.",
    },
    "below-baseline": {
      general:
        "Today's local activity is below your recent personal baseline. Natural rhythms vary.",
      active:
        "The local rhythm is quieter than your baseline; there is nothing you need to change.",
      quiet: "A quieter day is a valid part of your personal pattern.",
    },
    "new-tool": {
      general:
        "A new tool category appeared in the local summary. You can observe whether it suits your routine.",
      active: "There is a new tool category to explore only if it feels useful.",
      quiet: "A new category is noted; leaving it for later is completely fine.",
    },
    night: {
      general: "It is late. If you want to rest, your local progress will remain here.",
      active: "The day can end here whenever you choose.",
      quiet: "A quiet pause fits the hour. Everything local can wait.",
    },
    "collector-error": {
      general:
        "The latest summary was incomplete. You can try again later; local features remain available.",
      active:
        "The collector could not finish this pass. Nothing needs your immediate attention.",
      quiet:
        "Some summary data is unavailable right now. It is fine to leave it and return later.",
    },
  },
} as const satisfies Record<
  FixedLineLocale,
  Readonly<Record<FixedLineTrigger, VariantCopy>>
>;

const LEADS = {
  chatgpt: { "zh-TW": "我在。", en: "I’m here." },
  claude: { "zh-TW": "慢慢來。", en: "Take your time." },
  gemini: { "zh-TW": "一起看看。", en: "Let’s take a look." },
  grok: { "zh-TW": "收到。", en: "Got it." },
} as const satisfies Record<CharacterId, Record<FixedLineLocale, string>>;

const ACTIVE_MOODS = ["lively"] as const satisfies readonly MonsterMood[];
const QUIET_MOODS = [
  "learning",
  "unknown",
  "resting",
  "quiet",
] as const satisfies readonly MonsterMood[];
const NO_MOODS: readonly MonsterMood[] = Object.freeze([]);
const NO_TRAITS: readonly MonsterTrait[] = Object.freeze([]);

const VARIANT_ELIGIBILITY: Readonly<
  Record<
    LineVariant,
    Readonly<{
      moods: readonly MonsterMood[];
      traits: readonly MonsterTrait[];
    }>
  >
> = Object.freeze({
  general: Object.freeze({ moods: NO_MOODS, traits: NO_TRAITS }),
  active: Object.freeze({
    moods: Object.freeze([...ACTIVE_MOODS]),
    traits: NO_TRAITS,
  }),
  quiet: Object.freeze({
    moods: Object.freeze([...QUIET_MOODS]),
    traits: NO_TRAITS,
  }),
});

const LINE_VARIANTS = ["general", "active", "quiet"] as const satisfies readonly LineVariant[];

function createCooldown(
  characterId: CharacterId,
  trigger: FixedLineTrigger,
): CooldownMetadata {
  const policy = FIXED_LINE_COOLDOWNS[trigger];
  return Object.freeze({
    scope: "character-trigger",
    key: `${characterId}:${trigger}`,
    durationMs: policy.durationMs,
    dailyCap: policy.dailyCap,
  });
}

function buildLineDefinitions(): readonly FixedLineDefinition[] {
  const lines: FixedLineDefinition[] = [];
  for (const characterId of CHARACTER_IDS) {
    for (const locale of FIXED_LINE_LOCALES) {
      for (const trigger of FIXED_LINE_TRIGGERS) {
        for (const variant of LINE_VARIANTS) {
          const eligibility = VARIANT_ELIGIBILITY[variant];
          const lineId = `fixed-line/${FIXED_LINE_CONTENT_VERSION}/${characterId}/${locale}/${trigger}/${variant}`;
          const parsed = FixedLineDefinitionSchema.parse({
              schemaVersion: FIXED_LINE_SCHEMA_VERSION,
              contentVersion: FIXED_LINE_CONTENT_VERSION,
              lineId,
              characterId,
              locale,
              trigger,
              variant,
              eligibleMoods: eligibility.moods,
              eligibleTraits: eligibility.traits,
              text: `${LEADS[characterId][locale]} ${COPY[locale][trigger][variant]}`,
              cooldown: createCooldown(characterId, trigger),
              contentRating: FIXED_LINE_CONTENT_RATING,
              provenance: {
                kind: "tokenmonster-original-copy",
                sourceId: "tokenmonster-fixed-lines-v1",
                licenseStatus: FIXED_LINE_LICENSE_STATUS,
              },
              fallbackLineId:
                variant === "general"
                  ? null
                  : `fixed-line/${FIXED_LINE_CONTENT_VERSION}/${characterId}/${locale}/${trigger}/general`,
            });
          Object.freeze(parsed.eligibleMoods);
          Object.freeze(parsed.eligibleTraits);
          Object.freeze(parsed.cooldown);
          Object.freeze(parsed.provenance);
          lines.push(Object.freeze(parsed));
        }
      }
    }
  }
  const lineIds = new Set(lines.map(({ lineId }) => lineId));
  for (const line of lines) {
    if (line.fallbackLineId !== null && !lineIds.has(line.fallbackLineId)) {
      throw new Error(`Missing fixed-line fallback: ${line.fallbackLineId}`);
    }
  }
  return Object.freeze(lines);
}

const FIXED_LINE_DEFINITIONS = buildLineDefinitions();

export function listFixedLineDefinitions(): readonly FixedLineDefinition[] {
  return FIXED_LINE_DEFINITIONS;
}

export function resolveFixedLineLocale(requestedLocale: string): FixedLineLocale {
  const normalized = requestedLocale.trim().replaceAll("_", "-").toLowerCase();
  if (normalized === "zh" || normalized.startsWith("zh-tw") || normalized.startsWith("zh-hant")) {
    return "zh-TW";
  }
  if (normalized === "en" || normalized.startsWith("en-")) {
    return "en";
  }
  return "en";
}

function matchesLine(
  line: FixedLineDefinition,
  mood: MonsterMood,
  traits: readonly MonsterTrait[],
): boolean {
  if (line.variant === "general") {
    return true;
  }
  return (
    line.eligibleMoods.includes(mood) ||
    traits.some((trait) => line.eligibleTraits.includes(trait))
  );
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function selectFixedLine(input: FixedLineSelectionInput): FixedLineSelection;
export function selectFixedLine(input: unknown): FixedLineSelection;
export function selectFixedLine(input: unknown): FixedLineSelection {
  const parsed = FixedLineSelectionInputSchema.parse(input);
  const locale = resolveFixedLineLocale(parsed.locale);
  const sortedTraits = parsed.traits.toSorted();
  const candidates = FIXED_LINE_DEFINITIONS.filter(
    (line) =>
      line.characterId === parsed.characterId &&
      line.locale === locale &&
      line.trigger === parsed.trigger &&
      matchesLine(line, parsed.mood, sortedTraits),
  );
  const selectionKey = [
    FIXED_LINE_SCHEMA_VERSION,
    FIXED_LINE_CONTENT_VERSION,
    parsed.characterId,
    locale,
    parsed.trigger,
    parsed.mood,
    sortedTraits.join(","),
    String(parsed.seed),
  ].join("|");
  const selected = candidates[fnv1a32(selectionKey) % candidates.length];
  if (selected === undefined) {
    throw new Error("Fixed-line catalog invariant failed: no candidate line");
  }

  return Object.freeze({
    schemaVersion: selected.schemaVersion,
    contentVersion: selected.contentVersion,
    lineId: selected.lineId,
    characterId: selected.characterId,
    requestedLocale: parsed.locale,
    locale,
    trigger: selected.trigger,
    text: selected.text,
    cooldown: selected.cooldown,
  });
}

/**
 * Strict integration boundary for the monster engine. The full derivation is
 * parsed before only its content-blind mood and trait IDs reach copy selection.
 */
export function selectFixedLineFromMonsterDerivation(
  contextInput: FixedLineDerivationContext,
  derivationInput: MonsterDerivationV1,
): FixedLineSelection;
export function selectFixedLineFromMonsterDerivation(
  contextInput: unknown,
  derivationInput: unknown,
): FixedLineSelection;
export function selectFixedLineFromMonsterDerivation(
  contextInput: unknown,
  derivationInput: unknown,
): FixedLineSelection {
  const context = FixedLineDerivationContextSchema.parse(contextInput);
  const traitView = readonlyTraitViewFromMonsterDerivation(derivationInput);
  return selectFixedLine({
    ...context,
    mood: traitView.mood,
    traits: traitView.traits,
  });
}
