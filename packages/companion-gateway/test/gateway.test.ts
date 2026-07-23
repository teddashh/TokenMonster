import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TokenTrackerAdapterError,
  type TokenMonsterDailyAggregateResponse,
  type TokenMonsterDailyContentBlindFootprint,
  type TokenMonsterDailyFamilySeries,
  type TokenMonsterModelUsageResponse,
  type TokenMonsterProviderTotals,
  type TokenTrackerAdapter,
  type TokenTrackerAggregateRange,
} from "@tokenmonster/token-tracker-adapter";
import {
  LETTER_WARDROBE_CATALOG,
  WARDROBE_THEME_IDS,
  getApprovedAssetPackConfiguration,
  listCharacters,
  selectTapLine,
  type AssetManifest,
  type WardrobeThemeId,
} from "@tokenmonster/characters";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseCharacterAssetPackStatus,
  parseCharacterInteractionResponse,
  parseCharacterProfileResponse,
  parseCharactersSnapshot,
} from "../../companion-ui/src/public/dto.js";

import {
  CompanionGatewayError,
  createCompanionGateway,
  type CompanionBaseAssets,
  type CompanionCharacterOptions,
  type CompanionCharacterProfileResponse,
  type CompanionCollectorController,
  type CompanionCollectorStatus,
  type CompanionContributionStatusSource,
  type CompanionContributionController,
  type CompanionGateway,
  type CompanionGatewayAddress,
  type CompanionProgressionLockRepairResponse,
  type CompanionUsageFamiliesResponse,
} from "../src/index.js";
import {
  createCharacterService,
  normalizeCharacterOptions,
} from "../src/character-service.js";

const UI_ASSETS = Object.freeze({
  html: '<!doctype html><link rel="stylesheet" href="/assets/companion.css"><script type="module" src="/assets/main.js"></script>',
  css: "body { color: #123; }",
  scripts: Object.freeze({
    "main.js": 'import "./dto.js";\nglobalThis.TokenMonster = true;',
    "dto.js": "export const dto = true;",
  }),
});

const gateways: CompanionGateway[] = [];
const temporaryDirectories: string[] = [];

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(async (gateway) => gateway.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
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
    totalTokens,
  });
}

function responseFor(
  range: TokenTrackerAggregateRange,
  values: readonly (readonly [string, number])[] = [],
): TokenMonsterDailyAggregateResponse {
  return Object.freeze({
    fromUtcDate: range.fromUtcDate,
    toUtcDate: range.toUtcDate,
    days: Object.freeze(
      values.map(([utcDate, totalTokens]) =>
        Object.freeze({ utcDate, tokens: ledger(totalTokens) }),
      ),
    ),
  });
}

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function webpFixture(label: string): Buffer {
  return Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.alloc(4),
    Buffer.from("WEBP", "ascii"),
    Buffer.from(label, "utf8"),
  ]);
}

function objectRef(body: Uint8Array, extension: "webp" | "png" | "wav") {
  const hash = sha256(body);
  return {
    path: `objects/${hash}.${extension}`,
    bytes: body.byteLength,
    sha256: hash,
    ...(extension === "wav" ? {} : { width: 1, height: 1 }),
  };
}

function characterManifest(
  avatarBody: Uint8Array,
  themes: ReadonlyArray<
    Readonly<{
      themeId: WardrobeThemeId;
      outfitBody: Uint8Array;
      supportedBody?: Uint8Array;
    }>
  > = [{ themeId: "tech", outfitBody: avatarBody }],
  characterId: "chatgpt" | "glm" = "chatgpt",
) {
  return {
    schemaVersion: "1" as const,
    generatedAt: "2026-07-16T00:00:00.000Z",
    characters: [
      {
        characterId,
        avatar: objectRef(avatarBody, "webp"),
        themes: themes.map((theme) => ({
          themeId: theme.themeId,
          outfit: objectRef(theme.outfitBody, "webp"),
          poses:
            theme.supportedBody === undefined
              ? {}
              : { supported: objectRef(theme.supportedBody, "webp") },
        })),
      },
    ],
    voice: [],
  };
}

const STARTER_CHARACTER_IDS = ["chatgpt", "claude", "gemini", "grok"] as const;
type StarterCharacterId = (typeof STARTER_CHARACTER_IDS)[number];

function starterCharacterManifest(
  assets: Readonly<
    Record<
      StarterCharacterId,
      Readonly<{ avatarBody: Uint8Array; outfitBody: Uint8Array }>
    >
  >,
): AssetManifest {
  return {
    schemaVersion: "1",
    generatedAt: "2026-07-16T00:00:00.000Z",
    characters: STARTER_CHARACTER_IDS.map((characterId) => ({
      characterId,
      avatar: objectRef(assets[characterId].avatarBody, "webp"),
      themes: [
        {
          themeId: "tech",
          outfit: objectRef(assets[characterId].outfitBody, "webp"),
          poses: {},
        },
      ],
    })),
    voice: [],
  };
}

function embeddedObjects(
  manifest: AssetManifest,
  bodies: readonly Uint8Array[],
): CompanionBaseAssets["objects"] {
  return Object.freeze(
    Object.fromEntries(
      bodies.map((body) => {
        const object = [...manifest.characters]
          .flatMap((character) => [
            character.avatar,
            ...character.themes.flatMap((theme) => [
              theme.outfit,
              ...Object.values(theme.poses).filter(
                (pose): pose is NonNullable<typeof pose> => pose !== undefined,
              ),
            ]),
          ])
          .find((candidate) => candidate.sha256 === sha256(body));
        if (object === undefined) throw new Error("missing fixture object");
        return [object.path, body] as const;
      }),
    ),
  );
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
    other: 0,
  });
}

function usageFamilyTotals(openai = 0, anthropic = 0) {
  return Object.freeze({
    openai,
    anthropic,
    google: 0,
    xai: 0,
    deepseek: 0,
    qwen: 0,
    mistral: 0,
    venice: 0,
    sakana: 0,
    perplexity: 0,
    glm: 0,
    other: 0,
  });
}

function familySeriesFor(
  range: TokenTrackerAggregateRange,
): TokenMonsterDailyFamilySeries {
  const start = Date.parse(`${range.fromUtcDate}T00:00:00.000Z`);
  const end = Date.parse(`${range.toUtcDate}T00:00:00.000Z`);
  const days = [];
  for (let time = start; time <= end; time += 86_400_000) {
    const utcDate = new Date(time).toISOString().slice(0, 10);
    days.push(
      Object.freeze({
        utcDate,
        families: usageFamilyTotals(utcDate === range.toUtcDate ? 11 : 0),
      }),
    );
  }
  return Object.freeze({ days: Object.freeze(days) });
}

function profileFootprint(
  fromUtcDate: string,
  toUtcDate: string,
  observedDays = 14,
  lastDayTotal = 100,
  lastCompleteDayTotal = 100,
): TokenMonsterDailyContentBlindFootprint {
  const start = Date.parse(`${fromUtcDate}T00:00:00.000Z`);
  const end = Date.parse(`${toUtcDate}T00:00:00.000Z`);
  const allDates: string[] = [];
  for (let time = start; time <= end; time += 86_400_000) {
    allDates.push(new Date(time).toISOString().slice(0, 10));
  }
  const observedStart = allDates.length - observedDays;
  const totalForDay = (index: number): number =>
    index === allDates.length - 1
      ? lastDayTotal
      : index === allDates.length - 2
        ? lastCompleteDayTotal
        : 100;
  return {
    schemaVersion: "1",
    characterId: "chatgpt",
    window: {
      from: fromUtcDate,
      to: toUtcDate,
      timezone: "UTC",
    },
    days: allDates.map((localDate, index) =>
      index < observedStart
        ? {
            localDate,
            coverage: "unavailable" as const,
            aggregates: [],
          }
        : {
            localDate,
            coverage: "observed" as const,
            aggregates: [
              {
                provider: "other" as const,
                modelFamily: "other" as const,
                tool: "codex-cli" as const,
                valueQuality: "estimated" as const,
                cacheReadAvailability: "observed" as const,
                tokens: {
                  input: String(Math.floor(totalForDay(index) * 0.4)),
                  output: String(
                    totalForDay(index) - Math.floor(totalForDay(index) * 0.4),
                  ),
                  cacheRead: "0",
                  cacheWrite: "0",
                  reasoning: "0",
                  other: "0",
                  total: String(totalForDay(index)),
                },
              },
            ],
          },
    ),
  };
}

function fakeAdapter(
  getDaily: TokenTrackerAdapter["getDaily"] = async (range) =>
    responseFor(range),
  getProviderTotals: TokenTrackerAdapter["getProviderTotals"] = async () =>
    Object.freeze({ openai: 0, anthropic: 0, google: 0, xai: 0 }),
  getProgressionFamilyTotals: TokenTrackerAdapter["getProgressionFamilyTotals"] = async () =>
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
      other: 0,
    }),
  getDailyFamilySeries: TokenTrackerAdapter["getDailyFamilySeries"] = async (
    range,
  ) => familySeriesFor(range),
  getModelUsage: TokenTrackerAdapter["getModelUsage"] = async () =>
    Object.freeze({ models: Object.freeze([]) }),
  getDailyContentBlindFootprint: TokenTrackerAdapter["getDailyContentBlindFootprint"] = async () => {
    throw new Error("Unused in companion gateway tests.");
  },
): TokenTrackerAdapter {
  return Object.freeze({
    probe: vi.fn(async () => ({
      reachable: true as const,
      schemaCompatible: true as const,
      compatibilityTarget: "0.80.0" as const,
    })),
    getSummary: vi.fn(async () => {
      throw new Error("Unused in companion gateway tests.");
    }),
    getDaily: vi.fn(getDaily),
    getProviderTotals: vi.fn(getProviderTotals),
    getProgressionFamilyTotals: vi.fn(getProgressionFamilyTotals),
    getDailyFamilySeries: vi.fn(getDailyFamilySeries),
    getDailyContentBlindFootprint: vi.fn(getDailyContentBlindFootprint),
    getModelUsage: vi.fn(getModelUsage),
  });
}

function adapterWithOpenAiProgression(total: number): TokenTrackerAdapter {
  return fakeAdapter(
    async (range) => responseFor(range),
    async () =>
      Object.freeze({ openai: total, anthropic: 0, google: 0, xai: 0 }),
    async () => progressionTotals(total),
  );
}

function adapterWithExactOpenAiLifetime(total: number): TokenTrackerAdapter {
  return fakeAdapter(
    async (range) => responseFor(range),
    async () =>
      Object.freeze({ openai: total, anthropic: 0, google: 0, xai: 0 }),
    async (range) =>
      progressionTotals(range.fromUtcDate === "2026-07-15" ? total : 0),
  );
}

function adapterWithAllStarterProgression(total: number): TokenTrackerAdapter {
  return fakeAdapter(
    async (range) => responseFor(range),
    async () =>
      Object.freeze({
        openai: total,
        anthropic: total,
        google: total,
        xai: total,
      }),
    async () =>
      Object.freeze({
        ...progressionTotals(total),
        anthropic: total,
        google: total,
        xai: total,
      }),
  );
}

function adapterWithSelectableSisterAndFriend(): TokenTrackerAdapter {
  return fakeAdapter(
    async (range) => responseFor(range),
    async () =>
      Object.freeze({ openai: 100, anthropic: 100, google: 100, xai: 100 }),
    async () =>
      Object.freeze({
        ...progressionTotals(100),
        anthropic: 100,
        google: 100,
        xai: 100,
        deepseek: 100_000,
      }),
  );
}

const EMPTY_CHARACTER_OPTIONS = Object.freeze({
  manifest: {
    schemaVersion: "1" as const,
    generatedAt: "2026-07-16T00:00:00.000Z",
    characters: [],
    voice: [],
  },
  cacheDirectory: "/tmp/tokenmonster-gateway-unused-assets",
  cdnBaseUrl: null,
  progressionStorePath: "/tmp/tokenmonster-gateway-unused-progression.json",
});

const READY_COLLECTOR_STATUS: CompanionCollectorStatus = Object.freeze({
  phase: "ready",
  lastSuccessAt: "2026-07-15T12:00:00.000Z",
  consecutiveFailures: 0,
  canRetry: true,
});

function fakeCollector(
  getStatus: CompanionCollectorController["getStatus"] = () =>
    READY_COLLECTOR_STATUS,
  requestRefresh: CompanionCollectorController["requestRefresh"] = async () =>
    getStatus(),
): CompanionCollectorController {
  return Object.freeze({
    getStatus: vi.fn(getStatus),
    requestRefresh: vi.fn(requestRefresh),
  });
}

async function startGateway(
  adapter: TokenTrackerAdapter = fakeAdapter(),
  apiTimeoutMs?: number,
  collector: CompanionCollectorController = fakeCollector(),
  characterOverrides: Partial<CompanionCharacterOptions> = {},
  clock: () => Date = () => new Date("2026-07-15T12:34:56.789Z"),
  contribution?:
    CompanionContributionStatusSource | CompanionContributionController | null,
): Promise<
  Readonly<{
    gateway: CompanionGateway;
    address: CompanionGatewayAddress;
  }>
> {
  const characterDirectory = await mkdtemp(
    join(tmpdir(), "tokenmonster-gateway-characters-"),
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
      ...characterOverrides,
    },
    clock,
    ...(contribution === undefined ? {} : { contribution }),
    ...(apiTimeoutMs === undefined ? {} : { apiTimeoutMs }),
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
    /^tokenmonster_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/u,
  );
  const cookie = setCookie!.split(";", 1)[0]!;
  const bootstrapToken = new URL(address.bootstrapUrl).pathname
    .split("/")
    .at(-1);
  const sessionToken = cookie.split("=", 2)[1];
  expect(bootstrapToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(sessionToken).not.toBe(bootstrapToken);
  return cookie;
}

async function apiRequest(
  address: CompanionGatewayAddress,
  cookie: string,
): Promise<Response> {
  return fetch(`${address.origin}/api/companion`, {
    headers: {
      Accept: "application/json",
      Cookie: cookie,
      Origin: address.origin,
    },
  });
}

async function characterRequest(
  address: CompanionGatewayAddress,
  cookie: string,
): Promise<Response> {
  return fetch(`${address.origin}/api/characters`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
}

async function characterProfileRequest(
  address: CompanionGatewayAddress,
  cookie: string,
): Promise<Response> {
  return fetch(`${address.origin}/api/characters/profile`, {
    headers: { Cookie: cookie, Origin: address.origin },
  });
}

async function usageRequest(
  address: CompanionGatewayAddress,
  cookie: string | null,
  path: string,
): Promise<Response> {
  return fetch(`${address.origin}${path}`, {
    headers: {
      ...(cookie === null ? {} : { Cookie: cookie }),
      Origin: address.origin,
    },
  });
}

async function characterPost(
  address: CompanionGatewayAddress,
  cookie: string,
  path: "select" | "wardrobe" | "interact",
  body: string,
  contentType = "application/json",
): Promise<Response> {
  return fetch(`${address.origin}/api/characters/${path}`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: address.origin,
      "Content-Type": contentType,
    },
    body,
  });
}

async function progressionLockRepairPost(
  address: CompanionGatewayAddress,
  cookie: string,
  body: string,
  includeOrigin = true,
): Promise<Response> {
  return fetch(`${address.origin}/api/characters/progression-lock/repair`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      ...(includeOrigin ? { Origin: address.origin } : {}),
      "Content-Type": "application/json",
    },
    body,
  });
}

async function quotaPost(
  address: CompanionGatewayAddress,
  cookie: string,
  body: string,
): Promise<Response> {
  return fetch(`${address.origin}/api/usage/quota/plan`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Cookie: cookie,
      Origin: address.origin,
      "Content-Type": "application/json",
    },
    body,
  });
}

async function uiLocaleRequest(
  address: CompanionGatewayAddress,
  cookie: string,
  input: Readonly<{
    method?: "GET" | "POST";
    body?: string;
    includeOrigin?: boolean;
    path?: string;
  }> = {},
): Promise<Response> {
  const method = input.method ?? "GET";
  return fetch(`${address.origin}${input.path ?? "/api/preferences/locale"}`, {
    method,
    headers: {
      Accept: "application/json",
      Cookie: cookie,
      ...(input.includeOrigin === false ? {} : { Origin: address.origin }),
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(input.body === undefined ? {} : { body: input.body }),
  });
}

async function collectorStatusRequest(
  address: CompanionGatewayAddress,
  cookie: string,
): Promise<Response> {
  return fetch(`${address.origin}/api/companion/status`, {
    headers: {
      Accept: "application/json",
      Cookie: cookie,
      Origin: address.origin,
    },
  });
}

async function collectorRefreshRequest(
  address: CompanionGatewayAddress,
  cookie: string,
): Promise<Response> {
  return fetch(`${address.origin}/api/companion/refresh`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Cookie: cookie,
      Origin: address.origin,
    },
  });
}

function rawRequest(
  address: CompanionGatewayAddress,
  input: Readonly<{
    path: string;
    method?: string;
    headers?: Readonly<Record<string, string | string[]>>;
    body?: string;
  }>,
): Promise<
  Readonly<{
    status: number;
    headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    body: string;
  }>
> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: address.host,
        port: address.port,
        path: input.path,
        method: input.method ?? "GET",
        headers: input.headers,
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
    request.on("error", reject);
    request.end(input.body);
  });
}

