import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { type CharacterId } from "./catalog.js";
import {
  DailyProviderBucketSchema,
  EMPTY_PERSISTED_SELECTION,
  PROGRESSION_SCHEMA_VERSION,
  PROGRESSION_PROVIDER_IDS,
  PersistedSelectionSchema,
  PersistedUnlockedAtSchema,
  ProgressionStateSchema,
  ProviderTotalsSchema,
  UtcTimestampSchema,
  deriveLifetimeCounters,
  emptyProviderTotals,
  type DailyProviderBucket,
  type PersistedSelection,
  type PersistedUnlockedAt,
  type ProgressionProviderId,
  type ProgressionState,
  type ProviderTotals,
} from "./progression.js";
import {
  STARTER_CHARACTER_BY_PROVIDER_FAMILY,
  type StarterProviderTotals28Days,
} from "./starter-selection.js";

export const LOCAL_PROGRESSION_STORE_SCHEMA_VERSION = "1" as const;
export const LOCAL_PROGRESSION_DIRECTORY_NAME = ".tokenmonster" as const;
export const LOCAL_PROGRESSION_FILE_NAME = "progression-v1.json" as const;
export const LOCAL_PROGRESSION_STORE_ERROR_CODES = ["store-busy"] as const;

export type LocalProgressionStoreErrorCode =
  (typeof LOCAL_PROGRESSION_STORE_ERROR_CODES)[number];

export class LocalProgressionStoreError extends Error {
  public readonly code: LocalProgressionStoreErrorCode;

  public constructor(code: LocalProgressionStoreErrorCode) {
    super("本機 progression store 正忙碌，請稍後再試。");
    this.name = "LocalProgressionStoreError";
    this.code = code;
  }
}

const STORE_LOCK_RETRY_COUNT = 10;
const STORE_LOCK_QUEUE_STALL_RETRY_COUNT = 20;
const STORE_LOCK_QUEUE_TOTAL_RETRY_COUNT = 100;
const STORE_LOCK_RETRY_DELAY_MS = 50;
const STORE_LOCK_STALE_AFTER_MS = 10_000;
const DAILY_BUCKET_RETENTION_MS = 366 * 86_400_000;

const StoredLifetimeSchema = z
  .object({
    baseline: ProviderTotalsSchema.optional(),
    baselineActiveDays: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    dailyProviderBuckets: z.array(DailyProviderBucketSchema),
    providerTotals: ProviderTotalsSchema,
    lifetimeTotal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    activeDays: z.number().int().nonnegative(),
  })
  .strict();

export const LocalProgressionStoreSchema = z
  .object({
    schemaVersion: z.literal(LOCAL_PROGRESSION_STORE_SCHEMA_VERSION),
    lifetime: StoredLifetimeSchema,
    unlockedAt: PersistedUnlockedAtSchema,
    selection: PersistedSelectionSchema,
  })
  .strict()
  .superRefine((store, context) => {
    const dates = store.lifetime.dailyProviderBuckets.map(({ utcDate }) => utcDate);
    if (
      new Set(dates).size !== dates.length ||
      dates.some((date, index) => index > 0 && dates[index - 1]! >= date)
    ) {
      context.addIssue({
        code: "custom",
        path: ["lifetime", "dailyProviderBuckets"],
        message: "Stored daily buckets must have unique dates in ascending order.",
      });
      return;
    }

    const counters = deriveLifetimeCounters(store.lifetime.dailyProviderBuckets, {
      baseline: store.lifetime.baseline,
      baselineActiveDays: store.lifetime.baselineActiveDays,
    });
    if (
      PROGRESSION_PROVIDER_IDS.some(
        (providerId) =>
          counters.providerTotals[providerId] !==
          store.lifetime.providerTotals[providerId],
      ) ||
      counters.lifetimeTotal !== store.lifetime.lifetimeTotal ||
      counters.activeDays !== store.lifetime.activeDays
    ) {
      context.addIssue({
        code: "custom",
        path: ["lifetime"],
        message: "Stored lifetime counters must match the daily bucket ledger.",
      });
    }
  });

export type LocalProgressionStore = Readonly<{
  schemaVersion: typeof LOCAL_PROGRESSION_STORE_SCHEMA_VERSION;
  lifetime: Readonly<{
    baseline?: ProviderTotals | undefined;
    baselineActiveDays?: number | undefined;
    dailyProviderBuckets: readonly DailyProviderBucket[];
    providerTotals: ProviderTotals;
    lifetimeTotal: number;
    activeDays: number;
  }>;
  unlockedAt: PersistedUnlockedAt;
  selection: PersistedSelection;
}>;

export const LocalProgressionStoreLoadResultSchema = z
  .object({
    store: LocalProgressionStoreSchema,
    corruptionRecovered: z.boolean(),
  })
  .strict();

