import type {
  RateLimitDecision,
  RateLimitPort,
  RateLimitRequest,
  RateLimitRoute,
  SuppressionLedgerEntry,
  SuppressionLedgerPort
} from "@tokenmonster/api-domain";

const RATE_KEY_PATTERN_BY_ROUTE: Readonly<Record<RateLimitRoute, RegExp>> =
  Object.freeze({
    enrollment: /^rl_e1_[A-Za-z0-9_-]{43}$/u,
    ingest: /^rl_i1_[A-Za-z0-9_-]{43}$/u,
    lifecycle: /^rl_i1_[A-Za-z0-9_-]{43}$/u,
    delete: /^rl_d1_[A-Za-z0-9_-]{43}$/u
  });
const HMAC_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const HMAC_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const EARLIEST_INSTANT_MS = Date.parse("2020-01-01T00:00:00.000Z");
const LATEST_INSTANT_MS = Date.parse("2100-01-01T00:00:00.000Z");
const MAX_SUPPRESSION_RETENTION_MS = 45 * 24 * 60 * 60 * 1_000;
const SUPPRESSION_SHARD_COUNT = 16;
const MAX_SUPPRESSIONS_PER_SHARD = 512;
const MAX_ACTIVE_SUPPRESSIONS =
  SUPPRESSION_SHARD_COUNT * MAX_SUPPRESSIONS_PER_SHARD;
const RATE_BUCKET_STORAGE_KEY = "rate-bucket-v1";
const SUPPRESSION_LEDGER_STORAGE_KEY = "suppression-ledger-v1";

export const CLOUDFLARE_RATE_LIMIT_POLICIES: Readonly<
  Record<RateLimitRoute, Readonly<{ limit: number; windowSeconds: number }>>
> = Object.freeze({
  enrollment: Object.freeze({ limit: 10, windowSeconds: 15 * 60 }),
  ingest: Object.freeze({ limit: 120, windowSeconds: 60 * 60 }),
  lifecycle: Object.freeze({ limit: 10, windowSeconds: 60 }),
  delete: Object.freeze({ limit: 5, windowSeconds: 60 * 60 })
});

type StrictRecord = Readonly<Record<string, unknown>>;

type StoredRateBucket = Readonly<{
  version: 1;
  partitionKey: string;
  route: RateLimitRoute;
  windowStartedAtMs: number;
  consumed: number;
}>;

type StoredSuppressionLedger = Readonly<{
  version: 1;
  entries: readonly SuppressionLedgerEntry[];
}>;

export interface CloudflareDurableTransactionLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface CloudflareDurableStorageLike {
  transaction<T>(
    operation: (transaction: CloudflareDurableTransactionLike) => Promise<T>
  ): Promise<T>;
}

export interface CloudflareDurableObjectStateLike {
  readonly storage: CloudflareDurableStorageLike;
}

export interface CloudflareDurableObjectNamespaceLike {
  getByName(name: string): unknown;
}

function durableFailure(): Error {
  return new Error("durable mutation service unavailable");
}

function strictRecord(input: unknown, keys: readonly string[]): StrictRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw durableFailure();
  }
  let prototype: object | null;
  let ownKeys: string[];
  try {
    prototype = Object.getPrototypeOf(input) as object | null;
    ownKeys = Object.keys(input);
  } catch {
    throw durableFailure();
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== keys.length ||
    keys.some((key) => !ownKeys.includes(key))
  ) {
    throw durableFailure();
  }
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key);
    } catch {
      throw durableFailure();
    }
    if (descriptor === undefined || !("value" in descriptor)) {
      throw durableFailure();
    }
  }
  return input as StrictRecord;
}

function ownData(record: StrictRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw durableFailure();
  }
  return descriptor.value;
}

