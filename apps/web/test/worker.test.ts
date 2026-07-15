import { describe, expect, it } from "vitest";
import type {
  D1BindValue,
  D1DatabaseLike,
  D1MutationBindValue,
  D1MutationDatabaseLike,
  D1MutationPreparedStatementLike,
  D1PreparedStatementLike,
} from "@tokenmonster/cloud-d1";

import { tokenMonsterWorker } from "../worker/handler.js";

interface ScheduledHarnessOptions {
  readonly failDeletionRead?: boolean;
  readonly failCompactorRead?: boolean;
  readonly failRetentionBatch?: boolean;
}

function createScheduledHarness(
  options: ScheduledHarnessOptions = {},
): Readonly<{
  db: D1MutationDatabaseLike;
  preparedQueries: string[];
  projection(): Record<string, string> | null;
}> {
  type FakeStatement = D1MutationPreparedStatementLike & {
    readonly query: string;
    readonly values: D1MutationBindValue[];
  };
  let projection: Record<string, string> | null = null;
  const preparedQueries: string[] = [];
  const db: D1MutationDatabaseLike = {
    prepare(query: string): FakeStatement {
      preparedQueries.push(query);
      const statement: FakeStatement = {
        query,
        values: [],
        bind(...values: readonly D1MutationBindValue[]) {
          statement.values.push(...values);
          return statement;
        },
        async first<T = unknown>() {
          if (
            options.failCompactorRead === true &&
            query.includes("GROUP BY bucket_start")
          ) {
            throw new Error("compactor unavailable");
          }
          return (query.includes("FROM public_totals_cache")
            ? projection
            : null) as T | null;
        },
        async all<T = unknown>() {
          if (
            options.failDeletionRead === true &&
            query.includes("FROM deletion_jobs")
          ) {
            throw new Error("deletion unavailable");
          }
          return { results: [] as T[] };
        },
        async run() {
          return {};
        },
      };
      return statement;
    },
    async batch(statements: D1MutationPreparedStatementLike[]) {
      const queries = statements.map(
        (statement) => (statement as FakeStatement).query,
      );
      if (
        options.failRetentionBatch === true &&
        queries.some((query) => query.includes("DELETE FROM quarantine_events"))
      ) {
        throw new Error("retention unavailable");
      }
      const rebuild = statements.find((statement) =>
        (statement as FakeStatement).query.includes(
          "INSERT INTO public_totals_cache",
        ),
      ) as FakeStatement | undefined;
      if (rebuild !== undefined) {
        const generatedAt = rebuild.values[0];
        const dataRevision = rebuild.values[2];
        if (typeof generatedAt !== "string" || typeof dataRevision !== "string") {
          throw new Error("invalid projection bindings");
        }
        projection = {
          allTimeTokens: "0",
          todayUtcTokens: "0",
          contributors: "0",
          generatedAt,
          dataRevision,
        };
      }
      return statements.map(() => ({
        success: true,
        meta: { changes: 0 },
      }));
    },
    withSession() {
      return this;
    },
  };
  return Object.freeze({
    db,
    preparedQueries,
    projection: () => projection,
  });
}

