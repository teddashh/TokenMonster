import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LOCAL_PROGRESSION_DIRECTORY_NAME,
  LOCAL_PROGRESSION_FILE_NAME,
  LOCAL_PROGRESSION_PRIVACY_POLICY,
  LocalProgressionStoreSchema,
  createEmptyLocalProgressionStore,
  loadLocalProgressionStore,
  mergeAndSaveDailyProviderBuckets,
  mergeDailyProviderBuckets,
  resolveLocalProgressionStorePath,
  resolvePersistedSisterSelection,
  saveLocalProgressionStore,
  sisterProviderTotalsFromLifetime,
  withAutomaticStarterSelection,
  withManualSisterSelection,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tokenmonster-progression-"));
  temporaryDirectories.push(directory);
  return join(directory, "local", LOCAL_PROGRESSION_FILE_NAME);
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
      schemaVersion: "1",
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
});

describe("local sister preference persistence", () => {
  it("persists an auto-starter once and gives a manual override precedence", () => {
    const empty = createEmptyLocalProgressionStore();
    const automatic = withAutomaticStarterSelection(
      empty,
      { openai: 10, anthropic: 20, google: 0, xai: 0 },
      "2026-07-15T10:00:00.000Z",
    );
    const laterLeaderDoesNotHop = withAutomaticStarterSelection(
      automatic,
      { openai: 100, anthropic: 20, google: 0, xai: 0 },
      "2026-07-16T10:00:00.000Z",
    );
    expect(resolvePersistedSisterSelection(laterLeaderDoesNotHop.selection)).toEqual({
      characterId: "claude",
      selectedBy: "auto",
      selectedAt: "2026-07-15T10:00:00.000Z",
    });

    const manual = withManualSisterSelection(
      laterLeaderDoesNotHop,
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

  it("does not auto-select on zero data or a highest-total tie", () => {
    const empty = createEmptyLocalProgressionStore();
    const zero = withAutomaticStarterSelection(
      empty,
      { openai: 0, anthropic: 0, google: 0, xai: 0 },
      "2026-07-16T10:00:00.000Z",
    );
    const tie = withAutomaticStarterSelection(
      zero,
      { openai: 10, anthropic: 10, google: 0, xai: 0 },
      "2026-07-16T10:00:00.000Z",
    );
    expect(resolvePersistedSisterSelection(tie.selection)).toBeNull();
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
