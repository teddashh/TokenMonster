import { constants as fsConstants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  rename,
  unlink
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
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
const FILE_OPERATION_TAILS = new Map<string, Promise<void>>();

class AtomicWriteError extends Error {
  public override readonly name = "AtomicWriteError";

  public constructor(public readonly renamed: boolean) {
    super("Atomic secret write failed.");
  }
}

function enqueueFileOperation<T>(
  filePath: string,
  operation: () => Promise<T>
): Promise<T> {
  // Lexical normalization makes equivalent absolute spellings share one local
  // authority without following a possibly hostile secret-file symlink.
  const authorityPath = resolve(filePath);
  const previous = FILE_OPERATION_TAILS.get(authorityPath) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  FILE_OPERATION_TAILS.set(authorityPath, tail);
  void tail.then(() => {
    if (FILE_OPERATION_TAILS.get(authorityPath) === tail) {
      FILE_OPERATION_TAILS.delete(authorityPath);
    }
  });
  return result;
}

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

function normalizeSetOptions(value: unknown): Readonly<{
  persist: boolean | undefined;
  signal: AbortSignal | undefined;
}> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(value) as object | null
    ) ||
    Reflect.ownKeys(value).some(
      (key) => key !== "persist" && key !== "signal"
    )
  ) {
    throw new SecretVaultError("invalid-configuration");
  }
  const persistDescriptor = Object.getOwnPropertyDescriptor(value, "persist");
  const signalDescriptor = Object.getOwnPropertyDescriptor(value, "signal");
  if (
    (persistDescriptor !== undefined &&
      (!("value" in persistDescriptor) ||
        typeof persistDescriptor.value !== "boolean")) ||
    (signalDescriptor !== undefined &&
      (!("value" in signalDescriptor) ||
        !(signalDescriptor.value instanceof AbortSignal)))
  ) {
    throw new SecretVaultError("invalid-configuration");
  }
  return Object.freeze({
    persist:
      persistDescriptor === undefined
        ? undefined
        : (persistDescriptor.value as boolean),
    signal:
      signalDescriptor === undefined
        ? undefined
        : (signalDescriptor.value as AbortSignal)
  });
}

function normalizeInitializeOptions(value: unknown): AbortSignal | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(value) as object | null
    ) ||
    Reflect.ownKeys(value).some((key) => key !== "signal")
  ) {
    throw new SecretVaultError("invalid-configuration");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "signal");
  if (
    descriptor !== undefined &&
    (!("value" in descriptor) || !(descriptor.value instanceof AbortSignal))
  ) {
    throw new SecretVaultError("invalid-configuration");
  }
  return descriptor === undefined
    ? undefined
    : (descriptor.value as AbortSignal);
}

function normalizeClearOptions(value: unknown): AbortSignal | undefined {
  return normalizeInitializeOptions(value);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new SecretVaultError("storage-failed");
  }
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

function parseSecretDocument(serialized: Uint8Array): Uint8Array {
  let input: unknown;
  try {
    input = JSON.parse(Buffer.from(serialized).toString("utf8")) as unknown;
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

async function readStoredSecretFile(
  filePath: string,
  signal: AbortSignal | undefined = undefined
): Promise<Uint8Array | null> {
  assertNotAborted(signal);
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
    const serialized = await handle.readFile(
      signal === undefined ? undefined : { signal }
    );
    assertNotAborted(signal);
    return serialized;
  } catch (error) {
    if (error instanceof SecretVaultError) throw error;
    throw new SecretVaultError("storage-failed");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readSecretFile(
  filePath: string,
  signal: AbortSignal | undefined = undefined
): Promise<Readonly<{ serialized: Uint8Array; ciphertext: Uint8Array }> | null> {
  const serialized = await readStoredSecretFile(filePath, signal);
  return serialized === null
    ? null
    : Object.freeze({
        serialized,
        ciphertext: parseSecretDocument(serialized)
      });
}

function directorySyncUnsupported(
  error: unknown,
  platform: NodeJS.Platform
): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (
    code === "EINVAL" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "ENOSYS"
  ) {
    return true;
  }
  return (
    platform === "win32" &&
    (code === "EISDIR" || code === "EPERM")
  );
}

async function syncDirectory(
  directory: string,
  platform: NodeJS.Platform
): Promise<void> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error, platform)) {
      throw new SecretVaultError("storage-failed");
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function serializeSecretDocument(ciphertext: Uint8Array): Uint8Array {
  if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength < 1) {
    throw new SecretVaultError("storage-failed");
  }
  const serialized = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      ciphertext: Buffer.from(ciphertext).toString("base64")
    }),
    "utf8"
  );
  if (serialized.byteLength > MAX_SECRET_FILE_BYTES) {
    throw new SecretVaultError("storage-failed");
  }
  return serialized;
}

