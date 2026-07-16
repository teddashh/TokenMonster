import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import {
  PROGRESSION_SCHEMA_VERSION,
  evaluateProgression,
  loadLocalProgressionStore,
  mergeAndSaveDailyProviderBuckets,
  parseAssetManifest,
  saveLocalProgressionStore,
  withManualSisterSelection,
  withProgressionEvaluation,
  type AssetManifest,
  type DailyProviderBucket,
  type LocalProgressionStore,
  type ProgressionState,
  type WardrobeThemeId
} from "@tokenmonster/characters";
import type { TokenTrackerAdapter } from "@tokenmonster/token-tracker-adapter";

import type {
  CompanionCharacterFetch,
  CompanionCharacterOptions,
  CompanionCharacter,
  CompanionCharactersResponse,
  CompanionGatewayClock
} from "./types.js";

const ROSTER_IDS = [
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
  "glm"
] as const;
type RosterId = (typeof ROSTER_IDS)[number];

const SISTER_IDS = new Set<RosterId>([
  "chatgpt",
  "claude",
  "gemini",
  "grok"
]);
const MAX_OBJECT_BYTES = 4 * 1_024 * 1_024;
const DOWNLOAD_TIMEOUT_MS = 10_000;
const LEDGER_SYNC_INTERVAL_MS = 60_000;
const LEDGER_WINDOW_DAYS = 28;
const CHARACTER_PREFERENCES_FILE = "character-preferences-v1.json";

const LETTER_VISUALS = Object.freeze({
  chatgpt: ["T", "#DDF5EA", "#173F35", "#4A9D84"],
  claude: ["C", "#F7E5D5", "#553323", "#C47C55"],
  gemini: ["G", "#E4EBFF", "#263C74", "#6D83D7"],
  grok: ["X", "#ECEDEF", "#25282D", "#777D87"],
  deepseek: ["D", "#DCEBFF", "#173B70", "#4C80D8"],
  qwen: ["Q", "#F1E4FF", "#4A2868", "#9A62C5"],
  mistral: ["M", "#FFF0D8", "#5C351B", "#D58A43"],
  venice: ["L", "#E6F2E1", "#294923", "#78A86D"],
  sakana: ["S", "#DDF7F5", "#174947", "#4AA49E"],
  perplexity: ["P", "#E3F4F3", "#204C4B", "#5B9E9B"],
  glm: ["G", "#F0E8FF", "#402A66", "#8566B7"]
} as const satisfies Record<RosterId, readonly [string, string, string, string]>);

interface CharacterPreferences {
  readonly schemaVersion: "1";
  readonly manualCharacterId: RosterId | null;
  readonly selectedAt: string | null;
  readonly activeThemeByCharacter: Readonly<Partial<Record<RosterId, WardrobeThemeId>>>;
}

interface NormalizedCharacterOptions {
  readonly manifest: AssetManifest | null;
  readonly cacheDirectory: string;
  readonly cdnBaseUrl: string | null;
  readonly progressionStorePath: string;
  readonly fetch: CompanionCharacterFetch;
}

interface CharacterServiceOptions {
  readonly adapter: TokenTrackerAdapter;
  readonly characters: NormalizedCharacterOptions;
  readonly clock: CompanionGatewayClock;
}

export interface CharacterAssetResult {
  readonly status: 200 | 404 | 503;
  readonly body?: Buffer;
  readonly contentType?: string;
}