export type LocalProgressionStoreLoadResult = Readonly<{
  store: LocalProgressionStore;
  corruptionRecovered: boolean;
}>;

export interface LocalProgressionStoreOptions {
  readonly path?: string;
  readonly homeDirectory?: string;
}

export const LEGACY_PROGRESSION_STORE_LOCK_REPAIR_OUTCOMES = [
  "repaired",
  "not-needed",
  "busy",
] as const;

export type LegacyProgressionStoreLockRepairOutcome =
  (typeof LEGACY_PROGRESSION_STORE_LOCK_REPAIR_OUTCOMES)[number];

export interface LegacyProgressionStoreLockRepairOptions
  extends LocalProgressionStoreOptions {
  /**
   * This explicit acknowledgement is required because rc.7 does not
   * participate in the v2 queue. A valid rc.7 lock is never removed unless
   * the player has first closed every older TokenMonster process.
   */
  readonly confirmedOldVersionsClosed: true;
}

function freezeStore(store: z.infer<typeof LocalProgressionStoreSchema>): LocalProgressionStore {
  Object.freeze(store.lifetime.dailyProviderBuckets);
  for (const bucket of store.lifetime.dailyProviderBuckets) {
    Object.freeze(bucket.providerTotals);
    Object.freeze(bucket);
  }
  Object.freeze(store.lifetime.providerTotals);
  if (store.lifetime.baseline !== undefined) {
    Object.freeze(store.lifetime.baseline);
  }
  Object.freeze(store.lifetime);
  Object.freeze(store.unlockedAt);
  Object.freeze(store.selection);
  return Object.freeze(store);
}

export function createEmptyLocalProgressionStore(): LocalProgressionStore {
  return freezeStore(
    LocalProgressionStoreSchema.parse({
      schemaVersion: LOCAL_PROGRESSION_STORE_SCHEMA_VERSION,
      lifetime: {
        dailyProviderBuckets: [],
        providerTotals: emptyProviderTotals(),
        lifetimeTotal: 0,
        activeDays: 0,
      },
      unlockedAt: {},
      selection: EMPTY_PERSISTED_SELECTION,
    }),
  );
}

export function resolveLocalProgressionStorePath(
  options: LocalProgressionStoreOptions = {},
): string {
  if (options.path !== undefined) return options.path;
  return join(
    options.homeDirectory ?? homedir(),
    LOCAL_PROGRESSION_DIRECTORY_NAME,
    LOCAL_PROGRESSION_FILE_NAME,
  );
}

function mergeProviderMaximums(
  target: Partial<Record<ProgressionProviderId, number>>,
  source: Readonly<Partial<Record<ProgressionProviderId, number>>>,
): void {
  for (const providerId of PROGRESSION_PROVIDER_IDS) {
    const incoming = source[providerId];
    if (incoming !== undefined) {
      target[providerId] = Math.max(target[providerId] ?? 0, incoming);
    }
  }
}

function utcTimestamp(utcDate: string): number {
  return Date.parse(`${utcDate}T00:00:00.000Z`);
}

function oldestRetainedTimestamp(newestUtcDate: string): number {
  return utcTimestamp(newestUtcDate) - DAILY_BUCKET_RETENTION_MS;
}

function compactDailyProviderBuckets(
  storeInput: LocalProgressionStore,
): LocalProgressionStore {
  const store = LocalProgressionStoreSchema.parse(storeInput);
  const newestBucket = store.lifetime.dailyProviderBuckets.at(-1);
  if (newestBucket === undefined) return freezeStore(store);

  const cutoffTimestamp = oldestRetainedTimestamp(newestBucket.utcDate);
  const retainedBuckets: DailyProviderBucket[] = [];
  const prunedBuckets: DailyProviderBucket[] = [];
  for (const bucket of store.lifetime.dailyProviderBuckets) {
    (utcTimestamp(bucket.utcDate) < cutoffTimestamp
      ? prunedBuckets
      : retainedBuckets
    ).push(bucket);
  }
  if (prunedBuckets.length === 0) return freezeStore(store);

  const baseline = { ...(store.lifetime.baseline ?? emptyProviderTotals()) };
  let baselineActiveDays = store.lifetime.baselineActiveDays ?? 0;
  for (const bucket of prunedBuckets) {
    if (Object.values(bucket.providerTotals).some((total) => total > 0)) {
      baselineActiveDays = Math.min(
        Number.MAX_SAFE_INTEGER,
        baselineActiveDays + 1,
      );
    }
    for (const providerId of PROGRESSION_PROVIDER_IDS) {
      baseline[providerId] = Math.min(
        Number.MAX_SAFE_INTEGER,
        baseline[providerId] + (bucket.providerTotals[providerId] ?? 0),
      );
    }
  }
  const parsedBaseline = ProviderTotalsSchema.parse(baseline);
  const counters = deriveLifetimeCounters(retainedBuckets, {
    baseline: parsedBaseline,
    baselineActiveDays,
  });
  return freezeStore(
    LocalProgressionStoreSchema.parse({
      ...store,
      lifetime: {
        baseline: parsedBaseline,
        baselineActiveDays,
        dailyProviderBuckets: retainedBuckets,
        providerTotals: counters.providerTotals,
        lifetimeTotal: counters.lifetimeTotal,
        activeDays: counters.activeDays,
      },
    }),
  );
}

