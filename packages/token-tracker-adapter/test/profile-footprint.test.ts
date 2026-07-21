import { DailyContentBlindFootprintV1Schema } from "@tokenmonster/monster-engine";
import { describe, expect, it, vi } from "vitest";

import {
  createTokenTrackerAdapter,
  type TokenTrackerFetch,
  type TokenTrackerFetchResponse
} from "../src/index.js";

const RANGE = Object.freeze({
  fromUtcDate: "2026-06-20",
  toUtcDate: "2026-07-17"
});
const EXCLUDED_CURSOR = Object.freeze([
  Object.freeze({
    source: "cursor",
    source_scope: "account",
    reason: "account_level_source"
  })
]);
const PRIVATE_MODEL_CANARY = "PRIVATE_MODEL_NAME_must_not_leave_adapter";

interface Components {
  readonly input: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
}

function tokenTotals(
  components: Components,
  overrides: Readonly<Record<string, unknown>> = {}
) {
  const total =
    components.input +
    (components.output ?? 0) +
    (components.cacheRead ?? 0) +
    (components.cacheWrite ?? 0);
  return {
    total_tokens: total,
    billable_total_tokens: total,
    input_tokens: components.input,
    output_tokens: components.output ?? 0,
    cached_input_tokens: components.cacheRead ?? 0,
    cache_creation_input_tokens: components.cacheWrite ?? 0,
    reasoning_output_tokens: components.reasoning ?? 0,
    ...overrides
  };
}

function model(
  name: string,
  components: Components,
  overrides: Readonly<Record<string, unknown>> = {}
) {
  return {
    model: name,
    model_id: name,
    totals: {
      ...tokenTotals(components),
      total_cost_usd: "0.000000"
    },
    ...overrides
  };
}

function geminiModel(
  name: string,
  components: Components,
  unclassifiedRemainder = 0
) {
  const base = tokenTotals(components);
  const total =
    base.total_tokens +
    (components.reasoning ?? 0) +
    unclassifiedRemainder;
  return model(name, components, {
    totals: {
      ...base,
      total_tokens: total,
      billable_total_tokens: total,
      total_cost_usd: "0.000000"
    }
  });
}

function source(
  sourceId: string,
  models: readonly ReturnType<typeof model>[],
  overrides: Readonly<Record<string, unknown>> = {}
) {
  const totals = models.reduce(
    (sum, item) => {
      for (const key of [
        "total_tokens",
        "billable_total_tokens",
        "input_tokens",
        "output_tokens",
        "cached_input_tokens",
        "cache_creation_input_tokens",
        "reasoning_output_tokens"
      ] as const) {
        sum[key] += Number(item.totals[key]);
      }
      return sum;
    },
    {
      total_tokens: 0,
      billable_total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0
    }
  );
  return {
    source: sourceId,
    source_scope: "local",
    totals: { ...totals, total_cost_usd: "0.000000" },
    models,
    ...overrides
  };
}

function breakdownBody(
  utcDate: string,
  sources: readonly ReturnType<typeof source>[],
  overrides: Readonly<Record<string, unknown>> = {}
) {
  return {
    from: utcDate,
    to: utcDate,
    days: 0,
    scope: "personal",
    excluded_sources: EXCLUDED_CURSOR,
    sources,
    pricing: {
      model: "per-model",
      pricing_mode: "per_token_type",
      source: "litellm",
      effective_from: "2026-07-17"
    },
    ...overrides
  };
}

function dailyRow(
  day: string,
  sources: readonly ReturnType<typeof source>[],
  overrides: Readonly<Record<string, unknown>> = {}
) {
  const totals = sources.reduce(
    (sum, item) => {
      for (const key of [
        "total_tokens",
        "billable_total_tokens",
        "input_tokens",
        "output_tokens",
        "cached_input_tokens",
        "cache_creation_input_tokens",
        "reasoning_output_tokens"
      ] as const) {
        sum[key] += Number(item.totals[key]);
      }
      return sum;
    },
    {
      total_tokens: 0,
      billable_total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0
    }
  );
  const models: Record<string, number> = {};
  for (const item of sources) {
    for (const modelEntry of item.models) {
      models[modelEntry.model] =
        (models[modelEntry.model] ?? 0) +
        Number(modelEntry.totals.total_tokens);
    }
  }
  return {
    day,
    ...totals,
    conversation_count: 1,
    total_cost_usd: 0,
    models,
    ...overrides
  };
}

