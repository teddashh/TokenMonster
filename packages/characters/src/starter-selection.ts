import { z } from "zod";

import { CharacterIdSchema, type CharacterId } from "./catalog.js";

export const STARTER_PROVIDER_FAMILIES = [
  "openai",
  "anthropic",
  "google",
  "xai",
] as const;

export type StarterProviderFamily = (typeof STARTER_PROVIDER_FAMILIES)[number];

export const StarterProviderFamilySchema = z.enum(STARTER_PROVIDER_FAMILIES);

export const STARTER_CHARACTER_BY_PROVIDER_FAMILY = Object.freeze({
  openai: "chatgpt",
  anthropic: "claude",
  google: "gemini",
  xai: "grok",
} as const satisfies Readonly<Record<StarterProviderFamily, CharacterId>>);

const ProviderTotal28DaysSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const StarterProviderTotals28DaysSchema = z
  .object({
    openai: ProviderTotal28DaysSchema,
    anthropic: ProviderTotal28DaysSchema,
    google: ProviderTotal28DaysSchema,
    xai: ProviderTotal28DaysSchema,
  })
  .strict();

export type StarterProviderTotals28Days = Readonly<
  z.infer<typeof StarterProviderTotals28DaysSchema>
>;

export const StarterSelectionInputSchema = z
  .object({
    manualCharacterId: CharacterIdSchema.nullable().optional(),
    providerTotals28Days: StarterProviderTotals28DaysSchema.nullable(),
  })
  .strict();

export type StarterSelectionInput = Readonly<
  z.infer<typeof StarterSelectionInputSchema>
>;

export type StarterCharacterSelection =
  | Readonly<{
      outcome: "selected";
      selectedBy: "manual";
      characterId: CharacterId;
    }>
  | Readonly<{
      outcome: "selected";
      selectedBy: "unique-provider-total";
      characterId: CharacterId;
      providerFamily: StarterProviderFamily;
    }>
  | Readonly<{
      outcome: "user-choice-required";
      reason: "no-positive-provider-data";
      tiedProviderFamilies: readonly [];
    }>
  | Readonly<{
      outcome: "user-choice-required";
      reason: "highest-provider-total-tie";
      tiedProviderFamilies: readonly StarterProviderFamily[];
    }>;

/**
 * Selects only a starter presentation. Provider totals never become character
 * capabilities, progression, or access gates.
 */
export function selectStarterCharacter(
  input: StarterSelectionInput,
): StarterCharacterSelection;
export function selectStarterCharacter(
  input: unknown,
): StarterCharacterSelection;
export function selectStarterCharacter(
  input: unknown,
): StarterCharacterSelection {
  const parsed = StarterSelectionInputSchema.parse(input);

  if (
    parsed.manualCharacterId !== undefined &&
    parsed.manualCharacterId !== null
  ) {
    return Object.freeze({
      outcome: "selected",
      selectedBy: "manual",
      characterId: parsed.manualCharacterId,
    });
  }

  if (parsed.providerTotals28Days === null) {
    return Object.freeze({
      outcome: "user-choice-required",
      reason: "no-positive-provider-data",
      tiedProviderFamilies: Object.freeze([] as const),
    });
  }

  let highestTotal = 0;
  let leaders: StarterProviderFamily[] = [];
  for (const providerFamily of STARTER_PROVIDER_FAMILIES) {
    const total = parsed.providerTotals28Days[providerFamily];
    if (total > highestTotal) {
      highestTotal = total;
      leaders = [providerFamily];
    } else if (total === highestTotal && total > 0) {
      leaders.push(providerFamily);
    }
  }

  if (highestTotal === 0) {
    return Object.freeze({
      outcome: "user-choice-required",
      reason: "no-positive-provider-data",
      tiedProviderFamilies: Object.freeze([] as const),
    });
  }

  if (leaders.length !== 1) {
    return Object.freeze({
      outcome: "user-choice-required",
      reason: "highest-provider-total-tie",
      tiedProviderFamilies: Object.freeze([...leaders]),
    });
  }

  const providerFamily = leaders[0]!;
  return Object.freeze({
    outcome: "selected",
    selectedBy: "unique-provider-total",
    characterId: STARTER_CHARACTER_BY_PROVIDER_FAMILY[providerFamily],
    providerFamily,
  });
}
