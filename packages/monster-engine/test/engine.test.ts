import { describe, expect, it } from "vitest";

import {
  MONSTER_THRESHOLDS_V1,
  MonsterDerivationV1Schema,
  MonsterStateV1Schema,
  deriveMonsterState,
  type ContentBlindFootprintV1,
  type MonsterDerivationV1,
} from "../src/index.js";
import {
  aggregate,
  cliShareFootprint,
  counts,
  makeFootprint,
  scaleFootprint,
  shiftFootprintDays,
} from "./fixtures.js";

function traitIds(result: MonsterDerivationV1): string[] {
  return result.state.traits.map((trait) => trait.id);
}

function outputKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(outputKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => [
      key,
      ...outputKeys(child),
    ]);
  }
  return [];
}

function changedTraitSlots(
  before: readonly string[],
  after: readonly string[],
): number {
  return Array.from(
    { length: Math.max(before.length, after.length) },
    (_, index) => index,
  ).filter((index) => before[index] !== after[index]).length;
}

function cacheProfileFootprint(): ContentBlindFootprintV1 {
  return makeFootprint({
    aggregates: () => [
      aggregate({
        cacheReadAvailability: "observed",
        tokens: counts(700, 0, 300),
      }),
    ],
  });
}

function diverseOutputProfileFootprint(): ContentBlindFootprintV1 {
  return makeFootprint({
    aggregates: () => [
      aggregate({
        provider: "openai",
        modelFamily: "openai-codex",
        tool: "browser",
        tokens: counts(100, 900),
      }),
      aggregate({
        provider: "anthropic",
        modelFamily: "claude-sonnet",
        tool: "cursor",
        tokens: counts(100, 900),
      }),
    ],
  });
}

