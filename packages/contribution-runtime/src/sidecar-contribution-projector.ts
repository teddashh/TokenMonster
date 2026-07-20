import { PERMANENT_SIDECAR_COLLECTOR_IDENTITY_V2 } from "@tokenmonster/contracts";
import type {
  DailyUpsertResult,
  ProjectedDailyAggregate,
} from "@tokenmonster/local-store";
import { DailyContentBlindFootprintV1Schema } from "@tokenmonster/monster-engine";
import type { TokenTrackerAdapter } from "@tokenmonster/token-tracker-adapter";

const DAY_MS = 86_400_000;
const CLOSED_WINDOW_DAYS = 28;

export const SIDECAR_CONTRIBUTION_COLLECTOR =
  PERMANENT_SIDECAR_COLLECTOR_IDENTITY_V2;

export interface SidecarContributionStorePort {
  upsertDailyAggregates(
    input: readonly ProjectedDailyAggregate[],
  ): readonly DailyUpsertResult[];
}

export interface SidecarContributionProjectionResult {
  readonly fromUtcDate: string;
  readonly toUtcDate: string;
  readonly projectedDays: number;
  readonly storedRows: number;
}

function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function closedContributionRange(now: Date): Readonly<{
  fromUtcDate: string;
  toUtcDate: string;
}> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Invalid sidecar contribution clock");
  }
  const currentUtcDay = Date.parse(`${utcDate(now.getTime())}T00:00:00.000Z`);
  return Object.freeze({
    fromUtcDate: utcDate(currentUtcDay - CLOSED_WINDOW_DAYS * DAY_MS),
    toUtcDate: utcDate(currentUtcDay - DAY_MS),
  });
}

function checkedDecimalAdd(left: string, right: string): string {
  const result = BigInt(left) + BigInt(right);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("Sidecar contribution token total is too large");
  }
  return result.toString(10);
}

const TOKEN_FIELDS = Object.freeze([
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "other",
  "total",
] as const);

type TokenField = (typeof TOKEN_FIELDS)[number];

function emptyTokens(): Record<TokenField, string> {
  return {
    input: "0",
    output: "0",
    cacheRead: "0",
    cacheWrite: "0",
    reasoning: "0",
    other: "0",
    total: "0",
  };
}

/**
 * Refreshes only closed UTC dates through the strict adapter, then collapses
 * every reviewed content-blind dimension into one coarse absolute row. No raw
 * source/model label crosses this boundary and no second collector is added.
 */
export async function refreshSidecarContributionProjection(
  adapter: TokenTrackerAdapter,
  store: SidecarContributionStorePort,
  now: Date = new Date(),
): Promise<SidecarContributionProjectionResult> {
  const range = closedContributionRange(now);
  const parsedFootprint = DailyContentBlindFootprintV1Schema.safeParse(
    await adapter.getDailyContentBlindFootprint({
      ...range,
      characterId: "chatgpt",
    }),
  );
  if (!parsedFootprint.success) {
    throw new TypeError("Sidecar contribution footprint was invalid");
  }
  const footprint = parsedFootprint.data;
  if (
    footprint.characterId !== "chatgpt" ||
    footprint.window.from !== range.fromUtcDate ||
    footprint.window.to !== range.toUtcDate ||
    footprint.window.timezone !== "UTC"
  ) {
    throw new TypeError("Sidecar contribution window drifted");
  }

  const rows: readonly ProjectedDailyAggregate[] = footprint.days.flatMap(
    (day) => {
      if (day.coverage !== "observed") return [];
      if (day.aggregates.length === 0) {
        throw new TypeError(
          "Sidecar contribution observed day had no aggregates",
        );
      }
      const tokens = emptyTokens();
      let valueQuality: "exact" | "estimated" = "exact";
      for (const aggregate of day.aggregates) {
        if (aggregate.valueQuality === "estimated") valueQuality = "estimated";
        for (const field of TOKEN_FIELDS) {
          tokens[field] = checkedDecimalAdd(
            tokens[field],
            aggregate.tokens[field],
          );
        }
      }
      return [
        Object.freeze({
          bucketStart: `${day.localDate}T00:00:00.000Z`,
          provider: "other" as const,
          modelFamily: "all" as const,
          tool: "all" as const,
          valueQuality,
          tokens: Object.freeze(tokens),
          localCoverage: "complete" as const,
          collector: SIDECAR_CONTRIBUTION_COLLECTOR,
        }),
      ];
    },
  );
  const decisions = store.upsertDailyAggregates(rows);
  if (decisions.length !== rows.length) {
    throw new TypeError("Sidecar contribution store rejected projected rows");
  }
  return Object.freeze({
    ...range,
    projectedDays: footprint.days.length,
    storedRows: rows.length,
  });
}
