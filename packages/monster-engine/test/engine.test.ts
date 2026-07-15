import { describe, expect, it } from "vitest";

import {
  MONSTER_THRESHOLDS_V1,
  deriveMonsterState,
  type ContentBlindFootprintV1,
  type MonsterDerivationV1
} from "../src/index.js";
import {
  aggregate,
  cliShareFootprint,
  counts,
  makeFootprint,
  scaleFootprint,
  shiftFootprintDays
} from "./fixtures.js";

function traitIds(result: MonsterDerivationV1): string[] {
  return result.state.traits.map((trait) => trait.id);
}

function outputKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(outputKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => [key, ...outputKeys(child)]);
  }
  return [];
}

function changedTraitSlots(
  before: readonly string[],
  after: readonly string[]
): number {
  return Array.from(
    { length: Math.max(before.length, after.length) },
    (_, index) => index
  ).filter((index) => before[index] !== after[index]).length;
}

function cacheProfileFootprint(): ContentBlindFootprintV1 {
  return makeFootprint({
    aggregates: () => [
      aggregate({
        cacheReadAvailability: "observed",
        tokens: counts(700, 0, 300)
      })
    ]
  });
}

function diverseOutputProfileFootprint(): ContentBlindFootprintV1 {
  return makeFootprint({
    aggregates: () => [
      aggregate({
        provider: "openai",
        modelFamily: "openai-codex",
        tool: "browser",
        tokens: counts(100, 900)
      }),
      aggregate({
        provider: "anthropic",
        modelFamily: "claude-sonnet",
        tool: "cursor",
        tokens: counts(100, 900)
      })
    ]
  });
}

