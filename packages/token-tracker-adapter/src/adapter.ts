import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

import {
  FOOTPRINT_WINDOW_DAYS_V1,
  FootprintWindowV1Schema,
  MonsterCharacterIdV1Schema
} from "@tokenmonster/monster-engine";

import {
  DEFAULT_TOKEN_TRACKER_BASE_URL,
  DEFAULT_TOKEN_TRACKER_TIMEOUT_MS,
  MAX_TOKEN_TRACKER_MODEL_USAGE_LIMIT,
  MAX_TOKEN_TRACKER_RANGE_DAYS,
  MAX_TOKEN_TRACKER_RESPONSE_BYTES,
  MAX_TOKEN_TRACKER_TIMEOUT_MS,
  SUPPORTED_TOKEN_TRACKER_VERSION,
  TOKEN_TRACKER_USAGE_DAILY_PATH,
  TOKEN_TRACKER_USAGE_MODEL_BREAKDOWN_PATH,
  TOKEN_TRACKER_USAGE_SUMMARY_PATH
} from "./constants.js";
import { TokenTrackerAdapterError } from "./errors.js";
import {
  personalActiveUtcDates,
  projectDailyContentBlindFootprint
} from "./profile-footprint.js";
import {
  UpstreamPersonalDailyResponseSchema,
  UpstreamPersonalModelBreakdownResponseSchema,
  UpstreamDailyResponseSchema,
  UpstreamModelBreakdownResponseSchema,
  UpstreamSummaryResponseSchema,
  projectDailyResponse,
  emptyUsageFamilyTotals,
  projectModelUsage,
  projectProgressionFamilyTotals,
  projectProviderTotals,
  projectTokenLedger,
  projectUsageFamilyTotals,
  type UpstreamDailyResponse,
  type UpstreamModelBreakdownResponse,
  type UpstreamPersonalDailyResponse,
  type UpstreamPersonalModelBreakdownResponse,
  type UpstreamSummaryResponse
} from "./schemas.js";
import type {
  TokenMonsterAggregateSummary,
  TokenMonsterDailyAggregateResponse,
  TokenMonsterDailyFamilySeries,
  TokenMonsterModelUsageResponse,
  TokenMonsterProgressionFamilyTotals,
  TokenMonsterProviderTotals,
  TokenTrackerAdapter,
  TokenTrackerAdapterOptions,
  TokenTrackerAggregateRange,
  TokenTrackerFetch,
  TokenTrackerFetchRequestInit,
  TokenTrackerFetchResponse,
  TokenTrackerModelUsageQuery,
  TokenTrackerProfileFootprintQuery,
  TokenTrackerProbe,
  TokenTrackerStreamReader
} from "./types.js";

const ABORTED = Symbol("token-tracker-request-aborted");
const MAX_RESPONSE_CHUNKS = 2_048;
const MAX_CONCURRENT_FAMILY_REQUESTS = 8;
const OPTION_KEYS = new Set<PropertyKey>(["baseUrl", "fetch", "timeoutMs"]);
const PROBE_RANGE = Object.freeze({
  fromUtcDate: "1970-01-01",
  toUtcDate: "1970-01-01"
});

const nativeFetch: TokenTrackerFetch = async (endpoint, init) =>
  fetch(endpoint, {
    method: init.method,
    redirect: init.redirect,
    cache: init.cache,
    headers: init.headers,
    signal: init.signal
  }) as unknown as TokenTrackerFetchResponse;

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
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) {
    throw new TokenTrackerAdapterError("invalid-configuration");
  }
  return descriptor.value;
}

export function normalizeTokenTrackerBaseUrl(baseUrl: unknown): string {
  if (typeof baseUrl !== "string") {
    throw new TokenTrackerAdapterError("invalid-configuration");
  }
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/u.exec(baseUrl);
  if (match === null) {
    throw new TokenTrackerAdapterError("invalid-configuration");
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port > 65_535) {
    throw new TokenTrackerAdapterError("invalid-configuration");
  }
  return `http://127.0.0.1:${port}`;
}

