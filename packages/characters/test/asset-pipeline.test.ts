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
import {
  createPcm16Wav,
  runPipeline,
  SOLID_COLOR_PNG,
} from "./asset-pipeline-fixture.js";

async function createPipelineFixture() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "tokenmonster-assets-"));
  const bank = join(fixtureRoot, "bank");
  const out = join(fixtureRoot, "out");
  const voiceDir = join(fixtureRoot, "voice");
  const outfits = join(bank, "outfits_v2_norm");
  await mkdir(outfits, { recursive: true });
  await mkdir(voiceDir);
  await writeFile(join(outfits, "doll_qwen__tech.png"), SOLID_COLOR_PNG);
  return { fixtureRoot, bank, out, voiceDir };
}

describe("asset pipeline", () => {
  it("builds and validates a content-addressed fallback avatar", async () => {
    const { fixtureRoot, bank, out } = await createPipelineFixture();

    try {
      const build = await runPipeline(bank, out, "qwen");
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      const manifestInput: unknown = JSON.parse(
        await readFile(join(out, "manifest.json"), "utf8"),
      );
      const manifest = parseAssetManifest(manifestInput);
      const report = JSON.parse(
        await readFile(join(out, "report.json"), "utf8"),
      ) as {
        perPersona: { qwen: { avatarSource: string } };
        voice: { characters: number; lines: number; bytes: number };
      };

      expect(manifest.generatedAt).toBe("2023-11-14T22:13:20.000Z");
      expect(manifest.characters).toHaveLength(1);
      expect(manifest.voice).toEqual([]);
      expect(manifest.characters[0]!.avatar).toMatchObject({
        width: 1,
        height: 1,
      });
      expect(report.perPersona.qwen.avatarSource).toBe("outfit-fallback");
      expect(report.voice).toEqual({ characters: 0, lines: 0, bytes: 0 });

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

  it("ingests valid PCM16 mono voice clips", async () => {
    const { fixtureRoot, bank, out, voiceDir } =
      await createPipelineFixture();
    const wav = createPcm16Wav({ frameCount: 441 });

    try {
      await writeFile(join(voiceDir, "openai__active.wav"), wav);
      await writeFile(join(voiceDir, "qwen__error.wav"), wav);
      await writeFile(join(voiceDir, "openai__greeting.wav"), wav);
      const build = await runPipeline(bank, out, "qwen", { voiceDir });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      const manifestInput: unknown = JSON.parse(
        await readFile(join(out, "manifest.json"), "utf8"),
      );
      const manifest = parseAssetManifest(manifestInput);
      const wavSha256 = createHash("sha256").update(wav).digest("hex");
      expect(manifest.voice).toEqual([
        {
          characterId: "chatgpt",
          lines: [
            {
              id: "chatgpt-greeting",
              trigger: "greeting",
              object: {
                path: `objects/${wavSha256}.wav`,
                bytes: wav.length,
                sha256: wavSha256,
              },
              durationMs: 20,
            },
            {
              id: "chatgpt-active",
              trigger: "active",
              object: {
                path: `objects/${wavSha256}.wav`,
                bytes: wav.length,
                sha256: wavSha256,
              },
              durationMs: 20,
            },
          ],
        },
        {
          characterId: "qwen",
          lines: [
            {
              id: "qwen-error",
              trigger: "error",
              object: {
                path: `objects/${wavSha256}.wav`,
                bytes: wav.length,
                sha256: wavSha256,
              },
              durationMs: 20,
            },
          ],
        },
      ]);
      expect(await readFile(join(out, "objects", `${wavSha256}.wav`))).toEqual(
        wav,
      );

      const report = JSON.parse(
        await readFile(join(out, "report.json"), "utf8"),
      ) as { voice: { characters: number; lines: number; bytes: number } };
      expect(report.voice).toEqual({
        characters: 2,
        lines: 3,
        bytes: wav.length * 3,
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it.each([
    {
      label: "the wrong sample rate",
      filename: "openai__greeting.wav",
      wav: createPcm16Wav({ sampleRate: 44_100 }),
    },
    {
      label: "stereo audio",
      filename: "openai__greeting.wav",
      wav: createPcm16Wav({ channels: 2 }),
    },
    {
      label: "an oversized clip",
      filename: "openai__greeting.wav",
      wav: createPcm16Wav({ frameCount: 200_000 }),
    },
    {
      label: "an overlong clip",
      filename: "openai__greeting.wav",
      wav: createPcm16Wav({ frameCount: 132_323 }),
    },
    {
      label: "a bad filename",
      filename: "openai-greeting.wav",
      wav: createPcm16Wav(),
    },
  ])("rejects $label without writing a manifest", async ({ filename, wav }) => {
    const { fixtureRoot, bank, out, voiceDir } =
      await createPipelineFixture();

    try {
      await writeFile(join(voiceDir, filename), wav);
      const build = await runPipeline(bank, out, "qwen", { voiceDir });
      expect(build.status).not.toBe(0);
      await expect(readFile(join(out, "manifest.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
