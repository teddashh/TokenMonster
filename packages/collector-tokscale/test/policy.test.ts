import { describe, expect, it } from "vitest";

import {
  CollectorTokscaleError,
  REMOVED_TOKSCALE_ENV_KEYS,
  TIER_1_CLIENTS,
  TIER_1_CLIENT_TOOL_SCOPE,
  buildSanitizedTokscaleEnv,
  buildTokscaleReportArgs,
  toolScopeForTier1Client
} from "../src/index.js";

const NOW = new Date("2026-07-15T12:00:00.000Z");

describe("fixed Tokscale command policy", () => {
  it("exports the exact immutable Tier-1 client tool scopes", () => {
    expect(TIER_1_CLIENT_TOOL_SCOPE).toEqual({
      claude: "claude-code",
      codex: "codex-cli",
      gemini: "gemini-cli",
      grok: "grok-build"
    });
    expect(Object.isFrozen(TIER_1_CLIENT_TOOL_SCOPE)).toBe(true);
    expect(toolScopeForTier1Client("codex")).toBe("codex-cli");
    expect(() => toolScopeForTier1Client("unknown-client")).toThrowError(
      expect.objectContaining({ code: "invalid-input" })
    );
  });

  it.each(TIER_1_CLIENTS)("builds fixed local report argv for %s", (client) => {
    const args = buildTokscaleReportArgs(client, "2026-07-15", NOW);
    expect(args).toEqual([
      "--json",
      "--group-by",
      "client,provider,model",
      "--since",
      "2026-07-15",
      "--until",
      "2026-07-15",
      "--client",
      client,
      "--no-spinner",
      "--hide-zero"
    ]);
    expect(Object.isFrozen(args)).toBe(true);
  });

  it.each([
    "cursor",
    "claude; rm -rf /",
    "--client=claude",
    "",
    ["claude", "--graph"]
  ])("rejects an unsafe or non-Tier-1 client: %j", (client) => {
    expect(() => buildTokscaleReportArgs(client, "2026-07-15", NOW)).toThrow(
      CollectorTokscaleError
    );
  });

  it.each([
    "2026-07-16",
    "2026-07-13",
    "2026-02-30",
    "2026-07-15 --graph",
    "../2026-07-15"
  ])("rejects a non-current or unsafe UTC date: %s", (date) => {
    expect(() => buildTokscaleReportArgs("claude", date, NOW)).toThrow(
      CollectorTokscaleError
    );
  });

  it("allows the previous UTC date for late writes and corrections", () => {
    const args = buildTokscaleReportArgs("codex", "2026-07-14", NOW);
    expect(args.slice(3, 7)).toEqual([
      "--since",
      "2026-07-14",
      "--until",
      "2026-07-14"
    ]);
  });
});

describe("sanitized child environment", () => {
  it("copies only allowlisted environment and forces offline Tokscale config", () => {
    const parentEnv: NodeJS.ProcessEnv = {
      HOME: "/home/tester",
      LANG: "en_US.UTF-8",
      PATH: "/private/bin",
      SECRET_VALUE: "do-not-copy",
      TOKSCALE_API_TOKEN: "upstream-secret",
      TOKSCALE_API_URL: "https://unexpected.example",
      TOKSCALE_EXTRA_DIRS: "/private/project",
      TOKSCALE_HEADLESS_DIR: "/private/headless",
      TOKSCALE_CONFIG_DIR: "/untrusted/config",
      TOKSCALE_PRICING_CACHE_ONLY: "0"
    };

    const env = buildSanitizedTokscaleEnv(
      parentEnv,
      "/home/tester/.tokenmonster/tokscale"
    );
    expect(env).toEqual({
      HOME: "/home/tester",
      LANG: "en_US.UTF-8",
      TZ: "UTC",
      TOKSCALE_CONFIG_DIR: "/home/tester/.tokenmonster/tokscale",
      TOKSCALE_PRICING_CACHE_ONLY: "1"
    });
    expect(env["PATH"]).toBeUndefined();
    expect(env["SECRET_VALUE"]).toBeUndefined();
    for (const key of REMOVED_TOKSCALE_ENV_KEYS) {
      expect(env[key]).toBeUndefined();
    }
  });

  it.each(["relative/path", "", "bad\0path", null])(
    "rejects a non-absolute private config directory: %j",
    (configDir) => {
      expect(() => buildSanitizedTokscaleEnv({}, configDir)).toThrow(
        CollectorTokscaleError
      );
    }
  );
});