function normalizeOptions(options: TokenTrackerAdapterOptions): Readonly<{
  baseUrl: string;
  fetch: TokenTrackerFetch;
  timeoutMs: number;
}> {
  if (
    !isPlainRecord(options) ||
    Reflect.ownKeys(options).some((key) => !OPTION_KEYS.has(key))
  ) {
    throw new TokenTrackerAdapterError("invalid-configuration");
  }
  const rawBaseUrl = ownDataValue(options, "baseUrl");
  const rawFetch = ownDataValue(options, "fetch");
  const rawTimeoutMs = ownDataValue(options, "timeoutMs");

  if (rawFetch !== undefined && typeof rawFetch !== "function") {
    throw new TokenTrackerAdapterError("invalid-configuration");
  }
  if (
    rawTimeoutMs !== undefined &&
    (typeof rawTimeoutMs !== "number" ||
      !Number.isInteger(rawTimeoutMs) ||
      rawTimeoutMs < 1 ||
      rawTimeoutMs > MAX_TOKEN_TRACKER_TIMEOUT_MS)
  ) {
    throw new TokenTrackerAdapterError("invalid-configuration");
  }

  return Object.freeze({
    baseUrl: normalizeTokenTrackerBaseUrl(
      rawBaseUrl ?? DEFAULT_TOKEN_TRACKER_BASE_URL
    ),
    fetch: (rawFetch as TokenTrackerFetch | undefined) ?? nativeFetch,
    timeoutMs:
      (rawTimeoutMs as number | undefined) ??
      DEFAULT_TOKEN_TRACKER_TIMEOUT_MS
  });
}

function utcDayNumber(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    return null;
  }
  return Math.floor(parsed.getTime() / 86_400_000);
}

function normalizeRange(
  range: TokenTrackerAggregateRange
): Readonly<TokenTrackerAggregateRange> {
  if (!isPlainRecord(range) || Reflect.ownKeys(range).length !== 2) {
    throw new TokenTrackerAdapterError("invalid-range");
  }
  const from = ownDataValue(range, "fromUtcDate");
  const to = ownDataValue(range, "toUtcDate");
  if (typeof from !== "string" || typeof to !== "string") {
    throw new TokenTrackerAdapterError("invalid-range");
  }
  const fromDay = utcDayNumber(from);
  const toDay = utcDayNumber(to);
  if (
    fromDay === null ||
    toDay === null ||
    toDay < fromDay ||
    toDay - fromDay + 1 > MAX_TOKEN_TRACKER_RANGE_DAYS
  ) {
    throw new TokenTrackerAdapterError("invalid-range");
  }
  return Object.freeze({ fromUtcDate: from, toUtcDate: to });
}

function normalizeModelUsageQuery(
  query: TokenTrackerModelUsageQuery
): Readonly<{
  range: Readonly<TokenTrackerAggregateRange>;
  limit: number;
}> {
  if (
    !isPlainRecord(query) ||
    Reflect.ownKeys(query).length !== 3 ||
    !Reflect.ownKeys(query).includes("fromUtcDate") ||
    !Reflect.ownKeys(query).includes("toUtcDate") ||
    !Reflect.ownKeys(query).includes("limit")
  ) {
    throw new TokenTrackerAdapterError("invalid-range");
  }
  const limit = ownDataValue(query, "limit");
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new TokenTrackerAdapterError("invalid-range");
  }
  return Object.freeze({
    range: normalizeRange({
      fromUtcDate: ownDataValue(query, "fromUtcDate") as string,
      toUtcDate: ownDataValue(query, "toUtcDate") as string
    }),
    limit: Math.min(
      MAX_TOKEN_TRACKER_MODEL_USAGE_LIMIT,
      Math.max(1, Math.trunc(limit))
    )
  });
}

