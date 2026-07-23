import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import {
  LETTER_WARDROBE_CATALOG,
  LocalProgressionStoreError,
  PROGRESSION_SCHEMA_VERSION,
  WardrobeThemeIdSchema,
  evaluateProgression,
  getCharacterDefinition,
  loadLocalProgressionStore,
  mergeAndSaveDailyProviderBuckets,
  parseAssetManifest,
  repairLegacyProgressionStoreLock,
  saveLocalProgressionStore,
  selectTapLine,
  withManualSisterSelection,
  withProgressionEvaluation,
  type ApprovedAssetPackConfiguration,
  type AssetManifest,
  type DailyProviderBucket,
  type LocalProgressionStore,
  type MonsterMood,
  type MonsterTrait,
  type ObjectRef,
  type ProgressionState,
  type WardrobeThemeId,
} from "@tokenmonster/characters";
import type { TokenTrackerAdapter } from "@tokenmonster/token-tracker-adapter";

import {
  mediaSignatureMatches,
  normalizeAssetPackConfiguration,
} from "./asset-pack-service.js";
import type {
  CompanionCharacter,
  CompanionCharacterInteractionResponse,
  CompanionCharactersResponse,
  CompanionGatewayClock,
} from "./types.js";

export const CHARACTER_ROSTER_IDS = [
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
  "glm",
] as const;
type RosterId = (typeof CHARACTER_ROSTER_IDS)[number];
type SisterId = "chatgpt" | "claude" | "gemini" | "grok";

const SISTER_IDS = new Set<RosterId>(["chatgpt", "claude", "gemini", "grok"]);
const MAX_OBJECT_BYTES = 4 * 1_024 * 1_024;
const LEDGER_SYNC_INTERVAL_MS = 60_000;
const LEDGER_WINDOW_DAYS = 28;
const CHARACTER_PREFERENCES_FILE = "character-preferences-v1.json";
export const CHARACTER_INTERACTIONS_FILE = "character-interactions-v1.json";
export const CHARACTER_TAP_COOLDOWN_MS = 1_600;
export const CHARACTER_TAP_DAILY_CAP = 48;
// Ambient idle chatter stays stateless: the line rotates on a shared UTC
// bucket instead of the persisted tap seed, so background speech can never
// consume the daily tap allowance. The cooldown hint must stay within the
// client contract bound of 60 seconds.
export const CHARACTER_IDLE_LINE_BUCKET_MS = 120_000;
export const CHARACTER_IDLE_LINE_COOLDOWN_MS = 45_000;
const MAX_TAP_LINE_ID_LENGTH = 128;
const MAX_TAP_LINE_TEXT_LENGTH = 240;

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
  glm: ["G", "#F0E8FF", "#402A66", "#8566B7"],
} as const satisfies Record<
  RosterId,
  readonly [string, string, string, string]
>);

interface CharacterPreferences {
  readonly schemaVersion: "1";
  readonly manualCharacterId: RosterId | null;
  readonly selectedAt: string | null;
  readonly activeThemeByCharacter: Readonly<
    Partial<Record<RosterId, WardrobeThemeId>>
  >;
}

interface CharacterInteractionEntry {
  readonly lastShownAt: string;
  readonly dailyCount: number;
  readonly nextSeed: number;
}

interface CharacterInteractionStore {
  readonly schemaVersion: "1";
  readonly utcDate: string;
  readonly characters: Readonly<
    Partial<Record<RosterId, CharacterInteractionEntry>>
  >;
}

interface NormalizedCharacterOptions {
  readonly manifest: AssetManifest | null;
  readonly baseAssets: NormalizedBaseAssets | null;
  readonly assetPack: ApprovedAssetPackConfiguration | null;
  readonly cacheDirectory: string;
  readonly progressionStorePath: string;
}

interface NormalizedBaseAssets {
  readonly manifest: AssetManifest;
  /** Returns a defensive copy so response consumers cannot mutate authority. */
  readonly readObject: (path: string) => Buffer | null;
}

interface CharacterServiceOptions {
  readonly adapter: TokenTrackerAdapter;
  readonly characters: NormalizedCharacterOptions;
  readonly clock: CompanionGatewayClock;
  readonly getTapLineContext?: () => Promise<
    Readonly<{
      mood: MonsterMood;
      traits: readonly MonsterTrait[];
    }>
  >;
}

export interface CharacterAssetResult {
  readonly status: 200 | 404 | 503;
  readonly body?: Buffer;
  readonly contentType?: string;
}

export interface CharacterService {
  syncAfterCompanionFetch(instant: Date): Promise<void>;
  getCharactersDto(): Promise<CompanionCharactersResponse>;
  selectCharacter(
    characterId: unknown,
  ): Promise<Readonly<{ status: number; body: unknown }>>;
  repairProgressionLock(
    confirmedOldVersionsClosed: unknown,
  ): Promise<Readonly<{ status: number; body: unknown }>>;
  selectWardrobe(
    characterId: unknown,
    themeId: unknown,
  ): Promise<Readonly<{ status: number; body: unknown }>>;
  interact(
    characterId: unknown,
    action: unknown,
    locale: unknown,
  ): Promise<Readonly<{ status: number; body: unknown }>>;
  getAsset(fileName: string): Promise<CharacterAssetResult>;
  setManifest(manifest: AssetManifest | null): void;
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function ownDataValue(
  value: Record<PropertyKey, unknown>,
  key: PropertyKey,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new Error("invalid character configuration");
  }
  return descriptor.value;
}

