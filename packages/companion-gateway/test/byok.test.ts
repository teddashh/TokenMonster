import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import {
  request as httpRequest,
  type ClientRequest,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TokenTrackerAdapter } from "@tokenmonster/token-tracker-adapter";
import {
  createMemorySecretSlot,
  type EncryptedSecretSlot,
} from "@tokenmonster/secret-vault";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCompanionGateway,
  type CompanionCollectorController,
  type CompanionGateway,
  type CompanionGatewayAddress,
} from "../src/index.js";
import {
  BYOK_STORAGE_OPERATION_TIMEOUT_MS,
  createCompanionByokService,
} from "../src/byok-service.js";

const API_KEY_CANARY = ["sk", "gateway_1234567890abcdef_KEY_CANARY"].join("-");
const gateways: CompanionGateway[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await Promise.all(gateways.splice(0).map(async (gateway) => gateway.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { force: true, recursive: true })),
  );
});

function unusedAdapter(): TokenTrackerAdapter {
  const unavailable = async (): Promise<never> => {
    throw new Error("unused adapter call");
  };
  return Object.freeze({
    probe: unavailable,
    getSummary: unavailable,
    getDaily: unavailable,
    getProviderTotals: unavailable,
    getProgressionFamilyTotals: unavailable,
    getDailyFamilySeries: unavailable,
    getDailyContentBlindFootprint: unavailable,
    getModelUsage: unavailable,
  });
}

function readyCollector(): CompanionCollectorController {
  const status = Object.freeze({
    phase: "ready" as const,
    lastSuccessAt: "2026-07-18T12:00:00.000Z",
    consecutiveFailures: 0,
    canRetry: true,
  });
  return Object.freeze({
    getStatus: () => status,
    requestRefresh: async () => status,
  });
}

function osBackedSecretSlot(): EncryptedSecretSlot {
  let secret: string | null = null;
  let activePersistence: "os-backed" | "memory-only" = "memory-only";
  const snapshot = () =>
    Object.freeze({
      configured: secret !== null,
      persistence: "os-backed" as const,
      activePersistence,
      backend: "test-os-vault",
    });
  return Object.freeze({
    initialize: async () => snapshot(),
    set: async (
      value: string,
      options: Readonly<{ persist?: boolean; signal?: AbortSignal }> = {},
    ) => {
      if (options.signal?.aborted) throw new Error("aborted");
      secret = value;
      activePersistence =
        options.persist === false ? "memory-only" : "os-backed";
      return snapshot();
    },
    get: () => secret,
    clear: async () => {
      secret = null;
      activePersistence = "memory-only";
      return snapshot();
    },
    status: snapshot,
  });
}

async function startByokGateway(
  byok: EncryptedSecretSlot | null = null,
): Promise<Readonly<{ gateway: CompanionGateway; address: CompanionGatewayAddress }>> {
  const directory = await mkdtemp(join(tmpdir(), "tokenmonster-byok-gateway-"));
  temporaryDirectories.push(directory);
  const gateway = createCompanionGateway({
    adapter: unusedAdapter(),
    collector: readyCollector(),
    byok,
    assets: {
      html: "<!doctype html><title>TokenMonster</title>",
      css: "body{}",
      scripts: { "main.js": "export {};" },
    },
    characters: {
      manifest: {
        schemaVersion: "1",
        generatedAt: "2026-07-18T00:00:00.000Z",
        characters: [],
        voice: [],
      },
      cacheDirectory: join(directory, "assets"),
      cdnBaseUrl: null,
      progressionStorePath: join(directory, "progression-v1.json"),
    },
  });
  gateways.push(gateway);
  return Object.freeze({ gateway, address: await gateway.start(0) });
}

async function bootstrap(address: CompanionGatewayAddress): Promise<string> {
  const response = await fetch(address.bootstrapUrl, { redirect: "manual" });
  expect(response.status).toBe(303);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).not.toBeNull();
  return setCookie!.split(";", 1)[0]!;
}

