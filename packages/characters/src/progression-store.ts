import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
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
  StarterProviderTotals28DaysSchema,
  selectStarterCharacter,
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

/** Persist the first deterministic auto-starter; later usage never makes it hop. */
export function withAutomaticStarterSelection(
  storeInput: LocalProgressionStore,
  providerTotals: StarterProviderTotals28Days,
  selectedAt: string,
): LocalProgressionStore;
export function withAutomaticStarterSelection(
  storeInput: unknown,
  providerTotals: unknown,
  selectedAt: unknown,
): LocalProgressionStore;
export function withAutomaticStarterSelection(
  storeInput: unknown,
  providerTotals: unknown,
  selectedAt: unknown,
): LocalProgressionStore {
  const store = LocalProgressionStoreSchema.parse(storeInput);
  if (store.selection.autoStarterCharacterId !== null) {
    return freezeStore(store);
  }
  const parsedTotals = StarterProviderTotals28DaysSchema.parse(providerTotals);
  const parsedSelectedAt = UtcTimestampSchema.parse(selectedAt);
  const selection = selectStarterCharacter({
    providerTotals28Days: parsedTotals,
  });
  if (selection.outcome !== "selected") return freezeStore(store);

  return freezeStore(
    LocalProgressionStoreSchema.parse({
      ...store,
      selection: {
        ...store.selection,
        autoStarterCharacterId: selection.characterId,
        autoStarterSelectedAt: parsedSelectedAt,
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

/** Copy evaluator unlock timestamps and a newly derived auto-starter into storage. */
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

  let selection = store.selection;
  if (
    progression.selection?.selectedBy === "unique-provider-total" &&
    selection.autoStarterCharacterId === null
  ) {
    selection = {
      ...selection,
      autoStarterCharacterId: progression.selection.characterId,
      autoStarterSelectedAt: progression.selection.selectedAt,
    };
  }

  return freezeStore(
    LocalProgressionStoreSchema.parse({
      ...store,
      unlockedAt,
      selection,
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

async function tryRemoveStaleLock(lockPath: string): Promise<boolean> {
  let serialized: string;
  try {
    serialized = await readFile(lockPath, "utf8");
  } catch (error) {
    return isMissingFile(error);
  }
  try {
    const lock = z
      .object({
        pid: z.number().int().positive(),
        createdAt: UtcTimestampSchema,
      })
      .passthrough()
      .parse(JSON.parse(serialized));
    if (Date.now() - Date.parse(lock.createdAt) <= STORE_LOCK_STALE_AFTER_MS) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    if ((await readFile(lockPath, "utf8")) !== serialized) return false;
    await rm(lockPath);
    return true;
  } catch (error) {
    return isMissingFile(error);
  }
}

async function acquireStoreLock(path: string): Promise<StoreLock> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lockPath = `${path}.lock`;

  for (let attempt = 0; attempt <= STORE_LOCK_RETRY_COUNT; attempt += 1) {
    const owner = `${JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
      ownerId: randomUUID(),
    })}\n`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let created = false;
    try {
      handle = await open(lockPath, "wx", 0o600);
      created = true;
      await handle.writeFile(owner, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
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
      if (handle !== null) await handle.close().catch(() => undefined);
      if (created) await rm(lockPath, { force: true }).catch(() => undefined);
      if (!hasErrorCode(error, "EEXIST")) throw error;
      if (await tryRemoveStaleLock(lockPath)) continue;
      if (attempt === STORE_LOCK_RETRY_COUNT) {
        throw new LocalProgressionStoreError("store-busy");
      }
      await delay(STORE_LOCK_RETRY_DELAY_MS);
    }
  }
  throw new LocalProgressionStoreError("store-busy");
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
