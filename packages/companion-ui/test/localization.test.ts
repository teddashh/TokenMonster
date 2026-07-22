import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHARACTER_PROFILE_EVOLUTION_EVENTS,
  CHARACTER_PROFILE_MOOD_IDS,
  CHARACTER_PROFILE_REASON_CODES,
  CHARACTER_PROFILE_TRAIT_IDS,
  CHARACTER_THEME_IDS,
  parseUiLocalePreferenceResponse,
  type CharacterUnlock,
} from "../src/public/dto.js";
import {
  requestUiLocalePreference,
  saveUiLocalePreference,
} from "../src/public/api.js";
import {
  characterProfileEvolutionLabel,
  characterProfileMoodLabel,
  characterProfileReasonText,
  characterProfileTraitLabel,
} from "../src/public/character-profile.js";
import { characterUnlockToastText } from "../src/public/character-state.js";
import { progressionLockRepairView } from "../src/public/progression-lock-repair.js";
import {
  ENGLISH_UI_COPY,
  containsHan,
  englishUiText,
  formatUiDate,
  formatUiNumber,
  localizeUiText,
  setUiLocale,
  uiLocaleFromSessionPath,
  uiLocaleSessionPath,
  uiCopy,
} from "../src/public/localization.js";
import { formatCompactTokenCount } from "../src/public/usage-panel.js";
import {
  characterThemeAccessibleLabel,
  characterThemeLabel,
  characterThemeLockedLabel,
  characterThemeStageGreetingLabel,
  characterThemeUnavailableLabel,
  characterThemeWearLabel,
} from "../src/public/wardrobe.js";

afterEach(() => {
  setUiLocale("zh-TW");
  vi.restoreAllMocks();
});

function expectEnglish(...values: readonly string[]): void {
  for (const value of values) {
    expect(value).not.toMatch(/\p{Script=Han}/u);
  }
}