function canonicalInstant(input: unknown): Readonly<{
  value: string;
  milliseconds: number;
}> {
  if (typeof input !== "string" || input.length !== 24) {
    throw durableFailure();
  }
  const milliseconds = Date.parse(input);
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < EARLIEST_INSTANT_MS ||
    milliseconds >= LATEST_INSTANT_MS ||
    new Date(milliseconds).toISOString() !== input
  ) {
    throw durableFailure();
  }
  return Object.freeze({ value: input, milliseconds });
}

function rateRoute(input: unknown): RateLimitRoute {
  if (
    input !== "enrollment" &&
    input !== "ingest" &&
    input !== "lifecycle" &&
    input !== "delete"
  ) {
    throw durableFailure();
  }
  return input;
}

function rateRequest(input: unknown): Readonly<{
  request: RateLimitRequest;
  atMs: number;
  partitionKey: string;
}> {
  const record = strictRecord(input, ["route", "subjectKey", "at"]);
  const route = rateRoute(ownData(record, "route"));
  const subjectKey = ownData(record, "subjectKey");
  const at = canonicalInstant(ownData(record, "at"));
  if (
    typeof subjectKey !== "string" ||
    !RATE_KEY_PATTERN_BY_ROUTE[route].test(subjectKey)
  ) {
    throw durableFailure();
  }
  return Object.freeze({
    request: Object.freeze({ route, subjectKey, at: at.value }),
    atMs: at.milliseconds,
    partitionKey: `rate-limit:v1:${route}:${subjectKey}`
  });
}

function storedRateBucket(
  input: unknown,
  expectedPartitionKey: string,
  expectedRoute: RateLimitRoute,
  limit: number,
  windowMs: number
): StoredRateBucket | null {
  if (input === undefined) return null;
  const record = strictRecord(input, [
    "version",
    "partitionKey",
    "route",
    "windowStartedAtMs",
    "consumed"
  ]);
  const version = ownData(record, "version");
  const partitionKey = ownData(record, "partitionKey");
  const route = ownData(record, "route");
  const windowStartedAtMs = ownData(record, "windowStartedAtMs");
  const consumed = ownData(record, "consumed");
  if (
    version !== 1 ||
    partitionKey !== expectedPartitionKey ||
    route !== expectedRoute ||
    typeof windowStartedAtMs !== "number" ||
    !Number.isSafeInteger(windowStartedAtMs) ||
    windowStartedAtMs < EARLIEST_INSTANT_MS ||
    windowStartedAtMs >= LATEST_INSTANT_MS ||
    windowStartedAtMs % windowMs !== 0 ||
    typeof consumed !== "number" ||
    !Number.isSafeInteger(consumed) ||
    consumed < 1 ||
    consumed > limit
  ) {
    throw durableFailure();
  }
  return Object.freeze({
    version: 1,
    partitionKey,
    route: expectedRoute,
    windowStartedAtMs,
    consumed
  });
}

function retryDecision(seconds: number): RateLimitDecision {
  if (!Number.isSafeInteger(seconds) || seconds < 1) throw durableFailure();
  return Object.freeze({ allowed: false, retryAfterSeconds: seconds });
}

function allowedDecision(): RateLimitDecision {
  return Object.freeze({ allowed: true });
}

function suppressionMarker(input: unknown): string {
  if (
    typeof input !== "string" ||
    (!HMAC_BASE64URL_PATTERN.test(input) && !HMAC_HEX_PATTERN.test(input))
  ) {
    throw durableFailure();
  }
  return input;
}

function suppressionEntry(input: unknown): SuppressionLedgerEntry {
  const record = strictRecord(input, [
    "suppressionMarker",
    "recordedAt",
    "expiresAt"
  ]);
  const marker = suppressionMarker(ownData(record, "suppressionMarker"));
  const recordedAt = canonicalInstant(ownData(record, "recordedAt"));
  const expiresAt = canonicalInstant(ownData(record, "expiresAt"));
  if (
    expiresAt.milliseconds <= recordedAt.milliseconds ||
    expiresAt.milliseconds - recordedAt.milliseconds >
      MAX_SUPPRESSION_RETENTION_MS
  ) {
    throw durableFailure();
  }
  return Object.freeze({
    suppressionMarker: marker,
    recordedAt: recordedAt.value,
    expiresAt: expiresAt.value
  });
}

