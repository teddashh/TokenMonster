import { describe, expect, it } from "vitest";

import { characterCollectionView } from "../src/public/collection.js";
import type { CharacterRosterEntry } from "../src/public/dto.js";

function character(
  characterId: CharacterRosterEntry["characterId"],
  unlocked: boolean,
  progress: number | null,
): CharacterRosterEntry {
  return {
    characterId,
    displayName: characterId,
    kind: "friend",
    unlocked,
    unlockedAt: unlocked ? "2026-07-17T12:00:00.000Z" : null,
    isStarter: false,
    starterPersona: null,
    activeThemeId: null,
    visual: {
      mode: "letter",
      glyph: "T",
      background: "#ffffff",
      foreground: "#111111",
      accent: "#555555",
      themes: [],
    },
    progress:
      progress === null
        ? null
        : { value: progress, explain: "本機自然累積的相遇進度。" },
    voiceLines: [],
  };
}

describe("character collection summary", () => {
  it("reports collection size and the closest locked progress without naming it", () => {
    const view = characterCollectionView([
      character("chatgpt", true, null),
      character("glm", false, 0.371),
      character("sakana", false, 0.755),
    ]);

    expect(view).toEqual({
      unlockedCount: 1,
      totalCount: 3,
      lockedCount: 2,
      nextProgressPercent: 76,
    });
    expect(Object.isFrozen(view)).toBe(true);
    expect(JSON.stringify(view)).not.toContain("glm");
    expect(JSON.stringify(view)).not.toContain("sakana");
  });

  it("has no next milestone after the full roster is collected", () => {
    expect(
      characterCollectionView([
        character("chatgpt", true, null),
        character("glm", true, null),
      ]),
    ).toEqual({
      unlockedCount: 2,
      totalCount: 2,
      lockedCount: 0,
      nextProgressPercent: null,
    });
  });

  it("handles an empty pre-bootstrap roster", () => {
    expect(characterCollectionView([])).toEqual({
      unlockedCount: 0,
      totalCount: 0,
      lockedCount: 0,
      nextProgressPercent: null,
    });
  });

  it("never presents a still-locked character as 100% complete", () => {
    expect(
      characterCollectionView([character("glm", false, 0.995)])
        .nextProgressPercent,
    ).toBe(99);
    expect(
      characterCollectionView([character("glm", false, 0.9999)])
        .nextProgressPercent,
    ).toBe(99);
  });
});
