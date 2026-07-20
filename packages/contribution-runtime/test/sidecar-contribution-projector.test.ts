import { describe, expect, it, vi } from "vitest";
import type {
  DailyUpsertResult,
  ProjectedDailyAggregate,
} from "@tokenmonster/local-store";

import {
  SIDECAR_CONTRIBUTION_COLLECTOR,
  closedContributionRange,
  refreshSidecarContributionProjection,
  type SidecarContributionStorePort,
} from "../src/sidecar-contribution-projector.js";

function adapterWithFootprint(footprint: unknown) {
  return {
    getDailyContentBlindFootprint: vi.fn(async () => footprint),
  } as never;
}

function utcDates(from: string): readonly string[] {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  return Array.from({ length: 28 }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
}

function footprint(
  days: readonly unknown[],
  overrides: Readonly<{
    characterId?: string;
    from?: string;
    to?: string;
  }> = {},
): unknown {
  return {
    schemaVersion: "1",
    characterId: overrides.characterId ?? "chatgpt",
    window: {
      from: overrides.from ?? "2026-06-20",
      to: overrides.to ?? "2026-07-17",
      timezone: "UTC",
    },
    days,
  };
}

function unavailableDays(from = "2026-06-20"): readonly unknown[] {
  return utcDates(from).map((localDate) => ({
    localDate,
    coverage: "unavailable",
    aggregates: [],
  }));
}

function acceptedRows(
  input: readonly ProjectedDailyAggregate[],
): readonly DailyUpsertResult[] {
  return input.map((row) => ({
    status: "inserted",
    row: {
      ...row,
      revision: 1,
      updatedAt: "2026-07-18T12:00:00.000Z",
    },
  }));
}

describe("permanent sidecar contribution projection", () => {
  it("uses exactly 28 closed UTC dates", () => {
    expect(closedContributionRange(new Date("2026-07-18T23:59:59.999Z"))).toEqual({
      fromUtcDate: "2026-06-20",
      toUtcDate: "2026-07-17",
    });
  });

  it("collapses reviewed dimensions without source/model identity", async () => {
    const rows: ProjectedDailyAggregate[] = [];
    const store: SidecarContributionStorePort = {
      upsertDailyAggregates(input) {
        rows.push(...input);
        return acceptedRows(input);
      },
    };
    const days = [...unavailableDays()];
    days[0] =
        {
          localDate: "2026-06-20",
          coverage: "observed",
          aggregates: [
            {
              provider: "openai",
              modelFamily: "gpt-5",
              tool: "codex-cli",
              valueQuality: "exact",
              cacheReadAvailability: "observed",
              tokens: {
                input: "2",
                output: "3",
                cacheRead: "4",
                cacheWrite: "5",
                reasoning: "1",
                other: "6",
                total: "20",
              },
            },
            {
              provider: "other",
              modelFamily: "other",
              tool: "other",
              valueQuality: "estimated",
              cacheReadAvailability: "unavailable",
              tokens: {
                input: "0",
                output: "0",
                cacheRead: "0",
                cacheWrite: "0",
                reasoning: "0",
                other: "7",
                total: "7",
              },
            },
          ],
        };
    const adapter = adapterWithFootprint(footprint(days));

    await expect(
      refreshSidecarContributionProjection(
        adapter,
        store,
        new Date("2026-07-18T12:00:00.000Z"),
      ),
    ).resolves.toEqual({
      fromUtcDate: "2026-06-20",
      toUtcDate: "2026-07-17",
      projectedDays: 28,
      storedRows: 1,
    });
    expect(rows).toEqual([
      {
        bucketStart: "2026-06-20T00:00:00.000Z",
        provider: "other",
        modelFamily: "all",
        tool: "all",
        valueQuality: "estimated",
        tokens: {
          input: "2",
          output: "3",
          cacheRead: "4",
          cacheWrite: "5",
          reasoning: "1",
          other: "13",
          total: "27",
        },
        localCoverage: "complete",
        collector: SIDECAR_CONTRIBUTION_COLLECTOR,
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/codex|gpt-5|openai/u);
  });

  it("fails closed on adapter window drift or store rejection", async () => {
    const store: SidecarContributionStorePort = {
      upsertDailyAggregates: () => [],
    };
    const adapter = adapterWithFootprint(
      footprint(unavailableDays("2026-06-19"), {
        from: "2026-06-19",
        to: "2026-07-16",
      }),
    );
    await expect(
      refreshSidecarContributionProjection(
        adapter,
        store,
        new Date("2026-07-18T12:00:00.000Z"),
      ),
    ).rejects.toThrow("window drifted");

    await expect(
      refreshSidecarContributionProjection(
        adapterWithFootprint(footprint(unavailableDays())),
        store,
        new Date("2026-07-18T12:00:00.000Z"),
      ),
    ).resolves.toEqual({
      fromUtcDate: "2026-06-20",
      toUtcDate: "2026-07-17",
      projectedDays: 28,
      storedRows: 0,
    });
  });

  it("rejects non-canonical days and impossible observed empties", async () => {
    const store: SidecarContributionStorePort = {
      upsertDailyAggregates: acceptedRows,
    };
    const nonCanonical = [...unavailableDays()];
    nonCanonical[1] = {
      localDate: "2026-06-22",
      coverage: "unavailable",
      aggregates: [],
    };
    await expect(
      refreshSidecarContributionProjection(
        adapterWithFootprint(footprint(nonCanonical)),
        store,
        new Date("2026-07-18T12:00:00.000Z"),
      ),
    ).rejects.toThrow("footprint was invalid");

    const observedEmpty = [...unavailableDays()];
    observedEmpty[0] = {
      localDate: "2026-06-20",
      coverage: "observed",
      aggregates: [],
    };
    await expect(
      refreshSidecarContributionProjection(
        adapterWithFootprint(footprint(observedEmpty)),
        store,
        new Date("2026-07-18T12:00:00.000Z"),
      ),
    ).rejects.toThrow("observed day had no aggregates");
  });
});
