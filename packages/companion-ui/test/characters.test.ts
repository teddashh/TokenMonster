import { describe, expect, it, vi } from "vitest";

import {
  ByokRequestError,
  CharacterProgressionWriteError,
  appendByokChatExchange,
  applyCharacterSelection,
  applyCharacterWardrobe,
  characterUnlockToastText,
  canShareCharacterProfile,
  characterRosterCardIdentity,
  byokChatErrorText,
  clearByok,
  configureByok,
  coalesceCharacterUnlocks,
  createCharacterMutationGate,
  createCharacterProfileRequestGate,
  createPortraitStageStateMachine,
  createPortraitSwitchStateMachine,
  createCharacterImageFallbackTracker,
  createCharacterUnlockQueue,
  createVoicePlaybackGate,
  diffCharacterUnlocks,
  enabledCharacterAnimationClasses,
  isCurrentCharacterInteraction,
  isByokChatCharacter,
  millisecondsUntilNextUtcDate,
  needsColdStartLetterFallback,
  parseCharacterInteractionResponse,
  parseCharactersSnapshot,
  presentedRosterCharacter,
  progressionLockRepairView,
  requestCharacterInteraction,
  requestCharacterProgressionLockRepair,
  requestCharacterSelection,
  requestCharacterWardrobe,
  requestByokChat,
  requestByokStatus,
  resolveCharacterStage,
  resolveCompanionView,
  resolveCharacterPose,
  resolveStageImageCandidates,
  selectedRosterCharacter,
  shouldPlayImmediateUnlockSparkles,
  shouldRenderAfterCharacterMutation,
  visibleCharacterRoster,
  type CharacterFetch,
  type CharacterProfileResponse,
  type CharactersSnapshot,
  type VoicePreferenceStorage,
} from "../src/public/app.js";

const IMAGE_PATH = `/assets/characters/objects/${"a".repeat(64)}.webp`;
const POSE_PATH = `/assets/characters/objects/${"b".repeat(64)}.png`;
const AUDIO_PATH = `/assets/characters/objects/${"c".repeat(64)}.wav`;

const LETTER_THEME = {
  themeId: "tech",
  displayName: "科技",
  accessibleLabel: "科技主題字母造型",
  unlocked: false,
  progress: {
    value: 0.25,
    explain: "再累積一點本機用量即可解鎖科技主題。",
  },
  palette: {
    background: "#0B1F33",
    foreground: "#F8FAFC",
    accent: "#5EEAD4",
  },
  pattern: {
    id: "circuit-grid",
    label: "電路網格",
    density: "medium",
  },
  accent: {
    id: "terminal-caret",
    label: "終端游標",
    placement: "top-right",
  },
} as const;

const FINANCE_LETTER_THEME = {
  themeId: "finance",
  displayName: "理財",
  accessibleLabel: "理財主題字母造型",
  unlocked: true,
  progress: null,
  palette: {
    background: "#102A1F",
    foreground: "#F8FAFC",
    accent: "#86EFAC",
  },
  pattern: {
    id: "ledger-grid",
    label: "帳本格線",
    density: "light",
  },
  accent: {
    id: "steady-coin",
    label: "穩健錢幣",
    placement: "bottom-right",
  },
} as const;

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
      starterPersona: {
        alias: "Aster",
        taglineZhTw: "沉著務實，會把選項整理清楚，陪你照自己的步調決定。",
      },
      activeThemeId: "tech",
      visual: {
        mode: "doll",
        avatarPath: IMAGE_PATH,
        themes: [
          {
            themeId: "tech",
            unlocked: true,
            progress: null,
            outfitPath: IMAGE_PATH,
            posePaths: {
              supported: POSE_PATH,
              challenged: null,
              victory: POSE_PATH,
            },
          },
        ],
      },
      progress: null,
      voiceLines: [
        {
          id: "hello",
          trigger: "greeting",
          path: AUDIO_PATH,
          durationMs: 1_200,
        },
      ],
    },
    {
      characterId: "glm",
      displayName: "GLM",
      kind: "friend",
      unlocked: true,
      unlockedAt: "2026-07-02T00:00:00.000Z",
      isStarter: false,
      starterPersona: null,
      activeThemeId: null,
      visual: {
        mode: "letter",
        glyph: "C",
        background: "#f4c993",
        foreground: "#754825",
        accent: "#f2bc68",
        themes: [LETTER_THEME],
      },
      progress: null,
      voiceLines: [],
    },
    {
      characterId: "sakana",
      displayName: "Sakana",
      kind: "friend",
      unlocked: false,
      unlockedAt: null,
      isStarter: false,
      starterPersona: null,
      activeThemeId: null,
      visual: {
        mode: "doll",
        avatarPath: IMAGE_PATH,
        themes: [
          {
            themeId: "festival",
            unlocked: false,
            progress: {
              value: 0.4,
              explain: "再累積一點本機用量即可解鎖 festival 主題。",
            },
            outfitPath: IMAGE_PATH,
            posePaths: {
              supported: null,
              challenged: null,
              victory: POSE_PATH,
            },
          },
        ],
      },
      progress: {
        value: 0.4,
        explain: "再累積一點本機里程就能遇見她",
      },
      voiceLines: [
        {
          id: "welcome",
          trigger: "unlock",
          path: AUDIO_PATH,
          durationMs: 900,
        },
      ],
    },
  ],
} as const;

