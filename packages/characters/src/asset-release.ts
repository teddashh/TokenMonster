import { createHash } from "node:crypto";

import { z } from "zod";

import {
  ASSET_CHARACTER_IDS,
  ASSET_STATE_TRIGGERS,
  ASSET_VOICE_TRIGGERS,
  AssetCharacterIdSchema,
  AssetManifestSchema,
  AssetStateTriggerSchema,
  AssetVoiceTriggerSchema,
  type AssetCharacterId,
  type AssetManifest,
  type ObjectRef,
} from "./asset-manifest.js";
import {
  WARDROBE_THEME_IDS,
  WardrobeThemeIdSchema,
  type WardrobeThemeId,
} from "./progression.js";

/**
 * The historical schema-v1 manifest proves associations and object integrity
 * only. Its old `AssetManifest` name is retained for API compatibility, while
 * this explicit alias prevents it from being mistaken for a public release
 * approval.
 */
export const AssetIntegrityManifestV1Schema = AssetManifestSchema;
export type AssetIntegrityManifestV1 = AssetManifest;

export const ASSET_BUILD_PROVENANCE_SCHEMA_VERSION = "1" as const;
export const ASSET_SOURCE_EVIDENCE_SCHEMA_VERSION = "1" as const;
export const ASSET_RIGHTS_LEDGER_SCHEMA_VERSION = "2" as const;
export const ASSET_RELEASE_MANIFEST_SCHEMA_VERSION = "2" as const;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const PinnedRevisionSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const SafeReferenceIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);
const ToolVersionSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+ -]*$/u);
const RelativeInventoryPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/u)
  .refine(
    (path) =>
      path.split("/").every((segment) => segment !== "." && segment !== ".."),
    { message: "source inventory paths must not contain dot segments" },
  );
const PublicAltTextSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((text) => text === text.trim(), {
    message: "alt text must not have surrounding whitespace",
  })
  .refine((text) => !/[\u0000-\u001f\u007f]/u.test(text), {
    message: "alt text must not contain control characters",
  })
  .refine((text) => !/\b(?:file|https?):\/\//iu.test(text), {
    message: "alt text must not contain URLs or filesystem URIs",
  });
const VoiceLineIdSchema = z
  .string()
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const LocaleSchema = z
  .string()
  .max(35)
  .regex(/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/u);

const AvatarAssociationSchema = z
  .object({
    kind: z.literal("avatar"),
    characterId: AssetCharacterIdSchema,
  })
  .strict();

const OutfitAssociationSchema = z
  .object({
    kind: z.literal("outfit"),
    characterId: AssetCharacterIdSchema,
    themeId: WardrobeThemeIdSchema,
  })
  .strict();

const PoseAssociationSchema = z
  .object({
    kind: z.literal("pose"),
    characterId: AssetCharacterIdSchema,
    themeId: WardrobeThemeIdSchema,
    state: AssetStateTriggerSchema,
  })
  .strict();

const VoiceAssociationSchema = z
  .object({
    kind: z.literal("voice"),
    characterId: AssetCharacterIdSchema,
    lineId: VoiceLineIdSchema,
    trigger: AssetVoiceTriggerSchema,
  })
  .strict();

export const AssetAssociationSchema = z.discriminatedUnion("kind", [
  AvatarAssociationSchema,
  OutfitAssociationSchema,
  PoseAssociationSchema,
  VoiceAssociationSchema,
]);
export type AssetAssociation = Readonly<z.infer<typeof AssetAssociationSchema>>;

const AssetIdSchema = z
  .string()
  .max(240)
  .regex(/^asset:[a-z0-9]+(?::[a-z0-9-]+)+$/u);

/** Produce the one stable ID for an integrity-manifest association tuple. */
export function assetIdForAssociation(association: AssetAssociation): string {
  switch (association.kind) {
    case "avatar":
      return `asset:${association.characterId}:avatar`;
    case "outfit":
      return `asset:${association.characterId}:theme:${association.themeId}:outfit`;
    case "pose":
      return `asset:${association.characterId}:theme:${association.themeId}:pose:${association.state}`;
    case "voice":
      return `asset:${association.characterId}:voice:${association.lineId}:${association.trigger}`;
  }
}

const ImageMediaShapeSchema = z
  .object({
    mediaType: z.enum(["image/webp", "image/png"]),
    width: z.number().int().min(1).max(4_096),
    height: z.number().int().min(1).max(4_096),
  })
  .strict();

const VoiceMediaShapeSchema = z
  .object({
    mediaType: z.literal("audio/wav"),
    durationMs: z.number().int().min(1).max(30_000),
  })
  .strict();

export const AssetOutputSnapshotSchema = z
  .object({
    path: z.string().regex(/^objects\/[0-9a-f]{64}\.(?:webp|png|wav)$/u),
    bytes: z.number().int().positive().max(4_194_304),
    sha256: Sha256Schema,
    media: z.discriminatedUnion("mediaType", [
      ImageMediaShapeSchema,
      VoiceMediaShapeSchema,
    ]),
  })
  .strict()
  .superRefine((output, context) => {
    const pathHash = output.path.slice("objects/".length).split(".", 1)[0];
    if (pathHash !== output.sha256) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "output path must contain the declared sha256",
      });
    }

    const extension = output.path.slice(output.path.lastIndexOf(".") + 1);
    const expectedMediaType =
      extension === "webp"
        ? "image/webp"
        : extension === "png"
          ? "image/png"
          : "audio/wav";
    if (output.media.mediaType !== expectedMediaType) {
      context.addIssue({
        code: "custom",
        path: ["media", "mediaType"],
        message: "mediaType must match the content-addressed path extension",
      });
    }
  });
