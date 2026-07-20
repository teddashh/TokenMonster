import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EncryptedSecretSlot,
  SecretPersistence,
  SecretSlotStatus,
} from "@tokenmonster/secret-vault";
import type { ContributionCredentialHost } from "@tokenmonster/contribution-runtime";
import type { TokenTrackerAdapter } from "@tokenmonster/token-tracker-adapter";

import {
  TOKENMONSTER_CONTRIBUTION_API_ORIGIN,
  createCliContributionRuntime,
} from "../src/contribution-host.js";

class Slot implements EncryptedSecretSlot {
  value: string | null = null;
  failSet = false;
  failClear = false;

  constructor(readonly persistence: SecretPersistence) {}

  private snapshot(): SecretSlotStatus {
    return Object.freeze({
      configured: this.value !== null,
      persistence: this.persistence,
      activePersistence: this.persistence,
      backend: this.persistence === "os-backed" ? "keychain" : "basic_text",
    });
  }

  initialize(): Promise<SecretSlotStatus> {
    return Promise.resolve(this.snapshot());
  }

  set(secret: string): Promise<SecretSlotStatus> {
    if (this.failSet) return Promise.reject(new Error("SLOT_SET_FAILED"));
    this.value = secret;
    return Promise.resolve(this.snapshot());
  }

  get(): string | null {
    return this.value;
  }

  clear(): Promise<SecretSlotStatus> {
    if (this.failClear) return Promise.reject(new Error("SLOT_CLEAR_FAILED"));
    this.value = null;
    return Promise.resolve(this.snapshot());
  }

  status(): SecretSlotStatus {
    return this.snapshot();
  }
}

const directories: string[] = [];

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

