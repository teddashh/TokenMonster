import { afterEach, describe, expect, it, vi } from "vitest";

import {
  characterProfileEvolutionLabel,
  characterProfileMoodLabel,
  characterProfileReasonText,
  characterProfileTraitLabel,
  parseCharacterProfileResponse,
  presentCharacterProfile,
  requestCharacterProfile,
  type CharacterFetch,
} from "../src/public/app.js";
import { setUiLocale } from "../src/public/localization.js";

afterEach(() => setUiLocale("zh-TW"));

const READY_PROFILE = {
  status: "ok",
  schemaVersion: "1",
  generatedAt: "2026-07-16T12:00:00.000Z",
  freshness: "fresh",
  dataQuality: "estimated-positive-days",
  window: {
    fromUtcDate: "2026-06-19",
    toUtcDate: "2026-07-16",
    timezone: "UTC",
  },
  identity: {
    status: "ready",
    coverageBand: "good",
    provisional: false,
    traitIds: ["cli-focused"],
  },
  mood: { id: "steady", energyBand: "medium" },
  evolution: { cadence: "event", event: "initial-profile" },
  reasons: [
    {
      subject: "identity",
      reasonCode: "IDENTITY_READY_COVERAGE_28D",
      templateId: "monster.identity.ready.v1",
      inputs: [
        { metric: "observed-days", valueBand: "available", coverage: "good" },
        { metric: "active-days", valueBand: "available", coverage: "good" },
      ],
    },
    {
      subject: "trait",
      reasonCode: "TRAIT_CLI_FOCUS_28D",
      templateId: "monster.trait.cliFocused.v1",
      inputs: [{ metric: "cli-share", valueBand: "high", coverage: "partial" }],
    },
    {
      subject: "mood",
      reasonCode: "MOOD_RELATIVE_ACTIVITY_STABLE",
      templateId: "monster.mood.steady.v1",
      inputs: [
        {
          metric: "relative-daily-activity",
          valueBand: "near-baseline",
          coverage: "good",
        },
      ],
    },
    {
      subject: "evolution",
      reasonCode: "EVOLUTION_INITIAL_PROFILE",
      templateId: "monster.evolution.initialProfile.v1",
      inputs: [
        { metric: "trait-structure", valueBand: "initial", coverage: "good" },
      ],
    },
  ],
} as const;

const LEARNING_PROFILE = {
  status: "ok",
  schemaVersion: "1",
  generatedAt: "2026-07-16T12:00:00.000Z",
  freshness: "stale",
  dataQuality: "estimated-positive-days",
  window: {
    fromUtcDate: "2026-06-19",
    toUtcDate: "2026-07-16",
    timezone: "UTC",
  },
  identity: {
    status: "learning",
    coverageBand: "insufficient",
    provisional: false,
    traitIds: [],
  },
  mood: { id: "learning", energyBand: "dormant" },
  evolution: { cadence: "event", event: "awaiting-coverage" },
  reasons: [
    {
      subject: "identity",
      reasonCode: "IDENTITY_LEARNING_COVERAGE_28D",
      templateId: "monster.identity.learning.v1",
      inputs: [
        {
          metric: "observed-days",
          valueBand: "insufficient",
          coverage: "insufficient",
        },
        {
          metric: "active-days",
          valueBand: "insufficient",
          coverage: "insufficient",
        },
      ],
    },
    {
      subject: "mood",
      reasonCode: "MOOD_LEARNING_COVERAGE_28D",
      templateId: "monster.mood.learning.v1",
      inputs: [
        {
          metric: "relative-daily-activity",
          valueBand: "insufficient",
          coverage: "insufficient",
        },
      ],
    },
    {
      subject: "evolution",
      reasonCode: "EVOLUTION_AWAITING_COVERAGE",
      templateId: "monster.evolution.awaitingCoverage.v1",
      inputs: [
        {
          metric: "trait-structure",
          valueBand: "insufficient",
          coverage: "insufficient",
        },
      ],
    },
  ],
} as const;

