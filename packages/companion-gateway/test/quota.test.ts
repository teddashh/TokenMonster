import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  QUOTA_CATALOG_FAMILIES,
  QUOTA_PLAN_CATALOG,
  dailyEquivalentBudget,
  loadQuotaPlanSelections,
  quotaWindowStart,
  remainingQuotaPercent,
  saveQuotaPlanSelections,
  withQuotaPlanSelection
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("quota catalog", () => {
  it("contains unique plans with valid family-owned windows and budgets", () => {
    const ids = new Set<string>();
    expect(QUOTA_CATALOG_FAMILIES).toEqual([
      "anthropic",
      "openai",
      "google",
      "xai"
    ]);
    for (const plan of QUOTA_PLAN_CATALOG) {
      expect(QUOTA_CATALOG_FAMILIES).toContain(plan.family);
      expect(ids.has(plan.planId)).toBe(false);
      expect(plan.labelZh.length).toBeGreaterThan(0);
      expect(plan.window.hours).toBeGreaterThan(0);
      expect(["rolling", "utc-day"]).toContain(plan.window.kind);
      expect(Number.isSafeInteger(plan.budgetTokens)).toBe(true);
      expect(plan.budgetTokens).toBeGreaterThan(0);
      ids.add(plan.planId);
    }
    expect([...ids]).toEqual([
      "claude-pro",
      "claude-max-5x",
      "claude-max-20x",
      "chatgpt-plus",
      "chatgpt-pro",
      "gemini-free",
      "gemini-ai-pro",
      "supergrok"
    ]);
  });
});

describe("quota estimator", () => {
  it("uses an exact rolling boundary", () => {
    expect(
      quotaWindowStart(
        new Date("2026-07-17T12:30:00.000Z"),
        { kind: "rolling", hours: 5 }
      ).toISOString()
    ).toBe("2026-07-17T07:30:00.000Z");
  });

  it("uses the current UTC-day boundary", () => {
    expect(
      quotaWindowStart(
        new Date("2026-07-17T23:59:59.999Z"),
        { kind: "utc-day", hours: 24 }
      ).toISOString()
    ).toBe("2026-07-17T00:00:00.000Z");
  });

  it("day-scales daily-only budgets and clamps over-budget remaining to zero", () => {
    const plus = QUOTA_PLAN_CATALOG.find((plan) => plan.planId === "chatgpt-plus")!;
    expect(dailyEquivalentBudget(plus)).toBe(1_920_000);
    expect(remainingQuotaPercent(600, 1_000)).toBe(40);
    expect(remainingQuotaPercent(1_001, 1_000)).toBe(0);
  });
});

describe("quota plan store", () => {
  it("roundtrips selected and cleared plans", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-quota-store-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "quota-plans.json");
    let selections = await loadQuotaPlanSelections(path);
    selections = withQuotaPlanSelection(selections, "openai", "chatgpt-plus");
    await saveQuotaPlanSelections(path, selections);
    expect(await loadQuotaPlanSelections(path)).toEqual({
      schemaVersion: 1,
      plans: { openai: "chatgpt-plus" }
    });
    await saveQuotaPlanSelections(
      path,
      withQuotaPlanSelection(selections, "openai", null)
    );
    expect(await loadQuotaPlanSelections(path)).toEqual({
      schemaVersion: 1,
      plans: {}
    });
  });

  it("recovers corrupt files and drops unknown families and plans", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-quota-store-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "quota-plans.json");
    await writeFile(path, "not-json", "utf8");
    expect(await loadQuotaPlanSelections(path)).toEqual({ schemaVersion: 1, plans: {} });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: 1,
      plans: {}
    });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        plans: {
          openai: "chatgpt-pro",
          anthropic: "unknown-plan",
          secret: "private"
        }
      }),
      "utf8"
    );
    expect(await loadQuotaPlanSelections(path)).toEqual({
      schemaVersion: 1,
      plans: { openai: "chatgpt-pro" }
    });
  });
});