async function writeDocumentAtomically(
  filePath: string,
  serialized: Uint8Array,
  platform: NodeJS.Platform,
  signal: AbortSignal | undefined
): Promise<void> {
  if (
    !(serialized instanceof Uint8Array) ||
    serialized.byteLength < 1 ||
    serialized.byteLength > MAX_SECRET_FILE_BYTES
  ) {
    throw new SecretVaultError("storage-failed");
  }
  assertNotAborted(signal);
  const directory = dirname(filePath);
  const temporaryPath = `${filePath}.${randomBytes(12).toString("hex")}.tmp`;
  let handle;
  let renamed = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    assertNotAborted(signal);
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600
    );
    await handle.writeFile(
      serialized,
      signal === undefined ? undefined : { signal }
    );
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    assertNotAborted(signal);
    await rename(temporaryPath, filePath);
    renamed = true;
    await syncDirectory(directory, platform);
    assertNotAborted(signal);
  } catch {
    await handle?.close().catch(() => undefined);
    const removedTemporary = await unlink(temporaryPath).then(
      () => true,
      () => false
    );
    if (removedTemporary) {
      await syncDirectory(directory, platform).catch(() => undefined);
    }
    throw new AtomicWriteError(renamed);
  }
}

async function restoreSecretFile(
  filePath: string,
  previous: Uint8Array | null,
  platform: NodeJS.Platform
): Promise<void> {
  if (previous === null) {
    const removed = await unlink(filePath).then(
      () => true,
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    );
    if (!removed) throw new SecretVaultError("storage-failed");
    await syncDirectory(dirname(filePath), platform);
    return;
  }
  await writeDocumentAtomically(filePath, previous, platform, undefined);
}

async function writeSecretFile(
  filePath: string,
  ciphertext: Uint8Array,
  platform: NodeJS.Platform,
  signal: AbortSignal | undefined
): Promise<void> {
  const serialized = serializeSecretDocument(ciphertext);
  const previous = await readStoredSecretFile(filePath, signal);
  try {
    await writeDocumentAtomically(filePath, serialized, platform, signal);
  } catch (error) {
    if (error instanceof AtomicWriteError && error.renamed) {
      await restoreSecretFile(filePath, previous, platform).catch(
        () => undefined
      );
    }
    throw new SecretVaultError("storage-failed");
  }
}

async function removeSecretFile(
  filePath: string,
  platform: NodeJS.Platform,
  signal: AbortSignal | undefined
): Promise<void> {
  assertNotAborted(signal);
  const previous = await readStoredSecretFile(filePath, signal);
  if (previous === null) return;
  assertNotAborted(signal);
  let unlinked = false;
  try {
    await unlink(filePath);
    unlinked = true;
    await syncDirectory(dirname(filePath), platform);
    assertNotAborted(signal);
  } catch (error) {
    if (unlinked) {
      await restoreSecretFile(filePath, previous, platform).catch(
        () => undefined
      );
    }
    throw new SecretVaultError("storage-failed");
  }
}

