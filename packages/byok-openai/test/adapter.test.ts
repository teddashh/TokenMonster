import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import {
  ByokOpenAiError,
  DEFAULT_OPENAI_MAX_OUTPUT_TOKENS,
  MAX_OPENAI_INPUT_BYTES,
  MAX_OPENAI_INSTRUCTIONS_BYTES,
  MAX_OPENAI_MAX_OUTPUT_TOKENS,
  MAX_OPENAI_RESPONSE_BYTES,
  OPENAI_RESPONSES_ENDPOINT,
  createOpenAiByokAdapter,
  type ByokOpenAiErrorCode,
  type OpenAiByokRequest,
  type OpenAiFetch,
  type OpenAiFetchRequestInit,
  type OpenAiFetchResponse
} from "../src/index.js";

const API_KEY_CANARY = ["sk", "test_1234567890abcdef_KEY_CANARY"].join("-");
const PROMPT_CANARY = "PROMPT_CANARY_97f36e";
const PROVIDER_CANARY = "PROVIDER_BODY_CANARY_d1af5c";

function request(
  overrides: Partial<OpenAiByokRequest> = {}
): OpenAiByokRequest {
  return {
    apiKey: API_KEY_CANARY,
    instructions: "You are a concise local companion.",
    input: PROMPT_CANARY,
    ...overrides
  };
}

function completedBody(text = "Hello from Luna") {
  return {
    id: "resp_local_test",
    status: "completed",
    output: [
      {
        id: "msg_local_test",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text,
            annotations: []
          }
        ]
      }
    ]
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Readonly<Record<string, string>> = {}
): OpenAiFetchResponse {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

function serializationOf(error: unknown): string {
  if (error instanceof Error) {
    return [
      String(error),
      error.message,
      error.stack ?? "",
      JSON.stringify(error)
    ].join("\n");
  }
  return JSON.stringify(error);
}

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    throw new Error("Expected operation to reject.");
  } catch (error) {
    return error;
  }
}

