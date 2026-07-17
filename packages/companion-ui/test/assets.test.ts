import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

interface BuiltCompanionUiModule {
  readonly COMPANION_UI_ENTRY_FILE: string;
  getCompanionUiAssetDirectory(): string;
}

const builtModuleUrl = pathToFileURL(
  resolve(import.meta.dirname, "../dist/index.js")
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
      readJavaScriptGraph()
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
          /(?:from\s+|export\s+\*\s+from\s+)["']\.\/([^"']+\.js)["']/gu
        )
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
      readJavaScriptGraph()
    ]);

    expect(html).toContain('lang="zh-Hant"');
    expect(html).toContain("先選一位姊妹陪你。");
    expect(html).toContain("TokenMonster 字母 T 夥伴");
    expect(html).toContain("data-roster");
    expect(html).toContain("data-character-doll");
    expect(html).toContain("data-wardrobe-toggle");
    expect(html).toContain("data-voice-toggle");
    expect(html).toContain("點一下讓她們開口");
    expect(html).toContain(
      "TokenMonster 為獨立產品，未與該供應商合作、隸屬或獲其背書。"
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
      '<details class="stats-disclosure" data-stats-disclosure open>'
    );
    expect(html.indexOf('class="companion-panel"')).toBeLessThan(
      html.indexOf('class="analytics-panel"')
    );
    expect(css).toMatch(/\.companion-panel\s*\{[^}]*grid-row:\s*1;/su);
    expect(css).toMatch(/\.stats-disclosure\s*\{[^}]*grid-row:\s*2;/su);
    expect(js).toContain('statsDisclosure.open = companionView === "dashboard"');
    expect(js).toContain("位夥伴等待解鎖");
    expect(html).not.toContain('style="');
    expect(html).not.toMatch(/data-metric="(?:today|last7Days|last28Days)">\d/u);
  });

  it("keeps compact pet mode within the window and puts stats behind an expander", async () => {
    const [html, css, js] = await Promise.all([
      readAsset("index.html"),
      readAsset("styles.css"),
      readJavaScriptGraph()
    ]);

    expect(html).toContain("<summary>用量與模型數據</summary>");
    expect(css).toContain('html[data-view="pet"] .page-shell');
    expect(css).toContain("height: 100dvh");
    expect(css).toContain("overflow: hidden");
    expect(css).toContain('html[data-view="pet"] .stats-disclosure[open]');
    expect(css).toContain('html[data-view="pet"] .quota-panel');
    expect(js).toContain('new URLSearchParams(search).get("view") === "pet"');
    expect(js).toContain('document.documentElement.dataset["view"] = companionView');
  });

  it("contains only same-origin assets and a restrictive browser policy", async () => {
    const [html, css, js] = await Promise.all([
      readAsset("index.html"),
      readAsset("styles.css"),
      readJavaScriptGraph()
    ]);
    const references = [...html.matchAll(/(?:href|src)="([^"]+)"/gu)].map(
      (match) => match[1]
    );

    expect(references.length).toBeGreaterThan(0);
    expect(
      references.every(
        (reference) =>
          reference?.startsWith("/") ||
          reference?.startsWith("./") ||
          reference?.startsWith("#")
      )
    ).toBe(true);
    expect(html).toContain("default-src 'self'");
    expect(html).toContain("connect-src 'self'");
    expect(html).toContain("object-src 'none'");
    expect(css).not.toMatch(/url\s*\(/iu);
    expect(js).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/u);
    expect(js).not.toMatch(
      /\b(?:innerHTML|outerHTML|insertAdjacentHTML|eval|sessionStorage)\b/u
    );
    expect(js).toContain('"tokenmonster-voice"');
    expect(js).toContain('const COMPANION_API_ENDPOINT = "/api/companion"');
    expect(js).toContain(
      'const COLLECTOR_STATUS_ENDPOINT = "/api/companion/status"'
    );
    expect(js).toContain(
      'const COLLECTOR_REFRESH_ENDPOINT = "/api/companion/refresh"'
    );
    expect(js).toContain('const CHARACTERS_API_ENDPOINT = "/api/characters"');
    expect(js).toContain(
      'const CHARACTER_SELECT_ENDPOINT = "/api/characters/select"'
    );
    expect(js).toContain(
      'const CHARACTER_WARDROBE_ENDPOINT = "/api/characters/wardrobe"'
    );
    expect(js).toContain('const USAGE_QUOTA_API_ENDPOINT = "/api/usage/quota"');
    expect(js).toContain(
      'const USAGE_QUOTA_PLAN_API_ENDPOINT = "/api/usage/quota/plan"'
    );
    expect(js).toContain('credentials: "same-origin"');
    expect(js).toContain("更新於本機時間");
    expect(js).toContain("依近 28 天的本機使用分布先由她陪你");
    expect(js).toContain("不需要多用 token");
  });

  it("gives transient and incompatible failures different recovery copy", async () => {
    const js = await readJavaScriptGraph();

    expect(js).toContain("本機用量服務暫時沒回應，我會稍後再試。");
    expect(js).toContain(
      "目前版本無法讀取用量。請重新啟動或更新 TokenMonster，再重新檢查。"
    );
    expect(js).toContain("立即重試");
    expect(js).toContain("重新檢查");
  });

  it("distinguishes first sync, no-data, failed, and stale collector states", async () => {
    const [html, css, js] = await Promise.all([
      readAsset("index.html"),
      readAsset("styles.css"),
      readJavaScriptGraph()
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

  it("keeps setup, policy, and unfinished controls off the main screen", async () => {
    const html = await readAsset("index.html");

    expect(html).not.toMatch(/collector|BYOK|cloud|API key|OAuth|k\s*=\s*20/iu);
    expect(html).not.toMatch(/選擇.*收集|隱私政策|安全停用|觀測日/u);
    expect(html).not.toContain("<form");
  });
});
