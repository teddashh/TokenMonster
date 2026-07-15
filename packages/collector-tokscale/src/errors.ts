export type CollectorTokscaleErrorCode =
  | "invalid-input"
  | "unsupported-platform"
  | "network-isolation-unavailable"
  | "process-failed"
  | "process-timeout"
  | "output-too-large"
  | "invalid-upstream-json"
  | "unexpected-upstream-data"
  | "unsupported-reasoning"
  | "token-overflow"
  | "no-usage";

export class CollectorTokscaleError extends Error {
  public readonly code: CollectorTokscaleErrorCode;

  public constructor(code: CollectorTokscaleErrorCode, message: string) {
    super(message);
    this.name = "CollectorTokscaleError";
    this.code = code;
  }
}
