import {
  deriveMonsterState,
  type ContentBlindFootprintV1,
  type MonsterDerivationV1,
} from "@tokenmonster/monster-engine";
import { describe, expect, it, vi } from "vitest";

import {
  CHARACTER_IDS,
  FIXED_LINE_CONTENT_VERSION,
  FIXED_LINE_CONTENT_RATING,
  FIXED_LINE_LICENSE_STATUS,
  FIXED_LINE_COOLDOWNS,
  FIXED_LINE_LOCALES,
  FIXED_LINE_SCHEMA_VERSION,
  FIXED_LINE_TRIGGERS,
  FixedLineDefinitionSchema,
  MONSTER_MOODS,
  MONSTER_TRAITS,
  PROVIDER_AFFILIATION,
  PROVIDER_RELATIONSHIP,
  createCharacterPresentation,
  createCharacterPresentationFromMonsterDerivation,
  getPlaceholderVisual,
  listCharacters,
  listFixedLineDefinitions,
  readonlyTraitViewFromMonsterDerivation,
  resolveCharacterVisual,
  resolveCharacterVisualFromManifest,
  resolveFixedLineLocale,
  selectFixedLine,
  selectFixedLineFromMonsterDerivation,
  switchCharacterPresentation,
  type CharacterId,
  type FixedLineSelectionInput,
} from "../src/index.js";

function makeLegacyManifest(
  characterId: CharacterId,
  status: "blocked" | "approved",
): unknown {
  return {
    schemaVersion: 1,
    updatedAt: "2026-07-15",
    source: {
      repository: "https://example.test/character-source.git",
      commit: "0123456789abcdef0123456789abcdef01234567",
    },
    releasePolicy: {
      requiredStatus: "approved",
      licenseGate: "Legacy string, not a structured rights grant.",
      brandGate: "Legacy string, not structured brand evidence.",
      voiceGate: "Legacy string, not structured voice evidence.",
    },
    assets: [
      {
        id: `candidate-${characterId}-portrait`,
        characterId,
        sourcePath: `web/public/avatars/candidate-${characterId}.webp`,
        sha256: "a".repeat(64),
        bytes: 12_345,
        mediaType: "image/webp",
        dimensions: { width: 208, height: 208 },
        contentRating: "sfw-character-portrait",
        licenseStatus:
          status === "approved" ? "approved" : "pending-owner-grant",
        brandReview: status === "approved" ? "approved" : "required",
        releaseStatus: status,
      },
    ],
  };
}

function makeDerivation(): MonsterDerivationV1 {
  const start = Date.parse("2026-06-18T00:00:00.000Z");
  const footprint: ContentBlindFootprintV1 = {
    schemaVersion: "1",
    characterId: "chatgpt",
    window: {
      from: "2026-06-18",
      to: "2026-07-15",
      timezone: "America/New_York",
    },
    latestDayCompleteness: "complete",
    days: Array.from({ length: 28 }, (_, index) => ({
      localDate: new Date(start + index * 86_400_000)
        .toISOString()
        .slice(0, 10),
      coverage: "observed" as const,
      aggregates: [
        {
          provider: "openai" as const,
          modelFamily: "openai-codex" as const,
          tool: "codex-cli" as const,
          valueQuality: "exact" as const,
          cacheReadAvailability: "observed" as const,
          tokens: {
            input: "100",
            output: "20",
            cacheRead: "80",
            cacheWrite: "0",
            reasoning: "5",
            other: "0",
            total: "200",
          },
        },
      ],
    })),
  };
  return deriveMonsterState(footprint, null);
}

const BASE_SELECTION_INPUT = {
  characterId: "chatgpt",
  locale: "en",
  trigger: "greeting",
  mood: "steady",
  traits: ["cli-focused", "provider-focused"],
  seed: 42,
} as const satisfies FixedLineSelectionInput;

