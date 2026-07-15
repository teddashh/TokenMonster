export type CollectorCoreErrorCode =
  | "AUTHORITY_MISMATCH"
  | "AUTHORITY_NOT_RUNNING"
  | "CLOCK_INVALID"
  | "COLLECTOR_FAILED"
  | "COLLECTOR_IDENTITY_MISMATCH"
  | "COLLECTOR_INCOMPLETE"
  | "COLLECTOR_OUTPUT_INVALID"
  | "DEPENDENCY_INVALID"
  | "LOCAL_APPLY_FAILED"
  | "LOCAL_SCOPE_TOO_LARGE"
  | "OUTBOX_READ_FAILED"
  | "OUTBOX_RETRY_FAILED"
  | "SCAN_IN_PROGRESS"
  | "SCAN_REQUEST_INVALID";

const ERROR_MESSAGES: Readonly<Record<CollectorCoreErrorCode, string>> = {
  AUTHORITY_MISMATCH:
    "The local collector authority does not match the exact scan collector.",
  AUTHORITY_NOT_RUNNING:
    "The exact local collector authority is not in the running state.",
  CLOCK_INVALID: "The injected local scan clock returned an invalid time.",
  COLLECTOR_FAILED: "The fixed local collector scan failed safely.",
  COLLECTOR_IDENTITY_MISMATCH:
    "The collector does not match the exact audited identity.",
  COLLECTOR_INCOMPLETE:
    "The local collector did not produce a complete absolute report.",
  COLLECTOR_OUTPUT_INVALID:
    "The local collector output failed the strict content-blind projection.",
  DEPENDENCY_INVALID: "The local scan coordinator dependencies are invalid.",
  LOCAL_APPLY_FAILED:
    "The validated local aggregate transaction could not be applied.",
  LOCAL_SCOPE_TOO_LARGE:
    "The local client/day scope exceeded the bounded coordinator limit.",
  OUTBOX_READ_FAILED: "The local upload outbox could not be read safely.",
  OUTBOX_RETRY_FAILED:
    "The local upload retry metadata could not be recorded safely.",
  SCAN_IN_PROGRESS: "A local collector scan is already in progress.",
  SCAN_REQUEST_INVALID: "The explicit local scan request is invalid."
};

export class CollectorCoreError extends Error {
  override readonly name = "CollectorCoreError";
  readonly code: CollectorCoreErrorCode;

  constructor(code: CollectorCoreErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

export function collectorCoreFailure(code: CollectorCoreErrorCode): never {
  throw new CollectorCoreError(code);
}
