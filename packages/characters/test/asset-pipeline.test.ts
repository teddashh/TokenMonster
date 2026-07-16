import { createHash } from "node:crypto";
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

import { describe, expect, it } from "vitest";

import { parseAssetManifest } from "../src/index.js";
import { runPipeline, SOLID_COLOR_PNG } from "./asset-pipeline-fixture.js";

describe("asset pipeline", () => {
  it("builds and validates a content-addressed fallback avatar", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "tokenmonster-assets-"));
    const bank = join(fixtureRoot, "bank");
    const out = join(fixtureRoot, "out");
    const outfits = join(bank, "outfits_v2_norm");

    try {
      await mkdir(outfits, { recursive: true });
      await writeFile(
        join(outfits, "doll_qwen__tech.png"),
        SOLID_COLOR_PNG,
      );
      const build = await runPipeline(bank, out, "qwen");
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      const manifestInput: unknown = JSON.parse(
        await readFile(join(out, "manifest.json"), "utf8"),
      );
      const manifest = parseAssetManifest(manifestInput);
      const report = JSON.parse(
        await readFile(join(out, "report.json"), "utf8"),
      ) as { perPersona: { qwen: { avatarSource: string } } };

      expect(manifest.generatedAt).toBe("2023-11-14T22:13:20.000Z");
      expect(manifest.characters).toHaveLength(1);
      expect(manifest.characters[0]!.avatar).toMatchObject({
        width: 1,
        height: 1,
      });
      expect(report.perPersona.qwen.avatarSource).toBe("outfit-fallback");

      const objectFiles = await readdir(join(out, "objects"));
      expect(objectFiles.length).toBeGreaterThan(0);
      for (const filename of objectFiles) {
        const match = /^([0-9a-f]{64})\.(?:webp|png)$/u.exec(filename);
        expect(match).not.toBeNull();
        const bytes = await readFile(join(out, "objects", filename));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          match![1],
        );
      }

    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