function validSnapshot(): CharactersSnapshot {
  return parseCharactersSnapshot(structuredClone(CHARACTER_RESPONSE));
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("progression lock repair presentation", () => {
  it("shows recovery only when useful and never hides a busy outcome", () => {
    expect(progressionLockRepairView("hidden")).toMatchObject({
      showControl: false,
      reasonOverride: null,
    });
    expect(progressionLockRepairView("available")).toMatchObject({
      showControl: true,
      controlDisabled: false,
      controlLabel: "修復角色選擇",
    });
    expect(progressionLockRepairView("checking")).toMatchObject({
      showControl: true,
      controlDisabled: true,
      controlLabel: "正在安全檢查…",
    });
    expect(progressionLockRepairView("busy")).toMatchObject({
      showControl: true,
      controlDisabled: false,
      controlLabel: "結束舊版後再檢查",
    });
    expect(progressionLockRepairView("ready")).toMatchObject({
      showControl: false,
      reasonOverride: expect.stringContaining("請再選一次"),
    });
    expect(progressionLockRepairView("failed")).toMatchObject({
      showControl: true,
      controlDisabled: false,
      controlLabel: "重新檢查角色選擇",
    });
  });
});

describe("local OpenAI BYOK companion", () => {
  const STATUS = Object.freeze({
    status: "ok",
    availability: "available",
    configured: false,
    persistence: "memory-only",
    canPersist: true,
    provider: "OpenAI",
    model: "gpt-5.6-luna",
  });

  it("parses the exact status and rejects response field drift", async () => {
    const fetcher = vi.fn(async () => jsonResponse(STATUS)) as CharacterFetch;
    await expect(requestByokStatus(fetcher)).resolves.toEqual(STATUS);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/byok/status",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      }),
    );

    const drifted = vi.fn(async () =>
      jsonResponse({ ...STATUS, backend: "secret-service" }),
    ) as CharacterFetch;
    await expect(requestByokStatus(drifted)).rejects.toThrow(
      "Invalid BYOK status response",
    );
  });

  it("sends a key only in the exact local configure request and clears explicitly", async () => {
    const apiKey = ["sk", "test_1234567890abcdef_UI_CANARY"].join("-");
    const configured = { ...STATUS, configured: true };
    const configureFetcher = vi.fn(async () =>
      jsonResponse(configured),
    ) as CharacterFetch;
    await expect(
      configureByok(apiKey, false, configureFetcher),
    ).resolves.toEqual(configured);
    expect(configureFetcher).toHaveBeenCalledWith(
      "/api/byok/configure",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ apiKey, persist: false }),
      }),
    );

    const clearFetcher = vi.fn(async () => jsonResponse(STATUS)) as CharacterFetch;
    await expect(clearByok(clearFetcher)).resolves.toEqual(STATUS);
    expect(clearFetcher).toHaveBeenCalledWith(
      "/api/byok/clear",
      expect.objectContaining({
        body: JSON.stringify({ confirmation: "clear-openai-byok" }),
      }),
    );

    const invalidFetcher = vi.fn(async () =>
      jsonResponse({ status: "error", error: "invalid-key" }, 400),
    ) as CharacterFetch;
    const error = await configureByok(
      "bad",
      false,
      invalidFetcher,
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ByokRequestError);
    expect(error).toMatchObject({ code: "invalid-key" });
  });

  it("keeps bounded history in UI RAM and posts the exact chat body", async () => {
    let history = Object.freeze([]) as readonly {
      role: "user" | "assistant";
      text: string;
    }[];
    for (let index = 0; index < 8; index += 1) {
      history = appendByokChatExchange(
        history,
        `問題 ${index}`,
        `回答 ${index}`,
      );
    }
    expect(history).toHaveLength(12);
    expect(history[0]).toEqual({ role: "user", text: "問題 2" });

    const fetcher = vi.fn(async () =>
      jsonResponse({ status: "ok", characterId: "chatgpt", text: "你好。" }),
    ) as CharacterFetch;
    await expect(
      requestByokChat("chatgpt", history, "在嗎？", fetcher),
    ).resolves.toEqual({
      status: "ok",
      characterId: "chatgpt",
      text: "你好。",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/byok/chat",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          characterId: "chatgpt",
          history,
          message: "在嗎？",
        }),
      }),
    );
  });

  it("limits reviewed chat personas and gives stable fallback copy", () => {
    expect(isByokChatCharacter("chatgpt")).toBe(true);
    expect(isByokChatCharacter("glm")).toBe(false);
    expect(byokChatErrorText("provider-rate-limited")).toContain("本機固定台詞");
    expect(byokChatErrorText("provider-authentication-failed")).toContain(
      "重新設定",
    );
  });
});

