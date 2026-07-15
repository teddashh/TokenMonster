export type SecretVaultErrorCode =
  | "invalid-configuration"
  | "invalid-secret"
  | "encryption-unavailable"
  | "storage-corrupt"
  | "storage-failed";

const MESSAGE_BY_CODE: Readonly<Record<SecretVaultErrorCode, string>> = {
  "invalid-configuration": "The encrypted secret slot is misconfigured.",
  "invalid-secret": "The secret value is invalid.",
  "encryption-unavailable": "OS-backed secret encryption is unavailable.",
  "storage-corrupt": "The encrypted secret file is invalid.",
  "storage-failed": "The encrypted secret operation failed."
};

export class SecretVaultError extends Error {
  public override readonly name = "SecretVaultError";
  public readonly code: SecretVaultErrorCode;

  public constructor(code: SecretVaultErrorCode) {
    super(MESSAGE_BY_CODE[code]);
    this.code = code;
  }

  public toJSON(): Readonly<{
    name: "SecretVaultError";
    code: SecretVaultErrorCode;
    message: string;
  }> {
    return Object.freeze({ name: this.name, code: this.code, message: this.message });
  }
}