function dailyBody(
  rows: readonly ReturnType<typeof dailyRow>[],
  overrides: Readonly<Record<string, unknown>> = {}
) {
  return {
    from: RANGE.fromUtcDate,
    to: RANGE.toUtcDate,
    scope: "personal",
    excluded_sources: EXCLUDED_CURSOR,
    data: rows,
    ...overrides
  };
}

function jsonResponse(body: unknown): TokenTrackerFetchResponse {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  }) as unknown as TokenTrackerFetchResponse;
}

function activeFixture() {
  const firstDate = "2026-07-16";
  const secondDate = "2026-07-17";
  const firstSources = [source("codex", [model("gpt-first", { input: 40 })])];
  const secondSources = [
    source("codex", [
      model(PRIVATE_MODEL_CANARY, {
        input: 100,
        output: 20,
        cacheRead: 10,
        cacheWrite: 2,
        reasoning: 5
      })
    ]),
    source("claude", [
      model("claude-private", { input: 40, output: 10 })
    ]),
    source("gemini", [model("gemini-private", { input: 30, output: 5 })]),
    source("grok", [model("grok-private", { input: 20, output: 10 })]),
    source("zcode", [model("zcode-private", { input: 7, output: 3 })]),
    source("glm", [model("glm-private", { input: 5, output: 5 })])
  ];
  return {
    daily: dailyBody([
      dailyRow(firstDate, firstSources),
      dailyRow(secondDate, secondSources)
    ]),
    breakdowns: new Map<string, unknown>([
      [firstDate, breakdownBody(firstDate, firstSources)],
      [secondDate, breakdownBody(secondDate, secondSources)]
    ])
  };
}

function fixtureFetch(
  daily: unknown,
  breakdowns: ReadonlyMap<string, unknown>
): TokenTrackerFetch {
  return vi.fn<TokenTrackerFetch>(async (endpoint) => {
    const url = new URL(endpoint);
    if (url.pathname.endsWith("usage-daily")) return jsonResponse(daily);
    const utcDate = url.searchParams.get("from") ?? "";
    return jsonResponse(breakdowns.get(utcDate));
  });
}

