import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

function fakeAdapter(
  getDaily: TokenTrackerAdapter["getDaily"] = async (range) =>
    responseFor(range),
  getProviderTotals: TokenTrackerAdapter["getProviderTotals"] = async () =>
    Object.freeze({ openai: 0, anthropic: 0, google: 0, xai: 0 })
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
    getProviderTotals: vi.fn(getProviderTotals)
  });
}

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
  collector: CompanionCollectorController = fakeCollector()
): Promise<Readonly<{
  gateway: CompanionGateway;
  address: CompanionGatewayAddress;
}>> {
  const gateway = createCompanionGateway({
    adapter,
    collector,
    assets: UI_ASSETS,
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
    request.end();
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
      assetDirectory: directory
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
        assetDirectory: directory
      })
    ).toThrowError(CompanionGatewayError);
  });
});
