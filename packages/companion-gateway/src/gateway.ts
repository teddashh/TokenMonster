import { Buffer } from "node:buffer";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, isAbsolute, join } from "node:path";

import {
  selectStarterCharacter,
  type StarterCharacterSelection,
  type StarterProviderTotals28Days
} from "@tokenmonster/characters";
import {
  MAX_TOKEN_TRACKER_RANGE_DAYS,
  TokenTrackerAdapterError,
  type TokenMonsterDailyAggregateResponse,
  type TokenMonsterProviderTotals,
  type TokenTrackerAdapter,
  type TokenTrackerAggregateRange
} from "@tokenmonster/token-tracker-adapter";

import { CompanionGatewayError } from "./errors.js";
import type {
  CompanionApiErrorCode,
  CompanionApiErrorResponse,
  CompanionApiHealthyResponse,
  CompanionDailyTotal,
  CompanionGateway,
  CompanionGatewayAddress,
  CompanionGatewayClock,
  CompanionGatewayOptions,
  CompanionUiAssets
} from "./types.js";

const LOOPBACK_HOST = "127.0.0.1" as const;
const COMPANION_API_PATH = "/api/companion";
const STYLESHEET_PATH = "/assets/companion.css";
const JAVASCRIPT_PATH = "/assets/companion.js";
const BOOTSTRAP_PREFIX = "/__tokenmonster/bootstrap/";
const SESSION_COOKIE_NAME = "tokenmonster_session";
const SESSION_TOKEN_BYTES = 32;
const OBSERVATION_DAYS = 28;
const DEFAULT_API_TIMEOUT_MS = 3_000;
const MIN_API_TIMEOUT_MS = 10;
const MAX_API_TIMEOUT_MS = 10_000;
const MAX_ASSET_BYTES = 2 * 1_024 * 1_024;
const MAX_TOTAL_ASSET_BYTES = 6 * 1_024 * 1_024;
const MAX_CONCURRENT_API_REQUESTS = 8;
const OPTION_KEYS = new Set<PropertyKey>([
  "adapter",
  "assets",
  "assetDirectory",
  "clock",
  "apiTimeoutMs"
]);
const ASSET_KEYS = new Set<PropertyKey>(["html", "css", "javascript"]);
const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
});

const PROJECTION_ERROR = Symbol("companion-gateway-projection-error");
const API_TIMEOUT = Symbol("companion-gateway-api-timeout");

interface NormalizedAssets {
  readonly html: Buffer;
  readonly css: Buffer;
  readonly javascript: Buffer;
}

interface NormalizedOptions {
  readonly adapter: TokenTrackerAdapter;
  readonly assets: NormalizedAssets;
  readonly clock: CompanionGatewayClock;
  readonly apiTimeoutMs: number;
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function ownDataValue(
  record: Record<PropertyKey, unknown>,
  key: PropertyKey
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw PROJECTION_ERROR;
  }
  return descriptor.value;
}

function optionalOwnDataValue(
  record: Record<PropertyKey, unknown>,
  key: PropertyKey
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) {
    throw new CompanionGatewayError("invalid-configuration");
  }
  return descriptor.value;
}

function normalizeAsset(value: unknown): Buffer {
  let body: Buffer;
  if (typeof value === "string") {
    body = Buffer.from(value, "utf8");
  } else if (value instanceof Uint8Array) {
    body = Buffer.from(value);
  } else {
    throw new CompanionGatewayError("invalid-configuration");
  }
  if (body.byteLength === 0 || body.byteLength > MAX_ASSET_BYTES) {
    throw new CompanionGatewayError("invalid-configuration");
  }
  return body;
}

function normalizeAssets(value: unknown): NormalizedAssets {
  if (
    !isPlainRecord(value) ||
    Reflect.ownKeys(value).some((key) => !ASSET_KEYS.has(key)) ||
    Reflect.ownKeys(value).length !== ASSET_KEYS.size
  ) {
    throw new CompanionGatewayError("invalid-configuration");
  }
  let html: unknown;
  let css: unknown;
  let javascript: unknown;
  try {
    html = ownDataValue(value, "html");
    css = ownDataValue(value, "css");
    javascript = ownDataValue(value, "javascript");
  } catch {
    throw new CompanionGatewayError("invalid-configuration");
  }
  const normalized = Object.freeze({
    html: normalizeAsset(html),
    css: normalizeAsset(css),
    javascript: normalizeAsset(javascript)
  });
  if (
    normalized.html.byteLength +
      normalized.css.byteLength +
      normalized.javascript.byteLength >
    MAX_TOTAL_ASSET_BYTES
  ) {
    throw new CompanionGatewayError("invalid-configuration");
  }
  return normalized;
}

