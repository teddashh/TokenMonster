import { describe, expect, it } from "vitest";

import {
  AssetBuildProvenanceV1Schema,
  AssetReleaseManifestV2Schema,
  AssetRightsLedgerV2Schema,
  assembleAssetReleaseManifestV2,
  assetIdForAssociation,
  computeAssetBuildProvenanceV1Sha256,
  computeAssetIntegrityManifestV1Sha256,
  projectAssetReleaseManifestV2ToRuntimeManifest,
  type AssetAssociation,
} from "../src/index.js";

const HASHES = {
  avatar: "a".repeat(64),
  outfit: "b".repeat(64),
  pose: "c".repeat(64),
  voice: "d".repeat(64),
  sourceAvatar: "1".repeat(64),
  sourceOutfit: "2".repeat(64),
  sourcePose: "3".repeat(64),
  sourceVoice: "4".repeat(64),
  inventory: "8".repeat(64),
} as const;

function imageObject(hash: string, width: number, height: number) {
  return {
    path: `objects/${hash}.webp`,
    bytes: 1_024,
    sha256: hash,
    width,
    height,
  };
}

function integrityManifest(
  characterId: "chatgpt" | "glm" = "chatgpt",
  includeVoice = true,
) {
  return {
    schemaVersion: "1" as const,
    generatedAt: "2026-07-17T12:00:00.000Z",
    characters: [
      {
        characterId,
        avatar: imageObject(HASHES.avatar, 256, 256),
        themes: [
          {
            themeId: "tech",
            outfit: imageObject(HASHES.outfit, 512, 840),
            poses: {
              supported: imageObject(HASHES.pose, 500, 840),
            },
          },
        ],
      },
    ],
    voice: includeVoice
      ? [
          {
            characterId,
            lines: [
              {
                id: `${characterId}-greeting`,
                trigger: "greeting" as const,
                object: {
                  path: `objects/${HASHES.voice}.wav`,
                  bytes: 8_192,
                  sha256: HASHES.voice,
                },
                durationMs: 1_250,
              },
            ],
          },
        ]
      : [],
  };
}

function associations(
  characterId: "chatgpt" | "glm",
  includeVoice: boolean,
): AssetAssociation[] {
  return [
    { kind: "avatar", characterId },
    { kind: "outfit", characterId, themeId: "tech" },
    {
      kind: "pose",
      characterId,
      themeId: "tech",
      state: "supported",
    },
    ...(includeVoice
      ? ([
          {
            kind: "voice",
            characterId,
            lineId: `${characterId}-greeting`,
            trigger: "greeting",
          },
        ] satisfies AssetAssociation[])
      : []),
  ];
}

function outputFor(association: AssetAssociation) {
  switch (association.kind) {
    case "avatar":
      return {
        path: `objects/${HASHES.avatar}.webp`,
        bytes: 1_024,
        sha256: HASHES.avatar,
        media: { mediaType: "image/webp" as const, width: 256, height: 256 },
      };
    case "outfit":
      return {
        path: `objects/${HASHES.outfit}.webp`,
        bytes: 1_024,
        sha256: HASHES.outfit,
        media: { mediaType: "image/webp" as const, width: 512, height: 840 },
      };
    case "pose":
      return {
        path: `objects/${HASHES.pose}.webp`,
        bytes: 1_024,
        sha256: HASHES.pose,
        media: { mediaType: "image/webp" as const, width: 500, height: 840 },
      };
    case "voice":
      return {
        path: `objects/${HASHES.voice}.wav`,
        bytes: 8_192,
        sha256: HASHES.voice,
        media: { mediaType: "audio/wav" as const, durationMs: 1_250 },
      };
  }
}

function sourceHashFor(association: AssetAssociation): string {
  switch (association.kind) {
    case "avatar":
      return HASHES.sourceAvatar;
    case "outfit":
      return HASHES.sourceOutfit;
    case "pose":
      return HASHES.sourcePose;
    case "voice":
      return HASHES.sourceVoice;
  }
}