describe("single-worker API integration", () => {
  it("serves the API health endpoint from the shared worker", async () => {
    const response = await tokenMonsterWorker.fetch(
      new Request("https://tokenmonster.example/healthz"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", contractVersion: 1 });
  });

  it("fails closed until a verified public projection is connected", async () => {
    const response = await tokenMonsterWorker.fetch(
      new Request("https://tokenmonster.example/v1/public/totals"),
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("PUBLIC_TOTALS_UNAVAILABLE");
    expect(body).not.toContain("allTimeTokens");
    expect(body).not.toContain("contributors");
  });

  it("serves only a verified fresh D1 projection when the binding exists", async () => {
    const boundValues: D1BindValue[] = [];
    const statement: D1PreparedStatementLike = {
      bind(...values: readonly D1BindValue[]) {
        boundValues.push(...values);
        return this;
      },
      async first<T = unknown>() {
        return {
          allTimeTokens: "1234567890",
          todayUtcTokens: "345678",
          contributors: "421",
          generatedAt: new Date().toISOString(),
          dataRevision: "worker-integration-1",
        } as T;
      },
    };
    const db: D1DatabaseLike = {
      prepare(query: string) {
        expect(query).toContain("FROM public_totals_cache");
        return statement;
      },
    };

    const response = await tokenMonsterWorker.fetch(
      new Request("https://tokenmonster.example/v1/public/totals"),
      { TOKENMONSTER_DB: db as D1MutationDatabaseLike },
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(boundValues).toEqual(["global", "all"]);
    expect(body).toMatchObject({
      allTimeTokens: "1234567890",
      contributors: "421",
    });
  });

  it("registers a scheduled authoritative projection rebuild when D1 is bound", async () => {
    const harness = createScheduledHarness();
    const pending: Promise<unknown>[] = [];

    tokenMonsterWorker.scheduled(
      { cron: "* * * * *", scheduledTime: Date.now() },
      { TOKENMONSTER_DB: harness.db },
      { waitUntil: (promise) => pending.push(promise) },
    );

    expect(pending).toHaveLength(1);
    await expect(pending[0]).resolves.toBeUndefined();
    expect(harness.projection()?.["dataRevision"]).toMatch(
      /^projection-v1\//u,
    );
    const deletionIndex = harness.preparedQueries.findIndex((query) =>
      query.includes("FROM deletion_jobs"),
    );
    const compactionIndex = harness.preparedQueries.findIndex((query) =>
      query.includes("GROUP BY bucket_start"),
    );
    const retentionIndex = harness.preparedQueries.findIndex((query) =>
      query.includes("DELETE FROM quarantine_events"),
    );
    const projectionIndex = harness.preparedQueries.findIndex((query) =>
      query.includes("INSERT INTO public_totals_cache"),
    );
    expect(deletionIndex).toBeGreaterThanOrEqual(0);
    expect(compactionIndex).toBeGreaterThan(deletionIndex);
    expect(retentionIndex).toBeGreaterThan(compactionIndex);
    expect(projectionIndex).toBeGreaterThan(retentionIndex);
    expect(
      harness.preparedQueries.some((query) =>
        query.includes("DELETE FROM usage_daily_current"),
      ),
    ).toBe(false);
    expect(
      harness.preparedQueries.some((query) =>
        query.includes("DELETE FROM collector_window_bindings"),
      ),
    ).toBe(false);
    expect(
      harness.preparedQueries.some((query) =>
        query.includes("DELETE FROM mutation_guards"),
      ),
    ).toBe(true);
  });

  it("keeps raw compaction inputs when compaction fails and still runs safe maintenance", async () => {
    const harness = createScheduledHarness({ failCompactorRead: true });
    const pending: Promise<unknown>[] = [];

    tokenMonsterWorker.scheduled(
      { cron: "* * * * *", scheduledTime: Date.now() },
      { TOKENMONSTER_DB: harness.db },
      { waitUntil: (promise) => pending.push(promise) },
    );

    await expect(pending[0]).rejects.toThrow("scheduled cloud maintenance failed");
    expect(
      harness.preparedQueries.some((query) =>
        query.includes("DELETE FROM usage_daily_current") ||
        query.includes("DELETE FROM collector_window_bindings"),
      ),
    ).toBe(false);
    expect(
      harness.preparedQueries.some((query) =>
        query.includes("DELETE FROM mutation_guards"),
      ),
    ).toBe(true);
    expect(
      harness.preparedQueries.some((query) =>
        query.includes("INSERT INTO public_totals_cache"),
      ),
    ).toBe(true);
  });

  it("skips irreversible compaction after deletion failure but continues safe work", async () => {
    const harness = createScheduledHarness({ failDeletionRead: true });
    const pending: Promise<unknown>[] = [];

    tokenMonsterWorker.scheduled(
      { cron: "* * * * *", scheduledTime: Date.now() },
      { TOKENMONSTER_DB: harness.db },
      { waitUntil: (promise) => pending.push(promise) },
    );

    await expect(pending[0]).rejects.toThrow("scheduled cloud maintenance failed");
    expect(
      harness.preparedQueries.some((query) =>
        query.includes("GROUP BY bucket_start"),
      ),
    ).toBe(false);
    expect(
      harness.preparedQueries.some((query) =>
        query.includes("DELETE FROM mutation_guards"),
      ),
    ).toBe(true);
    expect(
      harness.preparedQueries.some((query) =>
        query.includes("INSERT INTO public_totals_cache"),
      ),
    ).toBe(true);
  });

  it("rebuilds the projection after a safe-retention failure and rejects the schedule", async () => {
    const harness = createScheduledHarness({ failRetentionBatch: true });
    const pending: Promise<unknown>[] = [];

    tokenMonsterWorker.scheduled(
      { cron: "* * * * *", scheduledTime: Date.now() },
      { TOKENMONSTER_DB: harness.db },
      { waitUntil: (promise) => pending.push(promise) },
    );

    await expect(pending[0]).rejects.toThrow("scheduled cloud maintenance failed");
    expect(
      harness.preparedQueries.some((query) =>
        query.includes("INSERT INTO public_totals_cache"),
      ),
    ).toBe(true);
    expect(harness.projection()).not.toBeNull();
  });

  it("leaves scheduled projection work disabled without a valid D1 binding", () => {
    const pending: Promise<unknown>[] = [];
    tokenMonsterWorker.scheduled(
      { cron: "* * * * *", scheduledTime: Date.now() },
      {},
      { waitUntil: (promise) => pending.push(promise) },
    );
    expect(pending).toEqual([]);
  });
});