describe("28-day personal profile footprint", () => {
  it("projects reconciled source totals once into estimated content-blind dimensions", async () => {
    const fixture = activeFixture();
    const fetch = fixtureFetch(fixture.daily, fixture.breakdowns);
    const result = await createTokenTrackerAdapter({ fetch })
      .getDailyContentBlindFootprint({ ...RANGE, characterId: "chatgpt" });

    expect(DailyContentBlindFootprintV1Schema.safeParse(result).success).toBe(
      true
    );
    expect(result).toMatchObject({
      schemaVersion: "1",
      characterId: "chatgpt",
      window: { from: RANGE.fromUtcDate, to: RANGE.toUtcDate, timezone: "UTC" }
    });
    expect(result.days).toHaveLength(28);
    expect(result.days.filter((day) => day.coverage === "observed")).toHaveLength(
      2
    );
    expect(result.days[0]).toEqual({
      localDate: RANGE.fromUtcDate,
      coverage: "unavailable",
      aggregates: []
    });
    expect(result.days.at(-1)?.aggregates).toEqual([
      {
        provider: "other",
        modelFamily: "other",
        tool: "codex-cli",
        valueQuality: "estimated",
        cacheReadAvailability: "unavailable",
        tokens: {
          input: "100",
          output: "20",
          cacheRead: "0",
          cacheWrite: "2",
          reasoning: "5",
          other: "10",
          total: "132"
        }
      },
      expect.objectContaining({
        provider: "other",
        modelFamily: "other",
        tool: "claude-code",
        valueQuality: "estimated",
        cacheReadAvailability: "unavailable"
      }),
      expect.objectContaining({
        provider: "other",
        modelFamily: "other",
        tool: "gemini-cli",
        valueQuality: "estimated",
        cacheReadAvailability: "unavailable"
      }),
      expect.objectContaining({
        provider: "other",
        modelFamily: "other",
        tool: "grok-build",
        valueQuality: "estimated",
        cacheReadAvailability: "unavailable"
      }),
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
          other: "20",
          total: "20"
        }
      }
    ]);
    const lastDayTotal = result.days
      .at(-1)!
      .aggregates.reduce((sum, aggregate) => sum + Number(aggregate.tokens.total), 0);
    expect(lastDayTotal).toBe(267);
    expect(result).not.toHaveProperty("localHourlyRhythm");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.days)).toBe(true);
    expect(Object.isFrozen(result.days.at(-1)?.aggregates)).toBe(true);

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      PRIVATE_MODEL_CANARY,
      "zcode",
      '"glm"',
      "glm-private",
      "claude-private",
      "source_scope",
      "excluded_sources",
      "total_cost_usd",
      "conversation_count"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    expect(fetch).toHaveBeenCalledTimes(3);
    const requestedUrls = vi
      .mocked(fetch)
      .mock.calls.map(([endpoint]) => new URL(endpoint));
    expect(
      requestedUrls.filter(
        (url) =>
          url.pathname === "/functions/tokentracker-usage-daily"
      )
    ).toHaveLength(1);
    expect(
      requestedUrls.filter(
        (url) =>
          url.pathname ===
          "/functions/tokentracker-usage-model-breakdown"
      )
    ).toHaveLength(2);
    for (const url of requestedUrls) {
      expect(url.searchParams.get("scope")).toBe("personal");
      expect(url.searchParams.get("tz")).toBe("UTC");
      expect([...url.searchParams.keys()]).toEqual(["from", "to", "scope", "tz"]);
      if (url.pathname.endsWith("model-breakdown")) {
        expect(url.searchParams.get("from")).toBe(url.searchParams.get("to"));
      }
    }
  });

  it("keeps missing and empty daily coverage unavailable without inventing zero days", async () => {
    const fetch = fixtureFetch(
      dailyBody([], { excluded_sources: [] }),
      new Map()
    );
    const result = await createTokenTrackerAdapter({ fetch })
      .getDailyContentBlindFootprint({ ...RANGE, characterId: "claude" });

    expect(result.days).toHaveLength(28);
    expect(result.days.every((day) => day.coverage === "unavailable")).toBe(
      true
    );
    expect(result.days.every((day) => day.aggregates.length === 0)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("canonicalizes audited Gemini thoughts and reported-total remainder", async () => {
    const date = RANGE.toUtcDate;
    const sources = [
      source("codex", [
        model("codex-subset", { input: 20, output: 10, reasoning: 4 })
      ]),
      source("gemini", [
        geminiModel("gemini-thoughts", {
          input: 10,
          output: 2,
          cacheRead: 3,
          reasoning: 7
        }),
        geminiModel(
          "gemini-remainder",
          { input: 4, output: 1, reasoning: 2 },
          5
        )
      ])
    ];
    const result = await createTokenTrackerAdapter({
      fetch: fixtureFetch(
        dailyBody([dailyRow(date, sources)]),
        new Map([[date, breakdownBody(date, sources)]])
      )
    }).getDailyContentBlindFootprint({ ...RANGE, characterId: "gemini" });

    expect(result.days.at(-1)?.aggregates).toEqual([
      {
        provider: "other",
        modelFamily: "other",
        tool: "codex-cli",
        valueQuality: "estimated",
        cacheReadAvailability: "unavailable",
        tokens: {
          input: "20",
          output: "10",
          cacheRead: "0",
          cacheWrite: "0",
          reasoning: "4",
          other: "0",
          total: "30"
        }
      },
      {
        provider: "other",
        modelFamily: "other",
        tool: "gemini-cli",
        valueQuality: "estimated",
        cacheReadAvailability: "unavailable",
        tokens: {
          input: "14",
          output: "12",
          cacheRead: "0",
          cacheWrite: "0",
          reasoning: "9",
          other: "8",
          total: "34"
        }
      }
    ]);
    expect(DailyContentBlindFootprintV1Schema.safeParse(result).success).toBe(
      true
    );
  });

  it.each([
    [
      "additive Codex reasoning",
      "codex",
      model("codex-additive", { input: 10, output: 4, reasoning: 3 }, {
        totals: {
          ...tokenTotals({ input: 10, output: 4, reasoning: 3 }),
          total_tokens: 17,
          billable_total_tokens: 17,
          total_cost_usd: "0.000000"
        }
      })
    ],
    [
      "underspecified Gemini thoughts",
      "gemini",
      model("gemini-invalid", { input: 10, output: 4, reasoning: 3 })
    ]
  ])("rejects unaudited %s semantics", async (_label, sourceId, entry) => {
    const date = RANGE.toUtcDate;
    const sources = [source(sourceId, [entry])];
    const adapter = createTokenTrackerAdapter({
      fetch: fixtureFetch(
        dailyBody([dailyRow(date, sources)]),
        new Map([[date, breakdownBody(date, sources)]])
      )
    });

    await expect(
      adapter.getDailyContentBlindFootprint({ ...RANGE, characterId: "gemini" })
    ).rejects.toMatchObject({ code: "incompatible-schema" });
  });

  it("rejects non-28-day windows and invalid character IDs before fetching", async () => {
    const fetch = vi.fn<TokenTrackerFetch>();
    const adapter = createTokenTrackerAdapter({ fetch });

    await expect(
      adapter.getDailyContentBlindFootprint({
        fromUtcDate: "2026-06-21",
        toUtcDate: RANGE.toUtcDate,
        characterId: "chatgpt"
      })
    ).rejects.toMatchObject({ code: "invalid-range" });
    await expect(
      adapter.getDailyContentBlindFootprint({
        ...RANGE,
        characterId: "glm"
      } as never)
    ).rejects.toMatchObject({ code: "invalid-range" });
    await expect(
      adapter.getDailyContentBlindFootprint({
        ...RANGE,
        characterId: "grok",
        extra: true
      } as never)
    ).rejects.toMatchObject({ code: "invalid-range" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("personal route and accounting fail-closed contract", () => {
  it.each([
    ["daily scope echo", { scope: "all" }],
    ["daily unknown field", { raw_prompt: "forbidden" }],
    ["unknown excluded account source", {
      excluded_sources: [
        {
          source: "future-account",
          source_scope: "account",
          reason: "account_level_source"
        }
      ]
    }],
    ["malformed exclusion reason", {
      excluded_sources: [
        {
          source: "cursor",
          source_scope: "account",
          reason: "different"
        }
      ]
    }]
  ])("rejects %s drift", async (_label, overrides) => {
    const adapter = createTokenTrackerAdapter({
      fetch: fixtureFetch(dailyBody([], overrides), new Map())
    });
    await expect(
      adapter.getDailyContentBlindFootprint({ ...RANGE, characterId: "gemini" })
    ).rejects.toMatchObject({ code: "incompatible-schema" });
  });

  it("rejects account-scoped rows even when the response claims personal scope", async () => {
    const date = RANGE.toUtcDate;
    const accountSource = source(
      "cursor",
      [model("cursor-private", { input: 10 })],
      { source_scope: "account" }
    );
    const adapter = createTokenTrackerAdapter({
      fetch: fixtureFetch(
        dailyBody([dailyRow(date, [accountSource])]),
        new Map([[date, breakdownBody(date, [accountSource])]])
      )
    });

    await expect(
      adapter.getDailyContentBlindFootprint({ ...RANGE, characterId: "gemini" })
    ).rejects.toMatchObject({ code: "incompatible-schema" });
  });

  it.each([
    ["model-breakdown scope echo", { scope: "all" }],
    ["model-breakdown unknown field", { prompt: "forbidden" }],
    [
      "model-breakdown exclusion drift",
      {
        excluded_sources: [
          {
            source: "future-account",
            source_scope: "account",
            reason: "account_level_source"
          }
        ]
      }
    ]
  ])("rejects %s", async (_label, overrides) => {
    const fixture = activeFixture();
    const original = fixture.breakdowns.get(RANGE.toUtcDate) as ReturnType<
      typeof breakdownBody
    >;
    fixture.breakdowns.set(RANGE.toUtcDate, { ...original, ...overrides });
    const adapter = createTokenTrackerAdapter({
      fetch: fixtureFetch(fixture.daily, fixture.breakdowns)
    });

    await expect(
      adapter.getDailyContentBlindFootprint({ ...RANGE, characterId: "claude" })
    ).rejects.toMatchObject({ code: "incompatible-schema" });
  });

  it.each([
    ["zero total with nonzero components", (fixture: ReturnType<typeof activeFixture>) => {
      const rows = (fixture.daily as ReturnType<typeof dailyBody>).data;
      fixture.daily = dailyBody([
        rows[0]!,
        { ...rows[1]!, total_tokens: 0 }
      ]);
    }],
    ["daily component conservation", (fixture: ReturnType<typeof activeFixture>) => {
      const rows = (fixture.daily as ReturnType<typeof dailyBody>).data;
      fixture.daily = dailyBody([
        rows[0]!,
        { ...rows[1]!, total_tokens: Number(rows[1]!.total_tokens) + 1 }
      ]);
    }],
    ["daily reasoning subset", (fixture: ReturnType<typeof activeFixture>) => {
      const rows = (fixture.daily as ReturnType<typeof dailyBody>).data;
      fixture.daily = dailyBody([
        rows[0]!,
        { ...rows[1]!, reasoning_output_tokens: 999 }
      ]);
    }],
    ["source component conservation", (fixture: ReturnType<typeof activeFixture>) => {
      const body = fixture.breakdowns.get(RANGE.toUtcDate) as ReturnType<
        typeof breakdownBody
      >;
      const sources = [...body.sources];
      sources[0] = {
        ...sources[0]!,
        totals: { ...sources[0]!.totals, total_tokens: 999 }
      };
      fixture.breakdowns.set(RANGE.toUtcDate, breakdownBody(RANGE.toUtcDate, sources));
    }],
    ["model component conservation", (fixture: ReturnType<typeof activeFixture>) => {
      const body = fixture.breakdowns.get(RANGE.toUtcDate) as ReturnType<
        typeof breakdownBody
      >;
      const sources = [...body.sources];
      const models = [...sources[0]!.models];
      models[0] = {
        ...models[0]!,
        totals: { ...models[0]!.totals, total_tokens: 999 }
      };
      sources[0] = { ...sources[0]!, models };
      fixture.breakdowns.set(RANGE.toUtcDate, breakdownBody(RANGE.toUtcDate, sources));
    }],
    ["model-to-source reconciliation", (fixture: ReturnType<typeof activeFixture>) => {
      const body = fixture.breakdowns.get(RANGE.toUtcDate) as ReturnType<
        typeof breakdownBody
      >;
      const sources = [...body.sources];
      sources[0] = {
        ...sources[0]!,
        totals: {
          ...sources[0]!.totals,
          billable_total_tokens: Number(sources[0]!.totals.billable_total_tokens) + 1
        }
      };
      fixture.breakdowns.set(RANGE.toUtcDate, breakdownBody(RANGE.toUtcDate, sources));
    }],
    ["source-to-daily reconciliation", (fixture: ReturnType<typeof activeFixture>) => {
      const rows = (fixture.daily as ReturnType<typeof dailyBody>).data;
      fixture.daily = dailyBody([
        rows[0]!,
        {
          ...rows[1]!,
          input_tokens: Number(rows[1]!.input_tokens) + 1,
          total_tokens: Number(rows[1]!.total_tokens) + 1
        }
      ]);
    }],
    ["daily model reconciliation", (fixture: ReturnType<typeof activeFixture>) => {
      const rows = (fixture.daily as ReturnType<typeof dailyBody>).data;
      fixture.daily = dailyBody([
        rows[0]!,
        { ...rows[1]!, models: { ...rows[1]!.models, unexpected: 1 } }
      ]);
    }],
    ["empty active-day breakdown", (fixture: ReturnType<typeof activeFixture>) => {
      fixture.breakdowns.set(
        RANGE.toUtcDate,
        breakdownBody(RANGE.toUtcDate, [])
      );
    }]
  ])("rejects %s mismatch for the whole footprint", async (_label, mutate) => {
    const fixture = activeFixture();
    mutate(fixture);
    const adapter = createTokenTrackerAdapter({
      fetch: fixtureFetch(fixture.daily, fixture.breakdowns)
    });

    await expect(
      adapter.getDailyContentBlindFootprint({ ...RANGE, characterId: "grok" })
    ).rejects.toMatchObject({ code: "incompatible-schema" });
  });

  it("rejects duplicate raw source and per-source model rows", async () => {
    const date = RANGE.toUtcDate;
    const shared = source("codex", [model("one", { input: 10 })]);
    const duplicateSources = [shared, shared];
    const sourceAdapter = createTokenTrackerAdapter({
      fetch: fixtureFetch(
        dailyBody([dailyRow(date, duplicateSources)]),
        new Map([[date, breakdownBody(date, duplicateSources)]])
      )
    });
    await expect(
      sourceAdapter.getDailyContentBlindFootprint({
        ...RANGE,
        characterId: "chatgpt"
      })
    ).rejects.toMatchObject({ code: "incompatible-schema" });

    const duplicateModels = source("codex", [
      model("same", { input: 5 }),
      model("same", { input: 5 })
    ]);
    const modelAdapter = createTokenTrackerAdapter({
      fetch: fixtureFetch(
        dailyBody([dailyRow(date, [duplicateModels])]),
        new Map([[date, breakdownBody(date, [duplicateModels])]])
      )
    });
    await expect(
      modelAdapter.getDailyContentBlindFootprint({
        ...RANGE,
        characterId: "chatgpt"
      })
    ).rejects.toMatchObject({ code: "incompatible-schema" });
  });
});
