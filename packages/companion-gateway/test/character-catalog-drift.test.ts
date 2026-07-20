import {
  ASSET_CHARACTER_IDS,
  LETTER_WARDROBE_ACCENT_IDS,
  LETTER_WARDROBE_PATTERN_IDS,
  WARDROBE_THEME_IDS
} from "@tokenmonster/characters";
import { describe, expect, it } from "vitest";

import {
  CHARACTER_IDS,
  CHARACTER_LETTER_ACCENT_IDS,
  CHARACTER_LETTER_PATTERN_IDS,
  CHARACTER_THEME_IDS
} from "../../companion-ui/src/public/dto.js";
import { CHARACTER_ROSTER_IDS } from "../src/character-service.js";

describe("character catalog drift guard", () => {
  it("keeps manifest, gateway, and UI character IDs in exact order", () => {
    expect(ASSET_CHARACTER_IDS).toEqual(CHARACTER_ROSTER_IDS);
    expect(CHARACTER_IDS).toEqual(CHARACTER_ROSTER_IDS);
  });

  it("keeps manifest progression and UI themes in exact order", () => {
    expect(CHARACTER_THEME_IDS).toEqual(WARDROBE_THEME_IDS);
    expect(CHARACTER_LETTER_PATTERN_IDS).toEqual(
      LETTER_WARDROBE_PATTERN_IDS
    );
    expect(CHARACTER_LETTER_ACCENT_IDS).toEqual(LETTER_WARDROBE_ACCENT_IDS);
  });
});
