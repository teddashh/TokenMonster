import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TokenTrackerAdapterError,
  type TokenMonsterDailyAggregateResponse,
  type TokenMonsterProviderTotals,
  type TokenTrackerAdapter,
  type TokenTrackerAggregateRange
} from "@tokenmonster/token-tracker-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CompanionGatewayError,
  createCompanionGateway,
  type CompanionCharacterFetch,
  type CompanionCharacterOptions,
  type CompanionCollectorController,
  type CompanionCollectorStatus,
  type CompanionGateway,
  type CompanionGatewayAddress
} from "../src/index.js";

const UI_ASSETS = Object.freeze({
  html: "<!doctype html><link rel=\"stylesheet\" href=\"/assets/companion.css\"><script type=\"module\" src=\"/assets/companion.js\"></script>",
  css: "body { color: #123; }",
  javascript: "globalThis.TokenMonster = true;"
});

const gateways: CompanionGateway[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(async (gateway) => gateway.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

function ledger(totalTokens: number): Readonly<{
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}> {
  return Object.freeze({
    inputTokens: 0,
    outputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens
  });
}

function responseFor(
  range: TokenTrackerAggregateRange,
  values: readonly (readonly [string, number])[] = []
): TokenMonsterDailyAggregateResponse {
  return Object.freeze({
    fromUtcDate: range.fromUtcDate,
    toUtcDate: range.toUtcDate,
    days: Object.freeze(
      values.map(([utcDate, totalTokens]) =>
        Object.freeze({ utcDate, tokens: ledger(totalTokens) })
      )
    )
  });
}

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function objectRef(body: Uint8Array, extension: "webp" | "png" | "wav") {
  const hash = sha256(body);
  return {
    path: `objects/${hash}.${extension}`,
    bytes: body.byteLength,
    sha256: hash,
    ...(extension === "wav" ? {} : { width: 1, height: 1 })
  };
}

function characterManifest(
  avatarBody: Uint8Array,
  themes: ReadonlyArray<
    Readonly<{
      themeId: string;
      outfitBody: Uint8Array;
      supportedBody?: Uint8Array;
    }>
  > = [{ themeId: "tech", outfitBody: avatarBody }]
) {
  return {
    schemaVersion: "1" as const,
    generatedAt: "2026-07-16T00:00:00.000Z",
    characters: [
      {
        characterId: "chatgpt" as const,
        avatar: objectRef(avatarBody, "webp"),
        themes: themes.map((theme) => ({
          themeId: theme.themeId,
          outfit: objectRef(theme.outfitBody, "webp"),
          poses:
            theme.supportedBody === undefined
              ? {}
              : { supported: objectRef(theme.supportedBody, "webp") }
        }))
      }
    ],
    voice: []
  };
}

function progressionTotals(openai: number) {
  return Object.freeze({
    openai,
    anthropic: 0,
    google: 0,
    xai: 0,
    deepseek: 0,
    qwen: 0,
    mistral: 0,
    venice: 0,
    sakana: 0,
    perplexity: 0,
    glm: 0,
    other: 0
  });
}

function fakeAdapter(
  getDaily: TokenTrackerAdapter["getDaily"] = async (range) =>
    responseFor(range),
  getProviderTotals: TokenTrackerAdapter["getProviderTotals"] = async () =>
    Object.freeze({ openai: 0, anthropic: 0, google: 0, xai: 0 }),
  getProgressionFamilyTotals: TokenTrackerAdapter["getProgressionFamilyTotals"] =
    async () =>
      Object.freeze({
        openai: 0,
        anthropic: 0,
        google: 0,
        xai: 0,
        deepseek: 0,
        qwen: 0,
        mistral: 0,
        venice: 0,
        sakana: 0,
        perplexity: 0,
        glm: 0,
        other: 0
      })
): TokenTrackerAdapter {
  return Object.freeze({
    probe: vi.fn(async () => ({
      reachable: true as const,
      schemaCompatible: true as const,
      compatibilityTarget: "0.80.0" as const
    })),
    getSummary: vi.fn(async () => {
      throw new Error("Unused in companion gateway tests.");
    }),
    getDaily: vi.fn(getDaily),
    getProviderTotals: vi.fn(getProviderTotals),
    getProgressionFamilyTotals: vi.fn(getProgressionFamilyTotals)
  });
}

function adapterWithOpenAiProgression(total: number): TokenTrackerAdapter {
  return fakeAdapter(
    async (range) => responseFor(range),
    async () => Object.freeze({ openai: total, anthropic: 0, google: 0, xai: 0 }),
    async () => progressionTotals(total)
  );
}

const EMPTY_CHARACTER_OPTIONS = Object.freeze({
  manifest: {
    schemaVersion: "1" as const,
    generatedAt: "2026-07-16T00:00:00.000Z",
    characters: [],
    voice: []
  },
  cacheDirectory: "/tmp/tokenmonster-gateway-unused-assets",
  cdnBaseUrl: null,
  progressionStorePath: "/tmp/tokenmonster-gateway-unused-progression.json"
});

const READY_COLLECTOR_STATUS: CompanionCollectorStatus = Object.freeze({
  phase: "ready",
  lastSuccessAt: "2026-07-15T12:00:00.000Z",
  consecutiveFailures: 0,
  canRetry: true
});

function fakeCollector(
  getStatus: CompanionCollectorController["getStatus"] = () =>
    READY_COLLECTOR_STATUS,
  requestRefresh: CompanionCollectorController["requestRefresh"] = async () =>
    getStatus()
): CompanionCollectorController {
  return Object.freeze({
    getStatus: vi.fn(getStatus),
    requestRefresh: vi.fn(requestRefresh)
  });
}

async function startGateway(
  adapter: TokenTrackerAdapter = fakeAdapter(),
  apiTimeoutMs?: number,
  collector: CompanionCollectorController = fakeCollector(),
  characterOverrides: Partial<CompanionCharacterOptions> = {}
): Promise<Readonly<{
  gateway: CompanionGateway;
  address: CompanionGatewayAddress;
}>> {
  const characterDirectory = await mkdtemp(
    join(tmpdir(), "tokenmonster-gateway-characters-")
  );
  temporaryDirectories.push(characterDirectory);
  const gateway = createCompanionGateway({
    adapter,
    collector,
    assets: UI_ASSETS,
    characters: {
      ...EMPTY_CHARACTER_OPTIONS,
      cacheDirectory: join(characterDirectory, "asset-cache"),
      progressionStorePath: join(characterDirectory, "progression-v1.json"),
      ...characterOverrides
    },
    clock: () => new Date("2026-07-15T12:34:56.789Z"),
    ...(apiTimeoutMs === undefined ? {} : { apiTimeoutMs })
  });
  gateways.push(gateway);
  return Object.freeze({ gateway, address: await gateway.start(0) });
}

async function bootstrap(address: CompanionGatewayAddress): Promise<string> {
  const response = await fetch(address.bootstrapUrl, { redirect: "manual" });
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/");
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toMatch(
    /^tokenmonster_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/u
  );
  const cookie = setCookie!.split(";", 1)[0]!;
  const bootstrapToken = new URL(address.bootstrapUrl).pathname.split("/").at(-1);
  const sessionToken = cookie.split("=", 2)[1];
  expect(bootstrapToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(sessionToken).not.toBe(bootstrapToken);
  return cookie;
}

async function apiRequest(
  address: CompanionGatewayAddress,
  cookie: string
): Promise<Response> {
  return fetch(`${address.origin}/api/companion`, {
    headers: {
      Accept: "application/json",
      Cookie: cookie,
      Origin: address.origin
    }
  });
}

async function characterRequest(
  address: CompanionGatewayAddress,
  cookie: string
): Promise<Response> {
  return fetch(`${address.origin}/api/characters`, {
    headers: { Cookie: cookie, Origin: address.origin }
  });
}

async function characterPost(
  address: CompanionGatewayAddress,
  cookie: string,
  path: "select" | "wardrobe",
  body: string,
  contentType = "application/json"
): Promise<Response> {
  return fetch(`${address.origin}/api/characters/${path}`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: address.origin,
      "Content-Type": contentType
    },
    body
  });
}

async function collectorStatusRequest(
  address: CompanionGatewayAddress,
  cookie: string
): Promise<Response> {
  return fetch(`${address.origin}/api/companion/status`, {
    headers: {
      Accept: "application/json",
      Cookie: cookie,
      Origin: address.origin
    }
  });
}

async function collectorRefreshRequest(
  address: CompanionGatewayAddress,
  cookie: string
): Promise<Response> {
  return fetch(`${address.origin}/api/companion/refresh`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Cookie: cookie,
      Origin: address.origin
    }
  });
}

