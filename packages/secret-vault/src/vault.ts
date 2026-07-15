import { constants as fsConstants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  rename,
  unlink
} from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";

import { SecretVaultError } from "./errors.js";
import type {
  AsyncSafeStoragePort,
  EncryptedSecretSlot,
  EncryptedSecretSlotOptions,
  SecretPersistence,
  SecretSlotStatus
} from "./types.js";

const MAX_SECRET_BYTES = 4_096;
const MAX_SECRET_FILE_BYTES = 16_384;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function validSafeStorage(value: unknown): value is AsyncSafeStoragePort {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncSafeStoragePort).isAsyncEncryptionAvailable === "function" &&
    typeof (value as AsyncSafeStoragePort).getSelectedStorageBackend === "function" &&
    typeof (value as AsyncSafeStoragePort).encryptStringAsync === "function" &&
    typeof (value as AsyncSafeStoragePort).decryptStringAsync === "function"
  );
}

function validateConfiguration(options: EncryptedSecretSlotOptions): void {
  if (
    typeof options !== "object" ||
    options === null ||
    !validSafeStorage(options.safeStorage) ||
    typeof options.filePath !== "string" ||
    !isAbsolute(options.filePath) ||
    options.filePath.includes("\0") ||
    typeof options.platform !== "string"
  ) {
    throw new SecretVaultError("invalid-configuration");
  }
}

function validateSecret(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES
  ) {
    throw new SecretVaultError("invalid-secret");
  }
  return value;
}

function normalizeBackend(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 64 ||
    !/^[a-z0-9_-]+$/u.test(value)
  ) {
    return "unknown";
  }
  return value;
}

function persistentBackendAllowed(
  platform: NodeJS.Platform,
  backend: string,
  encryptionAvailable: boolean
): boolean {
  if (!encryptionAvailable) return false;
  if (platform !== "linux") return platform === "darwin" || platform === "win32";
  return ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(
    backend
  );
}

function parseSecretDocument(serialized: string): Uint8Array {
  let input: unknown;
  try {
    input = JSON.parse(serialized) as unknown;
  } catch {
    throw new SecretVaultError("storage-corrupt");
  }
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(input).length !== 2 ||
    !Object.hasOwn(input, "schemaVersion") ||
    !Object.hasOwn(input, "ciphertext")
  ) {
    throw new SecretVaultError("storage-corrupt");
  }
  const record = input as Record<string, unknown>;
  if (
    record["schemaVersion"] !== 1 ||
    typeof record["ciphertext"] !== "string" ||
    record["ciphertext"].length === 0 ||
    record["ciphertext"].length > MAX_SECRET_FILE_BYTES ||
    !BASE64_PATTERN.test(record["ciphertext"])
  ) {
    throw new SecretVaultError("storage-corrupt");
  }
  const bytes = Buffer.from(record["ciphertext"], "base64");
  if (bytes.length === 0 || bytes.length > MAX_SECRET_FILE_BYTES) {
    throw new SecretVaultError("storage-corrupt");
  }
  return bytes;
}

async function readSecretFile(filePath: string): Promise<Uint8Array | null> {
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new SecretVaultError("storage-corrupt");
    }
    throw new SecretVaultError("storage-failed");
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > MAX_SECRET_FILE_BYTES
    ) {
      throw new SecretVaultError("storage-corrupt");
    }
    await handle.chmod(0o600);
    return parseSecretDocument(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof SecretVaultError) throw error;
    throw new SecretVaultError("storage-failed");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeSecretFile(
  filePath: string,
  ciphertext: Uint8Array
): Promise<void> {
  if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength < 1) {
    throw new SecretVaultError("storage-failed");
  }
  const directory = dirname(filePath);
  const temporaryPath = `${filePath}.${randomBytes(12).toString("hex")}.tmp`;
  let handle;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600
    );
    const serialized = JSON.stringify({
      schemaVersion: 1,
      ciphertext: Buffer.from(ciphertext).toString("base64")
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SECRET_FILE_BYTES) {
      throw new SecretVaultError("storage-failed");
    }
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
    if (error instanceof SecretVaultError) throw error;
    throw new SecretVaultError("storage-failed");
  }
}

