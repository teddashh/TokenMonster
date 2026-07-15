import {
  completeContributorDeletion,
  type DeletionMaintenanceStoragePort
} from "@tokenmonster/api-domain";

const DEFAULT_MAX_JOBS = 25;
const MAX_JOBS = 100;
const DELETION_JOB_ID = /^del_[A-Za-z0-9_-]{22}$/u;

export type D1DeletionMaintenanceErrorCode =
  | "INPUT_INVALID"
  | "SERVICE_UNAVAILABLE";

export class D1DeletionMaintenanceError extends Error {
  override readonly name = "D1DeletionMaintenanceError";

  constructor(readonly code: D1DeletionMaintenanceErrorCode) {
    super(
      code === "INPUT_INVALID"
        ? "The deletion maintenance adapter received invalid input."
        : "The deletion maintenance service is unavailable."
    );
  }

  toJSON(): Readonly<{
    name: "D1DeletionMaintenanceError";
    code: D1DeletionMaintenanceErrorCode;
  }> {
    return Object.freeze({ name: this.name, code: this.code });
  }
}

export interface D1DeletionMaintenanceOptions {
  /** Maximum jobs claimed by one invocation. Defaults to 25; hard max is 100. */
  readonly maxJobs?: number;
  /** Dependency injection exists for deterministic tests only. */
  readonly now?: () => Date;
}

export interface D1DeletionMaintenanceResult {
  /** Content-free operational count; no job or installation IDs are returned. */
  readonly examinedJobs: number;
  /** Equals examinedJobs only when the invocation returns successfully. */
  readonly completedJobs: number;
}

export type D1DeletionMaintenanceProcessor =
  () => Promise<D1DeletionMaintenanceResult>;

function fail(code: D1DeletionMaintenanceErrorCode): never {
  throw new D1DeletionMaintenanceError(code);
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_JOBS;
}

function invocationClock(now: () => Date): Readonly<{ now(): Date }> {
  let value: Date;
  try {
    value = now();
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
  const milliseconds = value instanceof Date ? value.getTime() : Number.NaN;
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < Date.parse("2020-01-01T00:00:00.000Z") ||
    milliseconds >= Date.parse("2100-01-01T00:00:00.000Z")
  ) {
    return fail("SERVICE_UNAVAILABLE");
  }
  return Object.freeze({ now: () => new Date(milliseconds) });
}

/**
 * Completes one bounded page of queued deletion jobs. Individual completions
 * use the domain use case backed by the existing guarded atomic D1 purge. A
 * partial failure rejects the invocation so the scheduler retries; already
 * completed jobs remain safe because completion is idempotent.
 */
export function createD1DeletionMaintenanceProcessor(
  storage: DeletionMaintenanceStoragePort,
  options: D1DeletionMaintenanceOptions = {}
): D1DeletionMaintenanceProcessor {
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
  if (
    storage === null ||
    typeof storage !== "object" ||
    typeof storage.listQueuedDeletionJobIds !== "function" ||
    typeof storage.completeDeletionAtomically !== "function" ||
    !validLimit(maxJobs)
  ) {
    fail("INPUT_INVALID");
  }
  const now = options.now ?? (() => new Date());

  return async () => {
    try {
      const jobIds = await storage.listQueuedDeletionJobIds(maxJobs);
      if (
        !Array.isArray(jobIds) ||
        jobIds.length > maxJobs ||
        jobIds.some((jobId) =>
          typeof jobId !== "string" || !DELETION_JOB_ID.test(jobId)
        ) ||
        new Set(jobIds).size !== jobIds.length
      ) {
        return fail("SERVICE_UNAVAILABLE");
      }
      if (jobIds.length === 0) {
        return Object.freeze({ examinedJobs: 0, completedJobs: 0 });
      }
      const clock = invocationClock(now);
      let completedJobs = 0;
      for (const jobId of jobIds) {
        await completeContributorDeletion({ jobId }, { clock, storage });
        completedJobs += 1;
      }
      return Object.freeze({
        examinedJobs: jobIds.length,
        completedJobs
      });
    } catch (error: unknown) {
      if (error instanceof D1DeletionMaintenanceError) throw error;
      return fail("SERVICE_UNAVAILABLE");
    }
  };
}
