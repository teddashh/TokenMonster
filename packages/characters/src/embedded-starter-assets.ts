import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseAssetManifest,
  type AssetManifest,
  type ObjectRef,
} from "./asset-manifest.js";
import {
  STARTER_BASE_THEME_ID,
  STARTER_CHARACTER_BY_PROVIDER_FAMILY,
} from "./starter-selection.js";

export const EMBEDDED_STARTER_ASSET_DIRECTORY_NAME =
  "embedded-starter-assets" as const;

const STARTER_IDS = Object.freeze(
  Object.values(STARTER_CHARACTER_BY_PROVIDER_FAMILY),
);

interface EmbeddedStarterSnapshot {
  readonly characterId: (typeof STARTER_IDS)[number];
  readonly avatar: ObjectRef;
  readonly outfit: ObjectRef;
}

/**
 * Exact reviewed bytes admitted to the lightweight public installer. Keeping
 * this list independent from array order prevents a future full-pack update
 * from silently changing the built-in identity or base outfit.
 */
export const EMBEDDED_STARTER_ASSET_SNAPSHOTS = Object.freeze([
  Object.freeze({
    characterId: "chatgpt",
    avatar: Object.freeze({
      path: "objects/2966f68a3e702c47a29d11c19b901a4d850a8914ec2b78252b617d757c04fca3.webp",
      bytes: 17_722,
      sha256:
        "2966f68a3e702c47a29d11c19b901a4d850a8914ec2b78252b617d757c04fca3",
      width: 256,
      height: 251,
    }),
    outfit: Object.freeze({
      path: "objects/0a725ec07f71ddd4366aaae352532dbd7978c5673119a1826628f8c2c5f70314.webp",
      bytes: 63_198,
      sha256:
        "0a725ec07f71ddd4366aaae352532dbd7978c5673119a1826628f8c2c5f70314",
      width: 347,
      height: 840,
    }),
  }),
  Object.freeze({
    characterId: "claude",
    avatar: Object.freeze({
      path: "objects/f4b50a1ffa8f717a2717bd14551c84a2258b4985e3e8b7f4b18d6008a660f2ae.webp",
      bytes: 19_088,
      sha256:
        "f4b50a1ffa8f717a2717bd14551c84a2258b4985e3e8b7f4b18d6008a660f2ae",
      width: 256,
      height: 240,
    }),
    outfit: Object.freeze({
      path: "objects/fa39c624f4b1263b90a665230491f238f5a24d6fc91e39de0f169c8351345c73.webp",
      bytes: 108_302,
      sha256:
        "fa39c624f4b1263b90a665230491f238f5a24d6fc91e39de0f169c8351345c73",
      width: 614,
      height: 840,
    }),
  }),
  Object.freeze({
    characterId: "gemini",
    avatar: Object.freeze({
      path: "objects/c4fa29dbd7142705b3ef35477c86aa5372d6c66cc9ef6c5a3f7c55b2bac926ef.webp",
      bytes: 19_898,
      sha256:
        "c4fa29dbd7142705b3ef35477c86aa5372d6c66cc9ef6c5a3f7c55b2bac926ef",
      width: 256,
      height: 239,
    }),
    outfit: Object.freeze({
      path: "objects/539f8fb9d004e8047ab80e0d66ce5b97d733613e7d189d0fca95bb2c8c518012.webp",
      bytes: 97_304,
      sha256:
        "539f8fb9d004e8047ab80e0d66ce5b97d733613e7d189d0fca95bb2c8c518012",
      width: 552,
      height: 840,
    }),
  }),
  Object.freeze({
    characterId: "grok",
    avatar: Object.freeze({
      path: "objects/41377cc281b8f5685628da087f82055cbf7806949b33dcc19c8814240c3d4995.webp",
      bytes: 15_012,
      sha256:
        "41377cc281b8f5685628da087f82055cbf7806949b33dcc19c8814240c3d4995",
      width: 256,
      height: 256,
    }),
    outfit: Object.freeze({
      path: "objects/6ac1e5a8dfd219cb1119ff06b723e9babdff64bd042e033d452d590ce2ed071b.webp",
      bytes: 74_946,
      sha256:
        "6ac1e5a8dfd219cb1119ff06b723e9babdff64bd042e033d452d590ce2ed071b",
      width: 521,
      height: 840,
    }),
  }),
] as const satisfies readonly EmbeddedStarterSnapshot[]);

