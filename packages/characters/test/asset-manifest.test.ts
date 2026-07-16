import { describe, expect, it } from "vitest";

import {
  ASSET_MANIFEST_SCHEMA_VERSION,
  parseAssetManifest,
} from "../src/index.js";

const WEBP_SHA256 = "a".repeat(64);
const WAV_SHA256 = "b".repeat(64);

function validManifest(): unknown {
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
            id: "chatgpt/supported/hello",
            stateTrigger: "supported",
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
});