function readAssetFile(directory: string, fileName: string): Buffer {
  try {
    const path = realpathSync(join(directory, fileName));
    if (dirname(path) !== directory) {
      throw new CompanionGatewayError("invalid-configuration");
    }
    const stats = statSync(path);
    if (!stats.isFile() || stats.size < 1 || stats.size > MAX_ASSET_BYTES) {
      throw new CompanionGatewayError("invalid-configuration");
    }
    return readFileSync(path);
  } catch (error) {
    if (error instanceof CompanionGatewayError) throw error;
    throw new CompanionGatewayError("invalid-configuration");
  }
}

function normalizeAssetDirectory(value: unknown): NormalizedAssets {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new CompanionGatewayError("invalid-configuration");
  }
  let directory: string;
  try {
    directory = realpathSync(value);
    if (!statSync(directory).isDirectory()) {
      throw new CompanionGatewayError("invalid-configuration");
    }
  } catch (error) {
    if (error instanceof CompanionGatewayError) throw error;
    throw new CompanionGatewayError("invalid-configuration");
  }
  const normalized = Object.freeze({
    html: readAssetFile(directory, "index.html"),
    css: readAssetFile(directory, "styles.css"),
    javascript: readAssetFile(directory, "app.js")
  });
  if (
    normalized.html.byteLength +
      normalized.css.byteLength +
      normalized.javascript.byteLength >
    MAX_TOTAL_ASSET_BYTES
  ) {
    throw new CompanionGatewayError("invalid-configuration");
  }
  return normalized;
}

function normalizeOptions(options: CompanionGatewayOptions): NormalizedOptions {
  if (
    !isPlainRecord(options) ||
    Reflect.ownKeys(options).some((key) => !OPTION_KEYS.has(key))
  ) {
    throw new CompanionGatewayError("invalid-configuration");
  }
  let adapter: unknown;
  let assets: unknown;
  let assetDirectory: unknown;
  try {
    adapter = ownDataValue(options, "adapter");
    assets = optionalOwnDataValue(options, "assets");
    assetDirectory = optionalOwnDataValue(options, "assetDirectory");
  } catch {
    throw new CompanionGatewayError("invalid-configuration");
  }
  const clock = optionalOwnDataValue(options, "clock");
  const apiTimeoutMs = optionalOwnDataValue(options, "apiTimeoutMs");
  if (
    !isPlainRecord(adapter) ||
    typeof adapter["getDaily"] !== "function" ||
    typeof adapter["getProviderTotals"] !== "function" ||
    typeof adapter["getSummary"] !== "function" ||
    typeof adapter["probe"] !== "function" ||
    (assets === undefined) === (assetDirectory === undefined) ||
    (clock !== undefined && typeof clock !== "function") ||
    (apiTimeoutMs !== undefined &&
      (typeof apiTimeoutMs !== "number" ||
        !Number.isInteger(apiTimeoutMs) ||
        apiTimeoutMs < MIN_API_TIMEOUT_MS ||
        apiTimeoutMs > MAX_API_TIMEOUT_MS))
  ) {
    throw new CompanionGatewayError("invalid-configuration");
  }

  return Object.freeze({
    adapter: adapter as unknown as TokenTrackerAdapter,
    assets:
      assets === undefined
        ? normalizeAssetDirectory(assetDirectory)
        : normalizeAssets(assets as CompanionUiAssets),
    clock: (clock as CompanionGatewayClock | undefined) ?? (() => new Date()),
    apiTimeoutMs:
      (apiTimeoutMs as number | undefined) ?? DEFAULT_API_TIMEOUT_MS
  });
}

function setSecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

