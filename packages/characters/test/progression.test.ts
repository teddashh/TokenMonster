import { describe, expect, it } from "vitest";

import {
  PROGRESSION_ACTION_IDS,
  PROGRESSION_CHARACTER_IDS,
  GLM_WARDROBE_LIFETIME_THRESHOLDS,
  PROGRESSION_MANIFEST,
  PROGRESSION_POSE_SET_IDS,
  PROGRESSION_PROVIDER_IDS,
  ProgressionInputSchema,
  ProgressionManifestSchema,
  ProgressionStateSchema,
  WARDROBE_THEME_IDS,
  createEmptyLocalProgressionStore,
  evaluateProgression,
  withProgressionEvaluation,
  type DailyProviderBucket,
  type PersistedSelection,
  type ProgressionCharacterId,
  type ProgressionInput,
  type ProgressionProviderId,
  type ProgressionState,
} from "../src/index.js";

const EVALUATED_AT = "2026-07-16T12:00:00.000Z";

function bucket(
  utcDate: string,
  providerTotals: Partial<Record<ProgressionProviderId, number>>,
): DailyProviderBucket {
  return { utcDate, providerTotals };
}

function input(
  dailyProviderBuckets: readonly DailyProviderBucket[],
  overrides: Partial<ProgressionInput> = {},
): ProgressionInput {
  return {
    schemaVersion: "2",
    evaluatedAt: EVALUATED_AT,
    dailyProviderBuckets,
    traitIds: [],
    persistedUnlockedAt: {},
    selection: {
      manualCharacterId: null,
      manualSelectedAt: null,
      autoStarterCharacterId: null,
      autoStarterSelectedAt: null,
    },
    ...overrides,
  };
}

function character(
  state: ProgressionState,
  characterId: ProgressionCharacterId,
) {
  return state.characters.find((candidate) => candidate.characterId === characterId)!;
}

function manualSelection(characterId: "chatgpt" | "claude"): PersistedSelection {
  return {
    manualCharacterId: characterId,
    manualSelectedAt: "2026-07-15T08:00:00.000Z",
    autoStarterCharacterId: null,
    autoStarterSelectedAt: null,
  };
}