function sameObjectRef(left: ObjectRef, right: ObjectRef): boolean {
  return (
    left.path === right.path &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256 &&
    left.width === right.width &&
    left.height === right.height
  );
}

function manifestObjectRefs(
  manifest: AssetManifest,
): ReadonlyMap<string, ObjectRef> {
  const refs = new Map<string, ObjectRef>();
  const add = (ref: ObjectRef): void => {
    const previous = refs.get(ref.path);
    if (previous !== undefined && !sameObjectRef(previous, ref)) {
      throw new Error("invalid character configuration");
    }
    refs.set(ref.path, ref);
  };
  for (const character of manifest.characters) {
    add(character.avatar);
    for (const theme of character.themes) {
      add(theme.outfit);
      for (const pose of Object.values(theme.poses)) {
        if (pose !== undefined) add(pose);
      }
    }
  }
  for (const voice of manifest.voice) {
    for (const line of voice.lines) add(line.object);
  }
  return refs;
}

function mediaTypeForObjectPath(
  path: string,
): "image/webp" | "image/png" | "audio/wav" {
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".png")) return "image/png";
  return "audio/wav";
}

function normalizeBaseAssets(value: unknown): NormalizedBaseAssets | null {
  if (value === null || value === undefined) return null;
  if (
    !isPlainRecord(value) ||
    Reflect.ownKeys(value).length !== 2 ||
    !Reflect.ownKeys(value).includes("manifest") ||
    !Reflect.ownKeys(value).includes("objects")
  ) {
    throw new Error("invalid character configuration");
  }

  let manifest: AssetManifest;
  try {
    manifest = parseAssetManifest(ownDataValue(value, "manifest"));
  } catch {
    throw new Error("invalid character configuration");
  }
  const objectValue = ownDataValue(value, "objects");
  if (!isPlainRecord(objectValue)) {
    throw new Error("invalid character configuration");
  }
  const refs = manifestObjectRefs(manifest);
  const keys = Reflect.ownKeys(objectValue);
  if (
    keys.length !== refs.size ||
    keys.some((key) => typeof key !== "string" || !refs.has(key))
  ) {
    throw new Error("invalid character configuration");
  }

  const verified = new Map<string, Buffer>();
  for (const [path, ref] of refs) {
    const bytesValue = ownDataValue(objectValue, path);
    if (!(bytesValue instanceof Uint8Array)) {
      throw new Error("invalid character configuration");
    }
    const bytes = Buffer.from(bytesValue);
    if (
      bytes.byteLength !== ref.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== ref.sha256 ||
      !mediaSignatureMatches(mediaTypeForObjectPath(path), bytes)
    ) {
      throw new Error("invalid character configuration");
    }
    verified.set(path, bytes);
  }

  return Object.freeze({
    manifest,
    readObject: (path: string): Buffer | null => {
      const bytes = verified.get(path);
      return bytes === undefined ? null : Buffer.from(bytes);
    },
  });
}

function isRosterId(value: unknown): value is RosterId {
  return (
    typeof value === "string" && CHARACTER_ROSTER_IDS.some((id) => id === value)
  );
}

function isSisterId(value: RosterId): value is SisterId {
  return SISTER_IDS.has(value);
}

function isStoreBusyError(error: unknown): boolean {
  return (
    error instanceof LocalProgressionStoreError && error.code === "store-busy"
  );
}

function isIsoInstant(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    return false;
  }
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
    activeThemeByCharacter: Object.freeze({}),
  });
}

