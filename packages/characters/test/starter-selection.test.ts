import { describe, expect, it } from "vitest";

import {
  STARTER_BASE_THEME_ID,
  STARTER_CHARACTER_BY_PROVIDER_FAMILY,
  STARTER_PROVIDER_FAMILIES,
  selectStarterCharacter,
  type StarterProviderFamily,
  type StarterProviderTotals28Days,
} from "../src/index.js";

const ZERO_TOTALS = Object.freeze({
  openai: 0,
  anthropic: 0,
  google: 0,
  xai: 0,
}) satisfies StarterProviderTotals28Days;

function totalsWithLeader(
  providerFamily: StarterProviderFamily,
): StarterProviderTotals28Days {
  return Object.freeze({
    ...ZERO_TOTALS,
    [providerFamily]: 100,
  });
}

describe("starter character selection", () => {
  it("maps the four provider families to the four stable characters", () => {
    expect(STARTER_BASE_THEME_ID).toBe("tech");
    expect(STARTER_PROVIDER_FAMILIES).toEqual([
      "openai",
      "anthropic",
      "google",
      "xai",
    ]);
    expect(STARTER_CHARACTER_BY_PROVIDER_FAMILY).toEqual({
      openai: "chatgpt",
      anthropic: "claude",
      google: "gemini",
      xai: "grok",
    });
  });

  it.each(STARTER_PROVIDER_FAMILIES)(
    "selects the unique highest positive %s total",
    (providerFamily) => {
      expect(
        selectStarterCharacter({
          providerTotals28Days: totalsWithLeader(providerFamily),
        }),
      ).toEqual({
        outcome: "selected",
        selectedBy: "unique-provider-total",
        characterId: STARTER_CHARACTER_BY_PROVIDER_FAMILY[providerFamily],
        providerFamily,
      });
    },
  );

  it("requires a user choice when provider data is absent or all zero", () => {
    const expected = {
      outcome: "user-choice-required",
      reason: "no-positive-provider-data",
      tiedProviderFamilies: [],
    };

    expect(selectStarterCharacter({ providerTotals28Days: null })).toEqual(
      expected,
    );
    expect(
      selectStarterCharacter({ providerTotals28Days: ZERO_TOTALS }),
    ).toEqual(expected);
  });

  it("reports every provider tied at the highest positive total", () => {
    expect(
      selectStarterCharacter({
        providerTotals28Days: {
          openai: 90,
          anthropic: 120,
          google: 120,
          xai: 20,
        },
      }),
    ).toEqual({
      outcome: "user-choice-required",
      reason: "highest-provider-total-tie",
      tiedProviderFamilies: ["anthropic", "google"],
    });
  });

  it.each([
    null,
    ZERO_TOTALS,
    totalsWithLeader("xai"),
    {
      openai: 77,
      anthropic: 77,
      google: 0,
      xai: 0,
    },
  ] as const)(
    "always honors an explicit manual choice",
    (providerTotals28Days) => {
      expect(
        selectStarterCharacter({
          manualCharacterId: "claude",
          providerTotals28Days,
        }),
      ).toEqual({
        outcome: "selected",
        selectedBy: "manual",
        characterId: "claude",
      });
    },
  );

  it.each([
    {
      providerTotals28Days: {
        ...ZERO_TOTALS,
        other: 1,
      },
    },
    {
      providerTotals28Days: {
        ...ZERO_TOTALS,
        openai: -1,
      },
    },
    {
      providerTotals28Days: {
        ...ZERO_TOTALS,
        openai: 1.5,
      },
    },
    {
      providerTotals28Days: {
        ...ZERO_TOTALS,
        openai: Number.MAX_SAFE_INTEGER + 1,
      },
    },
    {
      providerTotals28Days: ZERO_TOTALS,
      projectPath: "/must-not-enter-selection",
    },
  ])("rejects malformed or non-allowlisted input", (input) => {
    expect(() => selectStarterCharacter(input)).toThrow();
  });

  it("returns only a starter decision, never progression or capability fields", () => {
    const selections = [
      selectStarterCharacter({
        manualCharacterId: "chatgpt",
        providerTotals28Days: ZERO_TOTALS,
      }),
      selectStarterCharacter({
        providerTotals28Days: totalsWithLeader("google"),
      }),
      selectStarterCharacter({ providerTotals28Days: ZERO_TOTALS }),
    ];
    const forbiddenKeys = new Set([
      "xp",
      "power",
      "level",
      "rank",
      "unlock",
      "unlocks",
      "totalTokens",
    ]);

    for (const selection of selections) {
      expect(
        Object.keys(selection).filter((key) => forbiddenKeys.has(key)),
      ).toEqual([]);
      expect(Object.isFrozen(selection)).toBe(true);
      if (selection.outcome === "user-choice-required") {
        expect(Object.isFrozen(selection.tiedProviderFamilies)).toBe(true);
      }
    }
  });
});
