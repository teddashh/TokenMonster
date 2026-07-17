import { describe, expect, it, vi } from "vitest";

import {
  applyCharacterSelection,
  applyCharacterWardrobe,
  characterUnlockToastText,
  coalesceCharacterUnlocks,
  createPortraitSwitchStateMachine,
  createCharacterImageFallbackTracker,
  createCharacterUnlockQueue,
  createVoicePlaybackGate,
  diffCharacterUnlocks,
  enabledCharacterAnimationClasses,
  isGlmLetterCharacter,
  parseCharactersSnapshot,
  requestCharacterSelection,
  requestCharacterWardrobe,
  resolveCompanionView,
  resolveCharacterPose,
  visibleCharacterRoster,
  type CharacterFetch,
  type CharactersSnapshot,
  type VoicePreferenceStorage
} from "../src/public/app.js";

const IMAGE_PATH = `/assets/characters/objects/${"a".repeat(64)}.webp`;
const POSE_PATH = `/assets/characters/objects/${"b".repeat(64)}.png`;
const AUDIO_PATH = `/assets/characters/objects/${"c".repeat(64)}.wav`;

const CHARACTER_RESPONSE = {
  status: "ok",
  generatedAt: "2026-07-16T12:00:00.000Z",
  unlockBatchId: "2026-07-02T00:00:00.000Z",
  selection: { characterId: "chatgpt", selectedBy: "auto-starter" },
  voiceEnabled: true,
  characters: [
    {
      characterId: "chatgpt",
      displayName: "ChatGPT",
      kind: "sister",
      unlocked: true,
      unlockedAt: "2026-07-01T00:00:00.000Z",
      isStarter: true,
      activeThemeId: "tech",
      visual: {
        mode: "doll",
        avatarPath: IMAGE_PATH,
        themes: [
          {
            themeId: "tech",
            unlocked: true,
            outfitPath: IMAGE_PATH,
            posePaths: {
              supported: POSE_PATH,
              challenged: null,
              victory: POSE_PATH
            }
          }
        ]
      },
      progress: null,
      voiceLines: [
        {
          id: "hello",
          trigger: "greeting",
          path: AUDIO_PATH,
          durationMs: 1_200
        }
      ]
    },
    {
      characterId: "glm",
      displayName: "GLM",
      kind: "sister",
      unlocked: true,
      unlockedAt: "2026-07-02T00:00:00.000Z",
      isStarter: false,
      activeThemeId: null,
      visual: {
        mode: "letter",
        glyph: "C",
        background: "#f4c993",
        foreground: "#754825",
        accent: "#f2bc68"
      },
      progress: null,
      voiceLines: []
    },
    {
      characterId: "sakana",
      displayName: "Sakana",
      kind: "friend",
      unlocked: false,
      unlockedAt: null,
      isStarter: false,
      activeThemeId: null,
      visual: {
        mode: "doll",
        avatarPath: IMAGE_PATH,
        themes: [
          {
            themeId: "festival",
            unlocked: false,
            outfitPath: IMAGE_PATH,
            posePaths: {
              supported: null,
              challenged: null,
              victory: POSE_PATH
            }
          }
        ]
      },
      progress: {
        value: 0.4,
        explain: "再累積一點本機里程就能遇見她"
      },
      voiceLines: [
        {
          id: "welcome",
          trigger: "unlock",
          path: AUDIO_PATH,
          durationMs: 900
        }
      ]
    }
  ]
} as const;