describe("progression manifest", () => {
  it("is versioned, local-only, non-purchasable, and schema-valid", () => {
    expect(ProgressionManifestSchema.parse(PROGRESSION_MANIFEST)).toBeDefined();
    expect(PROGRESSION_MANIFEST).toMatchObject({
      schemaVersion: "2",
      localOnly: true,
      monotonicUnlocks: true,
      purchasable: false,
    });
    expect(PROGRESSION_MANIFEST.characters.map(({ id }) => id)).toEqual(
      PROGRESSION_CHARACTER_IDS,
    );
    expect(PROGRESSION_MANIFEST.wardrobe.themes.map(({ themeId }) => themeId)).toEqual(
      WARDROBE_THEME_IDS,
    );
    expect(PROGRESSION_MANIFEST.poses.availableAtCharacterUnlock).toEqual([
      "supported",
      "challenged",
    ]);
    expect(PROGRESSION_MANIFEST.actions.map(({ actionId }) => actionId)).toEqual(
      PROGRESSION_ACTION_IDS,
    );
  });

  it("spreads distinct friend milestones across all allowed local signals", () => {
    const friends = PROGRESSION_MANIFEST.characters.filter(
      ({ kind }) => kind !== "sister",
    );
    expect(new Set(friends.map(({ unlockRule }) => unlockRule.signal))).toEqual(
      new Set([
        "provider-cumulative-total",
        "distinct-active-provider-breadth",
        "active-day-streak",
        "lifetime-total",
      ]),
    );
    expect(new Set(friends.map(({ unlockRule }) => JSON.stringify(unlockRule))).size).toBe(
      friends.length,
    );
    expect(characterRule("glm")).toEqual({
      signal: "lifetime-total",
      threshold: 5_000_000,
    });
    expect(characterRule("reserved")).toEqual({
      signal: "distinct-active-provider-breadth",
      threshold: 8,
    });
    expect(
      PROGRESSION_MANIFEST.characters.find(({ id }) => id === "venice")?.displayName,
    ).toBe("Llama");
  });

  it("keeps every non-GLM wardrobe on its exact provider and gives only GLM the v2 lifetime ladder", () => {
    for (const definition of PROGRESSION_MANIFEST.characters) {
      if (definition.id === "glm") {
        expect(definition.wardrobeRule).toEqual({
          signal: "lifetime-total",
          thresholds: GLM_WARDROBE_LIFETIME_THRESHOLDS,
        });
      } else {
        expect(definition.wardrobeRule).toEqual({
          signal: "provider-cumulative-total",
          providerId: definition.providerId,
        });
      }
    }
    expect(GLM_WARDROBE_LIFETIME_THRESHOLDS).toEqual([
      5_000_000,
      5_250_000,
      5_500_000,
      5_750_000,
      6_000_000,
      6_500_000,
      7_000_000,
      7_500_000,
      8_000_000,
      9_000_000,
      10_000_000,
      11_000_000,
      12_000_000,
      13_500_000,
      15_000_000,
      17_000_000,
      19_000_000,
      22_000_000,
      25_000_000,
      30_000_000,
    ]);
  });

  it("rejects non-allowlisted content-bearing inputs", () => {
    const valid = input([]);
    expect(ProgressionInputSchema.parse(valid)).toBeDefined();
    expect(() =>
      evaluateProgression({
        ...valid,
        projectPath: "/must-not-enter-progression",
      }),
    ).toThrow();
    expect(() =>
      evaluateProgression({
        ...valid,
        dailyProviderBuckets: [
          {
            utcDate: "2026-07-16",
            providerTotals: { openai: 1, prompt: "secret" },
          },
        ],
      }),
    ).toThrow();
  });
});

function characterRule(characterId: ProgressionCharacterId) {
  return PROGRESSION_MANIFEST.characters.find(({ id }) => id === characterId)!
    .unlockRule;
}

