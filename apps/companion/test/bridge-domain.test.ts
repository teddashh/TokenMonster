import { beforeEach, describe, expect, it } from "vitest";

import {
  createFixedInteraction,
  getCompanionBootstrap,
  selectCompanionCharacter
} from "../src/main/bridge-domain.js";

describe("minimal companion bridge domain", () => {
  beforeEach(() => {
    selectCompanionCharacter("chatgpt");
  });

  it("returns four code-native, local-only character choices", () => {
    const result = getCompanionBootstrap();
    expect(result.mode).toBe("local-only");
    expect(result.characters.map(({ id }) => id)).toEqual([
      "chatgpt",
      "claude",
      "gemini",
      "grok"
    ]);
    expect(result.collector.state).toBe("not-configured");
    expect(result.contribution).toMatchObject({
      configured: false,
      secureStorage: "unavailable",
      state: "unavailable",
      enabled: false,
      canEnable: false,
      canDelete: false
    });
    expect(result.byok.configured).toBe(false);
    expect(result.monster).toMatchObject({
      characterId: "chatgpt",
      identityStatus: "learning",
      coverage: "insufficient",
      traits: []
    });
  });

  it("does not expose asset paths, credentials, or hidden content", () => {
    const serialized = JSON.stringify(getCompanionBootstrap());
    expect(serialized).not.toMatch(
      /\.webp|assetPath|sourcePath|apiKey|uploadToken|deletionToken|statusToken|prompt|response/i
    );
  });

  it("selects only a stable character id", () => {
    expect(selectCompanionCharacter("gemini").selectedCharacterId).toBe("gemini");
    expect(() => selectCompanionCharacter("unknown")).toThrow();
    expect(() =>
      selectCompanionCharacter({ id: "claude", prompt: "PRIVATE_CANARY" })
    ).toThrow();
  });

  it("rejects a monster summary for a different selected character", () => {
    const current = getCompanionBootstrap();
    expect(() =>
      getCompanionBootstrap(undefined, undefined, {
        ...current.monster,
        characterId: "claude"
      })
    ).toThrowError("MONSTER_CHARACTER_MISMATCH");
  });

  it("returns deterministic fixed-line content for the same seed", () => {
    const request = { characterId: "claude", trigger: "greeting" };
    expect(createFixedInteraction(request, 7)).toEqual(
      createFixedInteraction(request, 7)
    );
    expect(createFixedInteraction(request, 7)).toMatchObject({
      kind: "fixed-line",
      characterId: "claude"
    });
  });

  it("rejects arbitrary interaction text and unknown triggers", () => {
    expect(() =>
      createFixedInteraction(
        {
          characterId: "chatgpt",
          trigger: "greeting",
          message: "PRIVATE-PROMPT-CANARY"
        },
        1
      )
    ).toThrow();
    expect(() =>
      createFixedInteraction({ characterId: "chatgpt", trigger: "custom" }, 1)
    ).toThrow();
  });

  it("binds fixed lines to the selected monster state", () => {
    const monster = getCompanionBootstrap().monster;
    expect(() =>
      createFixedInteraction(
        { characterId: "claude", trigger: "idle" },
        1,
        monster
      )
    ).toThrowError("MONSTER_CHARACTER_MISMATCH");
    expect(
      createFixedInteraction(
        { characterId: "chatgpt", trigger: "idle" },
        1,
        {
          ...monster,
          identityStatus: "ready",
          coverage: "partial",
          mood: "steady",
          moodLabel: "今天節奏穩定",
          energy: "medium",
          evolution: "initial-profile",
          traits: [
            {
              id: "cli-focused",
              label: "CLI 專注型",
              reason: "已收集足跡主要來自核准的 CLI 工具。"
            }
          ]
        }
      )
    ).toMatchObject({ kind: "fixed-line", characterId: "chatgpt" });
  });
});