function validInputs({
  characterId = "chatgpt",
  includeVoice = true,
}: {
  characterId?: "chatgpt" | "glm";
  includeVoice?: boolean;
} = {}) {
  const integrity = integrityManifest(characterId, includeVoice);
  const tuples = associations(characterId, includeVoice);
  const buildEntries = tuples.map((association) => {
    const output = outputFor(association);
    const isVoice = association.kind === "voice";
    const sourceSha256 = sourceHashFor(association);
    return {
      assetId: assetIdForAssociation(association),
      association,
      source: {
        inventoryId: "ai-sister-reviewed-inventory",
        inventoryRevision: HASHES.inventory,
        path: isVoice
          ? `voice/${characterId}__greeting.wav`
          : `tachie/${characterId}/${association.kind}.png`,
        sha256: sourceSha256,
      },
      upstream: {
        repository: {
          repositoryId: "ai-sister",
          revision: "e".repeat(40),
        },
        steps: [
          {
            operation: isVoice ? ("import" as const) : ("generate" as const),
            receipt: {
              path: `receipts/${characterId}-${association.kind}.json`,
              sha256: "d".repeat(64),
            },
            tool: { name: "fixture-source-tool", version: "1.0.0" },
            model: isVoice ? null : "fixture-image-model",
            inputs: [],
            outputSha256: sourceSha256,
          },
        ],
      },
      output,
      generationHistory: {
        tool: { name: "ffmpeg", version: "7.1.1" },
        sourceMediaType: isVoice ? "audio/wav" : "image/png",
        resize:
          output.media.mediaType === "audio/wav"
            ? null
            : {
                width: output.media.width,
                height: output.media.height,
                algorithm: "lanczos",
              },
        encoding: {
          mediaType: output.media.mediaType,
          quality: output.media.mediaType === "image/webp" ? 82 : null,
        },
        metadataStripped: true,
      },
    };
  });
  const buildProvenance = {
    schemaVersion: "1" as const,
    createdAt: "2026-07-17T12:01:00.000Z",
    integrityManifestSha256: computeAssetIntegrityManifestV1Sha256(integrity),
    pipeline: {
      repositoryId: "tokenmonster",
      revision: "f".repeat(40),
      scriptPath: "scripts/asset-pipeline/build-manifest.mjs",
    },
    entries: buildEntries,
  };
  const rightsLedger = {
    schemaVersion: "2" as const,
    release: {
      releaseId: "characters-2026.07.17",
      approvedAt: "2026-07-17T13:00:00.000Z",
      expectedBuildProvenanceSha256:
        computeAssetBuildProvenanceV1Sha256(buildProvenance),
    },
    entries: buildEntries.map((entry) => ({
      assetId: entry.assetId,
      association: entry.association,
      expectedSource: structuredClone(entry.source),
      expectedOutputSha256: entry.output.sha256,
      rights: {
        licenseStatus: "approved" as const,
        grantReferenceId: "grant-public-commercial-v1",
        scopes: {
          publicUse: true,
          commercialUse: true,
          modify: true,
          redistribute: true,
        },
      },
      review: {
        brandStatus: "approved" as const,
        brandReviewReferenceId: "brand-review-v1",
        contentStatus: "approved" as const,
        contentReviewReferenceId: "content-review-v1",
        contentRating: "general" as const,
        disclosureId: "tokenmonster-unaffiliated-v1",
      },
      presentation: {
        altText: {
          "zh-TW": `${characterId} 的角色圖像`,
          en: `${characterId} character art`,
        },
        allowedTransforms: ["scale-down" as const],
      },
      ...(entry.association.kind === "voice"
        ? {
            voiceEvidence: {
              locale: "zh-TW",
              sourceType: "synthetic-non-clone" as const,
              consentReferenceId: null,
              syntheticProvenanceReferenceId: "synthetic-voice-v1",
              spokenContentReviewReferenceId: "spoken-content-review-v1",
            },
          }
        : {}),
      releaseStatus: "approved" as const,
    })),
  };
  return { integrityManifest: integrity, buildProvenance, rightsLedger };
}

type VoiceEvidenceFixture = {
  locale: string;
  sourceType:
    | "human-original"
    | "synthetic-non-clone"
    | "owner-authorized-reference-clone";
  consentReferenceId: string | null;
  syntheticProvenanceReferenceId: string | null;
  spokenContentReviewReferenceId: string;
};