function validSnapshot(): CharactersSnapshot {
  return parseCharactersSnapshot(structuredClone(CHARACTER_RESPONSE));
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("character roster response contract", () => {
  it("accepts and freezes the exact bounded DTO", () => {
    const parsed = validSnapshot();

    expect(parsed).toEqual(CHARACTER_RESPONSE);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.characters)).toBe(true);
    expect(Object.isFrozen(parsed.characters[0]?.voiceLines)).toBe(true);
  });

  it("accepts snapshots from before the optional unlock batch marker", () => {
    const { unlockBatchId: _omitted, ...legacy } = CHARACTER_RESPONSE;

    expect(parseCharactersSnapshot(legacy).unlockBatchId).toBeUndefined();
  });

  it.each([
    ["an extra key", { ...CHARACTER_RESPONSE, detail: "not allowed" }],
    [
      "a generated timestamp without milliseconds",
      { ...CHARACTER_RESPONSE, generatedAt: "2026-07-16T12:00:00Z" }
    ],
    [
      "a missing key",
      (() => {
        const { voiceEnabled: _voiceEnabled, ...missing } = CHARACTER_RESPONSE;
        return missing;
      })()
    ],
    [
      "more than 16 characters",
      {
        ...CHARACTER_RESPONSE,
        characters: Array.from(
          { length: 17 },
          () => CHARACTER_RESPONSE.characters[0]
        )
      }
    ],
    [
      "more than 20 themes",
      {
        ...CHARACTER_RESPONSE,
        characters: [
          {
            ...CHARACTER_RESPONSE.characters[0],
            visual: {
              ...CHARACTER_RESPONSE.characters[0].visual,
              themes: Array.from(
                { length: 21 },
                () => CHARACTER_RESPONSE.characters[0].visual.themes[0]
              )
            }
          }
        ],
        selection: { characterId: "chatgpt", selectedBy: "manual" }
      }
    ],
    [
      "more than 16 voice lines",
      {
        ...CHARACTER_RESPONSE,
        characters: [
          {
            ...CHARACTER_RESPONSE.characters[0],
            voiceLines: Array.from(
              { length: 17 },
              () => CHARACTER_RESPONSE.characters[0].voiceLines[0]
            )
          }
        ],
        selection: { characterId: "chatgpt", selectedBy: "manual" }
      }
    ],
    [
      "an off-origin avatar path",
      {
        ...CHARACTER_RESPONSE,
        characters: [
          {
            ...CHARACTER_RESPONSE.characters[0],
            visual: {
              ...CHARACTER_RESPONSE.characters[0].visual,
              avatarPath: "https://example.com/avatar.webp"
            }
          }
        ],
        selection: { characterId: "chatgpt", selectedBy: "manual" }
      }
    ],
    [
      "a malformed outfit path",
      {
        ...CHARACTER_RESPONSE,
        characters: [
          {
            ...CHARACTER_RESPONSE.characters[0],
            visual: {
              ...CHARACTER_RESPONSE.characters[0].visual,
              themes: [
                {
                  ...CHARACTER_RESPONSE.characters[0].visual.themes[0],
                  outfitPath: "/assets/characters/objects/not-a-hash.webp"
                }
              ]
            }
          }
        ],
        selection: { characterId: "chatgpt", selectedBy: "manual" }
      }
    ],
    [
      "an image extension on a voice path",
      {
        ...CHARACTER_RESPONSE,
        characters: [
          {
            ...CHARACTER_RESPONSE.characters[0],
            voiceLines: [
              {
                ...CHARACTER_RESPONSE.characters[0].voiceLines[0],
                path: IMAGE_PATH
              }
            ]
          }
        ],
        selection: { characterId: "chatgpt", selectedBy: "manual" }
      }
    ]
  ])("rejects %s", (_label, value) => {
    expect(() => parseCharactersSnapshot(value)).toThrow(
      "Invalid characters response"
    );
  });

  it("allows letter mode only for GLM", () => {
    const parsed = validSnapshot();
    expect(isGlmLetterCharacter(parsed.characters[1]!)).toBe(true);
    expect(isGlmLetterCharacter(parsed.characters[0]!)).toBe(false);

    const invalid = {
      ...CHARACTER_RESPONSE,
      characters: [
        CHARACTER_RESPONSE.characters[0],
        {
          ...CHARACTER_RESPONSE.characters[1],
          characterId: "claude",
          displayName: "Claude"
        },
        CHARACTER_RESPONSE.characters[2]
      ]
    };
    expect(() => parseCharactersSnapshot(invalid)).toThrow(
      "Invalid characters response"
    );
  });
});