export type AssetOutputSnapshot = Readonly<
  z.infer<typeof AssetOutputSnapshotSchema>
>;

export const AssetSourceSnapshotSchema = z
  .object({
    inventoryId: SafeReferenceIdSchema,
    inventoryRevision: Sha256Schema,
    path: RelativeInventoryPathSchema,
    sha256: Sha256Schema,
  })
  .strict();
export type AssetSourceSnapshot = Readonly<
  z.infer<typeof AssetSourceSnapshotSchema>
>;

const ResizeHistorySchema = z
  .object({
    width: z.number().int().min(1).max(4_096),
    height: z.number().int().min(1).max(4_096),
    algorithm: z.enum(["lanczos", "nearest", "bicubic"]),
  })
  .strict();

export const AssetGenerationHistorySchema = z
  .object({
    tool: z
      .object({
        name: SafeReferenceIdSchema,
        version: ToolVersionSchema,
      })
      .strict(),
    sourceMediaType: z.enum([
      "image/jpeg",
      "image/png",
      "image/webp",
      "audio/wav",
    ]),
    resize: ResizeHistorySchema.nullable(),
    encoding: z
      .object({
        mediaType: z.enum(["image/webp", "image/png", "audio/wav"]),
        quality: z.number().int().min(1).max(100).nullable(),
      })
      .strict(),
    metadataStripped: z.literal(true),
  })
  .strict()
  .superRefine((history, context) => {
    const isAudio = history.encoding.mediaType === "audio/wav";
    if (isAudio !== (history.sourceMediaType === "audio/wav")) {
      context.addIssue({
        code: "custom",
        path: ["sourceMediaType"],
        message: "audio and image media families cannot be crossed",
      });
    }
    if (isAudio && history.resize !== null) {
      context.addIssue({
        code: "custom",
        path: ["resize"],
        message: "voice generation history cannot contain an image resize",
      });
    }
    if (isAudio && history.encoding.quality !== null) {
      context.addIssue({
        code: "custom",
        path: ["encoding", "quality"],
        message: "WAV generation history must use a null quality",
      });
    }
    if (
      history.encoding.mediaType === "image/png" &&
      history.encoding.quality !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["encoding", "quality"],
        message: "PNG generation history must use a null quality",
      });
    }
    if (
      history.encoding.mediaType === "image/webp" &&
      history.encoding.quality === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["encoding", "quality"],
        message: "WebP generation history must record its quality",
      });
    }
  });
export type AssetGenerationHistory = Readonly<
  z.infer<typeof AssetGenerationHistorySchema>
>;

const SourceRepositorySnapshotSchema = z
  .object({
    repositoryId: SafeReferenceIdSchema,
    revision: PinnedRevisionSchema,
  })
  .strict();

const ReceiptSnapshotSchema = z
  .object({
    path: RelativeInventoryPathSchema.refine(
      (path) => path.toLowerCase().endsWith(".json"),
      { message: "source evidence receipts must be JSON files" },
    ),
    sha256: Sha256Schema,
  })
  .strict();

export const AssetUpstreamStepV1Schema = z
  .object({
    operation: z.enum(["generate", "edit", "normalize", "import"]),
    receipt: ReceiptSnapshotSchema,
    tool: z
      .object({
        name: SafeReferenceIdSchema,
        version: ToolVersionSchema,
      })
      .strict(),
    model: SafeReferenceIdSchema.nullable(),
    inputs: z
      .array(Sha256Schema)
      .max(16)
      .refine((hashes) => new Set(hashes).size === hashes.length, {
        message: "upstream step input hashes must be unique",
      }),
    outputSha256: Sha256Schema,
  })
  .strict();
export type AssetUpstreamStepV1 = Readonly<
  z.infer<typeof AssetUpstreamStepV1Schema>
>;

function validateUpstreamChain(
  evidence: {
    steps: ReadonlyArray<z.infer<typeof AssetUpstreamStepV1Schema>>;
  },
  context: RefinementContext,
): void {
  const seenReceipts = new Map<string, string>();
  evidence.steps.forEach((step, index) => {
    const priorDigest = seenReceipts.get(step.receipt.path);
    if (priorDigest !== undefined && priorDigest !== step.receipt.sha256) {
      context.addIssue({
        code: "custom",
        path: ["steps", index, "receipt", "sha256"],
        message: "one receipt path cannot claim multiple digests",
      });
    }
    seenReceipts.set(step.receipt.path, step.receipt.sha256);

    const priorStep = evidence.steps[index - 1];
    if (
      priorStep !== undefined &&
      !step.inputs.includes(priorStep.outputSha256)
    ) {
      context.addIssue({
        code: "custom",
        path: ["steps", index, "inputs"],
        message: "each upstream step must consume the prior step output",
      });
    }
  });
}

