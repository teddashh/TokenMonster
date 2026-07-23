import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import {
  MONSTER_CHARACTER_IDS_V1,
  MONSTER_TRAIT_IDS_V1,
} from "@tokenmonster/monster-engine";
import { describe, expect, it } from "vitest";

import {
  ASSET_VOICE_TRIGGERS,
  AssetReleaseManifestV2Schema,
  PROGRESSION_CHARACTER_IDS,
} from "../src/index.js";
import {
  AssetPackAllowlistV1Schema,
  AssetPackDescriptorV1Schema,
  planFixedAssetPack,
} from "../src/asset-pack.js";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "../..");
const SOURCE_MAP_PATH = join(PACKAGE_ROOT, "ai-sister-source-map.json");
const SOURCE_MAP_SCHEMA_PATH = join(
  PACKAGE_ROOT,
  "ai-sister-source-map.schema.json",
);

interface CharacterSourceEntry {
  sourceId: string;
  displayName: string;
  kind: "sister" | "friend";
  tokenMonsterCharacterId: string | null;
  heroThemeId: string;
  trackedArt: {
    avatar: string;
    hero: string;
    personaReferences: string[];
  };
  externalWardrobe: {
    sourceKey: string;
    coverage: "complete-candidate-bank" | "missing";
  };
}

interface WardrobeThemeEntry {
  themeId: string;
  styleFacet: string;
  recommendedWhen: { traitAny: string[] };
}

interface SemanticStateEntry {
  stateId: string;
  sourcePosePreference: string;
  actionPreferences: string[];
  fallbackStateId: string | null;
  reducedMotionFallbackId: string | null;
}

interface AiSisterSourceMap {
  $schema: string;
  schemaVersion: number;
  auditedAt: string;
  source: {
    repository: string;
    commit: string;
    externalCandidateLibrary: {
      logicalRoot: string;
      kind: string;
      trackedBySourceRepository: boolean;
    };
  };
  cloudDelivery: {
    owner: string;
    storage: string;
    publicDelivery: string;
    publicOrigin: string;
    objectPrefix: string;
    manifestObjectPattern: string;
    packObjectPattern: string;
    manifestTrust: string;
    publisherRunsIn: string;
    tokenMonsterRole: string;
    downloadMode: string;
    requestCardinality: string;
    objectImmutability: string;
    cachePolicy: string;
    integrity: string;
    initialRenderedAssetStates: string[];
    rawLayerPartsPublished: boolean;
    networkFailureFallback: string;
    status: string;
  };
  rosterAudit: {
    target: { sisters: number; friends: number };
    confirmed: { sisters: number; friends: number };
    unresolvedSlots: Array<{ kind: string; count: number; reason: string }>;
  };
  starterSelection: {
    availableCharacterIds: string[];
    providerCharacterMap: Record<string, string>;
    window: string;
    signal: string;
    rule: string;
    tieOutcome: string;
    noDataOutcome: string;
    manualOverride: string;
    persistence: string;
    usedForProgression: boolean;
    leavesDevice: boolean;
    adapterReadiness: string;
  };
  characters: CharacterSourceEntry[];
  wardrobe: {
    themes: WardrobeThemeEntry[];
    styleFacetEffect: string;
    recommendationIsUnlockGate: boolean;
    unlockPolicy: {
      status: string;
      implementedAllowedSignals: string[];
      forbiddenForCloudSignals: string[];
      note: string;
    };
    externalCandidateBank: {
      inventoryStatus: string;
      coveredPersonaIds: string[];
      candidateAssetStates: string[];
      observedCounts: {
        personas: number;
        themesPerPersona: number;
        outfits: number;
        reactionPoses: number;
        layeredPartSets: number;
      };
      relativePathTemplates: Record<string, string>;
    };
  };
  animation: {
    classification: string;
    standardRuntimeFormatsPresent: string[];
    runtimeCompatibility: string;
    capabilities: string[];
    actionVocabulary: string[];
    semanticStates: SemanticStateEntry[];
  };
  releasePolicy: {
    runtimeUse: string;
    copyCandidateBinariesIntoRepository: boolean;
    requiredBeforeRuntimeUse: string[];
    fallbackRenderer: string;
  };
}

