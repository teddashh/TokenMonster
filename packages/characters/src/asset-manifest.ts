import { z } from "zod";

import {
  WARDROBE_THEME_IDS,
  WardrobeThemeIdSchema,
} from "./progression.js";

export const ASSET_MANIFEST_SCHEMA_VERSION = "1" as const;

export const ASSET_CHARACTER_IDS = [
  "chatgpt",
  "claude",
  "gemini",
  "grok",
  "deepseek",
  "qwen",
  "mistral",
  "venice",
  "sakana",
  "perplexity",
  "glm",
] as const;

export const ASSET_STATE_TRIGGERS = [
  "supported",
  "challenged",
  "victory",
] as const;

export const ASSET_VOICE_TRIGGERS = [
  "greeting",
  "unlock",
  "quiet",
  "active",
  "error",
] as const;

export const AssetCharacterIdSchema = z.enum(ASSET_CHARACTER_IDS);
export const AssetStateTriggerSchema = z.enum(ASSET_STATE_TRIGGERS);
export const AssetVoiceTriggerSchema = z.enum(ASSET_VOICE_TRIGGERS);

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const ObjectRefSchema = z
  .object({
    path: z
      .string()
      .regex(/^objects\/[0-9a-f]{64}\.(?:webp|png|wav)$/u),
    bytes: z.number().int().positive().max(4_194_304),
    sha256: Sha256Schema,
    width: z.number().int().min(1).max(4_096).optional(),
    height: z.number().int().min(1).max(4_096).optional(),
  })
  .strict()
  .superRefine((object, context) => {
    const pathSha256 = object.path
      .slice("objects/".length)
      .split(".", 1)[0];
    if (pathSha256 !== object.sha256) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "path must contain the declared sha256",
      });
    }

    const extension = object.path.slice(object.path.lastIndexOf(".") + 1);
    const isImage = extension !== "wav";
    if (isImage) {
      for (const dimension of ["width", "height"] as const) {
        if (object[dimension] === undefined) {
          context.addIssue({
            code: "custom",
            path: [dimension],
            message: `${dimension} is required for image objects`,
          });
        }
      }
    } else {
      for (const dimension of ["width", "height"] as const) {
        if (object[dimension] !== undefined) {
          context.addIssue({
            code: "custom",
            path: [dimension],
            message: `${dimension} is not allowed for WAV objects`,
          });
        }
      }
    }
  });

const ImageObjectRefSchema = ObjectRefSchema.refine(
  (object) => !object.path.endsWith("wav"),
  { path: ["path"], message: "image assets must use WebP or PNG objects" },
);

const ThemeSchema = z
  .object({
    themeId: WardrobeThemeIdSchema,
    outfit: ImageObjectRefSchema,
    poses: z
      .object({
        supported: ImageObjectRefSchema.optional(),
        challenged: ImageObjectRefSchema.optional(),
        victory: ImageObjectRefSchema.optional(),
      })
      .strict(),
  })
  .strict();

const CharacterAssetsSchema = z
  .object({
    characterId: AssetCharacterIdSchema,
    avatar: ImageObjectRefSchema,
    themes: z.array(ThemeSchema).max(WARDROBE_THEME_IDS.length),
  })
  .strict()
  .superRefine((character, context) => {
    const themeIds = character.themes.map((theme) => theme.themeId);
    if (new Set(themeIds).size !== themeIds.length) {
      context.addIssue({
        code: "custom",
        path: ["themes"],
        message: "themeId values must be unique within a character",
      });
    }
  });

const VoiceLineSchema = z
  .object({
    id: z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    trigger: AssetVoiceTriggerSchema,
    object: ObjectRefSchema,
    durationMs: z.number().int().min(1).max(30_000),
  })
  .strict()
  .superRefine((line, context) => {
    if (!line.object.path.endsWith("wav")) {
      context.addIssue({
        code: "custom",
        path: ["object", "path"],
        message: "voice lines must use .wav objects",
      });
    }
  });

const CharacterVoiceSchema = z
  .object({
    characterId: AssetCharacterIdSchema,
    lines: z.array(VoiceLineSchema).max(8),
  })
  .strict()
  .superRefine((voice, context) => {
    const lineIds = voice.lines.map((line) => line.id);
    if (new Set(lineIds).size !== lineIds.length) {
      context.addIssue({
        code: "custom",
        path: ["lines"],
        message: "voice line ids must be unique within a character",
      });
    }
  });

export const AssetManifestSchema = z
  .object({
    schemaVersion: z.literal(ASSET_MANIFEST_SCHEMA_VERSION),
    generatedAt: z.iso.datetime({ offset: true }),
    characters: z.array(CharacterAssetsSchema),
    voice: z.array(CharacterVoiceSchema).max(128),
  })
  .strict()
  .superRefine((manifest, context) => {
    const characterIds = manifest.characters.map(
      (character) => character.characterId,
    );
    if (new Set(characterIds).size !== characterIds.length) {
      context.addIssue({
        code: "custom",
        path: ["characters"],
        message: "characterId values must be unique",
      });
    }

    const voiceCharacterIds = manifest.voice.map((voice) => voice.characterId);
    if (new Set(voiceCharacterIds).size !== voiceCharacterIds.length) {
      context.addIssue({
        code: "custom",
        path: ["voice"],
        message: "voice characterId values must be unique",
      });
    }
  });

export type AssetCharacterId = z.infer<typeof AssetCharacterIdSchema>;
export type AssetStateTrigger = z.infer<typeof AssetStateTriggerSchema>;
export type AssetVoiceTrigger = z.infer<typeof AssetVoiceTriggerSchema>;
export type ObjectRef = Readonly<z.infer<typeof ObjectRefSchema>>;
export type AssetManifest = Readonly<z.infer<typeof AssetManifestSchema>>;

export function parseAssetManifest(input: unknown): AssetManifest {
  return AssetManifestSchema.parse(input);
}
