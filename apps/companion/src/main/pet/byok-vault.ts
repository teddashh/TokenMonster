import { Buffer } from "node:buffer";
import { join } from "node:path";

import {
  createEncryptedSecretSlot,
  type AsyncSafeStoragePort,
  type EncryptedSecretSlot
} from "@tokenmonster/secret-vault";

import { ensurePrivateChildDirectory } from "../private-directory.js";

export const PET_BYOK_SECRET_FILE = "openai-byok.json";
export const PET_BYOK_INITIALIZATION_TIMEOUT_MS = 5_000;

function initializeWithinDeadline(
  operation: Promise<EncryptedSecretSlot | null>,
  controller: AbortController
): Promise<EncryptedSecretSlot | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: EncryptedSecretSlot | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish(null);
    const timer = setTimeout(() => {
      controller.abort();
      finish(null);
    }, PET_BYOK_INITIALIZATION_TIMEOUT_MS);
    timer.unref?.();
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (slot) => finish(slot),
      () => finish(null)
    );
  });
}

export interface ElectronAsyncSafeStorageBridge {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  getSelectedStorageBackend(): string;
  encryptStringAsync(plainText: string): Promise<Uint8Array>;
  decryptStringAsync(
    encrypted: Buffer
  ): Promise<Readonly<{ result: string; shouldReEncrypt: boolean }>>;
}

export interface PetByokSecretSlotOptions {
  readonly userDataDirectory: string;
  readonly safeStorage: AsyncSafeStoragePort;
  readonly platform: NodeJS.Platform;
  readonly signal?: AbortSignal;
}

export interface PetByokSecretSlotStartup {
  readonly result: Promise<EncryptedSecretSlot | null>;
  abort(): void;
  quiesce(): Promise<void>;
}

export function createElectronAsyncSafeStoragePort(
  bridge: ElectronAsyncSafeStorageBridge
): AsyncSafeStoragePort {
  return Object.freeze({
    isAsyncEncryptionAvailable: () => bridge.isAsyncEncryptionAvailable(),
    getSelectedStorageBackend: () => bridge.getSelectedStorageBackend(),
    encryptStringAsync: async (plainText: string) =>
      new Uint8Array(await bridge.encryptStringAsync(plainText)),
    decryptStringAsync: async (encrypted: Uint8Array) => {
      const decrypted = await bridge.decryptStringAsync(Buffer.from(encrypted));
      return Object.freeze({
        result: decrypted.result,
        shouldReEncrypt: decrypted.shouldReEncrypt
      });
    }
  });
}

/**
 * Starts the default pet's legacy-compatible OpenAI slot without making BYOK
 * a startup dependency. The handle keeps raw work joinable after its bounded
 * public result returns null or shutdown aborts the attempt.
 */
export function startPetByokSecretSlot(
  options: PetByokSecretSlotOptions
): PetByokSecretSlotStartup {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  if (options.signal?.aborted === true) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const operation = (async (): Promise<EncryptedSecretSlot | null> => {
    if (controller.signal.aborted) return null;
    const secretsDirectory = await ensurePrivateChildDirectory(
      options.userDataDirectory,
      ["secrets"]
    );
    if (secretsDirectory === null) return null;
    if (controller.signal.aborted) return null;

    const backend = options.safeStorage.getSelectedStorageBackend();
    const encryptionAvailable =
      await options.safeStorage.isAsyncEncryptionAvailable();
    if (controller.signal.aborted) return null;
    if (
      typeof backend !== "string" ||
      backend.length === 0 ||
      typeof encryptionAvailable !== "boolean"
    ) {
      return null;
    }
    // Cache the successfully probed policy values. Encryption/decryption stay
    // delegated to Electron and can still fail closed at mutation/read time.
    const safeStorage: AsyncSafeStoragePort = Object.freeze({
      isAsyncEncryptionAvailable: async () => encryptionAvailable,
      getSelectedStorageBackend: () => backend,
      encryptStringAsync: (plainText: string) =>
        options.safeStorage.encryptStringAsync(plainText),
      decryptStringAsync: (encrypted: Uint8Array) =>
        options.safeStorage.decryptStringAsync(encrypted)
    });
    const slot = createEncryptedSecretSlot({
      safeStorage,
      platform: options.platform,
      filePath: join(secretsDirectory, PET_BYOK_SECRET_FILE)
    });
    await slot.initialize({ signal: controller.signal });
    if (controller.signal.aborted) return null;
    return slot;
  })();
  const result = initializeWithinDeadline(operation, controller).finally(() => {
    options.signal?.removeEventListener("abort", forwardAbort);
  });
  let quiescence: Promise<void> | null = null;
  return Object.freeze({
    result,
    abort: () => controller.abort(),
    quiesce: () => {
      quiescence ??= Promise.allSettled([operation]).then(() => undefined);
      return quiescence;
    }
  });
}

/** Convenience wrapper for callers without an owned shutdown lifecycle. */
export async function createPetByokSecretSlot(
  options: PetByokSecretSlotOptions
): Promise<EncryptedSecretSlot | null> {
  return await startPetByokSecretSlot(options).result;
}
