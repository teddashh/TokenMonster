export type TokenTrackerRuntimeErrorCode =
  | "invalid-configuration"
  | "runtime-not-found"
  | "version-mismatch"
  | "spawn-failed"
  | "startup-timeout"
  | "sidecar-exited"
  | "sidecar-unavailable"
  | "sidecar-incompatible"
  | "refresh-failed"
  | "refresh-timeout";

const MESSAGE_BY_CODE: Readonly<Record<TokenTrackerRuntimeErrorCode, string>> = {
  "invalid-configuration": "The TokenTracker runtime configuration is invalid.",
  "runtime-not-found": "The pinned TokenTracker runtime is unavailable.",
  "version-mismatch": "The installed TokenTracker runtime version is incompatible.",
  "spawn-failed": "The managed TokenTracker process could not be started.",
  "startup-timeout": "The managed TokenTracker process did not become ready in time.",
  "sidecar-exited": "The managed TokenTracker process stopped unexpectedly.",
  "sidecar-unavailable": "The managed TokenTracker process is unavailable.",
  "sidecar-incompatible": "The managed TokenTracker API is incompatible.",
  "refresh-failed": "The local TokenTracker refresh did not complete.",
  "refresh-timeout": "The local TokenTracker refresh timed out."
};

export class TokenTrackerRuntimeError extends Error {
  public override readonly name = "TokenTrackerRuntimeError";
  public readonly code: TokenTrackerRuntimeErrorCode;

  public constructor(code: TokenTrackerRuntimeErrorCode) {
    super(MESSAGE_BY_CODE[code]);
    this.code = code;
  }

  public toJSON(): Readonly<{
    name: "TokenTrackerRuntimeError";
    code: TokenTrackerRuntimeErrorCode;
    message: string;
  }> {
    return Object.freeze({
      name: this.name,
      code: this.code,
      message: this.message
    });
  }
}