describe("evaluateProgression", () => {
  it("returns a fully locked, explainable state for zero data", () => {
    const state = evaluateProgression(input([]));
    expect(ProgressionStateSchema.parse(state)).toBeDefined();
    expect(state.selection).toBeNull();
    expect(state.counters).toEqual({
      providerTotals: Object.fromEntries(
        PROGRESSION_PROVIDER_IDS.map((providerId) => [providerId, 0]),
      ),
      lifetimeTotal: 0,
      distinctActiveProviders: 0,
      activeDays: 0,
      activeDayStreak: 0,
    });
    expect(state.characters.every(({ unlocked }) => !unlocked)).toBe(true);
    expect(state.nextUnlock?.progress.value).toBe(0);
    expect(state.nextUnlock?.progress.explanation.length).toBeGreaterThan(0);
  });

  it("does not auto-select a starter when highest positive sister totals tie", () => {
    const state = evaluateProgression(
      input([
        bucket("2026-07-16", {
          openai: 500,
          anthropic: 500,
        }),
      ]),
    );
    expect(state.selection).toBeNull();
    expect(character(state, "chatgpt").unlocked).toBe(true);
    expect(character(state, "claude").unlocked).toBe(true);
  });

  it("unlocks from historical use without choosing a starter for the player", () => {
    const state = evaluateProgression(
      input([bucket("2026-07-16", { google: 25, openai: 10 })]),
    );
    expect(state.selection).toBeNull();
    expect(character(state, "gemini")).toMatchObject({
      unlocked: true,
      unlockedAt: EVALUATED_AT,
    });
  });

  it("marks unlocks from one evaluation with a shared batch id", () => {
    const state = evaluateProgression(
      input([bucket("2026-07-16", { openai: 5_000_000 })]),
    );
    const unlockTimestamps = state.characters.flatMap((entry) => [
      entry.unlockedAt,
      ...entry.themes.map((theme) => theme.unlockedAt),
      ...entry.poseSets.map((pose) => pose.unlockedAt),
      ...entry.actions.map((action) => action.unlockedAt),
    ]);

    expect(state.unlockBatchId).toBe(EVALUATED_AT);
    expect(new Set(unlockTimestamps.filter((value) => value !== null))).toEqual(
      new Set([EVALUATED_AT]),
    );
  });

  it("honors a manual starter at zero usage and uses its earlier timestamp", () => {
    const state = evaluateProgression(
      input([], { selection: manualSelection("claude") }),
    );
    expect(state.selection).toEqual({
      characterId: "claude",
      selectedBy: "manual",
      selectedAt: "2026-07-15T08:00:00.000Z",
    });
    expect(character(state, "claude")).toMatchObject({
      unlocked: true,
      unlockedAt: "2026-07-15T08:00:00.000Z",
    });
    expect(character(state, "claude").themes[0]).toMatchObject({
      themeId: "tech",
      unlocked: true,
      unlockedAt: "2026-07-15T08:00:00.000Z",
      progress: {
        value: 1,
        explanation:
          "Claude 是你選擇的起始角色，立即開放 tech 基本服裝。",
      },
    });
    expect(character(state, "claude").themes[1]).toMatchObject({
      themeId: "finance",
      unlocked: false,
    });
    expect(character(state, "chatgpt").themes[0]).toMatchObject({
      themeId: "tech",
      unlocked: false,
    });
  });

  it("keeps a former starter's base theme unlocked after selection changes", () => {
    const firstState = evaluateProgression(
      input([], { selection: manualSelection("claude") }),
    );
    const persisted = withProgressionEvaluation(
      createEmptyLocalProgressionStore(),
      firstState,
    );
    const nextState = evaluateProgression(
      input([], {
        persistedUnlockedAt: persisted.unlockedAt,
        selection: {
          manualCharacterId: "chatgpt",
          manualSelectedAt: "2026-07-16T10:00:00.000Z",
          autoStarterCharacterId: null,
          autoStarterSelectedAt: null,
        },
      }),
    );

    expect(character(nextState, "claude").themes[0]).toMatchObject({
      themeId: "tech",
      unlocked: true,
      unlockedAt: "2026-07-15T08:00:00.000Z",
    });
    expect(character(nextState, "chatgpt").themes[0]).toMatchObject({
      themeId: "tech",
      unlocked: true,
      unlockedAt: "2026-07-16T10:00:00.000Z",
    });
  });

  it("supports single-provider heavy use without inventing provider breadth", () => {
    const state = evaluateProgression(
      input([bucket("2026-07-16", { openai: 5_000_000 })]),
    );
    expect(state.counters.distinctActiveProviders).toBe(1);
    expect(state.counters.lifetimeTotal).toBe(5_000_000);
    expect(character(state, "chatgpt").unlocked).toBe(true);
    expect(character(state, "venice").unlocked).toBe(true);
    expect(character(state, "glm").unlocked).toBe(true);
    expect(character(state, "sakana").unlocked).toBe(false);
  });

  it("unlocks Sakana through provider breadth with exact progress copy", () => {
    const three = evaluateProgression(
      input([
        bucket("2026-07-16", {
          openai: 1,
          anthropic: 1,
          google: 1,
        }),
      ]),
    );
    expect(character(three, "sakana").progress).toEqual({
      value: 0.75,
      explanation: "已使用 3 個不同的 provider，再使用 1 個即可解鎖 Sakana。",
    });
    expect(character(three, "sakana").unlocked).toBe(false);

    const four = evaluateProgression(
      input([
        bucket("2026-07-16", {
          openai: 1,
          anthropic: 1,
          google: 1,
          xai: 1,
        }),
      ]),
    );
    expect(character(four, "sakana").unlocked).toBe(true);
  });

  it("breaks the current active-day streak on an observed quiet day", () => {
    const state = evaluateProgression(
      input([
        bucket("2026-07-13", { openai: 1 }),
        bucket("2026-07-14", { openai: 1 }),
        bucket("2026-07-15", {}),
      ]),
    );
    expect(state.counters.activeDays).toBe(2);
    expect(state.counters.activeDayStreak).toBe(0);
    expect(character(state, "mistral").unlocked).toBe(false);
  });

  it("optionally anchors the active-day streak to the evaluation UTC date", () => {
    const days = [
      bucket("2026-07-13", { openai: 1 }),
      bucket("2026-07-14", { openai: 1 }),
      bucket("2026-07-15", { openai: 1 }),
    ];

    expect(
      evaluateProgression(
        input(days, { evaluationUtcDate: "2026-08-20" }),
      ).counters.activeDayStreak,
    ).toBe(0);
    expect(
      evaluateProgression(
        input(days, { evaluationUtcDate: "2026-07-16" }),
      ).counters.activeDayStreak,
    ).toBe(3);
    expect(
      evaluateProgression(
        input(days, { evaluationUtcDate: "2026-07-15" }),
      ).counters.activeDayStreak,
    ).toBe(3);
    expect(evaluateProgression(input(days)).counters.activeDayStreak).toBe(3);
  });

  it("fast-tracks a recommended wardrobe theme by exactly one tier", () => {
    const state = evaluateProgression(
      input([bucket("2026-07-16", { openai: 1 })], {
        traitIds: ["cache-savvy"],
      }),
    );
    const chatgpt = character(state, "chatgpt");
    const finance = chatgpt.themes.find(({ themeId }) => themeId === "finance")!;
    const politics = chatgpt.themes.find(({ themeId }) => themeId === "politics")!;
    expect(finance).toMatchObject({
      fastTrackedByTrait: true,
      unlocked: true,
    });
    expect(politics).toMatchObject({
      fastTrackedByTrait: false,
      unlocked: false,
    });
  });

  it("preserves the existing provider-cumulative wardrobe thresholds exactly", () => {
    const beforeFinance = character(
      evaluateProgression(input([bucket("2026-07-16", { openai: 4_999 })])),
      "chatgpt",
    );
    expect(beforeFinance.themes.filter(({ unlocked }) => unlocked).map(({ themeId }) => themeId)).toEqual([
      "tech",
    ]);

    const atFinance = character(
      evaluateProgression(input([bucket("2026-07-16", { openai: 5_000 })])),
      "chatgpt",
    );
    expect(atFinance.themes.filter(({ unlocked }) => unlocked).map(({ themeId }) => themeId)).toEqual([
      "tech",
      "finance",
    ]);
    expect(atFinance.themes[1]!.progress.explanation).toBe(
      "本機 openai 已達第 2 階，解鎖 finance 主題。",
    );
  });

  it("unlocks GLM and only its first lifetime theme at exactly five million", () => {
    const before = character(
      evaluateProgression(
        input([bucket("2026-07-16", { openai: 4_999_999 })]),
      ),
      "glm",
    );
    expect(before.unlocked).toBe(false);
    expect(before.themes.every(({ unlocked }) => !unlocked)).toBe(true);

    const atUnlock = character(
      evaluateProgression(input([bucket("2026-07-16", { openai: 5_000_000 })])),
      "glm",
    );
    expect(atUnlock.unlocked).toBe(true);
    expect(atUnlock.themes.filter(({ unlocked }) => unlocked).map(({ themeId }) => themeId)).toEqual([
      "tech",
    ]);
    expect(atUnlock.themes[1]!.progress).toEqual({
      value: 5_000_000 / 5_250_000,
      explanation:
        "本機累積總用量已達 5,000,000 tokens，再 250,000 tokens 即可解鎖 GLM 的 finance 主題。",
    });
  });

  it("advances GLM through the explicit next lifetime thresholds without mass unlock", () => {
    for (const [index, threshold] of GLM_WARDROBE_LIFETIME_THRESHOLDS.entries()) {
      const glm = character(
        evaluateProgression(
          input([bucket("2026-07-16", { openai: threshold })]),
        ),
        "glm",
      );
      expect(glm.themes.filter(({ unlocked }) => unlocked).map(({ themeId }) => themeId)).toEqual(
        WARDROBE_THEME_IDS.slice(0, index + 1),
      );
    }
  });

  it("never fast-tracks a GLM theme below character unlock or more than one tier", () => {
    const beforeUnlock = character(
      evaluateProgression(
        input([bucket("2026-07-16", { openai: 4_999_999 })], {
          traitIds: ["cache-savvy"],
        }),
      ),
      "glm",
    );
    expect(beforeUnlock.themes.every(({ unlocked }) => !unlocked)).toBe(true);

    const atUnlock = character(
      evaluateProgression(
        input([bucket("2026-07-16", { openai: 5_000_000 })], {
          traitIds: ["cache-savvy"],
        }),
      ),
      "glm",
    );
    expect(atUnlock.themes.filter(({ unlocked }) => unlocked).map(({ themeId }) => themeId)).toEqual([
      "tech",
      "finance",
    ]);
  });

  it("preserves a previously persisted GLM theme and its original timestamp after v2", () => {
    const persistedAt = "2026-07-15T08:00:00.000Z";
    const state = evaluateProgression(
      input([], {
        persistedUnlockedAt: { "theme:glm:festival": persistedAt },
      }),
    );
    expect(
      character(state, "glm").themes.find(({ themeId }) => themeId === "festival"),
    ).toMatchObject({
      unlocked: true,
      unlockedAt: persistedAt,
      progress: {
        value: 1,
        explanation: "GLM 的 festival 主題 已解鎖；本機解鎖不會倒退。",
      },
    });
  });

  it("makes base poses/actions available at character unlock and stages celebrations", () => {
    const days = Array.from({ length: 7 }, (_, index) =>
      bucket(`2026-07-${String(10 + index).padStart(2, "0")}`, { openai: 1 }),
    );
    const state = evaluateProgression(input(days));
    const chatgpt = character(state, "chatgpt");
    expect(chatgpt.poseSets.find(({ poseSetId }) => poseSetId === "supported")?.unlocked).toBe(
      true,
    );
    expect(chatgpt.poseSets.find(({ poseSetId }) => poseSetId === "challenged")?.unlocked).toBe(
      true,
    );
    expect(chatgpt.poseSets.find(({ poseSetId }) => poseSetId === "victory")?.unlocked).toBe(
      true,
    );
    expect(chatgpt.actions.find(({ actionId }) => actionId === "laugh")?.unlocked).toBe(
      true,
    );
    expect(chatgpt.actions.find(({ actionId }) => actionId === "applause")?.unlocked).toBe(
      false,
    );
  });

  it("never re-locks and preserves the original persisted unlock timestamp", () => {
    const first = evaluateProgression(
      input([
        bucket("2026-07-14", { openai: 1 }),
        bucket("2026-07-15", { openai: 1 }),
        bucket("2026-07-16", { openai: 1 }),
      ]),
    );
    const persisted = withProgressionEvaluation(
      createEmptyLocalProgressionStore(),
      first,
    );
    const afterBreak = evaluateProgression(
      input([bucket("2026-07-17", {})], {
        evaluatedAt: "2026-07-17T12:00:00.000Z",
        persistedUnlockedAt: persisted.unlockedAt,
        selection: persisted.selection,
      }),
    );
    expect(character(first, "mistral").unlockedAt).toBe(EVALUATED_AT);
    expect(character(afterBreak, "mistral")).toMatchObject({
      unlocked: true,
      unlockedAt: EVALUATED_AT,
      progress: {
        value: 1,
        explanation: "Mistral 已解鎖；本機解鎖不會倒退。",
      },
    });
    expect(
      character(afterBreak, "chatgpt").poseSets.find(
        ({ poseSetId }) => poseSetId === "victory",
      ),
    ).toMatchObject({ unlocked: true, unlockedAt: EVALUATED_AT });
  });
});