function parsePreferences(input: unknown): CharacterPreferences {
  if (
    !isPlainRecord(input) ||
    Reflect.ownKeys(input).length !== 4 ||
    input["schemaVersion"] !== "1" ||
    !(
      input["manualCharacterId"] === null ||
      isRosterId(input["manualCharacterId"])
    ) ||
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
    const parsedThemeId = WardrobeThemeIdSchema.safeParse(value);
    if (!parsedThemeId.success) {
      throw new Error("invalid character preferences");
    }
    activeThemeByCharacter[key] = parsedThemeId.data;
  }
  return Object.freeze({
    schemaVersion: "1",
    manualCharacterId: input["manualCharacterId"] as RosterId | null,
    selectedAt: input["selectedAt"] as string | null,
    activeThemeByCharacter: Object.freeze(activeThemeByCharacter),
  });
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

export function characterInteractionsPath(
  progressionStorePath: string,
): string {
  return join(dirname(progressionStorePath), CHARACTER_INTERACTIONS_FILE);
}

function emptyInteractionStore(utcDate: string): CharacterInteractionStore {
  return Object.freeze({
    schemaVersion: "1",
    utcDate,
    characters: Object.freeze({}),
  });
}

function parseInteractionEntry(
  input: unknown,
  utcDate: string,
): CharacterInteractionEntry {
  if (
    !isPlainRecord(input) ||
    Reflect.ownKeys(input).length !== 3 ||
    !Reflect.ownKeys(input).includes("lastShownAt") ||
    !Reflect.ownKeys(input).includes("dailyCount") ||
    !Reflect.ownKeys(input).includes("nextSeed")
  ) {
    throw new Error("invalid character interaction entry");
  }
  const lastShownAt = input["lastShownAt"];
  const dailyCount = input["dailyCount"];
  const nextSeed = input["nextSeed"];
  if (
    !isIsoInstant(lastShownAt) ||
    lastShownAt.slice(0, 10) !== utcDate ||
    typeof dailyCount !== "number" ||
    !Number.isInteger(dailyCount) ||
    dailyCount < 1 ||
    dailyCount > CHARACTER_TAP_DAILY_CAP ||
    typeof nextSeed !== "number" ||
    !Number.isSafeInteger(nextSeed) ||
    nextSeed < 0
  ) {
    throw new Error("invalid character interaction entry");
  }
  return Object.freeze({ lastShownAt, dailyCount, nextSeed });
}

function parseInteractionStore(
  input: unknown,
  utcDate: string,
): CharacterInteractionStore {
  if (
    !isPlainRecord(input) ||
    Reflect.ownKeys(input).length !== 3 ||
    input["schemaVersion"] !== "1" ||
    typeof input["utcDate"] !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(input["utcDate"]) ||
    !isPlainRecord(input["characters"])
  ) {
    throw new Error("invalid character interaction store");
  }
  if (input["utcDate"] !== utcDate) return emptyInteractionStore(utcDate);
  const entries: Partial<Record<RosterId, CharacterInteractionEntry>> = {};
  for (const key of Reflect.ownKeys(input["characters"])) {
    if (typeof key !== "string" || !isRosterId(key)) {
      throw new Error("invalid character interaction store");
    }
    entries[key] = parseInteractionEntry(input["characters"][key], utcDate);
  }
  return Object.freeze({
    schemaVersion: "1",
    utcDate,
    characters: Object.freeze(entries),
  });
}

async function loadInteractionStore(
  path: string,
  utcDate: string,
): Promise<CharacterInteractionStore> {
  try {
    return parseInteractionStore(
      JSON.parse(await readFile(path, "utf8")) as unknown,
      utcDate,
    );
  } catch {
    return emptyInteractionStore(utcDate);
  }
}

function isSupportedTapLocale(value: unknown): value is "zh-TW" | "en" {
  return value === "zh-TW" || value === "en";
}

function nextUtcDateStartMs(utcDate: string): number {
  return Date.parse(`${utcDate}T00:00:00.000Z`) + 86_400_000;
}

function boundedRetryAfterMs(value: number): number {
  return Math.max(1, Math.min(86_400_000, Math.ceil(value)));
}

function validTapLine(lineId: string, text: string): boolean {
  return (
    lineId.length >= 1 &&
    lineId.length <= MAX_TAP_LINE_ID_LENGTH &&
    /^[A-Za-z0-9./-]+$/u.test(lineId) &&
    text.trim() === text &&
    text.length >= 1 &&
    text.length <= MAX_TAP_LINE_TEXT_LENGTH
  );
}

async function loadPreferences(path: string): Promise<CharacterPreferences> {
  try {
    return parsePreferences(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
  } catch {
    // Reads are side-effect free. In particular, selecting a sister must not
    // repair or replace the friend-authority file as a hidden second commit.
    return emptyPreferences();
  }
}

function evaluateStore(
  store: LocalProgressionStore,
  evaluatedAt: string,
): ProgressionState {
  return evaluateProgression({
    schemaVersion: PROGRESSION_SCHEMA_VERSION,
    evaluatedAt,
    evaluationUtcDate: evaluatedAt.slice(0, 10),
    baseline: store.lifetime.baseline,
    baselineActiveDays: store.lifetime.baselineActiveDays,
    dailyProviderBuckets: store.lifetime.dailyProviderBuckets,
    traitIds: [],
    persistedUnlockedAt: store.unlockedAt,
    selection: store.selection,
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
      autoStarterSelectedAt: null,
    },
  });
}

interface ResolvedCharacterSelection {
  readonly characterId: RosterId;
  readonly selectedBy: "manual" | "auto-starter";
  readonly selectedAt: string;
}

function resolveCharacterSelection(
  progression: ProgressionState,
  preferences: CharacterPreferences,
): ResolvedCharacterSelection | null {
  const progressionSelection = progression.selection;
  const sisterSelection: ResolvedCharacterSelection | null =
    progressionSelection === null ||
    !isSisterId(progressionSelection.characterId)
      ? null
      : Object.freeze({
          characterId: progressionSelection.characterId,
          selectedBy:
            progressionSelection.selectedBy === "manual"
              ? ("manual" as const)
              : ("auto-starter" as const),
          selectedAt: progressionSelection.selectedAt,
        });

  const preferredCharacterId = preferences.manualCharacterId;
  const preferredCharacter =
    preferredCharacterId === null || isSisterId(preferredCharacterId)
      ? undefined
      : progression.characters.find(
          (candidate) => candidate.characterId === preferredCharacterId,
        );
  const friendSelection: ResolvedCharacterSelection | null =
    preferredCharacterId === null ||
    preferences.selectedAt === null ||
    preferredCharacter === undefined ||
    !preferredCharacter.unlocked
      ? null
      : Object.freeze({
          characterId: preferredCharacterId,
          selectedBy: "manual" as const,
          selectedAt: preferences.selectedAt,
        });

  if (friendSelection === null) return sisterSelection;
  if (sisterSelection === null) return friendSelection;
  // Preference wins an exact legacy tie because old releases wrote it last.
  // New mutations always allocate a strictly increasing millisecond, so ties
  // cannot be created by this implementation.
  return friendSelection.selectedAt >= sisterSelection.selectedAt
    ? friendSelection
    : sisterSelection;
}

function nextSelectionTimestamp(
  now: Date,
  store: LocalProgressionStore,
  preferences: CharacterPreferences,
): string {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("invalid selection clock");
  const persisted = [
    store.selection.manualSelectedAt,
    store.selection.autoStarterSelectedAt,
    preferences.selectedAt,
  ]
    .filter((value): value is string => value !== null)
    .map((value) => Date.parse(value));
  const latestPersistedMs =
    persisted.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...persisted);
  const selectedAtMs = Math.max(nowMs, latestPersistedMs + 1);
  const selectedAt = new Date(selectedAtMs).toISOString();
  if (!isIsoInstant(selectedAt)) throw new Error("invalid selection clock");
  return selectedAt;
}

