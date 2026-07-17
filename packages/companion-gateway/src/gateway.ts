import { Buffer } from "node:buffer";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
  MAX_TOKEN_TRACKER_MODEL_NAME_LENGTH,
  TOKEN_MONSTER_USAGE_FAMILIES,
  TokenTrackerAdapterError,
  type TokenMonsterDailyAggregateResponse,
  type TokenMonsterDailyFamilySeries,
  type TokenMonsterModelUsageResponse,
  type TokenMonsterProviderTotals,
  type TokenMonsterUsageFamily,
  type TokenTrackerAdapter,
  type TokenTrackerAggregateRange
} from "@tokenmonster/token-tracker-adapter";

import {
  createCharacterService,
  normalizeCharacterOptions
} from "./character-service.js";
import { CompanionGatewayError } from "./errors.js";
import type {
  CompanionApiErrorCode,
  CompanionApiErrorResponse,
  CompanionApiHealthyResponse,
  CompanionCollectorController,
  CompanionCollectorPhase,
  CompanionCollectorStatus,
  CompanionDailyTotal,
  CompanionGateway,
  CompanionGatewayAddress,
  CompanionGatewayClock,
  CompanionGatewayOptions,
  CompanionQuotaResponse,
  CompanionCharacterFetch,
  CompanionUiAssets,
  CompanionUsageFamiliesResponse,
  CompanionUsageFamilyDay,
  CompanionUsageModel,
  CompanionUsageModelsResponse,
  CompanionUsageWindow
} from "./types.js";
import {
  QUOTA_CATALOG_FAMILIES,
  findQuotaPlan,
  isQuotaCatalogFamily,
  type QuotaCatalogFamily
} from "./quota-catalog.js";
import { dailyEquivalentBudget } from "./quota-estimator.js";
import {
  loadQuotaPlanSelections,
  quotaPlansPath,
  saveQuotaPlanSelections,
  withQuotaPlanSelection
} from "./quota-store.js";

const LOOPBACK_HOST = "127.0.0.1" as const;
const COMPANION_API_PATH = "/api/companion";
const COLLECTOR_STATUS_PATH = "/api/companion/status";
const COLLECTOR_REFRESH_PATH = "/api/companion/refresh";
const CHARACTERS_API_PATH = "/api/characters";
const USAGE_FAMILIES_API_PATH = "/api/usage/families";
const USAGE_MODELS_API_PATH = "/api/usage/models";
const USAGE_QUOTA_API_PATH = "/api/usage/quota";
const USAGE_QUOTA_PLAN_API_PATH = "/api/usage/quota/plan";
const CHARACTER_SELECT_PATH = "/api/characters/select";
const CHARACTER_WARDROBE_PATH = "/api/characters/wardrobe";
const CHARACTER_ASSET_PREFIX = "/assets/characters/objects/";
const STYLESHEET_PATH = "/assets/companion.css";
const UI_SCRIPT_PATH_PREFIX = "/assets/";
const UI_SCRIPT_ENTRY = "main.js";
const UI_SCRIPT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*\.js$/u;
const MAX_UI_SCRIPT_FILES = 64;
const BOOTSTRAP_PREFIX = "/__tokenmonster/bootstrap/";
// The floating pet shell opts into its compact layout by requesting the root
// page with exactly this query. It is the only non-analytics query accepted;
// the one-shot bootstrap path never carries it.
const PET_VIEW_SEARCH = "?view=pet";
const SESSION_COOKIE_NAME = "tokenmonster_session";
const SESSION_TOKEN_BYTES = 32;
const OBSERVATION_DAYS = 28;
const DEFAULT_API_TIMEOUT_MS = 3_000;
const MIN_API_TIMEOUT_MS = 10;
const MAX_API_TIMEOUT_MS = 10_000;
const MAX_ASSET_BYTES = 2 * 1_024 * 1_024;
const MAX_TOTAL_ASSET_BYTES = 6 * 1_024 * 1_024;
const MAX_CONCURRENT_API_REQUESTS = 8;
const MIN_REFRESH_REQUEST_INTERVAL_MS = 5_000;
const OPTION_KEYS = new Set<PropertyKey>([
  "adapter",
  "collector",
  "assets",
  "assetDirectory",
  "characters",
  "clock",
  "apiTimeoutMs"
]);
const ASSET_KEYS = new Set<PropertyKey>(["html", "css", "scripts"]);
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
  readonly scripts: ReadonlyMap<string, Buffer>;
}

