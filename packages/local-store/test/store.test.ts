import {
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPLETE_SCAN_CLIENTS,
  LocalStoreError,
  openLocalStore,
} from "../src/index.js";
import {
  LOCAL_STORE_MIGRATIONS,
  LOCAL_STORE_SCHEMA_VERSION,
} from "../src/schema.js";
import {
  NOW,
  dailyAggregate,
  fixedClock,
  ingestReceipt,
  ingestSnapshot,
  learningMonsterState,
  validConfig,
  zeroTokens,
} from "./helpers.js";

const temporaryDirectories: string[] = [];

function temporaryDatabase(): {
  readonly directory: string;
  readonly path: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "tokenmonster-local-store-"));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, "local.sqlite") };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

describe("opening, migrations, and lifecycle", () => {
  it("configures a private WAL database with the current strict schema", async () => {
    const { path } = temporaryDatabase();
    const store = await openLocalStore({ path, clock: fixedClock() });

    expect(store.getDiagnosticSummary()).toEqual({
      schemaVersion: LOCAL_STORE_SCHEMA_VERSION,
      storage: "file",
      journalMode: "wal",
      securityPragmas: {
        foreignKeys: true,
        busyTimeoutMs: 5_000,
        secureDelete: true,
      },
      counts: {
        dailyAggregates: 0,
        completeScanScopes: 0,
        cloudMirrorEntries: 0,
        monsterSnapshots: 0,
        cloudOutboxEntries: 0,
      },
      configConfigured: false,
      collectorAuthority: { configured: false },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    store.close();
    const database = new DatabaseSync(path, { readBigInts: true });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 4n,
    });
    expect(database.prepare("PRAGMA quick_check").get()).toEqual({
      quick_check: "ok",
    });
    database.close();
  });

  it("reopens persisted content-blind rows without changing revisions", async () => {
    const { path } = temporaryDatabase();
    let store = await openLocalStore({ path, clock: fixedClock() });
    expect(store.upsertDailyAggregate(dailyAggregate()).row.revision).toBe(1);
    store.saveConfig(validConfig());
    store.close();

    store = await openLocalStore({ path, clock: fixedClock() });
    expect(store.listDailyAggregates({ limit: 10 })).toHaveLength(1);
    expect(store.upsertDailyAggregate(dailyAggregate())).toMatchObject({
      status: "unchanged",
      row: { revision: 1 },
    });
    expect(store.getConfig()).toEqual(validConfig());
    store.close();
  });

  it("backs up a recognized v1 database before transactionally migrating", async () => {
    const { directory, path } = temporaryDatabase();
    const legacy = new DatabaseSync(path);
    const migration = LOCAL_STORE_MIGRATIONS[0];
    if (migration === undefined) throw new Error("missing migration fixture");
    legacy.exec(migration.sql);
    legacy.exec("PRAGMA user_version = 1");
    legacy.close();

    const store = await openLocalStore({ path, clock: fixedClock() });
    expect(store.getDiagnosticSummary().schemaVersion).toBe(
      LOCAL_STORE_SCHEMA_VERSION,
    );
    store.close();

    const backups = readdirSync(directory).filter((name) =>
      name.startsWith(".tokenmonster-pre-migration-v1-to-v4-"),
    );
    expect(backups).toHaveLength(1);
    const backupPath = join(directory, backups[0] ?? "missing");
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    const backupDatabase = new DatabaseSync(backupPath, { readBigInts: true });
    expect(backupDatabase.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 1n,
    });
    expect(() =>
      backupDatabase
        .prepare("SELECT COUNT(*) AS count FROM cloud_outbox")
        .get(),
    ).toThrow();
    backupDatabase.close();
  });

  it("migrates the released v2 layout to an independent cloud mirror", async () => {
    const { directory, path } = temporaryDatabase();
    const versionTwo = new DatabaseSync(path);
    const migrationOne = LOCAL_STORE_MIGRATIONS[0];
    const migrationTwo = LOCAL_STORE_MIGRATIONS[1];
    if (migrationOne === undefined || migrationTwo === undefined) {
      throw new Error("missing migration fixture");
    }
    versionTwo.exec(migrationOne.sql);
    versionTwo.exec(migrationTwo.sql);
    versionTwo.exec("PRAGMA user_version = 2");
    versionTwo.close();

    const store = await openLocalStore({ path, clock: fixedClock() });
    expect(store.listCloudMirror({ limit: 10 })).toEqual([]);
    store.close();
    expect(
      readdirSync(directory).some((name) =>
        name.startsWith(".tokenmonster-pre-migration-v2-to-v4-"),
      ),
    ).toBe(true);
  });

  it("migrates v3 to the complete-scan ledger and reopens its evidence", async () => {
    const { directory, path } = temporaryDatabase();
    const versionThree = new DatabaseSync(path);
    for (const migration of LOCAL_STORE_MIGRATIONS.slice(0, 3)) {
      versionThree.exec(migration.sql);
    }
    versionThree.exec("PRAGMA user_version = 3");
    versionThree.close();

    let store = await openLocalStore({ path, clock: fixedClock() });
    expect(
      store.getCompleteDailyScanCoverage({ utcDate: "2026-07-15" }),
    ).toEqual({
      utcDate: "2026-07-15",
      completedClients: [],
      complete: false,
    });
    expect(
      store.recordCompleteDailyScan({
        utcDate: "2026-07-15",
        client: "codex",
      }),
    ).toEqual({
      utcDate: "2026-07-15",
      client: "codex",
      completedAt: NOW,
    });
    store.close();

    store = await openLocalStore({ path, clock: fixedClock() });
    expect(
      store.getCompleteDailyScanCoverage({ utcDate: "2026-07-15" }),
    ).toEqual({
      utcDate: "2026-07-15",
      completedClients: ["codex"],
      complete: false,
    });
    store.close();
    expect(
      readdirSync(directory).some((name) =>
        name.startsWith(".tokenmonster-pre-migration-v3-to-v4-"),
      ),
    ).toBe(true);
  });

  it("rejects unknown and future schemas instead of migrating them", async () => {
    const unknownFixture = temporaryDatabase();
    const unknown = new DatabaseSync(unknownFixture.path);
    unknown.exec(
      "CREATE TABLE raw_events (prompt TEXT); PRAGMA user_version = 0",
    );
    unknown.close();
    await expect(
      openLocalStore({ path: unknownFixture.path }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_SCHEMA",
    });

    const futureFixture = temporaryDatabase();
    const future = new DatabaseSync(futureFixture.path);
    future.exec("PRAGMA user_version = 999");
    future.close();
    await expect(
      openLocalStore({ path: futureFixture.path }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_SCHEMA",
    });
  });

  it("rejects relative paths and use after close with content-free codes", async () => {
    await expect(
      openLocalStore({ path: "relative.sqlite" }),
    ).rejects.toMatchObject({
      code: "INVALID_OPEN_OPTIONS",
    });
    const store = await openLocalStore({ path: ":memory:" });
    store.close();
    expect(() => store.getDiagnosticSummary()).toThrowError(
      expect.objectContaining({ code: "STORE_CLOSED" }),
    );
    store.close();
  });

  it("sanitizes filesystem failures that natively contain the full path", async () => {
    const { directory } = temporaryDatabase();
    const pathCanary = "TOKENMONSTER_PRIVATE_PATH_CANARY_9d31";
    const blockingFile = join(directory, pathCanary);
    writeFileSync(blockingFile, "not-a-directory", { mode: 0o600 });

    let caught: unknown;
    try {
      await openLocalStore({ path: join(blockingFile, "local.sqlite") });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LocalStoreError);
    expect(caught).toMatchObject({ code: "MIGRATION_FAILED" });
    expect(String(caught)).not.toContain(pathCanary);
    expect(caught instanceof Error ? caught.stack : "").not.toContain(
      pathCanary,
    );
    expect(JSON.stringify(caught)).not.toContain(pathCanary);
  });
});

