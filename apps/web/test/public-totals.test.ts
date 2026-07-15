import { describe, expect, it } from "vitest";

import {
  PUBLIC_COUNTER_DISCLAIMER,
  PUBLIC_COUNTER_LABEL,
  fetchPublicTotals,
  formatTokenDecimal,
  formatVerifiedAt,
  parsePublicTotals,
  publicTotalsAreFresh,
} from "../src/public-totals.js";

const VALID_TOTALS = {
  contractVersion: 1,
  label: PUBLIC_COUNTER_LABEL,
  disclaimer: PUBLIC_COUNTER_DISCLAIMER,
  allTimeTokens: "9223372036854775807",
  todayUtcTokens: "0",
  contributors: "21",
  generatedAt: "2026-07-15T18:23:00Z",
  dataRevision: "2026-07-15T18:23:00Z/184",
} as const;

describe("public totals contract", () => {
  it("accepts the exact verified response without converting counters to Number", () => {
    expect(parsePublicTotals(VALID_TOTALS)).toEqual(VALID_TOTALS);
    expect(formatTokenDecimal(VALID_TOTALS.allTimeTokens)).toBe(
      "9,223,372,036,854,775,807",
    );
  });

  it.each([
    { ...VALID_TOTALS, allTimeTokens: "9223372036854775808" },
    { ...VALID_TOTALS, contributors: "021" },
    { ...VALID_TOTALS, disclaimer: "所有 AI 的全球 Token 使用量" },
    { ...VALID_TOTALS, generatedAt: "2026-07-15T18:23:00+00:00" },
    { ...VALID_TOTALS, prompt: "must not enter the public contract" },
    { ...VALID_TOTALS, allTimeTokens: "9", todayUtcTokens: "10", contributors: "1" },
    { ...VALID_TOTALS, allTimeTokens: "9", todayUtcTokens: "1", contributors: "10" },
  ])("fails closed for changed, overflowing, or expanded payloads", (value) => {
    expect(parsePublicTotals(value)).toBeNull();
  });

  it("formats the server timestamp as explicit UTC", () => {
    expect(formatVerifiedAt("2026-07-15T18:23:00Z")).toBe(
      "2026-07-15 18:23:00 UTC",
    );
    expect(formatVerifiedAt("not-a-date")).toBe("時間未知");
  });

  it("rejects a projection after the shared ten-minute freshness window", () => {
    expect(
      publicTotalsAreFresh(
        VALID_TOTALS,
        Date.parse("2026-07-15T18:33:00Z"),
      ),
    ).toBe(true);
    expect(
      publicTotalsAreFresh(
        VALID_TOTALS,
        Date.parse("2026-07-15T18:33:00.001Z"),
      ),
    ).toBe(false);
  });

  it("does not accept a service error as a total", async () => {
    const unavailableFetcher = async () =>
      new Response(
        JSON.stringify({
          code: "PUBLIC_TOTALS_UNAVAILABLE",
          status: 503,
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/problem+json" },
        },
      );

    await expect(
      fetchPublicTotals(unavailableFetcher as typeof fetch),
    ).rejects.toThrow("unavailable");
  });
});