function sendBuffer(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  additionalHeaders: Readonly<Record<string, string>> = {}
): void {
  if (response.headersSent || response.destroyed) return;
  setSecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", String(body.byteLength));
  for (const [name, value] of Object.entries(additionalHeaders)) {
    response.setHeader(name, value);
  }
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  sendBuffer(
    response,
    status,
    "application/json; charset=utf-8",
    Buffer.from(JSON.stringify(value), "utf8")
  );
}

function sendRequestRejected(response: ServerResponse, status: number): void {
  sendJson(response, status, Object.freeze({ error: "request-rejected" }));
}

function rawHeaderValues(
  request: IncomingMessage,
  targetName: string
): readonly string[] {
  const values: string[] = [];
  const target = targetName.toLowerCase();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === target) {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
}

function hasAcceptedRequestHeaders(
  request: IncomingMessage,
  origin: string
): boolean {
  const hostValues = rawHeaderValues(request, "host");
  if (
    hostValues.length !== 1 ||
    hostValues[0] !== origin.slice("http://".length)
  ) {
    return false;
  }

  const originValues = rawHeaderValues(request, "origin");
  if (
    originValues.length > 1 ||
    (originValues.length === 1 && originValues[0] !== origin)
  ) {
    return false;
  }

  const fetchSiteValues = rawHeaderValues(request, "sec-fetch-site");
  if (
    fetchSiteValues.length > 1 ||
    (fetchSiteValues.length === 1 &&
      fetchSiteValues[0] !== "same-origin" &&
      fetchSiteValues[0] !== "none")
  ) {
    return false;
  }

  return (
    rawHeaderValues(request, "content-length").length === 0 &&
    rawHeaderValues(request, "transfer-encoding").length === 0
  );
}

function parseFixedPath(request: IncomingMessage, origin: string): string | null {
  const target = request.url;
  if (
    target === undefined ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("#") ||
    /[\\\u0000-\u001f\u007f]/u.test(target)
  ) {
    return null;
  }
  try {
    const parsed = new URL(target, origin);
    const rawPath = target.split("?", 1)[0];
    if (
      parsed.origin !== origin ||
      parsed.search !== "" ||
      rawPath !== parsed.pathname
    ) {
      return null;
    }
    return parsed.pathname;
  } catch {
    return null;
  }
}

function sessionCookieIsValid(
  request: IncomingMessage,
  expectedToken: string
): boolean {
  const cookieHeaders = rawHeaderValues(request, "cookie");
  if (cookieHeaders.length !== 1) return false;
  const matches: string[] = [];
  for (const part of cookieHeaders[0]!.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE_NAME) {
      matches.push(part.slice(separator + 1).trim());
    }
  }
  if (matches.length !== 1) return false;
  const supplied = Buffer.from(matches[0]!, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return (
    supplied.byteLength === expected.byteLength &&
    timingSafeEqual(supplied, expected)
  );
}

function utcDateFromInstant(instant: Date): string {
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    throw PROJECTION_ERROR;
  }
  return instant.toISOString().slice(0, 10);
}

function addUtcDays(utcDate: string, days: number): string {
  const time = Date.parse(`${utcDate}T00:00:00.000Z`);
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

function isSafeCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isUtcDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw PROJECTION_ERROR;
  return result;
}

const STARTER_PROVIDER_KEYS = [
  "openai",
  "anthropic",
  "google",
  "xai"
] as const;

function projectStarterSelection(
  upstream: TokenMonsterProviderTotals | null
): StarterCharacterSelection {
  if (upstream === null) {
    return selectStarterCharacter({ providerTotals28Days: null });
  }
  if (
    !isPlainRecord(upstream) ||
    Reflect.ownKeys(upstream).length !== STARTER_PROVIDER_KEYS.length ||
    STARTER_PROVIDER_KEYS.some(
      (key) =>
        !Reflect.ownKeys(upstream).includes(key) ||
        !isSafeCount(ownDataValue(upstream, key))
    )
  ) {
    throw PROJECTION_ERROR;
  }
  const providerTotals28Days = Object.freeze(
    Object.fromEntries(
      STARTER_PROVIDER_KEYS.map((key) => [key, ownDataValue(upstream, key)])
    )
  ) as StarterProviderTotals28Days;
  return selectStarterCharacter({ providerTotals28Days });
}

