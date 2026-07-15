import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openLocalStore } from "@tokenmonster/local-store";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalDataExport,
  createShareCardSvg,
  createSupportDiagnostic,
  parseFixedJsonExportRequest,
  parseLocalSourceResetRequest,
  parseShareCardSaveRequest,
  writeNewUserSelectedFile
} from "../src/main/local-actions.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("strict local action requests", () => {
  it("copies only fixed share, export, and reset request shapes", () => {
    expect(
      parseShareCardSaveRequest({ windowDays: 7, characterId: "chatgpt" })
    ).toEqual({ windowDays: 7, characterId: "chatgpt" });
    expect(() =>
      parseShareCardSaveRequest({
        windowDays: 7,
        characterId: "chatgpt",
        path: "/private"
      })
    ).toThrow("IPC_REQUEST_REJECTED");
    expect(() =>
      parseShareCardSaveRequest({ windowDays: 14, characterId: "chatgpt" })
    ).toThrow("IPC_REQUEST_REJECTED");
    expect(() => parseFixedJsonExportRequest({ format: "json-v1" })).not.toThrow();
    expect(() => parseFixedJsonExportRequest({ format: "svg" })).toThrow(
      "IPC_REQUEST_REJECTED"
    );
    expect(
      parseLocalSourceResetRequest({
        confirmation: "clear-collector-derived-data"
      })
    ).toEqual({ confirmation: "clear-collector-derived-data" });
  });

  it("never invokes accessors while rejecting a hostile request", () => {
    const getter = vi.fn(() => "chatgpt");
    const input = Object.defineProperties(
      {},
      {
        windowDays: { value: 7, enumerable: true },
        characterId: { get: getter, enumerable: true }
      }
    );
    expect(() => parseShareCardSaveRequest(input)).toThrow(
      "IPC_REQUEST_REJECTED"
    );
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("code-native local share card", () => {
  it("contains only coarse summary labels and no identifiers, paths, or models", () => {
    const svg = createShareCardSvg("chatgpt", {
      schemaVersion: "1",
      windowDays: 7,
      fromInclusive: "2026-07-09T00:00:00.000Z",
      toExclusive: "2026-07-16T00:00:00.000Z",
      totalTokens: "2500",
      providers: [
        { id: "openai", totalTokens: "2500", shareBasisPoints: 10_000 }
      ],
      tools: [
        { id: "codex-cli", totalTokens: "2500", shareBasisPoints: 10_000 }
      ]
    });

    expect(svg).toContain("TokenMonster 本機足跡分享卡");
    expect(svg).toContain("Aster");
    expect(svg).toContain("OpenAI");
    expect(svg).toContain("Codex CLI");
    expect(svg).toContain("僅含這台裝置的內容盲摘要");
    expect(svg).not.toContain("未分享至雲端");
    for (const canary of [
      "characterId",
      "modelFamily",
      "gpt-5",
      "account-id",
      "/private/project",
      "sk-private"
    ]) {
      expect(svg).not.toContain(canary);
    }
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("href=");
  });
});

describe("explicit user-selected file writes", () => {
  it("creates a private new file and refuses overwrite or wrong extensions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-export-"));
    directories.push(directory);
    const selected = join(directory, "tokenmonster-local-summary.svg");
    await expect(
      writeNewUserSelectedFile({
        filePath: selected,
        extension: ".svg",
        content: "<svg/>\n"
      })
    ).resolves.toEqual({ status: "saved" });
    expect(await readFile(selected, "utf8")).toBe("<svg/>\n");
    if (process.platform !== "win32") {
      expect((await stat(selected)).mode & 0o777).toBe(0o600);
    }
    await expect(
      writeNewUserSelectedFile({
        filePath: selected,
        extension: ".svg",
        content: "replacement"
      })
    ).resolves.toEqual({ status: "already-exists" });
    expect(await readFile(selected, "utf8")).toBe("<svg/>\n");
    await expect(
      writeNewUserSelectedFile({
        filePath: join(directory, "wrong.txt"),
        extension: ".json",
        content: "{}"
      })
    ).resolves.toEqual({ status: "invalid-selection" });

    const existing = join(directory, "existing.json");
    await writeFile(existing, "original", "utf8");
    await expect(
      writeNewUserSelectedFile({
        filePath: existing,
        extension: ".json",
        content: "new"
      })
    ).resolves.toEqual({ status: "already-exists" });
  });
});

describe("local data and support diagnostic separation", () => {
  it("keeps usage rows out of the content-free support diagnostic", async () => {
    const store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date("2026-07-15T18:00:00.000Z")
    });
    store.upsertDailyAggregate({
      bucketStart: "2026-07-15T00:00:00.000Z",
      provider: "openai",
      modelFamily: "gpt-5",
      tool: "codex-cli",
      valueQuality: "exact",
      tokens: {
        input: "10",
        output: "5",
        cacheRead: "0",
        cacheWrite: "0",
        reasoning: "0",
        other: "0",
        total: "15"
      },
      localCoverage: "complete",
      collector: {
        kind: "tokscale",
        adapterVersion: "0.1.0",
        sourceVersion: "4.5.2"
      }
    });

    const localData = createLocalDataExport(store);
    const diagnostic = createSupportDiagnostic({
      generatedAt: "2026-07-15T18:00:00.000Z",
      appVersion: "0.1.0",
      platform: "linux",
      localStore: store.getDiagnosticSummary()
    });
    expect(localData).toContain('"kind": "tokenmonster-local-data"');
    expect(localData).toContain('"dailyAggregates"');
    expect(diagnostic).toContain(
      '"kind": "tokenmonster-support-diagnostic"'
    );
    expect(diagnostic).toContain('"dailyAggregates": 1');
    for (const excluded of [
      "gpt-5",
      "codex-cli",
      "bucketStart",
      "/private"
    ]) {
      expect(diagnostic).not.toContain(excluded);
    }
    store.close();
  });
});