interface NormalizedOptions {
  readonly adapter: TokenTrackerAdapter;
  readonly collector: CompanionCollectorController;
  readonly characters: ReturnType<typeof normalizeCharacterOptions>;
  readonly assets: NormalizedAssets;
  readonly clock: CompanionGatewayClock;
  readonly apiTimeoutMs: number;
}

interface ParsedRequestTarget {
  readonly path: string;
  readonly searchParams: URLSearchParams;
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

function isSafeScriptName(name: string): boolean {
  return name.length <= 64 && UI_SCRIPT_NAME_PATTERN.test(name);
}

function assertScriptMap(scripts: ReadonlyMap<string, Buffer>): void {
  if (
    scripts.size < 1 ||
    scripts.size > MAX_UI_SCRIPT_FILES ||
    !scripts.has(UI_SCRIPT_ENTRY)
  ) {
    throw new CompanionGatewayError("invalid-configuration");
  }
}

function assertTotalAssetBytes(normalized: NormalizedAssets): void {
  let totalBytes = normalized.html.byteLength + normalized.css.byteLength;
  for (const script of normalized.scripts.values()) {
    totalBytes += script.byteLength;
  }
  if (totalBytes > MAX_TOTAL_ASSET_BYTES) {
    throw new CompanionGatewayError("invalid-configuration");
  }
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
  let scriptsInput: unknown;
  try {
    html = ownDataValue(value, "html");
    css = ownDataValue(value, "css");
    scriptsInput = ownDataValue(value, "scripts");
  } catch {
    throw new CompanionGatewayError("invalid-configuration");
  }
  if (!isPlainRecord(scriptsInput)) {
    throw new CompanionGatewayError("invalid-configuration");
  }
  const scripts = new Map<string, Buffer>();
  for (const key of Reflect.ownKeys(scriptsInput)) {
    if (typeof key !== "string" || !isSafeScriptName(key)) {
      throw new CompanionGatewayError("invalid-configuration");
    }
    let script: unknown;
    try {
      script = ownDataValue(scriptsInput, key);
    } catch {
      throw new CompanionGatewayError("invalid-configuration");
    }
    scripts.set(key, normalizeAsset(script));
  }
  assertScriptMap(scripts);
  const normalized = Object.freeze({
    html: normalizeAsset(html),
    css: normalizeAsset(css),
    scripts
  });
  assertTotalAssetBytes(normalized);
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
  let scriptNames: readonly string[];
  try {
    scriptNames = readdirSync(directory).filter(isSafeScriptName).sort();
  } catch {
    throw new CompanionGatewayError("invalid-configuration");
  }
  const scripts = new Map<string, Buffer>();
  for (const name of scriptNames) {
    scripts.set(name, readAssetFile(directory, name));
  }
  assertScriptMap(scripts);
  const normalized = Object.freeze({
    html: readAssetFile(directory, "index.html"),
    css: readAssetFile(directory, "styles.css"),
    scripts
  });
  assertTotalAssetBytes(normalized);
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
  let collector: unknown;
  let assets: unknown;
  let assetDirectory: unknown;
  let characters: unknown;
  try {
    adapter = ownDataValue(options, "adapter");
    collector = ownDataValue(options, "collector");
    assets = optionalOwnDataValue(options, "assets");
    assetDirectory = optionalOwnDataValue(options, "assetDirectory");
    characters = ownDataValue(options, "characters");
  } catch {
    throw new CompanionGatewayError("invalid-configuration");
  }
  const clock = optionalOwnDataValue(options, "clock");
  const apiTimeoutMs = optionalOwnDataValue(options, "apiTimeoutMs");
  if (
    !isPlainRecord(adapter) ||
    typeof adapter["getDaily"] !== "function" ||
    typeof adapter["getProviderTotals"] !== "function" ||
    typeof adapter["getProgressionFamilyTotals"] !== "function" ||
    typeof adapter["getDailyFamilySeries"] !== "function" ||
    typeof adapter["getModelUsage"] !== "function" ||
    typeof adapter["getSummary"] !== "function" ||
    typeof adapter["probe"] !== "function" ||
    !isPlainRecord(collector) ||
    typeof collector["getStatus"] !== "function" ||
    typeof collector["requestRefresh"] !== "function" ||
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

  const nativeCharacterFetch: CompanionCharacterFetch = async (url, init) =>
    fetch(url, {
      method: init.method,
      redirect: init.redirect,
      signal: init.signal
    });
  let normalizedCharacters: ReturnType<typeof normalizeCharacterOptions>;
  try {
    normalizedCharacters = normalizeCharacterOptions(
      characters,
      nativeCharacterFetch
    );
  } catch {
    throw new CompanionGatewayError("invalid-configuration");
  }

  return Object.freeze({
    adapter: adapter as unknown as TokenTrackerAdapter,
    collector: collector as unknown as CompanionCollectorController,
    characters: normalizedCharacters,
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

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  additionalHeaders: Readonly<Record<string, string>> = {}
): void {
  sendBuffer(
    response,
    status,
    "application/json; charset=utf-8",
    Buffer.from(JSON.stringify(value), "utf8"),
    additionalHeaders
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
  origin: string,
  acceptsJsonBody: boolean
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

  const contentLengthValues = rawHeaderValues(request, "content-length");
  if (acceptsJsonBody) {
    return (
      request.method === "POST" &&
      contentLengthValues.length === 1 &&
      /^\d+$/u.test(contentLengthValues[0]!) &&
      rawHeaderValues(request, "transfer-encoding").length === 0
    );
  }
  return (
    (contentLengthValues.length === 0 ||
      (request.method === "POST" &&
        contentLengthValues.length === 1 &&
        contentLengthValues[0] === "0")) &&
    rawHeaderValues(request, "transfer-encoding").length === 0
  );
}

async function readCharacterJsonBody(
  request: IncomingMessage,
  expectedKeys: readonly string[]
): Promise<Record<string, unknown> | null> {
  const contentTypes = rawHeaderValues(request, "content-type");
  const contentLengths = rawHeaderValues(request, "content-length");
  if (
    contentTypes.length !== 1 ||
    contentTypes[0]!.trim().toLowerCase() !== "application/json" ||
    contentLengths.length !== 1 ||
    !/^\d+$/u.test(contentLengths[0]!) ||
    Number(contentLengths[0]) > 512
  ) {
    return null;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const bodyChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += bodyChunk.byteLength;
    if (bytes > 512) return null;
    chunks.push(bodyChunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (
    !isPlainRecord(parsed) ||
    Reflect.ownKeys(parsed).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Reflect.ownKeys(parsed).includes(key))
  ) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function sendInvalidCharacterRequest(response: ServerResponse): void {
  sendJson(response, 400, { status: "error", error: "invalid-request" });
}

function hasAcceptedMutationHeaders(
  request: IncomingMessage,
  origin: string
): boolean {
  const originValues = rawHeaderValues(request, "origin");
  return originValues.length === 1 && originValues[0] === origin;
}

function parseFixedTarget(
  request: IncomingMessage,
  origin: string
): ParsedRequestTarget | null {
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
      rawPath !== parsed.pathname
    ) {
      return null;
    }
    if (
      parsed.search !== "" &&
      !(parsed.pathname === "/" && parsed.search === PET_VIEW_SEARCH) &&
      parsed.pathname !== USAGE_FAMILIES_API_PATH &&
      parsed.pathname !== USAGE_MODELS_API_PATH
    ) {
      return null;
    }
    return Object.freeze({
      path: parsed.pathname,
      searchParams: parsed.searchParams
    });
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

const USAGE_WINDOWS = Object.freeze([
  7,
  28,
  90
] as const satisfies readonly CompanionUsageWindow[]);
const USAGE_FAMILY_KEYS = TOKEN_MONSTER_USAGE_FAMILIES;
const USAGE_FAMILY_SET = new Set<TokenMonsterUsageFamily>(USAGE_FAMILY_KEYS);

function parseUsageWindow(value: string | null): CompanionUsageWindow | null {
  if (value === null || !/^(?:7|28|90)$/u.test(value)) return null;
  const window = Number(value);
  return USAGE_WINDOWS.find((candidate) => candidate === window) ?? null;
}

function parseUsageQuery(
  path: string,
  searchParams: URLSearchParams
): Readonly<{ window: CompanionUsageWindow; limit: number | null }> | null {
  const entries = [...searchParams.entries()];
  const window = parseUsageWindow(searchParams.get("window"));
  if (window === null) return null;
  if (path === USAGE_FAMILIES_API_PATH) {
    if (entries.length !== 1 || entries[0]?.[0] !== "window") return null;
    return Object.freeze({ window, limit: null });
  }
  if (
    path !== USAGE_MODELS_API_PATH ||
    entries.length !== 2 ||
    entries.filter(([key]) => key === "window").length !== 1 ||
    entries.filter(([key]) => key === "limit").length !== 1
  ) {
    return null;
  }
  const rawLimit = searchParams.get("limit");
  if (rawLimit === null || !/^(?:[1-9]|[1-4]\d|50)$/u.test(rawLimit)) {
    return null;
  }
  return Object.freeze({ window, limit: Number(rawLimit) });
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

function hasExactKeys(
  value: Record<PropertyKey, unknown>,
  keys: readonly string[]
): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    keys.every((key) => ownKeys.includes(key))
  );
}

function projectUsageFamiliesResponse(
  upstream: TokenMonsterDailyFamilySeries,
  window: CompanionUsageWindow,
  toUtcDate: string
): CompanionUsageFamiliesResponse {
  if (!isPlainRecord(upstream) || !hasExactKeys(upstream, ["days"])) {
    throw PROJECTION_ERROR;
  }
  const rawDays = ownDataValue(upstream, "days");
  if (!Array.isArray(rawDays) || rawDays.length !== window) {
    throw PROJECTION_ERROR;
  }
  const fromUtcDate = addUtcDays(toUtcDate, -(window - 1));
  const days: CompanionUsageFamilyDay[] = rawDays.map((rawDay, index) => {
    if (!isPlainRecord(rawDay) || !hasExactKeys(rawDay, ["utcDate", "families"])) {
      throw PROJECTION_ERROR;
    }
    const utcDate = ownDataValue(rawDay, "utcDate");
    const rawFamilies = ownDataValue(rawDay, "families");
    if (
      utcDate !== addUtcDays(fromUtcDate, index) ||
      !isPlainRecord(rawFamilies) ||
      !hasExactKeys(rawFamilies, USAGE_FAMILY_KEYS)
    ) {
      throw PROJECTION_ERROR;
    }
    const families = Object.fromEntries(
      USAGE_FAMILY_KEYS.map((family) => {
        const total = ownDataValue(rawFamilies, family);
        if (!isSafeCount(total)) throw PROJECTION_ERROR;
        return [family, total];
      })
    ) as Record<TokenMonsterUsageFamily, number>;
    return Object.freeze({ utcDate, families: Object.freeze(families) });
  });
  return Object.freeze({ window, days: Object.freeze(days) });
}

function projectUsageModelsResponse(
  upstream: TokenMonsterModelUsageResponse,
  window: CompanionUsageWindow,
  limit: number
): CompanionUsageModelsResponse {
  if (!isPlainRecord(upstream) || !hasExactKeys(upstream, ["models"])) {
    throw PROJECTION_ERROR;
  }
  const rawModels = ownDataValue(upstream, "models");
  if (!Array.isArray(rawModels) || rawModels.length > limit) {
    throw PROJECTION_ERROR;
  }
  let previousTotal = Number.MAX_SAFE_INTEGER;
  const models: CompanionUsageModel[] = rawModels.map((rawModel) => {
    if (!isPlainRecord(rawModel)) throw PROJECTION_ERROR;
    const keys = Reflect.ownKeys(rawModel);
    const allowedKeys = [
      "model",
      "family",
      "totalTokens",
      "inputTokens",
      "outputTokens"
    ];
    if (
      keys.length < 3 ||
      keys.length > allowedKeys.length ||
      keys.some((key) => !allowedKeys.includes(String(key))) ||
      !keys.includes("model") ||
      !keys.includes("family") ||
      !keys.includes("totalTokens")
    ) {
      throw PROJECTION_ERROR;
    }
    const model = ownDataValue(rawModel, "model");
    const family = ownDataValue(rawModel, "family");
    const totalTokens = ownDataValue(rawModel, "totalTokens");
    const inputTokens = keys.includes("inputTokens")
      ? ownDataValue(rawModel, "inputTokens")
      : undefined;
    const outputTokens = keys.includes("outputTokens")
      ? ownDataValue(rawModel, "outputTokens")
      : undefined;
    if (
      typeof model !== "string" ||
      model.length < 1 ||
      model.length > MAX_TOKEN_TRACKER_MODEL_NAME_LENGTH ||
      model.trim() !== model ||
      typeof family !== "string" ||
      !USAGE_FAMILY_SET.has(family as TokenMonsterUsageFamily) ||
      !isSafeCount(totalTokens) ||
      totalTokens > previousTotal ||
      (inputTokens !== undefined && !isSafeCount(inputTokens)) ||
      (outputTokens !== undefined && !isSafeCount(outputTokens))
    ) {
      throw PROJECTION_ERROR;
    }
    previousTotal = totalTokens;
    return Object.freeze({
      model,
      family: family as TokenMonsterUsageFamily,
      totalTokens,
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens })
    });
  });
  return Object.freeze({ window, models: Object.freeze(models) });
}

function projectCurrentDayFamilyUsage(
  upstream: TokenMonsterDailyFamilySeries,
  utcDate: string
): Readonly<Record<QuotaCatalogFamily, number>> {
  if (!isPlainRecord(upstream) || !hasExactKeys(upstream, ["days"])) {
    throw PROJECTION_ERROR;
  }
  const days = ownDataValue(upstream, "days");
  if (!Array.isArray(days) || days.length !== 1) throw PROJECTION_ERROR;
  const day = days[0];
  if (
    !isPlainRecord(day) ||
    !hasExactKeys(day, ["utcDate", "families"]) ||
    ownDataValue(day, "utcDate") !== utcDate
  ) {
    throw PROJECTION_ERROR;
  }
  const rawFamilies = ownDataValue(day, "families");
  if (!isPlainRecord(rawFamilies) || !hasExactKeys(rawFamilies, USAGE_FAMILY_KEYS)) {
    throw PROJECTION_ERROR;
  }
  const families = Object.fromEntries(
    QUOTA_CATALOG_FAMILIES.map((family) => {
      const value = ownDataValue(rawFamilies, family);
      if (!isSafeCount(value)) throw PROJECTION_ERROR;
      return [family, value];
    })
  ) as Record<QuotaCatalogFamily, number>;
  return Object.freeze(families);
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

const COLLECTOR_PHASES = Object.freeze([
  "starting",
  "syncing",
  "ready",
  "ready-no-data",
  "refresh-failed",
  "stale"
] as const satisfies readonly CompanionCollectorPhase[]);

function isCollectorPhase(value: unknown): value is CompanionCollectorPhase {
  return COLLECTOR_PHASES.some((phase) => phase === value);
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
  );
}

function projectCollectorStatus(value: unknown): CompanionCollectorStatus {
  if (
    !isPlainRecord(value) ||
    Reflect.ownKeys(value).length !== 4 ||
    !Reflect.ownKeys(value).includes("phase") ||
    !Reflect.ownKeys(value).includes("lastSuccessAt") ||
    !Reflect.ownKeys(value).includes("consecutiveFailures") ||
    !Reflect.ownKeys(value).includes("canRetry")
  ) {
    throw PROJECTION_ERROR;
  }
  const phase = ownDataValue(value, "phase");
  const lastSuccessAt = ownDataValue(value, "lastSuccessAt");
  const consecutiveFailures = ownDataValue(value, "consecutiveFailures");
  const canRetry = ownDataValue(value, "canRetry");
  if (
    !isCollectorPhase(phase) ||
    (lastSuccessAt !== null && !isIsoInstant(lastSuccessAt)) ||
    !isSafeCount(consecutiveFailures) ||
    typeof canRetry !== "boolean" ||
    ((phase === "ready" || phase === "ready-no-data") &&
      (lastSuccessAt === null || consecutiveFailures !== 0)) ||
    (phase === "refresh-failed" &&
      (lastSuccessAt !== null || consecutiveFailures < 1)) ||
    (phase === "stale" &&
      (lastSuccessAt === null || consecutiveFailures < 1))
  ) {
    throw PROJECTION_ERROR;
  }
  return Object.freeze({
    phase,
    lastSuccessAt,
    consecutiveFailures,
    canRetry
  });
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
  const characterService = createCharacterService({
    adapter: normalized.adapter,
    characters: normalized.characters,
    clock: normalized.clock
  });
  const quotaPlanFile = quotaPlansPath(
    normalized.characters.progressionStorePath
  );
  const bootstrapToken = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const sessionToken = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const bootstrapPath = `${BOOTSTRAP_PREFIX}${bootstrapToken}`;
  let state: "idle" | "starting" | "listening" | "closed" = "idle";
  let origin: string | null = null;
  let activeApiRequests = 0;
  let bootstrapAvailable = true;
  let refreshRequestInFlight: Promise<CompanionCollectorStatus> | null = null;
  let lastRefreshRequestAtMs: number | null = null;
  let quotaStoreMutation = Promise.resolve();

  const serializeQuotaStore = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = quotaStoreMutation;
    let release!: () => void;
    quotaStoreMutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const buildQuotaResponse = async (): Promise<CompanionQuotaResponse> => {
    const instant = normalized.clock();
    const generatedAt = instant.toISOString();
    const utcDate = utcDateFromInstant(instant);
    const [selections, upstream] = await Promise.all([
      serializeQuotaStore(() => loadQuotaPlanSelections(quotaPlanFile)),
      withTimeout(
        normalized.adapter.getDailyFamilySeries({
          fromUtcDate: utcDate,
          toUtcDate: utcDate
        }),
        normalized.apiTimeoutMs
      )
    ]);
    const usage = projectCurrentDayFamilyUsage(upstream, utcDate);
    const families = QUOTA_CATALOG_FAMILIES.map((family) => {
      const selectedPlanId = selections.plans[family] ?? null;
      const plan =
        selectedPlanId === null
          ? undefined
          : findQuotaPlan(family, selectedPlanId);
      return Object.freeze({
        family,
        planId: plan?.planId ?? null,
        // Daily-only upstream data makes UTC day the honest active window.
        windowHours: 24,
        windowKind: "utc-day" as const,
        usedTokens: usage[family]!,
        budgetTokens: plan === undefined ? null : dailyEquivalentBudget(plan),
        estimate: true as const
      });
    });
    return Object.freeze({
      status: "ok",
      generatedAt,
      families: Object.freeze(families)
    });
  };

  const readCollectorStatus = (): CompanionCollectorStatus =>
    projectCollectorStatus(normalized.collector.getStatus());

  const requestCollectorRefresh = (): Promise<CompanionCollectorStatus> => {
    if (refreshRequestInFlight !== null) return refreshRequestInFlight;
    const operation = Promise.resolve()
      .then(() => normalized.collector.requestRefresh())
      .then(projectCollectorStatus)
      .catch(() => readCollectorStatus());
    const wrappedOperation = operation.finally(() => {
      if (refreshRequestInFlight === wrappedOperation) {
        refreshRequestInFlight = null;
      }
    });
    refreshRequestInFlight = wrappedOperation;
    return wrappedOperation;
  };

  const server: Server = createServer(
    { maxHeaderSize: 16 * 1_024 },
    (request, response) => {
      void (async (): Promise<void> => {
        const activeOrigin = origin;
        if (state !== "listening" || activeOrigin === null) {
          sendRequestRejected(response, 503);
          return;
        }
        if (request.method !== "GET" && request.method !== "POST") {
          response.setHeader("Allow", "GET, POST");
          sendRequestRejected(response, 405);
          return;
        }
        const target = parseFixedTarget(request, activeOrigin);
        if (target === null) {
          sendRequestRejected(response, 404);
          return;
        }
        const path = target.path;
        const acceptsJsonBody =
          request.method === "POST" &&
          (path === CHARACTER_SELECT_PATH ||
            path === CHARACTER_WARDROBE_PATH ||
            path === USAGE_QUOTA_PLAN_API_PATH);
        if (!hasAcceptedRequestHeaders(request, activeOrigin, acceptsJsonBody)) {
          sendRequestRejected(response, 403);
          return;
        }

        if (
          request.method === "GET" &&
          path === bootstrapPath &&
          bootstrapAvailable
        ) {
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
        if (path === "/" || path === STYLESHEET_PATH) {
          if (request.method !== "GET") {
            response.setHeader("Allow", "GET");
            sendRequestRejected(response, 405);
            return;
          }
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
        if (path.startsWith(UI_SCRIPT_PATH_PREFIX)) {
          const script = normalized.assets.scripts.get(
            path.slice(UI_SCRIPT_PATH_PREFIX.length)
          );
          if (script !== undefined) {
            if (request.method !== "GET") {
              response.setHeader("Allow", "GET");
              sendRequestRejected(response, 405);
              return;
            }
            sendBuffer(
              response,
              200,
              "text/javascript; charset=utf-8",
              script
            );
            return;
          }
        }
        if (path === CHARACTERS_API_PATH) {
          if (request.method !== "GET") {
            response.setHeader("Allow", "GET");
            sendRequestRejected(response, 405);
            return;
          }
          sendJson(response, 200, await characterService.getCharactersDto());
          return;
        }
        if (path === CHARACTER_SELECT_PATH) {
          if (request.method !== "POST") {
            response.setHeader("Allow", "POST");
            sendRequestRejected(response, 405);
            return;
          }
          if (!hasAcceptedMutationHeaders(request, activeOrigin)) {
            sendRequestRejected(response, 403);
            return;
          }
          const body = await readCharacterJsonBody(request, ["characterId"]);
          if (body === null) {
            sendInvalidCharacterRequest(response);
            return;
          }
          const result = await characterService.selectCharacter(body["characterId"]);
          sendJson(response, result.status, result.body);
          return;
        }
        if (path === CHARACTER_WARDROBE_PATH) {
          if (request.method !== "POST") {
            response.setHeader("Allow", "POST");
            sendRequestRejected(response, 405);
            return;
          }
          if (!hasAcceptedMutationHeaders(request, activeOrigin)) {
            sendRequestRejected(response, 403);
            return;
          }
          const body = await readCharacterJsonBody(request, [
            "characterId",
            "themeId"
          ]);
          if (body === null) {
            sendInvalidCharacterRequest(response);
            return;
          }
          const result = await characterService.selectWardrobe(
            body["characterId"],
            body["themeId"]
          );
          sendJson(response, result.status, result.body);
          return;
        }
        if (path.startsWith(CHARACTER_ASSET_PREFIX)) {
          if (request.method !== "GET") {
            response.setHeader("Allow", "GET");
            sendRequestRejected(response, 405);
            return;
          }
          const fileName = path.slice(CHARACTER_ASSET_PREFIX.length);
          const asset = await characterService.getAsset(fileName);
          if (
            asset.status !== 200 ||
            asset.body === undefined ||
            asset.contentType === undefined
          ) {
            sendRequestRejected(response, asset.status);
            return;
          }
          sendBuffer(response, 200, asset.contentType, asset.body, {
            "Cache-Control": "public, max-age=31536000, immutable"
          });
          return;
        }
        if (path === USAGE_QUOTA_API_PATH) {
          if (request.method !== "GET") {
            response.setHeader("Allow", "GET");
            sendRequestRejected(response, 405);
            return;
          }
          if (activeApiRequests >= MAX_CONCURRENT_API_REQUESTS) {
            sendApiError(response, "sidecar-unavailable");
            return;
          }
          activeApiRequests += 1;
          try {
            sendJson(response, 200, await buildQuotaResponse());
          } catch (error) {
            sendApiError(response, classifyApiError(error));
          } finally {
            activeApiRequests -= 1;
          }
          return;
        }
        if (path === USAGE_QUOTA_PLAN_API_PATH) {
          if (request.method !== "POST") {
            response.setHeader("Allow", "POST");
            sendRequestRejected(response, 405);
            return;
          }
          if (!hasAcceptedMutationHeaders(request, activeOrigin)) {
            sendRequestRejected(response, 403);
            return;
          }
          const body = await readCharacterJsonBody(request, ["family", "planId"]);
          const family = body?.["family"];
          const planId = body?.["planId"];
          if (
            !isQuotaCatalogFamily(family) ||
            (planId !== null &&
              (typeof planId !== "string" ||
                findQuotaPlan(family, planId) === undefined))
          ) {
            sendInvalidCharacterRequest(response);
            return;
          }
          if (activeApiRequests >= MAX_CONCURRENT_API_REQUESTS) {
            sendApiError(response, "sidecar-unavailable");
            return;
          }
          activeApiRequests += 1;
          try {
            await serializeQuotaStore(async () => {
              const selections = await loadQuotaPlanSelections(quotaPlanFile);
              await saveQuotaPlanSelections(
                quotaPlanFile,
                withQuotaPlanSelection(selections, family, planId)
              );
            });
            sendJson(response, 200, await buildQuotaResponse());
          } catch (error) {
            sendApiError(response, classifyApiError(error));
          } finally {
            activeApiRequests -= 1;
          }
          return;
        }
        if (
          path === USAGE_FAMILIES_API_PATH ||
          path === USAGE_MODELS_API_PATH
        ) {
          if (request.method !== "GET") {
            response.setHeader("Allow", "GET");
            sendRequestRejected(response, 405);
            return;
          }
          const query = parseUsageQuery(path, target.searchParams);
          if (query === null) {
            sendRequestRejected(response, 400);
            return;
          }
          if (activeApiRequests >= MAX_CONCURRENT_API_REQUESTS) {
            sendApiError(response, "sidecar-unavailable");
            return;
          }
          activeApiRequests += 1;
          try {
            const toUtcDate = utcDateFromInstant(normalized.clock());
            const range = Object.freeze({
              fromUtcDate: addUtcDays(toUtcDate, -(query.window - 1)),
              toUtcDate
            });
            if (path === USAGE_FAMILIES_API_PATH) {
              const upstream = await withTimeout(
                normalized.adapter.getDailyFamilySeries(range),
                normalized.apiTimeoutMs
              );
              sendJson(
                response,
                200,
                projectUsageFamiliesResponse(
                  upstream,
                  query.window,
                  toUtcDate
                )
              );
            } else {
              const limit = query.limit!;
              const upstream = await withTimeout(
                normalized.adapter.getModelUsage({ ...range, limit }),
                normalized.apiTimeoutMs
              );
              sendJson(
                response,
                200,
                projectUsageModelsResponse(upstream, query.window, limit)
              );
            }
          } catch (error) {
            sendApiError(response, classifyApiError(error));
          } finally {
            activeApiRequests -= 1;
          }
          return;
        }
        if (path === COLLECTOR_STATUS_PATH) {
          if (request.method !== "GET") {
            response.setHeader("Allow", "GET");
            sendRequestRejected(response, 405);
            return;
          }
          try {
            sendJson(response, 200, readCollectorStatus());
          } catch {
            sendApiError(response, "sidecar-unavailable");
          }
          return;
        }
        if (path === COLLECTOR_REFRESH_PATH) {
          if (request.method !== "POST") {
            response.setHeader("Allow", "POST");
            sendRequestRejected(response, 405);
            return;
          }
          if (!hasAcceptedMutationHeaders(request, activeOrigin)) {
            sendRequestRejected(response, 403);
            return;
          }
          if (activeApiRequests >= MAX_CONCURRENT_API_REQUESTS) {
            sendApiError(response, "sidecar-unavailable");
            return;
          }
          try {
            const now = normalized.clock();
            utcDateFromInstant(now);
            if (
              refreshRequestInFlight === null &&
              lastRefreshRequestAtMs !== null &&
              now.getTime() - lastRefreshRequestAtMs <
                MIN_REFRESH_REQUEST_INTERVAL_MS
            ) {
              sendJson(response, 429, readCollectorStatus(), {
                "Retry-After": String(
                  Math.ceil(
                    (MIN_REFRESH_REQUEST_INTERVAL_MS -
                      Math.max(0, now.getTime() - lastRefreshRequestAtMs)) /
                      1_000
                  )
                )
              });
              return;
            }
            if (refreshRequestInFlight === null) {
              lastRefreshRequestAtMs = now.getTime();
            }
            activeApiRequests += 1;
            try {
              const status = await requestCollectorRefresh();
              if (status.phase === "ready" || status.phase === "ready-no-data") {
                await characterService.syncAfterCompanionFetch(now).catch(
                  () => undefined
                );
              }
              sendJson(response, 200, status);
            } finally {
              activeApiRequests -= 1;
            }
          } catch {
            sendApiError(response, "sidecar-unavailable");
          }
          return;
        }
        if (path !== COMPANION_API_PATH) {
          sendRequestRejected(response, 404);
          return;
        }
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET");
          sendRequestRejected(response, 405);
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
          const projected = projectCompanionResponse(
            upstream,
            providerTotals,
            range,
            instant.toISOString()
          );
          await characterService.syncAfterCompanionFetch(instant).catch(
            () => undefined
          );
          sendJson(
            response,
            200,
            projected
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
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
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
