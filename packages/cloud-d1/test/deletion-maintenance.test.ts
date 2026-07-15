import type {
  DeletionMaintenanceStoragePort,
  DeletionRequestRecord
} from "@tokenmonster/api-domain";
import { describe, expect, it } from "vitest";

import {
  createD1DeletionMaintenanceProcessor,
  D1DeletionMaintenanceError
} from "../src/index.js";

const NOW = "2026-07-15T18:30:00.000Z";
const JOBS = [
  `del_${"A".repeat(22)}`,
  `del_${"B".repeat(22)}`,
  `del_${"C".repeat(22)}`
] as const;

function record(jobId: string, completedAt: string): DeletionRequestRecord {
  return Object.freeze({
    installationId: `ins_${"I".repeat(22)}`,
    idempotencyKey: `delete_${"K".repeat(22)}`,
    jobId,
    state: "complete" as const,
    statusCredential: Object.freeze({
      scope: "deletion-status" as const,
      publicTokenId: `status${"S".repeat(16)}`,
      hmacDigest: "s".repeat(43),
      hmacKeyId: "status-v1"
    }),
    replayCredential: Object.freeze({
      scope: "deletion" as const,
      publicTokenId: `replay${"R".repeat(16)}`,
      hmacDigest: "r".repeat(43),
      hmacKeyId: "pepper-v1"
    }),
    requestedAt: "2026-07-15T18:00:00.000Z",
    completedAt,
    expiresAt: "2026-08-14T18:00:00.000Z",
    anonymousHistoricalTotalsRetained: true
  });
}

class FakeMaintenanceStorage implements DeletionMaintenanceStoragePort {
  readonly requestedLimits: number[] = [];
  readonly completed: Array<Readonly<{ jobId: string; completedAt: string }>> =
    [];
  jobs: readonly string[] = JOBS;
  failure: Error | null = null;

  async listQueuedDeletionJobIds(limit: number): Promise<readonly string[]> {
    this.requestedLimits.push(limit);
    return this.jobs.slice(0, limit);
  }

  async completeDeletionAtomically(input: {
    readonly jobId: string;
    readonly completedAt: string;
  }): Promise<DeletionRequestRecord> {
    if (this.failure !== null) throw this.failure;
    this.completed.push(Object.freeze({ ...input }));
    return record(input.jobId, input.completedAt);
  }
}

describe("D1 deletion maintenance processor", () => {
  it("completes one bounded page and returns only content-free counts", async () => {
    const storage = new FakeMaintenanceStorage();
    const process = createD1DeletionMaintenanceProcessor(storage, {
      maxJobs: 2,
      now: () => new Date(NOW)
    });

    const result = await process();

    expect(result).toEqual({ examinedJobs: 2, completedJobs: 2 });
    expect(storage.requestedLimits).toEqual([2]);
    expect(storage.completed).toEqual([
      { jobId: JOBS[0], completedAt: NOW },
      { jobId: JOBS[1], completedAt: NOW }
    ]);
    expect(JSON.stringify(result)).not.toContain("del_");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("returns zero counts without consulting the clock when the queue is empty", async () => {
    const storage = new FakeMaintenanceStorage();
    storage.jobs = [];
    const process = createD1DeletionMaintenanceProcessor(storage, {
      now: () => {
        throw new Error("unused clock");
      }
    });

    await expect(process()).resolves.toEqual({
      examinedJobs: 0,
      completedJobs: 0
    });
  });

  it.each([0, 101, 1.5])("rejects an unsafe maxJobs value %s", (maxJobs) => {
    expect(() =>
      createD1DeletionMaintenanceProcessor(new FakeMaintenanceStorage(), {
        maxJobs
      })
    ).toThrowError(D1DeletionMaintenanceError);
  });

  it("rejects malformed or duplicate queue output", async () => {
    const malformed = new FakeMaintenanceStorage();
    malformed.jobs = ["not-a-job"];
    const duplicate = new FakeMaintenanceStorage();
    duplicate.jobs = [JOBS[0], JOBS[0]];

    for (const storage of [malformed, duplicate]) {
      const process = createD1DeletionMaintenanceProcessor(storage);
      await expect(process()).rejects.toMatchObject({
        name: "D1DeletionMaintenanceError",
        code: "SERVICE_UNAVAILABLE"
      });
      expect(storage.completed).toEqual([]);
    }
  });

  it("sanitizes atomic completion failures and returns no partial result", async () => {
    const storage = new FakeMaintenanceStorage();
    const canary = `prompt=PRIVATE:${JOBS[0]}`;
    storage.failure = new Error(canary);
    const process = createD1DeletionMaintenanceProcessor(storage, {
      now: () => new Date(NOW)
    });

    try {
      await process();
      throw new Error("expected failure");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(D1DeletionMaintenanceError);
      expect(JSON.stringify(error)).not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(JOBS[0]);
    }
  });
});
