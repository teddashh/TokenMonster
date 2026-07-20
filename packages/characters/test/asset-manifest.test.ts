import { describe, expect, it } from "vitest";

import {
  ASSET_MANIFEST_SCHEMA_VERSION,
  AssetManifestSchema,
  parseAssetManifest,
} from "../src/index.js";

const WEBP_SHA256 = "a".repeat(64);
const WAV_SHA256 = "b".repeat(64);

function validManifest() {
  return {
    schemaVersion: ASSET_MANIFEST_SCHEMA_VERSION,
    generatedAt: "2026-07-16T12:00:00.000Z",
    characters: [
      {
        characterId: "chatgpt",
        avatar: {
          path: `objects/${WEBP_SHA256}.webp`,
          bytes: 1_024,
          sha256: WEBP_SHA256,
          width: 256,
          height: 256,
        },
        themes: [
          {
            themeId: "tech",
            outfit: {
              path: `objects/${WEBP_SHA256}.webp`,
              bytes: 4_096,
              sha256: WEBP_SHA256,
              width: 512,
              height: 840,
            },
            poses: {
              supported: {
                path: `objects/${WEBP_SHA256}.webp`,
                bytes: 4_096,
                sha256: WEBP_SHA256,
                width: 512,
                height: 840,
              },
            },
          },
        ],
      },
    ],
    voice: [
      {
        characterId: "chatgpt",
        lines: [
          {
            id: "chatgpt-greeting-hello",
            trigger: "greeting",
            object: {
              path: `objects/${WAV_SHA256}.wav`,
              bytes: 8_192,
              sha256: WAV_SHA256,
            },
            durationMs: 1_250,
          },
        ],
      },
    ],
  };
}

describe("asset manifest schema", () => {
  it("parses a complete v1 manifest", () => {
    expect(parseAssetManifest(validManifest())).toEqual(validManifest());
  });

  it("allows GLM image and voice assets without requiring them in a release", () => {
    const manifest = structuredClone(validManifest());
    manifest.characters[0]!.characterId = "glm";
    manifest.voice[0]!.characterId = "glm";

    expect(parseAssetManifest(manifest)).toEqual(manifest);
  });

  it("rejects invalid integrity, dimensions, and identifiers", () => {
    const manifest = validManifest() as {
      characters: Array<{
        characterId: string;
        avatar: { path: string; height?: number };
      }>;
    };
    manifest.characters[0]!.characterId = "unknown-provider";
    manifest.characters[0]!.avatar.path = `objects/${"c".repeat(64)}.webp`;
    delete manifest.characters[0]!.avatar.height;

    expect(() => parseAssetManifest(manifest)).toThrow();
  });

  it("rejects unknown fields at every manifest level", () => {
    const manifest = validManifest() as {
      characters: Array<{
        themes: Array<{ poses: Record<string, unknown> }>;
      }>;
      unexpected?: boolean;
    };
    manifest.unexpected = true;
    manifest.characters[0]!.themes[0]!.poses["idle"] = {
      path: `objects/${WEBP_SHA256}.webp`,
      bytes: 1,
      sha256: WEBP_SHA256,
    };

    expect(() => parseAssetManifest(manifest)).toThrow();
  });

  it("enforces object, dimension, and duration size caps", () => {
    const cases: Array<(manifest: ReturnType<typeof validManifest>) => void> = [
      (manifest) => {
        manifest.characters[0]!.avatar.bytes = 4_194_305;
      },
      (manifest) => {
        manifest.characters[0]!.avatar.width = 4_097;
      },
      (manifest) => {
        manifest.characters[0]!.avatar.height = 4_097;
      },
      (manifest) => {
        manifest.voice[0]!.lines[0]!.durationMs = 30_001;
      },
    ];

    for (const mutate of cases) {
      const manifest = structuredClone(validManifest());
      mutate(manifest);
      expect(() => parseAssetManifest(manifest)).toThrow();
    }
  });

  it("caps themes, voice entries, and lines", () => {
    const themesManifest = structuredClone(validManifest());
    const theme = themesManifest.characters[0]!.themes[0]!;
    themesManifest.characters[0]!.themes = Array.from(
      { length: 21 },
      (_, index) => ({ ...structuredClone(theme), themeId: `theme-${index}` }),
    );

    const voiceManifest = structuredClone(validManifest());
    const voice = voiceManifest.voice[0]!;
    voiceManifest.voice = Array.from({ length: 129 }, () =>
      structuredClone(voice),
    );

    const linesManifest = structuredClone(validManifest());
    const line = linesManifest.voice[0]!.lines[0]!;
    linesManifest.voice[0]!.lines = Array.from({ length: 9 }, (_, index) => ({
      ...structuredClone(line),
      id: `chatgpt-greeting-line-${index}`,
    }));

    for (const [manifest, path] of [
      [themesManifest, "characters.0.themes"],
      [voiceManifest, "voice"],
      [linesManifest, "voice.0.lines"],
    ] as const) {
      const result = AssetManifestSchema.safeParse(manifest);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            (issue) =>
              issue.code === "too_big" && issue.path.join(".") === path,
          ),
        ).toBe(true);
      }
    }
  });

  it("accepts consistent PNG, WebP, and WAV references", () => {
    const manifest = structuredClone(validManifest());
    manifest.characters[0]!.avatar.path = `objects/${WEBP_SHA256}.png`;

    expect(parseAssetManifest(manifest)).toEqual(manifest);
  });

  it("keeps theme and voice identifiers inside the renderer contract", () => {
    const unknownTheme = structuredClone(validManifest());
    unknownTheme.characters[0]!.themes[0]!.themeId = "not-approved";

    const pathLikeVoiceId = structuredClone(validManifest());
    pathLikeVoiceId.voice[0]!.lines[0]!.id = "chatgpt/greeting";

    const overlongVoiceId = structuredClone(validManifest());
    overlongVoiceId.voice[0]!.lines[0]!.id = "a".repeat(81);

    for (const manifest of [unknownTheme, pathLikeVoiceId, overlongVoiceId]) {
      expect(() => parseAssetManifest(manifest)).toThrow();
    }
  });

  it("rejects extension and kind inconsistencies", () => {
    const cases: Array<(manifest: ReturnType<typeof validManifest>) => void> = [
      (manifest) => {
        delete (manifest.characters[0]!.avatar as { width?: number }).width;
      },
      (manifest) => {
        Object.assign(manifest.characters[0]!.avatar, { durationMs: 1_000 });
      },
      (manifest) => {
        Object.assign(manifest.voice[0]!.lines[0]!.object, {
          width: 1,
          height: 1,
        });
      },
      (manifest) => {
        Object.assign(manifest.voice[0]!.lines[0]!.object, {
          path: `objects/${WEBP_SHA256}.webp`,
          sha256: WEBP_SHA256,
          width: 1,
          height: 1,
        });
      },
      (manifest) => {
        Object.assign(manifest.characters[0]!.avatar, {
          path: `objects/${WAV_SHA256}.wav`,
          sha256: WAV_SHA256,
        });
        delete (manifest.characters[0]!.avatar as { width?: number }).width;
        delete (manifest.characters[0]!.avatar as { height?: number }).height;
      },
      (manifest) => {
        delete (manifest.voice[0]!.lines[0] as { durationMs?: number })
          .durationMs;
      },
    ];

    for (const mutate of cases) {
      const manifest = structuredClone(validManifest());
      mutate(manifest);
      expect(() => parseAssetManifest(manifest)).toThrow();
    }
  });
});