describe("companion gateway", () => {
  it("persists the content-free UI locale with guarded idempotent CAS across ports", async () => {
    const shared = await mkdtemp(join(tmpdir(), "tokenmonster-locale-api-"));
    temporaryDirectories.push(shared);
    const progressionStorePath = join(shared, "progression-v1.json");
    const first = await startGateway(
      fakeAdapter(),
      undefined,
      fakeCollector(),
      {
        progressionStorePath,
      },
    );
    expect(
      (await fetch(`${first.address.origin}/api/preferences/locale`)).status,
    ).toBe(404);
    const firstCookie = await bootstrap(first.address);

    const wrongMethod = await rawRequest(first.address, {
      path: "/api/preferences/locale",
      method: "PUT",
      headers: {
        Host: `127.0.0.1:${first.address.port}`,
        Cookie: firstCookie,
      },
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers["allow"]).toBe("GET, POST");

    const initial = await uiLocaleRequest(first.address, firstCookie);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      status: "ok",
      locale: "zh-TW",
      revision: 0,
    });

    const missingOrigin = await uiLocaleRequest(first.address, firstCookie, {
      method: "POST",
      includeOrigin: false,
      body: JSON.stringify({ locale: "en", expectedRevision: 0 }),
    });
    expect(missingOrigin.status).toBe(403);
    const invalid = await uiLocaleRequest(first.address, firstCookie, {
      method: "POST",
      body: JSON.stringify({
        locale: "en",
        expectedRevision: 0,
        unexpected: true,
      }),
    });
    expect(invalid.status).toBe(400);

    const changed = await uiLocaleRequest(first.address, firstCookie, {
      method: "POST",
      body: JSON.stringify({ locale: "en", expectedRevision: 0 }),
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({
      status: "ok",
      locale: "en",
      revision: 1,
    });

    const responseLostRetry = await uiLocaleRequest(
      first.address,
      firstCookie,
      {
        method: "POST",
        body: JSON.stringify({ locale: "en", expectedRevision: 0 }),
      },
    );
    expect(responseLostRetry.status).toBe(200);
    expect(await responseLostRetry.json()).toEqual({
      status: "ok",
      locale: "en",
      revision: 1,
    });

    const conflict = await uiLocaleRequest(first.address, firstCookie, {
      method: "POST",
      body: JSON.stringify({ locale: "zh-TW", expectedRevision: 0 }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      status: "error",
      error: "revision-conflict",
    });

    const query = await uiLocaleRequest(first.address, firstCookie, {
      path: "/api/preferences/locale?locale=en",
    });
    expect(query.status).toBe(404);
    await first.gateway.close();

    const second = await startGateway(
      fakeAdapter(),
      undefined,
      fakeCollector(),
      {
        progressionStorePath,
      },
    );
    expect(second.address.port).not.toBe(first.address.port);
    const secondCookie = await bootstrap(second.address);
    const persisted = await uiLocaleRequest(second.address, secondCookie);
    expect(persisted.status).toBe(200);
    expect(await persisted.json()).toEqual({
      status: "ok",
      locale: "en",
      revision: 1,
    });
  });

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
      "connect-src 'self'",
    );
    expect(html.headers.get("access-control-allow-origin")).toBeNull();

    for (const path of [
      "/session/locale/en",
      "/session/locale/zh-TW?view=pet",
    ]) {
      const sessionDocument = await fetch(`${address.origin}${path}`, {
        headers: { Cookie: cookie },
      });
      expect(sessionDocument.status).toBe(200);
      expect(await sessionDocument.text()).toBe(UI_ASSETS.html);
    }
    expect(
      (
        await fetch(`${address.origin}/session/locale/en`, {
          redirect: "manual",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${address.origin}/session/locale/en?locale=zh-TW`, {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(404);
    const sessionDocumentPost = await rawRequest(address, {
      path: "/session/locale/en",
      method: "POST",
      headers: {
        Host: `127.0.0.1:${address.port}`,
        Cookie: cookie,
        Origin: address.origin,
        "Content-Length": "0",
      },
    });
    expect(sessionDocumentPost.status).toBe(405);
    expect(sessionDocumentPost.headers["allow"]).toBe("GET");

    const css = await fetch(`${address.origin}/assets/companion.css`, {
      headers: { Cookie: cookie },
    });
    expect(css.status).toBe(200);
    expect(await css.text()).toBe(UI_ASSETS.css);

    const mainScript = await fetch(`${address.origin}/assets/main.js`, {
      headers: { Cookie: cookie },
    });
    expect(mainScript.status).toBe(200);
    expect(await mainScript.text()).toBe(UI_ASSETS.scripts["main.js"]);
    expect(mainScript.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );

    const moduleScript = await fetch(`${address.origin}/assets/dto.js`, {
      headers: { Cookie: cookie },
    });
    expect(moduleScript.status).toBe(200);
    expect(await moduleScript.text()).toBe(UI_ASSETS.scripts["dto.js"]);

    const unknownScript = await fetch(`${address.origin}/assets/nope.js`, {
      headers: { Cookie: cookie },
    });
    expect(unknownScript.status).toBe(404);

    const anonymousScript = await fetch(`${address.origin}/assets/main.js`);
    expect(anonymousScript.status).toBe(404);

    const unknown = await fetch(`${address.origin}/favicon.ico`, {
      headers: { Cookie: cookie },
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

  it("exposes a session-gated, GET-only, default-off contribution capability", async () => {
    const { address } = await startGateway();
    expect(
      (await fetch(`${address.origin}/api/contribution/status`)).status,
    ).toBe(404);
    const cookie = await bootstrap(address);

    const response = await usageRequest(
      address,
      cookie,
      "/api/contribution/status",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      availability: "unavailable",
      unavailableReason: "secure-storage-unavailable",
      secureStorage: "unavailable",
      state: "unavailable",
      enabled: false,
      canPreview: false,
      canStop: false,
      canDelete: false,
      canRecover: false,
      outboxPending: 0,
      deletionStatus: null,
      anonymousHistoricalTotalsRetained: null,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();

    const query = await usageRequest(
      address,
      cookie,
      "/api/contribution/status?api=https://attacker.invalid",
    );
    expect(query.status).toBe(404);
    const post = await rawRequest(address, {
      path: "/api/contribution/status",
      method: "POST",
      headers: {
        Host: `127.0.0.1:${address.port}`,
        Cookie: cookie,
        Origin: address.origin,
      },
    });
    expect(post.status).toBe(405);
    expect(post.headers["allow"]).toBe("GET");
    expect(
      (await usageRequest(address, cookie, "/api/contribution/enable")).status,
    ).toBe(405);
  });

  it("serves exact session- and Origin-gated contribution controls", async () => {
    let state:
      "off" | "active" | "stopped" | "deletion-pending" | "deletion-complete" =
      "off";
    const runtimeStatus = () => {
      const deletion =
        state === "deletion-pending" || state === "deletion-complete"
          ? Object.freeze({
              jobId: "del_abcdefghijklmnopqrstuv",
              status:
                state === "deletion-pending"
                  ? ("queued" as const)
                  : ("complete" as const),
              requestedAt: "2026-07-19T12:00:00.000Z",
              finishedAt:
                state === "deletion-complete"
                  ? "2026-07-19T12:01:00.000Z"
                  : null,
              anonymousHistoricalTotalsRetained: true as const,
            })
          : null;
      return Object.freeze({
        configured: true,
        secureStorage: "os-backed" as const,
        state,
        enabled: state === "active",
        canEnable:
          state === "off" ||
          state === "stopped" ||
          state === "deletion-complete",
        canDelete: state === "active" || state === "stopped",
        canRecover: state === "deletion-pending",
        outboxPending: 0,
        consentDocumentRevision:
          state === "active" || state === "stopped"
            ? "contribution-2026-07-19"
            : null,
        deletion,
      });
    };
    const previewId = "10000000-0000-4000-8000-000000000001";
    const preparePreview = vi.fn(async () =>
      Object.freeze({
        previewId,
        expiresAt: "2026-07-19T12:10:00.000Z",
        document: Object.freeze({
          revision: "contribution-2026-07-19",
          title: "自願分享匿名 Token 日彙總",
          summary: "只分享內容盲 UTC 日彙總。",
          retentionDisclosure: "目前可識別日彙總最多保留 30 天。",
        }),
        fieldAllowlist: Object.freeze([
          "schemaVersion",
          "batchId",
          "generatedAt",
          "collector.kind",
          "collector.adapterVersion",
          "collector.sourceVersion",
          "buckets.bucketStart",
          "buckets.provider",
          "buckets.modelFamily",
          "buckets.tool",
          "buckets.valueQuality",
          "buckets.revision",
          "buckets.tokens.input",
          "buckets.tokens.output",
          "buckets.tokens.cacheRead",
          "buckets.tokens.cacheWrite",
          "buckets.tokens.reasoning",
          "buckets.tokens.other",
          "buckets.tokens.total",
        ]),
        forbidden: Object.freeze([
          "prompt / response / message content",
          "source code / filename / project path",
          "API key / OAuth token / provider credential",
          "raw log / event / session / hourly bucket",
        ]),
        payload: null,
        eligibleBucketCount: 0,
        remainingEligibleBucketCount: 0,
      }),
    );
    const controller: CompanionContributionController = Object.freeze({
      status: runtimeStatus,
      preparePreview,
      enable: vi.fn(async (receivedPreviewId: string) => {
        expect(receivedPreviewId).toBe(previewId);
        state = "active";
        return Object.freeze({
          ok: true,
          code: "enabled" as const,
          status: runtimeStatus(),
        });
      }),
      stop: vi.fn(async () => {
        state = "stopped";
        return Object.freeze({
          ok: true,
          code: "stopped" as const,
          status: runtimeStatus(),
        });
      }),
      requestDeletion: vi.fn(async () => {
        state = "deletion-pending";
        return Object.freeze({
          ok: true,
          code: "deletion-requested" as const,
          status: runtimeStatus(),
        });
      }),
      recover: vi.fn(async () => {
        state = "deletion-complete";
        return Object.freeze({
          ok: true,
          code: "deletion-status-updated" as const,
          status: runtimeStatus(),
        });
      }),
    });
    const { address } = await startGateway(
      fakeAdapter(),
      undefined,
      fakeCollector(),
      {},
      undefined,
      controller,
    );
    const cookie = await bootstrap(address);
    const post = (path: string, body: unknown, includeOrigin = true) =>
      fetch(`${address.origin}${path}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Cookie: cookie,
          ...(includeOrigin ? { Origin: address.origin } : {}),
        },
        body: JSON.stringify(body),
      });

    const initial = await usageRequest(
      address,
      cookie,
      "/api/contribution/status",
    );
    expect(await initial.json()).toMatchObject({
      state: "off",
      canPreview: true,
      canStop: false,
      canDelete: false,
      canRecover: false,
    });
    expect(
      (
        await post(
          "/api/contribution/preview",
          { confirmation: "preview-contribution-data" },
          false,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post("/api/contribution/enable", {
          previewId,
          confirmation: "wrong",
        })
      ).status,
    ).toBe(400);
    expect(controller.enable).not.toHaveBeenCalled();

    const preview = await post("/api/contribution/preview", {
      confirmation: "preview-contribution-data",
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      status: "ok",
      preview: { previewId, payload: null },
    });

    const enabled = await post("/api/contribution/enable", {
      previewId,
      confirmation: "enable-anonymous-contribution",
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      status: "ok",
      action: "enable",
      code: "enabled",
      contribution: { state: "active", canStop: true, canDelete: true },
    });
    const stopped = await post("/api/contribution/stop", {
      confirmation: "stop-anonymous-contribution",
    });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({
      action: "stop",
      code: "stopped",
    });
    const deletion = await post("/api/contribution/delete", {
      confirmation: "delete-contribution-data",
    });
    expect(deletion.status).toBe(200);
    expect(await deletion.json()).toMatchObject({
      action: "delete",
      contribution: { state: "deletion-pending", canRecover: true },
    });
    const recovered = await post("/api/contribution/recover", {
      confirmation: "recover-contribution-state",
    });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      action: "recover",
      contribution: { state: "deletion-complete", canPreview: true },
    });
    expect(
      (
        await post("/api/contribution/stop?next=https://attacker.invalid", {
          confirmation: "stop-anonymous-contribution",
        })
      ).status,
    ).toBe(404);
  });

  it.each(["enable", "delete"] as const)(
    "waits for an in-flight contribution %s before gateway close resolves",
    async (action) => {
      const started = deferred<void>();
      const release = deferred<void>();
      const offStatus = () =>
        Object.freeze({
          configured: true,
          secureStorage: "os-backed" as const,
          state: "off" as const,
          enabled: false,
          canEnable: true,
          canDelete: false,
          canRecover: false,
          outboxPending: 0,
          consentDocumentRevision: null,
          deletion: null,
        });
      const controller: CompanionContributionController = Object.freeze({
        status: offStatus,
        preparePreview: async () => {
          throw new Error("UNUSED");
        },
        enable: async () => {
          started.resolve();
          await release.promise;
          return Object.freeze({
            ok: true,
            code: "enabled" as const,
            status: Object.freeze({
              ...offStatus(),
              state: "active" as const,
              enabled: true,
              canEnable: false,
              canDelete: true,
            }),
          });
        },
        stop: async () => {
          throw new Error("UNUSED");
        },
        requestDeletion: async () => {
          started.resolve();
          await release.promise;
          return Object.freeze({
            ok: true,
            code: "deletion-requested" as const,
            status: Object.freeze({
              ...offStatus(),
              state: "deletion-pending" as const,
              canEnable: false,
              canRecover: true,
              deletion: Object.freeze({
                jobId: "del_abcdefghijklmnopqrstuv",
                status: "queued" as const,
                requestedAt: "2026-07-19T12:00:00.000Z",
                finishedAt: null,
                anonymousHistoricalTotalsRetained: true as const,
              }),
            }),
          });
        },
        recover: async () => {
          throw new Error("UNUSED");
        },
      });
      const { gateway, address } = await startGateway(
        fakeAdapter(),
        undefined,
        fakeCollector(),
        {},
        undefined,
        controller,
      );
      const cookie = await bootstrap(address);
      const response = fetch(`${address.origin}/api/contribution/${action}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: address.origin,
        },
        body: JSON.stringify(
          action === "enable"
            ? {
                previewId: "10000000-0000-4000-8000-000000000001",
                confirmation: "enable-anonymous-contribution",
              }
            : { confirmation: "delete-contribution-data" },
        ),
      }).catch(() => null);
      await started.promise;
      let closeResolved = false;
      const closing = gateway.close().then(() => {
        closeResolved = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(closeResolved).toBe(false);

      release.resolve();
      await closing;
      await response;
      expect(closeResolved).toBe(true);
    },
  );

  it("applies the complete fixed request matrix to every contribution mutation route", async () => {
    const { address } = await startGateway();
    const routes = Object.freeze([
      Object.freeze({
        path: "/api/contribution/preview",
        action: "preview",
        body: Object.freeze({ confirmation: "preview-contribution-data" }),
      }),
      Object.freeze({
        path: "/api/contribution/enable",
        action: "enable",
        body: Object.freeze({
          previewId: "10000000-0000-4000-8000-000000000001",
          confirmation: "enable-anonymous-contribution",
        }),
      }),
      Object.freeze({
        path: "/api/contribution/stop",
        action: "stop",
        body: Object.freeze({ confirmation: "stop-anonymous-contribution" }),
      }),
      Object.freeze({
        path: "/api/contribution/delete",
        action: "delete",
        body: Object.freeze({ confirmation: "delete-contribution-data" }),
      }),
      Object.freeze({
        path: "/api/contribution/recover",
        action: "recover",
        body: Object.freeze({ confirmation: "recover-contribution-state" }),
      }),
    ] as const);
    const postRaw = (
      path: string,
      body: string,
      cookie: string | null,
      headers: Readonly<Record<string, string | string[]>> = {},
    ) =>
      rawRequest(address, {
        path,
        method: "POST",
        headers: {
          Host: `127.0.0.1:${address.port}`,
          ...(cookie === null ? {} : { Cookie: cookie }),
          Origin: address.origin,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
          ...headers,
        },
        body,
      });

    for (const route of routes) {
      const serialized = JSON.stringify(route.body);
      expect((await postRaw(route.path, serialized, null)).status).toBe(404);
    }
    const cookie = await bootstrap(address);

    for (const route of routes) {
      const serialized = JSON.stringify(route.body);
      const query = await postRaw(
        `${route.path}?next=attacker`,
        serialized,
        cookie,
      );
      expect(query.status).toBe(404);

      const wrongMethod = await rawRequest(address, {
        path: route.path,
        headers: {
          Host: `127.0.0.1:${address.port}`,
          Cookie: cookie,
          Origin: address.origin,
        },
      });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers["allow"]).toBe("POST");

      expect(
        (
          await postRaw(route.path, serialized, cookie, {
            Origin: "http://attacker.invalid",
          })
        ).status,
      ).toBe(403);
      expect(
        (await postRaw(route.path, serialized, cookie, { Origin: [] })).status,
      ).toBe(403);
      expect(
        (
          await postRaw(route.path, serialized, cookie, {
            Origin: [address.origin, address.origin],
          })
        ).status,
      ).toBe(403);

      const wrongType = await postRaw(route.path, serialized, cookie, {
        "Content-Type": "text/plain",
      });
      expect(wrongType.status).toBe(400);
      expect(JSON.parse(wrongType.body)).toMatchObject({
        status: "error",
        action: route.action,
        code: "invalid-request",
      });

      const tooLargeObject = {
        ...route.body,
        confirmation: "x".repeat(600),
      };
      expect(
        (await postRaw(route.path, JSON.stringify(tooLargeObject), cookie))
          .status,
      ).toBe(400);
      expect((await postRaw(route.path, "{}", cookie)).status).toBe(400);
      expect(
        (
          await postRaw(
            route.path,
            JSON.stringify({ ...route.body, unexpected: true }),
            cookie,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await postRaw(
            route.path,
            JSON.stringify({ ...route.body, confirmation: "wrong" }),
            cookie,
          )
        ).status,
      ).toBe(400);

      const accepted = await postRaw(route.path, serialized, cookie);
      expect(accepted.status).toBe(503);
      expect(JSON.parse(accepted.body)).toMatchObject({
        status: "error",
        action: route.action,
        code: "runtime-unavailable",
        contribution: {
          unavailableReason: "secure-storage-unavailable",
          canPreview: false,
          canStop: false,
          canDelete: false,
          canRecover: false,
        },
      });
      expect(accepted.body).not.toContain("attacker.invalid");
      expect(accepted.body).not.toContain("tm_");
    }

    const invalidUuid = await postRaw(
      "/api/contribution/enable",
      JSON.stringify({
        previewId: "not-a-uuid",
        confirmation: "enable-anonymous-contribution",
      }),
      cookie,
    );
    expect(invalidUuid.status).toBe(400);
  });

  it("projects only a wrapped read-only contribution status facade", async () => {
    const status = vi.fn(() =>
      Object.freeze({
        configured: true,
        secureStorage: "os-backed" as const,
        state: "active" as const,
        enabled: true,
        canEnable: false,
        canDelete: true,
        canRecover: false,
        outboxPending: 2,
        consentDocumentRevision: "contribution-2026-07-19",
        deletion: null,
      }),
    );
    const source = Object.freeze({ status });
    const { address } = await startGateway(
      fakeAdapter(),
      undefined,
      fakeCollector(),
      {},
      undefined,
      source,
    );
    const cookie = await bootstrap(address);
    const response = await usageRequest(
      address,
      cookie,
      "/api/contribution/status",
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      status: "ok",
      availability: "available",
      unavailableReason: null,
      secureStorage: "os-backed",
      state: "active",
      enabled: true,
      canPreview: false,
      canStop: false,
      canDelete: false,
      canRecover: false,
      outboxPending: 2,
      deletionStatus: null,
      anonymousHistoricalTotalsRetained: null,
    });
    expect(status).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("contribution-2026-07-19");
    expect(serialized).not.toContain("canEnable");
    expect(serialized).not.toContain("credential");
  });

  it("reduces thrown or malformed contribution facade output to one unavailable DTO", async () => {
    const errorCanary = "CONTRIBUTION_ENDPOINT_AND_CREDENTIAL_CANARY";
    const source = Object.freeze({
      status: () => {
        throw new Error(errorCanary);
      },
    });
    const { address } = await startGateway(
      fakeAdapter(),
      undefined,
      fakeCollector(),
      {},
      undefined,
      source,
    );
    const cookie = await bootstrap(address);
    const response = await usageRequest(
      address,
      cookie,
      "/api/contribution/status",
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      availability: "unavailable",
      enabled: false,
    });
    expect(body).not.toContain(errorCanary);
  });

  it("rejects a full contribution service instead of widening the status facade", () => {
    expect(() =>
      createCompanionGateway({
        adapter: fakeAdapter(),
        collector: fakeCollector(),
        assets: UI_ASSETS,
        characters: EMPTY_CHARACTER_OPTIONS,
        contribution: {
          status: () => ({
            configured: true,
            secureStorage: "os-backed",
            state: "off",
            enabled: false,
            canEnable: true,
            canDelete: false,
            canRecover: false,
            outboxPending: 0,
            consentDocumentRevision: null,
            deletion: null,
          }),
          enable: vi.fn(),
        } as unknown as CompanionContributionStatusSource,
      }),
    ).toThrowError(CompanionGatewayError);
  });

  it("delegates one fixed 28-day UTC range and returns only allowlisted totals", async () => {
    const getDaily = vi.fn<TokenTrackerAdapter["getDaily"]>(async (range) => {
      const response = responseFor(range, [
        ["2026-06-18", 40],
        ["2026-07-08", 30],
        ["2026-07-09", 20],
        ["2026-07-15", 10],
      ]);
      return {
        ...response,
        provider: "must-not-cross-gateway",
        projectPath: "must-not-cross-gateway",
      } as TokenMonsterDailyAggregateResponse;
    });
    const getProviderTotals = vi.fn<TokenTrackerAdapter["getProviderTotals"]>(
      async () =>
        Object.freeze({ openai: 20, anthropic: 80, google: 10, xai: 0 }),
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
        providerFamily: "anthropic",
      },
      totals: { today: 10, last7Days: 30, last28Days: 100 },
      daily: [
        { utcDate: "2026-06-18", totalTokens: 40 },
        { utcDate: "2026-07-08", totalTokens: 30 },
        { utcDate: "2026-07-09", totalTokens: 20 },
        { utcDate: "2026-07-15", totalTokens: 10 },
      ],
    });
    expect(getDaily).toHaveBeenCalledTimes(1);
    expect(getDaily).toHaveBeenCalledWith({
      fromUtcDate: "2026-06-18",
      toUtcDate: "2026-07-15",
    });
    expect(getProviderTotals).toHaveBeenCalledTimes(1);
    expect(getProviderTotals).toHaveBeenCalledWith({
      fromUtcDate: "2026-06-18",
      toUtcDate: "2026-07-15",
    });
  });

  it("exposes syncing before the first refresh without reading zero aggregates", async () => {
    const adapter = fakeAdapter();
    const collector = fakeCollector(() =>
      Object.freeze({
        phase: "syncing",
        lastSuccessAt: null,
        consecutiveFailures: 0,
        canRetry: false,
      }),
    );
    const { address } = await startGateway(adapter, undefined, collector);
    const cookie = await bootstrap(address);

    const response = await collectorStatusRequest(address, cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      phase: "syncing",
      lastSuccessAt: null,
      consecutiveFailures: 0,
      canRetry: false,
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
        canRetry: true,
      }),
    );
    const adapter = fakeAdapter(async (range) =>
      responseFor(range, [[range.toUtcDate, 42]]),
    );
    const { address } = await startGateway(adapter, undefined, collector);
    const cookie = await bootstrap(address);

    await expect(
      (await collectorStatusRequest(address, cookie)).json(),
    ).resolves.toMatchObject({ phase: "stale", consecutiveFailures: 2 });
    const metrics = await apiRequest(address, cookie);
    expect(metrics.status).toBe(200);
    expect(await metrics.json()).toMatchObject({
      status: "healthy",
      totals: { today: 42, last7Days: 42, last28Days: 42 },
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
      requestRefresh,
    );
    const { address } = await startGateway(fakeAdapter(), undefined, collector);
    const cookie = await bootstrap(address);

    const first = collectorRefreshRequest(address, cookie);
    const duplicate = collectorRefreshRequest(address, cookie);
    await vi.waitFor(() => expect(requestRefresh).toHaveBeenCalledTimes(1));
    resolveRefresh(READY_COLLECTOR_STATUS);
    const [firstResponse, duplicateResponse] = await Promise.all([
      first,
      duplicate,
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
          detail: canary,
        }) as CompanionCollectorStatus,
      async () => {
        throw new Error(canary);
      },
    );
    const { address } = await startGateway(fakeAdapter(), undefined, collector);
    const cookie = await bootstrap(address);

    const statusResponse = await collectorStatusRequest(address, cookie);
    expect(statusResponse.status).toBe(503);
    const statusBody = await statusResponse.text();
    expect(statusBody).not.toContain(canary);
    expect(JSON.parse(statusBody)).toEqual({
      status: "error",
      error: "sidecar-unavailable",
    });

    const refreshResponse = await collectorRefreshRequest(address, cookie);
    expect(refreshResponse.status).toBe(503);
    const refreshBody = await refreshResponse.text();
    expect(refreshBody).not.toContain(canary);
    expect(JSON.parse(refreshBody)).toEqual({
      status: "error",
      error: "sidecar-unavailable",
    });
  });

  it("keeps metrics healthy and requests a manual choice when provider totals are unavailable", async () => {
    const adapter = fakeAdapter(
      async (range) => responseFor(range, [[range.toUtcDate, 12]]),
      async () => {
        throw new TokenTrackerAdapterError("incompatible-schema");
      },
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
        tiedProviderFamilies: [],
      },
      totals: { today: 12, last7Days: 12, last28Days: 12 },
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
          projectPath: "/must-not-cross-gateway",
        }) as TokenMonsterProviderTotals,
    );
    const { address } = await startGateway(adapter);
    const cookie = await bootstrap(address);

    const response = await apiRequest(address, cookie);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      status: "error",
      error: "sidecar-incompatible",
    });
  });

  it("rejects foreign Host, Origin, methods, query strings, and unauthenticated API reads", async () => {
    const adapter = fakeAdapter();
    const { address } = await startGateway(adapter);
    const cookie = await bootstrap(address);

    const foreignHost = await rawRequest(address, {
      path: "/api/companion",
      headers: { Host: `localhost:${address.port}`, Cookie: cookie },
    });
    expect(foreignHost.status).toBe(403);

    const foreignOrigin = await rawRequest(address, {
      path: "/api/companion",
      headers: {
        Host: `127.0.0.1:${address.port}`,
        Cookie: cookie,
        Origin: "https://attacker.invalid",
        "Sec-Fetch-Site": "cross-site",
      },
    });
    expect(foreignOrigin.status).toBe(403);

    const post = await rawRequest(address, {
      path: "/api/companion",
      method: "POST",
      headers: { Host: `127.0.0.1:${address.port}`, Cookie: cookie },
    });
    expect(post.status).toBe(405);
    expect(post.headers["access-control-allow-origin"]).toBeUndefined();

    const query = await rawRequest(address, {
      path: "/api/companion?from=2020-01-01&to=2099-01-01",
      headers: { Host: `127.0.0.1:${address.port}`, Cookie: cookie },
    });
    expect(query.status).toBe(404);

    const anonymous = await rawRequest(address, {
      path: "/api/companion",
      headers: { Host: `127.0.0.1:${address.port}` },
    });
    expect(anonymous.status).toBe(404);
    expect(adapter.getDaily).not.toHaveBeenCalled();
  });

  it("serves the root page for the exact pet view query and rejects every other query", async () => {
    const { address } = await startGateway(fakeAdapter());
    const host = { Host: `127.0.0.1:${address.port}` };

    // A query on the one-shot bootstrap path is rejected without consuming it.
    const bootstrapWithQuery = await rawRequest(address, {
      path: `${new URL(address.bootstrapUrl).pathname}?view=pet`,
      headers: host,
    });
    expect(bootstrapWithQuery.status).toBe(404);
    const cookie = await bootstrap(address);

    const petView = await rawRequest(address, {
      path: "/?view=pet",
      headers: { ...host, Cookie: cookie },
    });
    expect(petView.status).toBe(200);
    expect(petView.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(petView.body).toContain("<!doctype html>");

    const anonymousPetView = await rawRequest(address, {
      path: "/?view=pet",
      headers: host,
    });
    expect(anonymousPetView.status).toBe(404);

    for (const path of [
      "/?view=dashboard",
      "/?view=pet&extra=1",
      "/?View=pet",
      "/?view=%70et",
      "/index.html?view=pet",
      "/api/companion?view=pet",
    ]) {
      const rejected = await rawRequest(address, {
        path,
        headers: { ...host, Cookie: cookie },
      });
      expect(rejected.status).toBe(404);
    }
  });

  it("returns session-gated family and model analytics for fixed UTC windows", async () => {
    const getDailyFamilySeries = vi.fn<
      TokenTrackerAdapter["getDailyFamilySeries"]
    >(async (range) => familySeriesFor(range));
    const getModelUsage = vi.fn<TokenTrackerAdapter["getModelUsage"]>(
      async () =>
        Object.freeze({
          models: Object.freeze([
            Object.freeze({
              model: "claude-sonnet",
              family: "anthropic" as const,
              totalTokens: 20,
              inputTokens: 12,
              outputTokens: 8,
            }),
            Object.freeze({
              model: "gpt-5",
              family: "openai" as const,
              totalTokens: 10,
            }),
          ]),
        }),
    );
    const adapter = fakeAdapter(
      undefined,
      undefined,
      undefined,
      getDailyFamilySeries,
      getModelUsage,
    );
    const { address } = await startGateway(adapter);
    const cookie = await bootstrap(address);

    const families = await usageRequest(
      address,
      cookie,
      "/api/usage/families?window=7",
    );
    expect(families.status).toBe(200);
    expect(families.headers.get("cache-control")).toBe("no-store");
    const familiesBody =
      (await families.json()) as CompanionUsageFamiliesResponse;
    expect(familiesBody).toMatchObject({ window: 7 });
    expect(familiesBody.days).toHaveLength(7);
    expect(familiesBody.days.at(-1)).toEqual({
      utcDate: "2026-07-15",
      families: usageFamilyTotals(11),
    });
    expect(getDailyFamilySeries).toHaveBeenCalledWith({
      fromUtcDate: "2026-07-09",
      toUtcDate: "2026-07-15",
    });

    const models = await usageRequest(
      address,
      cookie,
      "/api/usage/models?window=28&limit=2",
    );
    expect(models.status).toBe(200);
    expect(models.headers.get("cache-control")).toBe("no-store");
    expect(await models.json()).toEqual({
      window: 28,
      models: [
        {
          model: "claude-sonnet",
          family: "anthropic",
          totalTokens: 20,
          inputTokens: 12,
          outputTokens: 8,
        },
        { model: "gpt-5", family: "openai", totalTokens: 10 },
      ],
    });
    expect(getModelUsage).toHaveBeenCalledWith({
      fromUtcDate: "2026-06-18",
      toUtcDate: "2026-07-15",
      limit: 2,
    });
  });

  it.each([
    "/api/usage/families",
    "/api/usage/families?window=14",
    "/api/usage/families?window=7&extra=1",
    "/api/usage/families?window=7&window=28",
    "/api/usage/models?window=7",
    "/api/usage/models?window=7&limit=0",
    "/api/usage/models?window=7&limit=51",
    "/api/usage/models?window=90&limit=1&extra=1",
  ])("rejects invalid usage analytics query %s", async (path) => {
    const adapter = fakeAdapter();
    const { address } = await startGateway(adapter);
    const cookie = await bootstrap(address);

    const response = await usageRequest(address, cookie, path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "request-rejected" });
    expect(adapter.getDailyFamilySeries).not.toHaveBeenCalled();
    expect(adapter.getModelUsage).not.toHaveBeenCalled();
  });

  it("gives unauthenticated usage routes the same indistinguishable 404 as characters", async () => {
    const adapter = fakeAdapter();
    const { address } = await startGateway(adapter);

    const [families, models, characters] = await Promise.all([
      usageRequest(address, null, "/api/usage/families?window=7"),
      usageRequest(address, null, "/api/usage/models?window=7&limit=5"),
      fetch(`${address.origin}/api/characters`),
    ]);
    expect([families.status, models.status, characters.status]).toEqual([
      404, 404, 404,
    ]);
    expect(await families.text()).toBe(await characters.text());
    expect(await models.json()).toEqual({ error: "request-rejected" });
    expect(adapter.getDailyFamilySeries).not.toHaveBeenCalled();
    expect(adapter.getModelUsage).not.toHaveBeenCalled();
  });

  it("maps usage adapter failures to generic envelopes without upstream detail", async () => {
    const canary = "/private/upstream/status-599";
    const adapter = fakeAdapter(
      undefined,
      undefined,
      undefined,
      async () => {
        throw new Error(canary);
      },
      async () => {
        throw new Error(canary);
      },
    );
    const { address } = await startGateway(adapter);
    const cookie = await bootstrap(address);

    for (const path of [
      "/api/usage/families?window=7",
      "/api/usage/models?window=7&limit=5",
    ]) {
      const response = await usageRequest(address, cookie, path);
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        status: "error",
        error: "sidecar-unavailable",
      });
      expect(body).not.toContain(canary);
    }
  });

  it("maps incompatible data and unavailable sidecars to stable safe errors", async () => {
    const incompatible = await startGateway(
      fakeAdapter(async (range) => ({
        ...responseFor(range),
        days: [
          {
            utcDate: range.toUtcDate,
            tokens: ledger(-1),
          },
        ],
      })),
    );
    const incompatibleCookie = await bootstrap(incompatible.address);
    const incompatibleResponse = await apiRequest(
      incompatible.address,
      incompatibleCookie,
    );
    expect(incompatibleResponse.status).toBe(502);
    expect(await incompatibleResponse.json()).toEqual({
      status: "error",
      error: "sidecar-incompatible",
    });

    const unavailable = await startGateway(
      fakeAdapter(async () => {
        throw new Error("sensitive upstream detail");
      }),
    );
    const unavailableCookie = await bootstrap(unavailable.address);
    const unavailableResponse = await apiRequest(
      unavailable.address,
      unavailableCookie,
    );
    expect(unavailableResponse.status).toBe(503);
    const unavailableBody = await unavailableResponse.text();
    expect(JSON.parse(unavailableBody)).toEqual({
      status: "error",
      error: "sidecar-unavailable",
    });
    expect(unavailableBody).not.toContain("sensitive upstream detail");
  });

  it("distinguishes adapter schema errors and bounds a stalled injected adapter", async () => {
    const incompatible = await startGateway(
      fakeAdapter(async () => {
        throw new TokenTrackerAdapterError("incompatible-schema");
      }),
    );
    const incompatibleCookie = await bootstrap(incompatible.address);
    const incompatibleResponse = await apiRequest(
      incompatible.address,
      incompatibleCookie,
    );
    expect(incompatibleResponse.status).toBe(502);

    const stalled = await startGateway(
      fakeAdapter(
        async () =>
          new Promise<TokenMonsterDailyAggregateResponse>(() => undefined),
      ),
      10,
    );
    const stalledCookie = await bootstrap(stalled.address);
    const stalledResponse = await apiRequest(stalled.address, stalledCookie);
    expect(stalledResponse.status).toBe(503);
    expect(await stalledResponse.json()).toEqual({
      status: "error",
      error: "sidecar-unavailable",
    });
  });

  it("session-gates character routes and returns the exact letter-mode roster DTO without a manifest", async () => {
    const { address } = await startGateway(
      fakeAdapter(),
      undefined,
      fakeCollector(),
      { manifest: null },
    );
    expect((await fetch(`${address.origin}/api/characters`)).status).toBe(404);

    const cookie = await bootstrap(address);
    const response = await characterRequest(address, cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const dto = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(dto)).toEqual([
      "status",
      "generatedAt",
      "unlockBatchId",
      "selection",
      "voiceEnabled",
      "characters",
    ]);
    expect(dto).toMatchObject({
      status: "ok",
      generatedAt: "2026-07-15T12:34:56.789Z",
      unlockBatchId: null,
      selection: { characterId: null, selectedBy: null },
      voiceEnabled: true,
    });
    const characters = dto["characters"] as Array<Record<string, unknown>>;
    expect(characters).toHaveLength(11);
    expect(characters.map((character) => character["characterId"])).toEqual([
      "chatgpt",
      "claude",
      "gemini",
      "grok",
      "deepseek",
      "qwen",
      "mistral",
      "venice",
      "sakana",
      "perplexity",
      "glm",
    ]);
    expect(
      characters.every(
        (character) =>
          (character["visual"] as { mode?: string }).mode === "letter",
      ),
    ).toBe(true);
    expect(
      characters.every((character) => character["activeThemeId"] === null),
    ).toBe(true);
    expect(Object.keys(characters[0]!)).toEqual([
      "characterId",
      "displayName",
      "kind",
      "unlocked",
      "unlockedAt",
      "isStarter",
      "starterPersona",
      "activeThemeId",
      "visual",
      "progress",
      "voiceLines",
    ]);
    expect(
      characters.slice(0, 4).map((character) => character["starterPersona"]),
    ).toEqual(
      listCharacters().map((character) => ({
        alias: character.alias,
        taglineZhTw: character.tagline["zh-TW"],
      })),
    );
    for (const character of characters.slice(0, 4)) {
      expect(Object.keys(character["starterPersona"] as object)).toEqual([
        "alias",
        "taglineZhTw",
      ]);
    }
    expect(
      characters
        .slice(4)
        .every((character) => character["starterPersona"] === null),
    ).toBe(true);
    expect(Object.keys(characters[0]!["visual"] as object)).toEqual([
      "mode",
      "glyph",
      "background",
      "foreground",
      "accent",
      "themes",
    ]);
    const letterThemes = (
      characters[0]!["visual"] as { themes: Array<Record<string, unknown>> }
    ).themes;
    expect(letterThemes).toHaveLength(20);
    expect(letterThemes.map((theme) => theme["themeId"])).toEqual(
      WARDROBE_THEME_IDS,
    );
    expect(letterThemes.every((theme) => theme["unlocked"] === false)).toBe(
      true,
    );
    expect(Object.keys(letterThemes[0]!)).toEqual([
      "themeId",
      "displayName",
      "accessibleLabel",
      "unlocked",
      "palette",
      "pattern",
      "accent",
    ]);
    expect(Object.keys(letterThemes[0]!["palette"] as object)).toEqual([
      "background",
      "foreground",
      "accent",
    ]);
    expect(Object.keys(letterThemes[0]!["pattern"] as object)).toEqual([
      "id",
      "label",
      "density",
    ]);
    expect(Object.keys(letterThemes[0]!["accent"] as object)).toEqual([
      "id",
      "label",
      "placement",
    ]);
    expect(letterThemes).toEqual(
      LETTER_WARDROBE_CATALOG.map((theme) => ({ ...theme, unlocked: false })),
    );
    expect(parseCharactersSnapshot(dto).characters).toHaveLength(11);
    expect(JSON.stringify(dto)).not.toContain("providerId");
  });

  it("serves all four clean-install starter avatars without unlocking their wardrobes", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-starter-avatars-"),
    );
    temporaryDirectories.push(directory);
    const cacheDirectory = join(directory, "asset-cache");
    const starterAssets = {
      chatgpt: {
        avatarBody: Buffer.from("chatgpt-starter-avatar"),
        outfitBody: Buffer.from("chatgpt-locked-outfit"),
      },
      claude: {
        avatarBody: Buffer.from("claude-starter-avatar"),
        outfitBody: Buffer.from("claude-locked-outfit"),
      },
      gemini: {
        avatarBody: Buffer.from("gemini-starter-avatar"),
        outfitBody: Buffer.from("gemini-locked-outfit"),
      },
      grok: {
        avatarBody: Buffer.from("grok-starter-avatar"),
        outfitBody: Buffer.from("grok-locked-outfit"),
      },
    } satisfies Record<
      StarterCharacterId,
      Readonly<{ avatarBody: Buffer; outfitBody: Buffer }>
    >;
    const manifest = starterCharacterManifest(starterAssets);
    await mkdir(cacheDirectory, { recursive: true });
    await Promise.all(
      Object.values(starterAssets).flatMap(({ avatarBody, outfitBody }) =>
        [avatarBody, outfitBody].map((body) =>
          writeFile(join(cacheDirectory, `${sha256(body)}.webp`), body),
        ),
      ),
    );
    const { address } = await startGateway(
      fakeAdapter(),
      undefined,
      fakeCollector(),
      { manifest, cacheDirectory },
    );
    const cookie = await bootstrap(address);

    const snapshot = parseCharactersSnapshot(
      await (await characterRequest(address, cookie)).json(),
    );
    expect(snapshot.selection).toEqual({ characterId: null, selectedBy: null });
    const starters = snapshot.characters.filter(
      (character) => character.isStarter,
    );
    expect(starters.map((character) => character.characterId)).toEqual(
      STARTER_CHARACTER_IDS,
    );

    const starterAvatarPaths = new Map<StarterCharacterId, string>();
    for (const starter of starters) {
      expect(starter).toMatchObject({
        unlocked: false,
        activeThemeId: null,
        visual: { mode: "doll" },
      });
      expect(starter.visual.themes.every((theme) => !theme.unlocked)).toBe(
        true,
      );
      expect(starter.visual.mode).toBe("doll");
      if (starter.visual.mode !== "doll") continue;
      starterAvatarPaths.set(
        starter.characterId as StarterCharacterId,
        starter.visual.avatarPath,
      );
      const avatar = await fetch(
        `${address.origin}${starter.visual.avatarPath}`,
        { headers: { Cookie: cookie } },
      );
      expect(avatar.status).toBe(200);
      expect(Buffer.from(await avatar.arrayBuffer())).toEqual(
        starterAssets[starter.characterId as StarterCharacterId].avatarBody,
      );
      const outfit = await fetch(
        `${address.origin}${starter.visual.themes[0]!.outfitPath}`,
        { headers: { Cookie: cookie } },
      );
      expect(outfit.status).toBe(404);
    }

    const selected = await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "chatgpt" }),
    );
    expect(selected.status).toBe(200);
    const afterSelection = parseCharactersSnapshot(
      await (await characterRequest(address, cookie)).json(),
    );
    expect(
      afterSelection.characters
        .filter((character) => character.isStarter)
        .map((character) => [character.characterId, character.visual.mode]),
    ).toEqual([
      ["chatgpt", "doll"],
      ["claude", "letter"],
      ["gemini", "letter"],
      ["grok", "letter"],
    ]);
    for (const characterId of STARTER_CHARACTER_IDS) {
      const avatarPath = starterAvatarPaths.get(characterId);
      expect(avatarPath).toBeDefined();
      const avatar = await fetch(`${address.origin}${avatarPath}`, {
        headers: { Cookie: cookie },
      });
      expect(avatar.status).toBe(characterId === "chatgpt" ? 200 : 404);
      if (characterId === "chatgpt") {
        expect(Buffer.from(await avatar.arrayBuffer())).toEqual(
          starterAssets.chatgpt.avatarBody,
        );
      }
    }
  });

  it("serves verified built-in starter bytes without creating an asset cache", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-built-in-starters-"),
    );
    temporaryDirectories.push(directory);
    const cacheDirectory = join(directory, "asset-cache");
    const starterAssets = {
      chatgpt: {
        avatarBody: webpFixture("chatgpt-base-avatar"),
        outfitBody: webpFixture("chatgpt-base-outfit"),
      },
      claude: {
        avatarBody: webpFixture("claude-base-avatar"),
        outfitBody: webpFixture("claude-base-outfit"),
      },
      gemini: {
        avatarBody: webpFixture("gemini-base-avatar"),
        outfitBody: webpFixture("gemini-base-outfit"),
      },
      grok: {
        avatarBody: webpFixture("grok-base-avatar"),
        outfitBody: webpFixture("grok-base-outfit"),
      },
    } satisfies Record<
      StarterCharacterId,
      Readonly<{ avatarBody: Buffer; outfitBody: Buffer }>
    >;
    const manifest = starterCharacterManifest(starterAssets);
    const objects = embeddedObjects(
      manifest,
      Object.values(starterAssets).flatMap(({ avatarBody, outfitBody }) => [
        avatarBody,
        outfitBody,
      ]),
    );
    const originalChatgptAvatar = Buffer.from(starterAssets.chatgpt.avatarBody);
    const { address } = await startGateway(
      fakeAdapter(),
      undefined,
      fakeCollector(),
      {
        manifest: null,
        baseAssets: { manifest, objects },
        cacheDirectory,
      },
    );
    // Gateway construction copies verified bytes instead of retaining a
    // mutable host-owned view.
    starterAssets.chatgpt.avatarBody.fill(0);
    const cookie = await bootstrap(address);

    const snapshot = parseCharactersSnapshot(
      await (await characterRequest(address, cookie)).json(),
    );
    for (const characterId of STARTER_CHARACTER_IDS) {
      const character = snapshot.characters.find(
        (candidate) => candidate.characterId === characterId,
      );
      expect(character?.visual.mode).toBe("doll");
      if (character?.visual.mode !== "doll") continue;
      const avatar = await fetch(
        `${address.origin}${character.visual.avatarPath}`,
        { headers: { Cookie: cookie } },
      );
      expect(avatar.status).toBe(200);
      const avatarBody = Buffer.from(await avatar.arrayBuffer());
      if (characterId === "chatgpt") {
        expect(avatarBody).toEqual(originalChatgptAvatar);
      }
      const lockedOutfit = await fetch(
        `${address.origin}${character.visual.themes[0]!.outfitPath}`,
        { headers: { Cookie: cookie } },
      );
      expect(lockedOutfit.status).toBe(404);
    }
    await expect(access(cacheDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });

    expect(
      (
        await characterPost(
          address,
          cookie,
          "select",
          JSON.stringify({ characterId: "chatgpt" }),
        )
      ).status,
    ).toBe(200);
    const selected = parseCharactersSnapshot(
      await (await characterRequest(address, cookie)).json(),
    ).characters.find((character) => character.characterId === "chatgpt");
    expect(selected).toMatchObject({
      activeThemeId: "tech",
      visual: { mode: "doll" },
    });
    if (selected?.visual.mode !== "doll") {
      throw new Error("expected built-in starter doll");
    }
    const outfit = await fetch(
      `${address.origin}${selected.visual.themes[0]!.outfitPath}`,
      { headers: { Cookie: cookie } },
    );
    expect(outfit.status).toBe(200);
    expect(Buffer.from(await outfit.arrayBuffer())).toEqual(
      starterAssets.chatgpt.outfitBody,
    );
    await expect(access(cacheDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps only built-in starter avatars available behind a stale progression lock", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-built-in-starters-stale-lock-"),
    );
    temporaryDirectories.push(directory);
    const progressionStorePath = join(directory, "progression-v1.json");
    const cacheDirectory = join(directory, "asset-cache");
    const starterAssets = {
      chatgpt: {
        avatarBody: webpFixture("chatgpt-stale-lock-avatar"),
        outfitBody: webpFixture("chatgpt-stale-lock-outfit"),
      },
      claude: {
        avatarBody: webpFixture("claude-stale-lock-avatar"),
        outfitBody: webpFixture("claude-stale-lock-outfit"),
      },
      gemini: {
        avatarBody: webpFixture("gemini-stale-lock-avatar"),
        outfitBody: webpFixture("gemini-stale-lock-outfit"),
      },
      grok: {
        avatarBody: webpFixture("grok-stale-lock-avatar"),
        outfitBody: webpFixture("grok-stale-lock-outfit"),
      },
    } satisfies Record<
      StarterCharacterId,
      Readonly<{ avatarBody: Buffer; outfitBody: Buffer }>
    >;
    const manifest = starterCharacterManifest(starterAssets);
    const objects = embeddedObjects(
      manifest,
      Object.values(starterAssets).flatMap(({ avatarBody, outfitBody }) => [
        avatarBody,
        outfitBody,
      ]),
    );
    const { address } = await startGateway(
      fakeAdapter(),
      undefined,
      fakeCollector(),
      {
        manifest: null,
        baseAssets: { manifest, objects },
        cacheDirectory,
        progressionStorePath,
      },
    );
    const lockPath = `${progressionStorePath}.lock`;
    await writeFile(lockPath, "", { encoding: "utf8", mode: 0o600 });
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);
    const cookie = await bootstrap(address);

    const snapshot = parseCharactersSnapshot(
      await (await characterRequest(address, cookie)).json(),
    );
    expect(snapshot.selection).toEqual({ characterId: null, selectedBy: null });
    for (const characterId of STARTER_CHARACTER_IDS) {
      const character = snapshot.characters.find(
        (candidate) => candidate.characterId === characterId,
      );
      expect(character).toMatchObject({
        unlocked: false,
        activeThemeId: null,
        visual: { mode: "doll" },
      });
      if (character?.visual.mode !== "doll") continue;
      const avatar = await fetch(
        `${address.origin}${character.visual.avatarPath}`,
        { headers: { Cookie: cookie } },
      );
      expect(avatar.status).toBe(200);
      expect(Buffer.from(await avatar.arrayBuffer())).toEqual(
        starterAssets[characterId].avatarBody,
      );
      const lockedOutfit = await fetch(
        `${address.origin}${character.visual.themes[0]!.outfitPath}`,
        { headers: { Cookie: cookie } },
      );
      expect(lockedOutfit.status).toBe(404);
    }
    expect(
      snapshot.characters
        .filter((character) => !character.isStarter)
        .every((character) => character.visual.mode === "letter"),
    ).toBe(true);
    await expect(access(cacheDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(lockPath, "utf8")).resolves.toBe("");
  }, 10_000);

  it("never exposes an active full-pack object through the stale-lock base fallback", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-full-pack-stale-lock-"),
    );
    temporaryDirectories.push(directory);
    const progressionStorePath = join(directory, "progression-v1.json");
    const cacheDirectory = join(directory, "asset-cache");
    const baseAvatar = webpFixture("base-stale-lock-avatar");
    const baseOutfit = webpFixture("base-stale-lock-outfit");
    const baseManifest = characterManifest(baseAvatar, [
      { themeId: "tech", outfitBody: baseOutfit },
    ]);
    const fullAvatar = webpFixture("full-stale-lock-avatar");
    const fullOutfit = webpFixture("full-stale-lock-outfit");
    const fullManifest = characterManifest(fullAvatar, [
      { themeId: "tech", outfitBody: fullOutfit },
    ]);
    await mkdir(cacheDirectory, { recursive: true });
    await Promise.all(
      [fullAvatar, fullOutfit].map((body) =>
        writeFile(join(cacheDirectory, `${sha256(body)}.webp`), body),
      ),
    );
    const service = createCharacterService({
      adapter: fakeAdapter(),
      characters: normalizeCharacterOptions({
        manifest: null,
        baseAssets: {
          manifest: baseManifest,
          objects: embeddedObjects(baseManifest, [baseAvatar, baseOutfit]),
        },
        assetPack: null,
        cacheDirectory,
        cdnBaseUrl: null,
        progressionStorePath,
      }),
      clock: () => new Date("2026-07-15T12:34:56.789Z"),
    });
    // This is the same manifest transition performed by an installed,
    // consented full pack before the legacy progression lock is encountered.
    service.setManifest(fullManifest);
    const lockPath = `${progressionStorePath}.lock`;
    await writeFile(lockPath, "", { encoding: "utf8", mode: 0o600 });

    const snapshot = parseCharactersSnapshot(await service.getCharactersDto());
    const chatgpt = snapshot.characters.find(
      (character) => character.characterId === "chatgpt",
    );
    expect(chatgpt).toMatchObject({
      unlocked: false,
      activeThemeId: null,
      visual: {
        mode: "doll",
        avatarPath: `/assets/characters/${objectRef(baseAvatar, "webp").path}`,
      },
    });
    const fileName = (body: Uint8Array): string =>
      objectRef(body, "webp").path.slice("objects/".length);
    await expect(service.getAsset(fileName(baseAvatar))).resolves.toMatchObject(
      {
        status: 200,
        body: baseAvatar,
      },
    );
    await expect(service.getAsset(fileName(baseOutfit))).resolves.toEqual({
      status: 404,
    });
    for (const body of [fullAvatar, fullOutfit]) {
      const result = await service.getAsset(fileName(body));
      expect(result.status).not.toBe(200);
      expect(result.body).toBeUndefined();
    }
    await expect(readFile(lockPath, "utf8")).resolves.toBe("");
  });

  it("serves an exact fail-closed asset-pack status/control contract", async () => {
    const { address } = await startGateway();
    expect(
      (await fetch(`${address.origin}/api/characters/assets`)).status,
    ).toBe(404);
    const cookie = await bootstrap(address);

    const statusResponse = await fetch(
      `${address.origin}/api/characters/assets`,
      { headers: { Cookie: cookie, Origin: address.origin } },
    );
    expect(statusResponse.status).toBe(200);
    const status = (await statusResponse.json()) as Record<string, unknown>;
    expect(Object.keys(status)).toEqual([
      "status",
      "phase",
      "consented",
      "enabled",
      "releaseId",
      "downloadBytes",
      "lastError",
    ]);
    expect(parseCharacterAssetPackStatus(status)).toEqual({
      status: "ok",
      phase: "unavailable",
      consented: false,
      enabled: false,
      releaseId: null,
      downloadBytes: null,
      lastError: null,
    });

    const control = await fetch(
      `${address.origin}/api/characters/assets/consent`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: address.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(control.status).toBe(200);
    expect(parseCharacterAssetPackStatus(await control.json()).phase).toBe(
      "unavailable",
    );

    const extraKey = await fetch(
      `${address.origin}/api/characters/assets/consent`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: address.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: true, characterId: "glm" }),
      },
    );
    expect(extraKey.status).toBe(400);
    await expect(extraKey.json()).resolves.toEqual({
      status: "error",
      error: "invalid-request",
    });

    const queryBearing = await rawRequest(address, {
      path: "/api/characters/assets?characterId=glm",
      headers: {
        Host: `127.0.0.1:${address.port}`,
        Cookie: cookie,
        Origin: address.origin,
      },
    });
    expect(queryBearing.status).toBe(404);
    expect(JSON.parse(queryBearing.body)).toEqual({
      error: "request-rejected",
    });
  });

  it("accepts the embedded approved pack as available and default-off", async () => {
    const configuration = getApprovedAssetPackConfiguration();
    expect(configuration).not.toBeNull();
    const { address } = await startGateway(undefined, undefined, undefined, {
      manifest: null,
      assetPack: configuration,
    });
    const cookie = await bootstrap(address);

    const response = await fetch(`${address.origin}/api/characters/assets`, {
      headers: { Cookie: cookie, Origin: address.origin },
    });
    expect(response.status).toBe(200);
    expect(parseCharacterAssetPackStatus(await response.json())).toEqual({
      status: "ok",
      phase: "available",
      consented: false,
      enabled: false,
      releaseId: "ai-sister-images-11-2026.07.21",
      downloadBytes: 65_574_180,
      lastError: null,
    });
  });

  it("derives an exact 28-day UTC player profile without asserting provider traits", async () => {
    const adapter = fakeAdapter();
    vi.mocked(adapter.getDailyContentBlindFootprint).mockImplementation(
      async (query) =>
        profileFootprint(query.fromUtcDate, query.toUtcDate, 14, 1, 100),
    );
    const { address } = await startGateway(adapter);

    expect(
      (await fetch(`${address.origin}/api/characters/profile`)).status,
    ).toBe(404);
    expect(adapter.getDailyContentBlindFootprint).not.toHaveBeenCalled();
    const cookie = await bootstrap(address);

    const response = await characterProfileRequest(address, cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const dto = (await response.json()) as CompanionCharacterProfileResponse;
    expect(Object.keys(dto)).toEqual([
      "status",
      "schemaVersion",
      "generatedAt",
      "freshness",
      "dataQuality",
      "window",
      "identity",
      "mood",
      "evolution",
      "reasons",
    ]);
    expect(Object.keys(dto.window)).toEqual([
      "fromUtcDate",
      "toUtcDate",
      "timezone",
    ]);
    expect(Object.keys(dto.identity)).toEqual([
      "status",
      "coverageBand",
      "provisional",
      "traitIds",
    ]);
    expect(Object.keys(dto.mood)).toEqual(["id", "energyBand"]);
    expect(Object.keys(dto.evolution)).toEqual(["cadence", "event"]);
    expect(dto.reasons.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(dto.reasons[0]!)).toEqual([
      "subject",
      "reasonCode",
      "templateId",
      "inputs",
    ]);
    expect(Object.keys(dto.reasons[0]!.inputs[0]!)).toEqual([
      "metric",
      "valueBand",
      "coverage",
    ]);
    expect(dto).toMatchObject({
      status: "ok",
      schemaVersion: "1",
      generatedAt: "2026-07-15T12:34:56.789Z",
      freshness: "fresh",
      dataQuality: "estimated-positive-days",
      window: {
        fromUtcDate: "2026-06-18",
        toUtcDate: "2026-07-15",
        timezone: "UTC",
      },
      identity: {
        status: "ready",
        coverageBand: "partial",
        provisional: false,
      },
      mood: { id: "steady", energyBand: "medium" },
    });
    expect(dto.identity.traitIds).toContain("cli-focused");
    expect(dto.identity.traitIds).not.toEqual(
      expect.arrayContaining([
        "provider-focused",
        "multi-provider",
        "balanced",
      ]),
    );
    expect(dto.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: "mood",
          reasonCode: "MOOD_RELATIVE_ACTIVITY_STABLE",
        }),
      ]),
    );
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toMatch(
      /provider-focused|multi-provider|balanced|top-provider-share|TRAIT_PROVIDER/u,
    );
    expect(serialized).not.toMatch(
      /totalTokens|inputTokens|outputTokens|modelFamily|projectPath/u,
    );
    expect(adapter.getDailyContentBlindFootprint).toHaveBeenCalledTimes(1);
    expect(adapter.getDailyContentBlindFootprint).toHaveBeenCalledWith({
      fromUtcDate: "2026-06-18",
      toUtcDate: "2026-07-15",
      characterId: "chatgpt",
    });

    const queryBearing = await rawRequest(address, {
      path: "/api/characters/profile?window=90",
      headers: {
        Host: `127.0.0.1:${address.port}`,
        Cookie: cookie,
        Origin: address.origin,
      },
    });
    expect(queryBearing.status).toBe(404);
    expect(adapter.getDailyContentBlindFootprint).toHaveBeenCalledTimes(1);

    const post = await rawRequest(address, {
      path: "/api/characters/profile",
      method: "POST",
      headers: {
        Host: `127.0.0.1:${address.port}`,
        Cookie: cookie,
        Origin: address.origin,
      },
    });
    expect(post.status).toBe(405);
    expect(post.headers["allow"]).toBe("GET");
  });

  it("coalesces concurrent profile reads into one bounded sidecar operation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = fakeAdapter();
    vi.mocked(adapter.getDailyContentBlindFootprint).mockImplementation(
      async (query) => {
        await gate;
        return profileFootprint(query.fromUtcDate, query.toUtcDate);
      },
    );
    const { address } = await startGateway(adapter);
    const cookie = await bootstrap(address);

    const first = characterProfileRequest(address, cookie);
    const second = characterProfileRequest(address, cookie);
    await vi.waitFor(() =>
      expect(adapter.getDailyContentBlindFootprint).toHaveBeenCalledTimes(1),
    );
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await Promise.all(responses.map(async (response) => response.json()));
    expect(adapter.getDailyContentBlindFootprint).toHaveBeenCalledTimes(1);
  });

  it("carries strict profile continuity into the next UTC-day window", async () => {
    let nowMs = Date.parse("2026-07-15T12:34:56.789Z");
    const adapter = fakeAdapter();
    vi.mocked(adapter.getDailyContentBlindFootprint).mockImplementation(
      async (query) => profileFootprint(query.fromUtcDate, query.toUtcDate),
    );
    const { address } = await startGateway(
      adapter,
      undefined,
      fakeCollector(),
      {},
      () => new Date(nowMs),
    );
    const cookie = await bootstrap(address);

    const initial = (await (
      await characterProfileRequest(address, cookie)
    ).json()) as CompanionCharacterProfileResponse;
    expect(initial.evolution).toEqual({
      cadence: "event",
      event: "initial-profile",
    });

    nowMs += 24 * 60 * 60 * 1_000;
    const nextDay = (await (
      await characterProfileRequest(address, cookie)
    ).json()) as CompanionCharacterProfileResponse;
    expect(nextDay).toMatchObject({
      freshness: "fresh",
      window: {
        fromUtcDate: "2026-06-19",
        toUtcDate: "2026-07-16",
        timezone: "UTC",
      },
      identity: { status: "ready", provisional: false },
      evolution: { cadence: "none", event: "no-change" },
    });
    expect(adapter.getDailyContentBlindFootprint).toHaveBeenNthCalledWith(2, {
      fromUtcDate: "2026-06-19",
      toUtcDate: "2026-07-16",
      characterId: "chatgpt",
    });
  });

  it("uses only a recent strict local profile snapshot when the sidecar is temporarily unavailable", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-character-profile-"),
    );
    temporaryDirectories.push(directory);
    const progressionStorePath = join(directory, "progression-v1.json");
    const profilePath = join(directory, "character-profile-v1.json");
    let nowMs = Date.parse("2026-07-15T12:34:56.789Z");
    const canary = "/private/upstream/profile-canary";
    const adapter = fakeAdapter();
    vi.mocked(adapter.getDailyContentBlindFootprint).mockImplementation(
      async (query) => profileFootprint(query.fromUtcDate, query.toUtcDate),
    );
    const { address } = await startGateway(
      adapter,
      undefined,
      fakeCollector(),
      { progressionStorePath },
      () => new Date(nowMs),
    );
    const cookie = await bootstrap(address);

    const fresh = await characterProfileRequest(address, cookie);
    expect(fresh.status).toBe(200);
    await expect(fresh.json()).resolves.toMatchObject({ freshness: "fresh" });
    expect((await stat(profilePath)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await readFile(profilePath, "utf8")) as object;
    expect(Object.keys(stored)).toEqual([
      "schemaVersion",
      "computedAt",
      "derivation",
    ]);
    expect(JSON.stringify(stored)).not.toContain("tokens");

    nowMs += 60 * 60 * 1_000;
    vi.mocked(adapter.getDailyContentBlindFootprint).mockRejectedValue(
      new Error(canary),
    );
    const stale = await characterProfileRequest(address, cookie);
    expect(stale.status).toBe(200);
    const staleBody = await stale.text();
    expect(staleBody).not.toContain(canary);
    expect(JSON.parse(staleBody)).toMatchObject({
      status: "ok",
      generatedAt: "2026-07-15T13:34:56.789Z",
      freshness: "stale",
      window: { fromUtcDate: "2026-06-18", toUtcDate: "2026-07-15" },
    });

    await writeFile(
      profilePath,
      `${JSON.stringify({ ...stored, unexpected: true })}\n`,
      { mode: 0o600 },
    );
    const rejected = await characterProfileRequest(address, cookie);
    expect(rejected.status).toBe(503);
    const rejectedBody = await rejected.text();
    expect(rejectedBody).not.toContain(canary);
    expect(JSON.parse(rejectedBody)).toEqual({
      status: "error",
      error: "sidecar-unavailable",
    });

    await writeFile(profilePath, `${JSON.stringify(stored)}\n`, {
      mode: 0o600,
    });
    nowMs += 49 * 60 * 60 * 1_000;
    const expired = await characterProfileRequest(address, cookie);
    expect(expired.status).toBe(503);
    expect(await expired.json()).toEqual({
      status: "error",
      error: "sidecar-unavailable",
    });
  });

  it("keeps a profile in learning mode when positive-day coverage is insufficient", async () => {
    const adapter = fakeAdapter();
    vi.mocked(adapter.getDailyContentBlindFootprint).mockImplementation(
      async (query) => profileFootprint(query.fromUtcDate, query.toUtcDate, 6),
    );
    const { address } = await startGateway(adapter);
    const cookie = await bootstrap(address);

    const response = await characterProfileRequest(address, cookie);
    expect(response.status).toBe(200);
    const dto = (await response.json()) as CompanionCharacterProfileResponse;
    expect(dto.identity).toEqual({
      status: "learning",
      coverageBand: "insufficient",
      provisional: false,
      traitIds: [],
    });
    expect(dto.mood).toEqual({ id: "learning", energyBand: "dormant" });
    expect(dto.evolution).toEqual({
      cadence: "event",
      event: "awaiting-coverage",
    });
    expect(dto.reasons.every((reason) => reason.subject !== "trait")).toBe(
      true,
    );

    const sameWindow = await characterProfileRequest(address, cookie);
    expect(sameWindow.status).toBe(200);
    const sameWindowDto =
      (await sameWindow.json()) as CompanionCharacterProfileResponse;
    expect(sameWindowDto.identity.status).toBe("learning");
    expect(sameWindowDto.evolution).toEqual({
      cadence: "event",
      event: "awaiting-coverage",
    });
    expect(() => parseCharacterProfileResponse(sameWindowDto)).not.toThrow();
  });

  it("serves and persists unlocked code-native wardrobe themes without raster assets", async () => {
    const { address } = await startGateway(
      adapterWithExactOpenAiLifetime(5_000),
    );
    const cookie = await bootstrap(address);

    expect((await apiRequest(address, cookie)).status).toBe(200);
    const response = await characterRequest(address, cookie);
    expect(response.status).toBe(200);
    const dto = (await response.json()) as {
      characters: Array<Record<string, unknown>>;
    };
    const chatgpt = dto.characters.find(
      (character) => character["characterId"] === "chatgpt",
    );
    expect(chatgpt).toMatchObject({
      unlocked: true,
      activeThemeId: "tech",
      visual: {
        mode: "letter",
        background: "#0B1F33",
        foreground: "#F8FAFC",
        accent: "#5EEAD4",
      },
      progress: { value: 0.5 },
    });
    const initialThemes = (
      chatgpt?.["visual"] as { themes: Array<Record<string, unknown>> }
    ).themes;
    expect(
      initialThemes
        .filter((theme) => theme["unlocked"] === true)
        .map((theme) => theme["themeId"]),
    ).toEqual(["tech", "finance"]);

    const wardrobe = await characterPost(
      address,
      cookie,
      "wardrobe",
      JSON.stringify({ characterId: "chatgpt", themeId: "finance" }),
    );
    expect(wardrobe.status).toBe(200);
    expect(await wardrobe.json()).toEqual({
      status: "ok",
      characterId: "chatgpt",
      activeThemeId: "finance",
    });

    const afterSelection = (await (
      await characterRequest(address, cookie)
    ).json()) as { characters: Array<Record<string, unknown>> };
    expect(afterSelection.characters[0]).toMatchObject({
      characterId: "chatgpt",
      activeThemeId: "finance",
      visual: {
        mode: "letter",
        background: "#102A1F",
        foreground: "#F8FAFC",
        accent: "#86EFAC",
      },
    });

    const lockedTheme = await characterPost(
      address,
      cookie,
      "wardrobe",
      JSON.stringify({ characterId: "chatgpt", themeId: "politics" }),
    );
    expect(lockedTheme.status).toBe(409);
    expect(await lockedTheme.json()).toEqual({
      status: "error",
      error: "locked",
    });
  });

  it("falls back to built-in tech art without overwriting a non-tech preference", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-built-in-theme-fallback-"),
    );
    temporaryDirectories.push(directory);
    const progressionStorePath = join(directory, "progression-v1.json");
    const adapter = adapterWithExactOpenAiLifetime(5_000);
    const fullAvatar = webpFixture("full-avatar");
    const first = await startGateway(adapter, undefined, fakeCollector(), {
      manifest: characterManifest(fullAvatar, [
        { themeId: "tech", outfitBody: webpFixture("full-tech") },
        { themeId: "finance", outfitBody: webpFixture("full-finance") },
      ]),
      progressionStorePath,
    });
    const firstCookie = await bootstrap(first.address);
    expect((await apiRequest(first.address, firstCookie)).status).toBe(200);
    expect(
      (
        await characterPost(
          first.address,
          firstCookie,
          "wardrobe",
          JSON.stringify({ characterId: "chatgpt", themeId: "finance" }),
        )
      ).status,
    ).toBe(200);
    await first.gateway.close();

    const baseAvatar = webpFixture("base-avatar");
    const baseOutfit = webpFixture("base-tech");
    const baseManifest = characterManifest(baseAvatar, [
      { themeId: "tech", outfitBody: baseOutfit },
    ]);
    const second = await startGateway(adapter, undefined, fakeCollector(), {
      manifest: null,
      baseAssets: {
        manifest: baseManifest,
        objects: embeddedObjects(baseManifest, [baseAvatar, baseOutfit]),
      },
      progressionStorePath,
    });
    const secondCookie = await bootstrap(second.address);
    const chatgpt = parseCharactersSnapshot(
      await (await characterRequest(second.address, secondCookie)).json(),
    ).characters.find((character) => character.characterId === "chatgpt");
    expect(chatgpt).toMatchObject({
      activeThemeId: "tech",
      visual: { mode: "doll" },
    });
    expect(
      JSON.parse(
        await readFile(
          join(directory, "character-preferences-v1.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      activeThemeByCharacter: { chatgpt: "finance" },
    });
  });

  it("uses the GLM lifetime wardrobe ladder with the same future doll preference", async () => {
    const avatarBody = Buffer.from("glm-avatar");
    const { address } = await startGateway(
      adapterWithExactOpenAiLifetime(5_000_000),
      undefined,
      fakeCollector(),
      {
        manifest: characterManifest(
          avatarBody,
          [{ themeId: "tech", outfitBody: Buffer.from("glm-tech-outfit") }],
          "glm",
        ),
      },
    );
    const cookie = await bootstrap(address);

    expect((await apiRequest(address, cookie)).status).toBe(200);
    const dto = (await (await characterRequest(address, cookie)).json()) as {
      characters: Array<Record<string, unknown>>;
    };
    const glm = dto.characters.find(
      (character) => character["characterId"] === "glm",
    );
    expect(glm).toMatchObject({
      unlocked: true,
      activeThemeId: "tech",
      visual: { mode: "doll" },
      progress: { value: 5_000_000 / 5_250_000 },
    });
    const wardrobe = await characterPost(
      address,
      cookie,
      "wardrobe",
      JSON.stringify({ characterId: "glm", themeId: "tech" }),
    );
    expect(wardrobe.status).toBe(200);
    expect(await wardrobe.json()).toEqual({
      status: "ok",
      characterId: "glm",
      activeThemeId: "tech",
    });
  });

  it("atomically turns one clean-install starter choice into the first unlocked companion", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-first-starter-choice-"),
    );
    temporaryDirectories.push(directory);
    const progressionStorePath = join(directory, "progression-v1.json");
    const historicalUsageAdapter = fakeAdapter(
      async (range) => responseFor(range, [[range.toUtcDate, 250]]),
      async () =>
        Object.freeze({ openai: 0, anthropic: 250, google: 0, xai: 0 }),
      async () =>
        Object.freeze({
          ...progressionTotals(0),
          anthropic: 250,
        }),
    );
    const { address } = await startGateway(
      historicalUsageAdapter,
      undefined,
      fakeCollector(),
      { progressionStorePath },
    );
    const cookie = await bootstrap(address);

    // The first metrics read synchronizes real historical usage before the
    // roster is opened.  It may unlock Claude, but must not choose Claude on
    // the player's behalf or hide the other starter choices.
    expect((await apiRequest(address, cookie)).status).toBe(200);

    const initial = parseCharactersSnapshot(
      await (await characterRequest(address, cookie)).json(),
    );
    expect(initial.selection).toEqual({
      characterId: null,
      selectedBy: null,
    });
    expect(
      initial.characters
        .filter((character) => character.isStarter)
        .filter((character) => character.unlocked)
        .map((character) => character.characterId),
    ).toEqual(["claude"]);

    const attempts = await Promise.all([
      characterPost(
        address,
        cookie,
        "select",
        JSON.stringify({ characterId: "chatgpt" }),
      ),
      characterPost(
        address,
        cookie,
        "select",
        JSON.stringify({ characterId: "gemini" }),
      ),
    ]);
    expect(attempts.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const successfulIndex = attempts.findIndex(
      (response) => response.status === 200,
    );
    const winner = successfulIndex === 0 ? "chatgpt" : "gemini";
    await expect(attempts[successfulIndex]!.json()).resolves.toEqual({
      status: "ok",
      selection: { characterId: winner, selectedBy: "manual" },
    });
    await expect(attempts[1 - successfulIndex]!.json()).resolves.toEqual({
      status: "error",
      error: "locked",
    });

    const selected = parseCharactersSnapshot(
      await (await characterRequest(address, cookie)).json(),
    );
    expect(selected.selection).toEqual({
      characterId: winner,
      selectedBy: "manual",
    });
    expect(
      selected.characters
        .filter((character) => character.isStarter && character.unlocked)
        .map((character) => character.characterId),
    ).toEqual(
      ["claude", winner].sort(
        (left, right) =>
          initial.characters.findIndex((entry) => entry.characterId === left) -
          initial.characters.findIndex((entry) => entry.characterId === right),
      ),
    );

    const restarted = await startGateway(
      historicalUsageAdapter,
      undefined,
      fakeCollector(),
      { progressionStorePath },
    );
    const restartedCookie = await bootstrap(restarted.address);
    const persisted = parseCharactersSnapshot(
      await (await characterRequest(restarted.address, restartedCookie)).json(),
    );
    expect(persisted.selection.characterId).toBe(winner);
    expect(
      persisted.characters.find((character) => character.characterId === winner)
        ?.unlocked,
    ).toBe(true);
  });

  it("uses one timestamp-ordered authority across sister and friend switches and restart", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-selection-authority-"),
    );
    temporaryDirectories.push(directory);
    const progressionStorePath = join(directory, "progression-v1.json");
    const preferenceFile = join(directory, "character-preferences-v1.json");
    const { address } = await startGateway(
      adapterWithSelectableSisterAndFriend(),
      undefined,
      fakeCollector(),
      { progressionStorePath },
    );
    const cookie = await bootstrap(address);
    expect((await apiRequest(address, cookie)).status).toBe(200);

    const sister = await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "chatgpt" }),
    );
    expect(sister.status).toBe(200);
    await expect(access(preferenceFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const progressionAfterSister = await readFile(progressionStorePath, "utf8");
    expect(JSON.parse(progressionAfterSister).selection).toMatchObject({
      manualCharacterId: "chatgpt",
      manualSelectedAt: "2026-07-15T12:34:56.789Z",
    });

    const friend = await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "deepseek" }),
    );
    expect(friend.status).toBe(200);
    expect(await readFile(progressionStorePath, "utf8")).toBe(
      progressionAfterSister,
    );
    const preferenceAfterFriend = await readFile(preferenceFile, "utf8");
    expect(JSON.parse(preferenceAfterFriend)).toMatchObject({
      manualCharacterId: "deepseek",
      selectedAt: "2026-07-15T12:34:56.790Z",
    });
    expect(
      parseCharactersSnapshot(
        await (await characterRequest(address, cookie)).json(),
      ).selection,
    ).toEqual({ characterId: "deepseek", selectedBy: "manual" });
    expect(
      (
        await characterPost(
          address,
          cookie,
          "interact",
          JSON.stringify({
            characterId: "deepseek",
            action: "tap",
            locale: "en",
          }),
        )
      ).status,
    ).toBe(200);

    const sisterAgain = await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "chatgpt" }),
    );
    expect(sisterAgain.status).toBe(200);
    expect(await readFile(preferenceFile, "utf8")).toBe(preferenceAfterFriend);
    expect(
      JSON.parse(await readFile(progressionStorePath, "utf8")).selection,
    ).toMatchObject({
      manualCharacterId: "chatgpt",
      manualSelectedAt: "2026-07-15T12:34:56.791Z",
    });
    expect(
      parseCharactersSnapshot(
        await (await characterRequest(address, cookie)).json(),
      ).selection,
    ).toEqual({ characterId: "chatgpt", selectedBy: "manual" });
    expect(
      (
        await characterPost(
          address,
          cookie,
          "interact",
          JSON.stringify({
            characterId: "chatgpt",
            action: "tap",
            locale: "en",
          }),
        )
      ).status,
    ).toBe(200);

    const restarted = await startGateway(
      adapterWithSelectableSisterAndFriend(),
      undefined,
      fakeCollector(),
      { progressionStorePath },
    );
    const restartedCookie = await bootstrap(restarted.address);
    expect(
      parseCharactersSnapshot(
        await (
          await characterRequest(restarted.address, restartedCookie)
        ).json(),
      ).selection,
    ).toEqual({ characterId: "chatgpt", selectedBy: "manual" });
  });

  it("serializes concurrent cross-authority selections under a fixed clock", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-concurrent-selection-authority-"),
    );
    temporaryDirectories.push(directory);
    const progressionStorePath = join(directory, "progression-v1.json");
    const preferenceFile = join(directory, "character-preferences-v1.json");
    const { address } = await startGateway(
      adapterWithSelectableSisterAndFriend(),
      undefined,
      fakeCollector(),
      { progressionStorePath },
    );
    const cookie = await bootstrap(address);
    expect((await apiRequest(address, cookie)).status).toBe(200);

    const responses = await Promise.all([
      characterPost(
        address,
        cookie,
        "select",
        JSON.stringify({ characterId: "chatgpt" }),
      ),
      characterPost(
        address,
        cookie,
        "select",
        JSON.stringify({ characterId: "deepseek" }),
      ),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const progressionSelection = JSON.parse(
      await readFile(progressionStorePath, "utf8"),
    ).selection as {
      manualCharacterId: "chatgpt";
      manualSelectedAt: string;
    };
    const preferenceSelection = JSON.parse(
      await readFile(preferenceFile, "utf8"),
    ) as { manualCharacterId: "deepseek"; selectedAt: string };
    expect(progressionSelection.manualSelectedAt).not.toBe(
      preferenceSelection.selectedAt,
    );
    const expectedCharacterId =
      progressionSelection.manualSelectedAt > preferenceSelection.selectedAt
        ? "chatgpt"
        : "deepseek";
    expect(
      parseCharactersSnapshot(
        await (await characterRequest(address, cookie)).json(),
      ).selection,
    ).toEqual({ characterId: expectedCharacterId, selectedBy: "manual" });
  });

  it("ignores a newer locked friend preference when resolving the active companion", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-locked-selection-preference-"),
    );
    temporaryDirectories.push(directory);
    const progressionStorePath = join(directory, "progression-v1.json");
    const preferenceFile = join(directory, "character-preferences-v1.json");
    const lockedPreference = `${JSON.stringify(
      {
        schemaVersion: "1",
        manualCharacterId: "deepseek",
        selectedAt: "2026-07-15T13:00:00.000Z",
        activeThemeByCharacter: {},
      },
      null,
      2,
    )}\n`;
    await writeFile(preferenceFile, lockedPreference, {
      encoding: "utf8",
      mode: 0o600,
    });
    const { address } = await startGateway(
      fakeAdapter(),
      undefined,
      fakeCollector(),
      { progressionStorePath },
    );
    const cookie = await bootstrap(address);

    expect(
      parseCharactersSnapshot(
        await (await characterRequest(address, cookie)).json(),
      ).selection,
    ).toEqual({ characterId: null, selectedBy: null });
    const selected = await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "chatgpt" }),
    );
    expect(selected.status).toBe(200);
    expect(await readFile(preferenceFile, "utf8")).toBe(lockedPreference);
    expect(
      JSON.parse(await readFile(progressionStorePath, "utf8")).selection,
    ).toMatchObject({
      manualCharacterId: "chatgpt",
      manualSelectedAt: "2026-07-15T13:00:00.001Z",
    });
    expect(
      parseCharactersSnapshot(
        await (await characterRequest(address, cookie)).json(),
      ).selection,
    ).toEqual({ characterId: "chatgpt", selectedBy: "manual" });
  });

  it("repairs a stale zero-byte rc.7 lock before the player retries a starter", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-stale-starter-lock-"),
    );
    temporaryDirectories.push(directory);
    const progressionStorePath = join(directory, "progression-v1.json");
    const { address } = await startGateway(
      fakeAdapter(),
      undefined,
      fakeCollector(),
      { progressionStorePath },
    );
    const cookie = await bootstrap(address);

    const initial = parseCharactersSnapshot(
      await (await characterRequest(address, cookie)).json(),
    );
    expect(initial.selection).toEqual({ characterId: null, selectedBy: null });
    const lockPath = `${progressionStorePath}.lock`;
    await writeFile(lockPath, "", { encoding: "utf8", mode: 0o600 });
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    const beforeSelection = parseCharactersSnapshot(
      await (await characterRequest(address, cookie)).json(),
    );
    expect(beforeSelection.selection).toEqual({
      characterId: null,
      selectedBy: null,
    });
    const blocked = await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "chatgpt" }),
    );
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toEqual({
      status: "error",
      error: "store-busy",
    });
    const repaired = await progressionLockRepairPost(
      address,
      cookie,
      JSON.stringify({ confirmedOldVersionsClosed: true }),
    );
    expect(repaired.status).toBe(200);
    await expect(repaired.json()).resolves.toEqual({
      status: "ok",
      outcome: "repaired",
    });

    const response = await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "chatgpt" }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      selection: { characterId: "chatgpt", selectedBy: "manual" },
    });
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const selected = parseCharactersSnapshot(
      await (await characterRequest(address, cookie)).json(),
    );
    expect(selected.selection).toEqual({
      characterId: "chatgpt",
      selectedBy: "manual",
    });
    expect(
      selected.characters.find(
        (character) => character.characterId === "chatgpt",
      )?.unlocked,
    ).toBe(true);
  });

  it("does not fail a committed selection because the other authority is unavailable", async () => {
    const sisterDirectory = await mkdtemp(
      join(tmpdir(), "tokenmonster-sister-single-commit-"),
    );
    temporaryDirectories.push(sisterDirectory);
    const sisterProgressionPath = join(sisterDirectory, "progression-v1.json");
    const unusablePreferencePath = join(
      sisterDirectory,
      "character-preferences-v1.json",
    );
    await mkdir(unusablePreferencePath);
    const sisterGateway = await startGateway(
      fakeAdapter(),
      undefined,
      fakeCollector(),
      { progressionStorePath: sisterProgressionPath },
    );
    const sisterCookie = await bootstrap(sisterGateway.address);
    const sisterResponse = await characterPost(
      sisterGateway.address,
      sisterCookie,
      "select",
      JSON.stringify({ characterId: "chatgpt" }),
    );
    expect(sisterResponse.status).toBe(200);
    expect(
      JSON.parse(await readFile(sisterProgressionPath, "utf8")).selection,
    ).toMatchObject({ manualCharacterId: "chatgpt" });
    expect((await stat(unusablePreferencePath)).isDirectory()).toBe(true);

    const friendDirectory = await mkdtemp(
      join(tmpdir(), "tokenmonster-friend-single-commit-"),
    );
    temporaryDirectories.push(friendDirectory);
    const friendProgressionPath = join(friendDirectory, "progression-v1.json");
    const friendPreferencePath = join(
      friendDirectory,
      "character-preferences-v1.json",
    );
    const friendGateway = await startGateway(
      adapterWithSelectableSisterAndFriend(),
      undefined,
      fakeCollector(),
      { progressionStorePath: friendProgressionPath },
    );
    const friendCookie = await bootstrap(friendGateway.address);
    expect((await apiRequest(friendGateway.address, friendCookie)).status).toBe(
      200,
    );
    const progressionBeforeFriend = await readFile(
      friendProgressionPath,
      "utf8",
    );
    const lockPath = `${friendProgressionPath}.lock`;
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        ownerId: "selection-authority-test",
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const friendResponse = await characterPost(
      friendGateway.address,
      friendCookie,
      "select",
      JSON.stringify({ characterId: "deepseek" }),
    );
    expect(friendResponse.status).toBe(200);
    expect(await readFile(friendProgressionPath, "utf8")).toBe(
      progressionBeforeFriend,
    );
    expect(
      JSON.parse(await readFile(friendPreferencePath, "utf8")),
    ).toMatchObject({ manualCharacterId: "deepseek" });
    await rm(lockPath);
    expect(
      parseCharactersSnapshot(
        await (
          await characterRequest(friendGateway.address, friendCookie)
        ).json(),
      ).selection,
    ).toEqual({ characterId: "deepseek", selectedBy: "manual" });
  });

  it("strictly validates character POST bodies and lock-gates interactions", async () => {
    const { address } = await startGateway(
      fakeAdapter(),
      undefined,
      fakeCollector(),
      { manifest: characterManifest(Buffer.from("locked-character-avatar")) },
    );
    const cookie = await bootstrap(address);

    const lockedSelection = await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "deepseek" }),
    );
    expect(lockedSelection.status).toBe(409);
    expect(await lockedSelection.json()).toEqual({
      status: "error",
      error: "locked",
    });

    const lockedWardrobe = await characterPost(
      address,
      cookie,
      "wardrobe",
      JSON.stringify({ characterId: "chatgpt", themeId: "tech" }),
    );
    expect(lockedWardrobe.status).toBe(409);
    expect(await lockedWardrobe.json()).toEqual({
      status: "error",
      error: "locked",
    });

    expect(
      (
        await characterPost(
          address,
          cookie,
          "wardrobe",
          JSON.stringify({ characterId: "chatgpt", themeId: "not-a-theme" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await characterPost(
          address,
          cookie,
          "wardrobe",
          JSON.stringify({
            characterId: "chatgpt",
            themeId: "tech",
            extra: true,
          }),
        )
      ).status,
    ).toBe(400);

    const queryBearingWardrobe = await rawRequest(address, {
      path: "/api/characters/wardrobe?themeId=tech",
      method: "POST",
      headers: {
        Host: `127.0.0.1:${address.port}`,
        Cookie: cookie,
        Origin: address.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ characterId: "chatgpt", themeId: "tech" }),
    });
    expect(queryBearingWardrobe.status).toBe(404);

    expect(
      (
        await characterPost(
          address,
          cookie,
          "select",
          JSON.stringify({ characterId: "chatgpt", extra: true }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await characterPost(
          address,
          cookie,
          "select",
          JSON.stringify({ characterId: "chatgpt" }),
          "text/plain",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await characterPost(
          address,
          cookie,
          "select",
          JSON.stringify({ characterId: "x".repeat(600) }),
        )
      ).status,
    ).toBe(400);
  });

  it("exposes an exact privacy-safe progression-lock repair contract", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-gateway-repair-progression-lock-"),
    );
    temporaryDirectories.push(directory);
    const progressionStorePath = join(directory, "progression-v1.json");
    const lockPath = `${progressionStorePath}.lock`;
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: 2_147_483_647,
        createdAt: "2000-01-01T00:00:00.000Z",
        ownerId: "dead-rc7-gateway-test",
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);
    const { address } = await startGateway(
      fakeAdapter(),
      undefined,
      fakeCollector(),
      { progressionStorePath },
    );
    const confirmation = JSON.stringify({
      confirmedOldVersionsClosed: true,
    });

    const unauthenticated = await progressionLockRepairPost(
      address,
      "tokenmonster_session=invalid",
      confirmation,
    );
    expect(unauthenticated.status).toBe(404);

    const cookie = await bootstrap(address);
    const missingOrigin = await progressionLockRepairPost(
      address,
      cookie,
      confirmation,
      false,
    );
    expect(missingOrigin.status).toBe(403);

    const wrongMethod = await fetch(
      `${address.origin}/api/characters/progression-lock/repair`,
      { headers: { Cookie: cookie, Origin: address.origin } },
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");

    const response = await progressionLockRepairPost(
      address,
      cookie,
      confirmation,
    );
    expect(response.status).toBe(200);
    const dto =
      (await response.json()) as CompanionProgressionLockRepairResponse;
    expect(Object.keys(dto)).toEqual(["status", "outcome"]);
    expect(dto).toEqual({ status: "ok", outcome: "repaired" });
    expect(JSON.stringify(dto)).not.toMatch(
      /(?:pid|owner|path|filename|project|prompt|token)/iu,
    );

    const repeated = await progressionLockRepairPost(
      address,
      cookie,
      confirmation,
    );
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({
      status: "ok",
      outcome: "not-needed",
    });

    for (const body of [
      {},
      { confirmedOldVersionsClosed: false },
      { confirmedOldVersionsClosed: "true" },
      { confirmedOldVersionsClosed: true, force: true },
    ]) {
      const invalid = await progressionLockRepairPost(
        address,
        cookie,
        JSON.stringify(body),
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        status: "error",
        error: "invalid-request",
      });
    }

    const queryBearing = await rawRequest(address, {
      path: "/api/characters/progression-lock/repair?force=1",
      method: "POST",
      headers: {
        Host: `127.0.0.1:${address.port}`,
        Cookie: cookie,
        Origin: address.origin,
        "Content-Type": "application/json",
      },
      body: confirmation,
    });
    expect(queryBearing.status).toBe(404);
    expect(JSON.parse(queryBearing.body)).toEqual({
      error: "request-rejected",
    });
  });

  it("reports a held progression lock without hiding it as an invalid selection", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-gateway-held-progression-lock-"),
    );
    temporaryDirectories.push(directory);
    const progressionStorePath = join(directory, "progression-v1.json");
    const { address } = await startGateway(
      fakeAdapter(),
      undefined,
      fakeCollector(),
      { progressionStorePath },
    );
    const cookie = await bootstrap(address);
    const lockPath = `${progressionStorePath}.lock`;
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        ownerId: "gateway-live-lock-test",
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const selection = await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "chatgpt" }),
    );
    expect(selection.status).toBe(409);
    expect(await selection.json()).toEqual({
      status: "error",
      error: "store-busy",
    });

    const repair = await progressionLockRepairPost(
      address,
      cookie,
      JSON.stringify({ confirmedOldVersionsClosed: true }),
    );
    expect(repair.status).toBe(409);
    expect(await repair.json()).toEqual({
      status: "error",
      error: "store-busy",
    });

    await rm(lockPath);
    const retry = await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "chatgpt" }),
    );
    expect(retry.status).toBe(200);
  });

  it("returns bounded local tap lines, serializes cooldowns, and rotates copy", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-character-interactions-"),
    );
    temporaryDirectories.push(directory);
    const progressionStorePath = join(directory, "progression-v1.json");
    const interactionStorePath = join(
      directory,
      "character-interactions-v1.json",
    );
    let nowMs = Date.parse("2026-07-15T12:34:56.789Z");
    const adapter = adapterWithOpenAiProgression(5_000);
    const { address } = await startGateway(
      adapter,
      undefined,
      fakeCollector(),
      { progressionStorePath },
      () => new Date(nowMs),
    );
    const cookie = await bootstrap(address);
    expect((await apiRequest(address, cookie)).status).toBe(200);
    expect(
      (
        await characterPost(
          address,
          cookie,
          "select",
          JSON.stringify({ characterId: "chatgpt" }),
        )
      ).status,
    ).toBe(200);

    vi.mocked(adapter.getDaily).mockClear();
    vi.mocked(adapter.getProviderTotals).mockClear();
    vi.mocked(adapter.getProgressionFamilyTotals).mockClear();
    vi.mocked(adapter.getDailyFamilySeries).mockClear();
    vi.mocked(adapter.getModelUsage).mockClear();

    const simultaneous = await Promise.all([
      characterPost(
        address,
        cookie,
        "interact",
        JSON.stringify({
          characterId: "chatgpt",
          action: "tap",
          locale: "zh-TW",
        }),
      ),
      characterPost(
        address,
        cookie,
        "interact",
        JSON.stringify({
          characterId: "chatgpt",
          action: "tap",
          locale: "zh-TW",
        }),
      ),
    ]);
    expect(simultaneous.every((response) => response.status === 200)).toBe(
      true,
    );
    const outcomes = await Promise.all(
      simultaneous.map(
        async (response) => (await response.json()) as Record<string, unknown>,
      ),
    );
    const lineResponse = outcomes.find((body) => body["outcome"] === "line")!;
    const cooldownResponse = outcomes.find(
      (body) => body["outcome"] === "animation-only",
    )!;
    expect(Object.keys(lineResponse)).toEqual([
      "status",
      "action",
      "characterId",
      "locale",
      "outcome",
      "line",
      "cooldownMs",
    ]);
    expect(Object.keys(lineResponse["line"] as object)).toEqual([
      "lineId",
      "text",
    ]);
    expect(lineResponse).toMatchObject({
      status: "ok",
      action: "tap",
      characterId: "chatgpt",
      locale: "zh-TW",
      outcome: "line",
      cooldownMs: 1_600,
    });
    expect(lineResponse["line"]).toMatchObject({
      lineId: expect.stringMatching(
        /^fixed-line\/1\.0\.0\/chatgpt\/zh-TW\/greeting\//u,
      ),
      text: expect.stringMatching(/^\S.{0,239}$/u),
    });
    expect(Object.keys(cooldownResponse)).toEqual([
      "status",
      "action",
      "characterId",
      "locale",
      "outcome",
      "retryAfterMs",
    ]);
    expect(cooldownResponse).toEqual({
      status: "ok",
      action: "tap",
      characterId: "chatgpt",
      locale: "zh-TW",
      outcome: "animation-only",
      retryAfterMs: 1_600,
    });
    expect(parseCharacterInteractionResponse(lineResponse).outcome).toBe(
      "line",
    );
    expect(parseCharacterInteractionResponse(cooldownResponse).outcome).toBe(
      "animation-only",
    );

    const firstLineId = (lineResponse["line"] as Record<string, unknown>)[
      "lineId"
    ];
    nowMs += 1_601;
    const rotated = await characterPost(
      address,
      cookie,
      "interact",
      JSON.stringify({
        characterId: "chatgpt",
        action: "tap",
        locale: "zh-TW",
      }),
    );
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as {
      outcome: string;
      line: { lineId: string };
    };
    expect(rotatedBody.outcome).toBe("line");
    expect(rotatedBody.line.lineId).not.toBe(firstLineId);

    const serialized = await readFile(interactionStorePath, "utf8");
    const store = JSON.parse(serialized) as Record<string, unknown>;
    expect(Object.keys(store)).toEqual([
      "schemaVersion",
      "utcDate",
      "characters",
    ]);
    expect(store["schemaVersion"]).toBe("1");
    expect(store["utcDate"]).toBe("2026-07-15");
    const entries = store["characters"] as Record<string, unknown>;
    expect(Object.keys(entries)).toEqual(["chatgpt"]);
    expect(Object.keys(entries["chatgpt"] as object)).toEqual([
      "lastShownAt",
      "dailyCount",
      "nextSeed",
    ]);
    expect(entries["chatgpt"]).toEqual({
      lastShownAt: new Date(nowMs).toISOString(),
      dailyCount: 2,
      nextSeed: 2,
    });
    expect(serialized).not.toContain("lineId");
    expect(serialized).not.toContain("text");
    expect(serialized).not.toContain("source");
    expect((await stat(interactionStorePath)).mode & 0o777).toBe(0o600);

    expect(adapter.getDaily).not.toHaveBeenCalled();
    expect(adapter.getProviderTotals).not.toHaveBeenCalled();
    expect(adapter.getProgressionFamilyTotals).not.toHaveBeenCalled();
    expect(adapter.getDailyFamilySeries).not.toHaveBeenCalled();
    expect(adapter.getModelUsage).not.toHaveBeenCalled();

    const rawBody = JSON.stringify({
      characterId: "chatgpt",
      action: "tap",
      locale: "zh-TW",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("tap must not perform network fetches"));
    let rawTap: Awaited<ReturnType<typeof rawRequest>>;
    try {
      rawTap = await rawRequest(address, {
        path: "/api/characters/interact",
        method: "POST",
        headers: {
          Host: `127.0.0.1:${address.port}`,
          Cookie: cookie,
          Origin: address.origin,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(rawBody)),
        },
        body: rawBody,
      });
    } finally {
      fetchSpy.mockRestore();
    }
    expect(rawTap.status).toBe(200);
    expect(JSON.parse(rawTap.body)).toMatchObject({
      status: "ok",
      outcome: "animation-only",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves stateless idle chatter lines without spending the tap allowance", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-character-idle-lines-"),
    );
    temporaryDirectories.push(directory);
    const progressionStorePath = join(directory, "progression-v1.json");
    const interactionStorePath = join(
      directory,
      "character-interactions-v1.json",
    );
    let nowMs = Date.parse("2026-07-15T12:34:56.789Z");
    const adapter = adapterWithOpenAiProgression(5_000);
    const { address } = await startGateway(
      adapter,
      undefined,
      fakeCollector(),
      { progressionStorePath },
      () => new Date(nowMs),
    );
    const cookie = await bootstrap(address);
    expect((await apiRequest(address, cookie)).status).toBe(200);
    expect(
      (
        await characterPost(
          address,
          cookie,
          "select",
          JSON.stringify({ characterId: "chatgpt" }),
        )
      ).status,
    ).toBe(200);

    const idle = async () =>
      characterPost(
        address,
        cookie,
        "interact",
        JSON.stringify({
          characterId: "chatgpt",
          action: "idle",
          locale: "zh-TW",
        }),
      );

    const first = await idle();
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(Object.keys(firstBody)).toEqual([
      "status",
      "action",
      "characterId",
      "locale",
      "outcome",
      "line",
      "cooldownMs",
    ]);
    expect(firstBody).toMatchObject({
      status: "ok",
      action: "idle",
      characterId: "chatgpt",
      locale: "zh-TW",
      outcome: "line",
      cooldownMs: 45_000,
    });
    expect(firstBody["line"]).toMatchObject({
      lineId: expect.stringMatching(/^fixed-line\/1\.0\.0\/chatgpt\/zh-TW\//u),
      text: expect.stringMatching(/^\S.{0,239}$/u),
    });
    expect(parseCharacterInteractionResponse(firstBody).outcome).toBe("line");

    // The same two-minute bucket repeats the same line deterministically.
    nowMs += 1_000;
    const repeatBody = (await (await idle()).json()) as {
      line: { lineId: string };
    };
    expect(repeatBody.line.lineId).toBe(
      (firstBody["line"] as { lineId: string }).lineId,
    );

    // The next bucket rotates the copy.
    nowMs += 120_000;
    const rotatedBody = (await (await idle()).json()) as {
      line: { lineId: string };
    };
    expect(rotatedBody.line.lineId).not.toBe(repeatBody.line.lineId);

    // Idle chatter never touches the persisted interaction store.
    await expect(readFile(interactionStorePath, "utf8")).rejects.toThrow();

    // A tap inside its cooldown still leaves idle chatter available, and the
    // idle reply leaves the tap budget untouched.
    const tap = await characterPost(
      address,
      cookie,
      "interact",
      JSON.stringify({
        characterId: "chatgpt",
        action: "tap",
        locale: "zh-TW",
      }),
    );
    expect(((await tap.json()) as { outcome: string }).outcome).toBe("line");
    const idleDuringCooldown = (await (await idle()).json()) as {
      action: string;
      outcome: string;
    };
    expect(idleDuringCooldown).toMatchObject({
      action: "idle",
      outcome: "line",
    });
    const store = JSON.parse(
      await readFile(interactionStorePath, "utf8"),
    ) as { characters: Record<string, { dailyCount: number }> };
    expect(store.characters["chatgpt"]!.dailyCount).toBe(1);

    // Idle keeps the tap route's selection guard.
    const unselected = await characterPost(
      address,
      cookie,
      "interact",
      JSON.stringify({
        characterId: "claude",
        action: "idle",
        locale: "zh-TW",
      }),
    );
    expect(unselected.status).toBe(409);
  });

  it("personalizes starter taps from the current saved profile and falls back offline", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-profile-tap-lines-"),
    );
    temporaryDirectories.push(directory);
    const progressionStorePath = join(directory, "progression-v1.json");
    const profilePath = join(directory, "character-profile-v1.json");
    let nowMs = Date.parse("2026-07-15T12:34:56.789Z");
    const adapter = adapterWithOpenAiProgression(5_000);
    vi.mocked(adapter.getDailyContentBlindFootprint).mockImplementation(
      async (query) =>
        profileFootprint(query.fromUtcDate, query.toUtcDate, 14, 1_000, 1_000),
    );
    const { address } = await startGateway(
      adapter,
      undefined,
      fakeCollector(),
      { progressionStorePath },
      () => new Date(nowMs),
    );
    const cookie = await bootstrap(address);

    const profileResponse = await characterProfileRequest(address, cookie);
    expect(profileResponse.status).toBe(200);
    const profile =
      (await profileResponse.json()) as CompanionCharacterProfileResponse;
    expect(profile.mood.id).toBe("lively");
    const savedProfile = await readFile(profilePath, "utf8");

    expect((await apiRequest(address, cookie)).status).toBe(200);
    expect(
      (
        await characterPost(
          address,
          cookie,
          "select",
          JSON.stringify({ characterId: "chatgpt" }),
        )
      ).status,
    ).toBe(200);
    vi.mocked(adapter.getDailyContentBlindFootprint).mockClear();

    const personalized = await characterPost(
      address,
      cookie,
      "interact",
      JSON.stringify({
        characterId: "chatgpt",
        action: "tap",
        locale: "zh-TW",
      }),
    );
    expect(personalized.status).toBe(200);
    await expect(personalized.json()).resolves.toMatchObject({
      outcome: "line",
      line: {
        lineId: selectTapLine({
          characterId: "chatgpt",
          locale: "zh-TW",
          seed: 0,
          mood: profile.mood.id,
          traits: profile.identity.traitIds,
        }).lineId,
      },
    });
    expect(adapter.getDailyContentBlindFootprint).not.toHaveBeenCalled();

    await writeFile(profilePath, '{"schemaVersion":"1","prompt":"no"}\n');
    nowMs += 1_601;
    const corruptFallback = await characterPost(
      address,
      cookie,
      "interact",
      JSON.stringify({
        characterId: "chatgpt",
        action: "tap",
        locale: "zh-TW",
      }),
    );
    await expect(corruptFallback.json()).resolves.toMatchObject({
      outcome: "line",
      line: {
        lineId: selectTapLine({
          characterId: "chatgpt",
          locale: "zh-TW",
          seed: 1,
        }).lineId,
      },
    });

    await writeFile(profilePath, savedProfile);
    nowMs = Date.parse("2026-07-16T12:34:56.789Z");
    const priorDayFallback = await characterPost(
      address,
      cookie,
      "interact",
      JSON.stringify({
        characterId: "chatgpt",
        action: "tap",
        locale: "zh-TW",
      }),
    );
    await expect(priorDayFallback.json()).resolves.toMatchObject({
      outcome: "line",
      line: {
        lineId: selectTapLine({
          characterId: "chatgpt",
          locale: "zh-TW",
          seed: 0,
        }).lineId,
      },
    });
    expect(adapter.getDailyContentBlindFootprint).not.toHaveBeenCalled();
  });

  it("strictly validates tap requests and requires the unlocked current character", async () => {
    const locked = await startGateway();
    const lockedCookie = await bootstrap(locked.address);
    const lockedTap = await characterPost(
      locked.address,
      lockedCookie,
      "interact",
      JSON.stringify({
        characterId: "chatgpt",
        action: "tap",
        locale: "en",
      }),
    );
    expect(lockedTap.status).toBe(409);
    expect(await lockedTap.json()).toEqual({
      status: "error",
      error: "locked",
    });

    const unlocked = await startGateway(adapterWithAllStarterProgression(100));
    const cookie = await bootstrap(unlocked.address);
    expect((await apiRequest(unlocked.address, cookie)).status).toBe(200);
    expect(
      (
        await characterPost(
          unlocked.address,
          cookie,
          "select",
          JSON.stringify({ characterId: "chatgpt" }),
        )
      ).status,
    ).toBe(200);
    const notSelected = await characterPost(
      unlocked.address,
      cookie,
      "interact",
      JSON.stringify({
        characterId: "claude",
        action: "tap",
        locale: "en",
      }),
    );
    expect(notSelected.status).toBe(409);
    expect(await notSelected.json()).toEqual({
      status: "error",
      error: "not-selected",
    });

    for (const body of [
      { characterId: "chatgpt", action: "poke", locale: "en" },
      { characterId: "chatgpt", action: "tap", locale: "zh-CN" },
      { characterId: "unknown", action: "tap", locale: "en" },
      {
        characterId: "chatgpt",
        action: "tap",
        locale: "en",
        prompt: "do not accept free-form content",
      },
    ]) {
      const response = await characterPost(
        unlocked.address,
        cookie,
        "interact",
        JSON.stringify(body),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        status: "error",
        error: "invalid-request",
      });
    }

    const queryBearingTap = await rawRequest(unlocked.address, {
      path: "/api/characters/interact?locale=en",
      method: "POST",
      headers: {
        Host: `127.0.0.1:${unlocked.address.port}`,
        Cookie: cookie,
        Origin: unlocked.address.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        characterId: "chatgpt",
        action: "tap",
        locale: "en",
      }),
    });
    expect(queryBearingTap.status).toBe(404);
    expect(JSON.parse(queryBearingTap.body)).toEqual({
      error: "request-rejected",
    });
  });

  it("recovers a corrupt tap store without retaining content or event history", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-corrupt-interactions-"),
    );
    temporaryDirectories.push(directory);
    const progressionStorePath = join(directory, "progression-v1.json");
    const interactionStorePath = join(
      directory,
      "character-interactions-v1.json",
    );
    const { address } = await startGateway(
      adapterWithOpenAiProgression(100),
      undefined,
      fakeCollector(),
      { progressionStorePath },
    );
    const cookie = await bootstrap(address);
    expect((await apiRequest(address, cookie)).status).toBe(200);
    expect(
      (
        await characterPost(
          address,
          cookie,
          "select",
          JSON.stringify({ characterId: "chatgpt" }),
        )
      ).status,
    ).toBe(200);
    await writeFile(
      interactionStorePath,
      JSON.stringify({
        schemaVersion: "1",
        utcDate: "2026-07-15",
        characters: {
          chatgpt: {
            lastShownAt: "2026-07-15T12:00:00.000Z",
            dailyCount: 1,
            nextSeed: 1,
            leakedLine: "must be discarded",
          },
        },
      }),
      "utf8",
    );

    const response = await characterPost(
      address,
      cookie,
      "interact",
      JSON.stringify({
        characterId: "chatgpt",
        action: "tap",
        locale: "en",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      outcome: "line",
    });
    const repaired = JSON.parse(
      await readFile(interactionStorePath, "utf8"),
    ) as {
      characters: { chatgpt: Record<string, unknown> };
    };
    expect(repaired.characters.chatgpt).toEqual({
      lastShownAt: "2026-07-15T12:34:56.789Z",
      dailyCount: 1,
      nextSeed: 1,
    });
  });

  it("serves the original friend catalog through the same selected-character gate", async () => {
    const adapter = fakeAdapter(
      async (range) => responseFor(range),
      async () => Object.freeze({ openai: 0, anthropic: 0, google: 0, xai: 0 }),
      async () =>
        Object.freeze({
          ...progressionTotals(0),
          deepseek: 100_000,
        }),
    );
    const { address } = await startGateway(adapter);
    const cookie = await bootstrap(address);
    expect((await apiRequest(address, cookie)).status).toBe(200);
    const selected = await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "deepseek" }),
    );
    expect(selected.status).toBe(200);

    const response = await characterPost(
      address,
      cookie,
      "interact",
      JSON.stringify({
        characterId: "deepseek",
        action: "tap",
        locale: "en",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      action: "tap",
      characterId: "deepseek",
      locale: "en",
      outcome: "line",
      line: {
        lineId: "tap-line/1.0.0/deepseek/en/hello",
        text: expect.stringMatching(/^\S.{0,179}$/u),
      },
    });
  });

  it("turns the daily line cap into animation-only feedback and resets on UTC day change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-tap-cap-"));
    temporaryDirectories.push(directory);
    const progressionStorePath = join(directory, "progression-v1.json");
    const interactionStorePath = join(
      directory,
      "character-interactions-v1.json",
    );
    let nowMs = Date.parse("2026-07-15T23:59:00.000Z");
    const { address } = await startGateway(
      adapterWithOpenAiProgression(100),
      undefined,
      fakeCollector(),
      { progressionStorePath },
      () => new Date(nowMs),
    );
    const cookie = await bootstrap(address);
    expect((await apiRequest(address, cookie)).status).toBe(200);
    expect(
      (
        await characterPost(
          address,
          cookie,
          "select",
          JSON.stringify({ characterId: "chatgpt" }),
        )
      ).status,
    ).toBe(200);
    await writeFile(
      interactionStorePath,
      JSON.stringify({
        schemaVersion: "1",
        utcDate: "2026-07-15",
        characters: {
          chatgpt: {
            lastShownAt: "2026-07-15T23:58:00.000Z",
            dailyCount: 48,
            nextSeed: 48,
          },
        },
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const capped = await characterPost(
      address,
      cookie,
      "interact",
      JSON.stringify({
        characterId: "chatgpt",
        action: "tap",
        locale: "en",
      }),
    );
    expect(capped.status).toBe(200);
    expect(await capped.json()).toEqual({
      status: "ok",
      action: "tap",
      characterId: "chatgpt",
      locale: "en",
      outcome: "animation-only",
      retryAfterMs: 60_000,
    });

    nowMs += 60_001;
    const nextDay = await characterPost(
      address,
      cookie,
      "interact",
      JSON.stringify({
        characterId: "chatgpt",
        action: "tap",
        locale: "en",
      }),
    );
    expect(nextDay.status).toBe(200);
    expect(await nextDay.json()).toMatchObject({
      status: "ok",
      outcome: "line",
    });
    const resetStore = JSON.parse(
      await readFile(interactionStorePath, "utf8"),
    ) as {
      utcDate: string;
      characters: { chatgpt: { dailyCount: number; nextSeed: number } };
    };
    expect(resetStore.utcDate).toBe("2026-07-16");
    expect(resetStore.characters.chatgpt).toMatchObject({
      dailyCount: 1,
      nextSeed: 1,
    });
    expect((await stat(interactionStorePath)).mode & 0o777).toBe(0o600);
  });

  it("backfills progression once and persists unlocked selection and wardrobe", async () => {
    const adapter = adapterWithOpenAiProgression(5_000);
    const avatarBody = Buffer.from("progression-avatar");
    const { address } = await startGateway(
      adapter,
      undefined,
      fakeCollector(),
      {
        manifest: characterManifest(avatarBody, [
          { themeId: "tech", outfitBody: Buffer.from("tech-outfit") },
          { themeId: "finance", outfitBody: Buffer.from("finance-outfit") },
        ]),
      },
    );
    const cookie = await bootstrap(address);

    expect((await apiRequest(address, cookie)).status).toBe(200);
    expect(adapter.getProgressionFamilyTotals).toHaveBeenCalledTimes(28);
    expect((await apiRequest(address, cookie)).status).toBe(200);
    expect(adapter.getProgressionFamilyTotals).toHaveBeenCalledTimes(28);

    const selected = await characterPost(
      address,
      cookie,
      "select",
      JSON.stringify({ characterId: "chatgpt" }),
    );
    expect(selected.status).toBe(200);
    expect(await selected.json()).toEqual({
      status: "ok",
      selection: { characterId: "chatgpt", selectedBy: "manual" },
    });
    const wardrobe = await characterPost(
      address,
      cookie,
      "wardrobe",
      JSON.stringify({ characterId: "chatgpt", themeId: "finance" }),
    );
    expect(wardrobe.status).toBe(200);
    expect(await wardrobe.json()).toEqual({
      status: "ok",
      characterId: "chatgpt",
      activeThemeId: "finance",
    });
    const dto = (await (await characterRequest(address, cookie)).json()) as {
      unlockBatchId: string | null;
      selection: unknown;
      characters: Array<Record<string, unknown>>;
    };
    expect(dto.unlockBatchId).toBe("2026-07-15T12:34:56.789Z");
    expect(dto.selection).toEqual({
      characterId: "chatgpt",
      selectedBy: "manual",
    });
    expect(dto.characters[0]).toMatchObject({
      characterId: "chatgpt",
      unlocked: true,
      activeThemeId: "finance",
      visual: { mode: "doll" },
    });
  });

  it("serves verified cache hits and fails closed on cache misses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-assets-"));
    temporaryDirectories.push(directory);
    const cacheDirectory = join(directory, "cache");
    const cachedBody = Buffer.from("cached-approved-object");
    const missingBody = Buffer.from("missing-approved-object");
    const manifest = characterManifest(missingBody, [
      { themeId: "tech", outfitBody: cachedBody },
    ]);
    const { address } = await startGateway(
      adapterWithOpenAiProgression(1),
      undefined,
      fakeCollector(),
      { manifest, cacheDirectory },
    );
    const cookie = await bootstrap(address);
    await apiRequest(address, cookie);
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(
      join(cacheDirectory, `${sha256(cachedBody)}.webp`),
      cachedBody,
    );

    const cached = await fetch(
      `${address.origin}/assets/characters/objects/${sha256(cachedBody)}.webp`,
      { headers: { Cookie: cookie } },
    );
    expect(cached.status).toBe(200);
    expect(Buffer.from(await cached.arrayBuffer())).toEqual(cachedBody);
    expect(cached.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(cached.headers.get("content-type")).toBe("image/webp");

    const missing = await fetch(
      `${address.origin}/assets/characters/objects/${sha256(missingBody)}.webp`,
      { headers: { Cookie: cookie } },
    );
    expect(missing.status).toBe(404);
  });

  it("fails closed for locked, malformed, and corrupt cached assets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-assets-"));
    temporaryDirectories.push(directory);
    const approvedBody = Buffer.from("approved-object");
    const manifest = characterManifest(approvedBody);
    const locked = await startGateway(
      fakeAdapter(),
      undefined,
      fakeCollector(),
      {
        manifest,
        cacheDirectory: join(directory, "locked-cache"),
      },
    );
    const lockedCookie = await bootstrap(locked.address);
    const objectPath = `${sha256(approvedBody)}.webp`;
    expect(
      (
        await fetch(
          `${locked.address.origin}/assets/characters/objects/${objectPath}`,
          { headers: { Cookie: lockedCookie } },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          `${locked.address.origin}/assets/characters/objects/NOT-A-HASH.webp`,
          { headers: { Cookie: lockedCookie } },
        )
      ).status,
    ).toBe(404);

    const corruptCache = join(directory, "corrupt-cache");
    await mkdir(corruptCache, { recursive: true });
    await writeFile(join(corruptCache, objectPath), "wrong-object");
    const corrupt = await startGateway(
      adapterWithOpenAiProgression(1),
      undefined,
      fakeCollector(),
      { manifest, cacheDirectory: corruptCache },
    );
    const corruptCookie = await bootstrap(corrupt.address);
    await apiRequest(corrupt.address, corruptCookie);
    expect(
      (
        await fetch(
          `${corrupt.address.origin}/assets/characters/objects/${objectPath}`,
          { headers: { Cookie: corruptCookie } },
        )
      ).status,
    ).toBe(404);
    await expect(access(join(corruptCache, objectPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serves image and voice assets only from the verified local cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-cache-only-"));
    temporaryDirectories.push(directory);
    const cacheDirectory = join(directory, "cache");
    const missingAvatar = Buffer.from("missing-avatar");
    const cachedOutfit = Buffer.from("cached-outfit");
    const cachedVoice = Buffer.from("cached-voice");
    const missingVoice = Buffer.from("missing-voice");
    const manifest = {
      ...characterManifest(missingAvatar, [
        { themeId: "tech", outfitBody: cachedOutfit },
      ]),
      voice: [
        {
          characterId: "chatgpt" as const,
          lines: [
            {
              id: "chatgpt-greeting",
              trigger: "greeting" as const,
              object: objectRef(cachedVoice, "wav"),
              durationMs: 1_000,
            },
            {
              id: "chatgpt-active",
              trigger: "active" as const,
              object: objectRef(missingVoice, "wav"),
              durationMs: 1_000,
            },
          ],
        },
      ],
    };
    const { address } = await startGateway(
      adapterWithOpenAiProgression(1),
      undefined,
      fakeCollector(),
      { manifest, cacheDirectory },
    );
    const cookie = await bootstrap(address);
    await apiRequest(address, cookie);
    await mkdir(cacheDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        join(cacheDirectory, `${sha256(cachedOutfit)}.webp`),
        cachedOutfit,
      ),
      writeFile(
        join(cacheDirectory, `${sha256(cachedVoice)}.wav`),
        cachedVoice,
      ),
    ]);

    for (const [body, extension, expectedStatus] of [
      [cachedOutfit, "webp", 200],
      [missingAvatar, "webp", 404],
      [cachedVoice, "wav", 200],
      [missingVoice, "wav", 404],
    ] as const) {
      const response = await fetch(
        `${address.origin}/assets/characters/objects/${sha256(body)}.${extension}`,
        { headers: { Cookie: cookie } },
      );
      expect(response.status).toBe(expectedStatus);
    }
  });

  it("rejects every character asset transport configuration", () => {
    const invalidCharacters = [
      {
        ...EMPTY_CHARACTER_OPTIONS,
        cdnBaseUrl: "https://cdn.example.test/v1",
      },
      {
        ...EMPTY_CHARACTER_OPTIONS,
        fetch: vi.fn(),
      },
    ];
    for (const characters of invalidCharacters) {
      expect(() =>
        createCompanionGateway({
          adapter: fakeAdapter(),
          collector: fakeCollector(),
          assets: UI_ASSETS,
          characters: characters as unknown as CompanionCharacterOptions,
        }),
      ).toThrowError(CompanionGatewayError);
    }
  });

  it("rejects incomplete, unbound, unsigned, or non-strict built-in assets", () => {
    const avatar = webpFixture("strict-base-avatar");
    const outfit = webpFixture("strict-base-outfit");
    const manifest = characterManifest(avatar, [
      { themeId: "tech", outfitBody: outfit },
    ]);
    const validObjects = embeddedObjects(manifest, [avatar, outfit]);
    const avatarPath = manifest.characters[0]!.avatar.path;
    const withoutAvatar = Object.freeze(
      Object.fromEntries(
        Object.entries(validObjects).filter(([path]) => path !== avatarPath),
      ),
    );
    const withExtra = Object.freeze({
      ...validObjects,
      [`objects/${"f".repeat(64)}.webp`]: webpFixture("extra"),
    });
    const wrongBytes = Object.freeze({
      ...validObjects,
      [avatarPath]: Buffer.concat([avatar, Buffer.from([0])]),
    });
    const wrongHashAvatar = Buffer.from(avatar);
    const wrongHashIndex = wrongHashAvatar.length - 1;
    wrongHashAvatar[wrongHashIndex] = wrongHashAvatar[wrongHashIndex]! ^ 0xff;
    const wrongHash = Object.freeze({
      ...validObjects,
      [avatarPath]: wrongHashAvatar,
    });
    const accessorObjects = Object.create(null) as Record<string, Uint8Array>;
    for (const [path, bytes] of Object.entries(validObjects)) {
      if (path === avatarPath) {
        Object.defineProperty(accessorObjects, path, {
          enumerable: true,
          get: () => bytes,
        });
      } else {
        accessorObjects[path] = bytes;
      }
    }
    const invalidSignatureAvatar = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.alloc(4),
      Buffer.from("NOPE", "ascii"),
    ]);
    const invalidSignatureManifest = characterManifest(invalidSignatureAvatar, [
      { themeId: "tech", outfitBody: outfit },
    ]);
    const invalidSignatureObjects = embeddedObjects(invalidSignatureManifest, [
      invalidSignatureAvatar,
      outfit,
    ]);

    const invalidBaseAssets: unknown[] = [
      { manifest, objects: withoutAvatar },
      { manifest, objects: withExtra },
      { manifest, objects: wrongBytes },
      { manifest, objects: wrongHash },
      { manifest, objects: accessorObjects },
      { manifest: invalidSignatureManifest, objects: invalidSignatureObjects },
      { manifest, objects: validObjects, unexpected: true },
    ];
    for (const baseAssets of invalidBaseAssets) {
      expect(() =>
        createCompanionGateway({
          adapter: fakeAdapter(),
          collector: fakeCollector(),
          assets: UI_ASSETS,
          characters: {
            ...EMPTY_CHARACTER_OPTIONS,
            manifest: null,
            baseAssets,
          } as unknown as CompanionCharacterOptions,
        }),
      ).toThrowError(CompanionGatewayError);
    }

    expect(() =>
      createCompanionGateway({
        adapter: fakeAdapter(),
        collector: fakeCollector(),
        assets: UI_ASSETS,
        characters: {
          ...EMPTY_CHARACTER_OPTIONS,
          baseAssets: { manifest, objects: validObjects },
        },
      }),
    ).toThrowError(CompanionGatewayError);
  });

  it("rejects an adapter that omits the required profile footprint port", () => {
    const adapter = {
      ...fakeAdapter(),
      getDailyContentBlindFootprint: undefined,
    } as unknown as TokenTrackerAdapter;
    expect(() =>
      createCompanionGateway({
        adapter,
        collector: fakeCollector(),
        assets: UI_ASSETS,
        characters: EMPTY_CHARACTER_OPTIONS,
      }),
    ).toThrowError(CompanionGatewayError);
  });

  it("serves only index.html, styles.css, and safe module scripts from an injected static directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-gateway-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      writeFile(join(directory, "index.html"), UI_ASSETS.html),
      writeFile(join(directory, "styles.css"), UI_ASSETS.css),
      writeFile(join(directory, "main.js"), UI_ASSETS.scripts["main.js"]),
      writeFile(join(directory, "dto.js"), UI_ASSETS.scripts["dto.js"]),
      writeFile(join(directory, "Weird_Name.js"), "must never be served"),
      writeFile(join(directory, "private.txt"), "must never be served"),
    ]);
    const gateway = createCompanionGateway({
      adapter: fakeAdapter(),
      collector: fakeCollector(),
      assetDirectory: directory,
      characters: EMPTY_CHARACTER_OPTIONS,
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const cookie = await bootstrap(address);

    const moduleScript = await fetch(`${address.origin}/assets/dto.js`, {
      headers: { Cookie: cookie },
    });
    expect(moduleScript.status).toBe(200);
    expect(await moduleScript.text()).toBe(UI_ASSETS.scripts["dto.js"]);

    const unsafeName = await fetch(`${address.origin}/assets/Weird_Name.js`, {
      headers: { Cookie: cookie },
    });
    expect(unsafeName.status).toBe(404);

    const privateFile = await fetch(`${address.origin}/private.txt`, {
      headers: { Cookie: cookie },
    });
    expect(privateFile.status).toBe(404);
    const traversal = await rawRequest(address, {
      path: "/assets/../private.txt",
      headers: { Host: `127.0.0.1:${address.port}`, Cookie: cookie },
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
      writeFile(join(directory, "main.js"), UI_ASSETS.scripts["main.js"]),
      writeFile(join(outside, "dto.js"), UI_ASSETS.scripts["dto.js"]),
    ]);
    await symlink(join(outside, "dto.js"), join(directory, "dto.js"));

    expect(() =>
      createCompanionGateway({
        adapter: fakeAdapter(),
        collector: fakeCollector(),
        assetDirectory: directory,
        characters: EMPTY_CHARACTER_OPTIONS,
      }),
    ).toThrowError(CompanionGatewayError);
  });

  it("serves and persists session-gated daily quota estimates", async () => {
    const adapter = fakeAdapter();
    const { address } = await startGateway(adapter);
    const cookie = await bootstrap(address);

    const initial = await usageRequest(address, cookie, "/api/usage/quota");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      status: "ok",
      generatedAt: "2026-07-15T12:34:56.789Z",
      families: [
        {
          family: "anthropic",
          planId: null,
          windowHours: 24,
          windowKind: "utc-day",
          usedTokens: 0,
          budgetTokens: null,
          estimate: true,
        },
        {
          family: "openai",
          planId: null,
          windowHours: 24,
          windowKind: "utc-day",
          usedTokens: 11,
          budgetTokens: null,
          estimate: true,
        },
        {
          family: "google",
          planId: null,
          windowHours: 24,
          windowKind: "utc-day",
          usedTokens: 0,
          budgetTokens: null,
          estimate: true,
        },
        {
          family: "xai",
          planId: null,
          windowHours: 24,
          windowKind: "utc-day",
          usedTokens: 0,
          budgetTokens: null,
          estimate: true,
        },
      ],
    });

    const selected = await quotaPost(
      address,
      cookie,
      JSON.stringify({ family: "openai", planId: "chatgpt-plus" }),
    );
    expect(selected.status).toBe(200);
    const selectedBody = (await selected.json()) as {
      families: Array<Record<string, unknown>>;
    };
    expect(selectedBody.families[1]).toMatchObject({
      family: "openai",
      planId: "chatgpt-plus",
      budgetTokens: 1_920_000,
      usedTokens: 11,
    });
    const refreshed = await usageRequest(address, cookie, "/api/usage/quota");
    const refreshedBody = (await refreshed.json()) as {
      families: Array<{ planId: string | null }>;
    };
    expect(refreshedBody.families[1]?.planId).toBe("chatgpt-plus");

    const cleared = await quotaPost(
      address,
      cookie,
      JSON.stringify({ family: "openai", planId: null }),
    );
    const clearedBody = (await cleared.json()) as {
      families: Array<Record<string, unknown>>;
    };
    expect(clearedBody.families[1]).toMatchObject({
      planId: null,
      budgetTokens: null,
    });
  });

  it("rejects unauthenticated, query-bearing, and invalid quota requests", async () => {
    const adapter = fakeAdapter();
    const { address } = await startGateway(adapter);
    expect((await usageRequest(address, null, "/api/usage/quota")).status).toBe(
      404,
    );
    expect(
      (
        await quotaPost(
          address,
          "tokenmonster_session=invalid",
          JSON.stringify({ family: "openai", planId: null }),
        )
      ).status,
    ).toBe(404);
    const cookie = await bootstrap(address);
    expect(
      (await usageRequest(address, cookie, "/api/usage/quota?extra=1")).status,
    ).toBe(404);

    for (const body of [
      { family: "openai", planId: "private-plan" },
      { family: "other", planId: null },
      { family: "openai" },
      { family: "openai", planId: null, extra: true },
    ]) {
      const response = await quotaPost(address, cookie, JSON.stringify(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        status: "error",
        error: "invalid-request",
      });
    }
  });
});
