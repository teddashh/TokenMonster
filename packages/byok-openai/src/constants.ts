export const OPENAI_RESPONSES_ENDPOINT =
  "https://api.openai.com/v1/responses" as const;

export const OPENAI_BYOK_MODELS = ["gpt-5.6-luna"] as const;
export type OpenAiByokModel = (typeof OPENAI_BYOK_MODELS)[number];

export const DEFAULT_OPENAI_BYOK_MODEL: OpenAiByokModel = "gpt-5.6-luna";
export const DEFAULT_OPENAI_TIMEOUT_MS = 30_000;
export const MAX_OPENAI_TIMEOUT_MS = 60_000;
export const MAX_OPENAI_INSTRUCTIONS_BYTES = 16 * 1024;
export const MAX_OPENAI_INPUT_BYTES = 128 * 1024;
export const DEFAULT_OPENAI_MAX_OUTPUT_TOKENS = 512;
export const MAX_OPENAI_MAX_OUTPUT_TOKENS = 4_096;
export const MAX_OPENAI_RESPONSE_BYTES = 1024 * 1024;