describe("fixed OpenAI Responses request policy", () => {
  it("sends the exact fixed endpoint, headers, and data-minimized body", async () => {
    let capturedEndpoint: string | undefined;
    let capturedInit: OpenAiFetchRequestInit | undefined;
    const fetchImpl: OpenAiFetch = async (endpoint, init) => {
      capturedEndpoint = endpoint;
      capturedInit = init;
      return jsonResponse(completedBody());
    };

    const result = await createOpenAiByokAdapter({ fetch: fetchImpl }).respond(
      request()
    );

    expect(result).toEqual({ text: "Hello from Luna" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(capturedEndpoint).toBe(OPENAI_RESPONSES_ENDPOINT);
    expect(capturedInit).toBeDefined();
    expect(Reflect.ownKeys(capturedInit!)).toEqual([
      "method",
      "redirect",
      "headers",
      "body",
      "signal"
    ]);
    expect(capturedInit!.method).toBe("POST");
    expect(capturedInit!.redirect).toBe("error");
    expect(capturedInit!.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer " + API_KEY_CANARY,
      "Content-Type": "application/json"
    });
    expect(Object.isFrozen(capturedInit!.headers)).toBe(true);
    expect(JSON.parse(capturedInit!.body)).toEqual({
      model: "gpt-5.6-luna",
      instructions: "You are a concise local companion.",
      input: PROMPT_CANARY,
      max_output_tokens: DEFAULT_OPENAI_MAX_OUTPUT_TOKENS,
      background: false,
      store: false
    });
    expect(capturedInit!.body).not.toContain(API_KEY_CANARY);
    for (const forbidden of [
      "conversation",
      "previous_response_id",
      "tools",
      "files",
      "metadata",
      "safety_identifier",
      "prompt_cache_key"
    ]) {
      expect(capturedInit!.body).not.toContain(forbidden);
    }
  });

  it("forbids native fetch redirects so prompts cannot cross origins", async () => {
    const originalFetch = globalThis.fetch;
    let capturedRedirect: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_endpoint: string | URL | Request, init?: RequestInit) => {
        capturedRedirect = init?.redirect;
        return jsonResponse(completedBody()) as Response;
      })
    );
    try {
      await expect(createOpenAiByokAdapter().respond(request())).resolves.toEqual({
        text: "Hello from Luna"
      });
      expect(capturedRedirect).toBe("error");
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("allows only the compile-time model and bounded output token count", async () => {
    let parsedBody: Record<string, unknown> | undefined;
    const fetchImpl: OpenAiFetch = async (_endpoint, init) => {
      parsedBody = JSON.parse(init.body) as Record<string, unknown>;
      return jsonResponse(completedBody());
    };
    const adapter = createOpenAiByokAdapter({ fetch: fetchImpl });

    await adapter.respond(
      request({
        model: "gpt-5.6-luna",
        maxOutputTokens: MAX_OPENAI_MAX_OUTPUT_TOKENS
      })
    );
    expect(parsedBody?.["model"]).toBe("gpt-5.6-luna");
    expect(parsedBody?.["max_output_tokens"]).toBe(
      MAX_OPENAI_MAX_OUTPUT_TOKENS
    );

    await expect(
      adapter.respond(request({ model: "gpt-5.6-terra" as never }))
    ).rejects.toMatchObject({ code: "invalid-request" });
    await expect(
      adapter.respond(request({ maxOutputTokens: 0 }))
    ).rejects.toMatchObject({ code: "invalid-request" });
    await expect(
      adapter.respond({
        ...request(),
        maxOutputTokens: MAX_OPENAI_MAX_OUTPUT_TOKENS + 1
      })
    ).rejects.toMatchObject({ code: "invalid-request" });
  });

  it.each([
    "",
    "sk-short",
    " " + API_KEY_CANARY,
    API_KEY_CANARY + " secret",
    "Bearer " + API_KEY_CANARY
  ])("rejects an invalid API key shape without invoking fetch: %j", async (key) => {
    const fetchImpl = vi.fn<OpenAiFetch>(async () =>
      jsonResponse(completedBody())
    );
    const error = await captureError(
      createOpenAiByokAdapter({ fetch: fetchImpl }).respond(
        request({ apiKey: key })
      )
    );

    expect(error).toMatchObject({ code: "invalid-api-key" });
    if (key.length > 0) {
      expect(serializationOf(error)).not.toContain(key);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("enforces UTF-8 byte limits before fetch", async () => {
    const fetchImpl = vi.fn<OpenAiFetch>(async () =>
      jsonResponse(completedBody())
    );
    const adapter = createOpenAiByokAdapter({ fetch: fetchImpl });

    await expect(
      adapter.respond(
        request({ instructions: "a".repeat(MAX_OPENAI_INSTRUCTIONS_BYTES + 1) })
      )
    ).rejects.toMatchObject({ code: "invalid-request" });
    await expect(
      adapter.respond(
        request({ input: "界".repeat(Math.floor(MAX_OPENAI_INPUT_BYTES / 3) + 1) })
      )
    ).rejects.toMatchObject({ code: "invalid-request" });
    await expect(
      adapter.respond(request({ input: " \n\t " }))
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unknown request fields and accessor-backed secrets", async () => {
    const fetchImpl = vi.fn<OpenAiFetch>(async () =>
      jsonResponse(completedBody())
    );
    const adapter = createOpenAiByokAdapter({ fetch: fetchImpl });
    await expect(
      adapter.respond({ ...request(), tools: [{ type: "web_search" }] } as never)
    ).rejects.toMatchObject({ code: "invalid-request" });

    const accessorRequest = {
      instructions: "safe instructions",
      input: PROMPT_CANARY
    } as Record<string, unknown>;
    Object.defineProperty(accessorRequest, "apiKey", {
      enumerable: true,
      get() {
        throw new Error(API_KEY_CANARY);
      }
    });
    const error = await captureError(adapter.respond(accessorRequest as never));
    expect(error).toMatchObject({ code: "invalid-request" });
    expect(serializationOf(error)).not.toContain(API_KEY_CANARY);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not expose a base URL, arbitrary headers, or unsafe timeout", () => {
    expect(() =>
      createOpenAiByokAdapter({
        baseUrl: "https://attacker.example",
        fetch: async () => jsonResponse(completedBody())
      } as never)
    ).toThrowError(
      expect.objectContaining<Partial<ByokOpenAiError>>({
        code: "invalid-configuration"
      })
    );
    expect(() =>
      createOpenAiByokAdapter({ timeoutMs: 0 })
    ).toThrowError(
      expect.objectContaining<Partial<ByokOpenAiError>>({
        code: "invalid-configuration"
      })
    );
  });
});

describe("timeout and sanitized transport failures", () => {
  it("aborts a hanging fetch at the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      const fetchImpl: OpenAiFetch = (_endpoint, init) => {
        capturedSignal = init.signal;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(new Error(API_KEY_CANARY + PROMPT_CANARY)),
            { once: true }
          );
        });
      };
      const pending = createOpenAiByokAdapter({
        fetch: fetchImpl,
        timeoutMs: 25
      }).respond(request());
      const expected = expect(pending).rejects.toMatchObject({
        code: "request-timeout"
      });

      await vi.advanceTimersByTimeAsync(25);
      await expected;
      expect(capturedSignal?.aborted).toBe(true);

      const secondPending = captureError(
        createOpenAiByokAdapter({
          fetch: fetchImpl,
          timeoutMs: 25
        }).respond(request())
      );
      await vi.advanceTimersByTimeAsync(25);
      const error = await secondPending;
      expect(serializationOf(error)).not.toContain(API_KEY_CANARY);
      expect(serializationOf(error)).not.toContain(PROMPT_CANARY);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a hanging response stream even when cancellation never settles", async () => {
    vi.useFakeTimers();
    try {
      let cancelCalled = false;
      const response: OpenAiFetchResponse = {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        body: {
          getReader: () => ({
            read: () => new Promise(() => undefined),
            cancel: () => {
              cancelCalled = true;
              return new Promise(() => undefined);
            }
          })
        },
        text: async () => ""
      };
      const pending = createOpenAiByokAdapter({
        fetch: async () => response,
        timeoutMs: 25
      }).respond(request());
      const expected = expect(pending).rejects.toMatchObject({
        code: "request-timeout"
      });

      await vi.advanceTimersByTimeAsync(25);
      await expected;
      expect(cancelCalled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports caller cancellation without forwarding the caller signal or reason", async () => {
    const callerController = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const fetchImpl: OpenAiFetch = (_endpoint, init) => {
      providerSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new Error(API_KEY_CANARY + PROMPT_CANARY)),
          { once: true }
        );
      });
    };
    const errorPromise = captureError(
      createOpenAiByokAdapter({ fetch: fetchImpl }).respond(request(), {
        signal: callerController.signal
      })
    );

    callerController.abort(PROVIDER_CANARY);
    const error = await errorPromise;
    expect(error).toMatchObject({ code: "request-aborted" });
    expect(providerSignal).not.toBe(callerController.signal);
    expect(providerSignal?.aborted).toBe(true);
    const serialized = serializationOf(error);
    expect(serialized).not.toContain(API_KEY_CANARY);
    expect(serialized).not.toContain(PROMPT_CANARY);
    expect(serialized).not.toContain(PROVIDER_CANARY);
  });

  it("cancels a hanging body read without awaiting provider cancellation", async () => {
    const callerController = new AbortController();
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let cancelCalled = false;
    const response: OpenAiFetchResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        getReader: () => ({
          read: () => {
            markReadStarted?.();
            return new Promise(() => undefined);
          },
          cancel: () => {
            cancelCalled = true;
            return new Promise(() => undefined);
          }
        })
      },
      text: async () => ""
    };
    const errorPromise = captureError(
      createOpenAiByokAdapter({ fetch: async () => response }).respond(
        request(),
        { signal: callerController.signal }
      )
    );

    await readStarted;
    callerController.abort(PROVIDER_CANARY);
    const error = await errorPromise;
    expect(error).toMatchObject({ code: "request-aborted" });
    expect(cancelCalled).toBe(true);
    expect(serializationOf(error)).not.toContain(PROVIDER_CANARY);
  });

  it("fails before fetch for a pre-aborted or invalid caller signal", async () => {
    const fetchImpl = vi.fn<OpenAiFetch>(async () =>
      jsonResponse(completedBody())
    );
    const controller = new AbortController();
    controller.abort(PROVIDER_CANARY);
    await expect(
      createOpenAiByokAdapter({ fetch: fetchImpl }).respond(request(), {
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: "request-aborted" });
    await expect(
      createOpenAiByokAdapter({ fetch: fetchImpl }).respond(request(), {
        signal: "not-an-abort-signal"
      } as never)
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sanitizes hostile synchronous and asynchronous fetch failures", async () => {
    const failures: OpenAiFetch[] = [
      () => {
        throw new Error(API_KEY_CANARY + PROMPT_CANARY);
      },
      async () => {
        throw new Error(PROVIDER_CANARY + PROMPT_CANARY);
      }
    ];

    for (const fetchImpl of failures) {
      const error = await captureError(
        createOpenAiByokAdapter({ fetch: fetchImpl }).respond(request())
      );
      expect(error).toMatchObject({ code: "network-error" });
      const serialized = serializationOf(error);
      expect(serialized).not.toContain(API_KEY_CANARY);
      expect(serialized).not.toContain(PROMPT_CANARY);
      expect(serialized).not.toContain(PROVIDER_CANARY);
    }
  });

  it.each<[number, ByokOpenAiErrorCode]>([
    [400, "provider-request-rejected"],
    [401, "provider-authentication-failed"],
    [403, "provider-authentication-failed"],
    [408, "provider-unavailable"],
    [418, "provider-error"],
    [422, "provider-request-rejected"],
    [429, "provider-rate-limited"],
    [500, "provider-unavailable"],
    [503, "provider-unavailable"]
  ])("maps HTTP %i to stable code %s and cancels its body", async (status, code) => {
    const cancel = vi.fn(async () => undefined);
    const response: OpenAiFetchResponse = {
      ok: false,
      status,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => ({ done: true }),
          cancel
        })
      },
      async text() {
        throw new Error(PROVIDER_CANARY);
      }
    };
    const error = await captureError(
      createOpenAiByokAdapter({ fetch: async () => response }).respond(request())
    );

    expect(error).toMatchObject({ code });
    expect(cancel).toHaveBeenCalledOnce();
    const serialized = serializationOf(error);
    expect(serialized).not.toContain(API_KEY_CANARY);
    expect(serialized).not.toContain(PROMPT_CANARY);
    expect(serialized).not.toContain(PROVIDER_CANARY);
  });

  it("sanitizes a hostile body-stream failure", async () => {
    const response: OpenAiFetchResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        getReader: () => ({
          read: async () => {
            throw new Error(
              API_KEY_CANARY + PROMPT_CANARY + PROVIDER_CANARY
            );
          }
        })
      },
      text: async () => ""
    };
    const error = await captureError(
      createOpenAiByokAdapter({ fetch: async () => response }).respond(request())
    );

    expect(error).toMatchObject({ code: "network-error" });
    const serialized = serializationOf(error);
    expect(serialized).not.toContain(API_KEY_CANARY);
    expect(serialized).not.toContain(PROMPT_CANARY);
    expect(serialized).not.toContain(PROVIDER_CANARY);
  });

  it("sanitizes hostile response getters", async () => {
    const response = Object.defineProperty({}, "ok", {
      get() {
        throw new Error(API_KEY_CANARY + PROVIDER_CANARY);
      }
    }) as OpenAiFetchResponse;
    const error = await captureError(
      createOpenAiByokAdapter({ fetch: async () => response }).respond(request())
    );
    expect(error).toMatchObject({ code: "network-error" });
    expect(serializationOf(error)).not.toContain(API_KEY_CANARY);
    expect(serializationOf(error)).not.toContain(PROVIDER_CANARY);
  });
});