async function removeSecretFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SecretVaultError("storage-failed");
    }
  }
}

export function createEncryptedSecretSlot(
  options: EncryptedSecretSlotOptions
): EncryptedSecretSlot {
  validateConfiguration(options);
  let secret: string | null = null;
  let persistence: SecretPersistence = "memory-only";
  let backend = "unknown";
  let initialized = false;
  let loaded = false;
  let pending: Promise<void> = Promise.resolve();

  const snapshot = (): SecretSlotStatus =>
    Object.freeze({ configured: secret !== null, persistence, backend });

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation, operation);
    pending = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  const initializePolicy = async (): Promise<void> => {
    if (initialized) return;
    let available = false;
    try {
      backend = normalizeBackend(options.safeStorage.getSelectedStorageBackend());
      available = await options.safeStorage.isAsyncEncryptionAvailable();
    } catch {
      backend = "unknown";
    }
    persistence = persistentBackendAllowed(options.platform, backend, available)
      ? "os-backed"
      : "memory-only";
    initialized = true;
  };

  const initialize = (): Promise<SecretSlotStatus> =>
    enqueue(async () => {
      await initializePolicy();
      if (loaded) return snapshot();
      if (persistence !== "os-backed") {
        await removeSecretFile(options.filePath);
        loaded = true;
        return snapshot();
      }
      const ciphertext = await readSecretFile(options.filePath);
      if (ciphertext === null) {
        loaded = true;
        return snapshot();
      }
      let decrypted: Readonly<{ result: string; shouldReEncrypt: boolean }>;
      try {
        decrypted = await options.safeStorage.decryptStringAsync(ciphertext);
      } catch {
        throw new SecretVaultError("storage-corrupt");
      }
      if (
        typeof decrypted !== "object" ||
        decrypted === null ||
        typeof decrypted.shouldReEncrypt !== "boolean"
      ) {
        throw new SecretVaultError("storage-corrupt");
      }
      try {
        secret = validateSecret(decrypted.result);
      } catch {
        throw new SecretVaultError("storage-corrupt");
      }
      if (decrypted.shouldReEncrypt) {
        let freshCiphertext: Uint8Array;
        try {
          freshCiphertext = await options.safeStorage.encryptStringAsync(secret);
        } catch {
          throw new SecretVaultError("storage-failed");
        }
        await writeSecretFile(options.filePath, freshCiphertext);
      }
      loaded = true;
      return snapshot();
    });

  const set = (
    input: string,
    setOptions: Readonly<{ persist?: boolean }> = {}
  ): Promise<SecretSlotStatus> =>
    enqueue(async () => {
      const validated = validateSecret(input);
      if (
        typeof setOptions !== "object" ||
        setOptions === null ||
        Reflect.ownKeys(setOptions).some((key) => key !== "persist") ||
        (setOptions.persist !== undefined && typeof setOptions.persist !== "boolean")
      ) {
        throw new SecretVaultError("invalid-configuration");
      }
      await initializePolicy();
      secret = validated;
      loaded = true;
      if (setOptions.persist === false || persistence !== "os-backed") {
        await removeSecretFile(options.filePath);
        return snapshot();
      }
      try {
        const ciphertext = await options.safeStorage.encryptStringAsync(validated);
        await writeSecretFile(options.filePath, ciphertext);
      } catch {
        secret = null;
        await removeSecretFile(options.filePath).catch(() => undefined);
        throw new SecretVaultError("storage-failed");
      }
      return snapshot();
    });

  const clear = (): Promise<SecretSlotStatus> =>
    enqueue(async () => {
      secret = null;
      loaded = true;
      await removeSecretFile(options.filePath);
      return snapshot();
    });

  return Object.freeze({
    initialize,
    set,
    get: () => secret,
    clear,
    status: snapshot
  });
}