async function saveSisterSelection(
  store: LocalProgressionStore,
  characterId: SisterId,
  selectedAt: string,
  progressionOptions: Readonly<{ path: string }>,
): Promise<void> {
  const selectedStore = withManualSisterSelection(
    store,
    characterId,
    selectedAt,
  );
  const selectedProgression = evaluateStore(selectedStore, selectedAt);
  const committed = withProgressionEvaluation(
    selectedStore,
    selectedProgression,
  );
  try {
    await saveLocalProgressionStore(committed, progressionOptions);
  } catch (error) {
    // The progression writer uses atomic rename. If a post-rename durability
    // step reports an error, do not tell the player selection failed after the
    // exact requested authority is already durable.
    try {
      const verified = await loadLocalProgressionStore(progressionOptions);
      if (
        verified.store.selection.manualCharacterId === characterId &&
        verified.store.selection.manualSelectedAt === selectedAt
      ) {
        return;
      }
    } catch {
      // Preserve the original failure when the committed state cannot be read.
    }
    throw error;
  }
}

function manifestPath(path: string): string {
  return `/assets/characters/${path}`;
}

function starterPersonaDto(
  characterId: RosterId,
): CompanionCharacter["starterPersona"] {
  if (!isSisterId(characterId)) return null;
  const definition = getCharacterDefinition(characterId);
  return {
    alias: definition.alias,
    taglineZhTw: definition.tagline["zh-TW"],
  };
}

function themeUnlockProgress(
  themeStatus:
    ProgressionState["characters"][number]["themes"][number] | undefined,
): CompanionCharacter["progress"] {
  // Unlocked outfits need no condition; locked ones surface the progression
  // engine's own explanation so the wardrobe shows real local milestones.
  if (themeStatus === undefined || themeStatus.unlocked) return null;
  return {
    value: themeStatus.progress.value,
    explain: themeStatus.progress.explanation,
  };
}