type JsonObject = Record<string, unknown>;

const sourceMap = JSON.parse(
  readFileSync(SOURCE_MAP_PATH, "utf8"),
) as AiSisterSourceMap;
const sourceMapSchema = JSON.parse(
  readFileSync(SOURCE_MAP_SCHEMA_PATH, "utf8"),
) as JsonObject;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveLocalReference(
  reference: string,
  root: JsonObject,
): JsonObject {
  if (!reference.startsWith("#/")) {
    throw new Error(
      `Only local JSON Schema references are supported: ${reference}`,
    );
  }

  let current: unknown = root;
  for (const encodedSegment of reference.slice(2).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isJsonObject(current) || !(segment in current)) {
      throw new Error(`Unresolvable JSON Schema reference: ${reference}`);
    }
    current = current[segment];
  }

  if (!isJsonObject(current)) {
    throw new Error(`JSON Schema reference is not an object: ${reference}`);
  }
  return current;
}

function isType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isJsonObject(value);
    case "string":
      return typeof value === "string";
    default:
      throw new Error(
        `Unsupported JSON Schema type in test validator: ${expectedType}`,
      );
  }
}

function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

function isValidUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol.length > 1;
  } catch {
    return false;
  }
}

/**
 * The source-map schema intentionally uses a small, assertion-oriented subset
 * of draft 2020-12. Keeping this validator beside the repository-only map
 * avoids adding an undeclared runtime/schema dependency to the package.
 */
