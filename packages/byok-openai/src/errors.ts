export type ByokOpenAiErrorCode =
  | "invalid-api-key"
  | "invalid-request"
  | "invalid-configuration"
  | "request-timeout"
  | "request-aborted"
  | "network-error"
  | "provider-authentication-failed"
  | "provider-rate-limited"
  | "provider-request-rejected"
  | "provider-unavailable"
  | "provider-error"
  | "response-too-large"
  | "malformed-response"
  | "incomplete-response"
  | "unsupported-response"
  | "empty-response";

const MESSAGE_BY_CODE: Readonly<Record<ByokOpenAiErrorCode, string>> = {
  "invalid-api-key": "OpenAI API key format is invalid.",
  "invalid-request": "OpenAI BYOK request is invalid.",
  "invalid-configuration": "OpenAI BYOK adapter configuration is invalid.",
  "request-timeout": "OpenAI request timed out.",
  "request-aborted": "OpenAI request was canceled locally.",
  "network-error": "OpenAI could not be reached.",
  "provider-authentication-failed": "OpenAI rejected the API credential.",
  "provider-rate-limited": "OpenAI rate limited the request.",
  "provider-request-rejected": "OpenAI rejected the request.",
  "provider-unavailable": "OpenAI is temporarily unavailable.",
  "provider-error": "OpenAI returned an unexpected error.",
  "response-too-large": "OpenAI response exceeded the local safety limit.",
  "malformed-response": "OpenAI returned a malformed response.",
  "incomplete-response": "OpenAI did not complete the response.",
  "unsupported-response": "OpenAI returned unsupported response content.",
  "empty-response": "OpenAI returned no assistant text."
};

export class ByokOpenAiError extends Error {
  public override readonly name = "ByokOpenAiError";
  public readonly code: ByokOpenAiErrorCode;

  public constructor(code: ByokOpenAiErrorCode) {
    super(MESSAGE_BY_CODE[code]);
    this.code = code;
  }

  public toJSON(): Readonly<{
    name: "ByokOpenAiError";
    code: ByokOpenAiErrorCode;
    message: string;
  }> {
    return Object.freeze({
      name: this.name,
      code: this.code,
      message: this.message
    });
  }
}