function projectCompanionResponse(
  upstream: TokenMonsterDailyAggregateResponse,
  providerTotals: TokenMonsterProviderTotals | null,
  expectedRange: TokenTrackerAggregateRange,
  generatedAt: string
): CompanionApiHealthyResponse {
  if (!isPlainRecord(upstream)) throw PROJECTION_ERROR;
  const fromUtcDate = ownDataValue(upstream, "fromUtcDate");
  const toUtcDate = ownDataValue(upstream, "toUtcDate");
  const rawDays = ownDataValue(upstream, "days");
  if (
    fromUtcDate !== expectedRange.fromUtcDate ||
    toUtcDate !== expectedRange.toUtcDate ||
    !Array.isArray(rawDays) ||
    rawDays.length > OBSERVATION_DAYS ||
    rawDays.length > MAX_TOKEN_TRACKER_RANGE_DAYS
  ) {
    throw PROJECTION_ERROR;
  }

  const last7Start = addUtcDays(expectedRange.toUtcDate, -6);
  const daily: CompanionDailyTotal[] = [];
  let previousUtcDate = "";
  let today = 0;
  let last7Days = 0;
  let last28Days = 0;

  for (const rawDay of rawDays) {
    if (!isPlainRecord(rawDay)) throw PROJECTION_ERROR;
    const utcDate = ownDataValue(rawDay, "utcDate");
    const rawTokens = ownDataValue(rawDay, "tokens");
    if (
      !isUtcDate(utcDate) ||
      utcDate < expectedRange.fromUtcDate ||
      utcDate > expectedRange.toUtcDate ||
      (previousUtcDate !== "" && utcDate <= previousUtcDate) ||
      !isPlainRecord(rawTokens)
    ) {
      throw PROJECTION_ERROR;
    }
    const totalTokens = ownDataValue(rawTokens, "totalTokens");
    if (!isSafeCount(totalTokens)) throw PROJECTION_ERROR;
    previousUtcDate = utcDate;
    last28Days = checkedAdd(last28Days, totalTokens);
    if (utcDate >= last7Start) {
      last7Days = checkedAdd(last7Days, totalTokens);
    }
    if (utcDate === expectedRange.toUtcDate) {
      today = checkedAdd(today, totalTokens);
    }
    daily.push(Object.freeze({ utcDate, totalTokens }));
  }

  return Object.freeze({
    status: "healthy",
    generatedAt,
    starter: projectStarterSelection(providerTotals),
    totals: Object.freeze({ today, last7Days, last28Days }),
    daily: Object.freeze(daily)
  });
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(API_TIMEOUT), timeoutMs);
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function classifyApiError(error: unknown): CompanionApiErrorCode {
  if (
    error === PROJECTION_ERROR ||
    (error instanceof TokenTrackerAdapterError &&
      (error.code === "incompatible-schema" ||
        error.code === "malformed-response" ||
        error.code === "response-too-large"))
  ) {
    return "sidecar-incompatible";
  }
  return "sidecar-unavailable";
}

function sendApiError(
  response: ServerResponse,
  code: CompanionApiErrorCode
): void {
  const payload: CompanionApiErrorResponse = Object.freeze({
    status: "error",
    error: code
  });
  sendJson(response, code === "sidecar-incompatible" ? 502 : 503, payload);
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new CompanionGatewayError("invalid-configuration");
  }
}

