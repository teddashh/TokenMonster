import { z } from "zod";

import {
  CHARACTER_IDS,
  CharacterIdSchema,
  type CharacterId,
} from "./catalog.js";
import {
  FIXED_LINE_CONTENT_VERSION,
  FIXED_LINE_LOCALES,
  FixedLineLocaleSchema,
  MonsterMoodSchema,
  MonsterTraitSchema,
  selectFixedLine,
  type FixedLineLocale,
  type MonsterMood,
  type MonsterTrait,
} from "./fixed-lines.js";

export const FRIEND_TAP_CHARACTER_IDS = [
  "deepseek",
  "qwen",
  "mistral",
  "venice",
  "sakana",
  "perplexity",
  "glm",
] as const;

export type FriendTapCharacterId = (typeof FRIEND_TAP_CHARACTER_IDS)[number];
export const FriendTapCharacterIdSchema = z.enum(FRIEND_TAP_CHARACTER_IDS);

export const TAP_CHARACTER_IDS = [
  ...CHARACTER_IDS,
  ...FRIEND_TAP_CHARACTER_IDS,
] as const;
export type TapCharacterId = (typeof TAP_CHARACTER_IDS)[number];
export const TapCharacterIdSchema = z.enum(TAP_CHARACTER_IDS);

export const TAP_LINE_SCHEMA_VERSION = "1" as const;
export const TAP_LINE_CONTENT_VERSION = "1.0.0" as const;
export const TAP_LINE_CONTENT_RATING = "general-audience" as const;
export const TAP_LINE_LICENSE_STATUS = "project-license-pending" as const;

const FriendTapLineDefinitionSchema = z
  .object({
    schemaVersion: z.literal(TAP_LINE_SCHEMA_VERSION),
    contentVersion: z.literal(TAP_LINE_CONTENT_VERSION),
    lineId: z
      .string()
      .regex(/^tap-line\/1\.0\.0\/[a-z0-9-]+\/(?:zh-TW|en)\/[a-z0-9-]+$/u)
      .max(96),
    characterId: FriendTapCharacterIdSchema,
    locale: FixedLineLocaleSchema,
    variant: z.enum(["hello", "observe", "cheer"]),
    text: z.string().trim().min(1).max(180),
    contentRating: z.literal(TAP_LINE_CONTENT_RATING),
    provenance: z
      .object({
        kind: z.literal("tokenmonster-original-copy"),
        sourceId: z.literal("tokenmonster-friend-tap-lines-v1"),
        licenseStatus: z.literal(TAP_LINE_LICENSE_STATUS),
      })
      .strict(),
  })
  .strict()
  .superRefine((line, context) => {
    if (
      line.lineId !==
      `tap-line/${TAP_LINE_CONTENT_VERSION}/${line.characterId}/${line.locale}/${line.variant}`
    ) {
      context.addIssue({
        code: "custom",
        path: ["lineId"],
        message: "lineId must exactly match the declared dimensions.",
      });
    }
  });

export type FriendTapLineDefinition = Readonly<
  z.infer<typeof FriendTapLineDefinitionSchema>
>;

const FriendTapCopySchema = z
  .record(
    FriendTapCharacterIdSchema,
    z
      .object({
        "zh-TW": z.tuple([
          z.string().trim().min(1).max(180),
          z.string().trim().min(1).max(180),
          z.string().trim().min(1).max(180),
        ]),
        en: z.tuple([
          z.string().trim().min(1).max(180),
          z.string().trim().min(1).max(180),
          z.string().trim().min(1).max(180),
        ]),
      })
      .strict(),
  )
  .refine(
    (copy) => Reflect.ownKeys(copy).length === FRIEND_TAP_CHARACTER_IDS.length,
    { message: "tap copy must cover every friend" },
  );

const FRIEND_TAP_COPY = FriendTapCopySchema.parse({
  deepseek: {
    "zh-TW": [
      "水面很安靜，底下也許藏著一個好點子。要一起看看嗎？",
      "我把複雜的線頭先放整齊了，你想從哪一條開始都可以。",
      "找到一小塊清楚的地方，也算很棒的進展。",
    ],
    en: [
      "The surface is calm, and a good idea may be hiding underneath. Want to take a look together?",
      "I set the tangled threads in a neat row. You can start with whichever one feels right.",
      "Finding one small patch of clarity is a lovely bit of progress.",
    ],
  },
  qwen: {
    "zh-TW": [
      "我帶了一盒彩色標籤，想把哪個念頭好好收進來？",
      "這個點子有幾個有趣的抽屜，我們可以隨意打開一格。",
      "先把最順眼的那一塊拼上去，其他的慢慢來就好。",
    ],
    en: [
      "I brought a box of colorful labels. Which thought would you like to tuck away neatly?",
      "This idea has a few interesting drawers. We can open any one of them.",
      "Fit the piece that looks friendliest first. The rest can wait.",
    ],
  },
  mistral: {
    "zh-TW": [
      "風剛剛好，想往哪個方向看看？",
      "有些想法適合攤開透透氣，我幫你留住紙角。",
      "不用一次看完整張地圖，挑一條舒服的小路就好。",
    ],
    en: [
      "The breeze feels just right. Which direction should we look?",
      "Some ideas are nicer with a little air around them. I will hold down the corners.",
      "You do not need the whole map at once. A comfortable little path is enough.",
    ],
  },
  venice: {
    "zh-TW": [
      "這裡像一座安靜的小露台，想停一下也很適合。",
      "我替這個念頭留了一張靠窗的椅子。",
      "水波慢慢走，還沒決定的事也可以先放著。",
    ],
    en: [
      "This feels like a quiet little terrace. It is a good place to pause.",
      "I saved this thought a chair by the window.",
      "The water can ripple on. Undecided things are welcome to rest here.",
    ],
  },
  sakana: {
    "zh-TW": [
      "小魚群轉了個圈，好像在替你的新點子讓路。",
      "我聽見一顆泡泡啵了一聲，也許它有話想說。",
      "不同方向一起游，有時反而會拼出可愛的形狀。",
    ],
    en: [
      "The little school made a turn, as if clearing a path for your new idea.",
      "I heard a bubble pop. Maybe it had something to say.",
      "Swimming in different directions can still make a delightful shape.",
    ],
  },
  perplexity: {
    "zh-TW": [
      "我有一盞小小的提問燈，想照亮哪個角落？",
      "好奇心剛敲了敲門，我們可以只開一條小縫。",
      "一個好問題不必急著回答，先陪它坐一下也很好。",
    ],
    en: [
      "I have a tiny question-lantern. Which corner should we light up?",
      "Curiosity just knocked. We can open the door only a crack.",
      "A good question does not need a rushed answer. We can sit with it for a while.",
    ],
  },
  glm: {
    "zh-TW": [
      "齒輪輕輕轉了一格，要不要把一個想法拼起來？",
      "我找到一塊還沒命名的小零件，你覺得它像什麼？",
      "這座小工作台一直在，想動手時我們再開始。",
    ],
    en: [
      "A gear clicked gently into place. Want to piece an idea together?",
      "I found a little unnamed part. What do you think it looks like?",
      "This tiny workbench will stay here. We can begin whenever you feel like it.",
    ],
  },
});