describe("content-blind complete-scan ledger", () => {
  it("records a complete empty scope without inventing a usage row", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });

    for (const client of COMPLETE_SCAN_CLIENTS) {
      expect(
        store.recordCompleteDailyScan({ utcDate: "2026-07-15", client }),
      ).toEqual({ utcDate: "2026-07-15", client, completedAt: NOW });
    }

    expect(store.listDailyAggregates({ limit: 10 })).toEqual([]);
    expect(
      store.getCompleteDailyScanCoverage({ utcDate: "2026-07-15" }),
    ).toEqual({
      utcDate: "2026-07-15",
      completedClients: ["claude", "codex", "gemini", "grok"],
      complete: true,
    });
    store.recordCompleteDailyScan({ utcDate: "2026-07-15", client: "codex" });
    expect(store.getDiagnosticSummary().counts.completeScanScopes).toBe(4);
    store.close();
  });

  it("keeps one to three client scopes incomplete", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    for (const client of COMPLETE_SCAN_CLIENTS.slice(0, 3)) {
      store.recordCompleteDailyScan({ utcDate: "2026-07-15", client });
    }
    expect(
      store.getCompleteDailyScanCoverage({ utcDate: "2026-07-15" }),
    ).toEqual({
      utcDate: "2026-07-15",
      completedClients: ["claude", "codex", "gemini"],
      complete: false,
    });
    store.close();
  });

  it("bounds evidence to the current 35-day UTC retention window", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    expect(() =>
      store.recordCompleteDailyScan({ utcDate: "2026-06-10", client: "codex" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_SCAN_LEDGER" }));
    expect(() =>
      store.recordCompleteDailyScan({ utcDate: "2026-07-16", client: "codex" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_SCAN_LEDGER" }));
    expect(
      store.recordCompleteDailyScan({ utcDate: "2026-06-11", client: "codex" }),
    ).toMatchObject({ utcDate: "2026-06-11", client: "codex" });
    store.close();
  });

  it("strictly rejects unknown fields, accessors, invalid dates, and clients", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    const invalidInputs: readonly unknown[] = [
      { utcDate: "2026-07-15", client: "openai" },
      { utcDate: "2026-02-30", client: "codex" },
      { utcDate: "2026-07-15", client: "codex", completedAt: NOW },
      Object.assign(Object.create({}), {
        utcDate: "2026-07-15",
        client: "codex",
      }),
    ];
    for (const input of invalidInputs) {
      expect(() => store.recordCompleteDailyScan(input)).toThrowError(
        expect.objectContaining({ code: "INVALID_SCAN_LEDGER" }),
      );
    }

    const getter = vi.fn(() => "codex");
    const accessor = Object.defineProperties(
      {},
      {
        utcDate: { value: "2026-07-15", enumerable: true },
        client: { get: getter, enumerable: true },
      },
    );
    expect(() => store.recordCompleteDailyScan(accessor)).toThrowError(
      expect.objectContaining({ code: "INVALID_SCAN_LEDGER" }),
    );
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      store.getCompleteDailyScanCoverage({
        utcDate: "2026-07-15",
        client: "codex",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
    expect(store.getDiagnosticSummary().counts.completeScanScopes).toBe(0);
    store.close();
  });
});

describe("absolute daily projections", () => {
  it("increments only for wire-visible changes and accepts downward and zero corrections", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    expect(store.upsertDailyAggregate(dailyAggregate())).toMatchObject({
      status: "inserted",
      row: { revision: 1, tokens: { total: "2500" } },
    });

    const metadataOnly = dailyAggregate({
      localCoverage: "partial",
      collector: {
        kind: "tokscale",
        adapterVersion: "0.1.1",
        sourceVersion: "4.5.2",
      },
    });
    expect(store.upsertDailyAggregate(metadataOnly)).toMatchObject({
      status: "metadata-updated",
      row: { revision: 1, localCoverage: "partial" },
    });

    const downward = dailyAggregate({
      tokens: {
        input: "100",
        output: "40",
        cacheRead: "10",
        cacheWrite: "0",
        reasoning: "5",
        other: "0",
        total: "150",
      },
    });
    expect(store.upsertDailyAggregate(downward)).toMatchObject({
      status: "updated",
      row: { revision: 2, tokens: { total: "150" } },
    });
    expect(
      store.upsertDailyAggregate(dailyAggregate({ tokens: zeroTokens() })),
    ).toMatchObject({
      status: "updated",
      row: { revision: 3, tokens: { total: "0" } },
    });
    store.close();
  });

  it("updates valueQuality as a projected correction", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    store.upsertDailyAggregate(dailyAggregate());
    expect(
      store.upsertDailyAggregate(dailyAggregate({ valueQuality: "estimated" })),
    ).toMatchObject({ status: "updated", row: { revision: 2 } });
    store.close();
  });

  it("validates an entire bounded batch before committing any row", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    const valid = dailyAggregate({ bucketStart: "2026-07-14T00:00:00.000Z" });
    const invalid = {
      ...dailyAggregate(),
      tokens: { ...zeroTokens(), total: "1" },
    };
    expect(() => store.upsertDailyAggregates([valid, invalid])).toThrowError(
      expect.objectContaining({ code: "INVALID_DAILY_AGGREGATE" }),
    );
    expect(store.listDailyAggregates({ limit: 10 })).toEqual([]);

    expect(() => store.upsertDailyAggregates([valid, valid])).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_DAILY_KEY" }),
    );
    expect(store.listDailyAggregates({ limit: 10 })).toEqual([]);
    store.close();
  });

  it("rolls back earlier writes when a later row exhausts its revision", async () => {
    const { path } = temporaryDatabase();
    let store = await openLocalStore({ path, clock: fixedClock() });
    store.upsertDailyAggregate(dailyAggregate());
    store.close();

    const database = new DatabaseSync(path);
    database
      .prepare(
        `UPDATE usage_daily SET revision = 9007199254740991
         WHERE bucket_start = '2026-07-15T00:00:00.000Z'`,
      )
      .run();
    database.close();

    store = await openLocalStore({ path, clock: fixedClock() });
    expect(() =>
      store.upsertDailyAggregates([
        dailyAggregate({ bucketStart: "2026-07-14T00:00:00.000Z" }),
        dailyAggregate({ tokens: zeroTokens() }),
      ]),
    ).toThrowError(expect.objectContaining({ code: "REVISION_EXHAUSTED" }));
    const persisted = store.listDailyAggregates({ limit: 10 });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      bucketStart: "2026-07-15T00:00:00.000Z",
      revision: Number.MAX_SAFE_INTEGER,
      tokens: { total: "2500" },
    });
    store.close();
  });

  it("commits multi-row transactions and provides deterministic bounded range reads", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    const rows = [
      dailyAggregate({ bucketStart: "2026-07-13T00:00:00.000Z" }),
      dailyAggregate({ bucketStart: "2026-07-14T00:00:00.000Z" }),
      dailyAggregate({ bucketStart: "2026-07-15T00:00:00.000Z" }),
    ];
    expect(store.upsertDailyAggregates(rows)).toHaveLength(3);
    expect(
      store.listDailyAggregates({
        fromInclusive: "2026-07-14T00:00:00.000Z",
        toExclusive: "2026-07-16T00:00:00.000Z",
        limit: 1,
      }),
    ).toMatchObject([{ bucketStart: "2026-07-14T00:00:00.000Z" }]);
    expect(() => store.listDailyAggregates({ limit: 1_001 })).toThrowError(
      expect.objectContaining({ code: "INVALID_QUERY" }),
    );
    store.close();
  });
});