describe("localized character profile presentation", () => {
  it("derives a bounded Han-free English share presentation", () => {
    setUiLocale("en");
    const profile = presentCharacterProfile(
      parseCharacterProfileResponse(READY_PROFILE),
    );
    expect(JSON.stringify(profile)).not.toMatch(/\p{Script=Han}/u);
    expect([...profile.shareCard.mood].length).toBeLessThanOrEqual(16);
    expect(
      profile.shareCard.traitLabels.every((label) => [...label].length <= 16),
    ).toBe(true);
    expect([...profile.shareCard.evolution].length).toBeLessThanOrEqual(20);
    expect([...profile.shareCard.attribution].length).toBeLessThanOrEqual(80);
  });
});

const EVIDENCE_GRACE_PROFILE = {
  ...READY_PROFILE,
  identity: {
    ...READY_PROFILE.identity,
    coverageBand: "insufficient",
    provisional: true,
  },
  mood: { id: "unknown", energyBand: "dormant" },
  evolution: { cadence: "none", event: "no-change" },
  reasons: [
    {
      subject: "identity",
      reasonCode: "IDENTITY_HELD_EVIDENCE_GRACE_7D",
      templateId: "monster.identity.heldEvidenceGrace.v1",
      inputs: [
        {
          metric: "observed-days",
          valueBand: "insufficient",
          coverage: "insufficient",
        },
        {
          metric: "active-days",
          valueBand: "insufficient",
          coverage: "insufficient",
        },
        {
          metric: "trait-structure",
          valueBand: "held",
          coverage: "insufficient",
        },
      ],
    },
    {
      subject: "trait",
      reasonCode: "TRAIT_HELD_EVIDENCE_GRACE_7D",
      templateId: "monster.trait.heldEvidenceGrace.v1",
      inputs: [
        {
          metric: "trait-structure",
          valueBand: "held",
          coverage: "insufficient",
        },
      ],
    },
    {
      subject: "mood",
      reasonCode: "MOOD_TODAY_UNAVAILABLE",
      templateId: "monster.mood.unknown.v1",
      inputs: [
        {
          metric: "relative-daily-activity",
          valueBand: "unavailable",
          coverage: "insufficient",
        },
      ],
    },
    {
      subject: "evolution",
      reasonCode: "EVOLUTION_NO_CHANGE",
      templateId: "monster.evolution.noChange.v1",
      inputs: [
        {
          metric: "trait-structure",
          valueBand: "stable",
          coverage: "insufficient",
        },
      ],
    },
  ],
} as const;

const PROVISIONAL_PROFILE = {
  ...READY_PROFILE,
  identity: { ...READY_PROFILE.identity, provisional: true },
  evolution: { cadence: "event", event: "identity-shift" },
  reasons: [
    {
      subject: "identity",
      reasonCode: "IDENTITY_PROVISIONAL_DAILY_LIMIT",
      templateId: "monster.identity.provisionalDailyLimit.v1",
      inputs: [
        { metric: "observed-days", valueBand: "available", coverage: "good" },
        { metric: "active-days", valueBand: "available", coverage: "good" },
        {
          metric: "trait-structure",
          valueBand: "provisional",
          coverage: "good",
        },
      ],
    },
    {
      subject: "trait",
      reasonCode: "TRAIT_HELD_DAILY_LIMIT",
      templateId: "monster.trait.heldDailyLimit.v1",
      inputs: [
        {
          metric: "trait-structure",
          valueBand: "provisional",
          coverage: "good",
        },
      ],
    },
    READY_PROFILE.reasons[2],
    {
      subject: "evolution",
      reasonCode: "EVOLUTION_IDENTITY_SHIFT",
      templateId: "monster.evolution.identityShift.v1",
      inputs: [
        { metric: "trait-structure", valueBand: "changed", coverage: "good" },
      ],
    },
  ],
} as const;