describe("deriveMonsterState", () => {
  it("is byte-deterministic across repeated runs", () => {
    const footprint = makeFootprint({
      hourlyObservedDays: 14,
      hourlyTokens: (hour) => (hour >= 22 || hour < 6 ? 70 : 30)
    });
    const serialized = Array.from({ length: 10 }, () =>
      JSON.stringify(deriveMonsterState(footprint, null))
    );
    expect(new Set(serialized).size).toBe(1);
  });

  it("emits two or three allowlisted, explained traits when coverage is ready", () => {
    const result = deriveMonsterState(makeFootprint(), null);
    expect(result.state.identityStatus).toBe("ready");
    expect(result.state.traits.length).toBeGreaterThanOrEqual(2);
    expect(result.state.traits.length).toBeLessThanOrEqual(3);
    for (const trait of result.state.traits) {
      expect(
        result.explanations.find(
          (explanation) => explanation.explanationId === trait.explanationId
        )
      ).toMatchObject({ subject: "trait", after: trait.id });
    }
    expect(
      result.explanations.every((explanation) =>
        explanation.inputs.every(
          (input) =>
            typeof input.valueBand === "string" &&
            typeof input.coverage === "string"
        )
      )
    ).toBe(true);
  });

  it("uses a learning state below either observed-day or active-day coverage", () => {
    for (const footprint of [
      makeFootprint({ observedDays: 13, activeDays: 7 }),
      makeFootprint({ observedDays: 28, activeDays: 6 })
    ]) {
      const result = deriveMonsterState(footprint, null);
      expect(result.state.identityStatus).toBe("learning");
      expect(result.state.coverageBand).toBe("insufficient");
      expect(result.state.traits).toEqual([]);
      expect(result.state.mood.id).toBe("learning");
    }
  });

  it("excludes unavailable prior days from the personal activity baseline", () => {
    const footprint = makeFootprint();
    for (let index = 13; index < 27; index += 1) {
      footprint.days[index]!.coverage = "unavailable";
      footprint.days[index]!.aggregates = [];
    }
    footprint.days[27]!.aggregates = [
      aggregate({ tokens: counts(40) })
    ];

    const result = deriveMonsterState(footprint, null);
    expect(result.state.identityStatus).toBe("ready");
    expect(result.state.mood.id).toBe("quiet");
    expect(
      result.explanations.find(
        (explanation) => explanation.subject === "mood"
      )
    ).toMatchObject({
      reasonCode: "MOOD_RELATIVE_ACTIVITY_LOW",
      inputs: [{ valueBand: "below-baseline" }]
    });
  });

  it("marks today's mood unknown when the latest day is unavailable", () => {
    const footprint = makeFootprint();
    footprint.days[27]!.coverage = "unavailable";
    footprint.days[27]!.aggregates = [];

    const result = deriveMonsterState(footprint, null);
    expect(result.state.identityStatus).toBe("ready");
    expect(result.state.mood.id).toBe("unknown");
    expect(
      result.explanations.find(
        (explanation) => explanation.subject === "mood"
      )?.reasonCode
    ).toBe("MOOD_TODAY_UNAVAILABLE");
  });

  it("rejects unknown or mismatched rule config instead of ignoring it", () => {
    const footprint = makeFootprint();
    expect(() =>
      deriveMonsterState(footprint, null, {
        engineVersion: "0.1.0",
        cliFocusedShareBps: 1
      })
    ).toThrow();
    expect(() =>
      deriveMonsterState(footprint, null, { engineVersion: "0.2.0" })
    ).toThrow();
  });

  it("includes the CLI trait exactly at its 70% boundary", () => {
    expect(MONSTER_THRESHOLDS_V1.cliFocusedShareBps).toBe(7_000);
    expect(traitIds(deriveMonsterState(cliShareFootprint(700), null))).toContain(
      "cli-focused"
    );
    expect(
      traitIds(deriveMonsterState(cliShareFootprint(699), null))
    ).not.toContain("cli-focused");
  });

  it("includes cache-savvy exactly at its share boundary with sufficient coverage", () => {
    const atBoundary = makeFootprint({
      aggregates: () => [
        aggregate({
          cacheReadAvailability: "observed",
          tokens: counts(700, 0, 300)
        })
      ]
    });
    const belowBoundary = makeFootprint({
      aggregates: () => [
        aggregate({
          cacheReadAvailability: "observed",
          tokens: counts(701, 0, 299)
        })
      ]
    });
    expect(traitIds(deriveMonsterState(atBoundary, null))).toContain(
      "cache-savvy"
    );
    expect(traitIds(deriveMonsterState(belowBoundary, null))).not.toContain(
      "cache-savvy"
    );
  });

  it("includes output-heavy exactly at its ratio boundary", () => {
    const atBoundary = makeFootprint({
      aggregates: () => [aggregate({ tokens: counts(550, 450) })]
    });
    const belowBoundary = makeFootprint({
      aggregates: () => [aggregate({ tokens: counts(551, 449) })]
    });
    expect(traitIds(deriveMonsterState(atBoundary, null))).toContain(
      "output-heavy"
    );
    expect(traitIds(deriveMonsterState(belowBoundary, null))).not.toContain(
      "output-heavy"
    );
  });

  it("requires sufficient exact IANA/DST-aware hourly coverage for night orientation", () => {
    const hourlyTokens = (hour: number): number =>
      hour >= 22 || hour < 6 ? 100 : 0;
    const sufficient = makeFootprint({
      hourlyObservedDays: 7,
      hourlyTokens
    });
    expect(traitIds(deriveMonsterState(sufficient, null))).toContain(
      "night-oriented"
    );

    for (const insufficient of [
      makeFootprint({ hourlyObservedDays: 6, hourlyTokens }),
      makeFootprint({
        hourlyObservedDays: 7,
        hourlyTimeQuality: "estimated-local",
        hourlyTokens
      }),
      makeFootprint({
        hourlyObservedDays: 7,
        hourlyDstQuality: "fixed-offset",
        hourlyTokens
      })
    ]) {
      expect(traitIds(deriveMonsterState(insufficient, null))).not.toContain(
        "night-oriented"
      );
    }


    const inventedTimezone = makeFootprint({
      hourlyObservedDays: 7,
      hourlyTokens
    });
    inventedTimezone.window.timezone = "Mars/Olympus";
    expect(() => deriveMonsterState(inventedTimezone, null)).toThrow();
  });

  it("is invariant when every token count is scaled by ten", () => {
    const footprint = makeFootprint({
      aggregates: () => [
        aggregate({
          cacheReadAvailability: "observed",
          tokens: counts(500, 400, 100)
        })
      ],
      hourlyObservedDays: 10,
      hourlyTokens: (hour) => (hour >= 22 || hour < 6 ? 20 : 10)
    });
    const original = deriveMonsterState(footprint, null);
    const scaled = deriveMonsterState(scaleFootprint(footprint, 10n), null);
    expect(scaled).toEqual(original);
  });

  it("keeps analytical traits independent from the selected character", () => {
    const claude = deriveMonsterState(
      makeFootprint({ characterId: "claude" }),
      null
    );
    const gemini = deriveMonsterState(
      makeFootprint({ characterId: "gemini" }),
      null
    );
    expect(gemini.state.characterId).not.toBe(claude.state.characterId);
    expect(gemini.state.traits).toEqual(claude.state.traits);
    expect(gemini.state.mood).toEqual(claude.state.mood);
    expect(gemini.explanations).toEqual(claude.explanations);
  });

  it("has bounded cosmetic energy and no volume-power vocabulary or fields", () => {
    const result = deriveMonsterState(makeFootprint(), null);
    expect(["dormant", "low", "medium", "high"]).toContain(
      result.state.appearance.energyBand
    );
    const forbidden = new Set([
      "power",
      "strength",
      "rarity",
      "level",
      "rank",
      "unlock",
      "unlocks",
      "xp",
      "score",
      "totalTokens"
    ]);
    expect(outputKeys(result).filter((key) => forbidden.has(key))).toEqual([]);
  });

  it("holds a same-window correction without changing identity or faking a weekly review", () => {
    const initial = deriveMonsterState(cacheProfileFootprint(), null);
    const corrected = deriveMonsterState(
      diverseOutputProfileFootprint(),
      initial.state
    );

    expect(traitIds(corrected)).toEqual(traitIds(initial));
    expect(corrected.state.identityStatus).toBe(initial.state.identityStatus);
    expect(corrected.state.identityContinuity).toEqual({
      schemaVersion: "1",
      lastIdentityReviewDate: initial.state.window.to,
      provisional: true
    });
    expect(corrected.state.evolution).toMatchObject({
      cadence: "none",
      event: "no-change"
    });
    expect(
      corrected.explanations.find(
        (explanation) => explanation.subject === "identity"
      )?.reasonCode
    ).toBe("IDENTITY_HELD_SAME_WINDOW");
    expect(
      corrected.explanations
        .filter((explanation) => explanation.subject === "trait")
        .every(
          (explanation) =>
            explanation.reasonCode === "TRAIT_HELD_SAME_WINDOW"
        )
    ).toBe(true);
  });

  it("changes at most one trait per successive local day and converges deterministically", () => {
    const initial = deriveMonsterState(cacheProfileFootprint(), null);
    const target = deriveMonsterState(diverseOutputProfileFootprint(), null);
    expect(traitIds(initial)).toEqual([
      "cli-focused",
      "provider-focused",
      "cache-savvy"
    ]);
    expect(traitIds(target)).toEqual([
      "multi-tool",
      "multi-provider",
      "output-heavy"
    ]);
    expect(
      traitIds(initial).every(
        (trait, index) => trait !== traitIds(target)[index]
      )
    ).toBe(true);

    const states: MonsterDerivationV1[] = [initial];
    for (let day = 1; day <= 3; day += 1) {
      states.push(
        deriveMonsterState(
          shiftFootprintDays(diverseOutputProfileFootprint(), day),
          states.at(-1)!.state
        )
      );
    }

    for (let index = 1; index < states.length; index += 1) {
      expect(
        changedTraitSlots(
          traitIds(states[index - 1]!),
          traitIds(states[index]!)
        )
      ).toBe(1);
      expect(states[index]!.state.evolution.event).toBe("identity-shift");
    }
    expect(states[1]!.state.identityContinuity.provisional).toBe(true);
    expect(states[2]!.state.identityContinuity.provisional).toBe(true);
    expect(states[3]!.state.identityContinuity.provisional).toBe(false);
    expect(traitIds(states[3]!)).toEqual(traitIds(target));
    expect(
      states[1]!.explanations.some(
        (explanation) =>
          explanation.reasonCode === "TRAIT_HELD_DAILY_LIMIT"
      )
    ).toBe(true);
  });

  it("does not repeat stable evolution events and reviews only after seven real local days", () => {
    const footprint = makeFootprint();
    const initial = deriveMonsterState(footprint, null);
    expect(initial.state.evolution).toMatchObject({
      cadence: "event",
      event: "initial-profile"
    });

    let previous = initial;
    for (let day = 1; day <= 7; day += 1) {
      const current = deriveMonsterState(
        shiftFootprintDays(footprint, day),
        previous.state
      );
      if (day < 7) {
        expect(current.state.evolution).toMatchObject({
          cadence: "none",
          event: "no-change"
        });
        expect(current.state.identityContinuity.lastIdentityReviewDate).toBe(
          footprint.window.to
        );
      } else {
        expect(current.state.evolution).toMatchObject({
          cadence: "weekly",
          event: "weekly-review"
        });
        expect(current.state.identityContinuity.lastIdentityReviewDate).toBe(
          current.state.window.to
        );
      }
      previous = current;
    }

    const sameWindow = deriveMonsterState(
      shiftFootprintDays(footprint, 7),
      previous.state
    );
    expect(sameWindow.state.evolution).toMatchObject({
      cadence: "none",
      event: "no-change"
    });
  });

  it("holds learning-to-ready corrections until the next local day, then creates a complete profile", () => {
    const learningFootprint = makeFootprint({
      observedDays: 13,
      activeDays: 7
    });
    const learning = deriveMonsterState(learningFootprint, null);
    const sameWindowReady = deriveMonsterState(makeFootprint(), learning.state);
    expect(sameWindowReady.state.identityStatus).toBe("learning");
    expect(sameWindowReady.state.traits).toEqual([]);
    expect(sameWindowReady.state.identityContinuity.provisional).toBe(true);
    expect(sameWindowReady.state.evolution.event).toBe("no-change");

    const nextDayReady = deriveMonsterState(
      shiftFootprintDays(makeFootprint(), 1),
      sameWindowReady.state
    );
    expect(nextDayReady.state.identityStatus).toBe("ready");
    expect(nextDayReady.state.traits.length).toBeGreaterThanOrEqual(2);
    expect(nextDayReady.state.traits.length).toBeLessThanOrEqual(3);
    expect(nextDayReady.state.identityContinuity.provisional).toBe(false);
    expect(nextDayReady.state.evolution.event).toBe("coverage-complete");
  });

  it("holds a ready identity provisionally when rolling coverage becomes insufficient", () => {
    const ready = deriveMonsterState(makeFootprint(), null);
    const insufficient = shiftFootprintDays(
      makeFootprint({ observedDays: 13, activeDays: 7 }),
      1
    );
    const held = deriveMonsterState(insufficient, ready.state);

    expect(held.state.identityStatus).toBe("ready");
    expect(traitIds(held)).toEqual(traitIds(ready));
    expect(held.state.identityContinuity.provisional).toBe(true);
    expect(held.state.evolution.event).toBe("no-change");
    expect(
      held.explanations
        .filter((explanation) => explanation.subject === "trait")
        .every(
          (explanation) =>
            explanation.reasonCode === "TRAIT_HELD_DAILY_LIMIT"
        )
    ).toBe(true);
  });

  it("fails closed for future, gapped, timezone-incompatible, or malformed previous state", () => {
    const footprint = makeFootprint();
    const initial = deriveMonsterState(footprint, null);

    expect(() =>
      deriveMonsterState(shiftFootprintDays(footprint, 2), initial.state)
    ).toThrow(/immediately preceding/);

    const timezoneMismatch = structuredClone(initial.state);
    timezoneMismatch.window.timezone = "Europe/London";
    expect(() =>
      deriveMonsterState(shiftFootprintDays(footprint, 1), timezoneMismatch)
    ).toThrow(/timezone/);

    const future = structuredClone(initial.state);
    future.window.from = "2026-06-20";
    future.window.to = "2026-07-17";
    future.identityContinuity.lastIdentityReviewDate = "2026-07-17";
    expect(() => deriveMonsterState(footprint, future)).toThrow(
      /immediately preceding/
    );

    const malformed = structuredClone(initial.state) as unknown as {
      identityContinuity: { schemaVersion: string };
    };
    malformed.identityContinuity.schemaVersion = "2";
    expect(() => deriveMonsterState(footprint, malformed)).toThrow();

    const staleReview = structuredClone(initial.state);
    staleReview.identityContinuity.lastIdentityReviewDate = "2026-07-08";
    expect(() => deriveMonsterState(footprint, staleReview)).toThrow();
  });
});
