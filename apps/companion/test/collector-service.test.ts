import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CollectorCoreError,
  type LocalDailyScanResult,
} from "@tokenmonster/collector-core";
import { openLocalStore, type LocalStore } from "@tokenmonster/local-store";

import {
  createCompanionCollectorService,
  createTokscaleCollectorService,
} from "../src/main/collector-service.js";

const NOW = "2026-07-15T18:30:00.000Z";
let store: LocalStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

function appliedResult(
  client: "claude" | "codex" | "gemini" | "grok",
  utcDate: string,
  observedRows = 1,
): LocalDailyScanResult {
  const tool = {
    claude: "claude-code",
    codex: "codex-cli",
    gemini: "gemini-cli",
    grok: "grok-build",
  } as const;
  return Object.freeze({
    status: "applied",
    client,
    tool: tool[client],
    bucketStart: `${utcDate}T00:00:00.000Z`,
    complete: true,
    observedRows,
    appliedRows: observedRows,
    insertedRows: observedRows,
    updatedRows: 0,
    metadataUpdatedRows: 0,
    unchangedRows: 0,
    inferredZeroRows: 0,
    cloudQueue: Object.freeze({
      status: "skipped",
      reason: "contribution-disabled",
    }),
  });
}

describe("companion collector IPC service", () => {
  it("runs only an explicit current/previous UTC scan and returns bounded local facts", async () => {
    const scanDaily = vi.fn(
      (
        request: Readonly<{
          client: "claude" | "codex" | "gemini" | "grok";
          utcDate: string;
        }>,
        at: Date,
      ) => {
        expect(at.toISOString()).toBe(NOW);
        return Promise.resolve(appliedResult(request.client, request.utcDate));
      },
    );
    const onApplied = vi.fn();
    const service = createCompanionCollectorService({
      execution: { scanDaily },
      clock: () => new Date(NOW),
      onApplied,
    });

    await expect(
      service.scan({ client: "codex", day: "today" }),
    ).resolves.toEqual({
      kind: "applied",
      client: "codex",
      day: "today",
      bucketStart: "2026-07-15T00:00:00.000Z",
      observedRows: 1,
      appliedRows: 1,
      insertedRows: 1,
      updatedRows: 0,
      inferredZeroRows: 0,
      sharing: "disabled",
    });
    await service.scan({ client: "claude", day: "previous" });
    expect(scanDaily.mock.calls[1]?.[0]).toEqual({
      client: "claude",
      utcDate: "2026-07-14",
    });
    expect(onApplied).toHaveBeenLastCalledWith(NOW);
  });

  it("rejects unknown fields and accessors before the scan port", async () => {
    const scanDaily = vi.fn();
    const service = createCompanionCollectorService({
      execution: { scanDaily },
      clock: () => new Date(NOW),
      onApplied: () => undefined,
    });
    await expect(
      service.scan({ client: "codex", day: "today", path: "/private" }),
    ).rejects.toThrow("IPC_REQUEST_REJECTED");
    const getter = vi.fn(() => "codex");
    const accessor = Object.defineProperties(
      {},
      {
        client: { get: getter, enumerable: true },
        day: { value: "today", enumerable: true },
      },
    );
    await expect(service.scan(accessor)).rejects.toThrow(
      "IPC_REQUEST_REJECTED",
    );
    expect(getter).not.toHaveBeenCalled();
    expect(scanDaily).not.toHaveBeenCalled();
  });

  it("records complete empty scans without inventing usage rows", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const onApplied = vi.fn();
    const service = createCompanionCollectorService({
      execution: {
        async scanDaily(request): Promise<LocalDailyScanResult> {
          return appliedResult(request.client, request.utcDate, 0);
        },
      },
      clock: () => new Date(NOW),
      onApplied,
      recordCompleteScan: (input) => {
        store?.recordCompleteDailyScan(input);
      },
    });

    await expect(
      service.scan({ client: "codex", day: "today" }),
    ).resolves.toMatchObject({
      kind: "applied",
      observedRows: 0,
      appliedRows: 0,
    });
    expect(store.listDailyAggregates({ limit: 10 })).toEqual([]);
    expect(
      store.getCompleteDailyScanCoverage({ utcDate: "2026-07-15" }),
    ).toEqual({
      utcDate: "2026-07-15",
      completedClients: ["codex"],
      complete: false,
    });
    expect(onApplied).toHaveBeenCalledWith(NOW);
  });

  it("returns a fixed storage error when required ledger persistence fails", async () => {
    const onApplied = vi.fn();
    const onFailure = vi.fn();
    const service = createCompanionCollectorService({
      execution: {
        async scanDaily(request): Promise<LocalDailyScanResult> {
          return appliedResult(request.client, request.utcDate, 0);
        },
      },
      clock: () => new Date(NOW),
      onApplied,
      onFailure,
      recordCompleteScan: () => {
        throw new Error("PRIVATE_STORAGE_CANARY");
      },
    });

    await expect(
      service.scan({ client: "codex", day: "today" }),
    ).resolves.toEqual({
      kind: "error",
      client: "codex",
      day: "today",
      errorCode: "storage-error",
    });
    expect(onFailure).toHaveBeenCalledWith("storage-error");
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("maps collector/storage failures and malformed results to fixed codes", async () => {
    const errors = [
      [new CollectorCoreError("SCAN_IN_PROGRESS"), "busy"],
      [new CollectorCoreError("AUTHORITY_MISMATCH"), "authority-conflict"],
      [new CollectorCoreError("COLLECTOR_FAILED"), "collector-unavailable"],
      [new CollectorCoreError("LOCAL_APPLY_FAILED"), "storage-error"],
      [new Error("PRIVATE_PATH_CANARY"), "local-service-error"],
    ] as const;
    for (const [error, expected] of errors) {
      const service = createCompanionCollectorService({
        execution: {
          async scanDaily(): Promise<LocalDailyScanResult> {
            throw error;
          },
        },
        clock: () => new Date(NOW),
        onApplied: () => undefined,
      });
      await expect(
        service.scan({ client: "codex", day: "today" }),
      ).resolves.toMatchObject({ kind: "error", errorCode: expected });
    }

    const malformed = createCompanionCollectorService({
      execution: {
        async scanDaily(): Promise<LocalDailyScanResult> {
          return {
            ...appliedResult("codex", "2026-07-15"),
            cloudQueue: {
              status: "queued",
              batchId: "550e8400-e29b-41d4-a716-446655440000",
              generatedAt: NOW,
              bucketCount: 1,
              payloadBytes: 100,
            },
          };
        },
      },
      clock: () => new Date(NOW),
      onApplied: () => undefined,
    });
    await expect(
      malformed.scan({ client: "codex", day: "today" }),
    ).resolves.toMatchObject({ kind: "error", errorCode: "invalid-output" });
  });

  it("sets one exact tokscale authority and stops it on disposal", async () => {
    store = await openLocalStore({ path: ":memory:" });
    const service = createTokscaleCollectorService({
      store,
      configDir: "/tmp/tokenmonster-content-blind-test",
      clock: () => new Date(NOW),
      uuid: () => "550e8400-e29b-41d4-a716-446655440000",
      onApplied: () => undefined,
    });
    expect(store.getCollectorAuthority()).toMatchObject({
      kind: "tokscale",
      adapterVersion: "0.1.0",
      sourceVersion: "4.5.2",
      state: "running",
    });
    service.dispose();
    expect(store.getCollectorAuthority()).toMatchObject({ state: "stopped" });
  });

  it("degrades and refuses a conflicting parser authority", async () => {
    store = await openLocalStore({ path: ":memory:" });
    store.setCollectorAuthority({
      kind: "tokentracker-bridge",
      adapterVersion: "0.1.0",
      sourceVersion: "0.79.8",
      state: "running",
    });
    const service = createTokscaleCollectorService({
      store,
      configDir: "/tmp/tokenmonster-content-blind-test",
      clock: () => new Date(NOW),
      onApplied: () => undefined,
    });
    expect(store.getCollectorAuthority()).toMatchObject({
      kind: "tokentracker-bridge",
      state: "degraded",
    });
    await expect(
      service.scan({ client: "codex", day: "today" }),
    ).resolves.toMatchObject({
      kind: "error",
      errorCode: "authority-conflict",
    });
  });

  it("fails closed before authority startup for an invalid packaged binary path", async () => {
    store = await openLocalStore({ path: ":memory:" });
    const service = createTokscaleCollectorService({
      store,
      configDir: "/tmp/tokenmonster-content-blind-test",
      binaryPath: "relative/tokscale",
      clock: () => new Date(NOW),
      onApplied: () => undefined,
    });
    expect(store.getCollectorAuthority()).toBeNull();
    await expect(
      service.scan({ client: "codex", day: "today" }),
    ).resolves.toMatchObject({
      kind: "error",
      errorCode: "local-service-error",
    });
  });
});
