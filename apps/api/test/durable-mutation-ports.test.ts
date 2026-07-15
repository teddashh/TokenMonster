import type {
  RateLimitRequest,
  RateLimitRoute,
  SuppressionLedgerEntry
} from "@tokenmonster/api-domain";
import { describe, expect, it } from "vitest";

import {
  CLOUDFLARE_RATE_LIMIT_POLICIES,
  TokenMonsterRateLimitDurableController,
  TokenMonsterSuppressionLedgerDurableController,
  createCloudflareDurableMutationPorts,
  type CloudflareDurableStorageLike,
  type CloudflareDurableTransactionLike,
  type CloudflareMutationRuntimePorts
} from "../src/index.js";

class FakeDurableStorage implements CloudflareDurableStorageLike {
  #values = new Map<string, unknown>();
  #tail: Promise<void> = Promise.resolve();
  failTransactions = false;

  async transaction<T>(
    operation: (transaction: CloudflareDurableTransactionLike) => Promise<T>
  ): Promise<T> {
    if (this.failTransactions) throw new Error("sensitive storage detail");
    const previous = this.#tail;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const working = new Map(this.#values);
    try {
      const result = await operation({
        async get<Value>(key: string): Promise<Value | undefined> {
          return working.get(key) as Value | undefined;
        },
        async put<Value>(key: string, value: Value): Promise<void> {
          working.set(key, value);
        }
      });
      this.#values = working;
      return result;
    } finally {
      release();
    }
  }

  corrupt(key: string, value: unknown): void {
    this.#values.set(key, value);
  }
}

type DurableKind = "rate" | "suppression";

class FakeDurableNamespace {
  readonly requestedNames: string[] = [];
  readonly #kind: DurableKind;
  readonly #instances = new Map<string, unknown>();
  readonly #storages = new Map<string, FakeDurableStorage>();

  constructor(kind: DurableKind) {
    this.#kind = kind;
  }

  getByName(name: string): unknown {
    this.requestedNames.push(name);
    const existing = this.#instances.get(name);
    if (existing !== undefined) return existing;
    const storage = new FakeDurableStorage();
    const state = Object.freeze({ storage });
    const instance =
      this.#kind === "rate"
        ? new TokenMonsterRateLimitDurableController(state, {})
        : new TokenMonsterSuppressionLedgerDurableController(state, {});
    this.#storages.set(name, storage);
    this.#instances.set(name, instance);
    return instance;
  }

  storage(name: string): FakeDurableStorage {
    this.getByName(name);
    const storage = this.#storages.get(name);
    if (storage === undefined) throw new Error("missing fake storage");
    return storage;
  }
}

const ROUTE_PREFIX: Readonly<Record<RateLimitRoute, string>> = Object.freeze({
  enrollment: "rl_e1_",
  ingest: "rl_i1_",
  delete: "rl_d1_"
});

function rateKey(route: RateLimitRoute, character = "A"): string {
  return `${ROUTE_PREFIX[route]}${character.repeat(43)}`;
}

function request(
  route: RateLimitRoute,
  at: string,
  character = "A"
): RateLimitRequest {
  return Object.freeze({ route, subjectKey: rateKey(route, character), at });
}

function instant(base: string, milliseconds: number): string {
  return new Date(Date.parse(base) + milliseconds).toISOString();
}

