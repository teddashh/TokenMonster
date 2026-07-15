import type { MonsterDerivationV1 } from "@tokenmonster/monster-engine";

import {
  CharacterIdSchema,
  getCharacterDefinition,
  type CharacterDefinition,
  type CharacterId,
} from "./catalog.js";
import {
  resolveCharacterVisual,
  type CharacterVisual,
} from "./assets.js";
import {
  createReadonlyTraitView,
  readonlyTraitViewFromMonsterDerivation,
  type ReadonlyTraitView,
} from "./monster-view.js";

export type CharacterPresentation = Readonly<{
  character: CharacterDefinition;
  visual: CharacterVisual;
  traitView: ReadonlyTraitView;
}>;

export function createCharacterPresentation(
  characterId: CharacterId,
  traitView: ReadonlyTraitView,
): CharacterPresentation {
  const parsedCharacterId = CharacterIdSchema.parse(characterId);
  const preservedTraitView = createReadonlyTraitView(traitView);

  return Object.freeze({
    character: getCharacterDefinition(parsedCharacterId),
    visual: resolveCharacterVisual(parsedCharacterId),
    traitView: preservedTraitView,
  });
}

export function switchCharacterPresentation(
  nextCharacterId: CharacterId,
  readonlyTraitView: ReadonlyTraitView,
): CharacterPresentation {
  return createCharacterPresentation(nextCharacterId, readonlyTraitView);
}

export function createCharacterPresentationFromMonsterDerivation(
  characterId: CharacterId,
  derivation: MonsterDerivationV1,
): CharacterPresentation;
export function createCharacterPresentationFromMonsterDerivation(
  characterId: CharacterId,
  derivation: unknown,
): CharacterPresentation;
export function createCharacterPresentationFromMonsterDerivation(
  characterId: CharacterId,
  derivation: unknown,
): CharacterPresentation {
  return createCharacterPresentation(
    characterId,
    readonlyTraitViewFromMonsterDerivation(derivation),
  );
}
