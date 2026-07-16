import { z } from "zod";

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
] as const;

export const ASSET_STATE_TRIGGERS = [
  "supported",
  "challenged",
  "victory",
] as const;

export const AssetCharacterIdSchema = z.enum(ASSET_CHARACTER_IDS);
export const AssetStateTriggerSchema = z.enum(ASSET_STATE_TRIGGERS);

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const ObjectRefSchema = z
  .object({
    path: z
      .string()
      .regex(/^objects\/[0-9a-f]{64}\.(?:webp|png|wav)$/u),
    bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: Sha256Schema,
    width: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
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

    if ((object.width === undefined) !== (object.height === undefined)) {
      context.addIssue({
        code: "custom",
        path: object.width === undefined ? ["width"] : ["height"],
        message: "width and height must be declared together",
      });
    }
  });

const ThemeSchema = z
  .object({
    themeId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    outfit: ObjectRefSchema,
    poses: z
      .object({
        supported: ObjectRefSchema.optional(),
        challenged: ObjectRefSchema.optional(),
        victory: ObjectRefSchema.optional(),
      })
      .strict(),
  })
  .strict();

const CharacterAssetsSchema = z
  .object({
    characterId: AssetCharacterIdSchema,
    avatar: ObjectRefSchema,
    themes: z.array(ThemeSchema),
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
    id: z.string().regex(/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/u),
    stateTrigger: AssetStateTriggerSchema,
    object: ObjectRefSchema,
    durationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const CharacterVoiceSchema = z
  .object({
    characterId: AssetCharacterIdSchema,
    lines: z.array(VoiceLineSchema),
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
    voice: z.array(CharacterVoiceSchema),
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
export type ObjectRef = Readonly<z.infer<typeof ObjectRefSchema>>;
export type AssetManifest = Readonly<z.infer<typeof AssetManifestSchema>>;

export function parseAssetManifest(input: unknown): AssetManifest {
  return AssetManifestSchema.parse(input);
}