function normalizeProfileFootprintQuery(
  query: TokenTrackerProfileFootprintQuery
): Readonly<TokenTrackerProfileFootprintQuery> {
  if (
    !isPlainRecord(query) ||
    Reflect.ownKeys(query).length !== 3 ||
    !Reflect.ownKeys(query).includes("fromUtcDate") ||
    !Reflect.ownKeys(query).includes("toUtcDate") ||
    !Reflect.ownKeys(query).includes("characterId")
  ) {
    throw new TokenTrackerAdapterError("invalid-range");
  }
  const range = normalizeRange({
    fromUtcDate: ownDataValue(query, "fromUtcDate") as string,
    toUtcDate: ownDataValue(query, "toUtcDate") as string
  });
  const characterId = MonsterCharacterIdV1Schema.safeParse(
    ownDataValue(query, "characterId")
  );
  const window = FootprintWindowV1Schema.safeParse({
    from: range.fromUtcDate,
    to: range.toUtcDate,
    timezone: "UTC"
  });
  if (!characterId.success || !window.success) {
    throw new TokenTrackerAdapterError("invalid-range");
  }
  if (eachUtcDate(range).length !== FOOTPRINT_WINDOW_DAYS_V1) {
    throw new TokenTrackerAdapterError("invalid-range");
  }
  return Object.freeze({ ...range, characterId: characterId.data });
}

