import { describe, expect, it } from "vitest";

import {
  USAGE_FAMILIES,
  calculateFamilyShares,
  createAnalyticsWindowStateMachine,
  enabledAnalyticsMotionClasses,
  parseUsageFamiliesResponse,
  parseUsageModelsResponse,
  shouldRenderAnalyticsEmpty,
  type UsageFamily,
  type UsageFamilyDay,
  type UsageFamilyTotals
} from "../src/public/app.js";

const TODAY = "2026-07-16";

function familyTotals(
  overrides: Partial<Record<UsageFamily, number>> = {}
): UsageFamilyTotals {
  return Object.freeze({
    openai: 0,
    anthropic: 0,
    google: 0,
    xai: 0,
    deepseek: 0,
    qwen: 0,
    mistral: 0,
    venice: 0,
    sakana: 0,
    perplexity: 0,
    glm: 0,
    other: 0,
    ...overrides
  });
}

function utcDateOffset(utcDate: string, days: number): string {
  const timestamp = Date.parse(`${utcDate}T00:00:00.000Z`);
  return new Date(timestamp + days * 86_400_000).toISOString().slice(0, 10);
}

function familyResponse(window = 7): Record<string, unknown> {
  return {
    window,
    days: Array.from({ length: window }, (_, index) => ({
      utcDate: utcDateOffset(TODAY, index - (window - 1)),
      families: familyTotals(index === window - 1 ? { openai: 120 } : {})
    }))
  };
}

describe("usage family DTO parser", () => {
  it("accepts and freezes a complete contiguous family window", () => {
    const parsed = parseUsageFamiliesResponse(familyResponse(), TODAY, 7);

    expect(parsed.window).toBe(7);
    expect(parsed.days).toHaveLength(7);
    expect(parsed.days.at(-1)?.families.openai).toBe(120);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.days)).toBe(true);
    expect(Object.isFrozen(parsed.days[0]?.families)).toBe(true);
  });

  it("rejects unknown response keys", () => {
    expect(() =>
      parseUsageFamiliesResponse(
        { ...familyResponse(), privatePath: "/private/project" },
        TODAY
      )
    ).toThrow("Invalid usage families response");
  });

  it("rejects a wrong day count", () => {
    const response = familyResponse();
    response["days"] = (response["days"] as unknown[]).slice(1);

    expect(() => parseUsageFamiliesResponse(response, TODAY)).toThrow(
      "Invalid usage families response"
    );
  });

  it("rejects a family object missing any required family", () => {
    const response = familyResponse();
    const days = response["days"] as Array<Record<string, unknown>>;
    const original = days[0]?.["families"] as UsageFamilyTotals;
    const { other: _other, ...missingOther } = original;
    days[0]!["families"] = missingOther;

    expect(() => parseUsageFamiliesResponse(response, TODAY)).toThrow(
      "Invalid usage families response"
    );
  });
});

describe("usage model DTO parser", () => {
  const response = {
    window: 28,
    models: [
      {
        model: "gpt-5",
        family: "openai",
        totalTokens: 1_200,
        inputTokens: 900,
        outputTokens: 300
      },
      {
        model: "claude-sonnet",
        family: "anthropic",
        totalTokens: 800
      }
    ]
  } as const;

  it("accepts sorted models with optional input/output splits", () => {
    const parsed = parseUsageModelsResponse(response, 28, 10);

    expect(parsed).toEqual(response);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.models)).toBe(true);
    expect(Object.isFrozen(parsed.models[0])).toBe(true);
  });

  it("rejects unknown model keys", () => {
    expect(() =>
      parseUsageModelsResponse({
        window: 28,
        models: [{ ...response.models[0], filename: "secret.ts" }]
      })
    ).toThrow("Invalid usage models response");
  });

  it("rejects model names containing control characters", () => {
    for (const model of ["gpt\u00005", "gpt\n5", "gpt\u007f5"]) {
      expect(() =>
        parseUsageModelsResponse({
          window: 28,
          models: [{ model, family: "openai", totalTokens: 1 }]
        })
      ).toThrow("Invalid usage models response");
    }
  });

  it("accepts 120 characters and rejects a model name over the cap", () => {
    expect(
      parseUsageModelsResponse({
        window: 7,
        models: [
          { model: "m".repeat(120), family: "mistral", totalTokens: 1 }
        ]
      }).models[0]?.model
    ).toHaveLength(120);
    expect(() =>
      parseUsageModelsResponse({
        window: 7,
        models: [
          { model: "m".repeat(121), family: "mistral", totalTokens: 1 }
        ]
      })
    ).toThrow("Invalid usage models response");
  });
});

describe("analytics view decisions", () => {
  it("uses largest remainders so displayed family shares sum to 100", () => {
    const days: readonly UsageFamilyDay[] = [
      { utcDate: TODAY, families: familyTotals({ openai: 1, anthropic: 1, google: 1 }) }
    ];
    const shares = calculateFamilyShares(days);

    expect(shares.map(({ family, percentage }) => ({ family, percentage }))).toEqual([
      { family: "openai", percentage: 34 },
      { family: "anthropic", percentage: 33 },
      { family: "google", percentage: 33 }
    ]);
    expect(shares.reduce((total, share) => total + share.percentage, 0)).toBe(100);
  });

  it("shows the empty window only when every family value is zero", () => {
    const emptyDays = [{ utcDate: TODAY, families: familyTotals() }];
    const usedDays = [
      { utcDate: TODAY, families: familyTotals({ perplexity: 1 }) }
    ];

    expect(shouldRenderAnalyticsEmpty(emptyDays)).toBe(true);
    expect(shouldRenderAnalyticsEmpty(usedDays)).toBe(false);
  });

  it("gates analytics transition classes for reduced motion", () => {
    expect(enabledAnalyticsMotionClasses(false)).toEqual([
      "analytics-bars-motion"
    ]);
    expect(enabledAnalyticsMotionClasses(true)).toEqual([]);
  });
});

describe("analytics window switch state machine", () => {
  it("defaults to 28 days and ignores stale or repeated selections", () => {
    const state = createAnalyticsWindowStateMachine();
    const original = state.refresh();
    const switched = state.select(7)!;

    expect(original.window).toBe(28);
    expect(state.selectedWindow()).toBe(7);
    expect(state.isCurrent(original)).toBe(false);
    expect(state.isCurrent(switched)).toBe(true);
    expect(state.select(7)).toBeUndefined();
    const refreshed = state.refresh();
    expect(refreshed.window).toBe(7);
    expect(state.isCurrent(switched)).toBe(false);
    expect(state.isCurrent(refreshed)).toBe(true);
  });
});

it("keeps the family catalog stable at twelve exact keys", () => {
  expect(USAGE_FAMILIES).toHaveLength(12);
});