function storedSuppressionLedger(input: unknown): StoredSuppressionLedger {
  if (input === undefined) {
    return Object.freeze({ version: 1, entries: Object.freeze([]) });
  }
  const record = strictRecord(input, ["version", "entries"]);
  const version = ownData(record, "version");
  const entries = ownData(record, "entries");
  if (
    version !== 1 ||
    !Array.isArray(entries) ||
    entries.length > MAX_SUPPRESSIONS_PER_SHARD
  ) {
    throw durableFailure();
  }
  const parsed = entries.map((entry) => suppressionEntry(entry));
  if (new Set(parsed.map(({ suppressionMarker: marker }) => marker)).size !== parsed.length) {
    throw durableFailure();
  }
  return Object.freeze({ version: 1, entries: Object.freeze(parsed) });
}

function durableStorage(input: unknown): CloudflareDurableStorageLike {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw durableFailure();
  }
  try {
    const storage = Reflect.get(input, "storage") as unknown;
    if (
      storage === null ||
      typeof storage !== "object" ||
      typeof Reflect.get(storage, "transaction") !== "function"
    ) {
      throw durableFailure();
    }
    return storage as CloudflareDurableStorageLike;
  } catch {
    throw durableFailure();
  }
}

async function sanitizedStorageOperation<T>(
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch {
    throw durableFailure();
  }
}

/**
 * Configure this class as a SQLite-backed Durable Object. It intentionally uses
 * that backend's transactional KV API so its protocol remains easy to audit.
 */
export class TokenMonsterRateLimitDurableController {
  readonly #storage: CloudflareDurableStorageLike;

  constructor(state: unknown, _environment: unknown) {
    this.#storage = durableStorage(state);
  }

  async consume(input: unknown): Promise<RateLimitDecision> {
    const parsed = rateRequest(input);
    const policy = CLOUDFLARE_RATE_LIMIT_POLICIES[parsed.request.route];
    const windowMs = policy.windowSeconds * 1_000;
    const requestedWindow = Math.floor(parsed.atMs / windowMs) * windowMs;
    return await sanitizedStorageOperation(() =>
      this.#storage.transaction(async (transaction) => {
        const existing = storedRateBucket(
          await transaction.get<unknown>(RATE_BUCKET_STORAGE_KEY),
          parsed.partitionKey,
          parsed.request.route,
          policy.limit,
          windowMs
        );
        if (
          existing !== null &&
          requestedWindow < existing.windowStartedAtMs
        ) {
          throw durableFailure();
        }
        if (
          existing !== null &&
          requestedWindow === existing.windowStartedAtMs &&
          existing.consumed >= policy.limit
        ) {
          return retryDecision(
            Math.ceil(
              (existing.windowStartedAtMs + windowMs - parsed.atMs) / 1_000
            )
          );
        }
        const consumed =
          existing !== null && requestedWindow === existing.windowStartedAtMs
            ? existing.consumed + 1
            : 1;
        await transaction.put<StoredRateBucket>(
          RATE_BUCKET_STORAGE_KEY,
          Object.freeze({
            version: 1,
            partitionKey: parsed.partitionKey,
            route: parsed.request.route,
            windowStartedAtMs: requestedWindow,
            consumed
          })
        );
        return allowedDecision();
      })
    );
  }
}

/** Independent from D1. The integration factory fans this class over shards. */
export class TokenMonsterSuppressionLedgerDurableController {
  readonly #storage: CloudflareDurableStorageLike;

  constructor(state: unknown, _environment: unknown) {
    this.#storage = durableStorage(state);
  }