export const AssetUpstreamEvidenceV1Schema = z
  .object({
    repository: SourceRepositorySnapshotSchema,
    steps: z.array(AssetUpstreamStepV1Schema).min(1).max(8),
  })
  .strict()
  .superRefine(validateUpstreamChain);
export type AssetUpstreamEvidenceV1 = Readonly<
  z.infer<typeof AssetUpstreamEvidenceV1Schema>
>;

export const AssetSourceEvidenceEntryV1Schema = z
  .object({
    path: RelativeInventoryPathSchema,
    sha256: Sha256Schema,
    upstream: AssetUpstreamEvidenceV1Schema,
  })
  .strict()
  .superRefine((entry, context) => {
    const finalStep = entry.upstream.steps.at(-1);
    if (finalStep?.outputSha256 !== entry.sha256) {
      context.addIssue({
        code: "custom",
        path: ["upstream", "steps", entry.upstream.steps.length - 1],
        message: "the final upstream step must produce the source hash",
      });
    }
  });
export type AssetSourceEvidenceEntryV1 = Readonly<
  z.infer<typeof AssetSourceEvidenceEntryV1Schema>
>;

/**
 * Controlled-host input that binds staged source bytes to prompt-free public
 * evidence. Receipt contents stay private; only their relative paths and
 * digests are projected into build provenance.
 */
export const AssetSourceEvidenceBundleV1Schema = z
  .object({
    schemaVersion: z.literal(ASSET_SOURCE_EVIDENCE_SCHEMA_VERSION),
    inventoryId: SafeReferenceIdSchema,
    entries: z.array(AssetSourceEvidenceEntryV1Schema).min(1).max(4_096),
  })
  .strict()
  .superRefine((bundle, context) => {
    const seenSources = new Set<string>();
    const seenReceipts = new Map<string, string>();
    bundle.entries.forEach((entry, entryIndex) => {
      if (seenSources.has(entry.path)) {
        context.addIssue({
          code: "custom",
          path: ["entries", entryIndex, "path"],
          message: "source evidence paths must be unique",
        });
      }
      seenSources.add(entry.path);
      entry.upstream.steps.forEach((step, stepIndex) => {
        const priorDigest = seenReceipts.get(step.receipt.path);
        if (priorDigest !== undefined && priorDigest !== step.receipt.sha256) {
          context.addIssue({
            code: "custom",
            path: [
              "entries",
              entryIndex,
              "upstream",
              "steps",
              stepIndex,
              "receipt",
              "sha256",
            ],
            message: "one receipt path cannot claim multiple digests",
          });
        }
        seenReceipts.set(step.receipt.path, step.receipt.sha256);
      });
    });
  });
export type AssetSourceEvidenceBundleV1 = Readonly<
  z.infer<typeof AssetSourceEvidenceBundleV1Schema>
>;

const BuildProvenanceEntryShape = {
  assetId: AssetIdSchema,
  association: AssetAssociationSchema,
  source: AssetSourceSnapshotSchema,
  output: AssetOutputSnapshotSchema,
  generationHistory: AssetGenerationHistorySchema,
} as const;

type RefinementContext = {
  addIssue: (issue: {
    code: "custom";
    path: Array<string | number>;
    message: string;
  }) => void;
};

function validateAssetBinding(
  entry: {
    assetId: string;
    association: AssetAssociation;
    output: AssetOutputSnapshot;
    generationHistory: AssetGenerationHistory;
  },
  context: RefinementContext,
): void {
  if (entry.assetId !== assetIdForAssociation(entry.association)) {
    context.addIssue({
      code: "custom",
      path: ["assetId"],
      message: "assetId must be derived from the exact association tuple",
    });
  }

  const outputIsVoice = entry.output.media.mediaType === "audio/wav";
  if (outputIsVoice !== (entry.association.kind === "voice")) {
    context.addIssue({
      code: "custom",
      path: ["output", "media"],
      message:
        "voice associations require WAV and image associations require images",
    });
  }
  if (
    entry.generationHistory.encoding.mediaType !== entry.output.media.mediaType
  ) {
    context.addIssue({
      code: "custom",
      path: ["generationHistory", "encoding", "mediaType"],
      message: "generation output media type must match the output snapshot",
    });
  }

  const resize = entry.generationHistory.resize;
  if (resize !== null) {
    if (entry.output.media.mediaType === "audio/wav") {
      context.addIssue({
        code: "custom",
        path: ["generationHistory", "resize"],
        message: "voice output cannot have image resize history",
      });
    } else if (
      resize.width !== entry.output.media.width ||
      resize.height !== entry.output.media.height
    ) {
      context.addIssue({
        code: "custom",
        path: ["generationHistory", "resize"],
        message: "recorded resize dimensions must match the output image",
      });
    }
  }
}

export const AssetBuildProvenanceEntryV1Schema = z
  .object({
    ...BuildProvenanceEntryShape,
    upstream: AssetUpstreamEvidenceV1Schema,
  })
  .strict()
  .superRefine((entry, context) => {
    validateAssetBinding(entry, context);
    const finalStep = entry.upstream.steps.at(-1);
    if (finalStep?.outputSha256 !== entry.source.sha256) {
      context.addIssue({
        code: "custom",
        path: ["upstream", "steps", entry.upstream.steps.length - 1],
        message: "the final upstream step must produce the source hash",
      });
    }
  });

