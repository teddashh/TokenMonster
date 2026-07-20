import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ContributionRuntimeStatus,
  ContributionSyncResult,
} from "../src/types.js";
import { createContributionSyncScheduler } from "../src/contribution-sync-scheduler.js";

function runtimeStatus(enabled: boolean): ContributionRuntimeStatus {
  return Object.freeze({
    configured: true,
    secureStorage: "os-backed" as const,
    state: enabled ? ("active" as const) : ("off" as const),
    enabled,
    canEnable: !enabled,
    canDelete: enabled,
    canRecover: false,
    outboxPending: 0,
    consentDocumentRevision: enabled ? "contribution-2026-07-15" : null,
    deletion: null,
  });
}

function syncResult(
  enabled = true,
  overrides: Partial<ContributionSyncResult> = {},
): ContributionSyncResult {
  return Object.freeze({
    ok: true,
    code: "nothing-due" as const,
    uploadedBatches: 0,
    status: runtimeStatus(enabled),
    ...overrides,
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("background contribution sync scheduler", () => {
  it("makes no sync call while contribution is off or unavailable", async () => {
    vi.useFakeTimers();
    let enabled = false;
    const sync = vi.fn(async () => syncResult(enabled));
    const scheduler = createContributionSyncScheduler({
      contribution: {
        status: () => runtimeStatus(enabled),
        sync,
      },
      initialDelayMs: 10,
      wakeDelayMs: 5,
      intervalMs: 100,
    });

    scheduler.start();
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).not.toHaveBeenCalled();

    enabled = true;
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(5);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("runs after the startup delay and continues on a bounded cadence", async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async () => syncResult());
    const scheduler = createContributionSyncScheduler({
      contribution: { status: () => runtimeStatus(true), sync },
      initialDelayMs: 10,
      intervalMs: 100,
    });

    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(9);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("never overlaps sync and services a wake after the active run settles", async () => {
    vi.useFakeTimers();
    const pending = deferred<ContributionSyncResult>();
    const sync = vi
      .fn<() => Promise<ContributionSyncResult>>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(syncResult());
    const scheduler = createContributionSyncScheduler({
      contribution: { status: () => runtimeStatus(true), sync },
      initialDelayMs: 10,
      wakeDelayMs: 5,
      intervalMs: 100,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(500);
    expect(sync).toHaveBeenCalledTimes(1);

    pending.resolve(syncResult());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("survives busy results and thrown failures without fast looping", async () => {
    vi.useFakeTimers();
    const sync = vi
      .fn<() => Promise<ContributionSyncResult>>()
      .mockResolvedValueOnce(
        syncResult(true, { ok: false, code: "busy" }),
      )
      .mockRejectedValueOnce(new Error("NETWORK_CONTENT_REDACTED"))
      .mockResolvedValue(syncResult());
    const scheduler = createContributionSyncScheduler({
      contribution: { status: () => runtimeStatus(true), sync },
      initialDelayMs: 10,
      busyRetryDelayMs: 20,
      intervalMs: 100,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(99);
    expect(sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(3);
  });

  it("does not reschedule when paused during an active sync", async () => {
    vi.useFakeTimers();
    const pending = deferred<ContributionSyncResult>();
    const sync = vi
      .fn<() => Promise<ContributionSyncResult>>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(syncResult());
    const scheduler = createContributionSyncScheduler({
      contribution: { status: () => runtimeStatus(true), sync },
      initialDelayMs: 10,
      intervalMs: 100,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    scheduler.pause();
    pending.resolve(syncResult());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("does not retry stale consent even when a vault failure still reports active", async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async () =>
      syncResult(true, { ok: false, code: "consent-stale" }),
    );
    const scheduler = createContributionSyncScheduler({
      contribution: { status: () => runtimeStatus(true), sync },
      initialDelayMs: 10,
      intervalMs: 100,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("pauses and disposes idempotently without keeping a timer alive", async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async () => syncResult());
    const scheduler = createContributionSyncScheduler({
      contribution: { status: () => runtimeStatus(true), sync },
      initialDelayMs: 10,
      wakeDelayMs: 5,
      intervalMs: 100,
    });

    scheduler.start();
    scheduler.pause();
    await vi.advanceTimersByTimeAsync(100);
    expect(sync).not.toHaveBeenCalled();
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(5);
    expect(sync).toHaveBeenCalledTimes(1);
    scheduler.dispose();
    scheduler.dispose();
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("rejects unbounded timer configuration", () => {
    expect(() =>
      createContributionSyncScheduler({
        contribution: {
          status: () => runtimeStatus(false),
          sync: async () => syncResult(false),
        },
        intervalMs: 0,
      }),
    ).toThrow("BACKGROUND_SYNC_DELAY_INVALID");
  });
});
