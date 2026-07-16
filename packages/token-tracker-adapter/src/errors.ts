export type TokenTrackerAdapterErrorCode =
  | "invalid-configuration"
  | "invalid-range"
  | "network-error"
  | "request-timeout"
  | "unexpected-status"
  | "malformed-response"
  | "response-too-large"
  | "incompatible-schema";

const MESSAGE_BY_CODE: Readonly<
  Record<TokenTrackerAdapterErrorCode, string>
> = {
  "invalid-configuration": "TokenTracker adapter configuration is invalid.",
  "invalid-range": "TokenTracker aggregate date range is invalid.",
  "network-error": "The local TokenTracker sidecar could not be reached.",
  "request-timeout": "The local TokenTracker sidecar timed out.",
  "unexpected-status": "The local TokenTracker sidecar rejected the request.",
  "malformed-response": "The local TokenTracker sidecar returned malformed JSON.",
  "response-too-large": "The local TokenTracker response exceeded the safety limit.",
  "incompatible-schema":
    "The local TokenTracker response is not compatible with the supported schema."
};

export class TokenTrackerAdapterError extends Error {
  public override readonly name = "TokenTrackerAdapterError";
  public readonly code: TokenTrackerAdapterErrorCode;

  public constructor(code: TokenTrackerAdapterErrorCode) {
    super(MESSAGE_BY_CODE[code]);
    this.code = code;
  }

  public toJSON(): Readonly<{
    name: "TokenTrackerAdapterError";
    code: TokenTrackerAdapterErrorCode;
    message: string;
  }> {
    return Object.freeze({
      name: this.name,
      code: this.code,
      message: this.message
    });
  }
}