export const AssetBuildProvenanceV1Schema = z
  .object({
    schemaVersion: z.literal(ASSET_BUILD_PROVENANCE_SCHEMA_VERSION),
    createdAt: z.iso.datetime({ offset: true }),
    integrityManifestSha256: Sha256Schema,
    pipeline: z
      .object({
        repositoryId: SafeReferenceIdSchema,
        revision: PinnedRevisionSchema,
        scriptPath: RelativeInventoryPathSchema,
      })
      .strict(),
    entries: z.array(AssetBuildProvenanceEntryV1Schema).max(4_096),
  })
  .strict()
  .superRefine((provenance, context) => {
    const seen = new Set<string>();
    provenance.entries.forEach((entry, index) => {
      if (seen.has(entry.assetId)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "assetId"],
          message: "build provenance assetId values must be unique",
        });
      }
      seen.add(entry.assetId);
    });
  });
export type AssetBuildProvenanceV1 = Readonly<
  z.infer<typeof AssetBuildProvenanceV1Schema>
>;

const ReviewStatusSchema = z.enum(["approved", "pending", "blocked"]);
const ContentRatingSchema = z.enum(["general", "mature", "unreviewed"]);
const AllowedTransformSchema = z.enum([
  "scale-down",
  "crop-safe-area",
  "reduced-motion-static",
  "color-accessibility-adjustment",
]);

const VoiceEvidenceSchema = z
  .object({
    locale: LocaleSchema,
    sourceType: z.enum([
      "human-original",
      "synthetic-non-clone",
      "owner-authorized-reference-clone",
    ]),
    consentReferenceId: SafeReferenceIdSchema.nullable(),
    syntheticProvenanceReferenceId: SafeReferenceIdSchema.nullable(),
    spokenContentReviewReferenceId: SafeReferenceIdSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    switch (evidence.sourceType) {
      case "human-original":
        if (evidence.consentReferenceId === null) {
          context.addIssue({
            code: "custom",
            path: ["consentReferenceId"],
            message: "human-original voice requires a consent reference",
          });
        }
        if (evidence.syntheticProvenanceReferenceId !== null) {
          context.addIssue({
            code: "custom",
            path: ["syntheticProvenanceReferenceId"],
            message: "human-original voice cannot claim synthetic provenance",
          });
        }
        break;
      case "synthetic-non-clone":
        if (evidence.consentReferenceId !== null) {
          context.addIssue({
            code: "custom",
            path: ["consentReferenceId"],
            message: "synthetic-non-clone voice must use synthetic provenance",
          });
        }
        if (evidence.syntheticProvenanceReferenceId === null) {
          context.addIssue({
            code: "custom",
            path: ["syntheticProvenanceReferenceId"],
            message:
              "synthetic-non-clone voice requires a provenance reference",
          });
        }
        break;
      case "owner-authorized-reference-clone":
        if (evidence.consentReferenceId === null) {
          context.addIssue({
            code: "custom",
            path: ["consentReferenceId"],
            message:
              "owner-authorized-reference-clone voice requires a consent or authorization reference",
          });
        }
        if (evidence.syntheticProvenanceReferenceId !== null) {
          context.addIssue({
            code: "custom",
            path: ["syntheticProvenanceReferenceId"],
            message:
              "owner-authorized-reference-clone voice cannot claim synthetic-non-clone provenance",
          });
        }
        break;
    }
  });

const RightsLedgerEntrySchema = z
  .object({
    assetId: AssetIdSchema,
    association: AssetAssociationSchema,
    expectedSource: AssetSourceSnapshotSchema,
    expectedOutputSha256: Sha256Schema,
    rights: z
      .object({
        licenseStatus: ReviewStatusSchema,
        grantReferenceId: SafeReferenceIdSchema.nullable(),
        scopes: z
          .object({
            publicUse: z.boolean(),
            commercialUse: z.boolean(),
            modify: z.boolean(),
            redistribute: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    review: z
      .object({
        brandStatus: ReviewStatusSchema,
        brandReviewReferenceId: SafeReferenceIdSchema.nullable(),
        contentStatus: ReviewStatusSchema,
        contentReviewReferenceId: SafeReferenceIdSchema.nullable(),
        contentRating: ContentRatingSchema,
        disclosureId: SafeReferenceIdSchema.nullable(),
      })
      .strict(),
    presentation: z
      .object({
        altText: z
          .object({
            "zh-TW": PublicAltTextSchema,
            en: PublicAltTextSchema,
          })
          .strict()
          .nullable(),
        allowedTransforms: z
          .array(AllowedTransformSchema)
          .max(4)
          .refine((items) => new Set(items).size === items.length, {
            message: "allowedTransforms values must be unique",
          }),
      })
      .strict(),
    voiceEvidence: VoiceEvidenceSchema.optional(),
    releaseStatus: ReviewStatusSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.assetId !== assetIdForAssociation(entry.association)) {
      context.addIssue({
        code: "custom",
        path: ["assetId"],
        message: "assetId must be derived from the exact association tuple",
      });
    }
    if (
      entry.association.kind !== "voice" &&
      entry.voiceEvidence !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["voiceEvidence"],
        message: "voice evidence is allowed only for voice associations",
      });
    }
  });

/**
 * Owner-controlled input. It may contain blocked/pending decisions and must
 * never be copied into a public artifact; the assembler projects only the
 * approved, public-safe subset into AssetReleaseManifestV2.
 */
export const AssetRightsLedgerV2Schema = z
  .object({
    schemaVersion: z.literal(ASSET_RIGHTS_LEDGER_SCHEMA_VERSION),
    release: z
      .object({
        releaseId: SafeReferenceIdSchema,
        approvedAt: z.iso.datetime({ offset: true }).nullable(),
        expectedBuildProvenanceSha256: Sha256Schema.nullable(),
      })
      .strict(),
    entries: z.array(RightsLedgerEntrySchema).max(4_096),
  })
  .strict()
  .superRefine((ledger, context) => {
    const seen = new Set<string>();
    ledger.entries.forEach((entry, index) => {
      if (seen.has(entry.assetId)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "assetId"],
          message: "rights ledger assetId values must be unique",
        });
      }
      seen.add(entry.assetId);
    });
  });
