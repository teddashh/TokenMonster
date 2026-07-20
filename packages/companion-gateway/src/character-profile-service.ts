import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  MonsterDerivationV1Schema,
  deriveMonsterState,
  type MonsterDerivationV1,
  type MonsterMoodIdV1,
  type MonsterStateV1,
  type MonsterTraitIdV1,
} from "@tokenmonster/monster-engine";
import type { TokenTrackerAdapter } from "@tokenmonster/token-tracker-adapter";

import type {
  CompanionCharacterProfileResponse,
  CompanionCharacterProfileTraitId,
  CompanionGatewayClock,
} from "./types.js";

const ANALYTICAL_CHARACTER_ID = "chatgpt" as const;
const PROFILE_WINDOW_DAYS = 28;
const MAX_STALE_PROFILE_AGE_MS = 48 * 60 * 60 * 1_000;
const UNATTESTED_PROVIDER_TRAIT_IDS: ReadonlySet<MonsterTraitIdV1> = new Set([
  "provider-focused",
  "multi-provider",
  "balanced",
]);
export const CHARACTER_PROFILE_FILE = "character-profile-v1.json";

interface CharacterProfileSnapshot {
  readonly schemaVersion: "1";
  readonly computedAt: string;
  readonly derivation: MonsterDerivationV1;
}

interface CharacterProfileServiceOptions {
  readonly adapter: TokenTrackerAdapter;
  readonly progressionStorePath: string;
  readonly clock: CompanionGatewayClock;
}

export interface CharacterProfileService {
  getProfile(): Promise<CompanionCharacterProfileResponse>;
  getTapLineContext(): Promise<CharacterTapLineContext>;
}

export interface CharacterTapLineContext {
  readonly mood: MonsterMoodIdV1;
  readonly traits: readonly CompanionCharacterProfileTraitId[];
}

const UNKNOWN_TAP_LINE_CONTEXT: CharacterTapLineContext = Object.freeze({
  mood: "unknown",
  traits: Object.freeze([]),
});

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<PropertyKey, unknown>,
  keys: readonly string[],
): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length && keys.every((key) => ownKeys.includes(key))
  );
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function instant(clock: CompanionGatewayClock): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("invalid profile clock");
  }
  return value;
}

function addUtcDays(utcDate: string, days: number): string {
  const timestamp = Date.parse(`${utcDate}T00:00:00.000Z`);
  return new Date(timestamp + days * 86_400_000).toISOString().slice(0, 10);
}

export function characterProfilePath(progressionStorePath: string): string {
  return join(dirname(progressionStorePath), CHARACTER_PROFILE_FILE);
}

function isVisibleTraitId(
  value: MonsterTraitIdV1,
): value is CompanionCharacterProfileTraitId {
  return !UNATTESTED_PROVIDER_TRAIT_IDS.has(value);
}

function parseSnapshot(value: unknown): CharacterProfileSnapshot | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "computedAt", "derivation"]) ||
    value["schemaVersion"] !== "1" ||
    !isIsoInstant(value["computedAt"])
  ) {
    return null;
  }
  const parsedDerivation = MonsterDerivationV1Schema.safeParse(
    value["derivation"],
  );
  if (
    !parsedDerivation.success ||
    parsedDerivation.data.state.characterId !== ANALYTICAL_CHARACTER_ID ||
    parsedDerivation.data.state.window.timezone !== "UTC" ||
    value["computedAt"].slice(0, 10) !== parsedDerivation.data.state.window.to
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: "1",
    computedAt: value["computedAt"],
    derivation: parsedDerivation.data,
  });
}