describe("character catalog", () => {
  it("contains exactly the four stable character IDs", () => {
    expect(CHARACTER_IDS).toEqual(["chatgpt", "claude", "gemini", "grok"]);
    expect(listCharacters().map(({ id }) => id)).toEqual(CHARACTER_IDS);
    expect(new Set(listCharacters().map(({ id }) => id)).size).toBe(4);
  });

  it("owns the four starter aliases and provider-neutral zh-TW personality taglines", () => {
    expect(
      listCharacters().map(({ id, alias, tagline }) => ({
        id,
        alias,
        taglineZhTw: tagline["zh-TW"],
      })),
    ).toEqual([
      {
        id: "chatgpt",
        alias: "Aster",
        taglineZhTw: "沉著務實，會把選項整理清楚，陪你照自己的步調決定。",
      },
      {
        id: "claude",
        alias: "Cedar",
        taglineZhTw: "溫柔細膩，願意留白，也陪你慢慢想清楚每個細節。",
      },
      {
        id: "gemini",
        alias: "Mira",
        taglineZhTw: "好奇敏銳，喜歡發現日常模式，從不替你的節奏打分。",
      },
      {
        id: "grok",
        alias: "Rook",
        taglineZhTw: "直率活潑，帶點玩心，給你輕快但不催促的陪伴。",
      },
    ]);
    for (const character of listCharacters()) {
      expect(Object.isFrozen(character.tagline)).toBe(true);
      expect(character.tagline["zh-TW"]).not.toMatch(
        /OpenAI|ChatGPT|Anthropic|Claude|Google|Gemini|xAI|Grok/iu,
      );
    }
  });

  it("describes every persona as provider-inspired and independent", () => {
    for (const character of listCharacters()) {
      expect(character.inspiration.relationship).toBe(PROVIDER_RELATIONSHIP);
      expect(character.inspiration.affiliation).toBe(PROVIDER_AFFILIATION);
      expect(character.disclosure.en).toContain("independent");
      expect(character.disclosure.en).toContain("unaffiliated");
      expect(character.personaContext.safeguards).toEqual({
        providerAffiliationClaim: "never",
        providerEndorsementClaim: "never",
        billingAuthority: "none",
        hiddenContentAccess: "none",
        encourageTokenConsumption: "never",
      });
    }
  });
});

describe("asset release gate", () => {
  it("always has a code-native placeholder for every character", () => {
    for (const characterId of CHARACTER_IDS) {
      expect(getPlaceholderVisual(characterId)).toMatchObject({
        kind: "placeholder",
        characterId,
        renderer: "tokenmonster-letter-avatar-v1",
      });
      expect(resolveCharacterVisual(characterId)).toBe(
        getPlaceholderVisual(characterId),
      );
    }
  });

  it("does not release a legacy v1 manifest even when every old status says approved", () => {
    for (const characterId of CHARACTER_IDS) {
      for (const status of ["blocked", "approved"] as const) {
        const result = resolveCharacterVisualFromManifest(
          characterId,
          makeLegacyManifest(characterId, status),
        );
        expect(result).toBe(getPlaceholderVisual(characterId));
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(`candidate-${characterId}-portrait`);
        expect(serialized).not.toContain("web/public");
        expect(serialized).not.toContain(".webp");
        expect(serialized).not.toContain("sha256");
      }
    }
  });

  it("fails closed for malformed or future-looking documents", () => {
    expect(resolveCharacterVisualFromManifest("grok", { assets: [] })).toBe(
      getPlaceholderVisual("grok"),
    );
    expect(
      resolveCharacterVisualFromManifest("grok", {
        schemaVersion: 2,
        assets: [{ releaseStatus: "approved" }],
      }),
    ).toBe(getPlaceholderVisual("grok"));
  });

  it("does not evaluate candidate manifest properties at runtime", () => {
    const candidate = new Proxy(
      {},
      {
        get() {
          throw new Error("candidate manifest must remain repository-only");
        },
      },
    );
    expect(resolveCharacterVisualFromManifest("claude", candidate)).toBe(
      getPlaceholderVisual("claude"),
    );
  });
});