const TAP_VARIANTS = ["hello", "observe", "cheer"] as const;

function buildFriendTapLineCatalog(): readonly FriendTapLineDefinition[] {
  const lines: FriendTapLineDefinition[] = [];
  for (const characterId of FRIEND_TAP_CHARACTER_IDS) {
    for (const locale of FIXED_LINE_LOCALES) {
      const copy = FRIEND_TAP_COPY[characterId][locale];
      for (const [index, variant] of TAP_VARIANTS.entries()) {
        const parsed = FriendTapLineDefinitionSchema.parse({
          schemaVersion: TAP_LINE_SCHEMA_VERSION,
          contentVersion: TAP_LINE_CONTENT_VERSION,
          lineId: `tap-line/${TAP_LINE_CONTENT_VERSION}/${characterId}/${locale}/${variant}`,
          characterId,
          locale,
          variant,
          text: copy[index],
          contentRating: TAP_LINE_CONTENT_RATING,
          provenance: {
            kind: "tokenmonster-original-copy",
            sourceId: "tokenmonster-friend-tap-lines-v1",
            licenseStatus: TAP_LINE_LICENSE_STATUS,
          },
        });
        Object.freeze(parsed.provenance);
        lines.push(Object.freeze(parsed));
      }
    }
  }
  return Object.freeze(lines);
}

export const FRIEND_TAP_LINE_CATALOG = buildFriendTapLineCatalog();

const TapLineTraitsSchema = z
  .array(MonsterTraitSchema)
  .max(3)
  .refine((traits) => new Set(traits).size === traits.length, {
    message: "tap traits must be unique",
  });

export const TapLineSelectionInputSchema = z
  .object({
    characterId: TapCharacterIdSchema,
    locale: FixedLineLocaleSchema,
    seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    mood: MonsterMoodSchema.optional(),
    traits: TapLineTraitsSchema.optional(),
  })
  .strict();

export type TapLineSelectionInput = Readonly<{
  characterId: TapCharacterId;
  locale: FixedLineLocale;
  seed: number;
  mood?: MonsterMood;
  traits?: readonly MonsterTrait[];
}>;

export interface TapLineSelection {
  readonly lineId: string;
  readonly characterId: TapCharacterId;
  readonly locale: FixedLineLocale;
  readonly text: string;
}

export function selectTapLine(input: TapLineSelectionInput): TapLineSelection;
export function selectTapLine(input: unknown): TapLineSelection;
export function selectTapLine(input: unknown): TapLineSelection {
  const parsed = TapLineSelectionInputSchema.parse(input);
  if (CharacterIdSchema.safeParse(parsed.characterId).success) {
    const line = selectFixedLine({
      characterId: parsed.characterId as CharacterId,
      locale: parsed.locale,
      trigger: "greeting",
      mood: parsed.mood ?? "unknown",
      traits: parsed.traits ?? [],
      seed: parsed.seed,
    });
    return Object.freeze({
      lineId: line.lineId,
      characterId: parsed.characterId,
      locale: line.locale,
      text: line.text,
    });
  }

  const candidates = FRIEND_TAP_LINE_CATALOG.filter(
    (line) =>
      line.characterId === parsed.characterId && line.locale === parsed.locale,
  );
  const selected = candidates[parsed.seed % candidates.length];
  if (selected === undefined) {
    throw new Error("Tap-line catalog invariant failed: no candidate line");
  }
  return Object.freeze({
    lineId: selected.lineId,
    characterId: selected.characterId,
    locale: selected.locale,
    text: selected.text,
  });
}

// Keep this explicit: tap routes accept only the two shipped catalogs and do
// not silently apply the broader fixed-line locale fallback behavior.
export const TAP_LINE_LOCALES: readonly FixedLineLocale[] = FIXED_LINE_LOCALES;

// Referenced by catalog tests to prove the starter path stays on the existing
// four-sister content identity instead of minting a second starter catalog.
export const STARTER_TAP_CONTENT_VERSION = FIXED_LINE_CONTENT_VERSION;