describe("character interaction logic", () => {
  it("renders only unlocked roster entries and reports locked characters as a count", () => {
    const roster = visibleCharacterRoster(validSnapshot().characters);

    expect(roster.unlocked.map((character) => character.characterId)).toEqual([
      "chatgpt",
      "glm"
    ]);
    expect(roster.lockedCount).toBe(1);
    expect(roster.unlocked.some((character) => character.characterId === "sakana")).toBe(
      false
    );
    expect(Object.isFrozen(roster.unlocked)).toBe(true);
  });

  it("enables compact pet mode only for the exact view=pet query value", () => {
    expect(resolveCompanionView("?view=pet")).toBe("pet");
    expect(resolveCompanionView("?theme=warm&view=pet")).toBe("pet");
    expect(resolveCompanionView("?view=dashboard")).toBe("dashboard");
    expect(resolveCompanionView("?view=PET")).toBe("dashboard");
    expect(resolveCompanionView("")).toBe("dashboard");
  });

  it("preloads before committing a portrait switch and retains the current portrait on failure", async () => {
    const events: string[] = [];
    let finishPreload: (() => void) | undefined;
    const preload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPreload = resolve;
        })
    );
    const machine = createPortraitSwitchStateMachine({
      preload,
      onSwitching: (target) => events.push(`switching:${target.characterId}`),
      onCommit: (target) => events.push(`commit:${target.characterId}`),
      onError: (target) => events.push(`error:${target.characterId}`)
    });
    const first = { characterId: "chatgpt", imagePath: IMAGE_PATH };
    const pending = machine.transition(first);

    expect(machine.current()).toBeUndefined();
    expect(events).toEqual(["switching:chatgpt"]);
    finishPreload!();
    await expect(pending).resolves.toBe(true);
    expect(machine.current()).toBe(first);
    expect(events).toEqual(["switching:chatgpt", "commit:chatgpt"]);

    preload.mockRejectedValueOnce(new Error("404"));
    const failed = { characterId: "sakana", imagePath: POSE_PATH };
    await expect(machine.transition(failed)).resolves.toBe(false);
    expect(machine.current()).toBe(first);
    expect(events.at(-1)).toBe("error:sakana");
  });

  it("returns no animation classes when reduced motion is requested", () => {
    expect(enabledCharacterAnimationClasses(true)).toEqual([]);
    expect(enabledCharacterAnimationClasses(false)).toContain("character-idle");
    expect(enabledCharacterAnimationClasses(false)).toContain(
      "character-crossfade-in"
    );
  });

  it("diffs character and wardrobe unlocks, then serializes their toasts", () => {
    const previous = validSnapshot();
    const sakana = CHARACTER_RESPONSE.characters[2];
    const nextValue = {
      ...CHARACTER_RESPONSE,
      unlockBatchId: "2026-07-16T12:00:00.000Z",
      characters: [
        CHARACTER_RESPONSE.characters[0],
        CHARACTER_RESPONSE.characters[1],
        {
          ...sakana,
          unlocked: true,
          unlockedAt: "2026-07-16T12:00:00.000Z",
          activeThemeId: "festival",
          visual: {
            ...sakana.visual,
            themes: [{ ...sakana.visual.themes[0], unlocked: true }]
          }
        }
      ]
    } as const;
    const next = parseCharactersSnapshot(nextValue);
    const unlocks = diffCharacterUnlocks(previous, next);

    expect(unlocks.map((unlock) => unlock.kind)).toEqual([
      "character",
      "theme"
    ]);
    expect(unlocks.map((unlock) => unlock.batchId)).toEqual([
      next.unlockBatchId,
      next.unlockBatchId
    ]);
    expect(coalesceCharacterUnlocks(unlocks)).toBe(unlocks);
    const queue = createCharacterUnlockQueue();
    expect(queue.enqueue(unlocks)).toBe(unlocks[0]);
    expect(queue.current()).toBe(unlocks[0]);
    expect(queue.pendingCount()).toBe(1);
    queue.enqueue(unlocks);
    expect(queue.pendingCount()).toBe(1);
    expect(queue.finish()).toBe(unlocks[1]);
    expect(queue.finish()).toBeUndefined();
  });

  it("coalesces a burst into one mixed wardrobe summary", () => {
    const previous = validSnapshot();
    const next = parseCharactersSnapshot({
      ...structuredClone(CHARACTER_RESPONSE),
      generatedAt: "2026-07-16T12:01:00.000Z",
      unlockBatchId: "2026-07-16T12:01:00.000Z",
      characters: CHARACTER_RESPONSE.characters.map((entry) =>
        entry.characterId === "sakana"
          ? {
              ...entry,
              unlocked: true,
              unlockedAt: "2026-07-16T12:01:00.000Z",
              activeThemeId: "festival",
              visual: {
                ...entry.visual,
                themes: [{ ...entry.visual.themes[0], unlocked: true }]
              },
              progress: null
            }
          : entry.characterId === "chatgpt" && entry.visual.mode === "doll"
            ? {
                ...entry,
                visual: {
                  ...entry.visual,
                  themes: [
                    ...entry.visual.themes,
                    ...(["finance", "culture"] as const).map((themeId) => ({
                      ...entry.visual.themes[0],
                      themeId,
                      unlocked: true
                    }))
                  ]
                }
              }
            : entry
      )
    });
    const unlocks = diffCharacterUnlocks(previous, next);
    const notifications = coalesceCharacterUnlocks(unlocks);

    expect(unlocks).toHaveLength(4);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.summary).toEqual({
      characterCount: 1,
      themeCount: 3
    });
    expect(characterUnlockToastText(notifications[0]!)).toBe(
      "解鎖了 1 位夥伴與 3 件服裝，到衣櫃看看"
    );
    const queue = createCharacterUnlockQueue();
    expect(queue.enqueue(unlocks)).toEqual(notifications[0]);
    expect(queue.pendingCount()).toBe(0);
  });

  it("uses the wardrobe-only summary copy for a clothing burst", () => {
    const batchId = "2026-07-16T12:02:00.000Z";
    const unlocks = (["tech", "finance", "culture", "festival"] as const).map(
      (themeId) => ({
        key: `theme:chatgpt:${themeId}`,
        batchId,
        kind: "theme" as const,
        characterId: "chatgpt" as const,
        displayName: "ChatGPT",
        themeId
      })
    );

    const notifications = coalesceCharacterUnlocks(unlocks);
    expect(characterUnlockToastText(notifications[0]!)).toBe(
      "解鎖了 4 件新服裝，到衣櫃看看"
    );
  });

  it("maps challenged before victory, then supported, then idle", () => {
    expect(resolveCharacterPose("stale", 10, true)).toBe("challenged");
    expect(resolveCharacterPose("refresh-failed", 0, true)).toBe(
      "challenged"
    );
    expect(resolveCharacterPose("healthy", 10, true)).toBe("victory");
    expect(resolveCharacterPose("healthy", 10, false)).toBe("supported");
    expect(resolveCharacterPose("healthy", 0, false)).toBeNull();
    expect(resolveCharacterPose("other", 10, false)).toBeNull();
  });

  it("falls back after an image error and retries only once on a later poll", () => {
    const tracker = createCharacterImageFallbackTracker();

    expect(tracker.canAttempt("chatgpt", IMAGE_PATH)).toBe(true);
    tracker.recordFailure("chatgpt", IMAGE_PATH);
    expect(tracker.canAttempt("chatgpt", IMAGE_PATH)).toBe(false);
    tracker.advancePoll();
    expect(tracker.canAttempt("chatgpt", IMAGE_PATH)).toBe(true);
    tracker.recordFailure("chatgpt", IMAGE_PATH);
    tracker.advancePoll();
    expect(tracker.canAttempt("chatgpt", IMAGE_PATH)).toBe(false);
  });
});

