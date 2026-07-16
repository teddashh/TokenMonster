import type { CompanionErrorCode } from "./dto.js";

const UNAVAILABLE_RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;

export interface UnavailableRetryBackoff {
  nextDelayMs(): number;
  reset(): void;
}

export function createUnavailableRetryBackoff(): UnavailableRetryBackoff {
  let failureIndex = 0;
  return Object.freeze({
    nextDelayMs(): number {
      const delay =
        UNAVAILABLE_RETRY_DELAYS_MS[
          Math.min(failureIndex, UNAVAILABLE_RETRY_DELAYS_MS.length - 1)
        ] ?? 60_000;
      failureIndex += 1;
      return delay;
    },
    reset(): void {
      failureIndex = 0;
    }
  });
}

export function shouldAutomaticallyRetry(error: CompanionErrorCode): boolean {
  return error === "sidecar-unavailable";
}