describe("character roster response contract", () => {
  it("accepts and freezes the exact bounded DTO", () => {
    const parsed = validSnapshot();

    expect(parsed).toEqual(CHARACTER_RESPONSE);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.characters)).toBe(true);
    expect(Object.isFrozen(parsed.characters[0]?.starterPersona)).toBe(true);
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
      { ...CHARACTER_RESPONSE, generatedAt: "2026-07-16T12:00:00Z" },
    ],
    [
      "a missing key",
      (() => {
        const { voiceEnabled: _voiceEnabled, ...missing } = CHARACTER_RESPONSE;
        return missing;
      })(),
    ],
    [
      "an extra starter persona key",
      {
        ...CHARACTER_RESPONSE,
        characters: CHARACTER_RESPONSE.characters.map((character) =>
          character.characterId === "chatgpt"
            ? {
                ...character,
                starterPersona: {
                  ...character.starterPersona,
                  providerName: "must-not-cross",
                },
              }
            : character,
        ),
      },
    ],
    [
      "a missing starter persona",
      {
        ...CHARACTER_RESPONSE,
        characters: CHARACTER_RESPONSE.characters.map((character) =>
          character.characterId === "chatgpt"
            ? { ...character, starterPersona: null }
            : character,
        ),
      },
    ],
    [
      "a persona on a non-starter friend",
      {
        ...CHARACTER_RESPONSE,
        characters: CHARACTER_RESPONSE.characters.map((character) =>
          character.characterId === "glm"
            ? {
                ...character,
                starterPersona: {
                  alias: "Not a starter",
                  taglineZhTw: "這個欄位不應出現在非初始夥伴。",
                },
              }
            : character,
        ),
      },
    ],
    [
      "more than 16 characters",
      {
        ...CHARACTER_RESPONSE,
        characters: Array.from(
          { length: 17 },
          () => CHARACTER_RESPONSE.characters[0],
        ),
      },
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
                () => CHARACTER_RESPONSE.characters[0].visual.themes[0],
              ),
            },
          },
        ],
        selection: { characterId: "chatgpt", selectedBy: "manual" },
      },
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
              () => CHARACTER_RESPONSE.characters[0].voiceLines[0],
            ),
          },
        ],
        selection: { characterId: "chatgpt", selectedBy: "manual" },
      },
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
              avatarPath: "https://example.com/avatar.webp",
            },
          },
        ],
        selection: { characterId: "chatgpt", selectedBy: "manual" },
      },
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
                  outfitPath: "/assets/characters/objects/not-a-hash.webp",
                },
              ],
            },
          },
        ],
        selection: { characterId: "chatgpt", selectedBy: "manual" },
      },
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
                path: IMAGE_PATH,
              },
            ],
          },
        ],
        selection: { characterId: "chatgpt", selectedBy: "manual" },
      },
    ],
  ])("rejects %s", (_label, value) => {
    expect(() => parseCharactersSnapshot(value)).toThrow(
      "Invalid characters response",
    );
  });

  it("accepts bounded letter fallbacks and a future GLM doll upgrade", () => {
    const parsed = validSnapshot();
    expect(parsed.characters[1]!.visual.mode).toBe("letter");
    expect(parsed.characters[0]!.visual.mode).toBe("doll");

    const nonGlmLetter = parseCharactersSnapshot({
      ...CHARACTER_RESPONSE,
      characters: [
        {
          ...CHARACTER_RESPONSE.characters[0],
          activeThemeId: null,
          visual: CHARACTER_RESPONSE.characters[1].visual,
        },
        CHARACTER_RESPONSE.characters[1],
        CHARACTER_RESPONSE.characters[2],
      ],
    });
    expect(nonGlmLetter.characters[0]).toMatchObject({
      characterId: "chatgpt",
      activeThemeId: null,
      visual: { mode: "letter" },
    });

    const glmDoll = parseCharactersSnapshot({
      ...CHARACTER_RESPONSE,
      characters: [
        CHARACTER_RESPONSE.characters[0],
        {
          ...CHARACTER_RESPONSE.characters[1],
          activeThemeId: "tech",
          visual: CHARACTER_RESPONSE.characters[0].visual,
        },
        CHARACTER_RESPONSE.characters[2],
      ],
    });
    expect(glmDoll.characters[1]).toMatchObject({
      characterId: "glm",
      activeThemeId: "tech",
      visual: { mode: "doll" },
    });

    const letterWithTheme = parseCharactersSnapshot({
      ...CHARACTER_RESPONSE,
      characters: [
        CHARACTER_RESPONSE.characters[0],
        {
          ...CHARACTER_RESPONSE.characters[1],
          activeThemeId: "tech",
          visual: {
            ...CHARACTER_RESPONSE.characters[1].visual,
            background: LETTER_THEME.palette.background,
            foreground: LETTER_THEME.palette.foreground,
            accent: LETTER_THEME.palette.accent,
            themes: [{ ...LETTER_THEME, unlocked: true }],
          },
        },
        CHARACTER_RESPONSE.characters[2],
      ],
    });
    expect(letterWithTheme.characters[1]).toMatchObject({
      characterId: "glm",
      activeThemeId: "tech",
      visual: { mode: "letter", background: "#0B1F33" },
    });

    expect(() =>
      parseCharactersSnapshot({
        ...structuredClone(letterWithTheme),
        characters: letterWithTheme.characters.map((character) =>
          character.characterId === "glm" && character.visual.mode === "letter"
            ? {
                ...character,
                visual: { ...character.visual, background: "#FFFFFF" },
              }
            : character,
        ),
      }),
    ).toThrow("Invalid characters response");
  });
});