export function createEncryptedSecretSlot(
  options: EncryptedSecretSlotOptions
): EncryptedSecretSlot {
  validateConfiguration(options);
  let secret: string | null = null;
  let persistence: SecretPersistence = "memory-only";
  let activePersistence: SecretPersistence = "memory-only";
  let backend = "unknown";
  let initialized = false;
  let loaded = false;

  const snapshot = (): SecretSlotStatus =>
    Object.freeze({
      configured: secret !== null,
      persistence,
      activePersistence,
      backend
    });

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> =>
    enqueueFileOperation(options.filePath, operation);

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

  const initialize = (
    initializeOptions: Readonly<{ signal?: AbortSignal }> = {}
  ): Promise<SecretSlotStatus> =>
    enqueue(async () => {
      const signal = normalizeInitializeOptions(initializeOptions);
      assertNotAborted(signal);
      await initializePolicy();
      assertNotAborted(signal);
      if (loaded) return snapshot();
      if (persistence !== "os-backed") {
        activePersistence = "memory-only";
        loaded = true;
        return snapshot();
      }
      const document = await readSecretFile(options.filePath, signal);
      assertNotAborted(signal);
      if (document === null) {
        activePersistence = "memory-only";
        loaded = true;
        return snapshot();
      }
      let decrypted: Readonly<{ result: string; shouldReEncrypt: boolean }>;
      try {
        decrypted = await options.safeStorage.decryptStringAsync(
          document.ciphertext
        );
      } catch {
        throw new SecretVaultError("storage-corrupt");
      }
      assertNotAborted(signal);
      if (
        typeof decrypted !== "object" ||
        decrypted === null ||
        typeof decrypted.shouldReEncrypt !== "boolean"
      ) {
        throw new SecretVaultError("storage-corrupt");
      }
      let decryptedSecret: string;
      try {
        decryptedSecret = validateSecret(decrypted.result);
      } catch {
        throw new SecretVaultError("storage-corrupt");
      }
      if (decrypted.shouldReEncrypt) {
        let freshCiphertext: Uint8Array;
        try {
          freshCiphertext =
            await options.safeStorage.encryptStringAsync(decryptedSecret);
          assertNotAborted(signal);
          await writeSecretFile(
            options.filePath,
            freshCiphertext,
            options.platform,
            signal
          );
          assertNotAborted(signal);
        } catch {
          // The old ciphertext is still the conservative disk authority when
          // rotation cannot commit. Do not make the already-decrypted value
          // readable from this process after initialization reports failure.
          secret = null;
          activePersistence = "memory-only";
          throw new SecretVaultError("storage-failed");
        }
      }
      secret = decryptedSecret;
      activePersistence = "os-backed";
      loaded = true;
      return snapshot();
    });

  const set = (
    input: string,
    setOptions: Readonly<{ persist?: boolean; signal?: AbortSignal }> = {}
  ): Promise<SecretSlotStatus> =>
    enqueue(async () => {
      const validated = validateSecret(input);
      const normalizedSetOptions = normalizeSetOptions(setOptions);
      assertNotAborted(normalizedSetOptions.signal);
      await initializePolicy();
      assertNotAborted(normalizedSetOptions.signal);
      if (normalizedSetOptions.persist === false) {
        await removeSecretFile(
          options.filePath,
          options.platform,
          normalizedSetOptions.signal
        );
        assertNotAborted(normalizedSetOptions.signal);
        secret = validated;
        activePersistence = "memory-only";
        loaded = true;
        return snapshot();
      }
      if (persistence !== "os-backed") {
        secret = validated;
        activePersistence = "memory-only";
        loaded = true;
        return snapshot();
      }
      try {
        const ciphertext = await options.safeStorage.encryptStringAsync(validated);
        assertNotAborted(normalizedSetOptions.signal);
        await writeSecretFile(
          options.filePath,
          ciphertext,
          options.platform,
          normalizedSetOptions.signal
        );
        assertNotAborted(normalizedSetOptions.signal);
        secret = validated;
        activePersistence = "os-backed";
        loaded = true;
      } catch {
        secret = null;
        activePersistence = "memory-only";
        loaded = true;
        throw new SecretVaultError("storage-failed");
      }
      return snapshot();
    });

  const clear = (
    clearOptions: Readonly<{ signal?: AbortSignal }> = {}
  ): Promise<SecretSlotStatus> =>
    enqueue(async () => {
      const signal = normalizeClearOptions(clearOptions);
      assertNotAborted(signal);
      await removeSecretFile(options.filePath, options.platform, signal);
      assertNotAborted(signal);
      secret = null;
      activePersistence = "memory-only";
      loaded = true;
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
