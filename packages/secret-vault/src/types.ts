export type SecretPersistence = "os-backed" | "memory-only";

export interface AsyncSafeStoragePort {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  getSelectedStorageBackend(): string;
  encryptStringAsync(plainText: string): Promise<Uint8Array>;
  decryptStringAsync(
    encrypted: Uint8Array
  ): Promise<Readonly<{ result: string; shouldReEncrypt: boolean }>>;
}

export interface EncryptedSecretSlotOptions {
  readonly safeStorage: AsyncSafeStoragePort;
  readonly platform: NodeJS.Platform;
  readonly filePath: string;
}

export interface SecretSlotStatus {
  readonly configured: boolean;
  readonly persistence: SecretPersistence;
  readonly backend: string;
}

export interface EncryptedSecretSlot {
  initialize(): Promise<SecretSlotStatus>;
  set(secret: string, options?: Readonly<{ persist?: boolean }>): Promise<SecretSlotStatus>;
  get(): string | null;
  clear(): Promise<SecretSlotStatus>;
  status(): SecretSlotStatus;
}