async function loadSnapshot(
  path: string,
): Promise<CharacterProfileSnapshot | null> {
  try {
    return parseSnapshot(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
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
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function previousStateFor(
  snapshot: CharacterProfileSnapshot | null,
  now: Date,
  toUtcDate: string,
): MonsterStateV1 | null {
  if (!canUseStaleSnapshot(snapshot, now, toUtcDate)) return null;
  return snapshot.derivation.state;
}

function canUseStaleSnapshot(
  snapshot: CharacterProfileSnapshot | null,
  now: Date,
  toUtcDate: string,
): snapshot is CharacterProfileSnapshot {
  if (snapshot === null) return false;
  const ageMs = now.getTime() - Date.parse(snapshot.computedAt);
  const snapshotTo = snapshot.derivation.state.window.to;
  return (
    ageMs >= 0 &&
    ageMs <= MAX_STALE_PROFILE_AGE_MS &&
    (snapshotTo === toUtcDate || addUtcDays(snapshotTo, 1) === toUtcDate)
  );
}

function projectProfile(
  derivation: MonsterDerivationV1,
  generatedAt: string,
  freshness: CompanionCharacterProfileResponse["freshness"],
): CompanionCharacterProfileResponse {
  const { state } = derivation;
  const hiddenExplanationIds = new Set(
    state.traits
      .filter((trait) => UNATTESTED_PROVIDER_TRAIT_IDS.has(trait.id))
      .map((trait) => trait.explanationId),
  );
  return Object.freeze({
    status: "ok",
    schemaVersion: "1",
    generatedAt,
    freshness,
    dataQuality: "estimated-positive-days",
    window: Object.freeze({
      fromUtcDate: state.window.from,
      toUtcDate: state.window.to,
      timezone: "UTC",
    }),
    identity: Object.freeze({
      status: state.identityStatus,
      coverageBand: state.coverageBand,
      provisional: state.identityContinuity.provisional,
      traitIds: Object.freeze(
        state.traits.map((trait) => trait.id).filter(isVisibleTraitId),
      ),
    }),
    mood: Object.freeze({
      id: state.mood.id,
      energyBand: state.appearance.energyBand,
    }),
    evolution: Object.freeze({
      cadence: state.evolution.cadence,
      event: state.evolution.event,
    }),
    reasons: Object.freeze(
      derivation.explanations
        .filter(
          (explanation) => !hiddenExplanationIds.has(explanation.explanationId),
        )
        .map((explanation) =>
          Object.freeze({
            subject: explanation.subject,
            reasonCode: explanation.reasonCode,
            templateId: explanation.templateId,
            inputs: Object.freeze(
              explanation.inputs.map((input) =>
                Object.freeze({
                  metric: input.metric,
                  valueBand: input.valueBand,
                  coverage: input.coverage,
                }),
              ),
            ),
          }),
        ),
    ),
  });
}

export function createCharacterProfileService(
  options: CharacterProfileServiceOptions,
): CharacterProfileService {
  const profileFile = characterProfilePath(options.progressionStorePath);
  let mutation = Promise.resolve();
  let profileInFlight: Promise<CompanionCharacterProfileResponse> | null = null;

  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutation;
    let release!: () => void;
    mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  return Object.freeze({
    async getTapLineContext(): Promise<CharacterTapLineContext> {
      try {
        const now = instant(options.clock);
        const toUtcDate = now.toISOString().slice(0, 10);
        const snapshot = await loadSnapshot(profileFile);
        if (
          snapshot === null ||
          snapshot.computedAt.slice(0, 10) !== toUtcDate ||
          snapshot.derivation.state.window.to !== toUtcDate
        ) {
          return UNKNOWN_TAP_LINE_CONTEXT;
        }
        const ageMs = now.getTime() - Date.parse(snapshot.computedAt);
        if (ageMs < 0 || ageMs > MAX_STALE_PROFILE_AGE_MS) {
          return UNKNOWN_TAP_LINE_CONTEXT;
        }
        return Object.freeze({
          mood: snapshot.derivation.state.mood.id,
          traits: Object.freeze(
            snapshot.derivation.state.traits
              .map((trait) => trait.id)
              .filter(isVisibleTraitId),
          ),
        });
      } catch {
        return UNKNOWN_TAP_LINE_CONTEXT;
      }
    },

    getProfile(): Promise<CompanionCharacterProfileResponse> {
      if (profileInFlight !== null) return profileInFlight;
      const operation = serialize(async () => {
        const now = instant(options.clock);
        const generatedAt = now.toISOString();
        const toUtcDate = generatedAt.slice(0, 10);
        const fromUtcDate = addUtcDays(toUtcDate, -(PROFILE_WINDOW_DAYS - 1));
        const snapshot = await loadSnapshot(profileFile);
        let derivation: MonsterDerivationV1;
        try {
          const dailyFootprint =
            await options.adapter.getDailyContentBlindFootprint({
              fromUtcDate,
              toUtcDate,
              characterId: ANALYTICAL_CHARACTER_ID,
            });
          const footprint = {
            ...dailyFootprint,
            latestDayCompleteness: "partial" as const,
          };
          derivation = deriveMonsterState(
            footprint,
            previousStateFor(snapshot, now, toUtcDate),
          );
        } catch (error) {
          if (canUseStaleSnapshot(snapshot, now, toUtcDate)) {
            return projectProfile(snapshot.derivation, generatedAt, "stale");
          }
          throw error;
        }
        await writeJsonAtomically(profileFile, {
          schemaVersion: "1",
          computedAt: generatedAt,
          derivation,
        }).catch(() => undefined);
        return projectProfile(derivation, generatedAt, "fresh");
      }).finally(() => {
        if (profileInFlight === operation) profileInFlight = null;
      });
      profileInFlight = operation;
      return operation;
    },
  });
}