/**
 * Merge repeated UTC provider reports by maximum. Rescans and replay therefore
 * cannot increase lifetime counters unless a day/provider report itself grows.
 */
export function mergeDailyProviderBuckets(
  storeInput: LocalProgressionStore,
  incomingInput: readonly DailyProviderBucket[],
): LocalProgressionStore;
export function mergeDailyProviderBuckets(
  storeInput: unknown,
  incomingInput: unknown,
): LocalProgressionStore;
export function mergeDailyProviderBuckets(
  storeInput: unknown,
  incomingInput: unknown,
): LocalProgressionStore {
  const store = LocalProgressionStoreSchema.parse(storeInput);
  const incoming = z.array(DailyProviderBucketSchema).parse(incomingInput);
  const bucketsByDate = new Map<
    string,
    Partial<Record<ProgressionProviderId, number>>
  >();

  for (const bucket of store.lifetime.dailyProviderBuckets) {
    const providerTotals: Partial<Record<ProgressionProviderId, number>> = {};
    mergeProviderMaximums(providerTotals, bucket.providerTotals);
    bucketsByDate.set(bucket.utcDate, providerTotals);
  }
  const newestUtcDate = [...store.lifetime.dailyProviderBuckets, ...incoming]
    .map(({ utcDate }) => utcDate)
    .sort((left, right) => right.localeCompare(left))[0];
  const cutoffTimestamp =
    newestUtcDate === undefined ? null : oldestRetainedTimestamp(newestUtcDate);
  for (const bucket of incoming) {
    if (
      store.lifetime.baseline !== undefined &&
      cutoffTimestamp !== null &&
      utcTimestamp(bucket.utcDate) < cutoffTimestamp &&
      !bucketsByDate.has(bucket.utcDate)
    ) {
      continue;
    }
    const providerTotals = bucketsByDate.get(bucket.utcDate) ?? {};
    mergeProviderMaximums(providerTotals, bucket.providerTotals);
    bucketsByDate.set(bucket.utcDate, providerTotals);
  }

  const dailyProviderBuckets = [...bucketsByDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([utcDate, providerTotals]) => ({ utcDate, providerTotals }));
  const counters = deriveLifetimeCounters(dailyProviderBuckets, {
    baseline: store.lifetime.baseline,
    baselineActiveDays: store.lifetime.baselineActiveDays,
  });

  return freezeStore(
    LocalProgressionStoreSchema.parse({
      ...store,
      lifetime: {
        ...(store.lifetime.baseline === undefined
          ? {}
          : { baseline: store.lifetime.baseline }),
        ...(store.lifetime.baselineActiveDays === undefined
          ? {}
          : { baselineActiveDays: store.lifetime.baselineActiveDays }),
        dailyProviderBuckets,
        providerTotals: counters.providerTotals,
        lifetimeTotal: counters.lifetimeTotal,
        activeDays: counters.activeDays,
      },
    }),
  );
}

export function withManualSisterSelection(
  storeInput: LocalProgressionStore,
  characterId: CharacterId | null,
  selectedAt: string,
): LocalProgressionStore;
export function withManualSisterSelection(
  storeInput: unknown,
  characterId: unknown,
  selectedAt: unknown,
): LocalProgressionStore;
export function withManualSisterSelection(
  storeInput: unknown,
  characterId: unknown,
  selectedAt: unknown,
): LocalProgressionStore {
  const store = LocalProgressionStoreSchema.parse(storeInput);
  const parsedCharacterId = z
    .union([z.enum(STARTER_CHARACTER_BY_PROVIDER_FAMILY), z.null()])
    .parse(characterId);
  const parsedSelectedAt = UtcTimestampSchema.parse(selectedAt);
  return freezeStore(
    LocalProgressionStoreSchema.parse({
      ...store,
      selection: {
        ...store.selection,
        manualCharacterId: parsedCharacterId,
        manualSelectedAt: parsedCharacterId === null ? null : parsedSelectedAt,
      },
    }),
  );
}