function setVoiceEvidence(
  inputs: ReturnType<typeof validInputs>,
  evidence: VoiceEvidenceFixture,
): void {
  const voiceEntry = inputs.rightsLedger.entries.find(
    ({ association }) => association.kind === "voice",
  );
  if (voiceEntry === undefined) {
    throw new Error("voice fixture entry is missing");
  }
  (
    voiceEntry as unknown as {
      voiceEvidence: VoiceEvidenceFixture;
    }
  ).voiceEvidence = evidence;
}

function ownerAuthorizedReferenceCloneEvidence(): VoiceEvidenceFixture {
  return {
    locale: "zh-TW",
    sourceType: "owner-authorized-reference-clone",
    consentReferenceId: "owner-voice-authorization-v1",
    syntheticProvenanceReferenceId: null,
    spokenContentReviewReferenceId: "spoken-content-review-v1",
  };
}

describe("asset release manifest v2 assembler", () => {
  it("joins exact integrity, provenance, and rights rows into the only shippable schema", () => {
    const release = assembleAssetReleaseManifestV2(validInputs());

    expect(AssetReleaseManifestV2Schema.parse(release)).toEqual(release);
    expect(release.assets.map(({ association }) => association.kind)).toEqual([
      "avatar",
      "outfit",
      "pose",
      "voice",
    ]);
    expect(
      release.assets.every(({ releaseStatus }) => releaseStatus === "approved"),
    ).toBe(true);
    expect(JSON.stringify(release)).not.toContain("expectedOutputSha256");
  });

  it("allows an image-only GLM release without requiring GLM or voice", () => {
    const inputs = validInputs({ characterId: "glm", includeVoice: false });
    const release = assembleAssetReleaseManifestV2(inputs);

    expect(
      new Set(release.assets.map(({ association }) => association.characterId)),
    ).toEqual(new Set(["glm"]));
    expect(
      release.assets.some(({ association }) => association.kind === "voice"),
    ).toBe(false);
    expect(projectAssetReleaseManifestV2ToRuntimeManifest(release)).toEqual({
      ...inputs.integrityManifest,
      generatedAt: release.approvedAt,
    });
  });

  it("projects only a complete approved v2 image set into runtime cache authority", () => {
    const inputs = validInputs();
    const release = assembleAssetReleaseManifestV2(inputs);

    expect(projectAssetReleaseManifestV2ToRuntimeManifest(release)).toEqual({
      ...inputs.integrityManifest,
      generatedAt: release.approvedAt,
    });

    const missingAvatar = {
      ...structuredClone(release),
      assets: release.assets.filter(
        ({ association }) => association.kind !== "avatar",
      ),
    };
    expect(() =>
      projectAssetReleaseManifestV2ToRuntimeManifest(missingAvatar),
    ).toThrow(/missing its avatar/u);

    const missingOutfit = {
      ...structuredClone(release),
      assets: release.assets.filter(
        ({ association }) => association.kind !== "outfit",
      ),
    };
    expect(() =>
      projectAssetReleaseManifestV2ToRuntimeManifest(missingOutfit),
    ).toThrow(/missing its outfit/u);
  });

  it("fails closed on missing and extra join rows", () => {
    const missing = structuredClone(validInputs());
    missing.buildProvenance.entries.pop();
    expect(() => assembleAssetReleaseManifestV2(missing)).toThrow(
      /build provenance missing/u,
    );

    const extra = structuredClone(validInputs());
    const extraEntry = structuredClone(extra.rightsLedger.entries[0]!);
    extraEntry.association = { kind: "avatar", characterId: "glm" };
    extraEntry.assetId = assetIdForAssociation(extraEntry.association);
    extra.rightsLedger.entries.push(extraEntry);
    expect(() => assembleAssetReleaseManifestV2(extra)).toThrow(
      /rights ledger extra/u,
    );
  });

  it("rejects duplicate provenance and ledger asset IDs before joining", () => {
    const duplicateBuild = structuredClone(validInputs());
    duplicateBuild.buildProvenance.entries.push(
      structuredClone(duplicateBuild.buildProvenance.entries[0]!),
    );
    expect(
      AssetBuildProvenanceV1Schema.safeParse(duplicateBuild.buildProvenance)
        .success,
    ).toBe(false);

    const duplicateRights = structuredClone(validInputs());
    duplicateRights.rightsLedger.entries.push(
      structuredClone(duplicateRights.rightsLedger.entries[0]!),
    );
    expect(
      AssetRightsLedgerV2Schema.safeParse(duplicateRights.rightsLedger).success,
    ).toBe(false);
  });

  it("rejects stale manifest, output, and source hashes", () => {
    const staleManifest = structuredClone(validInputs());
    staleManifest.buildProvenance.integrityManifestSha256 = "0".repeat(64);
    expect(() => assembleAssetReleaseManifestV2(staleManifest)).toThrow(
      /stale integrity manifest hash/u,
    );

    const staleBuildApproval = structuredClone(validInputs());
    staleBuildApproval.rightsLedger.release.expectedBuildProvenanceSha256 =
      "0".repeat(64);
    expect(() => assembleAssetReleaseManifestV2(staleBuildApproval)).toThrow(
      /rights ledger pins a stale build provenance hash/u,
    );

    const staleOutput = structuredClone(validInputs());
    staleOutput.rightsLedger.entries[0]!.expectedOutputSha256 = "0".repeat(64);
    expect(() => assembleAssetReleaseManifestV2(staleOutput)).toThrow(
      /rights output hash is stale/u,
    );

    const staleSource = structuredClone(validInputs());
    staleSource.rightsLedger.entries[0]!.expectedSource.sha256 = "0".repeat(64);
    expect(() => assembleAssetReleaseManifestV2(staleSource)).toThrow(
      /rights source snapshot is stale/u,
    );
  });

  it("rejects non-approved decisions and any missing rights scope", () => {
    const pending = structuredClone(validInputs());
    const pendingEntry = pending.rightsLedger.entries[0]! as unknown as {
      rights: { licenseStatus: string };
      releaseStatus: string;
    };
    pendingEntry.rights.licenseStatus = "pending";
    pendingEntry.releaseStatus = "blocked";
    expect(() => assembleAssetReleaseManifestV2(pending)).toThrow(
      /license is not approved/u,
    );

    const incompleteScope = structuredClone(validInputs());
    incompleteScope.rightsLedger.entries[0]!.rights.scopes.redistribute = false;
    expect(() => assembleAssetReleaseManifestV2(incompleteScope)).toThrow(
      /rights scope redistribute is not granted/u,
    );
  });

  it("requires independent voice evidence without storing spoken text", () => {
    const missingEvidence = structuredClone(validInputs());
    const voice = missingEvidence.rightsLedger.entries.find(
      ({ association }) => association.kind === "voice",
    );
    expect(voice).toBeDefined();
    delete voice!.voiceEvidence;

    expect(() => assembleAssetReleaseManifestV2(missingEvidence)).toThrow(
      /voice evidence is missing/u,
    );

    const release = assembleAssetReleaseManifestV2(validInputs());
    const voiceRelease = release.assets.find(
      ({ association }) => association.kind === "voice",
    );
    expect(voiceRelease?.voiceEvidence).toMatchObject({
      sourceType: "synthetic-non-clone",
      spokenContentReviewReferenceId: "spoken-content-review-v1",
    });
    expect(JSON.stringify(release)).not.toContain("spokenText");
  });

  it("assembles an owner-authorized reference clone without a non-clone provenance claim", () => {
    const inputs = validInputs();
    const evidence = ownerAuthorizedReferenceCloneEvidence();
    setVoiceEvidence(inputs, evidence);

    expect(AssetRightsLedgerV2Schema.parse(inputs.rightsLedger)).toEqual(
      inputs.rightsLedger,
    );
    const release = assembleAssetReleaseManifestV2(inputs);
    expect(
      release.assets.find(
        ({ association }) => association.kind === "voice",
      )?.voiceEvidence,
    ).toEqual(evidence);
    expect(JSON.stringify(release)).not.toContain("spokenText");
  });

  it("fails clone evidence closed without authorization, spoken review, or with non-clone provenance", () => {
    const cases: Array<{
      name: string;
      mutate: (evidence: VoiceEvidenceFixture) => void;
      expected: RegExp;
    }> = [
      {
        name: "authorization",
        mutate: (evidence) => {
          evidence.consentReferenceId = null;
        },
        expected: /requires a consent or authorization reference/u,
      },
      {
        name: "non-clone provenance",
        mutate: (evidence) => {
          evidence.syntheticProvenanceReferenceId = "synthetic-voice-v1";
        },
        expected: /cannot claim synthetic-non-clone provenance/u,
      },
    ];

    for (const { name, mutate, expected } of cases) {
      const inputs = validInputs();
      const evidence = ownerAuthorizedReferenceCloneEvidence();
      mutate(evidence);
      setVoiceEvidence(inputs, evidence);
      expect(
        () => AssetRightsLedgerV2Schema.parse(inputs.rightsLedger),
        name,
      ).toThrow(expected);
    }

    const missingSpokenReview = validInputs();
    const incompleteEvidence = ownerAuthorizedReferenceCloneEvidence() as Omit<
      VoiceEvidenceFixture,
      "spokenContentReviewReferenceId"
    > &
      Partial<
        Pick<VoiceEvidenceFixture, "spokenContentReviewReferenceId">
      >;
    delete incompleteEvidence.spokenContentReviewReferenceId;
    setVoiceEvidence(
      missingSpokenReview,
      incompleteEvidence as VoiceEvidenceFixture,
    );
    expect(
      AssetRightsLedgerV2Schema.safeParse(missingSpokenReview.rightsLedger)
        .success,
    ).toBe(false);

    const unknownCloneKey = validInputs();
    setVoiceEvidence(unknownCloneKey, {
      ...ownerAuthorizedReferenceCloneEvidence(),
      privateReceiptPath: "/private/receipt.json",
    } as VoiceEvidenceFixture);
    expect(
      AssetRightsLedgerV2Schema.safeParse(unknownCloneKey.rightsLedger).success,
    ).toBe(false);
  });

  it("continues to assemble human-original voice evidence", () => {
    const inputs = validInputs();
    setVoiceEvidence(inputs, {
      locale: "zh-TW",
      sourceType: "human-original",
      consentReferenceId: "speaker-consent-v1",
      syntheticProvenanceReferenceId: null,
      spokenContentReviewReferenceId: "spoken-content-review-v1",
    });

    const release = assembleAssetReleaseManifestV2(inputs);
    expect(
      release.assets.find(
        ({ association }) => association.kind === "voice",
      )?.voiceEvidence,
    ).toMatchObject({
      sourceType: "human-original",
      consentReferenceId: "speaker-consent-v1",
      syntheticProvenanceReferenceId: null,
    });
  });

  it("rejects absolute, traversing, URL, and Windows source inventory paths", () => {
    for (const path of [
      "/private/bank/chatgpt.png",
      "../bank/chatgpt.png",
      "https://assets.example/chatgpt.png",
      "C:\\bank\\chatgpt.png",
    ]) {
      const input = structuredClone(validInputs());
      input.buildProvenance.entries[0]!.source.path = path;
      expect(
        AssetBuildProvenanceV1Schema.safeParse(input.buildProvenance).success,
        path,
      ).toBe(false);
    }
  });

  it("makes approval literals and strict keys non-bypassable in public v2", () => {
    const release = assembleAssetReleaseManifestV2(
      validInputs(),
    ) as unknown as {
      assets: Array<{ releaseStatus: string; privateEvidence?: string }>;
    };
    release.assets[0]!.releaseStatus = "blocked";
    expect(AssetReleaseManifestV2Schema.safeParse(release).success).toBe(false);

    const unknownKey = assembleAssetReleaseManifestV2(
      validInputs(),
    ) as unknown as {
      assets: Array<{ privateEvidence?: string }>;
    };
    unknownKey.assets[0]!.privateEvidence = "must-not-ship";
    expect(AssetReleaseManifestV2Schema.safeParse(unknownKey).success).toBe(
      false,
    );

    const unstripped = structuredClone(validInputs());
    (
      unstripped.buildProvenance.entries[0]!.generationHistory as unknown as {
        metadataStripped: boolean;
      }
    ).metadataStripped = false;
    expect(
      AssetBuildProvenanceV1Schema.safeParse(unstripped.buildProvenance)
        .success,
    ).toBe(false);
  });
});