export interface CharacterService {
  syncAfterCompanionFetch(instant: Date): Promise<void>;
  getCharactersDto(): Promise<CompanionCharactersResponse>;
  selectCharacter(characterId: unknown): Promise<Readonly<{ status: number; body: unknown }>>;
  selectWardrobe(
    characterId: unknown,
    themeId: unknown
  ): Promise<Readonly<{ status: number; body: unknown }>>;
  getAsset(fileName: string): Promise<CharacterAssetResult>;
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isRosterId(value: unknown): value is RosterId {
  return typeof value === "string" && ROSTER_IDS.some((id) => id === value);
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function addUtcDays(utcDate: string, days: number): string {
  const timestamp = Date.parse(`${utcDate}T00:00:00.000Z`);
  return new Date(timestamp + days * 86_400_000).toISOString().slice(0, 10);
}

function emptyPreferences(): CharacterPreferences {
  return Object.freeze({
    schemaVersion: "1",
    manualCharacterId: null,
    selectedAt: null,
    activeThemeByCharacter: Object.freeze({})
  });
}

function parsePreferences(input: unknown): CharacterPreferences {
  if (
    !isPlainRecord(input) ||
    Reflect.ownKeys(input).length !== 4 ||
    input["schemaVersion"] !== "1" ||
    !(input["manualCharacterId"] === null || isRosterId(input["manualCharacterId"])) ||
    !(input["selectedAt"] === null || isIsoInstant(input["selectedAt"])) ||
    (input["manualCharacterId"] === null) !== (input["selectedAt"] === null) ||
    !isPlainRecord(input["activeThemeByCharacter"])
  ) {
    throw new Error("invalid character preferences");
  }
  const activeThemeByCharacter: Partial<Record<RosterId, WardrobeThemeId>> = {};
  for (const key of Reflect.ownKeys(input["activeThemeByCharacter"])) {
    if (typeof key !== "string" || !isRosterId(key)) {
      throw new Error("invalid character preferences");
    }
    const value = input["activeThemeByCharacter"][key];
    if (
      typeof value !== "string" ||
      ![
        "tech", "finance", "politics", "education", "health",
        "environment", "law", "relationship", "family", "workplace",
        "science", "culture", "sports", "food", "travel", "psychology",
        "philosophy", "international", "media", "festival"
      ].includes(value)
    ) {
      throw new Error("invalid character preferences");
    }
    activeThemeByCharacter[key] = value as WardrobeThemeId;
  }
  return Object.freeze({
    schemaVersion: "1",
    manualCharacterId: input["manualCharacterId"] as RosterId | null,
    selectedAt: input["selectedAt"] as string | null,
    activeThemeByCharacter: Object.freeze(activeThemeByCharacter)
  });
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
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

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function preferencesPath(progressionStorePath: string): string {
  return join(dirname(progressionStorePath), CHARACTER_PREFERENCES_FILE);
}

async function loadPreferences(path: string): Promise<CharacterPreferences> {
  try {
    return parsePreferences(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (!isMissingFile(error)) {
      const preferences = emptyPreferences();
      await writeJsonAtomically(path, preferences);
      return preferences;
    }
    return emptyPreferences();
  }
}

function evaluateStore(store: LocalProgressionStore, evaluatedAt: string): ProgressionState {
  return evaluateProgression({
    schemaVersion: PROGRESSION_SCHEMA_VERSION,
    evaluatedAt,
    evaluationUtcDate: evaluatedAt.slice(0, 10),
    baseline: store.lifetime.baseline,
    baselineActiveDays: store.lifetime.baselineActiveDays,
    dailyProviderBuckets: store.lifetime.dailyProviderBuckets,
    traitIds: [],
    persistedUnlockedAt: store.unlockedAt,
    selection: store.selection
  });
}

function fallbackProgression(evaluatedAt: string): ProgressionState {
  return evaluateProgression({
    schemaVersion: PROGRESSION_SCHEMA_VERSION,
    evaluatedAt,
    evaluationUtcDate: evaluatedAt.slice(0, 10),
    dailyProviderBuckets: [],
    traitIds: [],
    persistedUnlockedAt: {},
    selection: {
      manualCharacterId: null,
      manualSelectedAt: null,
      autoStarterCharacterId: null,
      autoStarterSelectedAt: null
    }
  });
}

function manifestPath(path: string): string {
  return `/assets/characters/${path}`;
}

function characterDto(
  characterId: RosterId,
  progression: ProgressionState,
  manifest: AssetManifest | null,
  preferences: CharacterPreferences,
  forceLetterMode: boolean
): CompanionCharacter {
  const status = progression.characters.find(
    (character) => character.characterId === characterId
  )!;
  const assets = forceLetterMode
    ? undefined
    : manifest?.characters.find((character) => character.characterId === characterId);
  const preferredThemeId = preferences.activeThemeByCharacter[characterId];
  const preferredTheme = status.themes.find(
    (theme) => theme.themeId === preferredThemeId && theme.unlocked
  );
  const firstUnlockedTheme = status.themes.find((theme) => theme.unlocked);
  const firstUnlockedAssetTheme = assets?.themes.find((theme) =>
    status.themes.some(
      (candidate) => candidate.themeId === theme.themeId && candidate.unlocked
    )
  );
  const activeThemeId =
    preferredTheme !== undefined &&
    (assets === undefined ||
      assets.themes.some((theme) => theme.themeId === preferredTheme.themeId))
      ? preferredTheme.themeId
      : assets === undefined
        ? (firstUnlockedTheme?.themeId ?? null)
        : (firstUnlockedAssetTheme?.themeId ?? null);
  const nextTheme = status.unlocked
    ? status.themes.find((theme) => !theme.unlocked)
    : undefined;
  const progress = !status.unlocked
    ? {
        value: status.progress.value,
        explain: `再累積一點本機用量，就能遇見 ${status.displayName}。`
      }
    : nextTheme === undefined
      ? null
      : {
          value: nextTheme.progress.value,
          explain: `再累積一點本機用量，就能解鎖 ${status.displayName} 的下一套服裝。`
        };
  const voice = manifest?.voice.find((entry) => entry.characterId === characterId);

  let visual: CompanionCharacter["visual"];
  if (assets === undefined) {
    const [glyph, background, foreground, accent] = LETTER_VISUALS[characterId];
    visual = { mode: "letter", glyph, background, foreground, accent };
  } else {
    visual = {
      mode: "doll",
      avatarPath: manifestPath(assets.avatar.path),
      themes: assets.themes.map((theme) => {
        const themeStatus = status.themes.find(
          (candidate) => candidate.themeId === theme.themeId
        );
        return {
          themeId: theme.themeId,
          unlocked: themeStatus?.unlocked ?? false,
          outfitPath: manifestPath(theme.outfit.path),
          posePaths: {
            supported:
              theme.poses.supported === undefined
                ? null
                : manifestPath(theme.poses.supported.path),
            challenged:
              theme.poses.challenged === undefined
                ? null
                : manifestPath(theme.poses.challenged.path),
            victory:
              theme.poses.victory === undefined
                ? null
                : manifestPath(theme.poses.victory.path)
          }
        };
      })
    };
  }

  return {
    characterId,
    displayName: status.displayName,
    kind: status.kind === "sister" ? "sister" : "friend",
    unlocked: status.unlocked,
    unlockedAt: status.unlockedAt,
    isStarter: status.kind === "sister",
    activeThemeId,
    visual,
    progress,
    voiceLines:
      status.unlocked && voice !== undefined
        ? voice.lines.map((line) => ({
            id: line.id,
            trigger: line.trigger,
            path: manifestPath(line.object.path),
            durationMs: line.durationMs
          }))
        : []
  };
}

class DownloadSemaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  public async acquire(): Promise<() => void> {
    if (this.active >= 3) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    return () => {
      this.active -= 1;
      this.waiting.shift()?.();
    };
  }
}

async function readVerifiedCache(path: string, sha256: string): Promise<Buffer | null> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_OBJECT_BYTES) {
      await rm(path, { force: true });
      return null;
    }
    const body = await readFile(path);
    if (createHash("sha256").update(body).digest("hex") !== sha256) {
      await rm(path, { force: true });
      return null;
    }
    return body;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function readDownloadBody(
  response: Awaited<ReturnType<CompanionCharacterFetch>>
): Promise<Buffer> {
  if (!response.ok || response.status !== 200 || response.body === null) {
    throw new Error("asset fetch failed");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_OBJECT_BYTES) {
      throw new Error("asset too large");
    }
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array) || result.value.byteLength === 0) {
        throw new Error("invalid asset body");
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_OBJECT_BYTES) throw new Error("asset too large");
      chunks.push(Buffer.from(result.value));
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks, totalBytes);
}