describe("character interaction logic", () => {
  it("renders only unlocked roster entries and reports locked characters as a count", () => {
    const roster = visibleCharacterRoster(validSnapshot().characters);

    expect(roster.unlocked.map((character) => character.characterId)).toEqual([
      "chatgpt",
      "glm",
    ]);
    expect(roster.lockedCount).toBe(1);
    expect(
      roster.unlocked.some((character) => character.characterId === "sakana"),
    ).toBe(false);
    expect(Object.isFrozen(roster.unlocked)).toBe(true);
  });

  it("uses the catalog persona only for a first-choice starter card", () => {
    const starter = validSnapshot().characters[0]!;

    const initialCard = characterRosterCardIdentity(starter, true);
    expect(initialCard).toEqual({
      name: "Aster",
      taglineZhTw: "沉著務實，會把選項整理清楚，陪你照自己的步調決定。",
    });
    expect(JSON.stringify(initialCard)).not.toContain("ChatGPT");
    expect(Object.isFrozen(initialCard)).toBe(true);

    expect(characterRosterCardIdentity(starter, false)).toEqual({
      name: "ChatGPT",
      taglineZhTw: null,
    });
  });

  it("enables compact pet mode only for the exact view=pet query value", () => {
    expect(resolveCompanionView("?view=pet")).toBe("pet");
    expect(resolveCompanionView("?theme=warm&view=pet")).toBe("pet");
    expect(resolveCompanionView("?view=dashboard")).toBe("dashboard");
    expect(resolveCompanionView("?view=PET")).toBe("dashboard");
    expect(resolveCompanionView("")).toBe("dashboard");
  });

  it("keeps an explicit null selection empty instead of falling back to a starter", () => {
    const snapshot = parseCharactersSnapshot({
      ...structuredClone(CHARACTER_RESPONSE),
      selection: { characterId: null, selectedBy: null },
    });

    expect(selectedRosterCharacter(snapshot)).toBeUndefined();
    expect(snapshot.characters.some((character) => character.isStarter)).toBe(
      true,
    );
  });

  it("keeps an earlier tap current across a rapid second tap and invalidates it on selection change", () => {
    expect(
      isCurrentCharacterInteraction(4, 4, "chatgpt", "chatgpt", "chatgpt"),
    ).toBe(true);
    expect(
      isCurrentCharacterInteraction(4, 5, "chatgpt", "glm", "chatgpt"),
    ).toBe(false);
    expect(
      isCurrentCharacterInteraction(4, 4, "chatgpt", "chatgpt", "glm"),
    ).toBe(false);
  });

  it("retries a failed profile read after one minute and ignores superseded requests", () => {
    const gate = createCharacterProfileRequestGate();

    const first = gate.begin(1_000);
    expect(first).toBe(1);
    expect(gate.state(1_000)).toBe("loading");
    expect(gate.fail(first!, 2_000)).toBe(true);
    expect(gate.state(2_000)).toBe("unavailable");
    expect(gate.begin(61_999)).toBeUndefined();

    const retry = gate.begin(62_000);
    expect(retry).toBe(2);
    const forced = gate.begin(62_100, true);
    expect(forced).toBe(3);
    expect(gate.fail(retry!, 62_200)).toBe(false);
    expect(gate.state(62_200)).toBe("loading");
    expect(gate.succeed(forced!, 63_000)).toBe(true);
    expect(gate.state(63_000)).toBe("ready");
    expect(gate.state(962_999)).toBe("ready");
    expect(gate.state(963_000)).toBe("stale");
    expect(gate.begin(962_999)).toBeUndefined();
    expect(gate.begin(963_000)).toBe(4);
  });

  it("ages a ready profile while the UI is suspended", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-18T08:00:00.000Z"));
      const gate = createCharacterProfileRequestGate();
      const request = gate.begin(Date.now());
      expect(request).toBe(1);
      expect(gate.succeed(request!, Date.now())).toBe(true);
      expect(gate.state(Date.now())).toBe("ready");

      vi.advanceTimersByTime(15 * 60_000);
      expect(gate.state(Date.now())).toBe("stale");
      expect(gate.begin(Date.now())).toBe(2);
      expect(gate.state(Date.now())).toBe("loading");
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates stale roster reads and makes each mutation kind latest-wins", () => {
    const gate = createCharacterMutationGate();
    const beforeMutation = gate.revision();
    expect(gate.canAcceptRead(beforeMutation)).toBe(true);

    const firstWardrobe = gate.begin("wardrobe");
    const duringFirst = gate.revision();
    const latestWardrobe = gate.begin("wardrobe");
    expect(gate.pending()).toBe(true);
    expect(gate.isCurrent(firstWardrobe)).toBe(false);
    expect(gate.isCurrent(latestWardrobe)).toBe(true);
    expect(gate.canAcceptRead(beforeMutation)).toBe(false);
    expect(gate.canAcceptRead(duringFirst)).toBe(false);

    expect(gate.finish(firstWardrobe)).toEqual({ current: false, idle: false });
    expect(gate.finish(latestWardrobe)).toEqual({ current: true, idle: true });
    expect(gate.canAcceptRead(duringFirst)).toBe(false);
    expect(gate.canAcceptRead(gate.revision())).toBe(true);
  });

  it("accepts only the first player mutation until it settles", () => {
    const gate = createCharacterMutationGate();
    const firstChoice = gate.beginWhenIdle("selection");

    expect(firstChoice).toMatchObject({ kind: "selection" });
    expect(gate.beginWhenIdle("selection")).toBeUndefined();
    expect(gate.beginWhenIdle("wardrobe")).toBeUndefined();
    expect(gate.finish(firstChoice!)).toEqual({ current: true, idle: true });
    expect(gate.beginWhenIdle("wardrobe")).toMatchObject({ kind: "wardrobe" });
  });

  it.each(["selection", "wardrobe"] as const)(
    "re-renders after a superseded %s request is the last mutation to settle",
    (kind) => {
      const gate = createCharacterMutationGate();
      const superseded = gate.begin(kind);
      const latest = gate.begin(kind);

      const latestSettlement = gate.finish(latest);
      expect(latestSettlement).toEqual({ current: true, idle: false });
      expect(shouldRenderAfterCharacterMutation(latestSettlement)).toBe(true);
      expect(gate.pending()).toBe(true);

      const finalSettlement = gate.finish(superseded);
      expect(finalSettlement).toEqual({ current: false, idle: true });
      expect(shouldRenderAfterCharacterMutation(finalSettlement)).toBe(true);
      expect(gate.pending()).toBe(false);
    },
  );

  it("keeps an unlock celebration on the stage without changing persisted selection", () => {
    const snapshot = validSnapshot();

    expect(selectedRosterCharacter(snapshot)?.characterId).toBe("chatgpt");
    expect(presentedRosterCharacter(snapshot, "glm")?.characterId).toBe("glm");
    expect(selectedRosterCharacter(snapshot)?.characterId).toBe("chatgpt");
  });

  it("expires at the next UTC date boundary without relying on local timezone", () => {
    expect(
      millisecondsUntilNextUtcDate(Date.parse("2026-07-18T23:59:59.900Z")),
    ).toBe(100);
    expect(
      millisecondsUntilNextUtcDate(Date.parse("2026-07-18T04:00:00.000Z")),
    ).toBe(20 * 60 * 60_000);
  });

  it("shows locked starters only for clean-install choice and promotes the chosen starter", () => {
    const cleanInstall = parseCharactersSnapshot({
      ...structuredClone(CHARACTER_RESPONSE),
      selection: { characterId: null, selectedBy: null },
      characters: CHARACTER_RESPONSE.characters.map((character) =>
        character.characterId === "chatgpt"
          ? {
              ...character,
              unlocked: false,
              unlockedAt: null,
              activeThemeId: null,
              progress: {
                value: 0,
                explain: "先選一位起始夥伴，不需要增加用量。",
              },
            }
          : character.characterId === "glm"
            ? {
                ...character,
                unlocked: false,
                unlockedAt: null,
                progress: {
                  value: 0.2,
                  explain: "隨本機使用自然相遇。",
                },
              }
            : character,
      ),
    });

    const visible = visibleCharacterRoster(cleanInstall);
    expect(visible.unlocked.map((character) => character.characterId)).toEqual(
      [],
    );
    expect(
      visible.selectable.map((character) => character.characterId),
    ).toEqual(["chatgpt"]);
    expect(visible.lockedCount).toBe(3);

    const selected = applyCharacterSelection(cleanInstall, {
      status: "ok",
      selection: { characterId: "chatgpt", selectedBy: "manual" },
    });
    expect(selected.selection.characterId).toBe("chatgpt");
    expect(selected.characters[0]).toMatchObject({
      unlocked: true,
      progress: null,
    });
    expect(selected.characters[1]?.unlocked).toBe(false);
  });

  it("shares only the latest fresh profile for the current UTC date", () => {
    const profile = {
      freshness: "fresh",
      window: { toUtcDate: "2026-07-18" },
    } as unknown as CharacterProfileResponse;

    expect(canShareCharacterProfile(profile, "ready", "2026-07-18")).toBe(true);
    expect(canShareCharacterProfile(profile, "loading", "2026-07-18")).toBe(
      false,
    );
    expect(
      canShareCharacterProfile(
        { ...profile, freshness: "stale" },
        "ready",
        "2026-07-18",
      ),
    ).toBe(false);
    expect(canShareCharacterProfile(profile, "ready", "2026-07-19")).toBe(
      false,
    );
  });

  it("preloads before committing a portrait switch and retains the current portrait on failure", async () => {
    const events: string[] = [];
    let finishPreload: (() => void) | undefined;
    const preload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPreload = resolve;
        }),
    );
    const machine = createPortraitSwitchStateMachine({
      preload,
      onSwitching: (target) => events.push(`switching:${target.characterId}`),
      onCommit: (target) => events.push(`commit:${target.characterId}`),
      onError: (target) => events.push(`error:${target.characterId}`),
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

  it("keeps a letter stage visible until its replacement doll is decoded", async () => {
    let finishPreload: (() => void) | undefined;
    const letterLayer = { hidden: false };
    const machine = createPortraitStageStateMachine(letterLayer, {
      preload: () =>
        new Promise<void>((resolve) => {
          finishPreload = resolve;
        }),
      onSwitching: () => undefined,
      onCommit: () => undefined,
      onError: () => undefined,
    });

    const transition = machine.transition({
      characterId: "glm",
      imagePath: IMAGE_PATH,
    });
    expect(letterLayer.hidden).toBe(false);

    finishPreload!();
    await expect(transition).resolves.toBe(true);
    expect(letterLayer.hidden).toBe(true);
  });

  it("primes a local letter when no committed doll belongs to the target", () => {
    expect(
      needsColdStartLetterFallback({
        dollHidden: true,
        incomingDollHidden: true,
        renderedLetterCharacterId: undefined,
        targetCharacterId: "chatgpt",
      }),
    ).toBe(true);
    expect(
      needsColdStartLetterFallback({
        dollHidden: true,
        incomingDollHidden: true,
        renderedLetterCharacterId: "glm",
        targetCharacterId: "glm",
      }),
    ).toBe(false);
    expect(
      needsColdStartLetterFallback({
        dollHidden: true,
        incomingDollHidden: true,
        renderedLetterCharacterId: "chatgpt",
        targetCharacterId: "claude",
      }),
    ).toBe(true);
    expect(
      needsColdStartLetterFallback({
        dollHidden: false,
        incomingDollHidden: true,
        renderedLetterCharacterId: undefined,
        targetCharacterId: "chatgpt",
      }),
    ).toBe(false);
  });

  it("falls back from a missing pose to the outfit, then to its letter", () => {
    const character = validSnapshot().characters[0]!;
    expect(resolveStageImageCandidates(character, "healthy", 1, false)).toEqual(
      [POSE_PATH, IMAGE_PATH],
    );
    expect(resolveStageImageCandidates(character, "healthy", 0, false)).toEqual(
      [IMAGE_PATH],
    );

    const fallback = createCharacterImageFallbackTracker();
    expect(
      resolveCharacterStage(character, "healthy", 1, false, (imagePath) =>
        fallback.canAttempt(character.characterId, imagePath),
      ),
    ).toEqual({ mode: "doll", imagePath: POSE_PATH });
    fallback.recordFailure(character.characterId, POSE_PATH);
    expect(
      resolveCharacterStage(character, "healthy", 1, false, (imagePath) =>
        fallback.canAttempt(character.characterId, imagePath),
      ),
    ).toEqual({ mode: "doll", imagePath: IMAGE_PATH });
    fallback.recordFailure(character.characterId, IMAGE_PATH);
    expect(
      resolveCharacterStage(character, "healthy", 1, false, (imagePath) =>
        fallback.canAttempt(character.characterId, imagePath),
      ),
    ).toEqual({ mode: "letter" });
  });

  it("returns no animation classes when reduced motion is requested", () => {
    expect(enabledCharacterAnimationClasses(true)).toEqual([]);
    expect(enabledCharacterAnimationClasses(false)).toContain("character-idle");
    expect(enabledCharacterAnimationClasses(false)).toContain(
      "character-crossfade-in",
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
            themes: [{ ...sakana.visual.themes[0], unlocked: true }],
          },
        },
      ],
    } as const;
    const next = parseCharactersSnapshot(nextValue);
    const unlocks = diffCharacterUnlocks(previous, next);

    expect(unlocks.map((unlock) => unlock.kind)).toEqual([
      "character",
      "theme",
    ]);
    expect(unlocks.map((unlock) => unlock.batchId)).toEqual([
      next.unlockBatchId,
      next.unlockBatchId,
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

  it("celebrates character and wardrobe unlocks in the shipping letter fallback", () => {
    const previous = parseCharactersSnapshot({
      ...structuredClone(CHARACTER_RESPONSE),
      characters: CHARACTER_RESPONSE.characters.map((character) =>
        character.characterId === "glm"
          ? {
              ...character,
              unlocked: false,
              unlockedAt: null,
              activeThemeId: null,
              progress: {
                value: 0.99,
                explain: "再累積一點本機用量，就能遇見 GLM。",
              },
              visual: {
                ...character.visual,
                themes: [{ ...LETTER_THEME, unlocked: false }],
              },
            }
          : character,
      ),
    });
    const next = parseCharactersSnapshot({
      ...structuredClone(CHARACTER_RESPONSE),
      unlockBatchId: "2026-07-18T12:00:00.000Z",
      characters: CHARACTER_RESPONSE.characters.map((character) =>
        character.characterId === "glm"
          ? {
              ...character,
              unlocked: true,
              unlockedAt: "2026-07-18T12:00:00.000Z",
              activeThemeId: "tech",
              visual: {
                ...character.visual,
                background: LETTER_THEME.palette.background,
                foreground: LETTER_THEME.palette.foreground,
                accent: LETTER_THEME.palette.accent,
                themes: [{ ...LETTER_THEME, unlocked: true }],
              },
            }
          : character,
      ),
    });

    const unlocks = diffCharacterUnlocks(previous, next);
    expect(unlocks.map(({ kind }) => kind)).toEqual(["character", "theme"]);
    expect(characterUnlockToastText(unlocks[1]!)).toBe(
      "GLM 的科技服裝準備好了！",
    );

    const queue = createCharacterUnlockQueue();
    let unlock = queue.enqueue(unlocks);
    expect(
      shouldPlayImmediateUnlockSparkles(
        presentedRosterCharacter(next, unlock?.characterId),
      ),
    ).toBe(true);
    unlock = queue.finish();
    expect(unlock?.kind).toBe("theme");
    expect(
      shouldPlayImmediateUnlockSparkles(
        presentedRosterCharacter(next, unlock?.characterId),
      ),
    ).toBe(true);
    expect(
      shouldPlayImmediateUnlockSparkles(selectedRosterCharacter(next)),
    ).toBe(false);
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
                themes: [{ ...entry.visual.themes[0], unlocked: true }],
              },
              progress: null,
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
                      unlocked: true,
                    })),
                  ],
                },
              }
            : entry,
      ),
    });
    const unlocks = diffCharacterUnlocks(previous, next);
    const notifications = coalesceCharacterUnlocks(unlocks);

    expect(unlocks).toHaveLength(4);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.summary).toEqual({
      characterCount: 1,
      themeCount: 3,
    });
    expect(characterUnlockToastText(notifications[0]!)).toBe(
      "解鎖了 1 位夥伴與 3 件服裝，到衣櫃看看",
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
        themeId,
      }),
    );

    const notifications = coalesceCharacterUnlocks(unlocks);
    expect(characterUnlockToastText(notifications[0]!)).toBe(
      "解鎖了 4 件新服裝，到衣櫃看看",
    );
  });

  it("maps challenged before victory, then supported, then idle", () => {
    expect(resolveCharacterPose("stale", 10, true)).toBe("challenged");
    expect(resolveCharacterPose("refresh-failed", 0, true)).toBe("challenged");
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
    tracker.reset();
    expect(tracker.canAttempt("chatgpt", IMAGE_PATH)).toBe(true);
  });
});

