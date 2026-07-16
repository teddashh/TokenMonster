import { describe, expect, it, vi } from "vitest";

import {
  MAX_TOKEN_TRACKER_RESPONSE_BYTES,
  SUPPORTED_TOKEN_TRACKER_VERSION,
  TOKEN_TRACKER_PROVIDER_SOURCE_MAP,
  TOKEN_TRACKER_USAGE_MODEL_BREAKDOWN_PATH,
  TokenTrackerAdapterError,
  createTokenTrackerAdapter,
  normalizeTokenTrackerBaseUrl,
  type TokenTrackerFetch,
  type TokenTrackerFetchRequestInit,
  type TokenTrackerFetchResponse
} from "../src/index.js";

const PRIVATE_MODEL_CANARY = "MODEL_CANARY_must_not_leave_adapter";

function tokenFields(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    total_tokens: 180,
    billable_total_tokens: 180,
    input_tokens: 100,
    output_tokens: 50,
    cached_input_tokens: 20,
    cache_creation_input_tokens: 10,
    reasoning_output_tokens: 5,
    conversation_count: 3,
    ...overrides
  };
}

function summaryBody(
  from = "2026-07-01",
  to = "2026-07-02",
  overrides: Readonly<Record<string, unknown>> = {}
) {
  return {
    from,
    to,
    days: 2,
    scope: "all",
    excluded_sources: [],
    totals: {
      ...tokenFields(),
      total_cost_usd: "1.234567"
    },
    rolling: {
      last_7d: {
        from: "2026-06-26",
        to: "2026-07-02",
        active_days: 2,
        totals: {
          billable_total_tokens: 180,
          conversation_count: 3
        }
      },
      last_30d: {
        from: "2026-06-03",
        to: "2026-07-02",
        active_days: 2,
        totals: {
          billable_total_tokens: 180,
          conversation_count: 3
        },
        avg_per_active_day: 90
      }
    },
    ...overrides
  };
}

function dailyBody(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    from: "2026-07-01",
    to: "2026-07-02",
    scope: "all",
    excluded_sources: [],
    data: [
      {
        day: "2026-07-01",
        ...tokenFields(),
        total_cost_usd: 1.234567,
        models: { [PRIVATE_MODEL_CANARY]: 180 }
      },
      {
        day: "2026-07-02",
        ...tokenFields({
          total_tokens: 90,
          billable_total_tokens: 90,
          input_tokens: 50,
          output_tokens: 25,
          cached_input_tokens: 10,
          cache_creation_input_tokens: 5,
          reasoning_output_tokens: 2,
          conversation_count: 1
        }),
        total_cost_usd: 0.5,
        models: { "another-model": 90 }
      }
    ],
    ...overrides
  };
}

function modelBreakdownTotals(
  totalTokens: number,
  overrides: Readonly<Record<string, unknown>> = {}
) {
  return {
    total_tokens: totalTokens,
    billable_total_tokens: totalTokens,
    input_tokens: totalTokens,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_cost_usd: "0.000000",
    ...overrides
  };
}

function modelBreakdownSource(
  source: string,
  totalTokens: number,
  overrides: Readonly<Record<string, unknown>> = {}
) {
  const model = `${source}-model`;
  return {
    source,
    source_scope: source === "cursor" ? "account" : "local",
    totals: modelBreakdownTotals(totalTokens),
    models: [
      {
        model,
        model_id: model,
        totals: modelBreakdownTotals(totalTokens)
      }
    ],
    ...overrides
  };
}

function modelBreakdownBody(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    from: "2026-07-01",
    to: "2026-07-02",
    days: 0,
    scope: "all",
    excluded_sources: [],
    sources: [
      modelBreakdownSource("codex", 111),
      modelBreakdownSource("claude", 222),
      modelBreakdownSource("gemini", 333),
      modelBreakdownSource("grok", 444)
    ],
    pricing: {
      model: "per-model",
      pricing_mode: "per_token_type",
      source: "litellm",
      effective_from: "2026-07-15"
    },
    ...overrides
  };
}

function jsonResponse(body: unknown, status = 200): TokenTrackerFetchResponse {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  }) as unknown as TokenTrackerFetchResponse;
}

function injectedFetch(body: unknown): TokenTrackerFetch {
  return vi.fn<TokenTrackerFetch>(async () => jsonResponse(body));
}

