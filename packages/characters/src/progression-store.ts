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
  StarterProviderTotals28DaysSchema,
  selectStarterCharacter,
  type StarterProviderTotals28Days,
} from "./starter-selection.js";

export const LOCAL_PROGRESSION_STORE_SCHEMA_VERSION = "1" as const;
export const LOCAL_PROGRESSION_DIRECTORY_NAME = ".tokenmonster" as const;
export const LOCAL_PROGRESSION_FILE_NAME = "progression-v1.json" as const;

const StoredLifetimeSchema = z
  .object({
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

    const counters = deriveLifetimeCounters(store.lifetime.dailyProviderBuckets);
    if (
      JSON.stringify(counters.providerTotals) !==
        JSON.stringify(store.lifetime.providerTotals) ||
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
  for (const bucket of incoming) {
    const providerTotals = bucketsByDate.get(bucket.utcDate) ?? {};
    mergeProviderMaximums(providerTotals, bucket.providerTotals);
    bucketsByDate.set(bucket.utcDate, providerTotals);
  }

  const dailyProviderBuckets = [...bucketsByDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([utcDate, providerTotals]) => ({ utcDate, providerTotals }));
  const counters = deriveLifetimeCounters(dailyProviderBuckets);

  return freezeStore(
    LocalProgressionStoreSchema.parse({
      ...store,
      lifetime: {
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
    .union([
      z.enum(["chatgpt", "claude", "gemini", "grok"]),
      z.null(),
    ])
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
  const store = freezeStore(LocalProgressionStoreSchema.parse(storeInput));
  await writeAtomically(resolveLocalProgressionStorePath(options), store);
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
    const store = freezeStore(LocalProgressionStoreSchema.parse(JSON.parse(serialized)));
    return Object.freeze({ store, corruptionRecovered: false });
  } catch {
    const store = createEmptyLocalProgressionStore();
    await writeAtomically(path, store);
    return Object.freeze({ store, corruptionRecovered: true });
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
  const loaded = await loadLocalProgressionStore(options);
  const store = mergeDailyProviderBuckets(loaded.store, incoming);
  await saveLocalProgressionStore(store, options);
  return Object.freeze({
    store,
    corruptionRecovered: loaded.corruptionRecovered,
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
