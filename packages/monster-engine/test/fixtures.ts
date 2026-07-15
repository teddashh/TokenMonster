import type {
  ContentBlindFootprintV1,
  DailyDimensionAggregateV1,
  MonsterTokenCountsV1
} from "../src/index.js";

const START = Date.parse("2026-06-18T00:00:00.000Z");

export function counts(
  input: number,
  output = 0,
  cacheRead = 0,
  cacheWrite = 0,
  reasoning = 0,
  other = 0
): MonsterTokenCountsV1 {
  return {
    input: String(input),
    output: String(output),
    cacheRead: String(cacheRead),
    cacheWrite: String(cacheWrite),
    reasoning: String(reasoning),
    other: String(other),
    total: String(input + output + cacheRead + cacheWrite + other)
  };
}

export function aggregate(
  overrides: Partial<DailyDimensionAggregateV1> = {}
): DailyDimensionAggregateV1 {
  return {
    provider: "openai",
    modelFamily: "openai-codex",
    tool: "codex-cli",
    valueQuality: "exact",
    cacheReadAvailability: "unavailable",
    tokens: counts(100, 10),
    ...overrides
  };
}

interface FootprintOptions {
  readonly observedDays?: number;
  readonly activeDays?: number;
  readonly characterId?: ContentBlindFootprintV1["characterId"];
  readonly aggregates?: (
    dayIndex: number
  ) => readonly DailyDimensionAggregateV1[];
  readonly hourlyObservedDays?: number;
  readonly hourlyTimeQuality?:
    | "exact-iana-local"
    | "estimated-local"
    | "utc-only";
  readonly hourlyDstQuality?: "timezone-aware" | "fixed-offset" | "unknown";
  readonly hourlyTokens?: (hour: number) => number;
}

export function makeFootprint(
  options: FootprintOptions = {}
): ContentBlindFootprintV1 {
  const observedDays = options.observedDays ?? 28;
  const activeDays = Math.min(options.activeDays ?? observedDays, observedDays);
  const footprint: ContentBlindFootprintV1 = {
    schemaVersion: "1",
    characterId: options.characterId ?? "chatgpt",
    window: {
      from: "2026-06-18",
      to: "2026-07-15",
      timezone: "America/New_York"
    },
    days: Array.from({ length: 28 }, (_, index) => {
      const isObserved = index < observedDays;
      const isActive = isObserved && index < activeDays;
      return {
        localDate: new Date(START + index * 86_400_000)
          .toISOString()
          .slice(0, 10),
        coverage: isObserved ? "observed" : "unavailable",
        aggregates: isActive
          ? [...(options.aggregates?.(index) ?? [aggregate()])]
          : []
      };
    })
  };

  if (options.hourlyObservedDays !== undefined) {
    footprint.localHourlyRhythm = {
      schemaVersion: "1",
      coverage: "complete-local-days",
      timeQuality: options.hourlyTimeQuality ?? "exact-iana-local",
      dstQuality: options.hourlyDstQuality ?? "timezone-aware",
      observedDays: options.hourlyObservedDays,
      hours: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        tokens: String(options.hourlyTokens?.(hour) ?? 0)
      }))
    };
  }

  return footprint;
}

export function cliShareFootprint(cliTokens: number): ContentBlindFootprintV1 {
  return makeFootprint({
    aggregates: () => [
      aggregate({
        provider: "openai",
        modelFamily: "openai-codex",
        tool: "codex-cli",
        tokens: counts(cliTokens)
      }),
      aggregate({
        provider: "anthropic",
        modelFamily: "claude-sonnet",
        tool: "browser",
        tokens: counts(1_000 - cliTokens)
      })
    ]
  });
}

export function scaleFootprint(
  footprint: ContentBlindFootprintV1,
  multiplier: bigint
): ContentBlindFootprintV1 {
  const copy = structuredClone(footprint);
  const fields = [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "reasoning",
    "other",
    "total"
  ] as const;
  for (const day of copy.days) {
    for (const item of day.aggregates) {
      for (const field of fields) {
        item.tokens[field] = (BigInt(item.tokens[field]) * multiplier).toString();
      }
    }
  }
  for (const hour of copy.localHourlyRhythm?.hours ?? []) {
    hour.tokens = (BigInt(hour.tokens) * multiplier).toString();
  }
  return copy;
}

export function shiftFootprintDays(
  footprint: ContentBlindFootprintV1,
  days: number
): ContentBlindFootprintV1 {
  const copy = structuredClone(footprint);
  const shiftDate = (value: string): string =>
    new Date(
      Date.parse(`${value}T00:00:00.000Z`) + days * 86_400_000
    )
      .toISOString()
      .slice(0, 10);

  copy.window.from = shiftDate(copy.window.from);
  copy.window.to = shiftDate(copy.window.to);
  for (const day of copy.days) {
    day.localDate = shiftDate(day.localDate);
  }
  return copy;
}
