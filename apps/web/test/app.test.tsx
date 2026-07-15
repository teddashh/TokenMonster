import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App, PublicCounter } from "../src/App.js";
import {
  PUBLIC_COUNTER_DISCLAIMER,
  PUBLIC_COUNTER_LABEL,
  type PublicCounterState,
} from "../src/public-totals.js";

const UNAVAILABLE_STATE = {
  status: "unavailable",
} as const satisfies PublicCounterState;

const VERIFIED_STATE = {
  status: "verified",
  snapshot: {
    contractVersion: 1,
    label: PUBLIC_COUNTER_LABEL,
    disclaimer: PUBLIC_COUNTER_DISCLAIMER,
    allTimeTokens: "1234567890123456",
    todayUtcTokens: "456789",
    contributors: "42",
    generatedAt: "2026-07-15T18:23:00Z",
    dataRevision: "revision-7",
  },
} as const satisfies PublicCounterState;

describe("honest public counter", () => {
  it("renders an unavailable state without a made-up counter value", () => {
    const markup = renderToStaticMarkup(
      <PublicCounter state={UNAVAILABLE_STATE} onRetry={() => undefined} />,
    );

    expect(markup).toContain("目前無法顯示經驗證總量");
    expect(markup).toContain("不會用示範數字或動畫假裝資料存在");
    expect(markup).toContain(PUBLIC_COUNTER_DISCLAIMER);
    expect(markup).not.toContain("<data");
    expect(markup).not.toMatch(/data-counter|odometer|count-up/iu);
  });

  it("shows exact decimal totals and the verified UTC timestamp", () => {
    const markup = renderToStaticMarkup(
      <PublicCounter state={VERIFIED_STATE} onRetry={() => undefined} />,
    );

    expect(markup).toContain('value="1234567890123456"');
    expect(markup).toContain("1,234,567,890,123,456");
    expect(markup).toMatch(/date(?:T|t)ime="2026-07-15T18:23:00Z"/u);
    expect(markup).toContain("2026-07-15 18:23:00 UTC");
  });
});

describe("public landing semantics and release gates", () => {
  it("ships landmark navigation and all method, privacy, control, download, and support sections", () => {
    const markup = renderToStaticMarkup(<App counterState={UNAVAILABLE_STATE} />);

    expect(markup).toContain('<main id="main-content">');
    expect(markup).toContain('aria-label="主要導覽"');
    expect(markup).toContain('id="method"');
    expect(markup).toContain('id="privacy"');
    expect(markup).toContain('id="delete"');
    expect(markup).toContain('id="download"');
    expect(markup).toContain('id="support"');
    expect(markup).toContain(PUBLIC_COUNTER_DISCLAIMER);
    expect(markup).toContain("最多保留 30 天");
    expect(markup).toContain("k ≥ 20");
    expect(markup).toContain("未達門檻的到期資料會刪除");
    expect(markup).toContain("/v1/consent-documents/current?purpose=contribution");
  });

  it("renders four code-native letter placeholders and no blocked raster reference", () => {
    const markup = renderToStaticMarkup(<App counterState={UNAVAILABLE_STATE} />);

    expect(markup.match(/aria-pressed=/g)).toHaveLength(4);
    expect(markup.match(/字母 placeholder/g)?.length).toBeGreaterThanOrEqual(5);
    expect(markup).toContain("候選角色圖像：封鎖中");
    expect(markup).toContain("書面公開／商業授權與品牌審查核准前");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain(".webp");
    expect(markup).not.toContain("web/public/avatars");
    expect(markup).not.toContain("Live2D");
    expect(markup).not.toContain("3D");
  });

  it("keeps the unsigned Alpha CTA visibly unavailable", () => {
    const markup = renderToStaticMarkup(<App counterState={UNAVAILABLE_STATE} />);

    expect(markup).toContain("現在沒有可安全推薦的安裝包");
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*>簽署版 Alpha 尚未開放下載<\/button>/u,
    );
    expect(markup).toContain("Release status: not available");
  });
});
