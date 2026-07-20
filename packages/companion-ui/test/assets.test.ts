import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

interface BuiltCompanionUiModule {
  readonly COMPANION_UI_ENTRY_FILE: string;
  getCompanionUiAssetDirectory(): string;
}

const builtModuleUrl = pathToFileURL(
  resolve(import.meta.dirname, "../dist/index.js"),
).href;
const builtModule = (await import(builtModuleUrl)) as BuiltCompanionUiModule;
const assetDirectory = builtModule.getCompanionUiAssetDirectory();

async function readAsset(fileName: string): Promise<string> {
  return readFile(resolve(assetDirectory, fileName), "utf8");
}

async function readJavaScriptGraph(): Promise<string> {
  const fileNames = (await readdir(assetDirectory))
    .filter((fileName) => fileName.endsWith(".js"))
    .sort();
  return (await Promise.all(fileNames.map(readAsset))).join("\n");
}

describe("companion static assets", () => {
  it("exports the complete browser-native module graph", async () => {
    expect(builtModule.COMPANION_UI_ENTRY_FILE).toBe("index.html");
    await expect(stat(assetDirectory)).resolves.toMatchObject({});

    const [html, css, main, js] = await Promise.all([
      readAsset("index.html"),
      readAsset("styles.css"),
      readAsset("main.js"),
      readJavaScriptGraph(),
    ]);
    expect(html.length).toBeGreaterThan(1_000);
    expect(css.length).toBeGreaterThan(1_000);
    expect(js.length).toBeGreaterThan(1_000);
    expect(main.length).toBeGreaterThan(1_000);
    expect(html).toContain('<script type="module" src="/assets/main.js">');
    expect(html.match(/<script\b/gu)).toHaveLength(1);
    expect(js).not.toMatch(/\bfrom\s+["']\.\/(?![^"']+\.js["'])/u);

    const emittedFiles = new Set(await readdir(assetDirectory));
    expect(emittedFiles.has("analytics-panel.js")).toBe(true);
    for (const fileName of emittedFiles) {
      if (!fileName.endsWith(".js")) continue;
      const moduleSource = await readAsset(fileName);
      const imports = [
        ...moduleSource.matchAll(
          /(?:from\s+|export\s+\*\s+from\s+)["']\.\/([^"']+\.js)["']/gu,
        ),
      ];
      for (const moduleImport of imports) {
        expect(emittedFiles.has(moduleImport[1]!)).toBe(true);
      }
    }
  });

  it("shows the character and honest loading values before JavaScript runs", async () => {
    const [html, css, js] = await Promise.all([
      readAsset("index.html"),
      readAsset("styles.css"),
      readJavaScriptGraph(),
    ]);

    expect(html).toContain('lang="zh-Hant"');
    expect(html).toContain("先選一位姊妹陪你。");
    expect(html).toContain("TokenMonster 字母 T 夥伴");
    expect(html).toContain("data-roster");
    expect(html).toContain("data-progression-lock-repair");
    expect(html).toContain("data-character-doll");
    expect(html).toContain("data-wardrobe-toggle");
    expect(html).toContain("data-share-card");
    expect(html).toContain("data-share-card-hide-total");
    expect(html).toContain("data-asset-pack-control");
    expect(html).toContain("data-asset-pack-button");
    expect(html).toContain("data-asset-pack-revoke");
    expect(html).toContain("一次下載完整固定素材包");
    expect(html).toContain("不會傳送你的用量、目前角色、解鎖狀態或服裝選擇");
    expect(html).toContain("data-character-profile");
    expect(html).toContain("data-profile-reason-list");
    expect(html).toContain("今日默契");
    expect(html).toContain("我的夥伴卡");
    expect(html).toContain("儲存 PNG");
    expect(html).toContain("data-voice-toggle");
    expect(html).toContain("點一下讓她們開口");
    expect(html).toContain("data-character-tap-hint");
    expect(html).toMatch(
      /TokenMonster\s+為獨立產品，未與該供應商合作、隸屬或獲其背書。/u,
    );
    expect(html).toContain("正在啟動");
    expect(html).toContain("重新掃描");
    expect(html).toContain("data-rescan");
    expect(html).toContain('data-metric="today">—</span>');
    expect(html).toContain('data-metric="last7Days">—</span>');
    expect(html).toContain('data-metric="last28Days">—</span>');
    expect(html).toContain("今天（UTC）");
    expect(html).toContain("近 7 天（UTC）");
    expect(html).toContain("近 28 天（UTC）");
    expect(html).toContain("最近 28 個 UTC 日");
    expect(html).toContain("供應商與模型用量");
    expect(html).toContain("剩餘額度（估算）");
    expect(html).toContain("以本機統計估算，非官方數據，僅供參考。");
    expect(html).toContain("data-quota-list");
    expect(html).toContain('data-analytics-window="7"');
    expect(html).toContain('data-analytics-window="28"');
    expect(html).toContain('data-analytics-window="90"');
    expect(html).toContain(
      '<details class="stats-disclosure" data-stats-disclosure open>',
    );
    expect(html.indexOf('class="companion-panel"')).toBeLessThan(
      html.indexOf('class="analytics-panel"'),
    );
    expect(css).toMatch(/\.companion-panel\s*\{[^}]*grid-row:\s*1;/su);
    expect(css).toMatch(/\.stats-disclosure\s*\{[^}]*grid-row:\s*2;/su);
    expect(css).toMatch(
      /@media \(max-width: 34rem\)[\s\S]*?\.asset-pack-control\s*\{[^}]*flex-direction:\s*column;[\s\S]*?\.asset-pack-actions,[\s\S]*?\.asset-pack-revoke\s*\{[^}]*width:\s*100%;/u,
    );
    expect(js).toContain(
      'statsDisclosure.open = companionView === "dashboard"',
    );
    expect(js).toContain("已遇見 ");
    expect(js).toContain("下一次相遇進度");
    expect(js).toContain("renderLocalShareCard");
    expect(js).toContain("saveLocalShareCardBlob");
    expect(js).toContain("downloadLocalShareCard");
    expect(js).toContain("已交給瀏覽器下載");
    expect(js).toContain("作為第一位夥伴");
    expect(js).toContain("正在歡迎新夥伴");
    expect(js).toContain("requestCharacterProfile");
    expect(js).toContain("presentCharacterProfile");
    expect(html).not.toContain('style="');
    expect(html).not.toMatch(
      /data-metric="(?:today|last7Days|last28Days)">\d/u,
    );
  });

  it("keeps compact pet mode within the window and puts stats behind an expander", async () => {
    const [html, css, js] = await Promise.all([
      readAsset("index.html"),
      readAsset("styles.css"),
      readJavaScriptGraph(),
    ]);

    expect(html).toContain("<summary>用量與模型數據</summary>");
    expect(css).toContain('html[data-view="pet"] .page-shell');
    expect(css).toContain("height: 100dvh");
    expect(css).toContain("overflow: hidden");
    expect(css).toContain('html[data-view="pet"] .stats-disclosure[open]');
    expect(css).toContain('html[data-view="pet"] .quota-panel');
    expect(css).toContain(
      'html[data-view="pet"][data-starter-choice="pending"] .character-controls',
    );
    expect(js).toContain('new URLSearchParams(search).get("view") === "pet"');
    expect(js).toContain(
      'document.documentElement.dataset["view"] = companionView',
    );
    expect(js).toContain(
      'document.documentElement.dataset["starterChoice"] = initialChoiceMode',
    );
    expect(js).toContain("暫時未更新，顯示上次成功的額度估算。");
  });

  it("contains only same-origin assets and a restrictive browser policy", async () => {
    const [html, css, js] = await Promise.all([
      readAsset("index.html"),
      readAsset("styles.css"),
      readJavaScriptGraph(),
    ]);
    const references = [...html.matchAll(/(?:href|src)="([^"]+)"/gu)].map(
      (match) => match[1],
    );

    expect(references.length).toBeGreaterThan(0);
    expect(
      references.every(
        (reference) =>
          reference?.startsWith("/") ||
          reference?.startsWith("./") ||
          reference?.startsWith("#"),
      ),
    ).toBe(true);
    expect(html).toContain("default-src 'self'");
    expect(html).toContain("connect-src 'self'");
    expect(html).toContain("object-src 'none'");
    expect(css).not.toMatch(/url\s*\(/iu);
    expect(css).toContain(".roster-tagline");
    expect(css).toContain(".roster-recommendation");
    expect(js).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/u);
    expect(js).not.toMatch(
      /\b(?:innerHTML|outerHTML|insertAdjacentHTML|eval|sessionStorage)\b/u,
    );
    expect(js).toContain('"tokenmonster-voice"');
    expect(js).toContain('const COMPANION_API_ENDPOINT = "/api/companion"');
    expect(js).toContain(
      'const COLLECTOR_STATUS_ENDPOINT = "/api/companion/status"',
    );
    expect(js).toContain(
      'const COLLECTOR_REFRESH_ENDPOINT = "/api/companion/refresh"',
    );
    expect(js).toContain('const CHARACTERS_API_ENDPOINT = "/api/characters"');
    expect(js).toContain(
      'const CHARACTER_SELECT_ENDPOINT = "/api/characters/select"',
    );
    expect(js).toContain(
      'const CHARACTER_PROGRESSION_LOCK_REPAIR_ENDPOINT = "/api/characters/progression-lock/repair"',
    );
    expect(js).toContain(
      'const CHARACTER_WARDROBE_ENDPOINT = "/api/characters/wardrobe"',
    );
    expect(js).toContain(
      'const CHARACTER_ASSET_PACK_STATUS_ENDPOINT = "/api/characters/assets"',
    );
    expect(js).toContain("不會自動重試");
    expect(js).toMatch(/imageFallback\.reset\(\);\s*await pollCharacters\(\);/u);
    expect(js).toContain('const USAGE_QUOTA_API_ENDPOINT = "/api/usage/quota"');
    expect(js).toContain(
      'const USAGE_QUOTA_PLAN_API_ENDPOINT = "/api/usage/quota/plan"',
    );
    expect(js).toContain('credentials: "same-origin"');
    expect(js).toContain('tagline.className = "roster-tagline"');
    expect(js).toContain(
      'recommendation.className = "roster-recommendation"',
    );
    expect(js).toContain("更新於本機時間");
    expect(js).toContain(
      "四位都有不同個性，第一位由你親自選；之後也能隨時換。",
    );
    expect(js).toContain("這只是推薦，第一位夥伴仍由你親自選。");
    expect(js).toContain("依本機用量推薦，但仍由你決定");
    expect(js).toContain("不需要多用 token");
  });

  it("keeps old-version progression repair explicit, compact, and non-destructive", async () => {
    const [html, css, js] = await Promise.all([
      readAsset("index.html"),
      readAsset("styles.css"),
      readJavaScriptGraph(),
    ]);

    expect(html).toMatch(
      /<p id="character-reason" data-character-reason aria-live="polite">/u,
    );
    expect(html).toMatch(
      /<button\s+class="progression-lock-repair"\s+type="button"\s+data-progression-lock-repair\s+aria-describedby="character-reason"\s+hidden\s*>/u,
    );
    expect(css).toMatch(
      /\.progression-lock-repair\[hidden\]\s*\{\s*display:\s*none;/u,
    );
    expect(js).toContain("confirmedOldVersionsClosed: true");
    expect(html).toContain("修復角色選擇");
    expect(js).toContain("請保留這個視窗");
    expect(js).toContain("系統匣／選單列選「結束 TokenMonster」");
    expect(js).toContain("修復只會移除舊版留下的鎖，不會重設角色進度");
    expect(js).toContain("另一個 TokenMonster 仍在使用角色進度");
    expect(js).toContain("請再選一次你想要的夥伴");
    expect(js).toContain(
      "element.inert = starterChoiceSheetActive || byokDrawerOpen",
    );
    expect(js).toContain(
      "uiLocaleSessionPath(requestedLocale, window.location.search)",
    );
    expect(js).not.toContain("location.reload");
  });

  it("gives transient and incompatible failures different recovery copy", async () => {
    const js = await readJavaScriptGraph();

    expect(js).toContain("本機用量服務暫時沒回應，我會稍後再試。");
    expect(js).toContain(
      "目前版本無法讀取用量。請重新啟動或更新 TokenMonster，再重新檢查。",
    );
    expect(js).toContain("立即重試");
    expect(js).toContain("重新檢查");
  });

  it("distinguishes first sync, no-data, failed, and stale collector states", async () => {
    const [html, css, js] = await Promise.all([
      readAsset("index.html"),
      readAsset("styles.css"),
      readJavaScriptGraph(),
    ]);

    expect(js).toContain("先不把空白當成零");
    expect(js).toContain("這不是安靜的一天");
    expect(js).toContain("第一次掃描沒有完成");
    expect(js).toContain("這是上次成功整理的用量");
    expect(html).toContain("data-stale-badge");
    expect(css).toContain('html[data-connection="stale"]');
    expect(js).toContain("const ACTIVE_POLL_MS = 5_000");
    expect(js).toContain("const SETTLED_POLL_MS = 60_000");
  });

  it("shows only the finished fixed contribution controls, without collector configuration", async () => {
    const html = await readAsset("index.html");

    expect(html).not.toMatch(/collector|cloud|k\s*=\s*20/iu);
    expect(html).not.toMatch(/選擇.*收集|隱私政策|安全停用|觀測日/u);
    expect(html).toContain("data-contribution-control");
    expect(html).toContain("自願、匿名、預設關閉");
    expect(html).toContain("預覽實際分享資料");
    expect(html).toContain("不含提示、回覆、原始碼、檔名、專案路徑");
    expect(html).toContain("TokenMonster 公開服務永遠不會收到供應商憑證");
    expect(html.match(/<form/gu)).toHaveLength(3);
    expect(html).toContain("data-reminder-settings");
    expect(html).toContain("data-byok-configure");
    expect(html).toContain("data-byok-message-form");
  });

  it("loads, renders, saves, and tests opt-in device reminders through the Electron bridge", async () => {
    const [html, css, js] = await Promise.all([
      readAsset("index.html"),
      readAsset("styles.css"),
      readJavaScriptGraph(),
    ]);

    expect(html).toMatch(/data-reminder-panel[\s\S]*?hidden/u);
    expect(html).toContain("測試不會開啟每日排程；提醒預設保持關閉。");
    expect(html).toContain("開始與結束相同代表停用");
    expect(html).toContain("通知只含固定文字，不含提示、回覆、檔名或專案路徑");
    expect(css).toMatch(/\.reminder-panel\[hidden\][\s\S]*display:\s*none/u);
    expect(js).toContain("getReminderStatus");
    expect(js).toContain("updateReminderSettings");
    expect(js).toContain("testReminder");
    expect(js).toContain("loadReminderControl");
    expect(js).toContain("submitReminderSettings");
    expect(js).toContain("testReminderNotification");
    expect(js).toContain("reminderFormRevision");
    expect(js).toContain("expectedRevision");
    expect(js).toContain(
      "提醒設定已在另一個視窗更新；已重新載入最新設定",
    );
    expect(js).toContain("設定只會保存在這台裝置");
    expect(js).not.toMatch(/localStorage[\s\S]{0,160}reminder/iu);
  });

  it("renders default-off fixed-feed application update controls only through Electron", async () => {
    const [html, css, js] = await Promise.all([
      readAsset("index.html"),
      readAsset("styles.css"),
      readJavaScriptGraph(),
    ]);

    expect(html).toMatch(/data-automatic-update-panel[\s\S]*?hidden/u);
    expect(html).toContain("自動檢查預設關閉");
    expect(html).toContain("畫面不能指定網址");
    expect(html).toContain("data-automatic-update-enabled");
    expect(html).toContain("data-automatic-update-check");
    expect(html).toContain("data-automatic-update-install");
    expect(css).toMatch(
      /\.automatic-update-panel\[hidden\][\s\S]*display:\s*none/u,
    );
    expect(js).toContain("getAutomaticUpdateStatus");
    expect(js).toContain("updateAutomaticChecks");
    expect(js).toContain("checkForAutomaticUpdate");
    expect(js).toContain("installAutomaticUpdate");
    expect(js).toContain("automaticUpdateFormRevision");
    expect(js).toContain("若有新版會自動下載");
    expect(js).not.toMatch(/localStorage[\s\S]{0,180}automatic.?update/iu);
    expect(js).not.toContain("cdn.ted-h.com/tokenmonster/releases");
  });

  it("keeps BYOK explicit, session-only, and hidden when unavailable", async () => {
    const [html, css, js] = await Promise.all([
      readAsset("index.html"),
      readAsset("styles.css"),
      readJavaScriptGraph(),
    ]);

    expect(html).toMatch(/data-byok-panel[\s\S]*?hidden/u);
    expect(html).toContain('type="password"');
    expect(html).toContain("TokenMonster\n                    公開服務不會收到");
    expect(html).toContain("store: false");
    expect(html).toContain("仍適用\n                    OpenAI 的資料保留政策");
    expect(css).toMatch(/\.byok-chat-panel\[hidden\][\s\S]*display:\s*none/u);
    expect(js).toContain('byokKeyInput.value = ""');
    expect(js).toContain("resetByokConversation(true)");
    expect(js).toContain("byokHistory = Object.freeze([])");
    expect(js).not.toMatch(/localStorage[\s\S]{0,120}byok/iu);
  });
});