function characterDto(
  characterId: RosterId,
  progression: ProgressionState,
  manifest: AssetManifest | null,
  preferences: CharacterPreferences,
): CompanionCharacter {
  const status = progression.characters.find(
    (character) => character.characterId === characterId,
  )!;
  const assets = manifest?.characters.find(
    (character) => character.characterId === characterId,
  );
  const preferredThemeId = preferences.activeThemeByCharacter[characterId];
  const themeHasActiveAssets = (themeId: WardrobeThemeId): boolean =>
    assets === undefined ||
    assets.themes.some((theme) => theme.themeId === themeId);
  const preferredTheme = status.themes.find(
    (theme) =>
      theme.themeId === preferredThemeId &&
      theme.unlocked &&
      themeHasActiveAssets(theme.themeId),
  );
  const firstUnlockedTheme = status.themes.find(
    (theme) => theme.unlocked && themeHasActiveAssets(theme.themeId),
  );
  const activeThemeId =
    preferredTheme?.themeId ?? firstUnlockedTheme?.themeId ?? null;
  const activeAssetTheme = assets?.themes.find(
    (theme) => theme.themeId === activeThemeId,
  );
  const nextTheme = status.unlocked
    ? status.themes.find((theme) => !theme.unlocked)
    : undefined;
  const progress = !status.unlocked
    ? {
        value: status.progress.value,
        explain: `再累積一點本機用量，就能遇見 ${status.displayName}。`,
      }
    : nextTheme === undefined
      ? null
      : {
          value: nextTheme.progress.value,
          explain: `再累積一點本機用量，就能解鎖 ${status.displayName} 的下一套服裝。`,
        };
  const voice = manifest?.voice.find(
    (entry) => entry.characterId === characterId,
  );
  const starterPersona = starterPersonaDto(characterId);
  const mayShowAvatarWithoutTheme =
    activeThemeId === null &&
    (status.unlocked ||
      (starterPersona !== null && progression.selection === null));

  let visual: CompanionCharacter["visual"];
  // A clean-install starter has no unlocked wardrobe yet, but the reviewed
  // avatar is still the identity shown on the four-choice onboarding sheet.
  if (
    assets === undefined ||
    (!mayShowAvatarWithoutTheme && activeAssetTheme === undefined)
  ) {
    const [glyph, defaultBackground, defaultForeground, defaultAccent] =
      LETTER_VISUALS[characterId];
    const activeLetterTheme = LETTER_WARDROBE_CATALOG.find(
      (theme) => theme.themeId === activeThemeId,
    );
    visual = {
      mode: "letter",
      glyph,
      background: activeLetterTheme?.palette.background ?? defaultBackground,
      foreground: activeLetterTheme?.palette.foreground ?? defaultForeground,
      accent: activeLetterTheme?.palette.accent ?? defaultAccent,
      themes: LETTER_WARDROBE_CATALOG.map((theme) => {
        const themeStatus = status.themes.find(
          (candidate) => candidate.themeId === theme.themeId,
        );
        return {
          themeId: theme.themeId,
          displayName: theme.displayName,
          accessibleLabel: theme.accessibleLabel,
          unlocked: themeStatus?.unlocked ?? false,
          progress: themeUnlockProgress(themeStatus),
          palette: theme.palette,
          pattern: theme.pattern,
          accent: theme.accent,
        };
      }),
    };
  } else {
    visual = {
      mode: "doll",
      avatarPath: manifestPath(assets.avatar.path),
      themes: assets.themes.map((theme) => {
        const themeStatus = status.themes.find(
          (candidate) => candidate.themeId === theme.themeId,
        );
        return {
          themeId: theme.themeId,
          unlocked: themeStatus?.unlocked ?? false,
          progress: themeUnlockProgress(themeStatus),
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
                : manifestPath(theme.poses.victory.path),
          },
        };
      }),
    };
  }

  return {
    characterId,
    displayName: status.displayName,
    kind: starterPersona === null ? "friend" : "sister",
    unlocked: status.unlocked,
    unlockedAt: status.unlockedAt,
    isStarter: starterPersona !== null,
    starterPersona,
    activeThemeId,
    visual,
    progress,
    voiceLines:
      status.unlocked && voice !== undefined
        ? voice.lines.map((line) => ({
            id: line.id,
            trigger: line.trigger,
            path: manifestPath(line.object.path),
            durationMs: line.durationMs,
          }))
        : [],
  };
}