function rawRequest(
  address: CompanionGatewayAddress,
  input: Readonly<{
    path: string;
    method?: string;
    headers?: Readonly<Record<string, string>>;
    body?: string;
  }>
): Promise<Readonly<{
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: string;
}>> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: address.host,
        port: address.port,
        path: input.path,
        method: input.method ?? "GET",
        headers: input.headers
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve(
            Object.freeze({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8")
            })
          )
        );
      }
    );
    request.on("error", reject);
    request.end(input.body);
  });
}

describe("companion gateway", () => {
  it("binds an ephemeral IPv4 loopback port and serves only authenticated fixed assets", async () => {
    const { address } = await startGateway();
    expect(address.host).toBe("127.0.0.1");
    expect(address.port).toBeGreaterThan(0);
    expect(address.origin).toBe(`http://127.0.0.1:${address.port}`);

    const anonymous = await fetch(address.origin);
    expect(anonymous.status).toBe(404);
    const cookie = await bootstrap(address);

    const html = await fetch(address.origin, { headers: { Cookie: cookie } });
    expect(html.status).toBe(200);
    expect(await html.text()).toBe(UI_ASSETS.html);
    expect(html.headers.get("content-security-policy")).toContain(
      "connect-src 'self'"
    );
    expect(html.headers.get("access-control-allow-origin")).toBeNull();

    const css = await fetch(`${address.origin}/assets/companion.css`, {
      headers: { Cookie: cookie }
    });
    expect(css.status).toBe(200);
    expect(await css.text()).toBe(UI_ASSETS.css);

    const javascript = await fetch(`${address.origin}/assets/companion.js`, {
      headers: { Cookie: cookie }
    });
    expect(javascript.status).toBe(200);
    expect(await javascript.text()).toBe(UI_ASSETS.javascript);

    const unknown = await fetch(`${address.origin}/favicon.ico`, {
      headers: { Cookie: cookie }
    });
    expect(unknown.status).toBe(404);
  });

  it("invalidates the secret bootstrap route after its first successful use", async () => {
    const { address } = await startGateway();
    await bootstrap(address);
    const replay = await fetch(address.bootstrapUrl, { redirect: "manual" });
    expect(replay.status).toBe(404);
    expect(replay.headers.get("set-cookie")).toBeNull();
  });

  it("uses a distinct random bootstrap token for each gateway process instance", async () => {
    const first = await startGateway();
    const second = await startGateway();
    expect(first.address.bootstrapUrl).not.toBe(second.address.bootstrapUrl);
  });

  it("delegates one fixed 28-day UTC range and returns only allowlisted totals", async () => {
    const getDaily = vi.fn<TokenTrackerAdapter["getDaily"]>(async (range) => {
      const response = responseFor(range, [
        ["2026-06-18", 40],
        ["2026-07-08", 30],
        ["2026-07-09", 20],
        ["2026-07-15", 10]
      ]);
      return {
        ...response,
        provider: "must-not-cross-gateway",
        projectPath: "must-not-cross-gateway"
      } as TokenMonsterDailyAggregateResponse;
    });
    const getProviderTotals = vi.fn<
      TokenTrackerAdapter["getProviderTotals"]
    >(async () =>
      Object.freeze({ openai: 20, anthropic: 80, google: 10, xai: 0 })
    );
    const adapter = fakeAdapter(getDaily, getProviderTotals);
    const { address } = await startGateway(adapter);
    const cookie = await bootstrap(address);

    const response = await apiRequest(address, cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual({
      status: "healthy",
      generatedAt: "2026-07-15T12:34:56.789Z",
      starter: {
        outcome: "selected",
        selectedBy: "unique-provider-total",
        characterId: "claude",
        providerFamily: "anthropic"
      },
      totals: { today: 10, last7Days: 30, last28Days: 100 },
      daily: [
        { utcDate: "2026-06-18", totalTokens: 40 },
        { utcDate: "2026-07-08", totalTokens: 30 },
        { utcDate: "2026-07-09", totalTokens: 20 },
        { utcDate: "2026-07-15", totalTokens: 10 }
      ]
    });
    expect(getDaily).toHaveBeenCalledTimes(1);
    expect(getDaily).toHaveBeenCalledWith({
      fromUtcDate: "2026-06-18",
      toUtcDate: "2026-07-15"
    });
    expect(getProviderTotals).toHaveBeenCalledTimes(1);
    expect(getProviderTotals).toHaveBeenCalledWith({
      fromUtcDate: "2026-06-18",
      toUtcDate: "2026-07-15"
    });
  });

  it("exposes syncing before the first refresh without reading zero aggregates", async () => {
    const adapter = fakeAdapter();
    const collector = fakeCollector(() =>
      Object.freeze({
        phase: "syncing",
        lastSuccessAt: null,
        consecutiveFailures: 0,
        canRetry: false
      })
    );
    const { address } = await startGateway(adapter, undefined, collector);
    const cookie = await bootstrap(address);

    const response = await collectorStatusRequest(address, cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      phase: "syncing",
      lastSuccessAt: null,
      consecutiveFailures: 0,
      canRetry: false
    });
    expect(adapter.getDaily).not.toHaveBeenCalled();
    expect(adapter.getProviderTotals).not.toHaveBeenCalled();
  });

  it("keeps last-good metrics available while the collector is stale", async () => {
    const collector = fakeCollector(() =>
      Object.freeze({
        phase: "stale",
        lastSuccessAt: "2026-07-15T12:00:00.000Z",
        consecutiveFailures: 2,
        canRetry: true
      })
    );
    const adapter = fakeAdapter(async (range) =>
      responseFor(range, [[range.toUtcDate, 42]])
    );
    const { address } = await startGateway(adapter, undefined, collector);
    const cookie = await bootstrap(address);

    await expect(
      (await collectorStatusRequest(address, cookie)).json()
    ).resolves.toMatchObject({ phase: "stale", consecutiveFailures: 2 });
    const metrics = await apiRequest(address, cookie);
    expect(metrics.status).toBe(200);
    expect(await metrics.json()).toMatchObject({
      status: "healthy",
      totals: { today: 42, last7Days: 42, last28Days: 42 }
    });
  });

  it("deduplicates concurrent refreshes and rate-limits a completed retrigger", async () => {
    let resolveRefresh!: (status: CompanionCollectorStatus) => void;
    const pending = new Promise<CompanionCollectorStatus>((resolve) => {
      resolveRefresh = resolve;
    });
    const requestRefresh = vi.fn(async () => pending);
    const collector = fakeCollector(
      () => READY_COLLECTOR_STATUS,
      requestRefresh
    );
    const { address } = await startGateway(
      fakeAdapter(),
      undefined,
      collector
    );
    const cookie = await bootstrap(address);

    const first = collectorRefreshRequest(address, cookie);
    const duplicate = collectorRefreshRequest(address, cookie);
    await vi.waitFor(() => expect(requestRefresh).toHaveBeenCalledTimes(1));
    resolveRefresh(READY_COLLECTOR_STATUS);
    const [firstResponse, duplicateResponse] = await Promise.all([
      first,
      duplicate
    ]);
    expect(firstResponse.status).toBe(200);
    expect(duplicateResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual(READY_COLLECTOR_STATUS);
    expect(await duplicateResponse.json()).toEqual(READY_COLLECTOR_STATUS);

    const limited = await collectorRefreshRequest(address, cookie);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("5");
    expect(await limited.json()).toEqual(READY_COLLECTOR_STATUS);
    expect(requestRefresh).toHaveBeenCalledTimes(1);
  });

  it("sanitizes invalid collector snapshots and refresh error internals", async () => {
    const canary = "/private/path/refresh-canary";
    const collector = fakeCollector(
      () =>
        ({
          ...READY_COLLECTOR_STATUS,
          detail: canary
        }) as CompanionCollectorStatus,
      async () => {
        throw new Error(canary);
      }
    );
    const { address } = await startGateway(
      fakeAdapter(),
      undefined,
      collector
    );
    const cookie = await bootstrap(address);

    const statusResponse = await collectorStatusRequest(address, cookie);
    expect(statusResponse.status).toBe(503);
    const statusBody = await statusResponse.text();
    expect(statusBody).not.toContain(canary);
    expect(JSON.parse(statusBody)).toEqual({
      status: "error",
      error: "sidecar-unavailable"
    });

    const refreshResponse = await collectorRefreshRequest(address, cookie);
    expect(refreshResponse.status).toBe(503);
    const refreshBody = await refreshResponse.text();
    expect(refreshBody).not.toContain(canary);
    expect(JSON.parse(refreshBody)).toEqual({
      status: "error",
      error: "sidecar-unavailable"
    });
  });

  it("keeps metrics healthy and requests a manual choice when provider totals are unavailable", async () => {
    const adapter = fakeAdapter(
      async (range) => responseFor(range, [[range.toUtcDate, 12]]),
      async () => {
        throw new TokenTrackerAdapterError("incompatible-schema");
      }
    );
    const { address } = await startGateway(adapter);
    const cookie = await bootstrap(address);

    const response = await apiRequest(address, cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "healthy",
      starter: {
        outcome: "user-choice-required",
        reason: "no-positive-provider-data",
        tiedProviderFamilies: []
      },
      totals: { today: 12, last7Days: 12, last28Days: 12 }
    });
  });

  it("rejects malformed provider totals without exposing their fields", async () => {
    const adapter = fakeAdapter(
      async (range) => responseFor(range),
      async () =>
        ({
          openai: 1,
          anthropic: 0,
          google: 0,
          xai: 0,
          projectPath: "/must-not-cross-gateway"
        }) as TokenMonsterProviderTotals
    );
    const { address } = await startGateway(adapter);
    const cookie = await bootstrap(address);

    const response = await apiRequest(address, cookie);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      status: "error",
      error: "sidecar-incompatible"
    });
  });

  it("rejects foreign Host, Origin, methods, query strings, and unauthenticated API reads", async () => {
    const adapter = fakeAdapter();
    const { address } = await startGateway(adapter);
    const cookie = await bootstrap(address);

    const foreignHost = await rawRequest(address, {
      path: "/api/companion",
      headers: { Host: `localhost:${address.port}`, Cookie: cookie }
    });
    expect(foreignHost.status).toBe(403);

    const foreignOrigin = await rawRequest(address, {
      path: "/api/companion",
      headers: {
        Host: `127.0.0.1:${address.port}`,
        Cookie: cookie,
        Origin: "https://attacker.invalid",
        "Sec-Fetch-Site": "cross-site"
      }
    });
    expect(foreignOrigin.status).toBe(403);

    const post = await rawRequest(address, {
      path: "/api/companion",
      method: "POST",
      headers: { Host: `127.0.0.1:${address.port}`, Cookie: cookie }
    });
    expect(post.status).toBe(405);
    expect(post.headers["access-control-allow-origin"]).toBeUndefined();

    const query = await rawRequest(address, {
      path: "/api/companion?from=2020-01-01&to=2099-01-01",
      headers: { Host: `127.0.0.1:${address.port}`, Cookie: cookie }
    });
    expect(query.status).toBe(404);

    const anonymous = await rawRequest(address, {
      path: "/api/companion",
      headers: { Host: `127.0.0.1:${address.port}` }
    });
    expect(anonymous.status).toBe(404);
    expect(adapter.getDaily).not.toHaveBeenCalled();
  });

  it("maps incompatible data and unavailable sidecars to stable safe errors", async () => {
    const incompatible = await startGateway(
      fakeAdapter(async (range) => ({
        ...responseFor(range),
        days: [
          {
            utcDate: range.toUtcDate,
            tokens: ledger(-1)
          }
        ]
      }))
    );
    const incompatibleCookie = await bootstrap(incompatible.address);
    const incompatibleResponse = await apiRequest(
      incompatible.address,
      incompatibleCookie
    );
    expect(incompatibleResponse.status).toBe(502);
    expect(await incompatibleResponse.json()).toEqual({
      status: "error",
      error: "sidecar-incompatible"
    });

    const unavailable = await startGateway(
      fakeAdapter(async () => {
        throw new Error("sensitive upstream detail");
      })
    );
    const unavailableCookie = await bootstrap(unavailable.address);
    const unavailableResponse = await apiRequest(
      unavailable.address,
      unavailableCookie
    );
    expect(unavailableResponse.status).toBe(503);
    const unavailableBody = await unavailableResponse.text();
    expect(JSON.parse(unavailableBody)).toEqual({
      status: "error",
      error: "sidecar-unavailable"
    });
    expect(unavailableBody).not.toContain("sensitive upstream detail");
  });

  it("distinguishes adapter schema errors and bounds a stalled injected adapter", async () => {
    const incompatible = await startGateway(
      fakeAdapter(async () => {
        throw new TokenTrackerAdapterError("incompatible-schema");
      })
    );
    const incompatibleCookie = await bootstrap(incompatible.address);
    const incompatibleResponse = await apiRequest(
      incompatible.address,
      incompatibleCookie
    );
    expect(incompatibleResponse.status).toBe(502);

    const stalled = await startGateway(
      fakeAdapter(
        async () =>
          new Promise<TokenMonsterDailyAggregateResponse>(() => undefined)
      ),
      10
    );
    const stalledCookie = await bootstrap(stalled.address);
    const stalledResponse = await apiRequest(stalled.address, stalledCookie);
    expect(stalledResponse.status).toBe(503);
    expect(await stalledResponse.json()).toEqual({
      status: "error",
      error: "sidecar-unavailable"
    });
  });

  it("session-gates character routes and returns the exact letter-mode roster DTO", async () => {
    const { address } = await startGateway();
    expect((await fetch(`${address.origin}/api/characters`)).status).toBe(404);

    const cookie = await bootstrap(address);
    const response = await characterRequest(address, cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const dto = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(dto)).toEqual([
      "status",
      "generatedAt",
      "selection",
      "voiceEnabled",
      "characters"
    ]);
    expect(dto).toMatchObject({
      status: "ok",
      generatedAt: "2026-07-15T12:34:56.789Z",
      selection: { characterId: null, selectedBy: null },
      voiceEnabled: true
    });
    const characters = dto["characters"] as Array<Record<string, unknown>>;
    expect(characters).toHaveLength(11);
    expect(characters.map((character) => character["characterId"])).toEqual([
      "chatgpt", "claude", "gemini", "grok", "deepseek", "qwen",
      "mistral", "venice", "sakana", "perplexity", "glm"
    ]);
    expect(
      characters.every(
        (character) =>
          (character["visual"] as { mode?: string }).mode === "letter"
      )
    ).toBe(true);
    expect(Object.keys(characters[0]!)).toEqual([
      "characterId",
      "displayName",
      "kind",
      "unlocked",
      "unlockedAt",
      "isStarter",
      "activeThemeId",
      "visual",
      "progress",
      "voiceLines"
    ]);
    expect(Object.keys(characters[0]!["visual"] as object)).toEqual([
      "mode",
      "glyph",
      "background",
      "foreground",
      "accent"
    ]);
    expect(JSON.stringify(dto)).not.toContain("providerId");
  });

  it("strictly validates character POST bodies and lock-gates interactions", async () => {
    const { address } = await startGateway();
    const cookie = await bootstrap(address);

    const lockedSelection = await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "chatgpt" })
    );
    expect(lockedSelection.status).toBe(409);
    expect(await lockedSelection.json()).toEqual({ status: "error", error: "locked" });

    const lockedWardrobe = await characterPost(
      address,
      cookie,
      "wardrobe",
      JSON.stringify({ characterId: "chatgpt", themeId: "tech" })
    );
    expect(lockedWardrobe.status).toBe(409);
    expect(await lockedWardrobe.json()).toEqual({ status: "error", error: "locked" });

    expect((await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "chatgpt", extra: true })
    )).status).toBe(400);
    expect((await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "chatgpt" }),
      "text/plain"
    )).status).toBe(400);
    expect((await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "x".repeat(600) })
    )).status).toBe(400);
  });

  it("backfills progression once and persists unlocked selection and wardrobe", async () => {
    const adapter = adapterWithOpenAiProgression(5_000);
    const { address } = await startGateway(adapter);
    const cookie = await bootstrap(address);

    expect((await apiRequest(address, cookie)).status).toBe(200);
    expect(adapter.getProgressionFamilyTotals).toHaveBeenCalledTimes(28);
    expect((await apiRequest(address, cookie)).status).toBe(200);
    expect(adapter.getProgressionFamilyTotals).toHaveBeenCalledTimes(28);

    const selected = await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "chatgpt" })
    );
    expect(selected.status).toBe(200);
    expect(await selected.json()).toEqual({
      status: "ok",
      selection: { characterId: "chatgpt", selectedBy: "manual" }
    });
    const wardrobe = await characterPost(
      address,
      cookie,
      "wardrobe",
      JSON.stringify({ characterId: "chatgpt", themeId: "finance" })
    );
    expect(wardrobe.status).toBe(200);
    expect(await wardrobe.json()).toEqual({
      status: "ok",
      characterId: "chatgpt",
      activeThemeId: "finance"
    });
    const dto = (await (await characterRequest(address, cookie)).json()) as {
      selection: unknown;
      characters: Array<Record<string, unknown>>;
    };
    expect(dto.selection).toEqual({ characterId: "chatgpt", selectedBy: "manual" });
    expect(dto.characters[0]).toMatchObject({
      characterId: "chatgpt",
      unlocked: true,
      activeThemeId: "finance"
    });
  });

  it("serves verified cache hits and CDN misses with immutable object headers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-assets-"));
    temporaryDirectories.push(directory);
    const cacheDirectory = join(directory, "cache");
    const cachedBody = Buffer.from("cached-approved-object");
    const downloadedBody = Buffer.from("downloaded-approved-object");
    const manifest = characterManifest(downloadedBody, [
      { themeId: "tech", outfitBody: cachedBody }
    ]);
    const fetchImpl = vi.fn<CompanionCharacterFetch>(async () =>
      new Response(downloadedBody, { status: 200 })
    );
    const { address } = await startGateway(
      adapterWithOpenAiProgression(1),
      undefined,
      fakeCollector(),
      {
        manifest,
        cacheDirectory,
        cdnBaseUrl: "https://cdn.example.test/v1",
        fetch: fetchImpl
      }
    );
    const cookie = await bootstrap(address);
    await apiRequest(address, cookie);
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(join(cacheDirectory, `${sha256(cachedBody)}.webp`), cachedBody);

    const cached = await fetch(
      `${address.origin}/assets/characters/objects/${sha256(cachedBody)}.webp`,
      { headers: { Cookie: cookie } }
    );
    expect(cached.status).toBe(200);
    expect(Buffer.from(await cached.arrayBuffer())).toEqual(cachedBody);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cached.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(cached.headers.get("content-type")).toBe("image/webp");

    const downloaded = await fetch(
      `${address.origin}/assets/characters/objects/${sha256(downloadedBody)}.webp`,
      { headers: { Cookie: cookie } }
    );
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(downloadedBody);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://cdn.example.test/v1/objects/${sha256(downloadedBody)}.webp`,
      expect.objectContaining({ method: "GET", redirect: "error" })
    );
    expect(
      await readFile(join(cacheDirectory, `${sha256(downloadedBody)}.webp`))
    ).toEqual(downloadedBody);
  });

  it("fails closed for locked, malformed, cache-only, and mismatched assets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-assets-"));
    temporaryDirectories.push(directory);
    const approvedBody = Buffer.from("approved-object");
    const manifest = characterManifest(approvedBody);
    const fetchImpl = vi.fn<CompanionCharacterFetch>(async () =>
      new Response("wrong-object", { status: 200 })
    );
    const locked = await startGateway(fakeAdapter(), undefined, fakeCollector(), {
      manifest,
      cacheDirectory: join(directory, "locked-cache"),
      cdnBaseUrl: "https://cdn.example.test/v1",
      fetch: fetchImpl
    });
    const lockedCookie = await bootstrap(locked.address);
    const objectPath = `${sha256(approvedBody)}.webp`;
    expect((await fetch(
      `${locked.address.origin}/assets/characters/objects/${objectPath}`,
      { headers: { Cookie: lockedCookie } }
    )).status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await fetch(
      `${locked.address.origin}/assets/characters/objects/NOT-A-HASH.webp`,
      { headers: { Cookie: lockedCookie } }
    )).status).toBe(404);

    const mismatchCache = join(directory, "mismatch-cache");
    const mismatch = await startGateway(
      adapterWithOpenAiProgression(1),
      undefined,
      fakeCollector(),
      {
        manifest,
        cacheDirectory: mismatchCache,
        cdnBaseUrl: "https://cdn.example.test/v1",
        fetch: fetchImpl
      }
    );
    const mismatchCookie = await bootstrap(mismatch.address);
    await apiRequest(mismatch.address, mismatchCookie);
    expect((await fetch(
      `${mismatch.address.origin}/assets/characters/objects/${objectPath}`,
      { headers: { Cookie: mismatchCookie } }
    )).status).toBe(503);
    await expect(access(join(mismatchCache, objectPath))).rejects.toMatchObject({
      code: "ENOENT"
    });

    const cacheOnly = await startGateway(
      adapterWithOpenAiProgression(1),
      undefined,
      fakeCollector(),
      {
        manifest,
        cacheDirectory: join(directory, "cache-only"),
        cdnBaseUrl: null
      }
    );
    const cacheOnlyCookie = await bootstrap(cacheOnly.address);
    await apiRequest(cacheOnly.address, cacheOnlyCookie);
    expect((await fetch(
      `${cacheOnly.address.origin}/assets/characters/objects/${objectPath}`,
      { headers: { Cookie: cacheOnlyCookie } }
    )).status).toBe(404);
  });

  it("queues asset downloads at a maximum of three concurrent requests", async () => {
    const bodies = ["avatar", "tech", "supported", "finance"].map((value) =>
      Buffer.from(`asset-${value}`)
    );
    const manifest = characterManifest(bodies[0]!, [
      {
        themeId: "tech",
        outfitBody: bodies[1]!,
        supportedBody: bodies[2]!
      },
      { themeId: "finance", outfitBody: bodies[3]! }
    ]);
    const bodyByFile = new Map<string, Buffer>(
      bodies.map((body) => [`${sha256(body)}.webp`, body] as const)
    );
    let active = 0;
    let maximumActive = 0;
    const fetchImpl: CompanionCharacterFetch = async (url) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return new Response(bodyByFile.get(url.split("/").at(-1)!)!, {
        status: 200
      });
    };
    const { address } = await startGateway(
      adapterWithOpenAiProgression(5_000),
      undefined,
      fakeCollector(),
      {
        manifest,
        cdnBaseUrl: "https://cdn.example.test/v1",
        fetch: fetchImpl
      }
    );
    const cookie = await bootstrap(address);
    await apiRequest(address, cookie);
    const responses = await Promise.all(
      bodies.map((body) =>
        fetch(
          `${address.origin}/assets/characters/objects/${sha256(body)}.webp`,
          { headers: { Cookie: cookie } }
        )
      )
    );
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200
    ]);
    expect(maximumActive).toBe(3);
  });

  it("reads only the three allowlisted files from an injected static directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-gateway-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      writeFile(join(directory, "index.html"), UI_ASSETS.html),
      writeFile(join(directory, "styles.css"), UI_ASSETS.css),
      writeFile(join(directory, "app.js"), UI_ASSETS.javascript),
      writeFile(join(directory, "private.txt"), "must never be served")
    ]);
    const gateway = createCompanionGateway({
      adapter: fakeAdapter(),
      collector: fakeCollector(),
      assetDirectory: directory,
      characters: EMPTY_CHARACTER_OPTIONS
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const cookie = await bootstrap(address);

    const privateFile = await fetch(`${address.origin}/private.txt`, {
      headers: { Cookie: cookie }
    });
    expect(privateFile.status).toBe(404);
    const traversal = await rawRequest(address, {
      path: "/assets/../private.txt",
      headers: { Host: `127.0.0.1:${address.port}`, Cookie: cookie }
    });
    expect(traversal.status).toBe(404);
  });

  it("rejects an allowlisted filename when its symlink escapes the asset directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-gateway-"));
    const outside = await mkdtemp(join(tmpdir(), "tokenmonster-outside-"));
    temporaryDirectories.push(directory, outside);
    await Promise.all([
      writeFile(join(directory, "index.html"), UI_ASSETS.html),
      writeFile(join(directory, "styles.css"), UI_ASSETS.css),
      writeFile(join(outside, "app.js"), UI_ASSETS.javascript)
    ]);
    await symlink(join(outside, "app.js"), join(directory, "app.js"));

    expect(() =>
      createCompanionGateway({
        adapter: fakeAdapter(),
        collector: fakeCollector(),
        assetDirectory: directory,
        characters: EMPTY_CHARACTER_OPTIONS
      })
    ).toThrowError(CompanionGatewayError);
  });
});
