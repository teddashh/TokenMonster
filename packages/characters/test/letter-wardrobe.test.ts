import { describe, expect, it } from "vitest";

import {
  LETTER_WARDROBE_ACCENT_IDS,
  LETTER_WARDROBE_CATALOG,
  LETTER_WARDROBE_PATTERN_IDS,
  LetterWardrobeCatalogSchema,
  LetterWardrobeThemeSchema,
  WARDROBE_THEME_IDS,
  getLetterWardrobeTheme,
} from "../src/index.js";

const EXACT_THEME_COLORS_AND_PATTERNS = [
  ["tech", "#0B1F33", "#F8FAFC", "#5EEAD4", "circuit-grid"],
  ["finance", "#102A1F", "#F8FAFC", "#86EFAC", "ledger-grid"],
  ["politics", "#24133D", "#F8FAFC", "#D8B4FE", "civic-ribbons"],
  ["education", "#172554", "#F8FAFC", "#93C5FD", "notebook-lines"],
  ["health", "#3F1725", "#F8FAFC", "#FDA4AF", "pulse-steps"],
  ["environment", "#12372A", "#F8FAFC", "#A7F3D0", "leaf-canopy"],
  ["law", "#242424", "#F8FAFC", "#FDE68A", "balanced-scales"],
  ["relationship", "#3B1535", "#F8FAFC", "#F9A8D4", "interlocking-rings"],
  ["family", "#3A220F", "#F8FAFC", "#FCD34D", "woven-home"],
  ["workplace", "#1E293B", "#F8FAFC", "#CBD5E1", "checklist-grid"],
  ["science", "#082F49", "#F8FAFC", "#67E8F9", "constellation"],
  ["culture", "#3B1D0B", "#F8FAFC", "#FDBA74", "story-weave"],
  ["sports", "#3F1D14", "#F8FAFC", "#FDBA74", "speed-stripes"],
  ["food", "#3B2605", "#F8FAFC", "#FDE047", "table-check"],
  ["travel", "#172554", "#F8FAFC", "#A5B4FC", "route-dashes"],
  ["psychology", "#2E1065", "#F8FAFC", "#C4B5FD", "soft-waves"],
  ["philosophy", "#1C1917", "#F8FAFC", "#D6D3D1", "nested-circles"],
  ["international", "#0F2E2E", "#F8FAFC", "#99F6E4", "linked-arcs"],
  ["media", "#3B1426", "#F8FAFC", "#F9A8D4", "broadcast-rings"],
  ["festival", "#3B1B0B", "#F8FAFC", "#FDE68A", "confetti"],
] as const;

describe("code-native letter wardrobe", () => {
  it("pins all twenty themes, colors, patterns, and accents in progression order", () => {
    expect(LetterWardrobeCatalogSchema.parse(LETTER_WARDROBE_CATALOG)).toBeDefined();
    expect(LETTER_WARDROBE_CATALOG.map(({ themeId }) => themeId)).toEqual(
      WARDROBE_THEME_IDS,
    );
    expect(
      LETTER_WARDROBE_CATALOG.map(({ themeId, palette, pattern }) => [
        themeId,
        palette.background,
        palette.foreground,
        palette.accent,
        pattern.id,
      ]),
    ).toEqual(EXACT_THEME_COLORS_AND_PATTERNS);
    expect(LETTER_WARDROBE_CATALOG.map(({ pattern }) => pattern.id)).toEqual(
      LETTER_WARDROBE_PATTERN_IDS,
    );
    expect(LETTER_WARDROBE_CATALOG.map(({ accent }) => accent.id)).toEqual(
      LETTER_WARDROBE_ACCENT_IDS,
    );
    expect(getLetterWardrobeTheme("festival")).toBe(
      LETTER_WARDROBE_CATALOG.at(-1),
    );
  });

  it("requires AAA letter contrast and high-contrast accent/pattern colors", () => {
    const valid = LETTER_WARDROBE_CATALOG[0]!;
    expect(() =>
      LetterWardrobeThemeSchema.parse({
        ...valid,
        palette: { ...valid.palette, foreground: "#52606D" },
      }),
    ).toThrow(/7:1/u);
    expect(() =>
      LetterWardrobeThemeSchema.parse({
        ...valid,
        palette: { ...valid.palette, accent: "#52606D" },
      }),
    ).toThrow(/4.5:1/u);
  });

  it("rejects reordered, duplicated, and extra transport or asset metadata", () => {
    const reordered = [
      LETTER_WARDROBE_CATALOG[1]!,
      LETTER_WARDROBE_CATALOG[0]!,
      ...LETTER_WARDROBE_CATALOG.slice(2),
    ];
    expect(() => LetterWardrobeCatalogSchema.parse(reordered)).toThrow(
      /canonical progression order/u,
    );

    const duplicatePattern = LETTER_WARDROBE_CATALOG.map((theme, index) =>
      index === 1
        ? { ...theme, pattern: { ...theme.pattern, id: "circuit-grid" as const } }
        : theme,
    );
    expect(() => LetterWardrobeCatalogSchema.parse(duplicatePattern)).toThrow(
      /distinct pattern/u,
    );

    expect(() =>
      LetterWardrobeThemeSchema.parse({
        ...LETTER_WARDROBE_CATALOG[0]!,
        assetUrl: "https://must-not-enter.example/theme.png",
      }),
    ).toThrow();
    expect(JSON.stringify(LETTER_WARDROBE_CATALOG)).not.toMatch(
      /(?:https?:|file:|\.png|\.webp|\.wav)/u,
    );
  });

  it("is deeply frozen so runtime consumers cannot drift the shared catalog", () => {
    expect(Object.isFrozen(LETTER_WARDROBE_CATALOG)).toBe(true);
    for (const theme of LETTER_WARDROBE_CATALOG) {
      expect(Object.isFrozen(theme)).toBe(true);
      expect(Object.isFrozen(theme.palette)).toBe(true);
      expect(Object.isFrozen(theme.pattern)).toBe(true);
      expect(Object.isFrozen(theme.accent)).toBe(true);
    }
  });
});