async function readVerifiedCache(
  path: string,
  sha256: string,
): Promise<Buffer | null> {
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

function assetIsUnlocked(
  fileName: string,
  manifest: AssetManifest,
  progression: ProgressionState,
): boolean {
  const objectPath = `objects/${fileName}`;
  for (const characterAssets of manifest.characters) {
    const character = progression.characters.find(
      (candidate) => candidate.characterId === characterAssets.characterId,
    );
    // Starter avatars are selection UI, not wardrobe rewards. Expose only the
    // avatar during the explicit first-choice state; themes remain lock-gated.
    if (
      characterAssets.avatar.path === objectPath &&
      (character?.unlocked === true ||
        (progression.selection === null &&
          isSisterId(characterAssets.characterId)))
    ) {
      return true;
    }
    if (character?.unlocked !== true) continue;
    for (const theme of characterAssets.themes) {
      const themeStatus = character.themes.find(
        (candidate) => candidate.themeId === theme.themeId,
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
      (candidate) => candidate.characterId === voice.characterId,
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

export function createCharacterService(
  options: CharacterServiceOptions,
): CharacterService {
  const { adapter, characters, clock } = options;
  let activeManifest = characters.baseAssets?.manifest ?? characters.manifest;
  const progressionOptions = Object.freeze({
    path: characters.progressionStorePath,
  });
  const preferenceFile = preferencesPath(characters.progressionStorePath);
  const interactionFile = characterInteractionsPath(
    characters.progressionStorePath,
  );
  let lastLedgerSyncStartedAtMs: number | null = null;
  let ledgerSyncInFlight: Promise<void> | null = null;
  let storeMutation = Promise.resolve();
  let preferenceMutation = Promise.resolve();
  let selectionMutation = Promise.resolve();
  let interactionMutation = Promise.resolve();

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

  const serializePreferences = async <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
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

  const serializeInteractions = async <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = interactionMutation;
    let release!: () => void;
    interactionMutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const serializeSelection = async <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = selectionMutation;
    let release!: () => void;
    selectionMutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const loadEvaluated = async (): Promise<
    Readonly<{
      store: LocalProgressionStore;
      progression: ProgressionState;
    }>
  > =>
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
        loaded.store.lifetime.dailyProviderBuckets.map(
          (bucket) => bucket.utcDate,
        ),
      );
      const dates = new Set<string>([today]);
      for (let offset = 0; offset < LEDGER_WINDOW_DAYS; offset += 1) {
        const date = addUtcDays(windowStart, offset);
        if (!existing.has(date)) dates.add(date);
      }
      const lastDate =
        loaded.store.lifetime.dailyProviderBuckets.at(-1)?.utcDate;
      if (lastDate !== undefined && lastDate < today) {
        for (
          let date = addUtcDays(
            lastDate < windowStart ? windowStart : lastDate,
            1,
          );
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
            toUtcDate: utcDate,
          }),
        })),
      );
      const merged = await mergeAndSaveDailyProviderBuckets(
        buckets,
        progressionOptions,
      );
      const progression = evaluateStore(merged.store, instant.toISOString());
      await saveLocalProgressionStore(
        withProgressionEvaluation(merged.store, progression),
        progressionOptions,
      );
    });
  };

  const getStateForAsset = async (): Promise<ProgressionState> =>
    (await loadEvaluated()).progression;

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
      let displayManifest = activeManifest;
      try {
        [progression, preferences] = await Promise.all([
          loadEvaluated().then((state) => state.progression),
          loadPreferences(preferenceFile),
        ]);
      } catch {
        progression = fallbackProgression(generatedAt);
        preferences = emptyPreferences();
        // A progression failure must never reveal the consented full pack or
        // infer prior unlocks. The reviewed built-in starter projection is
        // safe to show with the empty fallback state, though: it exposes only
        // the four onboarding avatars while wardrobe assets remain locked.
        displayManifest = characters.baseAssets?.manifest ?? null;
      }
      const resolvedSelection = resolveCharacterSelection(
        progression,
        preferences,
      );
      const selection =
        resolvedSelection === null
          ? { characterId: null, selectedBy: null }
          : {
              characterId: resolvedSelection.characterId,
              selectedBy: resolvedSelection.selectedBy,
            };
      return {
        status: "ok",
        generatedAt,
        unlockBatchId: progression.unlockBatchId ?? null,
        selection,
        voiceEnabled: true,
        characters: CHARACTER_ROSTER_IDS.map((characterId) =>
          characterDto(characterId, progression, displayManifest, preferences),
        ),
      };
    },

    async selectCharacter(characterId: unknown) {
      if (!isRosterId(characterId)) {
        return Object.freeze({
          status: 400,
          body: { status: "error", error: "invalid-request" },
        });
      }
      try {
        const selectionAllowed = await serializeSelection(() =>
          serializeStore(async () => {
            const loaded = await loadLocalProgressionStore(progressionOptions);
            const evaluatedAt = clock().toISOString();
            const progression = evaluateStore(loaded.store, evaluatedAt);
            return serializePreferences(async () => {
              const preferences = await loadPreferences(preferenceFile);
              const status = progression.characters.find(
                (candidate) => candidate.characterId === characterId,
              );
              const isFirstStarterChoice =
                status?.unlocked === false &&
                resolveCharacterSelection(progression, preferences) === null &&
                isSisterId(characterId);
              if (status?.unlocked !== true && !isFirstStarterChoice) {
                return false;
              }

              const selectedAt = nextSelectionTimestamp(
                clock(),
                loaded.store,
                preferences,
              );
              if (isSisterId(characterId)) {
                await saveSisterSelection(
                  loaded.store,
                  characterId,
                  selectedAt,
                  progressionOptions,
                );
              } else {
                await writeJsonAtomically(preferenceFile, {
                  ...preferences,
                  manualCharacterId: characterId,
                  selectedAt,
                });
              }
              return true;
            });
          }),
        );
        if (!selectionAllowed) {
          return Object.freeze({
            status: 409,
            body: { status: "error", error: "locked" },
          });
        }
        return Object.freeze({
          status: 200,
          body: {
            status: "ok",
            selection: { characterId, selectedBy: "manual" },
          },
        });
      } catch (error) {
        if (isStoreBusyError(error)) {
          return Object.freeze({
            status: 409,
            body: { status: "error", error: "store-busy" },
          });
        }
        return Object.freeze({
          status: 400,
          body: { status: "error", error: "invalid-request" },
        });
      }
    },

    async repairProgressionLock(confirmedOldVersionsClosed: unknown) {
      if (confirmedOldVersionsClosed !== true) {
        return Object.freeze({
          status: 400,
          body: { status: "error", error: "invalid-request" },
        });
      }
      try {
        const outcome = await repairLegacyProgressionStoreLock({
          path: progressionOptions.path,
          confirmedOldVersionsClosed,
        });
        if (outcome === "busy") {
          return Object.freeze({
            status: 409,
            body: { status: "error", error: "store-busy" },
          });
        }
        return Object.freeze({
          status: 200,
          body: { status: "ok", outcome },
        });
      } catch (error) {
        if (isStoreBusyError(error)) {
          return Object.freeze({
            status: 409,
            body: { status: "error", error: "store-busy" },
          });
        }
        return Object.freeze({
          status: 400,
          body: { status: "error", error: "invalid-request" },
        });
      }
    },

    async selectWardrobe(characterId: unknown, themeId: unknown) {
      const parsedThemeId = WardrobeThemeIdSchema.safeParse(themeId);
      if (!isRosterId(characterId) || !parsedThemeId.success) {
        return Object.freeze({
          status: 400,
          body: { status: "error", error: "invalid-request" },
        });
      }
      try {
        const current = await loadEvaluated();
        const character = current.progression.characters.find(
          (candidate) => candidate.characterId === characterId,
        );
        const theme = character?.themes.find(
          (candidate) => candidate.themeId === parsedThemeId.data,
        );
        if (character === undefined || theme === undefined) {
          return Object.freeze({
            status: 400,
            body: { status: "error", error: "invalid-request" },
          });
        }
        if (!character.unlocked || !theme.unlocked) {
          return Object.freeze({
            status: 409,
            body: { status: "error", error: "locked" },
          });
        }
        await serializePreferences(async () => {
          const preferences = await loadPreferences(preferenceFile);
          await writeJsonAtomically(preferenceFile, {
            ...preferences,
            activeThemeByCharacter: {
              ...preferences.activeThemeByCharacter,
              [characterId]: theme.themeId,
            },
          });
        });
        return Object.freeze({
          status: 200,
          body: {
            status: "ok",
            characterId,
            activeThemeId: theme.themeId,
          },
        });
      } catch {
        return Object.freeze({
          status: 400,
          body: { status: "error", error: "invalid-request" },
        });
      }
    },

    async interact(characterId: unknown, action: unknown, locale: unknown) {
      if (
        !isRosterId(characterId) ||
        (action !== "tap" && action !== "idle") ||
        !isSupportedTapLocale(locale)
      ) {
        return Object.freeze({
          status: 400,
          body: { status: "error", error: "invalid-request" },
        });
      }
      try {
        const current = await loadEvaluated();
        const preferences = await serializePreferences(() =>
          loadPreferences(preferenceFile),
        );
        const character = current.progression.characters.find(
          (candidate) => candidate.characterId === characterId,
        );
        if (character?.unlocked !== true) {
          return Object.freeze({
            status: 409,
            body: { status: "error", error: "locked" },
          });
        }
        const selected = resolveCharacterSelection(
          current.progression,
          preferences,
        );
        if (selected?.characterId !== characterId) {
          return Object.freeze({
            status: 409,
            body: { status: "error", error: "not-selected" },
          });
        }

        if (action === "idle") {
          const seed = Math.floor(
            clock().getTime() / CHARACTER_IDLE_LINE_BUCKET_MS,
          );
          let idleLineContext: Readonly<{
            mood: MonsterMood;
            traits: readonly MonsterTrait[];
          }> = Object.freeze({ mood: "unknown", traits: Object.freeze([]) });
          try {
            idleLineContext =
              (await options.getTapLineContext?.()) ?? idleLineContext;
          } catch {
            // A missing or temporarily unreadable profile must never make the
            // local idle chatter unavailable.
          }
          const idleLine = selectTapLine({
            characterId,
            locale,
            seed,
            mood: idleLineContext.mood,
            traits: idleLineContext.traits,
          });
          if (!validTapLine(idleLine.lineId, idleLine.text)) {
            throw new Error("invalid idle line projection");
          }
          const body: CompanionCharacterInteractionResponse = {
            status: "ok",
            action: "idle",
            characterId,
            locale,
            outcome: "line",
            line: Object.freeze({
              lineId: idleLine.lineId,
              text: idleLine.text,
            }),
            cooldownMs: CHARACTER_IDLE_LINE_COOLDOWN_MS,
          };
          return Object.freeze({ status: 200, body: Object.freeze(body) });
        }

        return await serializeInteractions(async () => {
          const now = clock();
          const nowMs = now.getTime();
          const shownAt = now.toISOString();
          const utcDate = shownAt.slice(0, 10);
          const store = await loadInteractionStore(interactionFile, utcDate);
          const previous = store.characters[characterId];
          if (previous !== undefined) {
            const lastShownAtMs = Date.parse(previous.lastShownAt);
            const retryAfterMs =
              previous.dailyCount >= CHARACTER_TAP_DAILY_CAP
                ? nextUtcDateStartMs(utcDate) - nowMs
                : lastShownAtMs + CHARACTER_TAP_COOLDOWN_MS - nowMs;
            if (retryAfterMs > 0) {
              const body: CompanionCharacterInteractionResponse = {
                status: "ok",
                action: "tap",
                characterId,
                locale,
                outcome: "animation-only",
                retryAfterMs: boundedRetryAfterMs(retryAfterMs),
              };
              return Object.freeze({ status: 200, body: Object.freeze(body) });
            }
          }

          const seed = previous?.nextSeed ?? 0;
          let tapLineContext: Readonly<{
            mood: MonsterMood;
            traits: readonly MonsterTrait[];
          }> = Object.freeze({ mood: "unknown", traits: Object.freeze([]) });
          try {
            tapLineContext =
              (await options.getTapLineContext?.()) ?? tapLineContext;
          } catch {
            // A missing or temporarily unreadable profile must never make the
            // local tap interaction unavailable.
          }
          const selected = selectTapLine({
            characterId,
            locale,
            seed,
            mood: tapLineContext.mood,
            traits: tapLineContext.traits,
          });
          if (!validTapLine(selected.lineId, selected.text)) {
            throw new Error("invalid tap line projection");
          }
          const nextSeed = seed === Number.MAX_SAFE_INTEGER ? 0 : seed + 1;
          const nextEntry = Object.freeze({
            lastShownAt: shownAt,
            dailyCount: (previous?.dailyCount ?? 0) + 1,
            nextSeed,
          });
          const nextStore: CharacterInteractionStore = Object.freeze({
            schemaVersion: "1",
            utcDate,
            characters: Object.freeze({
              ...store.characters,
              [characterId]: nextEntry,
            }),
          });
          await writeJsonAtomically(interactionFile, nextStore);
          const body: CompanionCharacterInteractionResponse = {
            status: "ok",
            action: "tap",
            characterId,
            locale,
            outcome: "line",
            line: Object.freeze({
              lineId: selected.lineId,
              text: selected.text,
            }),
            cooldownMs: CHARACTER_TAP_COOLDOWN_MS,
          };
          return Object.freeze({ status: 200, body: Object.freeze(body) });
        });
      } catch {
        return Object.freeze({
          status: 503,
          body: { status: "error", error: "unavailable" },
        });
      }
    },

    async getAsset(fileName: string): Promise<CharacterAssetResult> {
      const match = /^([0-9a-f]{64})\.(webp|png|wav)$/u.exec(fileName);
      const manifest = activeManifest;
      if (match === null || manifest === null) {
        return Object.freeze({ status: 404 });
      }
      const sha256 = match[1]!;
      const objectPath = `objects/${fileName}`;
      const embeddedBody = characters.baseAssets?.readObject(objectPath);
      try {
        let authorizationManifest = manifest;
        let progression: ProgressionState;
        try {
          progression = await getStateForAsset();
        } catch {
          if (embeddedBody === null || characters.baseAssets === null) {
            throw new Error("progression unavailable");
          }
          // Fail closed to the embedded projection. With an empty progression
          // only the four starter-selection avatars pass assetIsUnlocked; the
          // built-in outfits and every full-pack object remain inaccessible.
          authorizationManifest = characters.baseAssets.manifest;
          progression = fallbackProgression(clock().toISOString());
        }
        if (!assetIsUnlocked(fileName, authorizationManifest, progression)) {
          return Object.freeze({ status: 404 });
        }
        const cachePath = join(characters.cacheDirectory, fileName);
        const body =
          embeddedBody ?? (await readVerifiedCache(cachePath, sha256));
        if (body === null) return Object.freeze({ status: 404 });
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
    },

    setManifest(manifest: AssetManifest | null): void {
      activeManifest = manifest === null ? null : parseAssetManifest(manifest);
    },
  });
}

