import { Buffer } from "node:buffer";

import { SecretVaultError } from "./errors.js";
import type {
  EncryptedSecretSlot,
  SecretSlotStatus,
} from "./types.js";

const MAX_SECRET_BYTES = 4_096;
const MEMORY_BACKEND = "memory-only" as const;

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

function normalizeSetOptions(value: unknown): AbortSignal | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(value) as object | null,
    ) ||
    Reflect.ownKeys(value).some(
      (key) => key !== "persist" && key !== "signal",
    )
  ) {
    throw new SecretVaultError("invalid-configuration");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "persist");
  if (
    descriptor !== undefined &&
    (!("value" in descriptor) || typeof descriptor.value !== "boolean")
  ) {
    throw new SecretVaultError("invalid-configuration");
  }
  const signalDescriptor = Object.getOwnPropertyDescriptor(value, "signal");
  if (
    signalDescriptor !== undefined &&
    (!("value" in signalDescriptor) ||
      !(signalDescriptor.value instanceof AbortSignal))
  ) {
    throw new SecretVaultError("invalid-configuration");
  }
  return signalDescriptor === undefined
    ? undefined
    : (signalDescriptor.value as AbortSignal);
}

function normalizeInitializeOptions(value: unknown): AbortSignal | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(value) as object | null,
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

/**
 * Creates an explicitly ephemeral secret slot for hosts without an approved
 * OS-backed encryption bridge. The secret is never written or encrypted and
 * becomes unreachable with the slot; `persist: true` cannot upgrade it.
 */
export function createMemorySecretSlot(): EncryptedSecretSlot {
  let secret: string | null = null;

  const snapshot = (): SecretSlotStatus =>
    Object.freeze({
      configured: secret !== null,
      persistence: "memory-only" as const,
      activePersistence: "memory-only" as const,
      backend: MEMORY_BACKEND,
    });

  return Object.freeze({
    initialize: async (
      options: Readonly<{ signal?: AbortSignal }> = {},
    ) => {
      const signal = normalizeInitializeOptions(options);
      if (signal?.aborted === true) {
        throw new SecretVaultError("storage-failed");
      }
      return snapshot();
    },
    set: async (
      input: string,
      options: Readonly<{ persist?: boolean; signal?: AbortSignal }> = {},
    ) => {
      const signal = normalizeSetOptions(options);
      if (signal?.aborted === true) {
        throw new SecretVaultError("storage-failed");
      }
      secret = validateSecret(input);
      return snapshot();
    },
    get: () => secret,
    clear: async (
      options: Readonly<{ signal?: AbortSignal }> = {},
    ) => {
      const signal = normalizeInitializeOptions(options);
      if (signal?.aborted === true) {
        throw new SecretVaultError("storage-failed");
      }
      secret = null;
      return snapshot();
    },
    status: snapshot,
  });
}
