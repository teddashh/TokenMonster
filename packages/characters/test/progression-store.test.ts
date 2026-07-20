import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  LOCAL_PROGRESSION_DIRECTORY_NAME,
  LOCAL_PROGRESSION_FILE_NAME,
  LOCAL_PROGRESSION_PRIVACY_POLICY,
  LOCAL_PROGRESSION_STORE_SCHEMA_VERSION,
  LocalProgressionStoreError,
  LocalProgressionStoreSchema,
  createEmptyLocalProgressionStore,
  evaluateProgression,
  loadLocalProgressionStore,
  mergeAndSaveDailyProviderBuckets,
  mergeDailyProviderBuckets,
  repairLegacyProgressionStoreLock,
  resolveLocalProgressionStorePath,
  resolvePersistedSisterSelection,
  saveLocalProgressionStore,
  sisterProviderTotalsFromLifetime,
  withManualSisterSelection,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
const PROGRESSION_STORE_CHILD = fileURLToPath(
  new URL("./progression-store-child.mjs", import.meta.url),
);
const LEGACY_LOCK_WRITER_CHILD = fileURLToPath(
  new URL("./progression-store-legacy-writer-child.mjs", import.meta.url),
);

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tokenmonster-progression-"));
  temporaryDirectories.push(directory);
  return join(directory, "local", LOCAL_PROGRESSION_FILE_NAME);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("local progression lifetime store", () => {
  it("uses the sidecar-era TokenMonster home convention without returning a path DTO", () => {
    expect(LOCAL_PROGRESSION_STORE_SCHEMA_VERSION).toBe("1");
    expect(LOCAL_PROGRESSION_FILE_NAME).toBe("progression-v1.json");
    expect(
      resolveLocalProgressionStorePath({ homeDirectory: "/home/example" }),
    ).toBe(
      join(
        "/home/example",
        LOCAL_PROGRESSION_DIRECTORY_NAME,
        LOCAL_PROGRESSION_FILE_NAME,
      ),
    );
    expect(LOCAL_PROGRESSION_PRIVACY_POLICY).toEqual({
      schemaVersion: "2",
      persistence: "local-preference-and-aggregate-only",
      leavesDevice: false,
      contentFieldsAccepted: [],
    });
  });

  it("merges rescanned day/provider buckets by max and remains idempotent", () => {
    const empty = createEmptyLocalProgressionStore();
    const once = mergeDailyProviderBuckets(empty, [
      {
        utcDate: "2026-07-15",
        providerTotals: { openai: 10, anthropic: 4 },
      },
    ]);
    const replayed = mergeDailyProviderBuckets(once, [
      {
        utcDate: "2026-07-15",
        providerTotals: { openai: 10, anthropic: 4 },
      },
    ]);
    const grown = mergeDailyProviderBuckets(replayed, [
      {
        utcDate: "2026-07-15",
        providerTotals: { openai: 12, anthropic: 3 },
      },
      {
        utcDate: "2026-07-16",
        providerTotals: { openai: 5 },
      },
    ]);

    expect(replayed).toEqual(once);
    expect(grown.lifetime.dailyProviderBuckets).toEqual([
      {
        utcDate: "2026-07-15",
        providerTotals: { openai: 12, anthropic: 4 },
      },
      {
        utcDate: "2026-07-16",
        providerTotals: { openai: 5 },
      },
    ]);
    expect(grown.lifetime.providerTotals).toMatchObject({
      openai: 17,
      anthropic: 4,
    });
    expect(grown.lifetime.lifetimeTotal).toBe(21);
    expect(grown.lifetime.activeDays).toBe(2);
    expect(LocalProgressionStoreSchema.parse(grown)).toBeDefined();
  });

  it("takes the max across duplicate buckets within the same delivery", () => {
    const merged = mergeDailyProviderBuckets(createEmptyLocalProgressionStore(), [
      { utcDate: "2026-07-16", providerTotals: { openai: 9 } },
      { utcDate: "2026-07-16", providerTotals: { openai: 12, google: 2 } },
    ]);
    expect(merged.lifetime.dailyProviderBuckets).toEqual([
      {
        utcDate: "2026-07-16",
        providerTotals: { openai: 12, google: 2 },
      },
    ]);
    expect(merged.lifetime.lifetimeTotal).toBe(14);
  });

  it("writes atomically and reloads a versioned strict document", async () => {
    const path = await temporaryPath();
    const store = mergeDailyProviderBuckets(createEmptyLocalProgressionStore(), [
      { utcDate: "2026-07-16", providerTotals: { qwen: 25 } },
    ]);
    await saveLocalProgressionStore(store, { path });

    const loaded = await loadLocalProgressionStore({ path });
    expect(loaded).toEqual({ store, corruptionRecovered: false });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(store);
    expect((await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("loads lifetime provider totals regardless of serialized key order", async () => {
    const path = await temporaryPath();
    const store = mergeDailyProviderBuckets(createEmptyLocalProgressionStore(), [
      { utcDate: "2026-07-16", providerTotals: { openai: 9, google: 2 } },
    ]);
    const serialized = JSON.parse(JSON.stringify(store)) as {
      lifetime: { providerTotals: Record<string, number> };
    };
    serialized.lifetime.providerTotals = Object.fromEntries(
      Object.entries(serialized.lifetime.providerTotals).reverse(),
    );
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(serialized), "utf8");

    const loaded = await loadLocalProgressionStore({ path });
    expect(loaded.corruptionRecovered).toBe(false);
    expect(loaded.store).toEqual(store);
  });

  it("preserves unknown unlock keys and drops only malformed timestamps", async () => {
    const path = await temporaryPath();
    const store = mergeDailyProviderBuckets(createEmptyLocalProgressionStore(), [
      { utcDate: "2026-07-16", providerTotals: { anthropic: 12 } },
    ]);
    const serialized = {
      ...store,
      unlockedAt: {
        "character:claude": "2026-07-16T12:00:00.000Z",
        "future-kind:new-character:new-item": "2026-07-16T12:01:00.000Z",
        "character:chatgpt": "not-a-timestamp",
      },
    };
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(serialized), "utf8");

    const loaded = await loadLocalProgressionStore({ path });
    expect(loaded.corruptionRecovered).toBe(false);
    expect(loaded.store.lifetime).toEqual(store.lifetime);
    expect(loaded.store.unlockedAt).toEqual({
      "character:claude": "2026-07-16T12:00:00.000Z",
      "future-kind:new-character:new-item": "2026-07-16T12:01:00.000Z",
    });

    await saveLocalProgressionStore(loaded.store, { path });
    const roundTripped = JSON.parse(await readFile(path, "utf8")) as {
      unlockedAt: Record<string, string>;
    };
    expect(roundTripped.unlockedAt).toEqual(loaded.store.unlockedAt);
  });

  it("recovers corrupted JSON to an empty safe state and reports the flag", async () => {
    const path = await temporaryPath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{not valid JSON", "utf8");

    const loaded = await loadLocalProgressionStore({ path });
    expect(loaded.corruptionRecovered).toBe(true);
    expect(loaded.store).toEqual(createEmptyLocalProgressionStore());
    expect(LocalProgressionStoreSchema.parse(JSON.parse(await readFile(path, "utf8")))).toEqual(
      loaded.store,
    );
  });

  it("preserves the corruption flag while merging and saving new buckets", async () => {
    const path = await temporaryPath();
    const directory = join(path, "..");
    await mkdir(directory, { recursive: true });
    await writeFile(path, JSON.stringify({ schemaVersion: "future" }), "utf8");
    const merged = await mergeAndSaveDailyProviderBuckets(
      [{ utcDate: "2026-07-16", providerTotals: { xai: 2 } }],
      { path },
    );
    expect(merged.corruptionRecovered).toBe(true);
    expect(merged.store.lifetime.providerTotals.xai).toBe(2);
  });

  it("retries a held lock and reports a typed store-busy error", async () => {
    const path = await temporaryPath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      `${path}.lock`,
      `${JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const error = await mergeAndSaveDailyProviderBuckets(
      [{ utcDate: "2026-07-16", providerTotals: { openai: 1 } }],
      { path },
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(LocalProgressionStoreError);
    expect(error).toMatchObject({
      name: "LocalProgressionStoreError",
      code: "store-busy",
    });
  });

  it("does not steal a fresh zero-byte lock while its writer may still be starting", async () => {
    const path = await temporaryPath();
    await mkdir(join(path, ".."), { recursive: true });
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, "", { encoding: "utf8", mode: 0o600 });

    const error = await mergeAndSaveDailyProviderBuckets(
      [{ utcDate: "2026-07-16", providerTotals: { openai: 1 } }],
      { path },
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(LocalProgressionStoreError);
    expect(error).toMatchObject({ code: "store-busy" });
    await expect(readFile(lockPath, "utf8")).resolves.toBe("");
  });

  it("does not steal an old valid lock while its recorded owner is alive", async () => {
    const path = await temporaryPath();
    await mkdir(join(path, ".."), { recursive: true });
    const lockPath = `${path}.lock`;
    const lockContents = `${JSON.stringify({
      pid: process.pid,
      createdAt: "2000-01-01T00:00:00.000Z",
      ownerId: "live-owner",
    })}\n`;
    await writeFile(lockPath, lockContents, {
      encoding: "utf8",
      mode: 0o600,
    });

    const error = await mergeAndSaveDailyProviderBuckets(
      [{ utcDate: "2026-07-16", providerTotals: { openai: 1 } }],
      { path },
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(LocalProgressionStoreError);
    expect(error).toMatchObject({ code: "store-busy" });
    await expect(readFile(lockPath, "utf8")).resolves.toBe(lockContents);
  });

  it("does not steal an old queue ticket while its recorded owner is alive", async () => {
    const path = await temporaryPath();
    const queueDirectory = `${path}.lock-queue`;
    await mkdir(queueDirectory, { recursive: true, mode: 0o700 });
    const ownerId = "00000000-0000-4000-8000-000000000001";
    const ticketPath = join(queueDirectory, `ticket-${ownerId}.json`);
    const ticketContents = `${JSON.stringify({
      phase: "ticket",
      pid: process.pid,
      createdAt: "2000-01-01T00:00:00.000Z",
      ownerId,
      ticket: 1,
    })}\n`;
    await writeFile(ticketPath, ticketContents, {
      encoding: "utf8",
      mode: 0o600,
    });

    const error = await mergeAndSaveDailyProviderBuckets(
      [{ utcDate: "2026-07-16", providerTotals: { openai: 1 } }],
      { path },
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(LocalProgressionStoreError);
    expect(error).toMatchObject({ code: "store-busy" });
    await expect(readFile(ticketPath, "utf8")).resolves.toBe(ticketContents);
    expect(await readdir(queueDirectory)).toEqual([
      `ticket-${ownerId}.json`,
    ]);
  });

  it.each(["choosing", "ticket"] as const)(
    "recovers a freshly published %s queue record whose owner is dead",
    async (phase) => {
      const path = await temporaryPath();
      const queueDirectory = `${path}.lock-queue`;
      await mkdir(queueDirectory, { recursive: true, mode: 0o700 });
      const ownerId =
        phase === "choosing"
          ? "00000000-0000-4000-8000-000000000002"
          : "00000000-0000-4000-8000-000000000003";
      await writeFile(
        join(queueDirectory, `${phase}-${ownerId}.json`),
        `${JSON.stringify({
          phase,
          pid: 2_147_483_647,
          createdAt: new Date().toISOString(),
          ownerId,
          ...(phase === "ticket" ? { ticket: 1 } : {}),
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );

      const merged = await mergeAndSaveDailyProviderBuckets(
        [{ utcDate: "2026-07-16", providerTotals: { google: 3 } }],
        { path },
      );
      expect(merged.store.lifetime.providerTotals.google).toBe(3);
      expect(await readdir(queueDirectory)).toEqual([]);
    },
  );

  it.each(["", "{"])(
    "repairs stale rc.7 crash-window lock %j only after explicit shutdown",
    async (lockContents) => {
      const path = await temporaryPath();
      await mkdir(join(path, ".."), { recursive: true });
      const lockPath = `${path}.lock`;
      await writeFile(lockPath, lockContents, {
        encoding: "utf8",
        mode: 0o600,
      });
      const staleTime = new Date(Date.now() - 60_000);
      await utimes(lockPath, staleTime, staleTime);

      const error = await mergeAndSaveDailyProviderBuckets(
        [{ utcDate: "2026-07-16", providerTotals: { google: 3 } }],
        { path },
      ).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(LocalProgressionStoreError);
      expect(error).toMatchObject({ code: "store-busy" });
      await expect(readFile(lockPath, "utf8")).resolves.toBe(lockContents);

      await expect(
        repairLegacyProgressionStoreLock({
          path,
          confirmedOldVersionsClosed: true,
        }),
      ).resolves.toBe("repaired");
      const merged = await mergeAndSaveDailyProviderBuckets(
        [{ utcDate: "2026-07-16", providerTotals: { google: 3 } }],
        { path },
      );
      expect(merged.store.lifetime.providerTotals.google).toBe(3);
      await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("never steals an aged empty rc.7 lock from a live paused writer", async () => {
    const path = await temporaryPath();
    const directory = join(path, "..");
    await mkdir(directory, { recursive: true });
    const lockPath = `${path}.lock`;
    const readyPath = join(directory, "legacy-writer-ready");
    const goPath = join(directory, "legacy-writer-go");
    const child = spawn(
      process.execPath,
      [LEGACY_LOCK_WRITER_CHILD, lockPath, readyPath, goPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    let stdout = "";
    child.stderr?.setEncoding("utf8");
    child.stdout?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const completion = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    try {
      let ready = false;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (await pathExists(readyPath)) {
          ready = true;
          break;
        }
        await delay(10);
      }
      expect(ready).toBe(true);
      const staleTime = new Date(Date.now() - 60_000);
      await utimes(lockPath, staleTime, staleTime);

      const error = await mergeAndSaveDailyProviderBuckets(
        [{ utcDate: "2026-07-16", providerTotals: { google: 3 } }],
        { path },
      ).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(LocalProgressionStoreError);
      expect(error).toMatchObject({ code: "store-busy" });
      await expect(readFile(lockPath, "utf8")).resolves.toBe("");

      await writeFile(goPath, "go\n", { flag: "wx", mode: 0o600 });
      await expect(completion).resolves.toEqual({ code: 0, signal: null });
      expect(stderr).toBe("");
      expect(stdout.trim()).toBe("owner-visible");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }

    const merged = await mergeAndSaveDailyProviderBuckets(
      [{ utcDate: "2026-07-16", providerTotals: { google: 3 } }],
      { path },
    );
    expect(merged.store.lifetime.providerTotals.google).toBe(3);
  });

  it("does not steal a valid stale rc.7 lock with no cooperating old owner", async () => {
    const path = await temporaryPath();
    await mkdir(join(path, ".."), { recursive: true });
    const lockPath = `${path}.lock`;
    const lockContents = `${JSON.stringify({
      pid: 2_147_483_647,
      createdAt: "2000-01-01T00:00:00.000Z",
    })}\n`;
    await writeFile(
      lockPath,
      lockContents,
      { encoding: "utf8", mode: 0o600 },
    );

    const error = await mergeAndSaveDailyProviderBuckets(
      [{ utcDate: "2026-07-16", providerTotals: { google: 3 } }],
      { path },
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(LocalProgressionStoreError);
    expect(error).toMatchObject({ code: "store-busy" });
    await expect(readFile(lockPath, "utf8")).resolves.toBe(lockContents);
  });

  it("repairs a stale rc.7 crash lock only after explicit old-version shutdown", async () => {
    const path = await temporaryPath();
    await mkdir(join(path, ".."), { recursive: true });
    const lockPath = `${path}.lock`;
    const lockContents = `${JSON.stringify({
      pid: 2_147_483_647,
      createdAt: "2000-01-01T00:00:00.000Z",
      ownerId: "dead-rc7-owner",
    })}\n`;
    await writeFile(lockPath, lockContents, {
      encoding: "utf8",
      mode: 0o600,
    });
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    await expect(
      repairLegacyProgressionStoreLock({
        path,
        confirmedOldVersionsClosed: false as true,
      }),
    ).resolves.toBe("busy");
    await expect(readFile(lockPath, "utf8")).resolves.toBe(lockContents);

    await expect(
      repairLegacyProgressionStoreLock({
        path,
        confirmedOldVersionsClosed: true,
      }),
    ).resolves.toBe("repaired");
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(`${path}.lock-queue`)).toEqual([]);

    const merged = await mergeAndSaveDailyProviderBuckets(
      [{ utcDate: "2026-07-16", providerTotals: { google: 3 } }],
      { path },
    );
    expect(merged.store.lifetime.providerTotals.google).toBe(3);
  });

  it("keeps fresh or live rc.7 locks busy during explicit repair", async () => {
    const path = await temporaryPath();
    await mkdir(join(path, ".."), { recursive: true });
    const lockPath = `${path}.lock`;
    const freshDeadLock = `${JSON.stringify({
      pid: 2_147_483_647,
      createdAt: new Date().toISOString(),
    })}\n`;
    await writeFile(lockPath, freshDeadLock, {
      encoding: "utf8",
      mode: 0o600,
    });
    await expect(
      repairLegacyProgressionStoreLock({
        path,
        confirmedOldVersionsClosed: true,
      }),
    ).resolves.toBe("busy");
    await expect(readFile(lockPath, "utf8")).resolves.toBe(freshDeadLock);

    const liveLock = `${JSON.stringify({
      pid: process.pid,
      createdAt: "2000-01-01T00:00:00.000Z",
    })}\n`;
    await writeFile(lockPath, liveLock, "utf8");
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);
    await expect(
      repairLegacyProgressionStoreLock({
        path,
        confirmedOldVersionsClosed: true,
      }),
    ).resolves.toBe("busy");
    await expect(readFile(lockPath, "utf8")).resolves.toBe(liveLock);
  });

  it("reports that repair is not needed when no progression lock exists", async () => {
    const path = await temporaryPath();
    await expect(
      repairLegacyProgressionStoreLock({
        path,
        confirmedOldVersionsClosed: true,
      }),
    ).resolves.toBe("not-needed");
    expect(await readdir(`${path}.lock-queue`)).toEqual([]);
  });

  it("does not broaden explicit rc.7 repair to non-file locks", async () => {
    const path = await temporaryPath();
    await mkdir(join(path, ".."), { recursive: true });
    const lockPath = `${path}.lock`;
    await mkdir(lockPath);
    await expect(
      repairLegacyProgressionStoreLock({
        path,
        confirmedOldVersionsClosed: true,
      }),
    ).resolves.toBe("busy");
    expect(await readdir(`${path}.lock-queue`)).toEqual([]);
  });

  it("immediately recovers a v2 interlock whose owner is dead", async () => {
    const path = await temporaryPath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      `${path}.lock`,
      `tokenmonster-store-lock-v2:${JSON.stringify({
        pid: 2_147_483_647,
        createdAt: new Date().toISOString(),
        ownerId: "00000000-0000-4000-8000-000000000004",
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const merged = await mergeAndSaveDailyProviderBuckets(
      [{ utcDate: "2026-07-16", providerTotals: { google: 3 } }],
      { path },
    );
    expect(merged.store.lifetime.providerTotals.google).toBe(3);
    await expect(readFile(`${path}.lock`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it(
    "preserves every synchronized process update after explicit legacy repair",
    async () => {
      const processCount = 10;
      for (let round = 0; round < 6; round += 1) {
        const path = await temporaryPath();
        const directory = join(path, "..");
        await mkdir(directory, { recursive: true });
        const legacyLockPath = `${path}.lock`;
        await writeFile(legacyLockPath, "", { mode: 0o600 });
        const staleTime = new Date(Date.now() - 60_000);
        await utimes(legacyLockPath, staleTime, staleTime);
        await expect(
          repairLegacyProgressionStoreLock({
            path,
            confirmedOldVersionsClosed: true,
          }),
        ).resolves.toBe("repaired");

        const goPath = join(directory, `go-${round}`);
        const expectedDates = Array.from({ length: processCount }, (_, index) =>
          new Date(Date.UTC(2026, 6, index + 1)).toISOString().slice(0, 10),
        );
        const children: ReturnType<typeof spawn>[] = [];
        const readyPaths: string[] = [];
        const completions: Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
          stderr: string;
          stdout: string;
        }>[] = [];
        try {
          for (let index = 0; index < processCount; index += 1) {
            const readyPath = join(directory, `ready-${round}-${index}`);
            readyPaths.push(readyPath);
            const child = spawn(
              process.execPath,
              [
                PROGRESSION_STORE_CHILD,
                path,
                expectedDates[index]!,
                String(index + 1),
                readyPath,
                goPath,
              ],
              { stdio: ["ignore", "pipe", "pipe"] },
            );
            children.push(child);
            let stderr = "";
            let stdout = "";
            child.stderr?.setEncoding("utf8");
            child.stdout?.setEncoding("utf8");
            child.stderr?.on("data", (chunk: string) => {
              stderr += chunk;
            });
            child.stdout?.on("data", (chunk: string) => {
              stdout += chunk;
            });
            completions.push(
              new Promise((resolve, reject) => {
                child.once("error", reject);
                child.once("close", (code, signal) => {
                  resolve({ code, signal, stderr, stdout });
                });
              }),
            );
          }

          let ready = false;
          // Leave room for cold Node imports on resource-constrained CI hosts
          // without overtaking the child's own 60-second shared-go barrier.
          const readyDeadline = Date.now() + 30_000;
          while (Date.now() < readyDeadline) {
            if ((await Promise.all(readyPaths.map(pathExists))).every(Boolean)) {
              ready = true;
              break;
            }
            await delay(10);
          }
          expect(ready).toBe(true);
          await writeFile(goPath, "go\n", { flag: "wx", mode: 0o600 });
          const results = await Promise.all(completions);
          expect(
            results.map(({ code, signal, stderr, stdout }) => ({
              code,
              signal,
              stderr,
              stdout: stdout.trim(),
            })),
          ).toEqual(
            expectedDates.map((utcDate) => ({
              code: 0,
              signal: null,
              stderr: "",
              stdout: utcDate,
            })),
          );
        } finally {
          for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill();
            }
          }
          await Promise.allSettled(completions);
        }

        const loaded = await loadLocalProgressionStore({ path });
        expect(
          loaded.store.lifetime.dailyProviderBuckets.map(
            ({ utcDate }) => utcDate,
          ),
        ).toEqual(expectedDates);
        expect(loaded.store.lifetime.providerTotals.openai).toBe(55);
        await expect(readFile(legacyLockPath, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readdir(`${path}.lock-queue`)).toEqual([]);
      }
    },
    180_000,
  );

  it("folds buckets older than 366 days into an optional baseline", async () => {
    const path = await temporaryPath();
    const merged = await mergeAndSaveDailyProviderBuckets(
      [
        { utcDate: "2025-07-14", providerTotals: { openai: 7, qwen: 2 } },
        { utcDate: "2026-07-16", providerTotals: { openai: 5 } },
      ],
      { path },
    );

    expect(merged.store.lifetime.dailyProviderBuckets).toEqual([
      { utcDate: "2026-07-16", providerTotals: { openai: 5 } },
    ]);
    expect(merged.store.lifetime.baseline).toMatchObject({ openai: 7, qwen: 2 });
    expect(merged.store.lifetime.providerTotals).toMatchObject({
      openai: 12,
      qwen: 2,
    });
    expect(merged.store.lifetime.lifetimeTotal).toBe(14);
    expect(merged.store.lifetime.activeDays).toBe(2);

    const evaluated = evaluateProgression({
      schemaVersion: "2",
      evaluatedAt: "2026-07-16T12:00:00.000Z",
      evaluationUtcDate: "2026-07-16",
      baseline: merged.store.lifetime.baseline,
      baselineActiveDays: merged.store.lifetime.baselineActiveDays,
      dailyProviderBuckets: merged.store.lifetime.dailyProviderBuckets,
      traitIds: [],
      persistedUnlockedAt: {},
      selection: merged.store.selection,
    });
    expect(evaluated.counters.providerTotals.openai).toBe(12);
    expect(evaluated.counters.lifetimeTotal).toBe(14);
    expect(evaluated.counters.activeDays).toBe(2);

    const replayed = await mergeAndSaveDailyProviderBuckets(
      [{ utcDate: "2025-07-14", providerTotals: { openai: 7, qwen: 2 } }],
      { path },
    );
    expect(replayed.store.lifetime).toEqual(merged.store.lifetime);
  });

  it("continues to load schema-version-one files without a baseline", async () => {
    const path = await temporaryPath();
    const store = mergeDailyProviderBuckets(createEmptyLocalProgressionStore(), [
      { utcDate: "2026-07-16", providerTotals: { xai: 4 } },
    ]);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(store), "utf8");

    const loaded = await loadLocalProgressionStore({ path });
    expect(loaded.corruptionRecovered).toBe(false);
    expect(loaded.store.lifetime.baseline).toBeUndefined();
    expect(loaded.store).toEqual(store);
  });
});

describe("local sister preference persistence", () => {
  it("preserves a legacy auto-starter and gives a manual override precedence", () => {
    const empty = createEmptyLocalProgressionStore();
    const legacy = LocalProgressionStoreSchema.parse({
      ...empty,
      selection: {
        ...empty.selection,
        autoStarterCharacterId: "claude",
        autoStarterSelectedAt: "2026-07-15T10:00:00.000Z",
      },
    });
    expect(resolvePersistedSisterSelection(legacy.selection)).toEqual({
      characterId: "claude",
      selectedBy: "auto",
      selectedAt: "2026-07-15T10:00:00.000Z",
    });

    const manual = withManualSisterSelection(
      legacy,
      "grok",
      "2026-07-16T11:00:00.000Z",
    );
    expect(resolvePersistedSisterSelection(manual.selection)).toEqual({
      characterId: "grok",
      selectedBy: "manual",
      selectedAt: "2026-07-16T11:00:00.000Z",
    });

    const cleared = withManualSisterSelection(
      manual,
      null,
      "2026-07-16T12:00:00.000Z",
    );
    expect(resolvePersistedSisterSelection(cleared.selection)).toEqual({
      characterId: "claude",
      selectedBy: "auto",
      selectedAt: "2026-07-15T10:00:00.000Z",
    });
  });

  it("starts without any persisted selection", () => {
    expect(
      resolvePersistedSisterSelection(
        createEmptyLocalProgressionStore().selection,
      ),
    ).toBeNull();
  });

  it("projects only the four sister totals from lifetime counters", () => {
    const store = mergeDailyProviderBuckets(createEmptyLocalProgressionStore(), [
      {
        utcDate: "2026-07-16",
        providerTotals: { openai: 1, anthropic: 2, google: 3, xai: 4, glm: 99 },
      },
    ]);
    expect(sisterProviderTotalsFromLifetime(store.lifetime.providerTotals)).toEqual({
      openai: 1,
      anthropic: 2,
      google: 3,
      xai: 4,
    });
  });
});