const LEARNING_EVIDENCE_PROFILE = {
  ...LEARNING_PROFILE,
  freshness: "fresh",
  reasons: [
    {
      subject: "identity",
      reasonCode: "IDENTITY_LEARNING_EVIDENCE_28D",
      templateId: "monster.identity.learningEvidence.v1",
      inputs: [
        { metric: "observed-days", valueBand: "available", coverage: "good" },
        { metric: "active-days", valueBand: "available", coverage: "good" },
        {
          metric: "trait-structure",
          valueBand: "unavailable",
          coverage: "insufficient",
        },
      ],
    },
    LEARNING_PROFILE.reasons[1],
    LEARNING_PROFILE.reasons[2],
  ],
} as const;

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("character profile client contract", () => {
  it("accepts and deeply freezes the exact bounded DTO", () => {
    const parsed = parseCharacterProfileResponse(
      structuredClone(READY_PROFILE),
    );

    expect(parsed).toEqual(READY_PROFILE);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.window)).toBe(true);
    expect(Object.isFrozen(parsed.identity)).toBe(true);
    expect(Object.isFrozen(parsed.identity.traitIds)).toBe(true);
    expect(Object.isFrozen(parsed.reasons)).toBe(true);
    expect(Object.isFrozen(parsed.reasons[0])).toBe(true);
    expect(Object.isFrozen(parsed.reasons[0]?.inputs)).toBe(true);
    expect(Object.isFrozen(parsed.reasons[0]?.inputs[0])).toBe(true);
  });

  it("requests only the fixed local route and forwards the abort signal", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () =>
      jsonResponse(READY_PROFILE),
    ) as CharacterFetch;

    const result = await requestCharacterProfile(controller.signal, fetcher);

    expect(result.identity.traitIds).toEqual(["cli-focused"]);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/characters/profile",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
      }),
    );
  });

  it("keeps profile JSON reads behind the existing body-size bound", async () => {
    const response = new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "262145",
      },
    });
    const fetcher = vi.fn(async () => response) as CharacterFetch;

    await expect(
      requestCharacterProfile(new AbortController().signal, fetcher),
    ).rejects.toThrow("Invalid characters response");
  });

  it.each([
    ["an expanded top-level DTO", { ...READY_PROFILE, provider: "openai" }],
    ["an unknown schema", { ...READY_PROFILE, schemaVersion: "2" }],
    [
      "a non-UTC window",
      {
        ...READY_PROFILE,
        window: { ...READY_PROFILE.window, timezone: "local" },
      },
    ],
    [
      "a non-28-day window",
      {
        ...READY_PROFILE,
        window: { ...READY_PROFILE.window, fromUtcDate: "2026-06-20" },
      },
    ],
    [
      "a provider-derived trait",
      {
        ...READY_PROFILE,
        identity: {
          ...READY_PROFILE.identity,
          traitIds: ["provider-focused"],
        },
      },
    ],
    [
      "a ready profile without a visible trait",
      {
        ...READY_PROFILE,
        identity: { ...READY_PROFILE.identity, traitIds: [] },
        reasons: [READY_PROFILE.reasons[0], ...READY_PROFILE.reasons.slice(2)],
      },
    ],
    [
      "a provider-derived reason and template",
      {
        ...READY_PROFILE,
        reasons: [
          READY_PROFILE.reasons[0],
          {
            ...READY_PROFILE.reasons[1],
            reasonCode: "TRAIT_PROVIDER_FOCUS_28D",
            templateId: "monster.trait.providerFocused.v1",
          },
          ...READY_PROFILE.reasons.slice(2),
        ],
      },
    ],
    [
      "a provider-derived metric",
      {
        ...READY_PROFILE,
        reasons: [
          READY_PROFILE.reasons[0],
          {
            ...READY_PROFILE.reasons[1],
            inputs: [
              {
                metric: "top-provider-share",
                valueBand: "high",
                coverage: "good",
              },
            ],
          },
          ...READY_PROFILE.reasons.slice(2),
        ],
      },
    ],
    [
      "a mismatched reason template",
      {
        ...READY_PROFILE,
        reasons: [
          {
            ...READY_PROFILE.reasons[0],
            templateId: "monster.identity.learning.v1",
          },
          ...READY_PROFILE.reasons.slice(1),
        ],
      },
    ],
    [
      "more than three reason inputs",
      {
        ...READY_PROFILE,
        reasons: [
          {
            ...READY_PROFILE.reasons[0],
            inputs: [
              ...READY_PROFILE.reasons[0].inputs,
              { metric: "cli-share", valueBand: "high", coverage: "good" },
              {
                metric: "tool-diversity",
                valueBand: "diverse",
                coverage: "good",
              },
            ],
          },
          ...READY_PROFILE.reasons.slice(1),
        ],
      },
    ],
    [
      "more than six reasons",
      {
        ...READY_PROFILE,
        reasons: [
          ...READY_PROFILE.reasons,
          READY_PROFILE.reasons[1],
          READY_PROFILE.reasons[1],
          READY_PROFILE.reasons[1],
        ],
      },
    ],
    [
      "an expanded nested reason",
      {
        ...READY_PROFILE,
        reasons: [
          { ...READY_PROFILE.reasons[0], rawValue: 123 },
          ...READY_PROFILE.reasons.slice(1),
        ],
      },
    ],
    [
      "a mismatched evolution cadence",
      {
        ...READY_PROFILE,
        evolution: { cadence: "weekly", event: "initial-profile" },
      },
    ],
    [
      "a lively mood with dormant energy",
      {
        ...READY_PROFILE,
        mood: { id: "lively", energyBand: "dormant" },
        reasons: [
          READY_PROFILE.reasons[0],
          READY_PROFILE.reasons[1],
          {
            ...READY_PROFILE.reasons[2],
            reasonCode: "MOOD_RELATIVE_ACTIVITY_HIGH",
            templateId: "monster.mood.lively.v1",
          },
          READY_PROFILE.reasons[3],
        ],
      },
    ],
    [
      "a mood reason that contradicts the visible mood",
      {
        ...READY_PROFILE,
        reasons: [
          READY_PROFILE.reasons[0],
          READY_PROFILE.reasons[1],
          {
            ...READY_PROFILE.reasons[2],
            reasonCode: "MOOD_RESTING_TODAY",
            templateId: "monster.mood.resting.v1",
          },
          READY_PROFILE.reasons[3],
        ],
      },
    ],
    [
      "an output-heavy reason for a CLI-focused visible trait",
      {
        ...READY_PROFILE,
        reasons: [
          READY_PROFILE.reasons[0],
          {
            ...READY_PROFILE.reasons[1],
            reasonCode: "TRAIT_OUTPUT_HEAVY_28D",
            templateId: "monster.trait.outputHeavy.v1",
          },
          ...READY_PROFILE.reasons.slice(2),
        ],
      },
    ],
    [
      "an evolution reason that contradicts the visible event",
      {
        ...READY_PROFILE,
        reasons: [
          ...READY_PROFILE.reasons.slice(0, 3),
          {
            ...READY_PROFILE.reasons[3],
            reasonCode: "EVOLUTION_NO_CHANGE",
            templateId: "monster.evolution.noChange.v1",
          },
        ],
      },
    ],
  ])("rejects %s", (_label, value) => {
    expect(() => parseCharacterProfileResponse(value)).toThrow(
      "Invalid character profile response",
    );
  });

  it.each(["provider-focused", "multi-provider", "balanced"])(
    "rejects the unproven %s trait",
    (traitId) => {
      expect(() =>
        parseCharacterProfileResponse({
          ...READY_PROFILE,
          identity: { ...READY_PROFILE.identity, traitIds: [traitId] },
        }),
      ).toThrow("Invalid character profile response");
    },
  );

  it.each([
    ["TRAIT_PROVIDER_FOCUS_28D", "monster.trait.providerFocused.v1"],
    ["TRAIT_MULTI_PROVIDER_28D", "monster.trait.multiProvider.v1"],
    ["TRAIT_BALANCED_FALLBACK_28D", "monster.trait.balanced.v1"],
  ])(
    "rejects the unproven %s reason/template pair",
    (reasonCode, templateId) => {
      expect(() =>
        parseCharacterProfileResponse({
          ...READY_PROFILE,
          reasons: [
            READY_PROFILE.reasons[0],
            { ...READY_PROFILE.reasons[1], reasonCode, templateId },
            ...READY_PROFILE.reasons.slice(2),
          ],
        }),
      ).toThrow("Invalid character profile response");
    },
  );

  it.each(["top-provider-share", "provider-diversity"])(
    "rejects the provider-specific %s metric",
    (metric) => {
      expect(() =>
        parseCharacterProfileResponse({
          ...READY_PROFILE,
          reasons: [
            READY_PROFILE.reasons[0],
            {
              ...READY_PROFILE.reasons[1],
              inputs: [
                {
                  metric,
                  valueBand: "high",
                  coverage: "good",
                },
              ],
            },
            ...READY_PROFILE.reasons.slice(2),
          ],
        }),
      ).toThrow("Invalid character profile response");
    },
  );

  it("accepts a held trait reason for any still-visible allowlisted trait", () => {
    expect(() =>
      parseCharacterProfileResponse({
        ...READY_PROFILE,
        reasons: [
          READY_PROFILE.reasons[0],
          {
            ...READY_PROFILE.reasons[1],
            reasonCode: "TRAIT_HELD_SAME_WINDOW",
            templateId: "monster.trait.heldSameWindow.v1",
            inputs: [
              {
                metric: "trait-structure",
                valueBand: "held",
                coverage: "good",
              },
            ],
          },
          ...READY_PROFILE.reasons.slice(2),
        ],
      }),
    ).not.toThrow();
  });

  it.each([
    [
      "a reason-specific metric mismatch",
      { metric: "output-share", valueBand: "near-baseline", coverage: "good" },
    ],
    [
      "a reason-specific value-band mismatch",
      {
        metric: "relative-daily-activity",
        valueBand: "above-baseline",
        coverage: "good",
      },
    ],
    [
      "a reason-specific coverage mismatch",
      {
        metric: "relative-daily-activity",
        valueBand: "near-baseline",
        coverage: "bogus",
      },
    ],
  ])("rejects %s", (_label, input) => {
    expect(() =>
      parseCharacterProfileResponse({
        ...READY_PROFILE,
        reasons: [
          READY_PROFILE.reasons[0],
          READY_PROFILE.reasons[1],
          { ...READY_PROFILE.reasons[2], inputs: [input] },
          READY_PROFILE.reasons[3],
        ],
      }),
    ).toThrow("Invalid character profile response");
  });

  it("rejects an allowlisted coverage band paired with impossible ready evidence", () => {
    expect(() =>
      parseCharacterProfileResponse({
        ...READY_PROFILE,
        reasons: [
          {
            ...READY_PROFILE.reasons[0],
            inputs: [
              {
                ...READY_PROFILE.reasons[0].inputs[0],
                coverage: "insufficient",
              },
              READY_PROFILE.reasons[0].inputs[1],
            ],
          },
          ...READY_PROFILE.reasons.slice(1),
        ],
      }),
    ).toThrow("Invalid character profile response");
  });

  it("rejects top-level identity coverage or provisional state that contradicts its reason", () => {
    expect(() =>
      parseCharacterProfileResponse({
        ...READY_PROFILE,
        identity: { ...READY_PROFILE.identity, coverageBand: "partial" },
      }),
    ).toThrow("Invalid character profile response");
    expect(() =>
      parseCharacterProfileResponse({
        ...READY_PROFILE,
        identity: { ...READY_PROFILE.identity, provisional: true },
      }),
    ).toThrow("Invalid character profile response");
    expect(() =>
      parseCharacterProfileResponse({
        ...EVIDENCE_GRACE_PROFILE,
        identity: {
          ...EVIDENCE_GRACE_PROFILE.identity,
          provisional: false,
        },
      }),
    ).toThrow("Invalid character profile response");
    expect(() =>
      parseCharacterProfileResponse(PROVISIONAL_PROFILE),
    ).not.toThrow();
    expect(() =>
      parseCharacterProfileResponse({
        ...PROVISIONAL_PROFILE,
        identity: { ...PROVISIONAL_PROFILE.identity, provisional: false },
      }),
    ).toThrow("Invalid character profile response");
  });

  it("rejects disagreement between inputs that share one coverage authority", () => {
    expect(() =>
      parseCharacterProfileResponse({
        ...READY_PROFILE,
        reasons: [
          {
            ...READY_PROFILE.reasons[0],
            inputs: [
              READY_PROFILE.reasons[0].inputs[0],
              {
                ...READY_PROFILE.reasons[0].inputs[1],
                coverage: "partial",
              },
            ],
          },
          ...READY_PROFILE.reasons.slice(1),
        ],
      }),
    ).toThrow("Invalid character profile response");
  });

  it("requires evidence-grace identity and trait reasons to travel together", () => {
    expect(() =>
      parseCharacterProfileResponse(EVIDENCE_GRACE_PROFILE),
    ).not.toThrow();
    expect(() =>
      parseCharacterProfileResponse({
        ...EVIDENCE_GRACE_PROFILE,
        reasons: [
          EVIDENCE_GRACE_PROFILE.reasons[0],
          READY_PROFILE.reasons[1],
          ...EVIDENCE_GRACE_PROFILE.reasons.slice(2),
        ],
      }),
    ).toThrow("Invalid character profile response");
  });
});