function eachUtcDate(range: TokenTrackerAggregateRange): readonly string[] {
  const fromDay = utcDayNumber(range.fromUtcDate)!;
  const toDay = utcDayNumber(range.toUtcDate)!;
  const days: string[] = [];
  for (let day = fromDay; day <= toDay; day += 1) {
    days.push(new Date(day * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  project: (value: T) => Promise<R>
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await project(values[index]!);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function buildEndpoint(
  baseUrl: string,
  path: string,
  range: TokenTrackerAggregateRange,
  scope: "all" | "personal" = "all"
): string {
  const query = new URLSearchParams({
    from: range.fromUtcDate,
    to: range.toUtcDate,
    scope,
    tz: "UTC"
  });
  return `${baseUrl}${path}?${query.toString()}`;
}

function cancelReader(reader: TokenTrackerStreamReader): void {
  if (reader.cancel === undefined) return;
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Connection cleanup is best-effort; raw sidecar errors stay private.
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(ABORTED);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function validateResponse(response: TokenTrackerFetchResponse): void {
  if (
    typeof response !== "object" ||
    response === null ||
    response.status !== 200 ||
    response.ok !== true ||
    typeof response.headers?.get !== "function" ||
    response.body === null ||
    typeof response.body?.getReader !== "function"
  ) {
    if (
      typeof response === "object" &&
      response !== null &&
      typeof response.status === "number" &&
      response.status !== 200
    ) {
      throw new TokenTrackerAdapterError("unexpected-status");
    }
    throw new TokenTrackerAdapterError("network-error");
  }
  const contentType = response.headers.get("content-type");
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new TokenTrackerAdapterError("malformed-response");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      throw new TokenTrackerAdapterError("malformed-response");
    }
    const bytes = Number(contentLength);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes > MAX_TOKEN_TRACKER_RESPONSE_BYTES
    ) {
      throw new TokenTrackerAdapterError("response-too-large");
    }
  }
}

async function readBoundedBody(
  response: TokenTrackerFetchResponse,
  signal: AbortSignal,
  deadlineMs: number
): Promise<string> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let chunkCount = 0;

  try {
    while (true) {
      if (performance.now() >= deadlineMs) {
        throw new TokenTrackerAdapterError("request-timeout");
      }
      let result;
      try {
        result = await abortable(reader.read(), signal);
      } catch (error) {
        if (error === ABORTED) {
          throw new TokenTrackerAdapterError("request-timeout");
        }
        throw new TokenTrackerAdapterError("network-error");
      }
      if (result.done) break;
      if (
        !(result.value instanceof Uint8Array) ||
        result.value.byteLength === 0
      ) {
        throw new TokenTrackerAdapterError("malformed-response");
      }
      chunkCount += 1;
      totalBytes += result.value.byteLength;
      if (
        chunkCount > MAX_RESPONSE_CHUNKS ||
        totalBytes > MAX_TOKEN_TRACKER_RESPONSE_BYTES
      ) {
        throw new TokenTrackerAdapterError("response-too-large");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    cancelReader(reader);
    throw error;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        totalBytes
      )
    );
  } catch {
    throw new TokenTrackerAdapterError("malformed-response");
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new TokenTrackerAdapterError("malformed-response");
  }
}

async function requestJson(
  fetchImpl: TokenTrackerFetch,
  timeoutMs: number,
  endpoint: string
): Promise<unknown> {
  const controller = new AbortController();
  const deadlineMs = performance.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  const init: TokenTrackerFetchRequestInit = Object.freeze({
    method: "GET",
    redirect: "error",
    cache: "no-store",
    headers: Object.freeze({ Accept: "application/json" }),
    signal: controller.signal
  });

  try {
    let response: TokenTrackerFetchResponse;
    try {
      response = await abortable(fetchImpl(endpoint, init), controller.signal);
    } catch (error) {
      if (error === ABORTED || controller.signal.aborted) {
        throw new TokenTrackerAdapterError("request-timeout");
      }
      throw new TokenTrackerAdapterError("network-error");
    }
    validateResponse(response);
    return parseJson(await readBoundedBody(response, controller.signal, deadlineMs));
  } finally {
    clearTimeout(timer);
  }
}

function requireMatchingRange(
  response: { readonly from: string; readonly to: string },
  range: TokenTrackerAggregateRange
): void {
  if (response.from !== range.fromUtcDate || response.to !== range.toUtcDate) {
    throw new TokenTrackerAdapterError("incompatible-schema");
  }
}

export function createTokenTrackerAdapter(
  options: TokenTrackerAdapterOptions = {}
): TokenTrackerAdapter {
  const normalized = normalizeOptions(options);

  const fetchSummary = async (
    rangeInput: TokenTrackerAggregateRange
  ): Promise<UpstreamSummaryResponse> => {
    const range = normalizeRange(rangeInput);
    const raw = await requestJson(
      normalized.fetch,
      normalized.timeoutMs,
      buildEndpoint(
        normalized.baseUrl,
        TOKEN_TRACKER_USAGE_SUMMARY_PATH,
        range
      )
    );
    const parsed = UpstreamSummaryResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TokenTrackerAdapterError("incompatible-schema");
    }
    requireMatchingRange(parsed.data, range);
    return parsed.data;
  };

  const fetchDaily = async (
    rangeInput: TokenTrackerAggregateRange
  ): Promise<UpstreamDailyResponse> => {
    const range = normalizeRange(rangeInput);
    const raw = await requestJson(
      normalized.fetch,
      normalized.timeoutMs,
      buildEndpoint(
        normalized.baseUrl,
        TOKEN_TRACKER_USAGE_DAILY_PATH,
        range
      )
    );
    const parsed = UpstreamDailyResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TokenTrackerAdapterError("incompatible-schema");
    }
    requireMatchingRange(parsed.data, range);
    return parsed.data;
  };

  const fetchModelBreakdown = async (
    rangeInput: TokenTrackerAggregateRange
  ): Promise<UpstreamModelBreakdownResponse> => {
    const range = normalizeRange(rangeInput);
    const raw = await requestJson(
      normalized.fetch,
      normalized.timeoutMs,
      buildEndpoint(
        normalized.baseUrl,
        TOKEN_TRACKER_USAGE_MODEL_BREAKDOWN_PATH,
        range
      )
    );
    const parsed = UpstreamModelBreakdownResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TokenTrackerAdapterError("incompatible-schema");
    }
    requireMatchingRange(parsed.data, range);
    return parsed.data;
  };

  const fetchPersonalDaily = async (
    rangeInput: TokenTrackerAggregateRange
  ): Promise<UpstreamPersonalDailyResponse> => {
    const range = normalizeRange(rangeInput);
    const raw = await requestJson(
      normalized.fetch,
      normalized.timeoutMs,
      buildEndpoint(
        normalized.baseUrl,
        TOKEN_TRACKER_USAGE_DAILY_PATH,
        range,
        "personal"
      )
    );
    const parsed = UpstreamPersonalDailyResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TokenTrackerAdapterError("incompatible-schema");
    }
    requireMatchingRange(parsed.data, range);
    return parsed.data;
  };

  const fetchPersonalModelBreakdown = async (
    rangeInput: TokenTrackerAggregateRange
  ): Promise<UpstreamPersonalModelBreakdownResponse> => {
    const range = normalizeRange(rangeInput);
    const raw = await requestJson(
      normalized.fetch,
      normalized.timeoutMs,
      buildEndpoint(
        normalized.baseUrl,
        TOKEN_TRACKER_USAGE_MODEL_BREAKDOWN_PATH,
        range,
        "personal"
      )
    );
    const parsed = UpstreamPersonalModelBreakdownResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TokenTrackerAdapterError("incompatible-schema");
    }
    requireMatchingRange(parsed.data, range);
    return parsed.data;
  };

  return Object.freeze({
    async probe(): Promise<TokenTrackerProbe> {
      await fetchSummary(PROBE_RANGE);
      return Object.freeze({
        reachable: true,
        schemaCompatible: true,
        compatibilityTarget: SUPPORTED_TOKEN_TRACKER_VERSION
      });
    },

    async getSummary(
      range: TokenTrackerAggregateRange
    ): Promise<TokenMonsterAggregateSummary> {
      const response = await fetchSummary(range);
      return Object.freeze({
        fromUtcDate: response.from,
        toUtcDate: response.to,
        activeDays: response.days,
        tokens: projectTokenLedger(response.totals)
      });
    },

    async getDaily(
      range: TokenTrackerAggregateRange
    ): Promise<TokenMonsterDailyAggregateResponse> {
      return projectDailyResponse(await fetchDaily(range));
    },

    async getProviderTotals(
      range: TokenTrackerAggregateRange
    ): Promise<TokenMonsterProviderTotals> {
      return projectProviderTotals(await fetchModelBreakdown(range));
    },

    async getProgressionFamilyTotals(
      range: TokenTrackerAggregateRange
    ): Promise<TokenMonsterProgressionFamilyTotals> {
      return projectProgressionFamilyTotals(await fetchModelBreakdown(range));
    },

    async getDailyFamilySeries(
      rangeInput: TokenTrackerAggregateRange
    ): Promise<TokenMonsterDailyFamilySeries> {
      const range = normalizeRange(rangeInput);
      const daily = projectDailyResponse(await fetchDaily(range));
      const activeDates = daily.days.map((day) => day.utcDate);
      const activeTotals = await mapWithConcurrency(
        activeDates,
        MAX_CONCURRENT_FAMILY_REQUESTS,
        async (utcDate) =>
          projectUsageFamilyTotals(
            await fetchModelBreakdown({
              fromUtcDate: utcDate,
              toUtcDate: utcDate
            })
          )
      );
      const byDate = new Map(
        activeDates.map((utcDate, index) => [utcDate, activeTotals[index]!])
      );
      const days = eachUtcDate(range).map((utcDate) =>
        Object.freeze({
          utcDate,
          families: byDate.get(utcDate) ?? emptyUsageFamilyTotals()
        })
      );
      return Object.freeze({ days: Object.freeze(days) });
    },

    async getDailyContentBlindFootprint(
      query: TokenTrackerProfileFootprintQuery
    ) {
      const normalizedQuery = normalizeProfileFootprintQuery(query);
      const range = {
        fromUtcDate: normalizedQuery.fromUtcDate,
        toUtcDate: normalizedQuery.toUtcDate
      } as const;
      const daily = await fetchPersonalDaily(range);
      const activeDates = personalActiveUtcDates(daily);
      const breakdowns = await mapWithConcurrency(
        activeDates,
        MAX_CONCURRENT_FAMILY_REQUESTS,
        async (utcDate) =>
          fetchPersonalModelBreakdown({
            fromUtcDate: utcDate,
            toUtcDate: utcDate
          })
      );
      return projectDailyContentBlindFootprint(
        normalizedQuery.characterId,
        daily,
        new Map(
          activeDates.map((utcDate, index) => [utcDate, breakdowns[index]!])
        )
      );
    },

    async getModelUsage(
      query: TokenTrackerModelUsageQuery
    ): Promise<TokenMonsterModelUsageResponse> {
      const normalizedQuery = normalizeModelUsageQuery(query);
      return projectModelUsage(
        await fetchModelBreakdown(normalizedQuery.range),
        normalizedQuery.limit
      );
    }
  });
}