describe("voice gating", () => {
  it("requires a gesture, persists the preference, and throttles hourly lines", () => {
    const values = new Map<string, string>();
    const storage: VoicePreferenceStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
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
  it("posts a tap and accepts only the bounded local line DTO", async () => {
    const payload = {
      status: "ok",
      action: "tap",
      characterId: "glm",
      locale: "zh-TW",
      outcome: "line",
      line: {
        lineId: "tap-line/1.0.0/glm/zh-TW/hello",
        text: "齒輪輕輕轉了一格，要不要把一個想法拼起來？",
      },
      cooldownMs: 1_600,
    } as const;
    const fetcher = vi.fn(async () => jsonResponse(payload)) as CharacterFetch;

    const response = await requestCharacterInteraction("glm", "zh-TW", fetcher);

    expect(response).toEqual(payload);
    expect(Object.isFrozen(response)).toBe(true);
    expect(response.outcome === "line" && Object.isFrozen(response.line)).toBe(
      true,
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/characters/interact",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          characterId: "glm",
          action: "tap",
          locale: "zh-TW",
        }),
      }),
    );
  });

  it("posts idle chatter with the idle action and accepts the idle line DTO", async () => {
    const payload = {
      status: "ok",
      action: "idle",
      characterId: "glm",
      locale: "zh-TW",
      outcome: "line",
      line: {
        lineId: "tap-line/1.0.0/glm/zh-TW/hello",
        text: "齒輪輕輕轉了一格，要不要把一個想法拼起來？",
      },
      cooldownMs: 45_000,
    } as const;
    const fetcher = vi.fn(async () => jsonResponse(payload)) as CharacterFetch;

    const response = await requestCharacterInteraction(
      "glm",
      "zh-TW",
      fetcher,
      undefined,
      "idle",
    );

    expect(response).toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/characters/interact",
      expect.objectContaining({
        body: JSON.stringify({
          characterId: "glm",
          action: "idle",
          locale: "zh-TW",
        }),
      }),
    );
    expect(() =>
      parseCharacterInteractionResponse({ ...payload, action: "poke" }),
    ).toThrow("Invalid character interaction response");
  });

  it("accepts animation-only cooldowns and rejects interaction DTO drift", () => {
    expect(
      parseCharacterInteractionResponse({
        status: "ok",
        action: "tap",
        characterId: "chatgpt",
        locale: "en",
        outcome: "animation-only",
        retryAfterMs: 900,
      }),
    ).toEqual({
      status: "ok",
      action: "tap",
      characterId: "chatgpt",
      locale: "en",
      outcome: "animation-only",
      retryAfterMs: 900,
    });
    expect(() =>
      parseCharacterInteractionResponse({
        status: "ok",
        action: "tap",
        characterId: "chatgpt",
        locale: "zh-TW",
        outcome: "line",
        line: {
          lineId: "tap-line/1.0.0/chatgpt/zh-TW/hello",
          text: "not an allowlisted starter line",
        },
        cooldownMs: 1_600,
        rawSource: "forbidden",
      }),
    ).toThrow("Invalid character interaction response");
  });

  it("posts a selection and applies the response for an immediate re-render", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () =>
      jsonResponse({
        status: "ok",
        selection: { characterId: "glm", selectedBy: "manual" },
      }),
    ) as CharacterFetch;

    const response = await requestCharacterSelection(
      "glm",
      fetcher,
      controller.signal,
    );
    const updated = applyCharacterSelection(validSnapshot(), response);

    expect(updated.selection).toEqual({
      characterId: "glm",
      selectedBy: "manual",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/characters/select",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ characterId: "glm" }),
        signal: controller.signal,
      }),
    );
  });

  it("distinguishes an exact store-busy selection failure from other failures", async () => {
    const busyFetcher = vi.fn(async () =>
      jsonResponse({ status: "error", error: "store-busy" }, 409),
    ) as CharacterFetch;
    const busyError = await requestCharacterSelection(
      "glm",
      busyFetcher,
    ).catch((error: unknown) => error);

    expect(busyError).toBeInstanceOf(CharacterProgressionWriteError);
    expect(busyError).toMatchObject({ code: "store-busy" });

    const driftedFetcher = vi.fn(async () =>
      jsonResponse(
        { status: "error", error: "store-busy", retryAfterMs: 1 },
        409,
      ),
    ) as CharacterFetch;
    const driftedError = await requestCharacterSelection(
      "glm",
      driftedFetcher,
    ).catch((error: unknown) => error);

    expect(driftedError).toBeInstanceOf(CharacterProgressionWriteError);
    expect(driftedError).toMatchObject({ code: "request-failed" });
  });

  it("repairs only after the UI confirmation and accepts the exact outcomes", async () => {
    const controller = new AbortController();
    const repairedFetcher = vi.fn(async () =>
      jsonResponse({ outcome: "repaired", status: "ok" }),
    ) as CharacterFetch;

    await expect(
      requestCharacterProgressionLockRepair(
        repairedFetcher,
        controller.signal,
      ),
    ).resolves.toEqual({ status: "ok", outcome: "repaired" });
    expect(repairedFetcher).toHaveBeenCalledWith(
      "/api/characters/progression-lock/repair",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirmedOldVersionsClosed: true }),
        signal: controller.signal,
      }),
    );

    const notNeededFetcher = vi.fn(async () =>
      jsonResponse({ status: "ok", outcome: "not-needed" }),
    ) as CharacterFetch;
    await expect(
      requestCharacterProgressionLockRepair(notNeededFetcher),
    ).resolves.toEqual({ status: "ok", outcome: "not-needed" });
  });

  it("keeps a busy repair recoverable and rejects repair response drift", async () => {
    const busyFetcher = vi.fn(async () =>
      jsonResponse({ error: "store-busy", status: "error" }, 409),
    ) as CharacterFetch;
    const busyError = await requestCharacterProgressionLockRepair(
      busyFetcher,
    ).catch((error: unknown) => error);

    expect(busyError).toBeInstanceOf(CharacterProgressionWriteError);
    expect(busyError).toMatchObject({ code: "store-busy" });

    const driftedFetcher = vi.fn(async () =>
      jsonResponse({ status: "ok", outcome: "repaired", removedFiles: 1 }),
    ) as CharacterFetch;
    await expect(
      requestCharacterProgressionLockRepair(driftedFetcher),
    ).rejects.toThrow("Invalid progression lock repair response");
  });

  it("posts a wardrobe choice and swaps the active theme locally", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () =>
      jsonResponse({
        status: "ok",
        characterId: "chatgpt",
        activeThemeId: "tech",
      }),
    ) as CharacterFetch;

    const response = await requestCharacterWardrobe(
      "chatgpt",
      "tech",
      fetcher,
      controller.signal,
    );
    const updated = applyCharacterWardrobe(validSnapshot(), response);

    expect(updated.characters[0]?.activeThemeId).toBe("tech");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/characters/wardrobe",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ characterId: "chatgpt", themeId: "tech" }),
        signal: controller.signal,
      }),
    );
  });

  it("repaints a code-native letter immediately after a wardrobe choice", () => {
    const snapshot = parseCharactersSnapshot({
      ...structuredClone(CHARACTER_RESPONSE),
      selection: { characterId: "glm", selectedBy: "manual" },
      characters: CHARACTER_RESPONSE.characters.map((character) =>
        character.characterId === "glm"
          ? {
              ...character,
              activeThemeId: "tech",
              visual: {
                ...character.visual,
                background: LETTER_THEME.palette.background,
                foreground: LETTER_THEME.palette.foreground,
                accent: LETTER_THEME.palette.accent,
                themes: [
                  { ...LETTER_THEME, unlocked: true },
                  FINANCE_LETTER_THEME,
                ],
              },
            }
          : character,
      ),
    });

    const updated = applyCharacterWardrobe(snapshot, {
      status: "ok",
      characterId: "glm",
      activeThemeId: "finance",
    });
    expect(updated.characters[1]).toMatchObject({
      activeThemeId: "finance",
      visual: {
        mode: "letter",
        background: FINANCE_LETTER_THEME.palette.background,
        foreground: FINANCE_LETTER_THEME.palette.foreground,
        accent: FINANCE_LETTER_THEME.palette.accent,
      },
    });
  });
});
