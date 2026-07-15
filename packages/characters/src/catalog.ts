import { z } from "zod";

export const CHARACTER_IDS = ["chatgpt", "claude", "gemini", "grok"] as const;

export type CharacterId = (typeof CHARACTER_IDS)[number];

export const CharacterIdSchema = z.enum(CHARACTER_IDS);

export const PROVIDER_RELATIONSHIP = "provider-inspired" as const;
export const PROVIDER_AFFILIATION = "independent-unaffiliated" as const;

const VisibleContextFieldSchema = z.enum([
  "characterId",
  "locale",
  "mood",
  "traitIds",
  "trigger",
]);

export type VisibleContextField = z.infer<typeof VisibleContextFieldSchema>;

export const CharacterDefinitionSchema = z
  .object({
    id: CharacterIdSchema,
    alias: z.string().min(1),
    glyph: z.string().length(1),
    description: z.string().min(1),
    inspiration: z
      .object({
        providerName: z.string().min(1),
        productName: z.string().min(1),
        relationship: z.literal(PROVIDER_RELATIONSHIP),
        affiliation: z.literal(PROVIDER_AFFILIATION),
      })
      .strict(),
    disclosure: z
      .object({
        "zh-TW": z.string().min(1),
        en: z.string().min(1),
      })
      .strict(),
    personaContext: z
      .object({
        schemaVersion: z.literal("1"),
        tone: z.array(z.string().min(1)).min(1),
        manner: z.string().min(1),
        allowedVisibleContext: z.array(VisibleContextFieldSchema),
        safeguards: z
          .object({
            providerAffiliationClaim: z.literal("never"),
            providerEndorsementClaim: z.literal("never"),
            billingAuthority: z.literal("none"),
            hiddenContentAccess: z.literal("none"),
            encourageTokenConsumption: z.literal("never"),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type CharacterDefinition = Readonly<{
  id: CharacterId;
  alias: string;
  glyph: string;
  description: string;
  inspiration: Readonly<{
    providerName: string;
    productName: string;
    relationship: typeof PROVIDER_RELATIONSHIP;
    affiliation: typeof PROVIDER_AFFILIATION;
  }>;
  disclosure: Readonly<Record<"zh-TW" | "en", string>>;
  personaContext: Readonly<{
    schemaVersion: "1";
    tone: readonly string[];
    manner: string;
    allowedVisibleContext: readonly VisibleContextField[];
    safeguards: Readonly<{
      providerAffiliationClaim: "never";
      providerEndorsementClaim: "never";
      billingAuthority: "none";
      hiddenContentAccess: "none";
      encourageTokenConsumption: "never";
    }>;
  }>;
}>;

const INDEPENDENCE_DISCLOSURE = {
  "zh-TW":
    "這是受供應商產品啟發的虛構角色；TokenMonster 為獨立產品，未與該供應商合作、隸屬或獲其背書。",
  en: "This is a fictional, provider-inspired character. TokenMonster is independent, unaffiliated, and not endorsed by that provider.",
} as const;

const SAFEGUARDS = {
  providerAffiliationClaim: "never",
  providerEndorsementClaim: "never",
  billingAuthority: "none",
  hiddenContentAccess: "none",
  encourageTokenConsumption: "never",
} as const;

const ALLOWED_VISIBLE_CONTEXT = [
  "characterId",
  "locale",
  "mood",
  "traitIds",
  "trigger",
] as const satisfies readonly VisibleContextField[];

const RAW_CHARACTER_CATALOG = [
  {
    id: "chatgpt",
    alias: "Aster",
    glyph: "T",
    description: "A calm, practical guide who keeps choices clear and pressure-free.",
    inspiration: {
      providerName: "OpenAI",
      productName: "ChatGPT",
      relationship: PROVIDER_RELATIONSHIP,
      affiliation: PROVIDER_AFFILIATION,
    },
    disclosure: INDEPENDENCE_DISCLOSURE,
    personaContext: {
      schemaVersion: "1",
      tone: ["calm", "clear", "supportive"],
      manner: "Offer concise options and let the user choose the pace.",
      allowedVisibleContext: ALLOWED_VISIBLE_CONTEXT,
      safeguards: SAFEGUARDS,
    },
  },
  {
    id: "claude",
    alias: "Cedar",
    glyph: "C",
    description: "A thoughtful companion who makes room for pauses and nuance.",
    inspiration: {
      providerName: "Anthropic",
      productName: "Claude",
      relationship: PROVIDER_RELATIONSHIP,
      affiliation: PROVIDER_AFFILIATION,
    },
    disclosure: INDEPENDENCE_DISCLOSURE,
    personaContext: {
      schemaVersion: "1",
      tone: ["thoughtful", "gentle", "measured"],
      manner: "Acknowledge uncertainty and avoid urgency or judgment.",
      allowedVisibleContext: ALLOWED_VISIBLE_CONTEXT,
      safeguards: SAFEGUARDS,
    },
  },
  {
    id: "gemini",
    alias: "Mira",
    glyph: "G",
    description: "A curious observer who notices patterns without grading them.",
    inspiration: {
      providerName: "Google",
      productName: "Gemini",
      relationship: PROVIDER_RELATIONSHIP,
      affiliation: PROVIDER_AFFILIATION,
    },
    disclosure: INDEPENDENCE_DISCLOSURE,
    personaContext: {
      schemaVersion: "1",
      tone: ["curious", "balanced", "warm"],
      manner: "Frame local patterns as observations, never as a score.",
      allowedVisibleContext: ALLOWED_VISIBLE_CONTEXT,
      safeguards: SAFEGUARDS,
    },
  },
  {
    id: "grok",
    alias: "Rook",
    glyph: "X",
    description: "A direct, upbeat scout who stays playful without applying pressure.",
    inspiration: {
      providerName: "xAI",
      productName: "Grok",
      relationship: PROVIDER_RELATIONSHIP,
      affiliation: PROVIDER_AFFILIATION,
    },
    disclosure: INDEPENDENCE_DISCLOSURE,
    personaContext: {
      schemaVersion: "1",
      tone: ["direct", "light", "respectful"],
      manner: "Keep observations brief, optional, and free of consumption goals.",
      allowedVisibleContext: ALLOWED_VISIBLE_CONTEXT,
      safeguards: SAFEGUARDS,
    },
  },
] as const;

function freezeDefinition(value: z.infer<typeof CharacterDefinitionSchema>): CharacterDefinition {
  return Object.freeze({
    ...value,
    inspiration: Object.freeze({ ...value.inspiration }),
    disclosure: Object.freeze({ ...value.disclosure }),
    personaContext: Object.freeze({
      ...value.personaContext,
      tone: Object.freeze([...value.personaContext.tone]),
      allowedVisibleContext: Object.freeze([...value.personaContext.allowedVisibleContext]),
      safeguards: Object.freeze({ ...value.personaContext.safeguards }),
    }),
  });
}

export const CHARACTER_CATALOG: readonly CharacterDefinition[] = Object.freeze(
  RAW_CHARACTER_CATALOG.map((value) =>
    freezeDefinition(CharacterDefinitionSchema.parse(value)),
  ),
);

const CHARACTER_BY_ID = new Map(
  CHARACTER_CATALOG.map((character) => [character.id, character] as const),
);

export function listCharacters(): readonly CharacterDefinition[] {
  return CHARACTER_CATALOG;
}

export function getCharacterDefinition(characterId: CharacterId): CharacterDefinition {
  const character = CHARACTER_BY_ID.get(characterId);
  if (character === undefined) {
    throw new Error(`Unknown character ID: ${characterId}`);
  }
  return character;
}