describe("offline fixed-line engine", () => {
  it("uses the monster engine's exact public mood and trait registries", () => {
    expect(MONSTER_MOODS).toEqual([
      "learning",
      "unknown",
      "resting",
      "quiet",
      "steady",
      "lively",
    ]);
    expect(MONSTER_TRAITS).toEqual([
      "cli-focused",
      "tool-focused",
      "multi-tool",
      "provider-focused",
      "multi-provider",
      "cache-savvy",
      "output-heavy",
      "night-oriented",
      "balanced",
    ]);
  });

  it("has versioned copy for every character, locale, trigger, and tone variant", () => {
    const lines = listFixedLineDefinitions();
    expect(lines).toHaveLength(
      CHARACTER_IDS.length *
        FIXED_LINE_LOCALES.length *
        FIXED_LINE_TRIGGERS.length *
        3,
    );
    for (const characterId of CHARACTER_IDS) {
      for (const locale of FIXED_LINE_LOCALES) {
        for (const trigger of FIXED_LINE_TRIGGERS) {
          const matching = lines.filter(
            (line) =>
              line.characterId === characterId &&
              line.locale === locale &&
              line.trigger === trigger,
          );
          expect(matching.map(({ variant }) => variant)).toEqual([
            "general",
            "active",
            "quiet",
          ]);
          for (const line of matching) {
            expect(line.schemaVersion).toBe(FIXED_LINE_SCHEMA_VERSION);
            expect(line.contentVersion).toBe(FIXED_LINE_CONTENT_VERSION);
            expect(FixedLineDefinitionSchema.safeParse(line).success).toBe(
              true,
            );
            expect(line.contentRating).toBe(FIXED_LINE_CONTENT_RATING);
            expect(line.provenance).toEqual({
              kind: "tokenmonster-original-copy",
              sourceId: "tokenmonster-fixed-lines-v1",
              licenseStatus: FIXED_LINE_LICENSE_STATUS,
            });
            expect(line.fallbackLineId).toBe(
              line.variant === "general"
                ? null
                : `${line.lineId.slice(0, line.lineId.lastIndexOf("/") + 1)}general`,
            );
          }
        }
      }
    }
  });

  it("fails closed on malformed runtime line content and fallback metadata", () => {
    const line = listFixedLineDefinitions()[0]!;
    expect(
      FixedLineDefinitionSchema.safeParse({ ...line, text: "" }).success,
    ).toBe(false);
    expect(
      FixedLineDefinitionSchema.safeParse({
        ...line,
        variant: "active",
        fallbackLineId: null,
      }).success,
    ).toBe(false);
    expect(
      FixedLineDefinitionSchema.safeParse({
        ...line,
        provenance: { ...line.provenance, licenseStatus: "MIT" },
      }).success,
    ).toBe(false);
  });

  it("returns the same selection regardless of trait input order", () => {
    expect(selectFixedLine(BASE_SELECTION_INPUT)).toEqual(
      selectFixedLine({
        ...BASE_SELECTION_INPUT,
        traits: ["cli-focused", "provider-focused"],
      }),
    );
    expect(
      selectFixedLine({
        ...BASE_SELECTION_INPUT,
        traits: ["provider-focused", "cli-focused"],
      }),
    ).toEqual(selectFixedLine(BASE_SELECTION_INPUT));
  });

  it("falls back locales predictably", () => {
    expect(resolveFixedLineLocale("zh-Hant-TW")).toBe("zh-TW");
    expect(resolveFixedLineLocale("zh_TW")).toBe("zh-TW");
    expect(resolveFixedLineLocale("en-US")).toBe("en");
    expect(resolveFixedLineLocale("fr-CA")).toBe("en");
    expect(
      selectFixedLine({ ...BASE_SELECTION_INPUT, locale: "fr-CA" }).locale,
    ).toBe("en");
  });

  it("returns the declared trigger cooldown metadata", () => {
    for (const trigger of FIXED_LINE_TRIGGERS) {
      const result = selectFixedLine({ ...BASE_SELECTION_INPUT, trigger });
      expect(result.cooldown).toEqual({
        scope: "character-trigger",
        key: `chatgpt:${trigger}`,
        ...FIXED_LINE_COOLDOWNS[trigger],
      });
      expect(result.cooldown.durationMs).toBeGreaterThan(0);
      expect(result.cooldown.dailyCap).toBeGreaterThan(0);
    }
  });

  it.each(["usage", "prompt", "path", "session"])(
    "rejects hidden or sensitive input field %s",
    (forbiddenField) => {
      expect(() =>
        selectFixedLine({
          ...BASE_SELECTION_INPUT,
          [forbiddenField]: "must-not-enter-selection",
        }),
      ).toThrow();
    },
  );

  it("rejects non-engine moods, traits, and unsafe triggers", () => {
    expect(() =>
      selectFixedLine({ ...BASE_SELECTION_INPUT, mood: "active" }),
    ).toThrow();
    expect(() =>
      selectFixedLine({ ...BASE_SELECTION_INPUT, traits: ["focused"] }),
    ).toThrow();
    expect(() =>
      selectFixedLine({ ...BASE_SELECTION_INPUT, trigger: "buy-more" }),
    ).toThrow();
  });

  it("contains no shame, billing claim, or consumption incentive canaries", () => {
    const forbidden =
      /wast(?:e|ed|eful)|lazy|failure|shame|guilt|bill(?:ing)?|cost|charge|invoice|price|burn|spend|more tokens|浪費|偷懶|罪惡|糟糕|落後|不夠努力|帳單|花費|費用|燒(?:掉)?|再多用|衝高/iu;
    for (const line of listFixedLineDefinitions()) {
      expect(line.text, line.lineId).not.toMatch(forbidden);
    }
  });

  it("performs selection without a network request", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    selectFixedLine(BASE_SELECTION_INPUT);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("monster-engine composition", () => {
  it("passes an actual derivation into presentation and fixed-line selection", () => {
    const derivation = makeDerivation();
    const expectedView = {
      mood: derivation.state.mood.id,
      traits: derivation.state.traits.map((trait) => trait.id),
    };

    expect(readonlyTraitViewFromMonsterDerivation(derivation)).toEqual(
      expectedView,
    );
    expect(
      createCharacterPresentationFromMonsterDerivation("gemini", derivation)
        .traitView,
    ).toEqual(expectedView);
    expect(
      selectFixedLineFromMonsterDerivation(
        {
          characterId: "gemini",
          locale: "zh-TW",
          trigger: "greeting",
          seed: 17,
        },
        derivation,
      ),
    ).toMatchObject({
      characterId: "gemini",
      locale: "zh-TW",
      trigger: "greeting",
    });
  });

  it("switches characters while preserving the engine's exact mood and traits", () => {
    const derivation = makeDerivation();
    const traitView = readonlyTraitViewFromMonsterDerivation(derivation);
    const presentations = CHARACTER_IDS.map((characterId) =>
      switchCharacterPresentation(characterId, traitView),
    );

    for (const presentation of presentations) {
      expect(presentation.traitView.mood).toBe(derivation.state.mood.id);
      expect(presentation.traitView.traits).toEqual(
        derivation.state.traits.map((trait) => trait.id),
      );
      expect(presentation.visual.kind).toBe("placeholder");
    }
  });

  it("still accepts an already projected readonly trait view", () => {
    const result = createCharacterPresentation("claude", {
      mood: "steady",
      traits: ["balanced"],
    });
    expect(result.character.id).toBe("claude");
    expect(result.visual.kind).toBe("placeholder");
    expect(result.traitView).toEqual({ mood: "steady", traits: ["balanced"] });
  });
});
