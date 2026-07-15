import { isAbsolute } from "node:path";

import { z } from "zod";

import { CollectorTokscaleError } from "./errors.js";

export const TIER_1_CLIENTS = ["claude", "codex", "gemini", "grok"] as const;
export const Tier1ClientSchema = z.enum(TIER_1_CLIENTS);
export type Tier1Client = z.infer<typeof Tier1ClientSchema>;

/**
 * Exact normalized tool scope owned by each audited Tier-1 daily report.
 * Complete-empty scans use this scope to correct keys that disappeared from
 * an absolute report, so callers must not maintain a second mapping.
 */
export const TIER_1_CLIENT_TOOL_SCOPE: Readonly<
  Record<Tier1Client, "claude-code" | "codex-cli" | "gemini-cli" | "grok-build">
> = Object.freeze({
  claude: "claude-code",
  codex: "codex-cli",
  gemini: "gemini-cli",
  grok: "grok-build"
});

export type Tier1ToolScope =
  (typeof TIER_1_CLIENT_TOOL_SCOPE)[Tier1Client];

const UTC_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PASSTHROUGH_ENV_KEYS = [
  "APPDATA",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME"
] as const;

export const REMOVED_TOKSCALE_ENV_KEYS = [
  "TOKSCALE_API_TOKEN",
  "TOKSCALE_API_URL",
  "TOKSCALE_EXTRA_DIRS",
  "TOKSCALE_HEADLESS_DIR"
] as const;

function isValidUtcDate(value: string): boolean {
  const match = UTC_DATE_PATTERN.exec(value);
  if (match === null) {
    return false;
  }

  const canonical = value + "T00:00:00.000Z";
  const timestamp = Date.parse(canonical);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === canonical &&
    timestamp >= Date.parse("2020-01-01T00:00:00.000Z") &&
    timestamp < Date.parse("2100-01-01T00:00:00.000Z")
  );
}

export const UtcDateSchema = z
  .string()
  .refine(isValidUtcDate, "Expected a valid UTC date from 2020 through 2099.");

export function currentUtcDate(now: Date): string {
  if (!Number.isFinite(now.getTime())) {
    throw new CollectorTokscaleError("invalid-input", "now must be a valid Date.");
  }
  return now.toISOString().slice(0, 10);
}

export function previousUtcDate(now: Date): string {
  if (!Number.isFinite(now.getTime())) {
    throw new CollectorTokscaleError("invalid-input", "now must be a valid Date.");
  }
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

export function parseCollectionUtcDate(value: unknown, now: Date): string {
  const parsed = UtcDateSchema.safeParse(value);
  if (
    !parsed.success ||
    ![currentUtcDate(now), previousUtcDate(now)].includes(parsed.data)
  ) {
    throw new CollectorTokscaleError(
      "invalid-input",
      "Only the current or previous UTC date may be collected."
    );
  }
  return parsed.data;
}

export function parseTier1Client(value: unknown): Tier1Client {
  const parsed = Tier1ClientSchema.safeParse(value);
  if (!parsed.success) {
    throw new CollectorTokscaleError(
      "invalid-input",
      "Only Tier-1 clients claude, codex, gemini, and grok are allowed."
    );
  }
  return parsed.data;
}

export function toolScopeForTier1Client(input: unknown): Tier1ToolScope {
  return TIER_1_CLIENT_TOOL_SCOPE[parseTier1Client(input)];
}

export function buildTokscaleReportArgs(
  clientInput: unknown,
  utcDateInput: unknown,
  now: Date
): readonly string[] {
  const client = parseTier1Client(clientInput);
  const utcDate = parseCollectionUtcDate(utcDateInput, now);

  return Object.freeze([
    "--json",
    "--group-by",
    "client,provider,model",
    "--since",
    utcDate,
    "--until",
    utcDate,
    "--client",
    client,
    "--no-spinner",
    "--hide-zero"
  ]);
}

export function buildSanitizedTokscaleEnv(
  parentEnv: NodeJS.ProcessEnv,
  configDirInput: unknown
): NodeJS.ProcessEnv {
  if (
    typeof configDirInput !== "string" ||
    configDirInput.length === 0 ||
    configDirInput.includes("\0") ||
    !isAbsolute(configDirInput)
  ) {
    throw new CollectorTokscaleError(
      "invalid-input",
      "TOKSCALE_CONFIG_DIR must be an absolute TokenMonster-private directory."
    );
  }

  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV_KEYS) {
    const value = parentEnv[key];
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }

  childEnv["TZ"] = "UTC";
  childEnv["TOKSCALE_CONFIG_DIR"] = configDirInput;
  childEnv["TOKSCALE_PRICING_CACHE_ONLY"] = "1";

  return childEnv;
}