describe("character profile zh-TW presentation", () => {
  it("maps ready traits, mood, evolution, reasons, and share-card labels", () => {
    const profile = parseCharacterProfileResponse(READY_PROFILE);
    const presentation = presentCharacterProfile(profile);

    expect(presentation).toMatchObject({
      heading: "夥伴側寫",
      stateLabel: "側寫已成形",
      freshnessLabel: "最新本機側寫",
      mood: { label: "穩穩同行", energyLabel: "穩定" },
      evolution: { label: "初次側寫完成" },
      shareCard: {
        mood: "穩穩同行",
        traitLabels: ["CLI 專注型"],
        evolution: "初次側寫完成",
        attribution: "近 28 天的工具使用較集中在命令列介面。",
      },
    });
    expect(presentation.reasonLines).toHaveLength(4);
    expect(presentation.dataNote).toContain("缺少的日期不會被當成零用量");
    expect(Object.isFrozen(presentation)).toBe(true);
    expect(Object.isFrozen(presentation.shareCard.traitLabels)).toBe(true);
  });

  it("is honest about learning and stale data without rewarding token burn", () => {
    const presentation = presentCharacterProfile(
      parseCharacterProfileResponse(LEARNING_PROFILE),
    );

    expect(presentation.stateLabel).toBe("認識中");
    expect(presentation.freshnessLabel).toBe("最近一次可用側寫");
    expect(presentation.freshnessNote).toContain("暫時無法更新");
    expect(presentation.summary).toContain("不需要刻意增加用量");
    expect(presentation.traits).toEqual([]);
    expect(presentation.shareCard.traitLabels).toEqual([]);
    expect(presentation.shareCard.attribution).toContain("自然累積");
  });

  it("keeps learning when dates are sufficient but concrete trait evidence is not", () => {
    const profile = parseCharacterProfileResponse(LEARNING_EVIDENCE_PROFILE);
    const presentation = presentCharacterProfile(profile);

    expect(profile.identity).toMatchObject({
      status: "learning",
      coverageBand: "insufficient",
      traitIds: [],
    });
    expect(presentation.stateLabel).toBe("認識中");
    expect(presentation.reasonLines).toContain(
      "近期資料還無法證明穩定特質，夥伴會保持「認識中」而不替你猜測。",
    );
    expect(presentation.traits).toEqual([]);
  });

  it("explains that evidence-loss continuity is temporary and bounded", () => {
    const presentation = presentCharacterProfile(
      parseCharacterProfileResponse(EVIDENCE_GRACE_PROFILE),
    );

    expect(presentation.stateLabel).toBe("側寫已成形");
    expect(presentation.summary).toContain("只會短暫保留");
    expect(presentation.reasonLines).toContain(
      "近期證據暫時不足；夥伴最多保留七個自然日的既有側寫，之後會回到認識中。",
    );
  });

  it("exports stable labels for direct panel and share-card composition", () => {
    expect(characterProfileTraitLabel("multi-tool")).toBe("多工具切換型");
    expect(characterProfileMoodLabel("resting")).toBe("最近在休息");
    expect(characterProfileEvolutionLabel("no-change")).toBe("近期節奏穩定");
    expect(characterProfileReasonText("MOOD_TODAY_UNAVAILABLE")).toContain(
      "不推測",
    );
  });
});