describe("bounded local usage insights", () => {
  function totalOnlyTokens(total: number) {
    return {
      input: String(total),
      output: "0",
      cacheRead: "0",
      cacheWrite: "0",
      reasoning: "0",
      other: "0",
      total: String(total),
    } as const;
  }

  it("summarizes only the selected UTC window without model families", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    store.upsertDailyAggregates([
      dailyAggregate({ tokens: totalOnlyTokens(100) }),
      dailyAggregate({
        bucketStart: "2026-07-14T00:00:00.000Z",
        provider: "anthropic",
        modelFamily: "claude-sonnet",
        tool: "claude-code",
        tokens: totalOnlyTokens(300),
      }),
      dailyAggregate({
        bucketStart: "2026-07-09T00:00:00.000Z",
        provider: "google",
        modelFamily: "gemini-flash",
        tool: "experimental-tool",
        tokens: totalOnlyTokens(600),
      }),
      dailyAggregate({
        bucketStart: "2026-07-08T00:00:00.000Z",
        provider: "xai",
        modelFamily: "grok",
        tool: "grok-build",
        tokens: totalOnlyTokens(1_000),
      }),
      dailyAggregate({
        bucketStart: "2026-06-18T00:00:00.000Z",
        provider: "openrouter",
        modelFamily: "openrouter-other",
        tool: "codex-cli",
        tokens: totalOnlyTokens(500),
      }),
      dailyAggregate({
        bucketStart: "2026-06-17T00:00:00.000Z",
        provider: "other",
        modelFamily: "other",
        tool: "other-tool",
        tokens: totalOnlyTokens(8_000),
      }),
      dailyAggregate({
        bucketStart: "2026-07-16T00:00:00.000Z",
        provider: "other",
        modelFamily: "other",
        tool: "other-tool",
        tokens: totalOnlyTokens(4_000),
      }),
    ]);

    const sevenDays = store.getLocalUsageInsights({ windowDays: 7 });
    expect(sevenDays).toEqual({
      schemaVersion: "1",
      windowDays: 7,
      fromInclusive: "2026-07-09T00:00:00.000Z",
      toExclusive: "2026-07-16T00:00:00.000Z",
      totalTokens: "1000",
      providers: [
        { id: "google", totalTokens: "600", shareBasisPoints: 6000 },
        { id: "anthropic", totalTokens: "300", shareBasisPoints: 3000 },
        { id: "openai", totalTokens: "100", shareBasisPoints: 1000 },
      ],
      tools: [
        { id: "other", totalTokens: "600", shareBasisPoints: 6000 },
        { id: "claude-code", totalTokens: "300", shareBasisPoints: 3000 },
        { id: "codex-cli", totalTokens: "100", shareBasisPoints: 1000 },
      ],
    });
    expect(JSON.stringify(sevenDays)).not.toContain("modelFamily");
    expect(store.getLocalUsageInsights({ windowDays: 28 })).toMatchObject({
      fromInclusive: "2026-06-18T00:00:00.000Z",
      toExclusive: "2026-07-16T00:00:00.000Z",
      totalTokens: "2500",
    });
    store.close();
  });

  it("strictly rejects unsupported windows, extra fields, and accessors", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    expect(() =>
      store.getLocalUsageInsights({ windowDays: 14 }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
    expect(() =>
      store.getLocalUsageInsights({ windowDays: 7, path: "/private" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
    const getter = vi.fn(() => 7);
    const accessor = Object.defineProperty({}, "windowDays", {
      get: getter,
      enumerable: true,
    });
    expect(() => store.getLocalUsageInsights(accessor)).toThrowError(
      expect.objectContaining({ code: "INVALID_QUERY" }),
    );
    expect(getter).not.toHaveBeenCalled();
    store.close();
  });

  it("sums multiple safe rows beyond Number.MAX_SAFE_INTEGER without rounding", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    const maximum = Number.MAX_SAFE_INTEGER.toString();
    const maximumTokens = {
      input: maximum,
      output: "0",
      cacheRead: "0",
      cacheWrite: "0",
      reasoning: "0",
      other: "0",
      total: maximum,
    } as const;
    store.upsertDailyAggregates([
      dailyAggregate({ modelFamily: "gpt-5", tokens: maximumTokens }),
      dailyAggregate({
        modelFamily: "openai-codex",
        tokens: maximumTokens,
      }),
    ]);
    expect(store.getLocalUsageInsights({ windowDays: 7 })).toMatchObject({
      totalTokens: "18014398509481982",
      providers: [
        {
          id: "openai",
          totalTokens: "18014398509481982",
          shareBasisPoints: 10_000,
        },
      ],
      tools: [
        {
          id: "codex-cli",
          totalTokens: "18014398509481982",
          shareBasisPoints: 10_000,
        },
      ],
    });
    store.close();
  });
});

describe("local-only state", () => {
  it("stores strict non-secret config and singleton collector authority", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    expect(store.saveConfig(validConfig())).toEqual(validConfig());
    expect(store.getConfig()).toEqual(validConfig());
    expect(
      store.setCollectorAuthority({
        kind: "tokscale",
        state: "running",
        adapterVersion: "0.1.0",
        sourceVersion: "4.5.2",
      }),
    ).toEqual({
      kind: "tokscale",
      state: "running",
      adapterVersion: "0.1.0",
      sourceVersion: "4.5.2",
      updatedAt: NOW,
    });
    expect(store.getCollectorAuthority()?.state).toBe("running");
    expect(() =>
      store.setCollectorAuthority({
        kind: "tokentracker-bridge",
        state: "running",
        adapterVersion: "0.1.0",
        sourceVersion: "0.79.8",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_AUTHORITY" }));
    const snapshot = ingestSnapshot();
    store.upsertDailyAggregate(dailyAggregate());
    store.recordCompleteDailyScan({ utcDate: "2026-07-15", client: "codex" });
    store.upsertMonsterSnapshot({ state: learningMonsterState(), asOfRevision: 1 });
    store.enqueueCloudSnapshot(snapshot, {
      nextAttemptAt: NOW,
      expiresAt: "2026-08-14T18:00:00.000Z",
    });
    store.recordAcceptedCloudSnapshot(snapshot, ingestReceipt(snapshot));
    store.setLastSuccessfulScanAt(NOW);
    expect(store.clearCollectorAuthority()).toBe(true);
    expect(store.getDiagnosticSummary().counts).toEqual({
      dailyAggregates: 0,
      completeScanScopes: 0,
      cloudMirrorEntries: 0,
      monsterSnapshots: 0,
      cloudOutboxEntries: 0,
    });
    expect(store.getLastSuccessfulScanAt()).toBeNull();
    expect(store.getConfig()).toEqual(validConfig());
    expect(store.clearCollectorAuthority()).toBe(false);
    store.close();
  });

  it("persists only a canonical content-free last scan timestamp", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    expect(store.getLastSuccessfulScanAt()).toBeNull();
    expect(store.setLastSuccessfulScanAt(NOW)).toBe(NOW);
    expect(store.getLastSuccessfulScanAt()).toBe(NOW);
    expect(() =>
      store.setLastSuccessfulScanAt("/private/project/session.json"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
    expect(store.getLastSuccessfulScanAt()).toBe(NOW);
    store.close();
  });

  it("prevents stale or conflicting monster snapshots from overwriting state", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    const state = learningMonsterState();
    expect(
      store.upsertMonsterSnapshot({ state, asOfRevision: 2 }),
    ).toMatchObject({
      status: "inserted",
    });
    expect(
      store.upsertMonsterSnapshot({ state, asOfRevision: 1 }),
    ).toMatchObject({
      status: "stale",
      snapshot: { asOfRevision: 2 },
    });
    expect(
      store.upsertMonsterSnapshot({ state, asOfRevision: 2 }),
    ).toMatchObject({
      status: "unchanged",
    });
    const changed = learningMonsterState({ appearance: { energyBand: "low" } });
    expect(() =>
      store.upsertMonsterSnapshot({ state: changed, asOfRevision: 2 }),
    ).toThrowError(
      expect.objectContaining({ code: "MONSTER_REVISION_CONFLICT" }),
    );
    expect(
      store.upsertMonsterSnapshot({ state: changed, asOfRevision: 3 }),
    ).toMatchObject({
      status: "updated",
      snapshot: { asOfRevision: 3 },
    });
    store.close();
  });

  it("exports only allowlisted content-blind state with explicit truncation", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    store.upsertDailyAggregates([
      dailyAggregate({ bucketStart: "2026-07-14T00:00:00.000Z" }),
      dailyAggregate(),
    ]);
    store.saveConfig(validConfig());
    store.setCollectorAuthority({
      kind: "tokscale",
      state: "running",
      adapterVersion: "0.1.0",
      sourceVersion: "4.5.2",
    });
    store.upsertMonsterSnapshot({
      state: learningMonsterState(),
      asOfRevision: 2,
    });
    const queued = ingestSnapshot();
    store.enqueueCloudSnapshot(queued, {
      nextAttemptAt: NOW,
      expiresAt: "2026-08-14T18:00:00.000Z",
    });

    const exported = store.exportContentBlindState({ maxDailyRows: 1 });
    expect(exported.dailyAggregates).toHaveLength(1);
    expect(exported.dailyAggregatesTruncated).toBe(true);
    expect(exported.monsterSnapshots).toHaveLength(1);
    expect(exported.config).toEqual(validConfig());
    expect(exported.collectorAuthority?.state).toBe("running");
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain(queued.batchId);
    expect(serialized).not.toContain("payload_json");
    expect(() =>
      store.exportContentBlindState({ maxDailyRows: 5_001 }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
    store.close();
  });
});

describe("last-accepted cloud mirror", () => {
  it("keeps server-accepted truth independent from newer local truth", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    store.upsertDailyAggregate(dailyAggregate());
    const accepted = ingestSnapshot();
    expect(
      store.recordAcceptedCloudSnapshot(accepted, ingestReceipt(accepted)),
    ).toMatchObject({
      decisions: [{ status: "inserted", row: { bucket: { revision: 1 } } }],
    });

    store.upsertDailyAggregate(
      dailyAggregate({
        tokens: {
          input: "100",
          output: "40",
          cacheRead: "10",
          cacheWrite: "0",
          reasoning: "5",
          other: "0",
          total: "150",
        },
      }),
    );
    expect(store.listDailyAggregates({ limit: 10 })).toMatchObject([
      { revision: 2, tokens: { total: "150" } },
    ]);
    expect(store.listCloudMirror({ limit: 10 })).toMatchObject([
      {
        bucket: { revision: 1, tokens: { total: "2500" } },
        receipt: { batchId: accepted.batchId },
      },
    ]);
    expect(store.getDiagnosticSummary().counts.cloudMirrorEntries).toBe(1);
    expect(
      JSON.stringify(store.exportContentBlindState({ maxDailyRows: 10 })),
    ).not.toContain(accepted.batchId);
    store.close();
  });

  it("enforces monotonic accepted revisions and equal-revision identity", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    const initial = ingestSnapshot({
      buckets: [{ ...ingestSnapshot().buckets[0]!, revision: 2 }],
    });
    store.recordAcceptedCloudSnapshot(initial, ingestReceipt(initial));

    const replay = ingestSnapshot({ buckets: initial.buckets });
    expect(
      store.recordAcceptedCloudSnapshot(
        replay,
        ingestReceipt(replay, { replayed: true }),
      ),
    ).toMatchObject({ decisions: [{ status: "idempotent" }] });
    expect(store.listCloudMirror({ limit: 10 })[0]?.receipt.batchId).toBe(
      replay.batchId,
    );

    const conflict = ingestSnapshot({
      buckets: [
        {
          ...initial.buckets[0]!,
          modelFamily: "openai-other",
          revision: 1,
        },
        {
          ...initial.buckets[0]!,
          tokens: {
            input: "1",
            output: "0",
            cacheRead: "0",
            cacheWrite: "0",
            reasoning: "0",
            other: "0",
            total: "1",
          },
        },
      ],
    });
    expect(() =>
      store.recordAcceptedCloudSnapshot(conflict, ingestReceipt(conflict)),
    ).toThrowError(
      expect.objectContaining({ code: "CLOUD_MIRROR_REVISION_CONFLICT" }),
    );
    expect(store.listCloudMirror({ limit: 10 })).toHaveLength(1);

    const stale = ingestSnapshot({
      buckets: [{ ...initial.buckets[0]!, revision: 1 }],
    });
    expect(() =>
      store.recordAcceptedCloudSnapshot(stale, ingestReceipt(stale)),
    ).toThrowError(expect.objectContaining({ code: "CLOUD_MIRROR_STALE" }));
    expect(store.listCloudMirror({ limit: 10 })[0]?.receipt.batchId).toBe(
      replay.batchId,
    );
    store.close();
  });

  it("fails closed when a receipt cannot identify every row as accepted", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    const snapshot = ingestSnapshot();
    expect(() =>
      store.recordAcceptedCloudSnapshot(
        snapshot,
        ingestReceipt(snapshot, {
          summary: {
            appliedBuckets: 0,
            staleBuckets: 1,
            idempotentBuckets: 0,
            quarantinedBuckets: 0,
          },
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_CLOUD_MIRROR_RECEIPT" }),
    );
    expect(() =>
      store.recordAcceptedCloudSnapshot(
        snapshot,
        ingestReceipt(snapshot, {
          status: "quarantined",
          summary: {
            appliedBuckets: 0,
            staleBuckets: 0,
            idempotentBuckets: 0,
            quarantinedBuckets: 1,
          },
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_CLOUD_MIRROR_RECEIPT" }),
    );
    const another = ingestSnapshot();
    expect(() =>
      store.recordAcceptedCloudSnapshot(snapshot, ingestReceipt(another)),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_CLOUD_MIRROR_RECEIPT" }),
    );
    expect(store.listCloudMirror({ limit: 10 })).toEqual([]);
    store.close();
  });

  it("plans a higher-revision zero for a missing key without deleting the mirror", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    const accepted = ingestSnapshot();
    store.recordAcceptedCloudSnapshot(accepted, ingestReceipt(accepted));
    const acceptedBucket = accepted.buckets[0]!;

    expect(() =>
      store.planMissingCloudZeroCorrections({
        bucketStart: acceptedBucket.bucketStart,
        collector: accepted.collector,
        presentKeys: [],
        limit: 30,
      } as never),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CLOUD_MIRROR" }));
    expect(() =>
      store.planMissingCloudZeroCorrections({
        bucketStart: acceptedBucket.bucketStart,
        completeScan: true,
        collector: { ...accepted.collector, sourceVersion: "4.5.3" },
        presentKeys: [],
        limit: 30,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CLOUD_MIRROR" }));

    expect(
      store.planMissingCloudZeroCorrections({
        bucketStart: acceptedBucket.bucketStart,
        completeScan: true,
        collector: accepted.collector,
        presentKeys: [
          {
            provider: acceptedBucket.provider,
            modelFamily: acceptedBucket.modelFamily,
            tool: acceptedBucket.tool,
          },
        ],
        limit: 30,
      }),
    ).toEqual({ corrections: [], truncated: false });

    const plan = store.planMissingCloudZeroCorrections({
      bucketStart: acceptedBucket.bucketStart,
      completeScan: true,
      collector: accepted.collector,
      presentKeys: [],
      limit: 30,
    });
    expect(plan).toMatchObject({
      truncated: false,
      corrections: [
        {
          bucket: {
            bucketStart: acceptedBucket.bucketStart,
            revision: 2,
            tokens: { total: "0", reasoning: "0" },
          },
          collector: accepted.collector,
        },
      ],
    });
    expect(store.listCloudMirror({ limit: 10 })[0]?.bucket).toMatchObject({
      revision: 1,
      tokens: { total: "2500" },
    });

    const correction = plan.corrections[0]!;
    const zeroSnapshot = ingestSnapshot({
      collector: correction.collector,
      buckets: [correction.bucket],
    });
    expect(
      store.recordAcceptedCloudSnapshot(
        zeroSnapshot,
        ingestReceipt(zeroSnapshot),
      ),
    ).toMatchObject({ decisions: [{ status: "updated" }] });
    expect(store.listCloudMirror({ limit: 10 })[0]?.bucket).toMatchObject({
      revision: 2,
      tokens: { total: "0" },
    });
    expect(
      store.planMissingCloudZeroCorrections({
        bucketStart: acceptedBucket.bucketStart,
        completeScan: true,
        collector: accepted.collector,
        presentKeys: [],
        limit: 30,
      }),
    ).toEqual({ corrections: [], truncated: false });
    store.close();
  });

  it("bounds mirror reads and destructive clearing", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    const template = ingestSnapshot().buckets[0]!;
    const snapshot = ingestSnapshot({
      buckets: [
        template,
        { ...template, modelFamily: "openai-other", tool: "browser" },
      ],
    });
    store.recordAcceptedCloudSnapshot(snapshot, ingestReceipt(snapshot));
    expect(store.listCloudMirror({ limit: 1 })).toHaveLength(1);
    expect(store.clearCloudMirror({ limit: 1 })).toBe(1);
    expect(store.listCloudMirror({ limit: 10 })).toHaveLength(1);
    expect(() => store.clearCloudMirror({ limit: 1_001 })).toThrowError(
      expect.objectContaining({ code: "INVALID_QUERY" }),
    );
    expect(store.clearCloudMirror({ limit: 10 })).toBe(1);
    store.close();
  });
});

describe("strict cloud outbox", () => {
  it("enqueues idempotently, rejects batch reuse, and lists due entries with a hard bound", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    const snapshot = ingestSnapshot();
    const options = {
      nextAttemptAt: NOW,
      expiresAt: "2026-08-14T18:00:00.000Z",
    } as const;
    expect(store.enqueueCloudSnapshot(snapshot, options)).toBe("inserted");
    expect(store.enqueueCloudSnapshot(snapshot, options)).toBe("idempotent");
    expect(() =>
      store.enqueueCloudSnapshot(
        { ...snapshot, buckets: [{ ...snapshot.buckets[0]!, revision: 2 }] },
        options,
      ),
    ).toThrowError(expect.objectContaining({ code: "OUTBOX_BATCH_CONFLICT" }));
    expect(store.listDueCloudSnapshots({ now: NOW, limit: 1 })).toMatchObject([
      {
        snapshot: { batchId: snapshot.batchId },
        attempts: 0,
        lastErrorCode: null,
      },
    ]);
    expect(() =>
      store.listDueCloudSnapshots({ now: NOW, limit: 31 }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
    store.close();
  });

  it("reschedules without rebuilding a payload, then delivers it", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    const snapshot = ingestSnapshot();
    store.enqueueCloudSnapshot(snapshot, {
      nextAttemptAt: NOW,
      expiresAt: "2026-08-14T18:00:00.000Z",
    });
    expect(
      store.rescheduleCloudSnapshot({
        batchId: snapshot.batchId,
        nextAttemptAt: "2026-07-15T18:01:00.000Z",
        errorCode: "network",
      }),
    ).toBe(true);
    expect(
      store.listDueCloudSnapshots({
        now: "2026-07-15T18:01:00.000Z",
        limit: 1,
      }),
    ).toMatchObject([
      {
        snapshot: { batchId: snapshot.batchId },
        attempts: 1,
        lastErrorCode: "network",
      },
    ]);
    expect(() =>
      store.markCloudSnapshotDelivered(snapshot.batchId),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CLOUD_MIRROR" }));
    store.recordAcceptedCloudSnapshot(snapshot, ingestReceipt(snapshot));
    expect(store.markCloudSnapshotDelivered(snapshot.batchId)).toBe(true);
    expect(store.markCloudSnapshotDelivered(snapshot.batchId)).toBe(false);
    store.close();
  });

  it("enforces the 30-day retention window and purges expired rows", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    const snapshot = ingestSnapshot();
    expect(() =>
      store.enqueueCloudSnapshot(snapshot, {
        nextAttemptAt: NOW,
        expiresAt: "2026-08-14T18:00:00.001Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_OUTBOX_ENTRY" }));
    store.enqueueCloudSnapshot(snapshot, {
      nextAttemptAt: NOW,
      expiresAt: "2026-08-14T18:00:00.000Z",
    });
    expect(store.purgeExpiredCloudSnapshots("2026-08-14T18:00:00.000Z")).toBe(
      1,
    );
    expect(store.clearCloudOutbox()).toBe(0);
    store.close();
  });
});

describe("privacy regressions", () => {
  it("rejects forbidden canaries at every arbitrary-input boundary and never writes them", async () => {
    const { directory, path } = temporaryDatabase();
    const canary = "TOKENMONSTER_FORBIDDEN_PROMPT_CANARY_7f4c";
    const store = await openLocalStore({ path, clock: fixedClock() });
    const mirrorSnapshot = ingestSnapshot();
    const failures: Array<() => unknown> = [
      () =>
        store.upsertDailyAggregate({
          ...dailyAggregate(),
          prompt: canary,
        }),
      () => store.saveConfig({ ...validConfig(), apiKey: canary } as never),
      () =>
        store.setCollectorAuthority({
          kind: "tokscale",
          state: "running",
          adapterVersion: "0.1.0",
          sourceVersion: "4.5.2",
          sourcePath: canary,
        } as never),
      () =>
        store.upsertMonsterSnapshot({
          state: { ...learningMonsterState(), response: canary },
          asOfRevision: 1,
        } as never),
      () =>
        store.enqueueCloudSnapshot(
          { ...ingestSnapshot(), prompt: canary },
          {
            nextAttemptAt: NOW,
            expiresAt: "2026-08-14T18:00:00.000Z",
          },
        ),
      () =>
        store.recordAcceptedCloudSnapshot(mirrorSnapshot, {
          ...ingestReceipt(mirrorSnapshot),
          prompt: canary,
        }),
    ];
    for (const operation of failures) {
      let caught: unknown;
      try {
        operation();
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(LocalStoreError);
      expect(String(caught)).not.toContain(canary);
    }
    expect(store.getDiagnosticSummary().counts).toEqual({
      dailyAggregates: 0,
      completeScanScopes: 0,
      cloudMirrorEntries: 0,
      monsterSnapshots: 0,
      cloudOutboxEntries: 0,
    });
    expect(
      JSON.stringify(store.exportContentBlindState({ maxDailyRows: 10 })),
    ).not.toContain(canary);
    store.close();

    for (const filename of readdirSync(directory)) {
      const bytes = readFileSync(join(directory, filename));
      expect(bytes.includes(Buffer.from(canary))).toBe(false);
    }
  });

  it("diagnostics contain counts and support state, never usage values or outbox bodies", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: fixedClock(),
    });
    const snapshot = ingestSnapshot();
    store.upsertDailyAggregate(dailyAggregate());
    store.enqueueCloudSnapshot(snapshot, {
      nextAttemptAt: NOW,
      expiresAt: "2026-08-14T18:00:00.000Z",
    });
    const diagnostic = JSON.stringify(store.getDiagnosticSummary());
    expect(diagnostic).toContain('"dailyAggregates":1');
    expect(diagnostic).toContain('"cloudOutboxEntries":1');
    expect(diagnostic).not.toContain("2500");
    expect(diagnostic).not.toContain(snapshot.batchId);
    expect(diagnostic).not.toContain("gpt-5");
    expect(diagnostic).not.toContain("payload");
    store.close();
  });
});