  async record(input: unknown): Promise<Readonly<{ ok: true }>> {
    const entry = suppressionEntry(input);
    return await sanitizedStorageOperation(() =>
      this.#storage.transaction(async (transaction) => {
        const stored = storedSuppressionLedger(
          await transaction.get<unknown>(SUPPRESSION_LEDGER_STORAGE_KEY)
        );
        const active = stored.entries.filter(
          ({ expiresAt }) => Date.parse(expiresAt) > Date.parse(entry.recordedAt)
        );
        const duplicate = active.some(
          ({ suppressionMarker: marker }) => marker === entry.suppressionMarker
        );
        if (!duplicate && active.length >= MAX_SUPPRESSIONS_PER_SHARD) {
          throw durableFailure();
        }
        const next = duplicate ? active : [...active, entry];
        await transaction.put<StoredSuppressionLedger>(
          SUPPRESSION_LEDGER_STORAGE_KEY,
          Object.freeze({
            version: 1,
            entries: Object.freeze(next)
          })
        );
        return Object.freeze({ ok: true as const });
      })
    );
  }

  async listActive(input: unknown): Promise<readonly SuppressionLedgerEntry[]> {
    const at = canonicalInstant(input);
    return await sanitizedStorageOperation(() =>
      this.#storage.transaction(async (transaction) => {
        const stored = storedSuppressionLedger(
          await transaction.get<unknown>(SUPPRESSION_LEDGER_STORAGE_KEY)
        );
        const active = stored.entries.filter(
          ({ expiresAt }) => Date.parse(expiresAt) > at.milliseconds
        );
        if (active.length !== stored.entries.length) {
          await transaction.put<StoredSuppressionLedger>(
            SUPPRESSION_LEDGER_STORAGE_KEY,
            Object.freeze({
              version: 1,
              entries: Object.freeze(active)
            })
          );
        }
        return Object.freeze(active.map((entry) => Object.freeze({ ...entry })));
      })
    );
  }
}

function safeMethod(input: unknown, name: string): (...args: unknown[]) => unknown {
  try {
    if (input === null || typeof input !== "object") throw durableFailure();
    const method = Reflect.get(input, name) as unknown;
    if (typeof method !== "function") throw durableFailure();
    return (...args: unknown[]) => Reflect.apply(method, input, args) as unknown;
  } catch {
    throw durableFailure();
  }
}

function namespaceStub(namespace: unknown, name: string): unknown {
  try {
    return safeMethod(namespace, "getByName")(name);
  } catch {
    throw durableFailure();
  }
}

async function invokeRpc(
  namespace: unknown,
  objectName: string,
  methodName: string,
  input: unknown
): Promise<unknown> {
  try {
    const stub = namespaceStub(namespace, objectName);
    return await Promise.resolve(safeMethod(stub, methodName)(input));
  } catch {
    throw durableFailure();
  }
}

function rateDecision(
  input: unknown,
  maximumRetryAfterSeconds: number
): RateLimitDecision {
  if (input === null || typeof input !== "object") throw durableFailure();
  let keys: readonly string[];
  try {
    keys = Object.keys(input);
  } catch {
    throw durableFailure();
  }
  const record = strictRecord(
    input,
    keys.includes("retryAfterSeconds")
      ? ["allowed", "retryAfterSeconds"]
      : ["allowed"]
  );
  const allowed = ownData(record, "allowed");
  if (allowed === true && keys.length === 1) return allowedDecision();
  const retryAfterSeconds = ownData(record, "retryAfterSeconds");
  if (
    allowed !== false ||
    typeof retryAfterSeconds !== "number" ||
    !Number.isSafeInteger(retryAfterSeconds) ||
    retryAfterSeconds < 1 ||
    retryAfterSeconds > maximumRetryAfterSeconds
  ) {
    throw durableFailure();
  }
  return retryDecision(retryAfterSeconds);
}

function recordAcknowledgement(input: unknown): void {
  const record = strictRecord(input, ["ok"]);
  if (ownData(record, "ok") !== true) throw durableFailure();
}