export function resolvePersistedSisterSelection(
  selectionInput: PersistedSelection,
): Readonly<{
  characterId: CharacterId;
  selectedBy: "manual" | "auto";
  selectedAt: string;
}> | null;
export function resolvePersistedSisterSelection(
  selectionInput: unknown,
): Readonly<{
  characterId: CharacterId;
  selectedBy: "manual" | "auto";
  selectedAt: string;
}> | null;
export function resolvePersistedSisterSelection(selectionInput: unknown) {
  const selection = PersistedSelectionSchema.parse(selectionInput);
  if (selection.manualCharacterId !== null) {
    return Object.freeze({
      characterId: selection.manualCharacterId,
      selectedBy: "manual" as const,
      selectedAt: selection.manualSelectedAt!,
    });
  }
  if (selection.autoStarterCharacterId !== null) {
    return Object.freeze({
      characterId: selection.autoStarterCharacterId,
      selectedBy: "auto" as const,
      selectedAt: selection.autoStarterSelectedAt!,
    });
  }
  return null;
}

/** Copy evaluator unlock timestamps without choosing a companion for the player. */
export function withProgressionEvaluation(
  storeInput: LocalProgressionStore,
  progressionInput: ProgressionState,
): LocalProgressionStore;
export function withProgressionEvaluation(
  storeInput: unknown,
  progressionInput: unknown,
): LocalProgressionStore;
export function withProgressionEvaluation(
  storeInput: unknown,
  progressionInput: unknown,
): LocalProgressionStore {
  const store = LocalProgressionStoreSchema.parse(storeInput);
  const progression = ProgressionStateSchema.parse(progressionInput);
  const unlockedAt: Record<string, string> = { ...store.unlockedAt };

  for (const character of progression.characters) {
    if (character.unlockedAt !== null) {
      unlockedAt[`character:${character.characterId}`] ??= character.unlockedAt;
    }
    for (const theme of character.themes) {
      if (theme.unlockedAt !== null) {
        unlockedAt[`theme:${character.characterId}:${theme.themeId}`] ??=
          theme.unlockedAt;
      }
    }
    for (const pose of character.poseSets) {
      if (pose.unlockedAt !== null) {
        unlockedAt[`pose:${character.characterId}:${pose.poseSetId}`] ??=
          pose.unlockedAt;
      }
    }
    for (const action of character.actions) {
      if (action.unlockedAt !== null) {
        unlockedAt[`action:${character.characterId}:${action.actionId}`] ??=
          action.unlockedAt;
      }
    }
  }

  return freezeStore(
    LocalProgressionStoreSchema.parse({
      ...store,
      unlockedAt,
      selection: store.selection,
    }),
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function sanitizeUnlockedAtEntries(parsedJson: unknown): unknown {
  if (
    typeof parsedJson !== "object" ||
    parsedJson === null ||
    Array.isArray(parsedJson) ||
    !("unlockedAt" in parsedJson)
  ) {
    return parsedJson;
  }
  const unlockedAt = parsedJson.unlockedAt;
  if (
    typeof unlockedAt !== "object" ||
    unlockedAt === null ||
    Array.isArray(unlockedAt)
  ) {
    return parsedJson;
  }
  const sanitizedUnlockedAt = Object.fromEntries(
    Object.entries(unlockedAt).filter(
      ([, value]) =>
        typeof value === "string" && UtcTimestampSchema.safeParse(value).success,
    ),
  );
  return { ...parsedJson, unlockedAt: sanitizedUnlockedAt };
}

type StoreLock = Readonly<{
  release: () => Promise<void>;
}>;

type StoreQueueLock = StoreLock &
  Readonly<{
    ownerId: string;
  }>;

const StoreLockQueueRecordSchema = z.discriminatedUnion("phase", [
  z
    .object({
      phase: z.literal("choosing"),
      pid: z.number().int().positive(),
      createdAt: UtcTimestampSchema,
      ownerId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      phase: z.literal("ticket"),
      pid: z.number().int().positive(),
      createdAt: UtcTimestampSchema,
      ownerId: z.string().uuid(),
      ticket: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
]);

type StoreLockQueueRecord = z.infer<typeof StoreLockQueueRecordSchema>;

type ActiveStoreLockQueueEntry = Readonly<{
  path: string;
  serialized: string;
  record: StoreLockQueueRecord;
}>;

type StoreLockQueueState = Readonly<{
  blocked: boolean;
  choosing: readonly ActiveStoreLockQueueEntry[];
  tickets: readonly ActiveStoreLockQueueEntry[];
}>;

const STORE_LOCK_V2_INTERLOCK_PREFIX = "tokenmonster-store-lock-v2:";
const StoreLockV2InterlockSchema = z
  .object({
    pid: z.number().int().positive(),
    createdAt: UtcTimestampSchema,
    ownerId: z.string().uuid(),
  })
  .strict();
const StoreLockLegacyInterlockSchema = z
  .object({
    pid: z.number().int().positive(),
    createdAt: UtcTimestampSchema,
  })
  .passthrough();

const STORE_LOCK_QUEUE_FILE_PATTERN =
  /^(choosing|ticket)-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;

function unchangedFileIdentity(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.size === before.size &&
    after.mtimeMs === before.mtimeMs &&
    after.ctimeMs === before.ctimeMs
  );
}

function isProcessDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means that a process exists but cannot be signalled. PID reuse is
    // deliberately conservative too: a live replacement keeps the record
    // busy rather than letting an old paused owner resume without a ticket.
    return hasErrorCode(error, "ESRCH");
  }
}

async function removeUnchangedUniqueFile(
  path: string,
  before: Awaited<ReturnType<typeof lstat>>,
  serialized: string,
): Promise<boolean> {
  try {
    const after = await lstat(path);
    if (!unchangedFileIdentity(before, after)) return false;
    if ((await readFile(path, "utf8")) !== serialized) return false;
    await rm(path);
    return true;
  } catch (error) {
    return isMissingFile(error);
  }
}

// Compatibility interlock: rc.7 parses only bare JSON. The v2 prefix makes an
// active v2 owner opaque to rc.7, so the old remover waits instead of stealing
// it. Conversely, v2 never removes a syntactically valid rc.7 owner record;
// only the historical empty/truncated crash window is migrated automatically.
async function tryRemoveLegacyStaleLock(lockPath: string): Promise<boolean> {
  let before: Awaited<ReturnType<typeof lstat>>;
  let serialized: string;
  try {
    before = await lstat(lockPath);
    if (!before.isFile() || before.isSymbolicLink()) return false;
    serialized = await readFile(lockPath, "utf8");
  } catch (error) {
    return isMissingFile(error);
  }
  let stale = false;
  if (serialized.startsWith(STORE_LOCK_V2_INTERLOCK_PREFIX)) {
    try {
      const lock = StoreLockV2InterlockSchema.parse(
        JSON.parse(serialized.slice(STORE_LOCK_V2_INTERLOCK_PREFIX.length)),
      );
      // This record was fully synced before its hard-link publication. A dead
      // PID cannot resume, so no age delay is needed; PID reuse blocks
      // conservatively because process.kill(pid, 0) reports a live owner.
      stale = isProcessDefinitelyDead(lock.pid);
    } catch {
      stale = Date.now() - before.mtimeMs > STORE_LOCK_STALE_AFTER_MS;
    }
  } else {
    try {
      StoreLockLegacyInterlockSchema.parse(JSON.parse(serialized));
      return false;
    } catch {
      // rc.7 created the fixed file before writing its owner record. A live
      // writer can be suspended for longer than the stale interval while it
      // still owns that open inode, so age alone can never prove that an
      // empty/truncated bare record is abandoned. Only the explicit repair
      // path may remove this residue after the player closes old versions.
      return false;
    }
  }
  if (!stale) return false;
  return removeUnchangedUniqueFile(lockPath, before, serialized);
}

function queueFileName(record: StoreLockQueueRecord): string {
  return `${record.phase}-${record.ownerId}.json`;
}

async function publishQueueRecord(
  queueDirectory: string,
  record: StoreLockQueueRecord,
): Promise<Readonly<{ path: string; serialized: string }>> {
  const serialized = `${JSON.stringify(record)}\n`;
  const path = join(queueDirectory, queueFileName(record));
  const sourcePath = join(
    queueDirectory,
    `.store-lock-entry.${process.pid}.${record.ownerId}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(sourcePath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await link(sourcePath, path);
    await rm(sourcePath, { force: true }).catch(() => undefined);
    return Object.freeze({ path, serialized });
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    await rm(sourcePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readActiveQueueEntry(
  queueDirectory: string,
  name: string,
): Promise<
  | Readonly<{ state: "active"; entry: ActiveStoreLockQueueEntry }>
  | Readonly<{ state: "absent" | "blocked" }>
> {
  const match = STORE_LOCK_QUEUE_FILE_PATTERN.exec(name);
  if (match === null) return Object.freeze({ state: "blocked" });
  const path = join(queueDirectory, name);
  let before: Awaited<ReturnType<typeof lstat>>;
  let serialized: string;
  try {
    before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      return Object.freeze({ state: "blocked" });
    }
    serialized = await readFile(path, "utf8");
  } catch (error) {
    return Object.freeze({
      state: isMissingFile(error) ? "absent" : "blocked",
    });
  }

  let record: StoreLockQueueRecord | undefined;
  let stale = false;
  try {
    record = StoreLockQueueRecordSchema.parse(JSON.parse(serialized));
    if (
      record.phase !== match[1] ||
      record.ownerId !== match[2] ||
      queueFileName(record) !== name
    ) {
      return Object.freeze({ state: "blocked" });
    }
    stale = isProcessDefinitelyDead(record.pid);
  } catch {
    stale = Date.now() - before.mtimeMs > STORE_LOCK_STALE_AFTER_MS;
  }

  if (stale) {
    return Object.freeze({
      state: (await removeUnchangedUniqueFile(path, before, serialized))
        ? "absent"
        : "blocked",
    });
  }
  if (record === undefined) return Object.freeze({ state: "blocked" });
  return Object.freeze({
    state: "active",
    entry: Object.freeze({ path, serialized, record }),
  });
}

async function readStoreLockQueue(
  queueDirectory: string,
): Promise<StoreLockQueueState> {
  const choosing: ActiveStoreLockQueueEntry[] = [];
  const tickets: ActiveStoreLockQueueEntry[] = [];
  let blocked = false;
  for (const entry of await readdir(queueDirectory, { withFileTypes: true })) {
    if (entry.name.startsWith(".store-lock-entry.")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      blocked = true;
      continue;
    }
    const result = await readActiveQueueEntry(queueDirectory, entry.name);
    if (result.state === "blocked") {
      blocked = true;
    } else if (result.state === "active") {
      if (result.entry.record.phase === "choosing") {
        choosing.push(result.entry);
      } else {
        tickets.push(result.entry);
      }
    }
  }
  return Object.freeze({
    blocked,
    choosing: Object.freeze(choosing),
    tickets: Object.freeze(tickets),
  });
}

function orderedTickets(
  entries: readonly ActiveStoreLockQueueEntry[],
): readonly ActiveStoreLockQueueEntry[] {
  return [...entries].sort((left, right) => {
    const leftRecord = left.record;
    const rightRecord = right.record;
    if (leftRecord.phase !== "ticket" || rightRecord.phase !== "ticket") {
      return leftRecord.phase.localeCompare(rightRecord.phase);
    }
    return (
      leftRecord.ticket - rightRecord.ticket ||
      leftRecord.ownerId.localeCompare(rightRecord.ownerId)
    );
  });
}

async function acquireLegacyInterlock(
  path: string,
  ownerId: string,
): Promise<StoreLock> {
  const directory = dirname(path);
  const lockPath = `${path}.lock`;
  const owner = `${STORE_LOCK_V2_INTERLOCK_PREFIX}${JSON.stringify(
    StoreLockV2InterlockSchema.parse({
      pid: process.pid,
      createdAt: new Date().toISOString(),
      ownerId,
    }),
  )}\n`;
  const ownerPath = join(
    directory,
    `.${basename(path)}.legacy-lock-owner.${process.pid}.${ownerId}`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(ownerPath, "wx", 0o600);
    await handle.writeFile(owner, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    for (let attempt = 0; attempt <= STORE_LOCK_RETRY_COUNT; attempt += 1) {
      try {
        await link(ownerPath, lockPath);
        await rm(ownerPath, { force: true }).catch(() => undefined);
        return Object.freeze({
          release: async () => {
            try {
              if ((await readFile(lockPath, "utf8")) === owner) {
                await rm(lockPath);
              }
            } catch (error) {
              if (!isMissingFile(error)) throw error;
            }
          },
        });
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
        if (await tryRemoveLegacyStaleLock(lockPath)) continue;
        if (attempt === STORE_LOCK_RETRY_COUNT) {
          throw new LocalProgressionStoreError("store-busy");
        }
        await delay(STORE_LOCK_RETRY_DELAY_MS);
      }
    }
    throw new LocalProgressionStoreError("store-busy");
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
    await rm(ownerPath, { force: true }).catch(() => undefined);
  }
}

async function acquireStoreQueueLock(path: string): Promise<StoreQueueLock> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const queueDirectory = `${path}.lock-queue`;
  await mkdir(queueDirectory, { recursive: true, mode: 0o700 });
  await chmod(queueDirectory, 0o700);
  const ownerId = randomUUID();
  const choosingRecord = StoreLockQueueRecordSchema.parse({
    phase: "choosing",
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ownerId,
  });
  const choosingEntry = await publishQueueRecord(
    queueDirectory,
    choosingRecord,
  );
  let ticketEntry:
    | Readonly<{ path: string; serialized: string }>
    | undefined;
  let acquired = false;
  try {
    const initial = await readStoreLockQueue(queueDirectory);
    const maximumTicket = initial.tickets.reduce((maximum, entry) => {
      const record = entry.record;
      return record.phase === "ticket"
        ? Math.max(maximum, record.ticket)
        : maximum;
    }, 0);
    if (maximumTicket >= Number.MAX_SAFE_INTEGER) {
      throw new LocalProgressionStoreError("store-busy");
    }
    const ticketRecord = StoreLockQueueRecordSchema.parse({
      phase: "ticket",
      pid: process.pid,
      createdAt: choosingRecord.createdAt,
      ownerId,
      ticket: maximumTicket + 1,
    });
    ticketEntry = await publishQueueRecord(queueDirectory, ticketRecord);
    await rm(choosingEntry.path);

    let stalledAttempts = 0;
    let totalAttempts = 0;
    let leadingOwnerId: string | null | undefined;
    for (;;) {
      const state = await readStoreLockQueue(queueDirectory);
      const ordered = orderedTickets(state.tickets);
      const ownTicket = ordered.find(
        (entry) => entry.record.ownerId === ownerId,
      );
      if (
        !state.blocked &&
        state.choosing.length === 0 &&
        ownTicket !== undefined &&
        ordered[0] === ownTicket
      ) {
        acquired = true;
        return Object.freeze({
          ownerId,
          release: async () => {
            if (ticketEntry !== undefined) {
              try {
                await rm(ticketEntry.path);
              } catch (error) {
                if (!isMissingFile(error)) throw error;
              }
            }
          },
        });
      }

      // A live predecessor still gets a short, bounded stall budget. Reset
      // that budget only when the queue head advances so a healthy chain of
      // writers does not make every later ticket share the same one-second
      // window. The total budget keeps even a continually changing queue
      // fail-closed and bounded.
      const currentLeadingOwnerId = ordered[0]?.record.ownerId ?? null;
      if (currentLeadingOwnerId === leadingOwnerId) {
        stalledAttempts += 1;
      } else {
        leadingOwnerId = currentLeadingOwnerId;
        stalledAttempts = 0;
      }
      if (
        stalledAttempts >= STORE_LOCK_QUEUE_STALL_RETRY_COUNT ||
        totalAttempts >= STORE_LOCK_QUEUE_TOTAL_RETRY_COUNT
      ) {
        throw new LocalProgressionStoreError("store-busy");
      }
      await delay(STORE_LOCK_RETRY_DELAY_MS);
      totalAttempts += 1;
    }
  } finally {
    await rm(choosingEntry.path, { force: true }).catch(() => undefined);
    if (!acquired && ticketEntry !== undefined) {
      await rm(ticketEntry.path, { force: true }).catch(() => undefined);
    }
  }
}

async function acquireStoreLock(path: string): Promise<StoreLock> {
  const queueLock = await acquireStoreQueueLock(path);
  let legacyLock: StoreLock;
  try {
    legacyLock = await acquireLegacyInterlock(path, queueLock.ownerId);
  } catch (error) {
    try {
      await queueLock.release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "Unable to acquire or release the local progression store lock.",
      );
    }
    throw error;
  }

  return Object.freeze({
    release: async () => {
      let failure: unknown;
      try {
        await legacyLock.release();
      } catch (error) {
        failure = error;
      }
      try {
        await queueLock.release();
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
    },
  });
}

async function repairProgressionStoreInterlock(
  path: string,
): Promise<LegacyProgressionStoreLockRepairOutcome> {
  const lockPath = `${path}.lock`;
  let before: Awaited<ReturnType<typeof lstat>>;
  let serialized: string;
  try {
    before = await lstat(lockPath);
    if (!before.isFile() || before.isSymbolicLink()) return "busy";
    serialized = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return "not-needed";
    throw error;
  }

  // Dead v2 records are already recovered by normal acquisition. Keep this
  // explicit maintenance API scoped to rc.7's bare complete or crash-window
  // records, which cannot be recovered from age alone while a writer may live.
  if (serialized.startsWith(STORE_LOCK_V2_INTERLOCK_PREFIX)) return "busy";

  let lock: z.infer<typeof StoreLockLegacyInterlockSchema> | undefined;
  try {
    lock = StoreLockLegacyInterlockSchema.parse(JSON.parse(serialized));
  } catch {
    lock = undefined;
  }
  const now = Date.now();
  // A complete record additionally needs an aged owner timestamp and a
  // definitely-dead PID. Empty/truncated records have neither signal, so they
  // rely on aged mtime plus the caller's explicit shutdown acknowledgement.
  const safeToRemove =
    now - before.mtimeMs > STORE_LOCK_STALE_AFTER_MS &&
    (lock === undefined ||
      (isProcessDefinitelyDead(lock.pid) &&
        now - Date.parse(lock.createdAt) > STORE_LOCK_STALE_AFTER_MS));

  if (!safeToRemove) return "busy";
  return (await removeUnchangedUniqueFile(lockPath, before, serialized))
    ? "repaired"
    : "busy";
}

/**
 * Repairs a crash-left progression interlock after the player has explicitly
 * confirmed that every older TokenMonster process is closed. This is a local
 * maintenance operation; it never reads or changes the progression payload.
 */
export async function repairLegacyProgressionStoreLock(
  options: LegacyProgressionStoreLockRepairOptions,
): Promise<LegacyProgressionStoreLockRepairOutcome> {
  if (options.confirmedOldVersionsClosed !== true) return "busy";
  const path = resolveLocalProgressionStorePath(options);
  let queueLock: StoreQueueLock;
  try {
    queueLock = await acquireStoreQueueLock(path);
  } catch (error) {
    if (
      error instanceof LocalProgressionStoreError &&
      error.code === "store-busy"
    ) {
      return "busy";
    }
    throw error;
  }
  try {
    const outcome = await repairProgressionStoreInterlock(path);
    if (outcome !== "repaired") return outcome;

    // Publish a v2-prefixed fixed interlock before releasing our queue ticket.
    // This turns an rc.7 process that violated the shutdown acknowledgement
    // and won the unlink/link gap into a visible busy result instead of a
    // false-successful repair.
    let verificationLock: StoreLock;
    try {
      verificationLock = await acquireLegacyInterlock(path, queueLock.ownerId);
    } catch (error) {
      if (
        error instanceof LocalProgressionStoreError &&
        error.code === "store-busy"
      ) {
        return "busy";
      }
      throw error;
    }
    await verificationLock.release();
    return "repaired";
  } finally {
    await queueLock.release();
  }
}

async function withStoreLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lock = await acquireStoreLock(path);
  try {
    return await work();
  } finally {
    await lock.release();
  }
}

async function writeAtomically(
  path: string,
  store: LocalProgressionStore,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    try {
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // Some platforms do not permit opening or syncing directories.
    }
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function saveLocalProgressionStore(
  storeInput: LocalProgressionStore,
  options?: LocalProgressionStoreOptions,
): Promise<void>;
export async function saveLocalProgressionStore(
  storeInput: unknown,
  options?: LocalProgressionStoreOptions,
): Promise<void>;
export async function saveLocalProgressionStore(
  storeInput: unknown,
  options: LocalProgressionStoreOptions = {},
): Promise<void> {
  const path = resolveLocalProgressionStorePath(options);
  const store = compactDailyProviderBuckets(
    freezeStore(LocalProgressionStoreSchema.parse(storeInput)),
  );
  await withStoreLock(path, () => writeAtomically(path, store));
}

async function loadLocalProgressionStoreUnlocked(
  path: string,
): Promise<LocalProgressionStoreLoadResult> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return Object.freeze({
      store: createEmptyLocalProgressionStore(),
      corruptionRecovered: false,
    });
  }

  try {
    const parsedJson = sanitizeUnlockedAtEntries(JSON.parse(serialized));
    const store = freezeStore(LocalProgressionStoreSchema.parse(parsedJson));
    return Object.freeze({ store, corruptionRecovered: false });
  } catch {
    const store = createEmptyLocalProgressionStore();
    await writeAtomically(path, store);
    return Object.freeze({ store, corruptionRecovered: true });
  }
}

export async function loadLocalProgressionStore(
  options: LocalProgressionStoreOptions = {},
): Promise<LocalProgressionStoreLoadResult> {
  const path = resolveLocalProgressionStorePath(options);
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return Object.freeze({
      store: createEmptyLocalProgressionStore(),
      corruptionRecovered: false,
    });
  }

  try {
    const parsedJson = sanitizeUnlockedAtEntries(JSON.parse(serialized));
    const store = freezeStore(LocalProgressionStoreSchema.parse(parsedJson));
    return Object.freeze({ store, corruptionRecovered: false });
  } catch {
    return withStoreLock(path, () => loadLocalProgressionStoreUnlocked(path));
  }
}

export async function mergeAndSaveDailyProviderBuckets(
  incoming: readonly DailyProviderBucket[],
  options?: LocalProgressionStoreOptions,
): Promise<LocalProgressionStoreLoadResult>;
export async function mergeAndSaveDailyProviderBuckets(
  incoming: unknown,
  options?: LocalProgressionStoreOptions,
): Promise<LocalProgressionStoreLoadResult>;
export async function mergeAndSaveDailyProviderBuckets(
  incoming: unknown,
  options: LocalProgressionStoreOptions = {},
): Promise<LocalProgressionStoreLoadResult> {
  const path = resolveLocalProgressionStorePath(options);
  return withStoreLock(path, async () => {
    const loaded = await loadLocalProgressionStoreUnlocked(path);
    const store = compactDailyProviderBuckets(
      mergeDailyProviderBuckets(loaded.store, incoming),
    );
    await writeAtomically(path, store);
    return Object.freeze({
      store,
      corruptionRecovered: loaded.corruptionRecovered,
    });
  });
}

export function sisterProviderTotalsFromLifetime(
  providerTotalsInput: ProviderTotals,
): StarterProviderTotals28Days;
export function sisterProviderTotalsFromLifetime(
  providerTotalsInput: unknown,
): StarterProviderTotals28Days;
export function sisterProviderTotalsFromLifetime(
  providerTotalsInput: unknown,
): StarterProviderTotals28Days {
  const totals = ProviderTotalsSchema.parse(providerTotalsInput);
  return Object.freeze({
    openai: totals.openai,
    anthropic: totals.anthropic,
    google: totals.google,
    xai: totals.xai,
  });
}

export const LOCAL_PROGRESSION_PRIVACY_POLICY = Object.freeze({
  schemaVersion: PROGRESSION_SCHEMA_VERSION,
  persistence: "local-preference-and-aggregate-only",
  leavesDevice: false,
  contentFieldsAccepted: Object.freeze([] as const),
});
