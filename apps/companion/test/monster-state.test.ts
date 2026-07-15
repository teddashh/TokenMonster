import { describe, expect, it } from "vitest";

import {
  COMPLETE_SCAN_CLIENTS,
  openLocalStore,
  type LocalStore,
  type ProjectedDailyAggregate,
} from "@tokenmonster/local-store";

import { deriveLocalMonsterSummary } from "../src/main/monster-state.js";

const NOW = new Date("2026-07-15T18:00:00.000Z");
const DAY_MS = 86_400_000;

function aggregate(daysAgo: number): ProjectedDailyAggregate {
  const bucketStart = new Date(
    Date.parse("2026-07-15T00:00:00.000Z") - daysAgo * DAY_MS,
  ).toISOString();
  return {
    bucketStart,
    provider: "openai",
    modelFamily: "gpt-5",
    tool: "codex-cli",
    valueQuality: "exact",
    tokens: {
      input: "100",
      output: "20",
      cacheRead: "30",
      cacheWrite: "0",
      reasoning: "0",
      other: "0",
      total: "150",
    },
    localCoverage: "complete",
    collector: {
      kind: "tokscale",
      adapterVersion: "0.1.0",
      sourceVersion: "4.5.2",
    },
  };
}

function utcDate(daysAgo: number): string {
  return new Date(Date.parse("2026-07-15T00:00:00.000Z") - daysAgo * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function markCompleteDay(store: LocalStore, daysAgo: number): void {
  for (const client of COMPLETE_SCAN_CLIENTS) {
    store.recordCompleteDailyScan({ utcDate: utcDate(daysAgo), client });
  }
}

function seedObservedDays(store: LocalStore, days: number): void {
  store.upsertDailyAggregates(
    Array.from({ length: days }, (_, index) => aggregate(index)),
  );
  for (let index = 0; index < days; index += 1) {
    markCompleteDay(store, index);
  }
}

describe("local content-blind monster summary", () => {
  it("keeps an empty or under-covered footprint in learning state", async () => {
    const empty = await openLocalStore({ path: ":memory:" });
    const emptySummary = deriveLocalMonsterSummary(empty, "chatgpt", NOW);
    expect(emptySummary).toMatchObject({
      characterId: "chatgpt",
      identityStatus: "learning",
      coverage: "insufficient",
      mood: "learning",
      traits: [],
    });
    expect(emptySummary.window).toEqual({
      from: "2026-06-18",
      to: "2026-07-15",
      timezone: "UTC",
    });
    empty.close();

    const underCovered = await openLocalStore({ path: ":memory:" });
    seedObservedDays(underCovered, 13);
    expect(
      deriveLocalMonsterSummary(underCovered, "chatgpt", NOW),
    ).toMatchObject({ identityStatus: "learning", coverage: "insufficient" });
    underCovered.close();
  });

  it("unlocks allowlisted traits at 14 observed and seven active days", async () => {
    const store = await openLocalStore({ path: ":memory:" });
    seedObservedDays(store, 14);

    const result = deriveLocalMonsterSummary(store, "chatgpt", NOW);
    expect(result.identityStatus).toBe("ready");
    expect(result.coverage).toBe("partial");
    expect(result.traits.length).toBeGreaterThanOrEqual(2);
    expect(result.traits.length).toBeLessThanOrEqual(3);
    expect(result.traits.map(({ id }) => id)).toContain("cli-focused");
    expect(store.getMonsterSnapshot("chatgpt")).toMatchObject({
      asOfRevision: 1,
      state: { characterId: "chatgpt", identityStatus: "ready" },
    });

    const repeated = deriveLocalMonsterSummary(store, "chatgpt", NOW);
    expect(repeated).toMatchObject({
      identityStatus: result.identityStatus,
      coverage: result.coverage,
      mood: result.mood,
      energy: result.energy,
      traits: result.traits,
      evolution: "no-change",
    });
    expect(store.getMonsterSnapshot("chatgpt")?.asOfRevision).toBe(2);
    expect(deriveLocalMonsterSummary(store, "chatgpt", NOW)).toEqual(repeated);
    expect(store.getMonsterSnapshot("chatgpt")?.asOfRevision).toBe(2);
    store.close();
  });

  it("keeps token rows unavailable until all four client scopes are complete", async () => {
    const store = await openLocalStore({ path: ":memory:" });
    store.upsertDailyAggregates(
      Array.from({ length: 14 }, (_, index) => aggregate(index)),
    );
    for (let index = 0; index < 14; index += 1) {
      for (const client of COMPLETE_SCAN_CLIENTS.slice(0, 3)) {
        store.recordCompleteDailyScan({ utcDate: utcDate(index), client });
      }
    }

    expect(deriveLocalMonsterSummary(store, "chatgpt", NOW)).toMatchObject({
      identityStatus: "learning",
      coverage: "insufficient",
      mood: "learning",
      traits: [],
    });
    expect(store.listDailyAggregates({ limit: 20 })).toHaveLength(14);
    store.close();
  });

  it("counts complete empty days as observed without persisting zero usage", async () => {
    const store = await openLocalStore({ path: ":memory:" });
    store.upsertDailyAggregates(
      Array.from({ length: 7 }, (_, index) => aggregate(index)),
    );
    for (let index = 0; index < 14; index += 1) {
      markCompleteDay(store, index);
    }

    expect(deriveLocalMonsterSummary(store, "chatgpt", NOW)).toMatchObject({
      identityStatus: "ready",
      coverage: "partial",
    });
    expect(store.listDailyAggregates({ limit: 20 })).toHaveLength(7);
    store.close();
  });

  it("keeps analytical traits independent from the chosen letter character", async () => {
    const store = await openLocalStore({ path: ":memory:" });
    seedObservedDays(store, 14);

    const chatgpt = deriveLocalMonsterSummary(store, "chatgpt", NOW);
    const claude = deriveLocalMonsterSummary(store, "claude", NOW);
    expect(claude.characterId).toBe("claude");
    expect(claude.traits).toEqual(chatgpt.traits);
    expect(JSON.stringify(claude)).not.toMatch(
      /prompt|response|message|conversation|task|project/i,
    );
    store.close();
  });

  it("cannot bypass same-window identity continuity by switching characters", async () => {
    const store = await openLocalStore({ path: ":memory:" });
    expect(deriveLocalMonsterSummary(store, "chatgpt", NOW)).toMatchObject({
      identityStatus: "learning",
      traits: [],
    });
    seedObservedDays(store, 14);

    const chatgpt = deriveLocalMonsterSummary(store, "chatgpt", NOW);
    const claude = deriveLocalMonsterSummary(store, "claude", NOW);
    expect(chatgpt).toMatchObject({ identityStatus: "learning", traits: [] });
    expect(claude).toMatchObject({
      characterId: "claude",
      identityStatus: "learning",
      traits: [],
    });
    expect(store.getMonsterSnapshot("claude")).toBeNull();
    store.close();
  });
});