function marker(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function suppression(
  index: number,
  recordedAt: string,
  expiresAt: string
): SuppressionLedgerEntry {
  return Object.freeze({
    suppressionMarker: marker(index),
    recordedAt,
    expiresAt
  });
}

describe("Cloudflare durable rate-limit port", () => {
  it("enforces every fixed route quota and resets only at its next window", async () => {
    const rateNamespace = new FakeDurableNamespace("rate");
    const suppressionNamespace = new FakeDurableNamespace("suppression");
    const runtime: Required<CloudflareMutationRuntimePorts> =
      createCloudflareDurableMutationPorts(
        rateNamespace,
        suppressionNamespace
      );
    const { rateLimit } = runtime;
    const base = "2026-07-15T18:00:00.000Z";

    for (const route of ["enrollment", "ingest", "delete"] as const) {
      const policy = CLOUDFLARE_RATE_LIMIT_POLICIES[route];
      for (let consumed = 0; consumed < policy.limit; consumed += 1) {
        await expect(rateLimit.consume(request(route, base))).resolves.toEqual({
          allowed: true
        });
      }
      const afterOneHundredSeconds = instant(base, 100_000);
      await expect(
        rateLimit.consume(request(route, afterOneHundredSeconds))
      ).resolves.toEqual({
        allowed: false,
        retryAfterSeconds: policy.windowSeconds - 100
      });
      await expect(
        rateLimit.consume(request(route, instant(base, policy.windowSeconds * 1_000)))
      ).resolves.toEqual({ allowed: true });
    }
  });

  it("serializes concurrent consumes without exceeding the quota", async () => {
    const rateNamespace = new FakeDurableNamespace("rate");
    const { rateLimit } = createCloudflareDurableMutationPorts(
      rateNamespace,
      new FakeDurableNamespace("suppression")
    );
    const at = "2026-07-15T18:00:00.000Z";
    const decisions = await Promise.all(
      Array.from({ length: 25 }, () =>
        rateLimit.consume(request("enrollment", at))
      )
    );

    expect(decisions.filter(({ allowed }) => allowed)).toHaveLength(10);
    expect(decisions.filter(({ allowed }) => !allowed)).toHaveLength(15);
  });

  it("fails closed for an out-of-order window or a mismatched partition", async () => {
    const storage = new FakeDurableStorage();
    const object = new TokenMonsterRateLimitDurableController({ storage }, {});
    await object.consume(
      request("enrollment", "2026-07-15T18:15:00.000Z")
    );
    await expect(
      object.consume(request("enrollment", "2026-07-15T18:00:00.000Z"))
    ).rejects.toThrow("durable mutation service unavailable");
    await expect(
      object.consume(request("enrollment", "2026-07-15T18:15:01.000Z", "B"))
    ).rejects.toThrow("durable mutation service unavailable");
  });

  it("rejects raw identities and accessor inputs before resolving a stub", async () => {
    const rateNamespace = new FakeDurableNamespace("rate");
    const { rateLimit } = createCloudflareDurableMutationPorts(
      rateNamespace,
      new FakeDurableNamespace("suppression")
    );
    await expect(
      rateLimit.consume({
        route: "enrollment",
        subjectKey: "203.0.113.8",
        at: "2026-07-15T18:00:00.000Z"
      })
    ).rejects.toThrow("durable mutation service unavailable");
    await expect(
      rateLimit.consume({
        route: "ingest",
        subjectKey:
          "tm_u1_AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        at: "2026-07-15T18:00:00.000Z"
      })
    ).rejects.toThrow("durable mutation service unavailable");
    expect(rateNamespace.requestedNames).toEqual([]);

    let getterCalled = false;
    const malicious = {
      route: "enrollment",
      subjectKey: rateKey("enrollment"),
      get at(): string {
        getterCalled = true;
        return "2026-07-15T18:00:00.000Z";
      }
    };
    const object = new TokenMonsterRateLimitDurableController(
      { storage: new FakeDurableStorage() },
      {}
    );
    await expect(object.consume(malicious)).rejects.toThrow(
      "durable mutation service unavailable"
    );
    expect(getterCalled).toBe(false);
  });

  it("sanitizes malformed RPC results, namespace failures, and storage failures", async () => {
    let responseGetterCalled = false;
    const malformedNamespace = {
      getByName(): unknown {
        return {
          consume(): unknown {
            return {
              get allowed(): boolean {
                responseGetterCalled = true;
                return true;
              }
            };
          }
        };
      }
    };
    const malformed = createCloudflareDurableMutationPorts(
      malformedNamespace,
      new FakeDurableNamespace("suppression")
    );
    await expect(
      malformed.rateLimit.consume(
        request("enrollment", "2026-07-15T18:00:00.000Z")
      )
    ).rejects.toThrow("durable mutation service unavailable");
    expect(responseGetterCalled).toBe(false);

    const missing = createCloudflareDurableMutationPorts(null, null);
    await expect(
      missing.rateLimit.consume(
        request("enrollment", "2026-07-15T18:00:00.000Z")
      )
    ).rejects.toThrow("durable mutation service unavailable");

    const storage = new FakeDurableStorage();
    storage.failTransactions = true;
    const object = new TokenMonsterRateLimitDurableController({ storage }, {});
    let failure: unknown;
    try {
      await object.consume(
        request("enrollment", "2026-07-15T18:00:00.000Z")
      );
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("sensitive storage detail");
  });
});

describe("Cloudflare durable suppression ledger port", () => {
  it("records independently, deduplicates retries, and removes expired entries", async () => {
    const rateNamespace = new FakeDurableNamespace("rate");
    const suppressionNamespace = new FakeDurableNamespace("suppression");
    const ports = createCloudflareDurableMutationPorts(
      rateNamespace,
      suppressionNamespace
    );
    const recordedAt = "2026-07-15T18:00:00.000Z";
    const firstExpiry = instant(recordedAt, 37 * 24 * 60 * 60 * 1_000);
    const retryExpiry = instant(recordedAt, 40 * 24 * 60 * 60 * 1_000);
    await ports.suppressionLedger.record(
      suppression(1, recordedAt, firstExpiry)
    );
    await ports.suppressionLedger.record(
      suppression(2, recordedAt, retryExpiry)
    );
    await ports.suppressionLedger.record(
      suppression(1, instant(recordedAt, 1_000), retryExpiry)
    );

    await expect(
      ports.suppressionLedger.listActive(instant(recordedAt, 1_000))
    ).resolves.toEqual([
      suppression(1, recordedAt, firstExpiry),
      suppression(2, recordedAt, retryExpiry)
    ]);
    await expect(
      ports.suppressionLedger.listActive(instant(firstExpiry, 1))
    ).resolves.toEqual([suppression(2, recordedAt, retryExpiry)]);
    expect(rateNamespace.requestedNames).toEqual([]);
    expect(suppressionNamespace.requestedNames.length).toBeGreaterThan(16);
  });

  it("serializes concurrent duplicate records idempotently", async () => {
    const namespace = new FakeDurableNamespace("suppression");
    const { suppressionLedger } = createCloudflareDurableMutationPorts(
      new FakeDurableNamespace("rate"),
      namespace
    );
    const recordedAt = "2026-07-15T18:00:00.000Z";
    const expiresAt = instant(recordedAt, 37 * 24 * 60 * 60 * 1_000);
    await Promise.all(
      Array.from({ length: 30 }, () =>
        suppressionLedger.record(suppression(7, recordedAt, expiresAt))
      )
    );
    await expect(suppressionLedger.listActive(recordedAt)).resolves.toEqual([
      suppression(7, recordedAt, expiresAt)
    ]);
  });

  it("enforces a bounded retention interval and per-shard capacity", async () => {
    const object = new TokenMonsterSuppressionLedgerDurableController(
      { storage: new FakeDurableStorage() },
      {}
    );
    const recordedAt = "2026-07-15T18:00:00.000Z";
    await expect(
      object.record(
        suppression(1, recordedAt, instant(recordedAt, 46 * 24 * 60 * 60 * 1_000))
      )
    ).rejects.toThrow("durable mutation service unavailable");

    const expiresAt = instant(recordedAt, 37 * 24 * 60 * 60 * 1_000);
    for (let index = 1; index <= 512; index += 1) {
      await object.record(suppression(index, recordedAt, expiresAt));
    }
    await expect(
      object.record(suppression(513, recordedAt, expiresAt))
    ).rejects.toThrow("durable mutation service unavailable");
    await expect(object.listActive(recordedAt)).resolves.toHaveLength(512);
  });

  it("fails the whole replay for malformed shards and sanitized storage errors", async () => {
    const namespace = new FakeDurableNamespace("suppression");
    const { suppressionLedger } = createCloudflareDurableMutationPorts(
      new FakeDurableNamespace("rate"),
      namespace
    );
    await suppressionLedger.listActive("2026-07-15T18:00:00.000Z");
    const failedName = namespace.requestedNames[0];
    if (failedName === undefined) throw new Error("missing requested shard");
    namespace.storage(failedName).failTransactions = true;

    let failure: unknown;
    try {
      await suppressionLedger.listActive("2026-07-15T18:00:01.000Z");
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toBe(
      "Error: durable mutation service unavailable"
    );

    let getterCalled = false;
    const malformedNamespace = {
      getByName(): unknown {
        return {
          listActive(): unknown {
            return [
              {
                suppressionMarker: marker(1),
                recordedAt: "2026-07-15T18:00:00.000Z",
                get expiresAt(): string {
                  getterCalled = true;
                  return "2026-08-21T18:00:00.000Z";
                }
              }
            ];
          }
        };
      }
    };
    const malformed = createCloudflareDurableMutationPorts(
      new FakeDurableNamespace("rate"),
      malformedNamespace
    );
    await expect(
      malformed.suppressionLedger.listActive("2026-07-15T18:00:00.000Z")
    ).rejects.toThrow("durable mutation service unavailable");
    expect(getterCalled).toBe(false);
  });

  it("rejects malformed acknowledgement and never places raw IDs in object names", async () => {
    const names: string[] = [];
    const namespace = {
      getByName(name: string): unknown {
        names.push(name);
        return {
          record(): unknown {
            return { ok: false };
          }
        };
      }
    };
    const ports = createCloudflareDurableMutationPorts(
      new FakeDurableNamespace("rate"),
      namespace
    );
    const recordedAt = "2026-07-15T18:00:00.000Z";
    await expect(
      ports.suppressionLedger.record(
        suppression(
          42,
          recordedAt,
          instant(recordedAt, 37 * 24 * 60 * 60 * 1_000)
        )
      )
    ).rejects.toThrow("durable mutation service unavailable");
    expect(names).toHaveLength(1);
    expect(names[0]).not.toContain("ins_");
    expect(names[0]).not.toContain(marker(42));
  });
});
