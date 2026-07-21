import { describe, expect, it } from "vitest";

import {
  CHARACTER_IDS,
  FIXED_LINE_CONTENT_VERSION,
  FRIEND_TAP_CHARACTER_IDS,
  FRIEND_TAP_LINE_CATALOG,
  TAP_CHARACTER_IDS,
  TAP_LINE_CONTENT_RATING,
  TAP_LINE_LOCALES,
  TapLineSelectionInputSchema,
  selectTapLine,
} from "../src/index.js";

describe("character tap lines", () => {
  it("covers all seven friends in both locales with three original lines", () => {
    expect(TAP_CHARACTER_IDS).toEqual([
      ...CHARACTER_IDS,
      ...FRIEND_TAP_CHARACTER_IDS,
    ]);
    expect(FRIEND_TAP_LINE_CATALOG).toHaveLength(7 * 2 * 3);
    expect(
      new Set(FRIEND_TAP_LINE_CATALOG.map((line) => line.lineId)).size,
    ).toBe(FRIEND_TAP_LINE_CATALOG.length);

    for (const characterId of FRIEND_TAP_CHARACTER_IDS) {
      for (const locale of TAP_LINE_LOCALES) {
        const lines = FRIEND_TAP_LINE_CATALOG.filter(
          (line) => line.characterId === characterId && line.locale === locale,
        );
        expect(lines.map((line) => line.variant)).toEqual([
          "hello",
          "observe",
          "cheer",
        ]);
        expect(
          lines.every((line) => line.contentRating === TAP_LINE_CONTENT_RATING),
        ).toBe(true);
        expect(
          lines.every(
            (line) =>
              line.provenance.kind === "tokenmonster-original-copy" &&
              line.provenance.sourceId === "tokenmonster-friend-tap-lines-v1",
          ),
        ).toBe(true);
      }
    }
  });

  it("rotates friend copy deterministically without changing locale", () => {
    const selections = [0, 1, 2, 3].map((seed) =>
      selectTapLine({ characterId: "sakana", locale: "zh-TW", seed }),
    );
    expect(selections.map((line) => line.lineId)).toEqual([
      "tap-line/1.0.0/sakana/zh-TW/hello",
      "tap-line/1.0.0/sakana/zh-TW/observe",
      "tap-line/1.0.0/sakana/zh-TW/cheer",
      "tap-line/1.0.0/sakana/zh-TW/hello",
    ]);
    expect(selections.every((line) => line.locale === "zh-TW")).toBe(true);
  });

  it("reuses the existing greeting identity for the four starters", () => {
    for (const characterId of CHARACTER_IDS) {
      const selection = selectTapLine({
        characterId,
        locale: "en",
        seed: 7,
      });
      expect(selection.lineId).toMatch(
        new RegExp(
          `^fixed-line/${FIXED_LINE_CONTENT_VERSION}/${characterId}/en/greeting/`,
          "u",
        ),
      );
      expect(selection.text.length).toBeGreaterThan(0);
    }
  });

  it("keeps omitted profile context exactly backward compatible", () => {
    for (const characterId of CHARACTER_IDS) {
      for (const locale of TAP_LINE_LOCALES) {
        for (const seed of [0, 1, 7, 19]) {
          expect(selectTapLine({ characterId, locale, seed })).toEqual(
            selectTapLine({
              characterId,
              locale,
              seed,
              mood: "unknown",
              traits: [],
            }),
          );
        }
      }
    }
  });

  it("lets current mood vary starter greetings without changing their catalog", () => {
    const lively = Array.from({ length: 12 }, (_, seed) =>
      selectTapLine({
        characterId: "chatgpt",
        locale: "zh-TW",
        seed,
        mood: "lively",
        traits: ["cli-focused"],
      }),
    );
    const quiet = Array.from({ length: 12 }, (_, seed) =>
      selectTapLine({
        characterId: "chatgpt",
        locale: "zh-TW",
        seed,
        mood: "quiet",
        traits: ["cli-focused"],
      }),
    );

    expect(lively.some((line) => line.lineId.endsWith("/active"))).toBe(true);
    expect(quiet.some((line) => line.lineId.endsWith("/quiet"))).toBe(true);
    expect(
      [...lively, ...quiet].every((line) =>
        line.lineId.startsWith(
          `fixed-line/${FIXED_LINE_CONTENT_VERSION}/chatgpt/zh-TW/greeting/`,
        ),
      ),
    ).toBe(true);
  });

  it("keeps friend copy independent from profile context", () => {
    const base = selectTapLine({
      characterId: "glm",
      locale: "en",
      seed: 2,
    });
    expect(
      selectTapLine({
        characterId: "glm",
        locale: "en",
        seed: 2,
        mood: "lively",
        traits: ["cli-focused", "multi-tool"],
      }),
    ).toEqual(base);
  });

  it("rejects unsupported identities, locales, seeds, and extra context", () => {
    for (const input of [
      { characterId: "unknown", locale: "en", seed: 0 },
      { characterId: "glm", locale: "zh-CN", seed: 0 },
      { characterId: "glm", locale: "en", seed: -1 },
      { characterId: "glm", locale: "en", seed: 0, prompt: "secret" },
      { characterId: "chatgpt", locale: "en", seed: 0, mood: "excited" },
      {
        characterId: "chatgpt",
        locale: "en",
        seed: 0,
        traits: ["cli-focused", "cli-focused"],
      },
      {
        characterId: "chatgpt",
        locale: "en",
        seed: 0,
        traits: ["cli-focused", "tool-focused", "multi-tool", "cache-savvy"],
      },
    ]) {
      expect(TapLineSelectionInputSchema.safeParse(input).success).toBe(false);
      expect(() => selectTapLine(input)).toThrow();
    }
  });
});