function unavailableFootprint(now: Date): unknown {
  const end = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 1,
  ));
  const start = new Date(end.getTime() - 27 * 86_400_000);
  return {
    schemaVersion: "1",
    characterId: "chatgpt",
    window: {
      from: start.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
      timezone: "UTC",
    },
    days: Array.from({ length: 28 }, (_, index) => ({
      localDate: new Date(start.getTime() + index * 86_400_000)
        .toISOString()
        .slice(0, 10),
      coverage: "unavailable",
      aggregates: [],
    })),
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function adapter(): TokenTrackerAdapter {
  return Object.freeze({
    getDailyContentBlindFootprint: vi.fn(),
  }) as unknown as TokenTrackerAdapter;
}

function credentialHost(
  persistence: SecretPersistence,
): Readonly<{
  host: ContributionCredentialHost;
  slots: readonly Slot[];
  openCredentialSlots: ReturnType<typeof vi.fn>;
}> {
  const slots = [new Slot(persistence), new Slot(persistence), new Slot(persistence), new Slot(persistence)];
  const openCredentialSlots = vi.fn(() =>
    Object.freeze({
      uploadCredential: slots[0]!,
      deletionCredential: slots[1]!,
      statusCredential: slots[2]!,
      pendingEnrollmentCredential: slots[3]!,
    }),
  );
  return Object.freeze({
    host: Object.freeze({ openCredentialSlots }),
    slots: Object.freeze(slots),
    openCredentialSlots,
  });
}

describe("CLI contribution runtime composition", () => {
  it("opens the fixed local state only for an explicitly injected OS host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-cli-contribution-"));
    directories.push(directory);
    const authority = credentialHost("os-backed");
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const runtime = await createCliContributionRuntime({
      credentialHost: authority.host,
      stateDirectory: directory,
      adapter: adapter(),
      clock: () => new Date("2026-07-19T12:00:00.000Z"),
    });

    expect(authority.openCredentialSlots).toHaveBeenCalledWith(
      join(directory, "contribution-v2"),
    );
    expect(Reflect.ownKeys(runtime.controller)).toEqual([
      "status",
      "preparePreview",
      "enable",
      "stop",
      "requestDeletion",
      "recover",
    ]);
    expect(runtime.controller.status()).toMatchObject({
      configured: true,
      secureStorage: "os-backed",
      state: "off",
      enabled: false,
      canEnable: true,
      canRecover: false,
    });
    await expect(
      stat(join(directory, "contribution-v2.sqlite")),
    ).resolves.toMatchObject({});
    expect(fetcher).not.toHaveBeenCalled();
    await runtime.close();
    await runtime.close();
  });

  it("keeps an injected but unsupported host unavailable and zero-network", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-cli-contribution-"));
    directories.push(directory);
    const authority = credentialHost("memory-only");
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const runtime = await createCliContributionRuntime({
      credentialHost: authority.host,
      stateDirectory: directory,
      adapter: adapter(),
    });
    expect(runtime.controller.status()).toMatchObject({
      secureStorage: "unavailable",
      state: "unavailable",
      enabled: false,
      canEnable: false,
      canRecover: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("uses one fixed HTTPS contribution origin with no renderer override", () => {
    expect(TOKENMONSTER_CONTRIBUTION_API_ORIGIN).toBe(
      "https://api.tokenmonster.app",
    );
  });

  it("keeps close pending through a blocked projection and rejects post-close operations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-cli-contribution-"));
    directories.push(directory);
    const authority = credentialHost("os-backed");
    const projectionStarted = deferred<void>();
    const releaseProjection = deferred<unknown>();
    const now = new Date("2026-07-19T12:00:00.000Z");
    const getDailyContentBlindFootprint = vi.fn(async () => {
      projectionStarted.resolve();
      return releaseProjection.promise;
    });
    const runtime = await createCliContributionRuntime({
      credentialHost: authority.host,
      stateDirectory: directory,
      adapter: Object.freeze({
        getDailyContentBlindFootprint,
      }) as unknown as TokenTrackerAdapter,
      clock: () => new Date(now),
    });

    const preparing = runtime.controller.preparePreview();
    await projectionStarted.promise;
    let closeResolved = false;
    const closing = runtime.close().then(() => {
      closeResolved = true;
    });
    await Promise.resolve();
    expect(closeResolved).toBe(false);

    releaseProjection.resolve(unavailableFootprint(now));
    await expect(preparing).rejects.toThrow("local-service-error");
    await closing;
    expect(closeResolved).toBe(true);
    await expect(runtime.controller.stop()).rejects.toThrow(
      "CONTRIBUTION_RUNTIME_CLOSING",
    );
    expect(getDailyContentBlindFootprint).toHaveBeenCalledTimes(1);
  });

  it("never wakes background sync after Stop when vault writes and clears fail", async () => {
    vi.useFakeTimers();
    try {
      const directory = await mkdtemp(join(tmpdir(), "tokenmonster-cli-contribution-"));
      directories.push(directory);
      const authority = credentialHost("os-backed");
      authority.slots[0]!.value = JSON.stringify({
        schemaVersion: 2,
        kind: "upload",
        token: `tm_u1_${"u".repeat(16)}.${"U".repeat(43)}`,
        consentDocumentRevision: "contribution-2026-07-15",
        lifecycle: "active",
      });
      authority.slots[1]!.value = JSON.stringify({
        schemaVersion: 1,
        kind: "deletion",
        token: `tm_d1_${"d".repeat(16)}.${"D".repeat(43)}`,
        idempotencyKey: "10000000-0000-4000-8000-000000000001",
      });
      authority.slots[0]!.failSet = true;
      authority.slots[0]!.failClear = true;
      const contributionAdapter = adapter();
      const fetcher = vi.fn<typeof fetch>(async () =>
        new Response(
          JSON.stringify({
            contractVersion: 1,
            status: "paused",
            pausedAt: "2026-07-19T12:00:00.000Z",
            futureUploadsBlocked: true,
            identifiableCurrentDataRetained: true,
            anonymousHistoricalTotalsRetained: true,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json; charset=UTF-8" },
          },
        ),
      );
      vi.stubGlobal("fetch", fetcher);
      const runtime = await createCliContributionRuntime({
        credentialHost: authority.host,
        stateDirectory: directory,
        adapter: contributionAdapter,
        clock: () => new Date("2026-07-19T12:00:00.000Z"),
      });

      await expect(runtime.controller.stop()).resolves.toMatchObject({
        ok: false,
        code: "secure-storage-failed",
        status: { state: "active", enabled: true },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(
        contributionAdapter.getDailyContentBlindFootprint,
      ).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
      await runtime.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