export function normalizeCharacterOptions(
  value: unknown,
): NormalizedCharacterOptions {
  const keys = new Set<PropertyKey>([
    "manifest",
    "baseAssets",
    "assetPack",
    "cacheDirectory",
    "cdnBaseUrl",
    "progressionStorePath",
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
    manifest =
      manifestValue === null ? null : parseAssetManifest(manifestValue);
  } catch {
    throw new Error("invalid character configuration");
  }
  let assetPack: ApprovedAssetPackConfiguration | null;
  try {
    const normalizedAssetPack = normalizeAssetPackConfiguration(
      value["assetPack"],
    );
    assetPack =
      normalizedAssetPack === null
        ? null
        : Object.freeze({
            releaseManifest: normalizedAssetPack.releaseManifest,
            descriptor: normalizedAssetPack.descriptor,
            allowlist: normalizedAssetPack.allowlist,
          });
  } catch {
    throw new Error("invalid character configuration");
  }
  let baseAssets: NormalizedBaseAssets | null;
  try {
    const baseAssetsValue = Reflect.ownKeys(value).includes("baseAssets")
      ? ownDataValue(value, "baseAssets")
      : undefined;
    baseAssets = normalizeBaseAssets(baseAssetsValue);
  } catch {
    throw new Error("invalid character configuration");
  }
  const cacheDirectory = value["cacheDirectory"];
  const progressionStorePath = value["progressionStorePath"];
  if (
    typeof cacheDirectory !== "string" ||
    !isAbsolute(cacheDirectory) ||
    typeof progressionStorePath !== "string" ||
    !isAbsolute(progressionStorePath)
  ) {
    throw new Error("invalid character configuration");
  }
  if (value["cdnBaseUrl"] !== null) {
    throw new Error("invalid character configuration");
  }
  if (manifest !== null && (assetPack !== null || baseAssets !== null)) {
    throw new Error("invalid character configuration");
  }
  return Object.freeze({
    manifest,
    baseAssets,
    assetPack,
    cacheDirectory,
    progressionStorePath,
  });
}