describe("deriveMonsterState", () => {
  it("is byte-deterministic across repeated runs", () => {
    const footprint = makeFootprint({
      hourlyObservedDays: 14,
      hourlyTokens: (hour) => (hour >= 22 || hour < 6 ? 70 : 30),
    });
    const serialized = Array.from({ length: 10 }, () =>
      JSON.stringify(deriveMonsterState(footprint, null)),
    );
    expect(new Set(serialized).size).toBe(1);
  });

  it("emits one to three allowlisted, explained traits when coverage is ready", () => {
    const result = deriveMonsterState(makeFootprint(), null);
    expect(result.state.identityStatus).toBe("ready");
    expect(result.state.traits.length).toBeGreaterThanOrEqual(1);
    expect(result.state.traits.length).toBeLessThanOrEqual(3);
    for (const trait of result.state.traits) {
      expect(
        result.explanations.find(
          (explanation) => explanation.explanationId === trait.explanationId,
        ),
      ).toMatchObject({ subject: "trait", after: trait.id });
    }
    expect(
      result.explanations.every((explanation) =>
        explanation.inputs.every(
          (input) =>
            typeof input.valueBand === "string" &&
            typeof input.coverage === "string",
        ),
      ),
    ).toBe(true);
  });

  it("omits provider traits when provider evidence is wholly or partly unavailable", () => {
    const whollyUnavailable = makeFootprint({
      aggregates: () => [
        aggregate({
          provider: "other",
          modelFamily: "other",
          valueQuality: "estimated",
        }),
      ],
    });
    const partlyUnavailable = makeFootprint({
      aggregates: () => [
        aggregate({ tokens: counts(100) }),
        aggregate({
          provider: "other",
          modelFamily: "other",
          tool: "browser",
          valueQuality: "estimated",
          tokens: counts(900),
        }),
      ],
    });

    const whollyResult = deriveMonsterState(whollyUnavailable, null);
    const partlyResult = deriveMonsterState(partlyUnavailable, null);
    expect(whollyResult.state.identityStatus).toBe("ready");
    expect(traitIds(whollyResult)).toEqual(["cli-focused"]);
    expect(traitIds(partlyResult)).toEqual(["multi-tool"]);
    for (const result of [whollyResult, partlyResult]) {
      expect(
        result.explanations.some(
          (explanation) =>
            explanation.subject === "trait" &&
            explanation.inputs.some((input) =>
              ["top-provider-share", "provider-diversity"].includes(
                input.metric,
              ),
            ),
        ),
      ).toBe(false);
    }
  });

  it("does not turn catch-all tool or token components into a specific identity", () => {
    const onlyUnknown = makeFootprint({
      aggregates: () => [
        aggregate({
          provider: "other",
          modelFamily: "other",
          tool: "other",
          valueQuality: "estimated",
          tokens: counts(0, 0, 0, 0, 0, 1_000),
        }),
      ],
    });
    const tinyClassifiedRemainder = makeFootprint({
      aggregates: () => [
        aggregate({
          provider: "other",
          modelFamily: "other",
          tool: "other",
          valueQuality: "estimated",
          tokens: counts(1, 1, 0, 0, 0, 1_000_000),
        }),
      ],
    });

    for (const footprint of [onlyUnknown, tinyClassifiedRemainder]) {
      const result = deriveMonsterState(footprint, null);
      expect(result.state.identityStatus).toBe("learning");
      expect(result.state.coverageBand).toBe("insufficient");
      expect(traitIds(result)).toEqual([]);
      expect(
        result.explanations.find(
          (explanation) => explanation.subject === "identity",
        ),
      ).toMatchObject({
        reasonCode: "IDENTITY_LEARNING_EVIDENCE_28D",
        templateId: "monster.identity.learningEvidence.v1",
      });
    }
  });

  it("describes multiple supported CLI tools as multi-tool instead of generic CLI focus", () => {
    const result = deriveMonsterState(
      makeFootprint({
        aggregates: () => [
          aggregate({ tokens: counts(500) }),
          aggregate({
            provider: "anthropic",
            modelFamily: "claude-sonnet",
            tool: "claude-code",
            tokens: counts(500),
          }),
        ],
      }),
      null,
    );

    expect(traitIds(result)[0]).toBe("multi-tool");
    expect(traitIds(result)).not.toContain("cli-focused");
  });

  it("removes one unobservable provider slot as an explained identity shift", () => {
    const attested = makeFootprint({
      aggregates: () => [aggregate({ tokens: counts(550, 450) })],
    });
    const unavailable = makeFootprint({
      aggregates: () => [
        aggregate({
          provider: "other",
          modelFamily: "other",
          valueQuality: "estimated",
          tokens: counts(550, 450),
        }),
      ],
    });
    const previous = deriveMonsterState(attested, null);
    expect(traitIds(previous)).toEqual([
      "cli-focused",
      "provider-focused",
      "output-heavy",
    ]);

    const current = deriveMonsterState(
      shiftFootprintDays(unavailable, 1),
      previous.state,
    );
    expect(traitIds(current)).toEqual(["cli-focused", "output-heavy"]);
    expect(current.state.identityContinuity.provisional).toBe(false);
    expect(current.state.evolution).toEqual({
      cadence: "event",
      event: "identity-shift",
      explanationId: "monster-v1:2026-07-16:evolution:0",
    });
    expect(
      current.explanations.some(
        (explanation) => explanation.reasonCode === "TRAIT_PROVIDER_FOCUS_28D",
      ),
    ).toBe(false);
    expect(
      current.explanations.find(
        (explanation) => explanation.subject === "evolution",
      )?.reasonCode,
    ).toBe("EVOLUTION_IDENTITY_SHIFT");
  });

  it("converges partial tool/provider evidence loss one unique-list edit per day", () => {
    const attested = makeFootprint({
      aggregates: () => [aggregate({ tokens: counts(550, 450) })],
    });
    const outputOnly = makeFootprint({
      aggregates: () => [
        aggregate({
          provider: "other",
          modelFamily: "other",
          tool: "other",
          valueQuality: "estimated",
          tokens: counts(550, 450),
        }),
      ],
    });
    const initial = deriveMonsterState(attested, null);
    const first = deriveMonsterState(
      shiftFootprintDays(outputOnly, 1),
      initial.state,
    );
    const second = deriveMonsterState(
      shiftFootprintDays(outputOnly, 2),
      first.state,
    );

    expect(traitIds(initial)).toEqual([
      "cli-focused",
      "provider-focused",
      "output-heavy",
    ]);
    expect(traitIds(first)).toEqual(["provider-focused", "output-heavy"]);
    expect(traitIds(second)).toEqual(["output-heavy"]);
    expect(first.state.identityContinuity).toMatchObject({
      evidenceLossStartedDate: null,
      provisional: true,
    });
    expect(second.state.identityContinuity).toMatchObject({
      evidenceLossStartedDate: null,
      provisional: false,
    });
    expect(first.state.evolution.event).toBe("identity-shift");
    expect(second.state.evolution.event).toBe("identity-shift");
    expect(
      first.explanations.find(
        (explanation) =>
          explanation.reasonCode === "TRAIT_HELD_DAILY_LIMIT" &&
          explanation.after === "provider-focused",
      ),
    ).toMatchObject({ before: "provider-focused" });
  });

  it("uses a learning state below either observed-day or active-day coverage", () => {
    for (const footprint of [
      makeFootprint({ observedDays: 13, activeDays: 7 }),
      makeFootprint({ observedDays: 28, activeDays: 6 }),
    ]) {
      const result = deriveMonsterState(footprint, null);
      expect(result.state.identityStatus).toBe("learning");
      expect(result.state.coverageBand).toBe("insufficient");
      expect(result.state.traits).toEqual([]);
      expect(result.state.mood.id).toBe("learning");
      expect(result.state.evolution).toMatchObject({
        cadence: "event",
        event: "awaiting-coverage",
      });

      const nextDay = deriveMonsterState(
        shiftFootprintDays(footprint, 1),
        result.state,
      );
      expect(nextDay.state.identityStatus).toBe("learning");
      expect(nextDay.state.evolution).toMatchObject({
        cadence: "event",
        event: "awaiting-coverage",
      });
    }
  });

  it("excludes unavailable prior days from the personal activity baseline", () => {
    const footprint = makeFootprint();
    for (let index = 13; index < 27; index += 1) {
      footprint.days[index]!.coverage = "unavailable";
      footprint.days[index]!.aggregates = [];
    }
    footprint.days[27]!.aggregates = [aggregate({ tokens: counts(40) })];

    const result = deriveMonsterState(footprint, null);
    expect(result.state.identityStatus).toBe("ready");
    expect(result.state.mood.id).toBe("quiet");
    expect(
      result.explanations.find((explanation) => explanation.subject === "mood"),
    ).toMatchObject({
      reasonCode: "MOOD_RELATIVE_ACTIVITY_LOW",
      inputs: [{ valueBand: "below-baseline" }],
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
      result.explanations.find((explanation) => explanation.subject === "mood")
        ?.reasonCode,
    ).toBe("MOOD_TODAY_UNAVAILABLE");
  });

  it("compares the latest complete UTC day when the newest day is partial", () => {
    const footprint = makeFootprint({
      aggregates: (dayIndex) => [
        aggregate({
          tokens: counts(dayIndex === 27 ? 1 : 100),
        }),
      ],
    });

    const incorrectlyComplete = deriveMonsterState(footprint, null);
    const currentDayIsPartial = deriveMonsterState(
      { ...footprint, latestDayCompleteness: "partial" },
      null,
    );

    expect(incorrectlyComplete.state.mood.id).toBe("quiet");
    expect(currentDayIsPartial.state.mood.id).toBe("steady");
    expect(
      currentDayIsPartial.explanations.find(
        (explanation) => explanation.subject === "mood",
      ),
    ).toMatchObject({
      reasonCode: "MOOD_RELATIVE_ACTIVITY_STABLE",
      inputs: [{ valueBand: "near-baseline" }],
    });
  });

  it("never lets a partial current day enter the mood reference or baseline", () => {
    const footprint = makeFootprint({
      aggregates: (dayIndex) => [
        aggregate({
          tokens: counts(
            dayIndex === 26 ? 40 : dayIndex === 27 ? 1_000_000 : 100,
          ),
        }),
      ],
    });
    footprint.latestDayCompleteness = "partial";

    const quiet = deriveMonsterState(footprint, null);
    expect(quiet.state.mood.id).toBe("quiet");

    footprint.days[27]!.aggregates = [aggregate({ tokens: counts(1) })];
    expect(deriveMonsterState(footprint, null).state.mood.id).toBe("quiet");

    footprint.days[26]!.coverage = "unavailable";
    footprint.days[26]!.aggregates = [];
    const unknown = deriveMonsterState(footprint, null);
    expect(unknown.state.mood.id).toBe("unknown");
    expect(
      unknown.explanations.find((explanation) => explanation.subject === "mood")
        ?.reasonCode,
    ).toBe("MOOD_TODAY_UNAVAILABLE");
  });

  it("reserves resting for an explicitly observed complete zero-use day", () => {
    const footprint = makeFootprint();
    footprint.latestDayCompleteness = "partial";
    footprint.days[26]!.aggregates = [];

    const result = deriveMonsterState(footprint, null);
    expect(result.state.mood.id).toBe("resting");
    expect(
      result.explanations.find((explanation) => explanation.subject === "mood")
        ?.reasonCode,
    ).toBe("MOOD_RESTING_TODAY");
  });

  it("rejects unknown or mismatched rule config instead of ignoring it", () => {
    const footprint = makeFootprint();
    expect(() =>
      deriveMonsterState(footprint, null, {
        engineVersion: "0.1.5",
        cliFocusedShareBps: 1,
      }),
    ).toThrow();
    expect(() =>
      deriveMonsterState(footprint, null, { engineVersion: "0.2.0" }),
    ).toThrow();
  });

  it("includes the CLI trait exactly at its 70% boundary", () => {
    expect(MONSTER_THRESHOLDS_V1.cliFocusedShareBps).toBe(7_000);
    expect(
      traitIds(deriveMonsterState(cliShareFootprint(700), null)),
    ).toContain("cli-focused");
    expect(
      traitIds(deriveMonsterState(cliShareFootprint(699), null)),
    ).not.toContain("cli-focused");
  });

  it("includes cache-savvy exactly at its share boundary with sufficient coverage", () => {
    const atBoundary = makeFootprint({
      aggregates: () => [
        aggregate({
          cacheReadAvailability: "observed",
          tokens: counts(700, 0, 300),
        }),
      ],
    });
    const belowBoundary = makeFootprint({
      aggregates: () => [
        aggregate({
          cacheReadAvailability: "observed",
          tokens: counts(701, 0, 299),
        }),
      ],
    });
    expect(traitIds(deriveMonsterState(atBoundary, null))).toContain(
      "cache-savvy",
    );
    expect(traitIds(deriveMonsterState(belowBoundary, null))).not.toContain(
      "cache-savvy",
    );
  });

  it("includes output-heavy exactly at its ratio boundary", () => {
    const atBoundary = makeFootprint({
      aggregates: () => [aggregate({ tokens: counts(550, 450) })],
    });
    const belowBoundary = makeFootprint({
      aggregates: () => [aggregate({ tokens: counts(551, 449) })],
    });
    expect(traitIds(deriveMonsterState(atBoundary, null))).toContain(
      "output-heavy",
    );
    expect(traitIds(deriveMonsterState(belowBoundary, null))).not.toContain(
      "output-heavy",
    );
    const mostlyUnknown = makeFootprint({
      aggregates: () => [
        aggregate({
          tokens: counts(1, 1, 0, 0, 0, 1_000_000),
        }),
      ],
    });
    expect(traitIds(deriveMonsterState(mostlyUnknown, null))).not.toContain(
      "output-heavy",
    );
  });

  it("requires sufficient exact IANA/DST-aware hourly coverage for night orientation", () => {
    const hourlyTokens = (hour: number): number =>
      hour >= 22 || hour < 6 ? 100 : 0;
    const sufficient = makeFootprint({
      hourlyObservedDays: 7,
      hourlyTokens,
    });
    expect(traitIds(deriveMonsterState(sufficient, null))).toContain(
      "night-oriented",
    );

    for (const insufficient of [
      makeFootprint({ hourlyObservedDays: 6, hourlyTokens }),
      makeFootprint({
        hourlyObservedDays: 7,
        hourlyTimeQuality: "estimated-local",
        hourlyTokens,
      }),
      makeFootprint({
        hourlyObservedDays: 7,
        hourlyDstQuality: "fixed-offset",
        hourlyTokens,
      }),
    ]) {
      expect(traitIds(deriveMonsterState(insufficient, null))).not.toContain(
        "night-oriented",
      );
    }

    const inventedTimezone = makeFootprint({
      hourlyObservedDays: 7,
      hourlyTokens,
    });
    inventedTimezone.window.timezone = "Mars/Olympus";
    expect(() => deriveMonsterState(inventedTimezone, null)).toThrow();
  });

  it("is invariant when every token count is scaled by ten", () => {
    const footprint = makeFootprint({
      aggregates: () => [
        aggregate({
          cacheReadAvailability: "observed",
          tokens: counts(500, 400, 100),
        }),
      ],
      hourlyObservedDays: 10,
      hourlyTokens: (hour) => (hour >= 22 || hour < 6 ? 20 : 10),
    });
    const original = deriveMonsterState(footprint, null);
    const scaled = deriveMonsterState(scaleFootprint(footprint, 10n), null);
    expect(scaled).toEqual(original);
  });

  it("keeps analytical traits independent from the selected character", () => {
    const claude = deriveMonsterState(
      makeFootprint({ characterId: "claude" }),
      null,
    );
    const gemini = deriveMonsterState(
      makeFootprint({ characterId: "gemini" }),
      null,
    );
    expect(gemini.state.characterId).not.toBe(claude.state.characterId);
    expect(gemini.state.traits).toEqual(claude.state.traits);
    expect(gemini.state.mood).toEqual(claude.state.mood);
    expect(gemini.explanations).toEqual(claude.explanations);
  });

  it("has bounded cosmetic energy and no volume-power vocabulary or fields", () => {
    const result = deriveMonsterState(makeFootprint(), null);
    expect(["dormant", "low", "medium", "high"]).toContain(
      result.state.appearance.energyBand,
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
      "totalTokens",
    ]);
    expect(outputKeys(result).filter((key) => forbidden.has(key))).toEqual([]);
  });

  it("holds a same-window correction without changing identity or faking a weekly review", () => {
    const initial = deriveMonsterState(cacheProfileFootprint(), null);
    const corrected = deriveMonsterState(
      diverseOutputProfileFootprint(),
      initial.state,
    );

    expect(traitIds(corrected)).toEqual(traitIds(initial));
    expect(corrected.state.identityStatus).toBe(initial.state.identityStatus);
    expect(corrected.state.identityContinuity).toEqual({
      schemaVersion: "1",
      lastIdentityReviewDate: initial.state.window.to,
      evidenceLossStartedDate: null,
      provisional: true,
    });
    expect(corrected.state.evolution).toMatchObject({
      cadence: "none",
      event: "no-change",
    });
    expect(
      corrected.explanations.find(
        (explanation) => explanation.subject === "identity",
      )?.reasonCode,
    ).toBe("IDENTITY_HELD_SAME_WINDOW");
    expect(
      corrected.explanations
        .filter((explanation) => explanation.subject === "trait")
        .every(
          (explanation) => explanation.reasonCode === "TRAIT_HELD_SAME_WINDOW",
        ),
    ).toBe(true);
  });

  it("changes at most one trait per successive local day and converges deterministically", () => {
    const initial = deriveMonsterState(cacheProfileFootprint(), null);
    const target = deriveMonsterState(diverseOutputProfileFootprint(), null);
    expect(traitIds(initial)).toEqual([
      "cli-focused",
      "provider-focused",
      "cache-savvy",
    ]);
    expect(traitIds(target)).toEqual([
      "multi-tool",
      "multi-provider",
      "output-heavy",
    ]);
    expect(
      traitIds(initial).every(
        (trait, index) => trait !== traitIds(target)[index],
      ),
    ).toBe(true);

    const states: MonsterDerivationV1[] = [initial];
    for (let day = 1; day <= 3; day += 1) {
      states.push(
        deriveMonsterState(
          shiftFootprintDays(diverseOutputProfileFootprint(), day),
          states.at(-1)!.state,
        ),
      );
    }

    for (let index = 1; index < states.length; index += 1) {
      expect(
        changedTraitSlots(
          traitIds(states[index - 1]!),
          traitIds(states[index]!),
        ),
      ).toBe(1);
      expect(states[index]!.state.evolution.event).toBe("identity-shift");
    }
    expect(states[1]!.state.identityContinuity.provisional).toBe(true);
    expect(states[2]!.state.identityContinuity.provisional).toBe(true);
    expect(states[3]!.state.identityContinuity.provisional).toBe(false);
    expect(traitIds(states[3]!)).toEqual(traitIds(target));
    expect(
      states[1]!.explanations.some(
        (explanation) => explanation.reasonCode === "TRAIT_HELD_DAILY_LIMIT",
      ),
    ).toBe(true);
  });

  it("does not repeat stable evolution events and reviews only after seven real local days", () => {
    const footprint = makeFootprint();
    const initial = deriveMonsterState(footprint, null);
    expect(initial.state.evolution).toMatchObject({
      cadence: "event",
      event: "initial-profile",
    });

    let previous = initial;
    for (let day = 1; day <= 7; day += 1) {
      const current = deriveMonsterState(
        shiftFootprintDays(footprint, day),
        previous.state,
      );
      if (day < 7) {
        expect(current.state.evolution).toMatchObject({
          cadence: "none",
          event: "no-change",
        });
        expect(current.state.identityContinuity.lastIdentityReviewDate).toBe(
          footprint.window.to,
        );
      } else {
        expect(current.state.evolution).toMatchObject({
          cadence: "weekly",
          event: "weekly-review",
        });
        expect(current.state.identityContinuity.lastIdentityReviewDate).toBe(
          current.state.window.to,
        );
      }
      previous = current;
    }

    const sameWindow = deriveMonsterState(
      shiftFootprintDays(footprint, 7),
      previous.state,
    );
    expect(sameWindow.state.evolution).toMatchObject({
      cadence: "none",
      event: "no-change",
    });
  });

  it("holds learning-to-ready corrections until the next local day, then creates a complete profile", () => {
    const learningFootprint = makeFootprint({
      observedDays: 13,
      activeDays: 7,
    });
    const learning = deriveMonsterState(learningFootprint, null);
    const sameWindowReady = deriveMonsterState(makeFootprint(), learning.state);
    expect(sameWindowReady.state.identityStatus).toBe("learning");
    expect(sameWindowReady.state.traits).toEqual([]);
    expect(sameWindowReady.state.identityContinuity.provisional).toBe(true);
    expect(sameWindowReady.state.evolution).toMatchObject({
      cadence: "event",
      event: "awaiting-coverage",
    });

    const nextDayReady = deriveMonsterState(
      shiftFootprintDays(makeFootprint(), 1),
      sameWindowReady.state,
    );
    expect(nextDayReady.state.identityStatus).toBe("ready");
    expect(nextDayReady.state.traits.length).toBeGreaterThanOrEqual(1);
    expect(nextDayReady.state.traits.length).toBeLessThanOrEqual(3);
    expect(nextDayReady.state.identityContinuity.provisional).toBe(false);
    expect(nextDayReady.state.evolution.event).toBe("coverage-complete");
  });

  it("bounds an evidence-loss hold to seven contiguous local dates", () => {
    const ready = deriveMonsterState(makeFootprint(), null);
    const unavailable = makeFootprint({ observedDays: 0, activeDays: 0 });
    const heldStates: MonsterDerivationV1[] = [];
    let previous = ready;

    for (
      let day = 1;
      day <= MONSTER_THRESHOLDS_V1.evidenceLossGraceDays;
      day += 1
    ) {
      const held = deriveMonsterState(
        shiftFootprintDays(unavailable, day),
        previous.state,
      );
      heldStates.push(held);
      previous = held;
      expect(held.state.identityStatus).toBe("ready");
      expect(traitIds(held)).toEqual(traitIds(ready));
      expect(held.state.identityContinuity).toMatchObject({
        provisional: true,
        evidenceLossStartedDate: heldStates[0]!.state.window.to,
        lastIdentityReviewDate: heldStates[0]!.state.window.to,
      });
      expect(held.state.evolution.event).toBe("no-change");
      expect(
        held.explanations.find(
          (explanation) => explanation.subject === "identity",
        )?.reasonCode,
      ).toBe("IDENTITY_HELD_EVIDENCE_GRACE_7D");
      expect(
        held.explanations
          .filter((explanation) => explanation.subject === "trait")
          .every(
            (explanation) =>
              explanation.reasonCode === "TRAIT_HELD_EVIDENCE_GRACE_7D",
          ),
      ).toBe(true);
    }

    const expired = deriveMonsterState(
      shiftFootprintDays(
        unavailable,
        MONSTER_THRESHOLDS_V1.evidenceLossGraceDays + 1,
      ),
      previous.state,
    );
    expect(expired.state.identityStatus).toBe("learning");
    expect(expired.state.traits).toEqual([]);
    expect(expired.state.identityContinuity).toMatchObject({
      provisional: false,
      evidenceLossStartedDate: null,
      lastIdentityReviewDate: expired.state.window.to,
    });
    expect(expired.state.evolution.event).toBe("awaiting-coverage");
  });

  it("fails closed for future, gapped, timezone-incompatible, or malformed previous state", () => {
    const footprint = makeFootprint();
    const initial = deriveMonsterState(footprint, null);

    expect(() =>
      deriveMonsterState(shiftFootprintDays(footprint, 2), initial.state),
    ).toThrow(/immediately preceding/);

    const timezoneMismatch = structuredClone(initial.state);
    timezoneMismatch.window.timezone = "Europe/London";
    expect(() =>
      deriveMonsterState(shiftFootprintDays(footprint, 1), timezoneMismatch),
    ).toThrow(/timezone/);

    const future = structuredClone(initial.state);
    future.window.from = "2026-06-20";
    future.window.to = "2026-07-17";
    future.identityContinuity.lastIdentityReviewDate = "2026-07-17";
    expect(() => deriveMonsterState(footprint, future)).toThrow(
      /immediately preceding/,
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

  it("rejects a mood whose cosmetic energy band describes another state", () => {
    const state = structuredClone(
      deriveMonsterState(makeFootprint(), null).state,
    );
    state.mood.id = "lively";
    state.appearance.energyBand = "dormant";

    expect(MonsterStateV1Schema.safeParse(state).success).toBe(false);
  });

  it("rejects explanation reasons that contradict their semantic result", () => {
    const moodMismatch = structuredClone(
      deriveMonsterState(makeFootprint(), null),
    );
    const moodExplanation = moodMismatch.explanations.find(
      (explanation) => explanation.subject === "mood",
    )!;
    moodExplanation.reasonCode = "MOOD_RESTING_TODAY";
    moodExplanation.templateId = "monster.mood.resting.v1";
    expect(MonsterDerivationV1Schema.safeParse(moodMismatch).success).toBe(
      false,
    );

    const traitMismatch = structuredClone(
      deriveMonsterState(makeFootprint(), null),
    );
    const cliExplanation = traitMismatch.explanations.find(
      (explanation) => explanation.after === "cli-focused",
    )!;
    cliExplanation.reasonCode = "TRAIT_OUTPUT_HEAVY_28D";
    cliExplanation.templateId = "monster.trait.outputHeavy.v1";
    expect(MonsterDerivationV1Schema.safeParse(traitMismatch).success).toBe(
      false,
    );
  });

  it("rejects reason evidence and prior states that contradict their semantics", () => {
    const wrongEvidence = structuredClone(
      deriveMonsterState(makeFootprint(), null),
    );
    const moodExplanation = wrongEvidence.explanations.find(
      (explanation) => explanation.subject === "mood",
    )!;
    moodExplanation.inputs = [
      { metric: "output-share", valueBand: "high", coverage: "full" },
    ];
    expect(MonsterDerivationV1Schema.safeParse(wrongEvidence).success).toBe(
      false,
    );

    const coverageDisagreement = structuredClone(
      deriveMonsterState(makeFootprint(), null),
    );
    const identityExplanation = coverageDisagreement.explanations.find(
      (explanation) => explanation.subject === "identity",
    )!;
    identityExplanation.inputs[1] = {
      ...identityExplanation.inputs[1]!,
      coverage: "good",
    };
    expect(
      MonsterDerivationV1Schema.safeParse(coverageDisagreement).success,
    ).toBe(false);

    const wrongBefore = structuredClone(
      deriveMonsterState(makeFootprint(), null),
    );
    const wrongBeforeMood = wrongBefore.explanations.find(
      (explanation) => explanation.subject === "mood",
    )!;
    wrongBeforeMood.before = "cli-focused";
    expect(MonsterDerivationV1Schema.safeParse(wrongBefore).success).toBe(
      false,
    );

    const ready = deriveMonsterState(makeFootprint(), null);
    const graceMismatch = structuredClone(
      deriveMonsterState(
        shiftFootprintDays(
          makeFootprint({ observedDays: 0, activeDays: 0 }),
          1,
        ),
        ready.state,
      ),
    );
    graceMismatch.state.identityContinuity.evidenceLossStartedDate = null;
    expect(MonsterDerivationV1Schema.safeParse(graceMismatch).success).toBe(
      false,
    );
  });

  it("binds reason-specific prior states and identity metadata", () => {
    const initial = deriveMonsterState(makeFootprint(), null);
    const impossibleInitial = structuredClone(initial);
    impossibleInitial.explanations.find(
      (explanation) => explanation.subject === "evolution",
    )!.before = "weekly-review";
    expect(MonsterDerivationV1Schema.safeParse(impossibleInitial).success).toBe(
      false,
    );

    const evidenceGrace = deriveMonsterState(
      shiftFootprintDays(makeFootprint({ observedDays: 0, activeDays: 0 }), 1),
      initial.state,
    );
    const impossibleGraceIdentity = structuredClone(evidenceGrace);
    impossibleGraceIdentity.explanations.find(
      (explanation) => explanation.subject === "identity",
    )!.before = "learning";
    expect(
      MonsterDerivationV1Schema.safeParse(impossibleGraceIdentity).success,
    ).toBe(false);
    const impossibleGraceTrait = structuredClone(evidenceGrace);
    const graceTrait = impossibleGraceTrait.explanations.find(
      (explanation) => explanation.subject === "trait",
    )!;
    graceTrait.before =
      graceTrait.after === "cli-focused" ? "output-heavy" : "cli-focused";
    expect(
      MonsterDerivationV1Schema.safeParse(impossibleGraceTrait).success,
    ).toBe(false);

    const dailyLimited = deriveMonsterState(
      shiftFootprintDays(diverseOutputProfileFootprint(), 1),
      deriveMonsterState(cacheProfileFootprint(), null).state,
    );
    const impossibleDailyTrait = structuredClone(dailyLimited);
    const heldDailyTrait = impossibleDailyTrait.explanations.find(
      (explanation) => explanation.reasonCode === "TRAIT_HELD_DAILY_LIMIT",
    )!;
    heldDailyTrait.before =
      heldDailyTrait.after === "cli-focused" ? "output-heavy" : "cli-focused";
    expect(
      MonsterDerivationV1Schema.safeParse(impossibleDailyTrait).success,
    ).toBe(false);
    const impossibleDailyIdentity = structuredClone(dailyLimited);
    impossibleDailyIdentity.explanations.find(
      (explanation) => explanation.subject === "identity",
    )!.before = "learning";
    expect(
      MonsterDerivationV1Schema.safeParse(impossibleDailyIdentity).success,
    ).toBe(false);

    const learning = deriveMonsterState(
      makeFootprint({ observedDays: 13, activeDays: 7 }),
      null,
    );
    const sameWindowReady = deriveMonsterState(makeFootprint(), learning.state);
    const coverageComplete = deriveMonsterState(
      shiftFootprintDays(makeFootprint(), 1),
      sameWindowReady.state,
    );
    const impossibleCoverageComplete = structuredClone(coverageComplete);
    impossibleCoverageComplete.explanations.find(
      (explanation) => explanation.subject === "evolution",
    )!.before = "no-change";
    expect(
      MonsterDerivationV1Schema.safeParse(impossibleCoverageComplete).success,
    ).toBe(false);

    let weekly = initial;
    for (let day = 1; day <= 7; day += 1) {
      weekly = deriveMonsterState(
        shiftFootprintDays(makeFootprint(), day),
        weekly.state,
      );
    }
    const impossibleWeekly = structuredClone(weekly);
    impossibleWeekly.explanations.find(
      (explanation) => explanation.subject === "evolution",
    )!.before = "identity-shift";
    expect(MonsterDerivationV1Schema.safeParse(impossibleWeekly).success).toBe(
      false,
    );

    const coverageMismatch = structuredClone(initial);
    coverageMismatch.state.coverageBand = "partial";
    expect(MonsterDerivationV1Schema.safeParse(coverageMismatch).success).toBe(
      false,
    );
    const falseStableIdentity = structuredClone(initial);
    falseStableIdentity.state.identityContinuity.provisional = true;
    expect(
      MonsterDerivationV1Schema.safeParse(falseStableIdentity).success,
    ).toBe(false);
    const falseSettledIdentity = structuredClone(dailyLimited);
    falseSettledIdentity.state.identityContinuity.provisional = false;
    expect(
      MonsterDerivationV1Schema.safeParse(falseSettledIdentity).success,
    ).toBe(false);
  });

  it("rejects evolution, explanation-window, and referenced-after mismatches", () => {
    const evolutionMismatch = structuredClone(
      deriveMonsterState(makeFootprint(), null),
    );
    evolutionMismatch.state.evolution.event = "no-change";
    evolutionMismatch.state.evolution.cadence = "none";
    expect(MonsterDerivationV1Schema.safeParse(evolutionMismatch).success).toBe(
      false,
    );

    const windowMismatch = structuredClone(
      deriveMonsterState(makeFootprint(), null),
    );
    windowMismatch.explanations[0]!.window.from = "2026-06-17";
    windowMismatch.explanations[0]!.window.to = "2026-07-14";
    expect(MonsterDerivationV1Schema.safeParse(windowMismatch).success).toBe(
      false,
    );

    const afterMismatch = structuredClone(
      deriveMonsterState(makeFootprint(), null),
    );
    const moodExplanation = afterMismatch.explanations.find(
      (explanation) => explanation.subject === "mood",
    )!;
    moodExplanation.reasonCode = "MOOD_RELATIVE_ACTIVITY_HIGH";
    moodExplanation.templateId = "monster.mood.lively.v1";
    moodExplanation.after = "lively";
    expect(MonsterDerivationV1Schema.safeParse(afterMismatch).success).toBe(
      false,
    );
  });
});