describe("loopback-only configuration", () => {
  it.each([
    ["http://127.0.0.1:7680", "http://127.0.0.1:7680"],
    ["http://127.0.0.1:7681/", "http://127.0.0.1:7681"],
    ["http://127.0.0.1:65535", "http://127.0.0.1:65535"]
  ])("accepts canonical IPv4 loopback URL %s", (input, expected) => {
    expect(normalizeTokenTrackerBaseUrl(input)).toBe(expected);
  });

  it.each([
    "https://127.0.0.1:7680",
    "http://localhost:7680",
    "http://[::1]:7680",
    "http://0.0.0.0:7680",
    "http://192.168.1.2:7680",
    "http://2130706433:7680",
    "http://127.0.0.1",
    "http://127.0.0.1:07680",
    "http://user@127.0.0.1:7680",
    "http://127.0.0.1:7680/dashboard",
    "http://127.0.0.1:7680?port=1",
    " http://127.0.0.1:7680"
  ])("rejects non-canonical or non-loopback URL %s", (input) => {
    expect(() => normalizeTokenTrackerBaseUrl(input)).toThrowError(
      expect.objectContaining({ code: "invalid-configuration" })
    );
  });
});

describe("fixed local HTTP boundary", () => {
  it("uses only the audited summary route and fixed request policy", async () => {
    let endpoint: string | undefined;
    let init: TokenTrackerFetchRequestInit | undefined;
    const fetchImpl: TokenTrackerFetch = async (capturedEndpoint, capturedInit) => {
      endpoint = capturedEndpoint;
      init = capturedInit;
      return jsonResponse(summaryBody());
    };

    await createTokenTrackerAdapter({
      baseUrl: "http://127.0.0.1:8123",
      fetch: fetchImpl
    }).getSummary({
      fromUtcDate: "2026-07-01",
      toUtcDate: "2026-07-02"
    });

    expect(endpoint).toBe(
      "http://127.0.0.1:8123/functions/tokentracker-usage-summary" +
        "?from=2026-07-01&to=2026-07-02&scope=all&tz=UTC"
    );
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    expect(init?.signal.aborted).toBe(false);
    expect(Object.isFrozen(init)).toBe(true);
    expect(Object.isFrozen(init?.headers)).toBe(true);
  });

  it("uses the fixed audited model-breakdown route for provider totals", async () => {
    let endpoint: string | undefined;
    let init: TokenTrackerFetchRequestInit | undefined;
    const fetchImpl: TokenTrackerFetch = async (capturedEndpoint, capturedInit) => {
      endpoint = capturedEndpoint;
      init = capturedInit;
      return jsonResponse(modelBreakdownBody());
    };

    await createTokenTrackerAdapter({
      baseUrl: "http://127.0.0.1:8123",
      fetch: fetchImpl
    }).getProviderTotals({
      fromUtcDate: "2026-07-01",
      toUtcDate: "2026-07-02"
    });

    expect(TOKEN_TRACKER_USAGE_MODEL_BREAKDOWN_PATH).toBe(
      "/functions/tokentracker-usage-model-breakdown"
    );
    expect(endpoint).toBe(
      "http://127.0.0.1:8123/functions/tokentracker-usage-model-breakdown" +
        "?from=2026-07-01&to=2026-07-02&scope=all&tz=UTC"
    );
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    expect(Object.isFrozen(init)).toBe(true);
    expect(Object.isFrozen(init?.headers)).toBe(true);
  });

  it("probes schema compatibility without claiming the running version", async () => {
    let endpoint = "";
    const fetchImpl: TokenTrackerFetch = async (url) => {
      endpoint = url;
      return jsonResponse(summaryBody("1970-01-01", "1970-01-01", { days: 0 }));
    };

    const result = await createTokenTrackerAdapter({ fetch: fetchImpl }).probe();

    expect(result).toEqual({
      reachable: true,
      schemaCompatible: true,
      compatibilityTarget: SUPPORTED_TOKEN_TRACKER_VERSION
    });
    expect(result).not.toHaveProperty("installedVersion");
    expect(endpoint).toContain("from=1970-01-01&to=1970-01-01");
  });

  it("rejects invalid or oversized date ranges before fetch", async () => {
    const fetchImpl = vi.fn<TokenTrackerFetch>(async () =>
      jsonResponse(summaryBody())
    );
    const adapter = createTokenTrackerAdapter({ fetch: fetchImpl });

    await expect(
      adapter.getSummary({
        fromUtcDate: "2026-02-30",
        toUtcDate: "2026-03-01"
      })
    ).rejects.toMatchObject({ code: "invalid-range" });
    await expect(
      adapter.getDaily({
        fromUtcDate: "2026-07-02",
        toUtcDate: "2026-07-01"
      })
    ).rejects.toMatchObject({ code: "invalid-range" });
    await expect(
      adapter.getDaily({
        fromUtcDate: "2025-01-01",
        toUtcDate: "2026-07-01"
      })
    ).rejects.toMatchObject({ code: "invalid-range" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("content-blind TokenMonster projection", () => {
  it("returns only the TokenMonster summary DTO", async () => {
    const result = await createTokenTrackerAdapter({
      fetch: injectedFetch(summaryBody())
    }).getSummary({
      fromUtcDate: "2026-07-01",
      toUtcDate: "2026-07-02"
    });

    expect(result).toEqual({
      fromUtcDate: "2026-07-01",
      toUtcDate: "2026-07-02",
      activeDays: 2,
      tokens: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 20,
        cacheCreationInputTokens: 10,
        reasoningOutputTokens: 5,
        totalTokens: 180
      }
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tokens)).toBe(true);
    expect(result).not.toHaveProperty("rolling");
    expect(result).not.toHaveProperty("cost");
    expect(result).not.toHaveProperty("conversationCount");
  });

  it("drops upstream model names, costs, and conversation counts from daily DTOs", async () => {
    const result = await createTokenTrackerAdapter({
      fetch: injectedFetch(dailyBody())
    }).getDaily({
      fromUtcDate: "2026-07-01",
      toUtcDate: "2026-07-02"
    });

    expect(result.days).toHaveLength(2);
    expect(result.days[0]).toEqual({
      utcDate: "2026-07-01",
      tokens: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 20,
        cacheCreationInputTokens: 10,
        reasoningOutputTokens: 5,
        totalTokens: 180
      }
    });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_MODEL_CANARY);
    expect(JSON.stringify(result)).not.toContain("total_cost_usd");
    expect(JSON.stringify(result)).not.toContain("conversation_count");
    expect(Object.isFrozen(result.days)).toBe(true);
    expect(Object.isFrozen(result.days[0])).toBe(true);
    expect(Object.isFrozen(result.days[0]?.tokens)).toBe(true);
  });

  it("maps only the four audited source IDs to safe provider totals", async () => {
    const response = modelBreakdownBody();
    const sources = response.sources.map((source) => ({
      ...source,
      models: source.models.map((model) => ({
        ...model,
        model: PRIVATE_MODEL_CANARY,
        model_id: PRIVATE_MODEL_CANARY,
        totals: {
          ...model.totals,
          total_cost_usd: "9.999999"
        }
      }))
    }));
    const result = await createTokenTrackerAdapter({
      fetch: injectedFetch(modelBreakdownBody({ sources }))
    }).getProviderTotals({
      fromUtcDate: "2026-07-01",
      toUtcDate: "2026-07-02"
    });

    expect(TOKEN_TRACKER_PROVIDER_SOURCE_MAP).toEqual({
      codex: "openai",
      claude: "anthropic",
      gemini: "google",
      grok: "xai"
    });
    expect(result).toEqual({
      openai: 111,
      anthropic: 222,
      google: 333,
      xai: 444
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_MODEL_CANARY);
    expect(JSON.stringify(result)).not.toContain("total_cost_usd");
    expect(Object.keys(result)).toEqual(["openai", "anthropic", "google", "xai"]);
  });

  it("ignores other bounded sources and never infers a provider from model names", async () => {
    const impersonatingModel = {
      model: "codex",
      model_id: "codex",
      totals: modelBreakdownTotals(9_999)
    };
    const sources = [
      modelBreakdownSource("future-tool", 9_999, {
        models: [impersonatingModel]
      }),
      modelBreakdownSource("future-tool", 8_888, {
        models: [impersonatingModel]
      }),
      modelBreakdownSource("Codex", 7_777, {
        models: [impersonatingModel]
      }),
      modelBreakdownSource("codex", 10)
    ];

    await expect(
      createTokenTrackerAdapter({
        fetch: injectedFetch(modelBreakdownBody({ sources }))
      }).getProviderTotals({
        fromUtcDate: "2026-07-01",
        toUtcDate: "2026-07-02"
      })
    ).resolves.toEqual({
      openai: 10,
      anthropic: 0,
      google: 0,
      xai: 0
    });
  });
});

describe("strict and bounded upstream responses", () => {
  it("rejects schema drift and echoed range mismatches", async () => {
    const withUnknownField = createTokenTrackerAdapter({
      fetch: injectedFetch(summaryBody("2026-07-01", "2026-07-02", { prompt: "private" }))
    });
    await expect(
      withUnknownField.getSummary({
        fromUtcDate: "2026-07-01",
        toUtcDate: "2026-07-02"
      })
    ).rejects.toMatchObject({ code: "incompatible-schema" });

    const wrongRange = createTokenTrackerAdapter({
      fetch: injectedFetch(summaryBody("2026-06-01", "2026-06-02"))
    });
    await expect(
      wrongRange.getSummary({
        fromUtcDate: "2026-07-01",
        toUtcDate: "2026-07-02"
      })
    ).rejects.toMatchObject({ code: "incompatible-schema" });
  });

  it("rejects duplicate or out-of-order daily buckets", async () => {
    const rows = dailyBody().data;
    const adapter = createTokenTrackerAdapter({
      fetch: injectedFetch(dailyBody({ data: [rows[1], rows[0]] }))
    });

    await expect(
      adapter.getDaily({
        fromUtcDate: "2026-07-01",
        toUtcDate: "2026-07-02"
      })
    ).rejects.toMatchObject({ code: "incompatible-schema" });
  });

  it("rejects duplicate mapped source entries", async () => {
    const adapter = createTokenTrackerAdapter({
      fetch: injectedFetch(
        modelBreakdownBody({
          sources: [
            modelBreakdownSource("codex", 10),
            modelBreakdownSource("codex", 20)
          ]
        })
      )
    });

    await expect(
      adapter.getProviderTotals({
        fromUtcDate: "2026-07-01",
        toUtcDate: "2026-07-02"
      })
    ).rejects.toMatchObject({ code: "incompatible-schema" });
  });

  it.each([
    modelBreakdownSource("", 1),
    modelBreakdownSource("   ", 1),
    modelBreakdownSource("x".repeat(129), 1),
    modelBreakdownSource("codex", Number.MAX_SAFE_INTEGER + 1),
    modelBreakdownSource("codex", 1, { prompt: "must-not-enter-adapter" }),
    modelBreakdownSource("codex", 1, {
      models: [
        {
          model: "one-model",
          model_id: "different-model",
          totals: modelBreakdownTotals(1)
        }
      ]
    }),
    modelBreakdownSource("codex", 1, { source_scope: "account" })
  ])("rejects malformed model-breakdown source data", async (source) => {
    const adapter = createTokenTrackerAdapter({
      fetch: injectedFetch(modelBreakdownBody({ sources: [source] }))
    });

    await expect(
      adapter.getProviderTotals({
        fromUtcDate: "2026-07-01",
        toUtcDate: "2026-07-02"
      })
    ).rejects.toMatchObject({ code: "incompatible-schema" });
  });

  it("rejects model-breakdown schema drift and echoed range mismatches", async () => {
    const wrongDays = createTokenTrackerAdapter({
      fetch: injectedFetch(modelBreakdownBody({ days: 2 }))
    });
    await expect(
      wrongDays.getProviderTotals({
        fromUtcDate: "2026-07-01",
        toUtcDate: "2026-07-02"
      })
    ).rejects.toMatchObject({ code: "incompatible-schema" });

    const wrongRange = createTokenTrackerAdapter({
      fetch: injectedFetch(modelBreakdownBody({ from: "2026-06-01" }))
    });
    await expect(
      wrongRange.getProviderTotals({
        fromUtcDate: "2026-07-01",
        toUtcDate: "2026-07-02"
      })
    ).rejects.toMatchObject({ code: "incompatible-schema" });
  });

  it("rejects oversized bodies before parsing", async () => {
    const response = new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_TOKEN_TRACKER_RESPONSE_BYTES + 1)
      }
    }) as unknown as TokenTrackerFetchResponse;
    const adapter = createTokenTrackerAdapter({
      fetch: async () => response
    });

    await expect(
      adapter.getSummary({
        fromUtcDate: "2026-07-01",
        toUtcDate: "2026-07-02"
      })
    ).rejects.toMatchObject({ code: "response-too-large" });
  });

  it("times out an injected fetch that never resolves", async () => {
    const adapter = createTokenTrackerAdapter({
      timeoutMs: 1,
      fetch: async () => new Promise<TokenTrackerFetchResponse>(() => undefined)
    });

    await expect(
      adapter.getSummary({
        fromUtcDate: "2026-07-01",
        toUtcDate: "2026-07-02"
      })
    ).rejects.toMatchObject({ code: "request-timeout" });
  });

  it("keeps errors sanitized", () => {
    const error = new TokenTrackerAdapterError("incompatible-schema");
    expect(JSON.stringify(error)).toBe(
      '{"name":"TokenTrackerAdapterError","code":"incompatible-schema",' +
        '"message":"The local TokenTracker response is not compatible with the supported schema."}'
    );
  });
});