describe("typed companion UI locale catalog", () => {
  it("has structural zh-TW/en parity and no Han in any English value", () => {
    setUiLocale("en");
    for (const [source, english] of Object.entries(ENGLISH_UI_COPY)) {
      expect(uiCopy(source as keyof typeof ENGLISH_UI_COPY)).toBe(english);
      expectEnglish(english);
    }
    setUiLocale("zh-TW");
    for (const source of Object.keys(ENGLISH_UI_COPY)) {
      expect(uiCopy(source as keyof typeof ENGLISH_UI_COPY)).toBe(source);
    }
  });

  it("covers every static HTML text/ARIA phrase and exact TS copy literal", async () => {
    const publicDirectory = resolve(import.meta.dirname, "../src/public");
    const html = await readFile(resolve(publicDirectory, "index.html"), "utf8");
    expect(html).toContain("data-ui-locale");
    expect(html).toContain('<option value="zh-TW">繁體中文</option>');
    expect(html).toContain('<option value="en">English</option>');
    const htmlPhrases = [
      ...[...html.matchAll(/(?:aria-label|placeholder|title)="([^"]+)"/gu)].map(
        (match) => match[1]!,
      ),
      ...html
        .replace(/<[^>]+>/gu, "\n")
        .split(/\n+/gu)
        .map((text) => text.trim().replace(/\s+/gu, " "))
        .filter(Boolean),
    ];
    for (const phrase of htmlPhrases.filter(containsHan)) {
      expectEnglish(englishUiText(phrase));
    }

    const sourceFiles = (await readdir(publicDirectory)).filter(
      (fileName) => fileName.endsWith(".ts") && fileName !== "localization.ts",
    );
    for (const fileName of sourceFiles) {
      const source = await readFile(resolve(publicDirectory, fileName), "utf8");
      for (const match of source.matchAll(
        /(["`])((?:\\.|(?!\1)[\s\S])*?)\1/gu,
      )) {
        const phrase = match[2]!.replace(/\\n/gu, " ").replace(/\\"/gu, '"');
        if (containsHan(phrase) && !phrase.includes("${")) {
          expectEnglish(englishUiText(phrase));
        }
      }
    }
  });

  it("derives every English wardrobe/stage/toast/profile string from IDs", () => {
    setUiLocale("en");
    for (const themeId of CHARACTER_THEME_IDS) {
      expectEnglish(
        characterThemeLabel(themeId),
        characterThemeAccessibleLabel(themeId),
        characterThemeStageGreetingLabel("ChatGPT", themeId),
        characterThemeWearLabel(themeId),
        characterThemeUnavailableLabel(themeId),
        characterThemeLockedLabel(themeId),
        characterThemeLockedLabel(themeId, "Natural local milestone."),
      );
    }
    for (const id of CHARACTER_PROFILE_TRAIT_IDS) {
      expectEnglish(characterProfileTraitLabel(id));
    }
    for (const id of CHARACTER_PROFILE_MOOD_IDS) {
      expectEnglish(characterProfileMoodLabel(id));
    }
    for (const event of CHARACTER_PROFILE_EVOLUTION_EVENTS) {
      expectEnglish(characterProfileEvolutionLabel(event));
    }
    for (const reason of CHARACTER_PROFILE_REASON_CODES) {
      expectEnglish(characterProfileReasonText(reason));
    }

    const base = {
      key: "test",
      batchId: "batch",
      characterId: "chatgpt",
      displayName: "ChatGPT",
      themeId: null,
    } as const;
    const characterUnlock = {
      ...base,
      kind: "character",
    } satisfies CharacterUnlock;
    const themeUnlock = {
      ...base,
      kind: "theme",
      themeId: "tech",
    } satisfies CharacterUnlock;
    const summaryUnlock = {
      ...base,
      kind: "character",
      summary: { characterCount: 2, themeCount: 3 },
    } satisfies CharacterUnlock;
    expectEnglish(
      characterUnlockToastText(characterUnlock),
      characterUnlockToastText(themeUnlock),
      characterUnlockToastText(summaryUnlock),
    );
    for (const state of [
      "hidden",
      "available",
      "checking",
      "busy",
      "ready",
      "failed",
    ] as const) {
      const view = progressionLockRepairView(state);
      expectEnglish(view.controlLabel, view.reasonOverride ?? "");
    }
  });

  it("localizes interpolated copy and Intl formatting with the active locale", () => {
    setUiLocale("en");
    expectEnglish(
      localizeUiText(
        "啟用時會一次下載約 12 MB 的完整固定素材包（12,345,678 bytes）。這個請求只取素材，不會傳送你的用量、目前角色、解鎖狀態或服裝選擇；之後可隨時移除下載的完整素材，內建四位元祖角色的基本服裝圖像與文字不受影響。",
      ),
      localizeUiText("近 28 天共 12,345 tokens，來自 3 個供應商家族。"),
      localizeUiText("上次更新於本機時間 09:41"),
      localizeUiText("TokenMonster 0.2.0 已準備好安裝。"),
    );
    expect(formatUiNumber(1_234_567)).toBe(
      new Intl.NumberFormat("en", {
        maximumFractionDigits: 0,
        useGrouping: true,
      }).format(1_234_567),
    );
    const instant = Date.parse("2026-07-16T00:00:00.000Z");
    expect(
      formatUiDate(instant, {
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      }),
    ).toBe(
      new Intl.DateTimeFormat("en", {
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      }).format(instant),
    );
  });
});

describe("UI locale preference renderer API", () => {
  it("uses a fixed session route to fully reformat a failed-save locale", () => {
    expect(uiLocaleSessionPath("en")).toBe("/session/locale/en");
    expect(uiLocaleSessionPath("zh-TW", "?view=pet")).toBe(
      "/session/locale/zh-TW?view=pet",
    );
    expect(uiLocaleSessionPath("en", "?view=pet&unexpected=true")).toBe(
      "/session/locale/en",
    );
    expect(uiLocaleFromSessionPath("/session/locale/en")).toBe("en");
    expect(uiLocaleFromSessionPath("/session/locale/zh-TW")).toBe("zh-TW");
    expect(uiLocaleFromSessionPath("/session/locale/fr")).toBeNull();

    setUiLocale("zh-TW");
    const beforeReload = formatCompactTokenCount(12_345);
    const recoveredLocale = uiLocaleFromSessionPath(
      uiLocaleSessionPath("en"),
    );
    expect(recoveredLocale).toBe("en");
    setUiLocale(recoveredLocale!);
    expect(formatCompactTokenCount(12_345)).toBe(
      new Intl.NumberFormat("en", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(12_345),
    );
    expect(formatCompactTokenCount(12_345)).not.toBe(beforeReload);
  });

  it("parses only an exact bounded DTO", () => {
    expect(
      parseUiLocalePreferenceResponse({
        status: "ok",
        locale: "en",
        revision: 4,
      }),
    ).toEqual({ status: "ok", locale: "en", revision: 4 });
    for (const invalid of [
      { status: "ok", locale: "fr", revision: 0 },
      { status: "ok", locale: "en", revision: -1 },
      { status: "ok", locale: "en", revision: 0, path: "/private" },
      { status: "error", error: "storage-unavailable" },
    ]) {
      expect(() => parseUiLocalePreferenceResponse(invalid)).toThrow(
        "Invalid UI locale preference response",
      );
    }
  });

  it("uses fixed same-origin GET/POST requests and exact CAS JSON", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"status":"ok","locale":"zh-TW","revision":2}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response('{"status":"ok","locale":"en","revision":3}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    await expect(requestUiLocalePreference(fetcher)).resolves.toMatchObject({
      locale: "zh-TW",
      revision: 2,
    });
    await expect(saveUiLocalePreference("en", 2, fetcher)).resolves.toMatchObject(
      { locale: "en", revision: 3 },
    );
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/preferences/locale", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { Accept: "application/json" },
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/preferences/locale", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: '{"locale":"en","expectedRevision":2}',
    });
  });
});
