import { describe, expect, it } from "vitest";

import {
  parseQuotaSnapshot,
  quotaRowView
} from "../src/public/app.js";

function response() {
  return {
    status: "ok",
    generatedAt: "2026-07-17T12:00:00.000Z",
    families: [
      {
        family: "anthropic",
        planId: null,
        windowHours: 24,
        windowKind: "utc-day",
        usedTokens: 10,
        budgetTokens: null,
        estimate: true
      },
      {
        family: "openai",
        planId: "chatgpt-plus",
        windowHours: 24,
        windowKind: "utc-day",
        usedTokens: 729_600,
        budgetTokens: 1_920_000,
        estimate: true
      },
      {
        family: "google",
        planId: "gemini-free",
        windowHours: 24,
        windowKind: "utc-day",
        usedTokens: 100_001,
        budgetTokens: 100_000,
        estimate: true
      },
      {
        family: "xai",
        planId: null,
        windowHours: 24,
        windowKind: "utc-day",
        usedTokens: 0,
        budgetTokens: null,
        estimate: true
      }
    ]
  };
}

describe("quota DTO parser", () => {
  it("accepts and freezes the exact complete response", () => {
    const parsed = parseQuotaSnapshot(response());
    expect(parsed.families).toHaveLength(4);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.families)).toBe(true);
    expect(Object.isFrozen(parsed.families[0])).toBe(true);
  });

  it("rejects unknown keys, unknown plans, and missing catalog families", () => {
    expect(() => parseQuotaSnapshot({ ...response(), rawQuota: 10 })).toThrow(
      "Invalid quota response"
    );
    const unknownFamilyKey = response();
    Object.assign(unknownFamilyKey.families[0]!, { filename: "secret.ts" });
    expect(() => parseQuotaSnapshot(unknownFamilyKey)).toThrow(
      "Invalid quota response"
    );
    const unknownPlan = response();
    unknownPlan.families[1]!.planId = "private-plan";
    expect(() => parseQuotaSnapshot(unknownPlan)).toThrow("Invalid quota response");
    const missing = response();
    missing.families.pop();
    expect(() => parseQuotaSnapshot(missing)).toThrow("Invalid quota response");
  });
});

describe("quota UI row rendering state", () => {
  it("renders unset, set, and over-budget states without negative values", () => {
    const parsed = parseQuotaSnapshot(response());
    expect(quotaRowView(parsed.families[0]!)).toEqual({
      configured: false,
      exceeded: false,
      remainingPercent: 0,
      statusText: null
    });
    expect(quotaRowView(parsed.families[1]!)).toMatchObject({
      configured: true,
      exceeded: false,
      remainingPercent: 62,
      statusText: "約剩 62%・視窗 24 小時"
    });
    expect(quotaRowView(parsed.families[2]!)).toEqual({
      configured: true,
      exceeded: true,
      remainingPercent: 0,
      statusText: "已超過估算額度"
    });
  });
});
