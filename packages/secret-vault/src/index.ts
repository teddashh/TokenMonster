export { SecretVaultError, type SecretVaultErrorCode } from "./errors.js";
export { createEncryptedSecretSlot } from "./vault.js";
export type {
  AsyncSafeStoragePort,
  EncryptedSecretSlot,
  EncryptedSecretSlotOptions,
  SecretPersistence,
  SecretSlotStatus
} from "./types.js";
