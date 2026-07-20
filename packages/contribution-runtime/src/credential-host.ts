import { isAbsolute, join } from "node:path";

import {
  createEncryptedSecretSlot,
  type AsyncSafeStoragePort,
  type EncryptedSecretSlot,
} from "@tokenmonster/secret-vault";

export const CONTRIBUTION_CREDENTIAL_FILES = Object.freeze({
  upload: "contribution-upload.vault.json",
  deletion: "contribution-deletion.vault.json",
  status: "contribution-status.vault.json",
  pendingEnrollment: "contribution-enrollment-pending.vault.json",
});

export interface ContributionCredentialSlots {
  readonly uploadCredential: EncryptedSecretSlot;
  readonly deletionCredential: EncryptedSecretSlot;
  readonly statusCredential: EncryptedSecretSlot;
  readonly pendingEnrollmentCredential: EncryptedSecretSlot;
}

/**
 * Native hosts inject one audited asynchronous OS encryption authority here.
 * The caller cannot select slot names or paths below the fixed state root.
 */
export interface ContributionCredentialHost {
  openCredentialSlots(stateDirectory: string): ContributionCredentialSlots;
}

export interface ContributionCredentialHostOptions {
  readonly safeStorage: AsyncSafeStoragePort;
  readonly platform: NodeJS.Platform;
}

function validStateDirectory(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    isAbsolute(value) &&
    !value.includes("\0")
  );
}

export function createContributionCredentialHost(
  options: ContributionCredentialHostOptions,
): ContributionCredentialHost {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options) ||
    Reflect.ownKeys(options).length !== 2 ||
    !Object.hasOwn(options, "safeStorage") ||
    !Object.hasOwn(options, "platform")
  ) {
    throw new TypeError("Invalid contribution credential host");
  }
  const { safeStorage, platform } = options;
  return Object.freeze({
    openCredentialSlots(stateDirectory: string): ContributionCredentialSlots {
      if (!validStateDirectory(stateDirectory)) {
        throw new TypeError("Invalid contribution credential state directory");
      }
      const slot = (fileName: string): EncryptedSecretSlot =>
        createEncryptedSecretSlot({
          safeStorage,
          platform,
          filePath: join(stateDirectory, fileName),
        });
      return Object.freeze({
        uploadCredential: slot(CONTRIBUTION_CREDENTIAL_FILES.upload),
        deletionCredential: slot(CONTRIBUTION_CREDENTIAL_FILES.deletion),
        statusCredential: slot(CONTRIBUTION_CREDENTIAL_FILES.status),
        pendingEnrollmentCredential: slot(
          CONTRIBUTION_CREDENTIAL_FILES.pendingEnrollment,
        ),
      });
    },
  });
}