export type AssetRightsLedgerV2 = Readonly<
  z.infer<typeof AssetRightsLedgerV2Schema>
>;

const ApprovedRightsSchema = z
  .object({
    licenseStatus: z.literal("approved"),
    grantReferenceId: SafeReferenceIdSchema,
    scopes: z
      .object({
        publicUse: z.literal(true),
        commercialUse: z.literal(true),
        modify: z.literal(true),
        redistribute: z.literal(true),
      })
      .strict(),
  })
  .strict();

const ApprovedReviewSchema = z
  .object({
    brandStatus: z.literal("approved"),
    brandReviewReferenceId: SafeReferenceIdSchema,
    contentStatus: z.literal("approved"),
    contentReviewReferenceId: SafeReferenceIdSchema,
    contentRating: z.literal("general"),
    disclosureId: SafeReferenceIdSchema,
  })
  .strict();

const ApprovedPresentationSchema = z
  .object({
    altText: z
      .object({
        "zh-TW": PublicAltTextSchema,
        en: PublicAltTextSchema,
      })
      .strict(),
    allowedTransforms: z
      .array(AllowedTransformSchema)
      .max(4)
      .refine((items) => new Set(items).size === items.length, {
        message: "allowedTransforms values must be unique",
      }),
  })
  .strict();

export const AssetReleaseEntryV2Schema = z
  .object({
    ...BuildProvenanceEntryShape,
    rights: ApprovedRightsSchema,
    review: ApprovedReviewSchema,
    presentation: ApprovedPresentationSchema,
    voiceEvidence: VoiceEvidenceSchema.optional(),
    releaseStatus: z.literal("approved"),
  })
  .strict()
  .superRefine((entry, context) => {
    validateAssetBinding(entry, context);
    if (
      (entry.association.kind === "voice") !==
      (entry.voiceEvidence !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["voiceEvidence"],
        message:
          "release voice entries require evidence and image entries prohibit it",
      });
    }
  });

/** The only asset contract that is eligible to be embedded in a public release. */
export const AssetReleaseManifestV2Schema = z
  .object({
    schemaVersion: z.literal(ASSET_RELEASE_MANIFEST_SCHEMA_VERSION),
    releaseId: SafeReferenceIdSchema,
    approvedAt: z.iso.datetime({ offset: true }),
    provenance: z
      .object({
        integrityManifestSha256: Sha256Schema,
        buildProvenanceSha256: Sha256Schema,
        pipeline: z
          .object({
            repositoryId: SafeReferenceIdSchema,
            revision: PinnedRevisionSchema,
            scriptPath: RelativeInventoryPathSchema,
          })
          .strict(),
      })
      .strict(),
    assets: z.array(AssetReleaseEntryV2Schema).min(1).max(4_096),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    manifest.assets.forEach((entry, index) => {
      if (seen.has(entry.assetId)) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "assetId"],
          message: "release assetId values must be unique",
        });
      }
      seen.add(entry.assetId);
    });
  });
export type AssetReleaseManifestV2 = Readonly<
  z.infer<typeof AssetReleaseManifestV2Schema>
>;

type MutableRuntimeTheme = {
  outfit: ObjectRef | null;
  poses: Partial<Record<(typeof ASSET_STATE_TRIGGERS)[number], ObjectRef>>;
};

type MutableRuntimeCharacter = {
  avatar: ObjectRef | null;
  themes: Map<WardrobeThemeId, MutableRuntimeTheme>;
};

function runtimeObjectRef(output: AssetOutputSnapshot): ObjectRef {
  const base = {
    path: output.path,
    bytes: output.bytes,
    sha256: output.sha256,
  };
  return output.media.mediaType === "audio/wav"
    ? base
    : {
        ...base,
        width: output.media.width,
        height: output.media.height,
      };
}

/**
 * Project the rights-approved public authority into the legacy cache-serving
 * shape. Runtime callers must never project schema-v1 integrity input directly.
 */