async function cacheAtomically(directory: string, fileName: string, body: Buffer): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const destination = join(directory, fileName);
  const temporary = join(
    directory,
    `.${fileName}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function assetIsUnlocked(
  fileName: string,
  manifest: AssetManifest,
  progression: ProgressionState
): boolean {
  const objectPath = `objects/${fileName}`;
  for (const characterAssets of manifest.characters) {
    const character = progression.characters.find(
      (candidate) => candidate.characterId === characterAssets.characterId
    );
    if (character?.unlocked !== true) continue;
    if (characterAssets.avatar.path === objectPath) return true;
    for (const theme of characterAssets.themes) {
      const themeStatus = character.themes.find(
        (candidate) => candidate.themeId === theme.themeId
      );
      if (themeStatus?.unlocked !== true) continue;
      if (
        theme.outfit.path === objectPath ||
        Object.values(theme.poses).some((pose) => pose?.path === objectPath)
      ) {
        return true;
      }
    }
  }
  for (const voice of manifest.voice) {
    const character = progression.characters.find(
      (candidate) => candidate.characterId === voice.characterId
    );
    if (
      character?.unlocked === true &&
      voice.lines.some((line) => line.object.path === objectPath)
    ) {
      return true;
    }
  }
  return false;
}

export function createCharacterService(options: CharacterServiceOptions): CharacterService {
  const { adapter, characters, clock } = options;
  const progressionOptions = Object.freeze({ path: characters.progressionStorePath });
  const preferenceFile = preferencesPath(characters.progressionStorePath);
  const semaphore = new DownloadSemaphore();
  const downloads = new Map<string, Promise<Buffer>>();
  let lastLedgerSyncStartedAtMs: number | null = null;
  let ledgerSyncInFlight: Promise<void> | null = null;
  let storeMutation = Promise.resolve();
  let preferenceMutation = Promise.resolve();

  const serializeStore = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = storeMutation;
    let release!: () => void;
    storeMutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const serializePreferences = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = preferenceMutation;
    let release!: () => void;
    preferenceMutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const loadEvaluated = async (): Promise<Readonly<{
    store: LocalProgressionStore;
    progression: ProgressionState;
  }>> =>
    serializeStore(async () => {
      const loaded = await loadLocalProgressionStore(progressionOptions);
      const evaluatedAt = clock().toISOString();
      const progression = evaluateStore(loaded.store, evaluatedAt);
      const store = withProgressionEvaluation(loaded.store, progression);
      await saveLocalProgressionStore(store, progressionOptions);
      return Object.freeze({ store, progression });
    });

  const syncLedger = async (instant: Date): Promise<void> => {
    await serializeStore(async () => {
      const loaded = await loadLocalProgressionStore(progressionOptions);
      const today = instant.toISOString().slice(0, 10);
      const windowStart = addUtcDays(today, -(LEDGER_WINDOW_DAYS - 1));
      const existing = new Set(
        loaded.store.lifetime.dailyProviderBuckets.map((bucket) => bucket.utcDate)
      );
      const dates = new Set<string>([today]);
      for (let offset = 0; offset < LEDGER_WINDOW_DAYS; offset += 1) {
        const date = addUtcDays(windowStart, offset);
        if (!existing.has(date)) dates.add(date);
      }
      const lastDate = loaded.store.lifetime.dailyProviderBuckets.at(-1)?.utcDate;
      if (lastDate !== undefined && lastDate < today) {
        for (
          let date = addUtcDays(lastDate < windowStart ? windowStart : lastDate, 1);
          date <= today;
          date = addUtcDays(date, 1)
        ) {
          dates.add(date);
        }
      }
      const buckets: DailyProviderBucket[] = await Promise.all(
        [...dates].sort().map(async (utcDate) => ({
          utcDate,
          providerTotals: await adapter.getProgressionFamilyTotals({
            fromUtcDate: utcDate,
            toUtcDate: utcDate
          })
        }))
      );
      const merged = await mergeAndSaveDailyProviderBuckets(
        buckets,
        progressionOptions
      );
      const progression = evaluateStore(merged.store, instant.toISOString());
      await saveLocalProgressionStore(
        withProgressionEvaluation(merged.store, progression),
        progressionOptions
      );
    });
  };

  const getStateForAsset = async (): Promise<ProgressionState> =>
    (await loadEvaluated()).progression;

  const downloadAsset = async (fileName: string, sha256: string): Promise<Buffer> => {
    const existing = downloads.get(fileName);
    if (existing !== undefined) return existing;
    const operation = (async () => {
      const release = await semaphore.acquire();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      timer.unref();
      try {
        const response = await characters.fetch(
          `${characters.cdnBaseUrl}/objects/${fileName}`,
          Object.freeze({
            method: "GET",
            redirect: "error",
            signal: controller.signal
          })
        );
        const body = await readDownloadBody(response);
        if (createHash("sha256").update(body).digest("hex") !== sha256) {
          throw new Error("asset integrity mismatch");
        }
        await cacheAtomically(characters.cacheDirectory, fileName, body);
        return body;
      } finally {
        clearTimeout(timer);
        release();
      }
    })();
    downloads.set(fileName, operation);
    try {
      return await operation;
    } finally {
      downloads.delete(fileName);
    }
  };

  return Object.freeze({
    async syncAfterCompanionFetch(instant: Date): Promise<void> {
      const nowMs = instant.getTime();
      if (ledgerSyncInFlight !== null) return ledgerSyncInFlight;
      if (
        lastLedgerSyncStartedAtMs !== null &&
        nowMs - lastLedgerSyncStartedAtMs < LEDGER_SYNC_INTERVAL_MS
      ) {
        return;
      }
      lastLedgerSyncStartedAtMs = nowMs;
      const operation = syncLedger(instant).finally(() => {
        if (ledgerSyncInFlight === operation) ledgerSyncInFlight = null;
      });
      ledgerSyncInFlight = operation;
      return operation;
    },

    async getCharactersDto(): Promise<CompanionCharactersResponse> {
      const generatedAt = clock().toISOString();
      let progression: ProgressionState;
      let preferences: CharacterPreferences;
      let forceLetterMode = false;
      try {
        [progression, preferences] = await Promise.all([
          loadEvaluated().then((state) => state.progression),
          loadPreferences(preferenceFile)
        ]);
      } catch {
        progression = fallbackProgression(generatedAt);
        preferences = emptyPreferences();
        forceLetterMode = true;
      }
      const progressionSelection = progression.selection;
      const selection =
        preferences.manualCharacterId !== null
          ? {
              characterId: preferences.manualCharacterId,
              selectedBy: "manual" as const
            }
          : progressionSelection === null
            ? { characterId: null, selectedBy: null }
            : {
                characterId: progressionSelection.characterId,
                selectedBy:
                  progressionSelection.selectedBy === "manual"
                    ? ("manual" as const)
                    : ("auto-starter" as const)
              };
      return {
        status: "ok",
        generatedAt,
        selection,
        voiceEnabled: true,
        characters: ROSTER_IDS.map((characterId) =>
          characterDto(
            characterId,
            progression,
            characters.manifest,
            preferences,
            forceLetterMode
          )
        )
      };
    },

    async selectCharacter(characterId: unknown) {
      if (!isRosterId(characterId)) {
        return Object.freeze({
          status: 400,
          body: { status: "error", error: "invalid-request" }
        });
      }
      try {
        const current = await loadEvaluated();
        const status = current.progression.characters.find(
          (candidate) => candidate.characterId === characterId
        );
        if (status?.unlocked !== true) {
          return Object.freeze({
            status: 409,
            body: { status: "error", error: "locked" }
          });
        }
        const selectedAt = clock().toISOString();
        if (SISTER_IDS.has(characterId)) {
          await serializeStore(async () => {
            const loaded = await loadLocalProgressionStore(progressionOptions);
            await saveLocalProgressionStore(
              withManualSisterSelection(
                loaded.store,
                characterId as "chatgpt" | "claude" | "gemini" | "grok",
                selectedAt
              ),
              progressionOptions
            );
          });
        }
        await serializePreferences(async () => {
          const preferences = await loadPreferences(preferenceFile);
          await writeJsonAtomically(preferenceFile, {
            ...preferences,
            manualCharacterId: characterId,
            selectedAt
          });
        });
        return Object.freeze({
          status: 200,
          body: {
            status: "ok",
            selection: { characterId, selectedBy: "manual" }
          }
        });
      } catch {
        return Object.freeze({
          status: 400,
          body: { status: "error", error: "invalid-request" }
        });
      }
    },

    async selectWardrobe(characterId: unknown, themeId: unknown) {
      if (!isRosterId(characterId) || typeof themeId !== "string") {
        return Object.freeze({
          status: 400,
          body: { status: "error", error: "invalid-request" }
        });
      }
      try {
        const current = await loadEvaluated();
        const character = current.progression.characters.find(
          (candidate) => candidate.characterId === characterId
        );
        const theme = character?.themes.find(
          (candidate) => candidate.themeId === themeId
        );
        if (character === undefined || theme === undefined) {
          return Object.freeze({
            status: 400,
            body: { status: "error", error: "invalid-request" }
          });
        }
        if (!character.unlocked || !theme.unlocked) {
          return Object.freeze({
            status: 409,
            body: { status: "error", error: "locked" }
          });
        }
        await serializePreferences(async () => {
          const preferences = await loadPreferences(preferenceFile);
          await writeJsonAtomically(preferenceFile, {
            ...preferences,
            activeThemeByCharacter: {
              ...preferences.activeThemeByCharacter,
              [characterId]: theme.themeId
            }
          });
        });
        return Object.freeze({
          status: 200,
          body: {
            status: "ok",
            characterId,
            activeThemeId: theme.themeId
          }
        });
      } catch {
        return Object.freeze({
          status: 400,
          body: { status: "error", error: "invalid-request" }
        });
      }
    },

    async getAsset(fileName: string): Promise<CharacterAssetResult> {
      const match = /^([0-9a-f]{64})\.(webp|png|wav)$/u.exec(fileName);
      if (match === null || characters.manifest === null) {
        return Object.freeze({ status: 404 });
      }
      const sha256 = match[1]!;
      try {
        const progression = await getStateForAsset();
        if (!assetIsUnlocked(fileName, characters.manifest, progression)) {
          return Object.freeze({ status: 404 });
        }
        const cachePath = join(characters.cacheDirectory, fileName);
        let body = await readVerifiedCache(cachePath, sha256);
        if (body === null) {
          if (characters.cdnBaseUrl === null) {
            return Object.freeze({ status: 404 });
          }
          body = await downloadAsset(fileName, sha256);
        }
        const contentType =
          match[2] === "webp"
            ? "image/webp"
            : match[2] === "png"
              ? "image/png"
              : "audio/wav";
        return Object.freeze({ status: 200, body, contentType });
      } catch {
        return Object.freeze({ status: 503 });
      }
    }
  });
}

export function normalizeCharacterOptions(
  value: unknown,
  nativeFetch: CompanionCharacterFetch
): NormalizedCharacterOptions {
  const keys = new Set<PropertyKey>([
    "manifest",
    "cacheDirectory",
    "cdnBaseUrl",
    "progressionStorePath",
    "fetch"
  ]);
  if (
    !isPlainRecord(value) ||
    Reflect.ownKeys(value).some((key) => !keys.has(key)) ||
    !Reflect.ownKeys(value).includes("manifest") ||
    !Reflect.ownKeys(value).includes("cacheDirectory") ||
    !Reflect.ownKeys(value).includes("cdnBaseUrl") ||
    !Reflect.ownKeys(value).includes("progressionStorePath")
  ) {
    throw new Error("invalid character configuration");
  }
  const manifestValue = value["manifest"];
  let manifest: AssetManifest | null;
  try {
    manifest = manifestValue === null ? null : parseAssetManifest(manifestValue);
  } catch {
    throw new Error("invalid character configuration");
  }
  const cacheDirectory = value["cacheDirectory"];
  const progressionStorePath = value["progressionStorePath"];
  const fetchValue = value["fetch"];
  if (
    typeof cacheDirectory !== "string" ||
    !isAbsolute(cacheDirectory) ||
    typeof progressionStorePath !== "string" ||
    !isAbsolute(progressionStorePath) ||
    (fetchValue !== undefined && typeof fetchValue !== "function")
  ) {
    throw new Error("invalid character configuration");
  }
  const cdnValue = value["cdnBaseUrl"];
  let cdnBaseUrl: string | null = null;
  if (cdnValue !== null) {
    if (typeof cdnValue !== "string") {
      throw new Error("invalid character configuration");
    }
    let parsed: URL;
    try {
      parsed = new URL(cdnValue);
    } catch {
      throw new Error("invalid character configuration");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error("invalid character configuration");
    }
    cdnBaseUrl = parsed.toString().replace(/\/$/u, "");
  }
  return Object.freeze({
    manifest,
    cacheDirectory,
    cdnBaseUrl,
    progressionStorePath,
    fetch: (fetchValue as CompanionCharacterFetch | undefined) ?? nativeFetch
  });
}
