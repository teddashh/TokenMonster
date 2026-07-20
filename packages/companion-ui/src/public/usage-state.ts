import type {
  CompanionErrorCode,
  CompanionHealthySnapshot
} from "./dto.js";

const UNAVAILABLE_RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;

export interface UnavailableRetryBackoff {
  nextDelayMs(): number;
  reset(): void;
}

export interface HealthyUsageSnapshotEffects {
  readonly render: (snapshot: CompanionHealthySnapshot) => void;
  readonly refreshAnalytics: () => void | Promise<void>;
  readonly refreshQuota: () => void | Promise<void>;
}

/** Refresh dependent panels only after the healthy usage snapshot renders. */
export function applyHealthyUsageSnapshot(
  snapshot: CompanionHealthySnapshot,
  effects: HealthyUsageSnapshotEffects
): void {
  effects.render(snapshot);
  void effects.refreshAnalytics();
  void effects.refreshQuota();
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
