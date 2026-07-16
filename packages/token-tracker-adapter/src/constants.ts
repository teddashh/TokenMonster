export const SUPPORTED_TOKEN_TRACKER_VERSION = "0.80.0" as const;

export const DEFAULT_TOKEN_TRACKER_BASE_URL =
  "http://127.0.0.1:7680" as const;

export const TOKEN_TRACKER_USAGE_SUMMARY_PATH =
  "/functions/tokentracker-usage-summary" as const;

export const TOKEN_TRACKER_USAGE_DAILY_PATH =
  "/functions/tokentracker-usage-daily" as const;

export const TOKEN_TRACKER_USAGE_MODEL_BREAKDOWN_PATH =
  "/functions/tokentracker-usage-model-breakdown" as const;

export const TOKEN_TRACKER_PROVIDER_SOURCE_MAP = Object.freeze({
  codex: "openai",
  claude: "anthropic",
  gemini: "google",
  grok: "xai"
} as const);

export const TOKEN_TRACKER_PROGRESSION_SOURCE_MAP = Object.freeze({
  codex: "openai",
  claude: "anthropic",
  gemini: "google",
  grok: "xai",
  deepseek: "deepseek",
  qwen: "qwen",
  mistral: "mistral",
  venice: "venice",
  sakana: "sakana",
  perplexity: "perplexity",
  glm: "glm"
} as const);

export const DEFAULT_TOKEN_TRACKER_TIMEOUT_MS = 2_000;
export const MAX_TOKEN_TRACKER_TIMEOUT_MS = 10_000;
export const MAX_TOKEN_TRACKER_RESPONSE_BYTES = 512 * 1_024;
export const MAX_TOKEN_TRACKER_RANGE_DAYS = 366;
