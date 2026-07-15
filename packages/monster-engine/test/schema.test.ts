import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ContentBlindFootprintV1Schema,
  DailyContentBlindFootprintV1Schema,
  DailyDimensionAggregateV1Schema,
  LocalHourlyRhythmV1Schema,
  MonsterTokenCountsV1Schema
} from "../src/index.js";
import { aggregate, counts, makeFootprint } from "./fixtures.js";

describe("content-blind footprint contract", () => {
  it("accepts the four Tier-1 projected collector dimension fixtures", () => {
    const fixtures = JSON.parse(
      readFileSync(
        new URL("fixtures/collector-dimensions-v1.json", import.meta.url),
        "utf8"
      )
    ) as unknown[];

    for (const fixture of fixtures) {
      expect(
        DailyDimensionAggregateV1Schema.safeParse({
          ...(fixture as Record<string, unknown>),
          valueQuality: "exact",
          cacheReadAvailability: "observed"
        }).success
      ).toBe(true);
    }
  });

  it("accepts all coarse model dimensions currently emitted by the tokscale adapter", () => {
    const collectorDimensions = [
      ["anthropic", "claude-haiku", "claude-code"],
      ["anthropic", "claude-sonnet", "claude-code"],
      ["anthropic", "claude-opus", "claude-code"],
      ["anthropic", "anthropic-other", "claude-code"],
      ["google", "gemini-flash", "gemini-cli"],
      ["google", "gemini-pro", "gemini-cli"],
      ["google", "google-other", "gemini-cli"],
      ["openai", "openai-codex", "codex-cli"],
      ["openai", "gpt-5", "codex-cli"],
      ["openai", "gpt-4o", "codex-cli"],
      ["openai", "gpt-4", "codex-cli"],
      ["openai", "o1", "codex-cli"],
      ["openai", "o3", "codex-cli"],
      ["openai", "o4", "codex-cli"],
      ["openai", "openai-other", "codex-cli"],
      ["xai", "grok", "grok-build"],
      ["xai", "xai-other", "grok-build"],
      ["openrouter", "openrouter-other", "other"],
      ["other", "other", "other"]
    ] as const;

    for (const [provider, modelFamily, tool] of collectorDimensions) {
      expect(
        DailyDimensionAggregateV1Schema.safeParse({
          ...aggregate(),
          provider,
          modelFamily,
          tool
        }).success,
        `${provider}/${modelFamily}/${tool}`
      ).toBe(true);
    }
  });

  it("rejects raw model names and provider/family mismatches", () => {
    expect(
      DailyDimensionAggregateV1Schema.safeParse({
        ...aggregate(),
        modelFamily: "gpt-5.9-private-preview-2026-07-15"
      }).success
    ).toBe(false);
    expect(
      DailyDimensionAggregateV1Schema.safeParse({
        ...aggregate(),
        provider: "anthropic",
        modelFamily: "openai-codex"
      }).success
    ).toBe(false);
  });

  it("rejects content, path, session, and task fields at every boundary", () => {
    const root = structuredClone(makeFootprint()) as unknown as Record<
      string,
      unknown
    >;
    root["prompt"] = "private";
    expect(ContentBlindFootprintV1Schema.safeParse(root).success).toBe(false);

    const day = structuredClone(makeFootprint()) as unknown as {
      days: Array<Record<string, unknown>>;
    };
    day.days[0]!["path"] = "/private/project";
    expect(ContentBlindFootprintV1Schema.safeParse(day).success).toBe(false);

    const item = structuredClone(makeFootprint()) as unknown as {
      days: Array<{ aggregates: Array<Record<string, unknown>> }>;
    };
    item.days[0]!.aggregates[0]!["sessionId"] = "private-session";
    expect(ContentBlindFootprintV1Schema.safeParse(item).success).toBe(false);

    const hourly = makeFootprint({ hourlyObservedDays: 7 }) as unknown as {
      localHourlyRhythm: Record<string, unknown>;
    };
    hourly.localHourlyRhythm["task"] = "debugging";
    expect(ContentBlindFootprintV1Schema.safeParse(hourly).success).toBe(false);
  });

  it.each(["-1", "01", "+1", "1.5", "1e3", "9007199254740992"])(
    "rejects invalid decimal token string %s",
    (value) => {
      expect(
        MonsterTokenCountsV1Schema.safeParse({
          ...counts(0),
          input: value
        }).success
      ).toBe(false);
    }
  );

  it("rejects an inconsistent total and reasoning greater than output", () => {
    expect(
      MonsterTokenCountsV1Schema.safeParse({
        ...counts(10, 5),
        total: "16"
      }).success
    ).toBe(false);
    expect(
      MonsterTokenCountsV1Schema.safeParse(counts(10, 5, 0, 0, 6)).success
    ).toBe(false);
  });

  it("distinguishes unavailable cache coverage from an observed zero", () => {
    expect(
      DailyDimensionAggregateV1Schema.safeParse({
        ...aggregate(),
        cacheReadAvailability: "unavailable",
        tokens: counts(10, 0, 1)
      }).success
    ).toBe(false);
    expect(
      DailyDimensionAggregateV1Schema.safeParse({
        ...aggregate(),
        cacheReadAvailability: "observed",
        tokens: counts(10, 0, 1)
      }).success
    ).toBe(true);
  });

  it("keeps local hourly rhythm out of the strict daily-only type", () => {
    const local = makeFootprint({
      hourlyObservedDays: 7,
      hourlyTokens: (hour) => (hour === 23 ? 100 : 0)
    });
    expect(ContentBlindFootprintV1Schema.safeParse(local).success).toBe(true);
    expect(DailyContentBlindFootprintV1Schema.safeParse(local).success).toBe(
      false
    );

    const { localHourlyRhythm: _localOnly, ...dailyOnly } = local;
    expect(DailyContentBlindFootprintV1Schema.safeParse(dailyOnly).success).toBe(
      true
    );
  });

  it("requires explicit wall-clock and DST quality on hourly rhythm", () => {
    const rhythm = makeFootprint({ hourlyObservedDays: 7 }).localHourlyRhythm!;
    const { timeQuality: _timeQuality, ...missingQuality } = rhythm;
    expect(LocalHourlyRhythmV1Schema.safeParse(missingQuality).success).toBe(
      false
    );
  });

  it("accepts UTC and runtime-supported IANA zones but rejects invented zones", () => {
    for (const timezone of ["UTC", "America/New_York", "Europe/London"]) {
      const footprint = makeFootprint();
      footprint.window.timezone = timezone;
      expect(
        ContentBlindFootprintV1Schema.safeParse(footprint).success,
        timezone
      ).toBe(true);
    }

    const invented = makeFootprint({
      hourlyObservedDays: 7,
      hourlyTokens: (hour) => (hour >= 22 || hour < 6 ? 100 : 0)
    });
    invented.window.timezone = "Mars/Olympus";
    expect(ContentBlindFootprintV1Schema.safeParse(invented).success).toBe(
      false
    );
  });

  it("requires exactly 28 canonical contiguous days", () => {
    const missing = makeFootprint();
    missing.days.pop();
    expect(ContentBlindFootprintV1Schema.safeParse(missing).success).toBe(false);

    const unordered = makeFootprint();
    unordered.days[1]!.localDate = unordered.days[0]!.localDate;
    expect(ContentBlindFootprintV1Schema.safeParse(unordered).success).toBe(
      false
    );
  });

  it("accepts only the four release character IDs", () => {
    const footprint = makeFootprint();
    expect(
      ContentBlindFootprintV1Schema.safeParse({
        ...footprint,
        characterId: "placeholder"
      }).success
    ).toBe(false);
  });
});
