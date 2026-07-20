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
  /** Whether this host is capable of persisting a secret with an approved backend. */
  readonly persistence: SecretPersistence;
  /** Where the currently configured secret actually lives. */
  readonly activePersistence?: SecretPersistence;
  readonly backend: string;
}

export interface EncryptedSecretSlot {
  initialize(
    options?: Readonly<{ signal?: AbortSignal }>
  ): Promise<SecretSlotStatus>;
  set(
    secret: string,
    options?: Readonly<{ persist?: boolean; signal?: AbortSignal }>
  ): Promise<SecretSlotStatus>;
  get(): string | null;
  clear(
    options?: Readonly<{ signal?: AbortSignal }>
  ): Promise<SecretSlotStatus>;
  status(): SecretSlotStatus;
}