function suppressionShard(marker: string): number {
  let shard = 0;
  for (const character of marker) {
    shard = (shard * 33 + character.charCodeAt(0)) % SUPPRESSION_SHARD_COUNT;
  }
  return shard;
}

function suppressionShardName(shard: number): string {
  return `suppression-ledger:v1:${shard.toString(16).padStart(2, "0")}`;
}

function parseSuppressionList(input: unknown): readonly SuppressionLedgerEntry[] {
  if (!Array.isArray(input) || input.length > MAX_SUPPRESSIONS_PER_SHARD) {
    throw durableFailure();
  }
  return Object.freeze(input.map((entry) => suppressionEntry(entry)));
}

class CloudflareDurableRateLimitPort implements RateLimitPort {
  readonly #namespace: unknown;

  constructor(namespace: unknown) {
    this.#namespace = namespace;
  }

  async consume(request: RateLimitRequest): Promise<RateLimitDecision> {
    const parsed = rateRequest(request);
    const response = await invokeRpc(
      this.#namespace,
      parsed.partitionKey,
      "consume",
      parsed.request
    );
    return rateDecision(
      response,
      CLOUDFLARE_RATE_LIMIT_POLICIES[parsed.request.route].windowSeconds
    );
  }
}

class CloudflareDurableSuppressionLedgerPort implements SuppressionLedgerPort {
  readonly #namespace: unknown;

  constructor(namespace: unknown) {
    this.#namespace = namespace;
  }

  async record(entry: SuppressionLedgerEntry): Promise<void> {
    const parsed = suppressionEntry(entry);
    const response = await invokeRpc(
      this.#namespace,
      suppressionShardName(suppressionShard(parsed.suppressionMarker)),
      "record",
      parsed
    );
    recordAcknowledgement(response);
  }

  async listActive(at: string): Promise<readonly SuppressionLedgerEntry[]> {
    const parsedAt = canonicalInstant(at);
    const responses = await Promise.all(
      Array.from({ length: SUPPRESSION_SHARD_COUNT }, (_unused, shard) =>
        invokeRpc(
          this.#namespace,
          suppressionShardName(shard),
          "listActive",
          parsedAt.value
        )
      )
    );
    const entries = responses.flatMap((response, shard) => {
      const parsed = parseSuppressionList(response);
      if (
        parsed.some(
          ({ suppressionMarker: marker, expiresAt }) =>
            suppressionShard(marker) !== shard ||
            Date.parse(expiresAt) <= parsedAt.milliseconds
        )
      ) {
        throw durableFailure();
      }
      return [...parsed];
    });
    if (
      entries.length > MAX_ACTIVE_SUPPRESSIONS ||
      new Set(entries.map(({ suppressionMarker: marker }) => marker)).size !==
        entries.length
    ) {
      throw durableFailure();
    }
    entries.sort((left, right) =>
      left.suppressionMarker < right.suppressionMarker
        ? -1
        : left.suppressionMarker > right.suppressionMarker
          ? 1
          : 0
    );
    return Object.freeze(entries);
  }
}

/**
 * Creates the two independent durable runtime ports. Invalid/missing bindings
 * remain fail-closed on mutation use without taking public read routes down.
 */
export function createCloudflareDurableMutationPorts(
  rateLimitNamespace: CloudflareDurableObjectNamespaceLike | unknown,
  suppressionLedgerNamespace: CloudflareDurableObjectNamespaceLike | unknown
): Readonly<{
  rateLimit: RateLimitPort;
  suppressionLedger: SuppressionLedgerPort;
}> {
  return Object.freeze({
    rateLimit: Object.freeze(
      new CloudflareDurableRateLimitPort(rateLimitNamespace)
    ),
    suppressionLedger: Object.freeze(
      new CloudflareDurableSuppressionLedgerPort(suppressionLedgerNamespace)
    )
  });
}