function startRawRequest(
  address: CompanionGatewayAddress,
  input: Readonly<{
    path: string;
    method?: string;
    headers?: Readonly<Record<string, string>>;
    body?: string;
  }>,
): Readonly<{
  request: ClientRequest;
  response: Promise<
    Readonly<{
      status: number;
      headers: NodeJS.Dict<string | string[]>;
      body: string;
    }>
  >;
}> {
  let activeRequest: ClientRequest | undefined;
  const response = new Promise<
    Readonly<{
      status: number;
      headers: NodeJS.Dict<string | string[]>;
      body: string;
    }>
  >((resolve, reject) => {
    const body = input.body ?? "";
    const request = httpRequest(
      {
        hostname: address.host,
        port: address.port,
        path: input.path,
        method: input.method ?? "GET",
        headers: {
          ...input.headers,
          ...(input.body === undefined
            ? {}
            : { "Content-Length": String(Buffer.byteLength(body, "utf8")) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve(
            Object.freeze({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          ),
        );
      },
    );
    activeRequest = request;
    request.on("error", reject);
    request.end(body);
  });
  if (activeRequest === undefined) throw new Error("request did not start");
  return Object.freeze({ request: activeRequest, response });
}

function rawRequest(
  address: CompanionGatewayAddress,
  input: Readonly<{
    path: string;
    method?: string;
    headers?: Readonly<Record<string, string>>;
    body?: string;
  }>,
): Promise<Readonly<{ status: number; headers: NodeJS.Dict<string | string[]>; body: string }>> {
  return startRawRequest(address, input).response;
}

function sessionHeaders(
  address: CompanionGatewayAddress,
  cookie: string,
  contentType = false,
): Readonly<Record<string, string>> {
  return Object.freeze({
    Cookie: cookie,
    Origin: address.origin,
    ...(contentType ? { "Content-Type": "application/json" } : {}),
  });
}

function byokPost(
  address: CompanionGatewayAddress,
  cookie: string,
  route: "configure" | "clear" | "chat",
  body: unknown,
  headers = sessionHeaders(address, cookie, true),
) {
  return rawRequest(address, {
    path: `/api/byok/${route}`,
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function completedOpenAiResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "resp_local_test",
      status: "completed",
      output: [
        {
          id: "msg_local_test",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function configure(
  address: CompanionGatewayAddress,
  cookie: string,
): Promise<void> {
  const response = await byokPost(address, cookie, "configure", {
    apiKey: API_KEY_CANARY,
    persist: true,
  });
  expect(response.status).toBe(200);
}

describe("companion BYOK gateway", () => {
  it("defaults unavailable and keeps the fixed status route session-gated and query-free", async () => {
    const { address } = await startByokGateway();
    const anonymous = await rawRequest(address, { path: "/api/byok/status" });
    expect(anonymous.status).toBe(404);

    const cookie = await bootstrap(address);
    const response = await rawRequest(address, {
      path: "/api/byok/status",
      headers: sessionHeaders(address, cookie),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      "status",
      "availability",
      "configured",
      "persistence",
      "canPersist",
      "provider",
      "model",
    ]);
    expect(body).toEqual({
      status: "ok",
      availability: "unavailable",
      configured: false,
      persistence: "memory-only",
      canPersist: false,
      provider: "OpenAI",
      model: "gpt-5.6-luna",
    });
    expect(response.body).not.toMatch(/apiKey|history|conversation|sk-/u);

    const query = await rawRequest(address, {
      path: "/api/byok/status?debug=1",
      headers: sessionHeaders(address, cookie),
    });
    expect(query.status).toBe(404);
    const wrongMethod = await rawRequest(address, {
      path: "/api/byok/status",
      method: "POST",
      headers: sessionHeaders(address, cookie),
      body: "",
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers["allow"]).toBe("GET");
  });

  it("strictly configures and clears only a memory slot without returning the key", async () => {
    const slot = createMemorySecretSlot();
    const { address } = await startByokGateway(slot);
    const cookie = await bootstrap(address);

    const noOrigin = await byokPost(
      address,
      cookie,
      "configure",
      { apiKey: API_KEY_CANARY, persist: false },
      { Cookie: cookie, "Content-Type": "application/json" },
    );
    expect(noOrigin.status).toBe(403);
    expect(slot.get()).toBeNull();

    const extraKey = await byokPost(address, cookie, "configure", {
      apiKey: API_KEY_CANARY,
      persist: false,
      note: "not-allowed",
    });
    expect(extraKey.status).toBe(400);
    expect(slot.get()).toBeNull();

    const wrongContentType = await byokPost(
      address,
      cookie,
      "configure",
      { apiKey: API_KEY_CANARY, persist: false },
      sessionHeaders(address, cookie, false),
    );
    expect(wrongContentType.status).toBe(400);
    expect(slot.get()).toBeNull();

    const invalidKey = await byokPost(address, cookie, "configure", {
      apiKey: "sk-short",
      persist: false,
    });
    expect(invalidKey.status).toBe(400);
    expect(JSON.parse(invalidKey.body)).toEqual({
      status: "error",
      error: "invalid-key",
    });

    const configured = await byokPost(address, cookie, "configure", {
      apiKey: API_KEY_CANARY,
      persist: true,
    });
    expect(configured.status).toBe(200);
    expect(Object.keys(JSON.parse(configured.body) as object)).toEqual([
      "status",
      "availability",
      "configured",
      "persistence",
      "canPersist",
      "provider",
      "model",
    ]);
    expect(JSON.parse(configured.body)).toEqual({
      status: "ok",
      availability: "available",
      configured: true,
      persistence: "memory-only",
      canPersist: false,
      provider: "OpenAI",
      model: "gpt-5.6-luna",
    });
    expect(configured.body).not.toContain(API_KEY_CANARY);
    expect(slot.get()).toBe(API_KEY_CANARY);

    const wrongConfirmation = await byokPost(address, cookie, "clear", {
      confirmation: "clear",
    });
    expect(wrongConfirmation.status).toBe(400);
    expect(slot.get()).toBe(API_KEY_CANARY);

    const cleared = await byokPost(address, cookie, "clear", {
      confirmation: "clear-openai-byok",
    });
    expect(cleared.status).toBe(200);
    expect(Object.keys(JSON.parse(cleared.body) as object)).toEqual([
      "status",
      "availability",
      "configured",
      "persistence",
      "canPersist",
      "provider",
      "model",
    ]);
    expect(cleared.body).not.toContain(API_KEY_CANARY);
    expect(slot.get()).toBeNull();

    const query = await rawRequest(address, {
      path: "/api/byok/configure?persist=true",
      method: "POST",
      headers: sessionHeaders(address, cookie, true),
      body: JSON.stringify({ apiKey: API_KEY_CANARY, persist: true }),
    });
    expect(query.status).toBe(404);
    expect(slot.get()).toBeNull();
    const wrongMethod = await rawRequest(address, {
      path: "/api/byok/configure",
      headers: sessionHeaders(address, cookie),
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers["allow"]).toBe("POST");
  });

  it("reports OS persistence capability separately from the caller's active choice", async () => {
    const slot = osBackedSecretSlot();
    const { gateway, address } = await startByokGateway(slot);
    const cookie = await bootstrap(address);

    const initial = await rawRequest(address, {
      path: "/api/byok/status",
      headers: sessionHeaders(address, cookie),
    });
    expect(JSON.parse(initial.body)).toMatchObject({
      configured: false,
      persistence: "memory-only",
      canPersist: true,
    });

    const memoryOnly = await byokPost(address, cookie, "configure", {
      apiKey: API_KEY_CANARY,
      persist: false,
    });
    expect(JSON.parse(memoryOnly.body)).toMatchObject({
      configured: true,
      persistence: "memory-only",
      canPersist: true,
    });

    const persisted = await byokPost(address, cookie, "configure", {
      apiKey: API_KEY_CANARY,
      persist: true,
    });
    expect(JSON.parse(persisted.body)).toMatchObject({
      configured: true,
      persistence: "os-backed",
      canPersist: true,
    });

    const memoryOnlyAgain = await byokPost(address, cookie, "configure", {
      apiKey: API_KEY_CANARY,
      persist: false,
    });
    expect(JSON.parse(memoryOnlyAgain.body)).toMatchObject({
      configured: true,
      persistence: "memory-only",
      canPersist: true,
    });
    await gateway.close();

    const restarted = await startByokGateway(slot);
    const restartedCookie = await bootstrap(restarted.address);
    const restartedStatus = await rawRequest(restarted.address, {
      path: "/api/byok/status",
      headers: sessionHeaders(restarted.address, restartedCookie),
    });
    expect(JSON.parse(restartedStatus.body)).toMatchObject({
      configured: true,
      persistence: "memory-only",
      canPersist: true,
    });
  });

  it("sends exact store:false requests and leaves all history with the UI caller", async () => {
    const slot = createMemorySecretSlot();
    const { address } = await startByokGateway(slot);
    const cookie = await bootstrap(address);
    await configure(address, cookie);

    const providerCalls: Array<Readonly<{ endpoint: unknown; init: RequestInit }>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (endpoint: unknown, init: RequestInit) => {
        providerCalls.push({ endpoint, init });
        return completedOpenAiResponse(`回覆-${providerCalls.length}`);
      }),
    );

    const first = await byokPost(address, cookie, "chat", {
      characterId: "chatgpt",
      history: [
        { role: "user", text: "先前問題" },
        { role: "assistant", text: "先前回答" },
      ],
      message: "現在問題",
    });
    expect(first.status).toBe(200);
    expect(Object.keys(JSON.parse(first.body) as object)).toEqual([
      "status",
      "characterId",
      "text",
    ]);
    expect(JSON.parse(first.body)).toEqual({
      status: "ok",
      characterId: "chatgpt",
      text: "回覆-1",
    });
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]!.endpoint).toBe("https://api.openai.com/v1/responses");
    expect(providerCalls[0]!.init.redirect).toBe("error");
    expect(providerCalls[0]!.init.headers).toEqual({
      Accept: "application/json",
      Authorization: `Bearer ${API_KEY_CANARY}`,
      "Content-Type": "application/json",
    });
    const providerBodyText = providerCalls[0]!.init.body as string;
    expect(providerBodyText).not.toContain(API_KEY_CANARY);
    const providerBody = JSON.parse(providerBodyText) as Record<string, unknown>;
    expect(Object.keys(providerBody)).toEqual([
      "model",
      "instructions",
      "input",
      "max_output_tokens",
      "background",
      "store",
    ]);
    expect(providerBody["model"]).toBe("gpt-5.6-luna");
    expect(providerBody["max_output_tokens"]).toBe(512);
    expect(providerBody["background"]).toBe(false);
    expect(providerBody["store"]).toBe(false);
    expect(providerBody["instructions"]).toContain("You are Aster");
    expect(JSON.parse(providerBody["input"] as string)).toEqual({
      schemaVersion: "1",
      conversation: [
        { role: "user", text: "先前問題" },
        { role: "assistant", text: "先前回答" },
      ],
      currentUserMessage: "現在問題",
    });

    const second = await byokPost(address, cookie, "chat", {
      characterId: "claude",
      history: [],
      message: "全新問題",
    });
    expect(second.status).toBe(200);
    expect(providerCalls).toHaveLength(2);
    const secondProviderBody = JSON.parse(
      providerCalls[1]!.init.body as string,
    ) as Record<string, unknown>;
    expect(JSON.parse(secondProviderBody["input"] as string)).toEqual({
      schemaVersion: "1",
      conversation: [],
      currentUserMessage: "全新問題",
    });
    expect(secondProviderBody["input"]).not.toContain("先前問題");

    const friend = await byokPost(address, cookie, "chat", {
      characterId: "glm",
      history: [],
      message: "不應送出",
    });
    expect(friend.status).toBe(400);
    expect(providerCalls).toHaveLength(2);

    const status = await rawRequest(address, {
      path: "/api/byok/status",
      headers: sessionHeaders(address, cookie),
    });
    expect(status.body).not.toContain(API_KEY_CANARY);
    expect(status.body).not.toContain("先前問題");
    expect(status.body).not.toContain("全新問題");
  });

  it("rejects extra fields, non-alternating turns, and all history byte overflows", async () => {
    const slot = createMemorySecretSlot();
    const { address } = await startByokGateway(slot);
    const cookie = await bootstrap(address);

    const cases = [
      {
        characterId: "chatgpt",
        history: [],
        message: "hello",
        metadata: {},
      },
      {
        characterId: "chatgpt",
        history: [{ role: "assistant", text: "wrong first role" }],
        message: "hello",
      },
      {
        characterId: "chatgpt",
        history: Array.from({ length: 14 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          text: "turn",
        })),
        message: "hello",
      },
      {
        characterId: "chatgpt",
        history: [],
        message: "x".repeat(4_097),
      },
      {
        characterId: "chatgpt",
        history: Array.from({ length: 8 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          text: index % 2 === 0 ? "u".repeat(4_096) : "a".repeat(10_000),
        })),
        message: "hello",
      },
    ];
    for (const body of cases) {
      const response = await byokPost(address, cookie, "chat", body);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        status: "error",
        error: "invalid-request",
      });
    }
    expect(slot.get()).toBeNull();
  });

  it("admits one provider request at a time and returns a stable busy response", async () => {
    const slot = createMemorySecretSlot();
    const { address } = await startByokGateway(slot);
    const cookie = await bootstrap(address);
    await configure(address, cookie);

    let releaseProvider!: (response: Response) => void;
    let announceProvider!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      announceProvider = resolve;
    });
    const providerResponse = new Promise<Response>((resolve) => {
      releaseProvider = resolve;
    });
    const providerFetch = vi.fn(async () => {
      announceProvider();
      return providerResponse;
    });
    vi.stubGlobal("fetch", providerFetch);

    const first = byokPost(address, cookie, "chat", {
      characterId: "gemini",
      history: [],
      message: "first",
    });
    await providerStarted;
    const second = await byokPost(address, cookie, "chat", {
      characterId: "grok",
      history: [],
      message: "second",
    });
    expect(second.status).toBe(200);
    expect(Object.keys(JSON.parse(second.body) as object)).toEqual([
      "status",
      "characterId",
      "error",
    ]);
    expect(JSON.parse(second.body)).toEqual({
      status: "error",
      characterId: "grok",
      error: "busy",
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);

    releaseProvider(completedOpenAiResponse("first complete"));
    expect(JSON.parse((await first).body)).toEqual({
      status: "ok",
      characterId: "gemini",
      text: "first complete",
    });
  });

  it("aborts the provider request when the loopback client disconnects", async () => {
    const slot = createMemorySecretSlot();
    const { address } = await startByokGateway(slot);
    const cookie = await bootstrap(address);
    await configure(address, cookie);

    let announceProvider!: () => void;
    let announceAbort!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      announceProvider = resolve;
    });
    const providerAborted = new Promise<void>((resolve) => {
      announceAbort = resolve;
    });
    const providerSignals: AbortSignal[] = [];
    const providerFetch = vi.fn(
      async (_endpoint: unknown, init: RequestInit): Promise<Response> => {
        if (!(init.signal instanceof AbortSignal)) {
          throw new Error("missing provider abort signal");
        }
        providerSignals.push(init.signal);
        announceProvider();
        await new Promise<never>((_resolve, reject) => {
          const abort = (): void => {
            announceAbort();
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (init.signal!.aborted) abort();
          else init.signal!.addEventListener("abort", abort, { once: true });
        });
        throw new Error("unreachable");
      },
    );
    vi.stubGlobal("fetch", providerFetch);

    const body = JSON.stringify({
      characterId: "chatgpt",
      history: [],
      message: "disconnect me",
    });
    const pending = startRawRequest(address, {
      path: "/api/byok/chat",
      method: "POST",
      headers: sessionHeaders(address, cookie, true),
      body,
    });
    const disconnectedResponse = pending.response.catch(() => null);
    await providerStarted;
    pending.request.destroy();
    await providerAborted;
    await disconnectedResponse;

    expect(providerSignals).toHaveLength(1);
    expect(providerSignals[0]!.aborted).toBe(true);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("maps provider failures to key-free stable errors", async () => {
    const slot = createMemorySecretSlot();
    const { address } = await startByokGateway(slot);
    const cookie = await bootstrap(address);
    await configure(address, cookie);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(`provider rejected ${API_KEY_CANARY}`, {
          status: 401,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );

    const response = await byokPost(address, cookie, "chat", {
      characterId: "chatgpt",
      history: [],
      message: "hello",
    });
    expect(response.status).toBe(200);
    expect(Object.keys(JSON.parse(response.body) as object)).toEqual([
      "status",
      "characterId",
      "error",
    ]);
    expect(JSON.parse(response.body)).toEqual({
      status: "error",
      characterId: "chatgpt",
      error: "provider-authentication-failed",
    });
    expect(response.body).not.toContain(API_KEY_CANARY);
  });
});

describe("companion BYOK service lifecycle", () => {
  it("bounds initialization and fences a late vault result", async () => {
    vi.useFakeTimers();
    let finishInitialize!: () => void;
    const initializeGate = new Promise<void>((resolve) => {
      finishInitialize = resolve;
    });
    const snapshot = () =>
      Object.freeze({
        configured: false,
        persistence: "os-backed" as const,
        activePersistence: "memory-only" as const,
        backend: "test-os-vault",
      });
    const slot: EncryptedSecretSlot = Object.freeze({
      initialize: async () => {
        await initializeGate;
        return snapshot();
      },
      set: async () => snapshot(),
      get: () => null,
      clear: async () => snapshot(),
      status: snapshot,
    });
    const service = createCompanionByokService(slot);

    const initializing = service.initialize();
    await vi.advanceTimersByTimeAsync(BYOK_STORAGE_OPERATION_TIMEOUT_MS);
    await initializing;
    expect(service.status()).toMatchObject({
      availability: "unavailable",
      configured: false,
    });

    finishInitialize();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.status()).toMatchObject({
      availability: "unavailable",
      configured: false,
      canPersist: false,
    });
    service.dispose();
  });

  it("bounds configure, rejects concurrent work, and clears a late write", async () => {
    let secret: string | null = null;
    let setCalls = 0;
    let clearCalls = 0;
    let announceSet!: () => void;
    let finishSet!: () => void;
    let announceClear!: () => void;
    const setStarted = new Promise<void>((resolve) => {
      announceSet = resolve;
    });
    const setGate = new Promise<void>((resolve) => {
      finishSet = resolve;
    });
    const clearFinished = new Promise<void>((resolve) => {
      announceClear = resolve;
    });
    const snapshot = () =>
      Object.freeze({
        configured: secret !== null,
        persistence: "os-backed" as const,
        activePersistence:
          secret === null ? ("memory-only" as const) : ("os-backed" as const),
        backend: "test-os-vault",
      });
    const slot: EncryptedSecretSlot = Object.freeze({
      initialize: async () => snapshot(),
      set: async (value: string) => {
        setCalls += 1;
        announceSet();
        await setGate;
        // Deliberately ignore the signal to exercise the service's late-write
        // cleanup around a non-conforming local slot.
        secret = value;
        return snapshot();
      },
      get: () => secret,
      clear: async () => {
        clearCalls += 1;
        secret = null;
        announceClear();
        return snapshot();
      },
      status: snapshot,
    });
    const service = createCompanionByokService(slot);
    await service.initialize();
    vi.useFakeTimers();

    const first = service.configure(API_KEY_CANARY, true);
    await setStarted;
    await expect(
      service.configure(`${API_KEY_CANARY}_replacement`, true),
    ).resolves.toMatchObject({
      status: 503,
      body: { status: "error", error: "storage-failed" },
    });
    await expect(
      service.chat({
        characterId: "chatgpt",
        history: [],
        message: "must stay local while control is busy",
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { status: "error", error: "busy" },
    });
    expect(setCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(BYOK_STORAGE_OPERATION_TIMEOUT_MS);
    await expect(first).resolves.toMatchObject({
      status: 503,
      body: { status: "error", error: "storage-failed" },
    });
    service.dispose();
    finishSet();
    await clearFinished;
    await vi.advanceTimersByTimeAsync(0);

    expect(clearCalls).toBe(1);
    expect(slot.get()).toBeNull();
    expect(service.status()).toMatchObject({
      availability: "unavailable",
      configured: false,
    });
  });

  it("bounds clear and applies its eventual deletion", async () => {
    let secret: string | null = API_KEY_CANARY;
    let announceClear!: () => void;
    let finishClear!: () => void;
    let announceFinished!: () => void;
    const clearStarted = new Promise<void>((resolve) => {
      announceClear = resolve;
    });
    const clearGate = new Promise<void>((resolve) => {
      finishClear = resolve;
    });
    const clearFinished = new Promise<void>((resolve) => {
      announceFinished = resolve;
    });
    const snapshot = () =>
      Object.freeze({
        configured: secret !== null,
        persistence: "memory-only" as const,
        activePersistence: "memory-only" as const,
        backend: "memory-only",
      });
    const slot: EncryptedSecretSlot = Object.freeze({
      initialize: async () => snapshot(),
      set: async (value: string) => {
        secret = value;
        return snapshot();
      },
      get: () => secret,
      clear: async () => {
        announceClear();
        await clearGate;
        secret = null;
        announceFinished();
        return snapshot();
      },
      status: snapshot,
    });
    const service = createCompanionByokService(slot);
    await service.initialize();
    vi.useFakeTimers();

    const clearing = service.clear("clear-openai-byok");
    await clearStarted;
    await vi.advanceTimersByTimeAsync(BYOK_STORAGE_OPERATION_TIMEOUT_MS);
    await expect(clearing).resolves.toMatchObject({
      status: 503,
      body: { status: "error", error: "storage-failed" },
    });
    finishClear();
    await clearFinished;
    await vi.advanceTimersByTimeAsync(0);

    expect(slot.get()).toBeNull();
    expect(service.status()).toMatchObject({ configured: false });
    service.dispose();
  });
});
