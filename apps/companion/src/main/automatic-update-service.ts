import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import type { AutomaticUpdateController } from "./automatic-update-controller.js";
import { ensurePrivateChildDirectory } from "./private-directory.js";
import {
  isAutomaticUpdateRevision,
  parseAutomaticUpdatePreferenceRequest,
  parseAutomaticUpdateServiceStatus,
  type AutomaticUpdatePreferenceMutationResult,
  type AutomaticUpdateServiceCommandResult,
  type AutomaticUpdateServiceStatus,
} from "../shared/automatic-updates.js";

const STORE_SCHEMA_VERSION = "1" as const;
const MAX_STORE_BYTES = 4 * 1_024;
const MAX_REVISION = 18_446_744_073_709_551_615n;

interface AutomaticUpdatePreferenceStore {
  readonly schemaVersion: typeof STORE_SCHEMA_VERSION;
  readonly revision: string;
  readonly automaticChecksEnabled: boolean;
}

export interface AutomaticUpdateServiceOptions {
  readonly path: string;
  readonly createController: (
    automaticChecksEnabled: boolean,
  ) => AutomaticUpdateController;
}

export interface AutomaticUpdateService {
  status(): AutomaticUpdateServiceStatus;
  updatePreference(input: unknown): Promise<AutomaticUpdatePreferenceMutationResult>;
  checkNow(): AutomaticUpdateServiceCommandResult;
  quitAndInstall(): AutomaticUpdateServiceCommandResult;
  dispose(): void;
}

function defaultStore(): AutomaticUpdatePreferenceStore {
  return Object.freeze({
    schemaVersion: STORE_SCHEMA_VERSION,
    revision: "0",
    automaticChecksEnabled: false,
  });
}

function ownRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => !expectedKeys.includes(key))
  ) {
    return null;
  }
  return record;
}

function parseStore(input: unknown): AutomaticUpdatePreferenceStore {
  const record = ownRecord(input, [
    "schemaVersion",
    "revision",
    "automaticChecksEnabled",
  ]);
  if (
    record === null ||
    record["schemaVersion"] !== STORE_SCHEMA_VERSION ||
    !isAutomaticUpdateRevision(record["revision"]) ||
    typeof record["automaticChecksEnabled"] !== "boolean"
  ) {
    throw new TypeError("AUTOMATIC_UPDATE_STORAGE_UNAVAILABLE");
  }
  return Object.freeze({
    schemaVersion: STORE_SCHEMA_VERSION,
    revision: record["revision"],
    automaticChecksEnabled: record["automaticChecksEnabled"],
  });
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  if (
    (await ensurePrivateChildDirectory(parent, [basename(path)])) !== path
  ) {
    throw new Error("AUTOMATIC_UPDATE_STORAGE_UNAVAILABLE");
  }
}