export function projectAssetReleaseManifestV2ToRuntimeManifest(
  input: unknown,
): AssetManifest {
  const release = AssetReleaseManifestV2Schema.parse(input);
  const characters = new Map<AssetCharacterId, MutableRuntimeCharacter>();
  const voices = new Map<
    AssetCharacterId,
    Array<{
      id: string;
      trigger: (typeof ASSET_VOICE_TRIGGERS)[number];
      object: ObjectRef;
      durationMs: number;
    }>
  >();

  const characterFor = (
    characterId: AssetCharacterId,
  ): MutableRuntimeCharacter => {
    const existing = characters.get(characterId);
    if (existing !== undefined) return existing;
    const created: MutableRuntimeCharacter = {
      avatar: null,
      themes: new Map(),
    };
    characters.set(characterId, created);
    return created;
  };

  const themeFor = (
    character: MutableRuntimeCharacter,
    themeId: WardrobeThemeId,
  ): MutableRuntimeTheme => {
    const existing = character.themes.get(themeId);
    if (existing !== undefined) return existing;
    const created: MutableRuntimeTheme = { outfit: null, poses: {} };
    character.themes.set(themeId, created);
    return created;
  };

  for (const asset of release.assets) {
    const object = runtimeObjectRef(asset.output);
    switch (asset.association.kind) {
      case "avatar":
        characterFor(asset.association.characterId).avatar = object;
        break;
      case "outfit":
        themeFor(
          characterFor(asset.association.characterId),
          asset.association.themeId,
        ).outfit = object;
        break;
      case "pose":
        themeFor(
          characterFor(asset.association.characterId),
          asset.association.themeId,
        ).poses[asset.association.state] = object;
        break;
      case "voice": {
        if (asset.output.media.mediaType !== "audio/wav") {
          throw new TypeError("approved voice output must be WAV");
        }
        const lines = voices.get(asset.association.characterId) ?? [];
        lines.push({
          id: asset.association.lineId,
          trigger: asset.association.trigger,
          object,
          durationMs: asset.output.media.durationMs,
        });
        voices.set(asset.association.characterId, lines);
        break;
      }
    }
  }

  const runtimeCharacters = ASSET_CHARACTER_IDS.flatMap((characterId) => {
    const character = characters.get(characterId);
    if (character === undefined) return [];
    if (character.avatar === null) {
      throw new TypeError(
        `approved image set for ${characterId} is missing its avatar`,
      );
    }
    const themes = WARDROBE_THEME_IDS.flatMap((themeId) => {
      const theme = character.themes.get(themeId);
      if (theme === undefined) return [];
      if (theme.outfit === null) {
        throw new TypeError(
          `approved image set for ${characterId}/${themeId} is missing its outfit`,
        );
      }
      return [
        {
          themeId,
          outfit: theme.outfit,
          poses: Object.fromEntries(
            ASSET_STATE_TRIGGERS.flatMap((state) => {
              const pose = theme.poses[state];
              return pose === undefined ? [] : [[state, pose]];
            }),
          ),
        },
      ];
    });
    return [{ characterId, avatar: character.avatar, themes }];
  });

  const runtimeVoices = ASSET_CHARACTER_IDS.flatMap((characterId) => {
    const lines = voices.get(characterId);
    if (lines === undefined) return [];
    return [
      {
        characterId,
        lines: [...lines].sort((left, right) => {
          const byId = compareCodePoints(left.id, right.id);
          return byId === 0
            ? compareCodePoints(left.trigger, right.trigger)
            : byId;
        }),
      },
    ];
  });

  return AssetManifestSchema.parse({
    schemaVersion: "1",
    generatedAt: release.approvedAt,
    characters: runtimeCharacters,
    voice: runtimeVoices,
  });
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("asset release hashing accepts JSON values only");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort(compareCodePoints)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Hash the parsed v1 integrity value independent of JSON object key order. */
export function computeAssetIntegrityManifestV1Sha256(input: unknown): string {
  return sha256CanonicalJson(AssetIntegrityManifestV1Schema.parse(input));
}

/** Hash the parsed build provenance independent of JSON object key order. */
export function computeAssetBuildProvenanceV1Sha256(input: unknown): string {
  return sha256CanonicalJson(AssetBuildProvenanceV1Schema.parse(input));
}

/**
 * Hash the complete parsed public release manifest. Object keys are
 * canonicalized, while array order remains part of the immutable contract.
 */
export function computeAssetReleaseManifestV2Sha256(input: unknown): string {
  return sha256CanonicalJson(AssetReleaseManifestV2Schema.parse(input));
}

type IntegrityAssociation = Readonly<{
  assetId: string;
  association: AssetAssociation;
  output: AssetOutputSnapshot;
}>;

function imageOutputSnapshot(object: ObjectRef): AssetOutputSnapshot {
  if (object.width === undefined || object.height === undefined) {
    throw new TypeError("parsed image integrity object is missing dimensions");
  }
  const mediaType = object.path.endsWith("webp")
    ? ("image/webp" as const)
    : ("image/png" as const);
  return AssetOutputSnapshotSchema.parse({
    path: object.path,
    bytes: object.bytes,
    sha256: object.sha256,
    media: {
      mediaType,
      width: object.width,
      height: object.height,
    },
  });
}

function voiceOutputSnapshot(
  object: ObjectRef,
  durationMs: number,
): AssetOutputSnapshot {
  return AssetOutputSnapshotSchema.parse({
    path: object.path,
    bytes: object.bytes,
    sha256: object.sha256,
    media: { mediaType: "audio/wav", durationMs },
  });
}

function flattenIntegrityManifest(
  manifest: AssetIntegrityManifestV1,
): ReadonlyArray<IntegrityAssociation> {
  const entries: IntegrityAssociation[] = [];
  for (const character of manifest.characters) {
    const avatarAssociation: AssetAssociation = {
      kind: "avatar",
      characterId: character.characterId,
    };
    entries.push({
      assetId: assetIdForAssociation(avatarAssociation),
      association: avatarAssociation,
      output: imageOutputSnapshot(character.avatar),
    });

    for (const theme of character.themes) {
      const outfitAssociation: AssetAssociation = {
        kind: "outfit",
        characterId: character.characterId,
        themeId: theme.themeId,
      };
      entries.push({
        assetId: assetIdForAssociation(outfitAssociation),
        association: outfitAssociation,
        output: imageOutputSnapshot(theme.outfit),
      });
      for (const state of ASSET_STATE_TRIGGERS) {
        const pose = theme.poses[state];
        if (pose === undefined) {
          continue;
        }
        const poseAssociation: AssetAssociation = {
          kind: "pose",
          characterId: character.characterId,
          themeId: theme.themeId,
          state,
        };
        entries.push({
          assetId: assetIdForAssociation(poseAssociation),
          association: poseAssociation,
          output: imageOutputSnapshot(pose),
        });
      }
    }
  }

  for (const characterVoice of manifest.voice) {
    for (const line of characterVoice.lines) {
      const voiceAssociation: AssetAssociation = {
        kind: "voice",
        characterId: characterVoice.characterId,
        lineId: line.id,
        trigger: line.trigger,
      };
      entries.push({
        assetId: assetIdForAssociation(voiceAssociation),
        association: voiceAssociation,
        output: voiceOutputSnapshot(line.object, line.durationMs),
      });
    }
  }
  return entries.sort((left, right) =>
    compareCodePoints(left.assetId, right.assetId),
  );
}

/** An assembly error never contains a partial release manifest. */
export class AssetReleaseAssemblyError extends Error {
  public constructor(problems: ReadonlyArray<string>) {
    super(`Asset release assembly failed:\n- ${problems.join("\n- ")}`);
    this.name = "AssetReleaseAssemblyError";
  }
}

function exactSetProblems(
  label: string,
  expectedIds: ReadonlySet<string>,
  actualIds: ReadonlySet<string>,
): string[] {
  const missing = [...expectedIds]
    .filter((id) => !actualIds.has(id))
    .sort(compareCodePoints);
  const extra = [...actualIds]
    .filter((id) => !expectedIds.has(id))
    .sort(compareCodePoints);
  return [
    ...(missing.length === 0
      ? []
      : [`${label} missing: ${missing.join(", ")}`]),
    ...(extra.length === 0 ? [] : [`${label} extra: ${extra.join(", ")}`]),
  ];
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export type AssembleAssetReleaseManifestV2Input = Readonly<{
  integrityManifest: unknown;
  buildProvenance: unknown;
  rightsLedger: unknown;
}>;

/**
 * Pure fail-closed join. Validation and every exact-set/hash/approval check
 * complete before the public manifest is constructed and returned.
 */
export function assembleAssetReleaseManifestV2(
  input: AssembleAssetReleaseManifestV2Input,
): AssetReleaseManifestV2 {
  const integrityManifest = AssetIntegrityManifestV1Schema.parse(
    input.integrityManifest,
  );
  const buildProvenance = AssetBuildProvenanceV1Schema.parse(
    input.buildProvenance,
  );
  const rightsLedger = AssetRightsLedgerV2Schema.parse(input.rightsLedger);
  const integrityEntries = flattenIntegrityManifest(integrityManifest);
  const integrityManifestSha256 =
    computeAssetIntegrityManifestV1Sha256(integrityManifest);
  const buildProvenanceSha256 =
    computeAssetBuildProvenanceV1Sha256(buildProvenance);

  const problems: string[] = [];
  if (buildProvenance.integrityManifestSha256 !== integrityManifestSha256) {
    problems.push("build provenance pins a stale integrity manifest hash");
  }
  if (
    rightsLedger.release.expectedBuildProvenanceSha256 !== buildProvenanceSha256
  ) {
    problems.push("rights ledger pins a stale build provenance hash");
  }

  const expectedIds = new Set(integrityEntries.map((entry) => entry.assetId));
  const buildById = new Map(
    buildProvenance.entries.map((entry) => [entry.assetId, entry] as const),
  );
  const rightsById = new Map(
    rightsLedger.entries.map((entry) => [entry.assetId, entry] as const),
  );
  problems.push(
    ...exactSetProblems(
      "build provenance",
      expectedIds,
      new Set(buildById.keys()),
    ),
    ...exactSetProblems(
      "rights ledger",
      expectedIds,
      new Set(rightsById.keys()),
    ),
  );

  if (rightsLedger.release.approvedAt === null) {
    problems.push("rights ledger release approval timestamp is missing");
  }

  const releaseAssets: Array<z.infer<typeof AssetReleaseEntryV2Schema>> = [];
  for (const integrityEntry of integrityEntries) {
    const entryProblemStart = problems.length;
    const buildEntry = buildById.get(integrityEntry.assetId);
    const rightsEntry = rightsById.get(integrityEntry.assetId);
    if (buildEntry === undefined || rightsEntry === undefined) {
      continue;
    }

    if (!sameJson(buildEntry.association, integrityEntry.association)) {
      problems.push(`${integrityEntry.assetId} build association is stale`);
    }
    if (!sameJson(buildEntry.output, integrityEntry.output)) {
      problems.push(
        `${integrityEntry.assetId} build output integrity is stale`,
      );
    }
    if (!sameJson(rightsEntry.association, integrityEntry.association)) {
      problems.push(`${integrityEntry.assetId} rights association is stale`);
    }
    if (!sameJson(rightsEntry.expectedSource, buildEntry.source)) {
      problems.push(
        `${integrityEntry.assetId} rights source snapshot is stale`,
      );
    }
    if (rightsEntry.expectedOutputSha256 !== buildEntry.output.sha256) {
      problems.push(`${integrityEntry.assetId} rights output hash is stale`);
    }
    if (rightsEntry.rights.licenseStatus !== "approved") {
      problems.push(`${integrityEntry.assetId} license is not approved`);
    }
    if (rightsEntry.rights.grantReferenceId === null) {
      problems.push(
        `${integrityEntry.assetId} written grant reference is missing`,
      );
    }
    for (const [scope, enabled] of Object.entries(rightsEntry.rights.scopes)) {
      if (!enabled) {
        problems.push(
          `${integrityEntry.assetId} rights scope ${scope} is not granted`,
        );
      }
    }
    if (rightsEntry.review.brandStatus !== "approved") {
      problems.push(`${integrityEntry.assetId} brand review is not approved`);
    }
    if (rightsEntry.review.brandReviewReferenceId === null) {
      problems.push(
        `${integrityEntry.assetId} brand review reference is missing`,
      );
    }
    if (rightsEntry.review.contentStatus !== "approved") {
      problems.push(`${integrityEntry.assetId} content review is not approved`);
    }
    if (rightsEntry.review.contentReviewReferenceId === null) {
      problems.push(
        `${integrityEntry.assetId} content review reference is missing`,
      );
    }
    if (rightsEntry.review.contentRating !== "general") {
      problems.push(`${integrityEntry.assetId} content rating is not general`);
    }
    if (rightsEntry.review.disclosureId === null) {
      problems.push(`${integrityEntry.assetId} required disclosure is missing`);
    }
    if (rightsEntry.presentation.altText === null) {
      problems.push(`${integrityEntry.assetId} bilingual alt text is missing`);
    }
    if (rightsEntry.releaseStatus !== "approved") {
      problems.push(`${integrityEntry.assetId} release status is not approved`);
    }
    if (
      integrityEntry.association.kind === "voice" &&
      rightsEntry.voiceEvidence === undefined
    ) {
      problems.push(`${integrityEntry.assetId} voice evidence is missing`);
    }

    if (problems.length !== entryProblemStart) {
      continue;
    }
    const grantReferenceId = rightsEntry.rights.grantReferenceId;
    const brandReviewReferenceId = rightsEntry.review.brandReviewReferenceId;
    const contentReviewReferenceId =
      rightsEntry.review.contentReviewReferenceId;
    const disclosureId = rightsEntry.review.disclosureId;
    const altText = rightsEntry.presentation.altText;
    if (
      grantReferenceId === null ||
      brandReviewReferenceId === null ||
      contentReviewReferenceId === null ||
      disclosureId === null ||
      altText === null
    ) {
      throw new TypeError("asset release approval narrowing failed");
    }

    releaseAssets.push({
      assetId: buildEntry.assetId,
      association: buildEntry.association,
      source: buildEntry.source,
      output: buildEntry.output,
      generationHistory: buildEntry.generationHistory,
      rights: {
        licenseStatus: "approved",
        grantReferenceId,
        scopes: {
          publicUse: true,
          commercialUse: true,
          modify: true,
          redistribute: true,
        },
      },
      review: {
        brandStatus: "approved",
        brandReviewReferenceId,
        contentStatus: "approved",
        contentReviewReferenceId,
        contentRating: "general",
        disclosureId,
      },
      presentation: {
        altText,
        allowedTransforms: rightsEntry.presentation.allowedTransforms,
      },
      ...(rightsEntry.voiceEvidence === undefined
        ? {}
        : { voiceEvidence: rightsEntry.voiceEvidence }),
      releaseStatus: "approved",
    });
  }

  if (problems.length > 0) {
    throw new AssetReleaseAssemblyError(problems);
  }
  const approvedAt = rightsLedger.release.approvedAt;
  if (approvedAt === null) {
    throw new TypeError("asset release approval timestamp narrowing failed");
  }

  return AssetReleaseManifestV2Schema.parse({
    schemaVersion: ASSET_RELEASE_MANIFEST_SCHEMA_VERSION,
    releaseId: rightsLedger.release.releaseId,
    approvedAt,
    provenance: {
      integrityManifestSha256,
      buildProvenanceSha256,
      pipeline: buildProvenance.pipeline,
    },
    assets: releaseAssets,
  });
}
