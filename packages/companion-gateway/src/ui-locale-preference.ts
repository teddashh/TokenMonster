import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const UI_LOCALE_PREFERENCE_FILE = "ui-locale-preference.json";
export const UI_LOCALES = Object.freeze(["zh-TW", "en"] as const);
export type UiLocale = (typeof UI_LOCALES)[number];

export interface UiLocalePreference {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly locale: UiLocale;
}

export type UiLocalePreferenceErrorCode =
  | "revision-conflict"
  | "storage-unavailable";

export class UiLocalePreferenceError extends Error {
  public constructor(public readonly code: UiLocalePreferenceErrorCode) {
    super(code);
    this.name = "UiLocalePreferenceError";
  }
}

const DEFAULT_PREFERENCE: UiLocalePreference = Object.freeze({
  schemaVersion: 1,
  revision: 0,
  locale: "zh-TW",
});
const MAX_PREFERENCE_BYTES = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
}

export function isUiLocale(value: unknown): value is UiLocale {
  return value === "zh-TW" || value === "en";
}

export function parseUiLocalePreference(value: unknown): UiLocalePreference {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "revision", "locale"]) ||
    value["schemaVersion"] !== 1 ||
    !Number.isSafeInteger(value["revision"]) ||
    (value["revision"] as number) < 0 ||
    !isUiLocale(value["locale"])
  ) {
    throw new UiLocalePreferenceError("storage-unavailable");
  }
  return Object.freeze({
    schemaVersion: 1,
    revision: value["revision"] as number,
    locale: value["locale"],
  });
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

const VERIFIED_READ_FLAGS =
  constants.O_RDONLY |
  (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0));

function isPrivateMetadata(metadata: Stats): boolean {
  if (process.platform === "win32") return true;
  const getUid = process.getuid;
  return (
    typeof getUid === "function" &&
    metadata.uid === getUid() &&
    (Number(metadata.mode) & 0o077) === 0
  );
}

function isPrivateRegularFile(metadata: Stats): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1 &&
    isPrivateMetadata(metadata)
  );
}

function hasSameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openVerifiedPrivateFile(
  path: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  // O_NOFOLLOW is authoritative on POSIX. Windows does not support that flag
  // consistently, so the lstat/handle identity comparison is also required.
  const pathMetadata = await lstat(path);
  if (!isPrivateRegularFile(pathMetadata)) {
    throw new UiLocalePreferenceError("storage-unavailable");
  }
  const handle = await open(path, VERIFIED_READ_FLAGS);
  try {
    const handleMetadata = await handle.stat();
    if (
      !isPrivateRegularFile(handleMetadata) ||
      !hasSameIdentity(pathMetadata, handleMetadata)
    ) {
      throw new UiLocalePreferenceError("storage-unavailable");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !isPrivateMetadata(metadata)
  ) {
    throw new UiLocalePreferenceError("storage-unavailable");
  }
}

export function uiLocalePreferencePath(progressionStorePath: string): string {
  return join(dirname(progressionStorePath), UI_LOCALE_PREFERENCE_FILE);
}

export async function loadUiLocalePreference(
  path: string,
): Promise<UiLocalePreference> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    await assertPrivateDirectory(dirname(path));
    handle = await openVerifiedPrivateFile(path);
    const metadata = await handle.stat();
    if (metadata.size < 2 || metadata.size > MAX_PREFERENCE_BYTES) {
      throw new UiLocalePreferenceError("storage-unavailable");
    }
    const raw = await handle.readFile("utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_PREFERENCE_BYTES) {
      throw new UiLocalePreferenceError("storage-unavailable");
    }
    const parsed = parseUiLocalePreference(JSON.parse(raw) as unknown);
    if (raw !== `${JSON.stringify(parsed)}\n`) {
      throw new UiLocalePreferenceError("storage-unavailable");
    }
    return parsed;
  } catch (error) {
    if (isMissingFile(error)) {
      // A missing preference file is safe only when its derived parent is a
      // real private directory. If the runtime has not created that directory
      // yet, reads retain the default while mutations still fail closed.
      try {
        await assertPrivateDirectory(dirname(path));
      } catch (directoryError) {
        if (!isMissingFile(directoryError)) {
          throw new UiLocalePreferenceError("storage-unavailable");
        }
      }
      return DEFAULT_PREFERENCE;
    }
    if (error instanceof UiLocalePreferenceError) throw error;
    throw new UiLocalePreferenceError("storage-unavailable");
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

async function writeUiLocalePreferenceAtomically(
  path: string,
  preference: UiLocalePreference,
): Promise<void> {
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let createdIdentity: Readonly<{ device: number; inode: number }> | null = null;
  let renamed = false;
  try {
    // The shared CLI/Electron runtime lease creates and validates this private
    // progression directory before the gateway starts. Never recursively
    // create it here: doing so could traverse a replaced ancestor symlink.
    await assertPrivateDirectory(directory);
    handle = await open(temporary, "wx", 0o600);
    await handle.chmod(0o600);
    const createdMetadata = await handle.stat();
    if (!isPrivateRegularFile(createdMetadata)) {
      throw new UiLocalePreferenceError("storage-unavailable");
    }
    createdIdentity = Object.freeze({
      device: createdMetadata.dev,
      inode: createdMetadata.ino,
    });
    await handle.writeFile(`${JSON.stringify(preference)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    renamed = true;
    const finalHandle = await openVerifiedPrivateFile(path);
    try {
      const metadata = await finalHandle.stat();
      if (
        createdIdentity === null ||
        metadata.dev !== createdIdentity.device ||
        metadata.ino !== createdIdentity.inode
      ) {
        throw new UiLocalePreferenceError("storage-unavailable");
      }
    } finally {
      await finalHandle.close().catch(() => undefined);
    }
    const directoryHandle = await open(directory, "r").catch(() => null);
    if (directoryHandle !== null) {
      await directoryHandle.sync().catch(() => undefined);
      await directoryHandle.close().catch(() => undefined);
    }
  } catch {
    throw new UiLocalePreferenceError("storage-unavailable");
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function saveUiLocalePreference(
  path: string,
  locale: UiLocale,
  expectedRevision: number,
): Promise<UiLocalePreference> {
  // The one user-scoped runtime lease prevents CLI and Electron from owning
  // this directory concurrently. The gateway additionally serializes calls
  // within that owner, so this read/rename CAS has one writer authority.
  const current = await loadUiLocalePreference(path);
  // A response-lost retry is successful even when it carries the old revision.
  if (current.locale === locale) return current;
  if (current.revision !== expectedRevision) {
    throw new UiLocalePreferenceError("revision-conflict");
  }
  if (current.revision === Number.MAX_SAFE_INTEGER) {
    throw new UiLocalePreferenceError("storage-unavailable");
  }
  const next = Object.freeze({
    schemaVersion: 1 as const,
    revision: current.revision + 1,
    locale,
  });
  await writeUiLocalePreferenceAtomically(path, next);
  return next;
}