async function atomicWriteStore(
  path: string,
  store: AutomaticUpdatePreferenceStore,
): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporaryPath = join(
    directory,
    `.${randomBytes(16).toString("hex")}.automatic-update.tmp`,
  );
  const body = `${JSON.stringify(store)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_STORE_BYTES) {
    throw new Error("AUTOMATIC_UPDATE_STORAGE_UNAVAILABLE");
  }
  const file = await open(temporaryPath, "wx", 0o600);
  let renamed = false;
  try {
    await file.writeFile(body, "utf8");
    await file.sync();
    await file.close();
    await rename(temporaryPath, path);
    renamed = true;
  } finally {
    await file.close().catch(() => undefined);
    if (!renamed) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

async function loadOrCreateStore(
  path: string,
): Promise<AutomaticUpdatePreferenceStore> {
  if (!isAbsolute(path)) {
    throw new Error("AUTOMATIC_UPDATE_STORAGE_UNAVAILABLE");
  }
  await ensurePrivateDirectory(dirname(path));
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 2 ||
      metadata.size > MAX_STORE_BYTES
    ) {
      throw new Error("AUTOMATIC_UPDATE_STORAGE_UNAVAILABLE");
    }
    await chmod(path, 0o600);
    const body = await readFile(path, "utf8");
    const store = parseStore(JSON.parse(body) as unknown);
    if (body !== `${JSON.stringify(store)}\n`) {
      throw new Error("AUTOMATIC_UPDATE_STORAGE_UNAVAILABLE");
    }
    return store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const store = defaultStore();
    await atomicWriteStore(path, store);
    return store;
  }
}

function nextRevision(revision: string): string {
  const next = BigInt(revision) + 1n;
  if (next > MAX_REVISION) {
    throw new Error("AUTOMATIC_UPDATE_STORAGE_UNAVAILABLE");
  }
  return next.toString(10);
}

export async function createAutomaticUpdateService(
  options: AutomaticUpdateServiceOptions,
): Promise<AutomaticUpdateService> {
  let preferenceStorage: "ready" | "unavailable" = "ready";
  let store: AutomaticUpdatePreferenceStore;
  try {
    store = await loadOrCreateStore(options.path);
  } catch {
    preferenceStorage = "unavailable";
    store = defaultStore();
  }
  const controller = options.createController(store.automaticChecksEnabled);
  let disposed = false;
  let persistence = Promise.resolve();

  const status = (): AutomaticUpdateServiceStatus =>
    parseAutomaticUpdateServiceStatus({
      contractVersion: 1,
      revision: store.revision,
      preferenceStorage,
      automaticChecksEnabled:
        preferenceStorage === "ready" && store.automaticChecksEnabled,
      update: controller.status(),
    });

  const commandResult = (
    result: ReturnType<AutomaticUpdateController["checkNow"]>,
  ): AutomaticUpdateServiceCommandResult =>
    Object.freeze({
      ok: result.ok,
      code: result.code,
      status: status(),
    });

  const disposedCommand = (): AutomaticUpdateServiceCommandResult =>
    Object.freeze({ ok: false, code: "disposed", status: status() });

  return Object.freeze({
    status,
    updatePreference(
      input: unknown,
    ): Promise<AutomaticUpdatePreferenceMutationResult> {
      const operation = async (): Promise<AutomaticUpdatePreferenceMutationResult> => {
        if (disposed) {
          return Object.freeze({ ok: false, error: "disposed", status: status() });
        }
        let request;
        try {
          request = parseAutomaticUpdatePreferenceRequest(input);
        } catch {
          return Object.freeze({
            ok: false,
            error: "invalid-request",
            status: status(),
          });
        }
        if (preferenceStorage !== "ready") {
          return Object.freeze({
            ok: false,
            error: "storage-unavailable",
            status: status(),
          });
        }
        if (request.expectedRevision !== store.revision) {
          return Object.freeze({
            ok: false,
            error: "conflict",
            status: status(),
          });
        }
        if (
          request.automaticChecksEnabled === store.automaticChecksEnabled
        ) {
          return Object.freeze({ ok: true, status: status() });
        }
        let next: AutomaticUpdatePreferenceStore;
        try {
          next = Object.freeze({
            schemaVersion: STORE_SCHEMA_VERSION,
            revision: nextRevision(store.revision),
            automaticChecksEnabled: request.automaticChecksEnabled,
          });
          await atomicWriteStore(options.path, next);
        } catch {
          preferenceStorage = "unavailable";
          store = defaultStore();
          controller.setAutomaticChecksEnabled(false);
          return Object.freeze({
            ok: false,
            error: "storage-unavailable",
            status: status(),
          });
        }
        store = next;
        controller.setAutomaticChecksEnabled(next.automaticChecksEnabled);
        return Object.freeze({ ok: true, status: status() });
      };
      const result = persistence.catch(() => undefined).then(operation);
      persistence = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    checkNow(): AutomaticUpdateServiceCommandResult {
      return disposed ? disposedCommand() : commandResult(controller.checkNow());
    },
    quitAndInstall(): AutomaticUpdateServiceCommandResult {
      return disposed
        ? disposedCommand()
        : commandResult(controller.quitAndInstall());
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      controller.dispose();
    },
  });
}