function validateJsonSchema(
  value: unknown,
  schema: JsonObject,
  root: JsonObject,
  path = "$",
): string[] {
  const reference = schema["$ref"];
  if (typeof reference === "string") {
    return validateJsonSchema(
      value,
      resolveLocalReference(reference, root),
      root,
      path,
    );
  }

  const errors: string[] = [];
  const expectedType = schema["type"];
  if (typeof expectedType === "string" && !isType(value, expectedType)) {
    return [`${path}: expected ${expectedType}`];
  }

  if ("const" in schema && !jsonEquals(value, schema["const"])) {
    errors.push(`${path}: does not match const`);
  }

  const enumValues = schema["enum"];
  if (
    Array.isArray(enumValues) &&
    !enumValues.some((candidate) => jsonEquals(value, candidate))
  ) {
    errors.push(`${path}: is not in enum`);
  }

  if (typeof value === "string") {
    const minLength = schema["minLength"];
    if (typeof minLength === "number" && value.length < minLength) {
      errors.push(`${path}: shorter than minLength`);
    }
    const pattern = schema["pattern"];
    if (typeof pattern === "string" && !new RegExp(pattern, "u").test(value)) {
      errors.push(`${path}: does not match pattern`);
    }
    const format = schema["format"];
    if (format === "date" && !isValidCalendarDate(value)) {
      errors.push(`${path}: invalid date`);
    }
    if (format === "uri" && !isValidUri(value)) {
      errors.push(`${path}: invalid URI`);
    }
  }

  if (Array.isArray(value)) {
    const minItems = schema["minItems"];
    const maxItems = schema["maxItems"];
    if (typeof minItems === "number" && value.length < minItems) {
      errors.push(`${path}: fewer than minItems`);
    }
    if (typeof maxItems === "number" && value.length > maxItems) {
      errors.push(`${path}: more than maxItems`);
    }
    if (schema["uniqueItems"] === true) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) {
        errors.push(`${path}: items are not unique`);
      }
    }
    const itemSchema = schema["items"];
    if (isJsonObject(itemSchema)) {
      value.forEach((item, index) => {
        errors.push(
          ...validateJsonSchema(item, itemSchema, root, `${path}[${index}]`),
        );
      });
    }
  }

  if (isJsonObject(value)) {
    const properties = isJsonObject(schema["properties"])
      ? schema["properties"]
      : {};
    const required = Array.isArray(schema["required"])
      ? schema["required"].filter(
          (property): property is string => typeof property === "string",
        )
      : [];

    for (const property of required) {
      if (!(property in value)) {
        errors.push(`${path}.${property}: required property missing`);
      }
    }

    if (schema["additionalProperties"] === false) {
      for (const property of Object.keys(value)) {
        if (!(property in properties)) {
          errors.push(`${path}.${property}: additional property`);
        }
      }
    }

    for (const [property, propertySchema] of Object.entries(properties)) {
      if (property in value && isJsonObject(propertySchema)) {
        errors.push(
          ...validateJsonSchema(
            value[property],
            propertySchema,
            root,
            `${path}.${property}`,
          ),
        );
      }
    }
  }

  return errors;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function isRelativeNoHostReference(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("\\") ||
    value.includes("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
    /^www\./i.test(value)
  ) {
    return false;
  }
  if (value.split("/").includes("..")) {
    return false;
  }
  const firstSegment = value.split("/")[0];
  return (
    firstSegment !== undefined && !/^[^/]+\.[A-Za-z]{2,}$/.test(firstSegment)
  );
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

describe("AI-Sister repository-only source map", () => {
  it("keeps audit documentation pinned to the canonical source commit", () => {
    const documentation = [
      join(REPOSITORY_ROOT, "THIRD_PARTY_NOTICES.md"),
      join(REPOSITORY_ROOT, "docs", "CHARACTER_WARDROBE_MAP.md"),
    ].map((path) => readFileSync(path, "utf8"));

    for (const source of documentation) {
      expect(source).toContain(sourceMap.source.commit);
    }
  });

  it("validates against its strict draft 2020-12 schema", () => {
    expect(sourceMap.$schema).toBe("./ai-sister-source-map.schema.json");
    expect(sourceMapSchema["$schema"]).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(
      validateJsonSchema(sourceMap, sourceMapSchema, sourceMapSchema),
    ).toEqual([]);

    const hostedPath = structuredClone(sourceMap);
    hostedPath.wardrobe.externalCandidateBank.relativePathTemplates["outfit"] =
      "https://assets.example.test/outfit.png";
    expect(
      validateJsonSchema(hostedPath, sourceMapSchema, sourceMapSchema),
    ).not.toEqual([]);

    const undocumentedField = structuredClone(
      sourceMap,
    ) as unknown as JsonObject;
    const source = undocumentedField["source"];
    expect(isJsonObject(source)).toBe(true);
    if (isJsonObject(source)) {
      source["unexpectedRuntimeInput"] = true;
    }
    expect(
      validateJsonSchema(undocumentedField, sourceMapSchema, sourceMapSchema),
    ).not.toEqual([]);

    const claimedStandardRig = structuredClone(sourceMap);
    claimedStandardRig.animation.standardRuntimeFormatsPresent.push("live2d");
    expect(
      validateJsonSchema(claimedStandardRig, sourceMapSchema, sourceMapSchema),
    ).not.toEqual([]);

    const wrongInventory = structuredClone(sourceMap);
    wrongInventory.wardrobe.externalCandidateBank.observedCounts.personas = 10;
    expect(
      validateJsonSchema(wrongInventory, sourceMapSchema, sourceMapSchema),
    ).not.toEqual([]);

    const missingR2Trust = structuredClone(sourceMap) as unknown as JsonObject;
    const cloudDelivery = missingR2Trust["cloudDelivery"];
    expect(isJsonObject(cloudDelivery)).toBe(true);
    if (isJsonObject(cloudDelivery)) {
      delete cloudDelivery["manifestTrust"];
    }
    expect(
      validateJsonSchema(missingR2Trust, sourceMapSchema, sourceMapSchema),
    ).not.toEqual([]);
  });

  it("records four sisters, seven confirmed friends, and one unresolved friend", () => {
    expect(sourceMap.rosterAudit).toMatchObject({
      target: { sisters: 4, friends: 8 },
      confirmed: { sisters: 4, friends: 7 },
      unresolvedSlots: [{ kind: "friend", count: 1 }],
    });
    expect(sourceMap.characters).toHaveLength(11);
    expect(
      sourceMap.characters.filter(({ kind }) => kind === "sister"),
    ).toHaveLength(4);
    expect(
      sourceMap.characters.filter(({ kind }) => kind === "friend"),
    ).toHaveLength(7);
    expect(
      new Set(sourceMap.characters.map(({ sourceId }) => sourceId)).size,
    ).toBe(11);
    expect(
      new Set(sourceMap.characters.map(({ heroThemeId }) => heroThemeId)).size,
    ).toBe(11);

    for (const character of sourceMap.characters) {
      expect(character.externalWardrobe.sourceKey).toBe(character.sourceId);
      expect(character.displayName.length).toBeGreaterThan(0);
      expect(character.tokenMonsterCharacterId).toBe(character.sourceId);
    }

    expect(
      sourceMap.characters.map(
        ({ tokenMonsterCharacterId }) => tokenMonsterCharacterId,
      ),
    ).toEqual(PROGRESSION_CHARACTER_IDS.filter((id) => id !== "reserved"));

    expect(
      sourceMap.characters
        .filter(
          ({ externalWardrobe }) => externalWardrobe.coverage === "missing",
        )
        .map(({ sourceId }) => sourceId),
    ).toEqual([]);
  });

  it("keeps first-run starter selection explicit, local, and progression-safe", () => {
    expect(sorted(sourceMap.starterSelection.availableCharacterIds)).toEqual(
      sorted(MONSTER_CHARACTER_IDS_V1),
    );
    expect(sourceMap.starterSelection.providerCharacterMap).toEqual({
      openai: "chatgpt",
      anthropic: "claude",
      google: "gemini",
      xai: "grok",
    });
    expect(sourceMap.starterSelection).toMatchObject({
      window: "not-applicable",
      signal: "explicit-player-choice",
      rule: "choose-one-of-four",
      tieOutcome: "explicit-user-choice",
      noDataOutcome: "explicit-user-choice",
      manualOverride: "always",
      persistence: "local-preference-only",
      usedForProgression: true,
      leavesDevice: false,
      adapterReadiness: "not-required-for-choice",
    });
  });

  it("maps twenty unique cosmetic themes and facets only to monster-engine traits", () => {
    const themes = sourceMap.wardrobe.themes;
    expect(themes).toHaveLength(20);
    expect(new Set(themes.map(({ themeId }) => themeId)).size).toBe(20);
    expect(new Set(themes.map(({ styleFacet }) => styleFacet)).size).toBe(20);

    const referencedTraits = new Set(
      themes.flatMap(({ recommendedWhen }) => recommendedWhen.traitAny),
    );
    expect(sorted([...referencedTraits])).toEqual(sorted(MONSTER_TRAIT_IDS_V1));
    expect(sourceMap.wardrobe.styleFacetEffect).toBe(
      "cosmetic-presentation-only",
    );
    expect(sourceMap.wardrobe.recommendationIsUnlockGate).toBe(false);
    expect(sourceMap.wardrobe.unlockPolicy).toMatchObject({
      status: "implemented-local-milestones",
      implementedAllowedSignals: [
        "local-provider-cumulative-total",
        "local-distinct-active-provider-breadth",
        "local-active-day-streak",
        "local-lifetime-total",
        "local-allowlisted-workflow-trait",
      ],
      note: "Owner-approved 2026-07-16: usage-milestone progression; all signals local-only and never leave the device.",
    });
    expect(sourceMap.wardrobe.unlockPolicy.forbiddenForCloudSignals).toEqual(
      expect.arrayContaining([
        "absolute-token-volume",
        "cost",
        "spending",
        "prompt-content",
        "project-path",
        "filename",
      ]),
    );
  });

  it("records the observed complete 11/20/220/660/220 bank including GLM", () => {
    const bank = sourceMap.wardrobe.externalCandidateBank;
    expect(bank.observedCounts).toEqual({
      personas: 11,
      themesPerPersona: 20,
      outfits: 220,
      reactionPoses: 660,
      layeredPartSets: 220,
    });
    expect(new Set(bank.coveredPersonaIds).size).toBe(11);
    expect(bank.coveredPersonaIds).toContain("glm");
    expect(sorted(bank.coveredPersonaIds)).toEqual(
      sorted(
        sourceMap.characters
          .filter(
            ({ externalWardrobe }) =>
              externalWardrobe.coverage === "complete-candidate-bank",
          )
          .map(({ sourceId }) => sourceId),
      ),
    );
    expect(sorted(bank.candidateAssetStates)).toEqual(
      sorted(["outfit", "supported", "challenged", "victory"]),
    );
  });

  it("keeps every candidate and R2 object reference relative and host-free", () => {
    const references = [
      sourceMap.source.externalCandidateLibrary.logicalRoot,
      sourceMap.cloudDelivery.objectPrefix,
      sourceMap.cloudDelivery.manifestObjectPattern,
      sourceMap.cloudDelivery.packObjectPattern,
      ...sourceMap.characters.flatMap(({ trackedArt }) => [
        trackedArt.avatar,
        trackedArt.hero,
        ...trackedArt.personaReferences,
      ]),
      ...Object.values(
        sourceMap.wardrobe.externalCandidateBank.relativePathTemplates,
      ),
    ];

    for (const reference of references) {
      expect(reference, `unsafe source-map reference: ${reference}`).toSatisfy(
        isRelativeNoHostReference,
      );
      expect(reference).not.toContain("/home/");
    }
  });

  it("describes a custom 2.5D pipeline without claiming a standard rig", () => {
    expect(sourceMap.animation.classification).toBe("custom-layered-2.5d");
    expect(sourceMap.animation.standardRuntimeFormatsPresent).toEqual([]);
    expect(sourceMap.animation.runtimeCompatibility).toBe(
      "requires-tokenmonster-renderer-port",
    );
    expect(sourceMap.animation.capabilities).toEqual(
      expect.arrayContaining([
        "layer-compositing",
        "idle-sway",
        "breathing",
        "blink",
        "viseme-lip-sync",
        "static-reaction-pose-swap",
      ]),
    );
  });

  it("keeps action, state, fallback, and reduced-motion references closed", () => {
    const actions = new Set(sourceMap.animation.actionVocabulary);
    const states = new Map(
      sourceMap.animation.semanticStates.map((state) => [state.stateId, state]),
    );
    expect(actions.size).toBe(sourceMap.animation.actionVocabulary.length);
    expect(states.size).toBe(sourceMap.animation.semanticStates.length);

    for (const state of states.values()) {
      for (const action of state.actionPreferences) {
        expect(actions.has(action), `${state.stateId} -> ${action}`).toBe(true);
      }
      if (state.fallbackStateId !== null) {
        expect(
          states.has(state.fallbackStateId),
          `${state.stateId} -> ${state.fallbackStateId}`,
        ).toBe(true);
      }
      if (state.stateId === "idle-static") {
        expect(state.reducedMotionFallbackId).toBeNull();
      } else {
        expect(state.reducedMotionFallbackId).toBe("idle-static");
      }

      const visited = new Set<string>();
      let cursor: SemanticStateEntry = state;
      while (cursor.fallbackStateId !== null) {
        expect(
          visited.has(cursor.stateId),
          `fallback cycle at ${cursor.stateId}`,
        ).toBe(false);
        visited.add(cursor.stateId);
        const next = states.get(cursor.fallbackStateId);
        expect(
          next,
          `missing fallback ${cursor.fallbackStateId}`,
        ).toBeDefined();
        if (next === undefined) {
          break;
        }
        cursor = next;
      }
      expect(cursor.stateId).toBe("idle-static");
    }

    expect(
      [...states.values()]
        .filter(
          ({ sourcePosePreference }) => sourcePosePreference === "victory",
        )
        .map(({ stateId }) => stateId),
    ).toEqual(["wardrobe-unlocked"]);
  });

  it("keeps the published AI-Sister image-and-voice pack immutable and integrity-bound", () => {
    expect(sourceMap.cloudDelivery).toMatchObject({
      owner: "ai-sister",
      storage: "cloudflare-r2",
      publicDelivery: "ai-sister-cdn",
      publicOrigin: "https://cdn.ted-h.com",
      manifestTrust: "release-embedded-approved-copy",
      publisherRunsIn: "ai-sister",
      tokenMonsterRole: "manifest-consumer-and-local-cache",
      downloadMode: "explicit-consent-single-fixed-pack",
      requestCardinality: "one-get-independent-of-local-state",
      objectImmutability: "versioned-path-no-overwrite",
      cachePolicy: "content-addressed-local-cache",
      integrity: "sha256-per-object",
      rawLayerPartsPublished: false,
      networkFailureFallback: "tokenmonster-letter-avatar-v1",
      status: "published-image-and-voice-fixed-pack",
    });
    expect(sourceMap.cloudDelivery.manifestObjectPattern).toBe(
      `${sourceMap.cloudDelivery.objectPrefix}/releases/{releaseId}/asset-release-manifest-v2.json`,
    );
    expect(sourceMap.cloudDelivery.packObjectPattern).toBe(
      `${sourceMap.cloudDelivery.objectPrefix}/packs/{releaseId}/{packSha256}.zip`,
    );
    expect(sorted(sourceMap.cloudDelivery.initialRenderedAssetStates)).toEqual(
      sorted(sourceMap.wardrobe.externalCandidateBank.candidateAssetStates),
    );
    expect(sourceMap.releasePolicy.requiredBeforeRuntimeUse).toContain(
      "ai-sister-r2-publisher-and-cache-smoke",
    );
  });

  it("binds approved runtime use to the exact non-null release slots without copying binaries", () => {
    expect(sourceMap.releasePolicy).toMatchObject({
      runtimeUse: "approved-explicit-consent-image-and-voice-fixed-pack",
      copyCandidateBinariesIntoRepository: false,
      fallbackRenderer: "tokenmonster-letter-avatar-v1",
    });
    expect(sourceMap.releasePolicy.requiredBeforeRuntimeUse).toEqual(
      expect.arrayContaining([
        "explicit-redistribution-and-modification-grant",
        "per-asset-integrity-manifest",
        "provider-brand-review",
        "content-rating-review",
        "reviewed-browser-renderer",
        "explicit-consent-fixed-pack-delivery",
      ]),
    );

    const releaseManifest = AssetReleaseManifestV2Schema.parse(
      JSON.parse(
        readFileSync(
          join(PACKAGE_ROOT, "src", "approved-release-v2.json"),
          "utf8",
        ),
      ) as unknown,
    );
    const descriptor = AssetPackDescriptorV1Schema.parse(
      JSON.parse(
        readFileSync(
          join(PACKAGE_ROOT, "src", "approved-asset-pack-descriptor-v1.json"),
          "utf8",
        ),
      ) as unknown,
    );
    const allowlist = AssetPackAllowlistV1Schema.parse(
      JSON.parse(
        readFileSync(
          join(PACKAGE_ROOT, "src", "approved-asset-pack-allowlist-v1.json"),
          "utf8",
        ),
      ) as unknown,
    );
    const plan = planFixedAssetPack({ releaseManifest, descriptor, allowlist });
    expect(releaseManifest.assets).toHaveLength(946);
    const voiceAssets = releaseManifest.assets.filter(
      ({ association }) => association.kind === "voice",
    );
    expect(voiceAssets).toHaveLength(55);
    for (const character of sourceMap.characters) {
      const triggers = voiceAssets.flatMap(({ association }) =>
        association.kind === "voice" &&
        association.characterId === character.sourceId
          ? [association.trigger]
          : [],
      );
      expect(sorted(triggers), character.sourceId).toEqual(
        sorted(ASSET_VOICE_TRIGGERS),
      );
    }
    expect(allowlist.origin).toBe(sourceMap.cloudDelivery.publicOrigin);
    expect(descriptor.pack.path).toBe(allowlist.path);
    expect(plan.url).toBe(`${allowlist.origin}${allowlist.path}`);
    expect(
      descriptor.pack.path.startsWith(
        `/${sourceMap.cloudDelivery.objectPrefix}/packs/`,
      ),
    ).toBe(true);

    const forbiddenCandidateExtensions = new Set([
      ".avif",
      ".bin",
      ".gif",
      ".moc3",
      ".mp4",
      ".png",
      ".riv",
      ".skel",
      ".webm",
      ".webp",
      ".wav",
    ]);
    const copiedCandidates = listFiles(PACKAGE_ROOT).filter((path) =>
      forbiddenCandidateExtensions.has(extname(path).toLowerCase()),
    );
    expect(copiedCandidates).toEqual([]);
  });
});
