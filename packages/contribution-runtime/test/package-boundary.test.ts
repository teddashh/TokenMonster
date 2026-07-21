import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const SOURCE_FILES = [
  "contribution-service.ts",
  "contribution-sync-scheduler.ts",
  "sidecar-contribution-projector.ts",
  "types.ts",
] as const;

describe("contribution runtime package boundary", () => {
  it("contains no Electron, app, gateway, filesystem, or collector implementation import", async () => {
    const sources = await Promise.all(
      SOURCE_FILES.map((fileName) =>
        readFile(new URL(`../src/${fileName}`, import.meta.url), "utf8"),
      ),
    );
    const joined = sources.join("\n");
    for (const forbidden of [
      'from "electron"',
      "apps/companion",
      "@tokenmonster/companion-gateway",
      'from "node:child_process"',
      'from "node:fs',
      'from "node:http"',
      'from "node:sqlite"',
    ]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it("declares only reviewed local runtime dependencies", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly dependencies?: Readonly<Record<string, string>> };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@tokenmonster/contracts",
      "@tokenmonster/local-store",
      "@tokenmonster/monster-engine",
      "@tokenmonster/secret-vault",
      "@tokenmonster/token-tracker-adapter",
    ]);
  });
});