describe("voice gating", () => {
  it("requires a gesture, persists the preference, and throttles hourly lines", () => {
    const values = new Map<string, string>();
    const storage: VoicePreferenceStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      }
    };
    const gate = createVoicePlaybackGate(storage);

    expect(gate.isEnabled()).toBe(false);
    gate.setEnabled(true);
    expect(values.get("tokenmonster-voice")).toBe("on");
    expect(gate.allow("greeting", "chatgpt", 0)).toBe(false);
    gate.arm();
    expect(gate.allow("greeting", "chatgpt", 0)).toBe(true);
    expect(gate.allow("greeting", "chatgpt", 1)).toBe(false);
    expect(gate.allow("quiet", "chatgpt", 1_000)).toBe(true);
    expect(gate.allow("quiet", "chatgpt", 3_600_999)).toBe(false);
    expect(gate.allow("quiet", "chatgpt", 3_601_000)).toBe(true);
    expect(gate.allow("active", "chatgpt", 1_001)).toBe(true);
    expect(gate.allow("active", "claude", 1_002)).toBe(false);
    gate.setEnabled(false);
    expect(values.get("tokenmonster-voice")).toBe("off");
    expect(gate.allow("unlock", "chatgpt", 4_000_000)).toBe(false);
  });
});

describe("character POST flows", () => {
  it("posts a selection and applies the response for an immediate re-render", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        status: "ok",
        selection: { characterId: "glm", selectedBy: "manual" }
      })
    ) as CharacterFetch;

    const response = await requestCharacterSelection("glm", fetcher);
    const updated = applyCharacterSelection(validSnapshot(), response);

    expect(updated.selection).toEqual({
      characterId: "glm",
      selectedBy: "manual"
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/characters/select",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ characterId: "glm" })
      })
    );
  });

  it("posts a wardrobe choice and swaps the active theme locally", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        status: "ok",
        characterId: "chatgpt",
        activeThemeId: "tech"
      })
    ) as CharacterFetch;

    const response = await requestCharacterWardrobe(
      "chatgpt",
      "tech",
      fetcher
    );
    const updated = applyCharacterWardrobe(validSnapshot(), response);

    expect(updated.characters[0]?.activeThemeId).toBe("tech");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/characters/wardrobe",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ characterId: "chatgpt", themeId: "tech" })
      })
    );
  });
});