export const EMBEDDED_STARTER_ASSET_COUNT = 8 as const;
export const EMBEDDED_STARTER_ASSET_BYTES = 415_470 as const;

export interface EmbeddedStarterAssetConfiguration {
  readonly manifest: AssetManifest;
  /** Full content-addressed manifest paths mapped to immutable in-memory bytes. */
  readonly objects: Readonly<Record<string, Uint8Array>>;
}

function exactObjectRef(left: ObjectRef, right: ObjectRef): boolean {
  return (
    left.path === right.path &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256 &&
    left.width === right.width &&
    left.height === right.height
  );
}

/** Project the exact four-avatar/four-base-outfit subset from reviewed art. */
export function projectEmbeddedStarterAssetManifest(
  input: unknown,
): AssetManifest {
  const manifest = parseAssetManifest(input);
  const characters = EMBEDDED_STARTER_ASSET_SNAPSHOTS.map((snapshot) => {
    const character = manifest.characters.find(
      (candidate) => candidate.characterId === snapshot.characterId,
    );
    const theme = character?.themes.find(
      (candidate) => candidate.themeId === STARTER_BASE_THEME_ID,
    );
    if (
      character === undefined ||
      theme === undefined ||
      !exactObjectRef(character.avatar, snapshot.avatar) ||
      !exactObjectRef(theme.outfit, snapshot.outfit)
    ) {
      throw new TypeError(
        `approved starter assets differ for ${snapshot.characterId}`,
      );
    }
    return {
      characterId: snapshot.characterId,
      avatar: snapshot.avatar,
      themes: [
        {
          themeId: STARTER_BASE_THEME_ID,
          outfit: snapshot.outfit,
          poses: {},
        },
      ],
    };
  });
  return parseAssetManifest({
    schemaVersion: "1",
    generatedAt: manifest.generatedAt,
    characters,
    voice: [],
  });
}

function webpSignatureMatches(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  );
}

function readVerifiedObject(directory: string, object: ObjectRef): Buffer {
  const path = join(directory, ...object.path.split("/"));
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size !== object.bytes
  ) {
    throw new TypeError("embedded starter object is not one physical file");
  }
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    bytes.length !== object.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== object.sha256 ||
    !webpSignatureMatches(bytes)
  ) {
    throw new TypeError("embedded starter object bytes are invalid");
  }
  return bytes;
}

/**
 * Load the all-or-nothing built-in starter set from an installed release.
 * Source builds intentionally have no raster directory and therefore return
 * null through the public getter below.
 */
export function loadEmbeddedStarterAssetConfiguration(
  input: unknown,
  directory: string,
): EmbeddedStarterAssetConfiguration {
  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    normalize(directory) !== directory
  ) {
    throw new TypeError("embedded starter directory must be normalized");
  }
  const directoryMetadata = lstatSync(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new TypeError("embedded starter directory must be physical");
  }
  const manifest = projectEmbeddedStarterAssetManifest(input);
  const objects: Record<string, Uint8Array> = {};
  for (const character of manifest.characters) {
    for (const object of [character.avatar, character.themes[0]!.outfit]) {
      objects[object.path] = readVerifiedObject(directory, object);
    }
  }
  if (
    Reflect.ownKeys(objects).length !== EMBEDDED_STARTER_ASSET_COUNT ||
    Object.values(objects).reduce((total, bytes) => total + bytes.length, 0) !==
      EMBEDDED_STARTER_ASSET_BYTES
  ) {
    throw new TypeError("embedded starter inventory is incomplete");
  }
  return Object.freeze({ manifest, objects: Object.freeze(objects) });
}

export function installedEmbeddedStarterAssetDirectory(): string {
  return fileURLToPath(
    new URL(`./${EMBEDDED_STARTER_ASSET_DIRECTORY_NAME}`, import.meta.url),
  );
}