export function createCompanionGateway(
  options: CompanionGatewayOptions
): CompanionGateway {
  const normalized = normalizeOptions(options);
  const bootstrapToken = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const sessionToken = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const bootstrapPath = `${BOOTSTRAP_PREFIX}${bootstrapToken}`;
  let state: "idle" | "starting" | "listening" | "closed" = "idle";
  let origin: string | null = null;
  let activeApiRequests = 0;
  let bootstrapAvailable = true;

  const server: Server = createServer(
    { maxHeaderSize: 16 * 1_024 },
    (request, response) => {
      void (async (): Promise<void> => {
        const activeOrigin = origin;
        if (state !== "listening" || activeOrigin === null) {
          sendRequestRejected(response, 503);
          return;
        }
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET");
          sendRequestRejected(response, 405);
          return;
        }
        if (!hasAcceptedRequestHeaders(request, activeOrigin)) {
          sendRequestRejected(response, 403);
          return;
        }
        const path = parseFixedPath(request, activeOrigin);
        if (path === null) {
          sendRequestRejected(response, 404);
          return;
        }

        if (path === bootstrapPath && bootstrapAvailable) {
          bootstrapAvailable = false;
          sendBuffer(
            response,
            303,
            "text/plain; charset=utf-8",
            Buffer.from("Continue to TokenMonster.", "utf8"),
            Object.freeze({
              Location: "/",
              "Set-Cookie": `${SESSION_COOKIE_NAME}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`
            })
          );
          return;
        }

        if (!sessionCookieIsValid(request, sessionToken)) {
          sendRequestRejected(response, 404);
          return;
        }
        if (path === "/") {
          sendBuffer(
            response,
            200,
            "text/html; charset=utf-8",
            normalized.assets.html
          );
          return;
        }
        if (path === STYLESHEET_PATH) {
          sendBuffer(
            response,
            200,
            "text/css; charset=utf-8",
            normalized.assets.css
          );
          return;
        }
        if (path === JAVASCRIPT_PATH) {
          sendBuffer(
            response,
            200,
            "text/javascript; charset=utf-8",
            normalized.assets.javascript
          );
          return;
        }
        if (path !== COMPANION_API_PATH) {
          sendRequestRejected(response, 404);
          return;
        }
        if (activeApiRequests >= MAX_CONCURRENT_API_REQUESTS) {
          sendApiError(response, "sidecar-unavailable");
          return;
        }

        activeApiRequests += 1;
        try {
          const instant = normalized.clock();
          const toUtcDate = utcDateFromInstant(instant);
          const range = Object.freeze({
            fromUtcDate: addUtcDays(toUtcDate, -(OBSERVATION_DAYS - 1)),
            toUtcDate
          });
          const [upstream, providerTotals] = await Promise.all([
            withTimeout(
              normalized.adapter.getDaily(range),
              normalized.apiTimeoutMs
            ),
            withTimeout(
              normalized.adapter.getProviderTotals(range),
              normalized.apiTimeoutMs
            ).catch(() => null)
          ]);
          sendJson(
            response,
            200,
            projectCompanionResponse(
              upstream,
              providerTotals,
              range,
              instant.toISOString()
            )
          );
        } catch (error) {
          sendApiError(response, classifyApiError(error));
        } finally {
          activeApiRequests -= 1;
        }
      })().catch(() => {
        sendApiError(response, "sidecar-unavailable");
      });
    }
  );

  server.maxHeadersCount = 64;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 2_000;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
  });

  return Object.freeze({
    async start(port = 0): Promise<CompanionGatewayAddress> {
      validatePort(port);
      if (state === "closed") throw new CompanionGatewayError("closed");
      if (state !== "idle") {
        throw new CompanionGatewayError("already-started");
      }
      state = "starting";
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => {
            server.off("listening", onListening);
            reject(error);
          };
          const onListening = (): void => {
            server.off("error", onError);
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen({ host: LOOPBACK_HOST, port, exclusive: true });
        });
      } catch (error) {
        state = "idle";
        throw error;
      }
      const address = server.address();
      if (
        address === null ||
        typeof address === "string" ||
        (address as AddressInfo).address !== LOOPBACK_HOST
      ) {
        state = "closed";
        server.closeAllConnections();
        throw new CompanionGatewayError("invalid-configuration");
      }
      const boundPort = (address as AddressInfo).port;
      origin = `http://${LOOPBACK_HOST}:${boundPort}`;
      state = "listening";
      return Object.freeze({
        host: LOOPBACK_HOST,
        port: boundPort,
        origin,
        bootstrapUrl: `${origin}${bootstrapPath}`
      });
    },

    async close(): Promise<void> {
      if (state === "closed") return;
      if (state === "idle") {
        state = "closed";
        return;
      }
      if (state === "starting") {
        throw new CompanionGatewayError("already-started");
      }
      state = "closed";
      origin = null;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
        server.closeAllConnections();
      });
    }
  });
}