describe("bounded strict response projection", () => {
  it("rejects a declared response over the cap before reading the body", async () => {
    const cancel = vi.fn(async () => undefined);
    const response: OpenAiFetchResponse = {
      ok: true,
      status: 200,
      headers: new Headers({
        "content-length": String(MAX_OPENAI_RESPONSE_BYTES + 1),
        "content-type": "application/json"
      }),
      body: {
        getReader: () => ({
          read: async () => ({ done: true }),
          cancel
        })
      },
      async text() {
        return JSON.stringify(completedBody());
      }
    };

    await expect(
      createOpenAiByokAdapter({ fetch: async () => response }).respond(request())
    ).rejects.toMatchObject({ code: "response-too-large" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("caps actual streamed bytes before parsing JSON", async () => {
    const response = new Response("x".repeat(MAX_OPENAI_RESPONSE_BYTES + 1), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    await expect(
      createOpenAiByokAdapter({ fetch: async () => response }).respond(request())
    ).rejects.toMatchObject({ code: "response-too-large" });
  });

  it("rejects empty stream chunks and cancels the reader", async () => {
    const cancel = vi.fn(async () => undefined);
    const response: OpenAiFetchResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new Uint8Array() }),
          cancel
        })
      },
      text: async () => ""
    };
    await expect(
      createOpenAiByokAdapter({ fetch: async () => response }).respond(request())
    ).rejects.toMatchObject({ code: "malformed-response" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("enforces a monotonic deadline when immediate chunks starve timers", async () => {
    const cancel = vi.fn(async () => undefined);
    let reads = 0;
    const response: OpenAiFetchResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return { done: false, value: new Uint8Array([0x20]) };
          },
          cancel
        })
      },
      text: async () => ""
    };
    await expect(
      createOpenAiByokAdapter({
        fetch: async () => response,
        timeoutMs: 1
      }).respond(request())
    ).rejects.toMatchObject({ code: "request-timeout" });
    expect(reads).toBeLessThan(100_000);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ["not-json", "malformed-response"],
    [JSON.stringify(null), "malformed-response"],
    [JSON.stringify({ status: "completed" }), "malformed-response"],
    [JSON.stringify({ status: "completed", output: [] }), "empty-response"]
  ])("rejects a missing or malformed provider body", async (body, code) => {
    const fetchImpl: OpenAiFetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    await expect(
      createOpenAiByokAdapter({ fetch: fetchImpl }).respond(request())
    ).rejects.toMatchObject({ code });
  });

  it("requires a JSON content type", async () => {
    const fetchImpl: OpenAiFetch = async () =>
      new Response(JSON.stringify(completedBody()), {
        status: 200,
        headers: { "content-type": "text/plain" }
      });
    await expect(
      createOpenAiByokAdapter({ fetch: fetchImpl }).respond(request())
    ).rejects.toMatchObject({ code: "malformed-response" });
  });

  it("does not accept a media type that merely prefixes application/json", async () => {
    const fetchImpl: OpenAiFetch = async () =>
      new Response(JSON.stringify(completedBody()), {
        status: 200,
        headers: { "content-type": "application/jsonp" }
      });
    await expect(
      createOpenAiByokAdapter({ fetch: fetchImpl }).respond(request())
    ).rejects.toMatchObject({ code: "malformed-response" });
  });

  it("joins multiple completed assistant output_text parts in order", async () => {
    const body = {
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "Alpha" },
            { type: "output_text", text: "Beta" }
          ]
        },
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Gamma" }]
        }
      ]
    };
    await expect(
      createOpenAiByokAdapter({
        fetch: async () => jsonResponse(body)
      }).respond(request())
    ).resolves.toEqual({ text: "AlphaBetaGamma" });
  });

  it("ignores allowlisted reasoning items before assistant output", async () => {
    const body = {
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_local_test", summary: [] },
        ...completedBody().output
      ]
    };
    await expect(
      createOpenAiByokAdapter({
        fetch: async () => jsonResponse(body)
      }).respond(request())
    ).resolves.toEqual({ text: "Hello from Luna" });
  });

  it.each([
    [
      { status: "in_progress", output: [] },
      "incomplete-response"
    ],
    [
      {
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [{ type: "output_text", text: "partial" }]
          }
        ]
      },
      "incomplete-response"
    ],
    [
      {
        status: "completed",
        output: [{ type: "function_call", name: "exfiltrate", arguments: "{}" }]
      },
      "unsupported-response"
    ],
    [
      {
        status: "completed",
        output: [
          {
            type: "message",
            role: "user",
            status: "completed",
            content: [{ type: "output_text", text: "wrong role" }]
          }
        ]
      },
      "unsupported-response"
    ],
    [
      {
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "refusal", refusal: "no" }]
          }
        ]
      },
      "unsupported-response"
    ],
    [
      {
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: 123 }]
          }
        ]
      },
      "malformed-response"
    ]
  ])("rejects incomplete, tool, refusal, or malformed output", async (body, code) => {
    await expect(
      createOpenAiByokAdapter({
        fetch: async () => jsonResponse(body)
      }).respond(request())
    ).rejects.toMatchObject({ code });
  });

  it("never serializes key, prompt, or hostile provider body canaries", async () => {
    const hostileBody = {
      status: "completed",
      output: [
        {
          type: "function_call",
          arguments:
            API_KEY_CANARY + PROMPT_CANARY + PROVIDER_CANARY
        }
      ]
    };
    const error = await captureError(
      createOpenAiByokAdapter({
        fetch: async () => jsonResponse(hostileBody)
      }).respond(request())
    );

    expect(error).toMatchObject({ code: "unsupported-response" });
    const serialized = serializationOf(error);
    expect(serialized).not.toContain(API_KEY_CANARY);
    expect(serialized).not.toContain(PROMPT_CANARY);
    expect(serialized).not.toContain(PROVIDER_CANARY);
  });

  it("does not write secrets or provider bodies to console", async () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "debug").mockImplementation(() => undefined)
    ];
    try {
      await createOpenAiByokAdapter({
        fetch: async () => {
          throw new Error(
            API_KEY_CANARY + PROMPT_CANARY + PROVIDER_CANARY
          );
        }
      })
        .respond(request())
        .catch(() => undefined);
      expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });

  it("counts response bytes, not JavaScript characters", async () => {
    const bytes = Buffer.byteLength("界", "utf8");
    expect(bytes).toBe(3);
  });
});
