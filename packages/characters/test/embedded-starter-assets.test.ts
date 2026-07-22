import { describe, expect, it } from "vitest";

import {
  EMBEDDED_STARTER_ASSET_BYTES,
  EMBEDDED_STARTER_ASSET_COUNT,
  EMBEDDED_STARTER_ASSET_SNAPSHOTS,
  getApprovedAssetManifest,
  getEmbeddedStarterAssetConfiguration,
  projectEmbeddedStarterAssetManifest,
} from "../src/index.js";

describe("embedded starter assets", () => {
  it("projects exactly four avatars and four tech base outfits", () => {
    const approved = getApprovedAssetManifest();
    expect(approved).not.toBeNull();
    const manifest = projectEmbeddedStarterAssetManifest(approved);

    expect(manifest.voice).toEqual([]);
    expect(manifest.characters.map(({ characterId }) => characterId)).toEqual([
      "chatgpt",
      "claude",
      "gemini",
      "grok",
    ]);
    expect(
      manifest.characters.flatMap((character) => [
        character.avatar,
        ...character.themes.flatMap((theme) => [
          theme.outfit,
          ...Object.values(theme.poses),
        ]),
      ]),
    ).toHaveLength(EMBEDDED_STARTER_ASSET_COUNT);
    expect(
      manifest.characters
        .flatMap((character) => [
          character.avatar,
          ...character.themes.map((theme) => theme.outfit),
        ])
        .reduce((total, object) => total + object.bytes, 0),
    ).toBe(EMBEDDED_STARTER_ASSET_BYTES);
    for (const [index, character] of manifest.characters.entries()) {
      const snapshot = EMBEDDED_STARTER_ASSET_SNAPSHOTS[index]!;
      expect(character).toEqual({
        characterId: snapshot.characterId,
        avatar: snapshot.avatar,
        themes: [
          {
            themeId: "tech",
            outfit: snapshot.outfit,
            poses: {},
          },
        ],
      });
    }
  });

  it("rejects drift instead of silently selecting a different approved image", () => {
    const approved = getApprovedAssetManifest();
    expect(approved).not.toBeNull();
    const first = approved!.characters[0]!;
    const changed = {
      ...approved!,
      characters: [
        {
          ...first,
          avatar: { ...first.avatar, bytes: first.avatar.bytes + 1 },
        },
        ...approved!.characters.slice(1),
      ],
    };
    expect(() => projectEmbeddedStarterAssetManifest(changed)).toThrow(
      /approved starter assets differ/u,
    );
  });

  it("fails closed when a source build has no staged raster directory", () => {
    expect(getEmbeddedStarterAssetConfiguration()).toBeNull();
  });
});
