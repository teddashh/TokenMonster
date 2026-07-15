import {
  MonsterDerivationV1Schema,
  MonsterMoodIdV1Schema,
  MonsterTraitIdV1Schema,
  type MonsterDerivationV1,
  type MonsterMoodIdV1,
  type MonsterTraitIdV1,
} from "@tokenmonster/monster-engine";
import { z } from "zod";

export const ReadonlyTraitViewSchema = z
  .object({
    mood: MonsterMoodIdV1Schema,
    traits: z
      .array(MonsterTraitIdV1Schema)
      .max(3)
      .refine((traits) => new Set(traits).size === traits.length, {
        message: "traits must be unique",
      }),
  })
  .strict();

export type ReadonlyTraitView = Readonly<{
  mood: MonsterMoodIdV1;
  traits: readonly MonsterTraitIdV1[];
}>;

export function createReadonlyTraitView(input: unknown): ReadonlyTraitView {
  const parsed = ReadonlyTraitViewSchema.parse(input);
  return Object.freeze({
    mood: parsed.mood,
    traits: Object.freeze([...parsed.traits]),
  });
}

/** Project the engine's exact, validated IDs into presentation-only data. */
export function readonlyTraitViewFromMonsterDerivation(
  derivationInput: MonsterDerivationV1,
): ReadonlyTraitView;
export function readonlyTraitViewFromMonsterDerivation(
  derivationInput: unknown,
): ReadonlyTraitView;
export function readonlyTraitViewFromMonsterDerivation(
  derivationInput: unknown,
): ReadonlyTraitView {
  const derivation = MonsterDerivationV1Schema.parse(derivationInput);
  return createReadonlyTraitView({
    mood: derivation.state.mood.id,
    traits: derivation.state.traits.map((trait) => trait.id),
  });
}
