import { Buffer } from "node:buffer";

import {
  DEFAULT_OPENAI_BYOK_MODEL,
  DEFAULT_OPENAI_MAX_OUTPUT_TOKENS,
  MAX_OPENAI_INPUT_BYTES,
  MAX_OPENAI_INSTRUCTIONS_BYTES,
  MAX_OPENAI_MAX_OUTPUT_TOKENS,
  OPENAI_BYOK_MODELS,
  type OpenAiByokModel
} from "./constants.js";
import { ByokOpenAiError } from "./errors.js";
import type { OpenAiByokRequest } from "./types.js";

const API_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{16,509}$/u;
const REQUEST_KEYS = new Set<PropertyKey>([
  "apiKey",
  "instructions",
  "input",
  "maxOutputTokens",
  "model"
]);

export interface NormalizedOpenAiByokRequest {
  readonly apiKey: string;
  readonly instructions: string;
  readonly input: string;
  readonly maxOutputTokens: number;
  readonly model: OpenAiByokModel;
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function dataProperty(
  record: Record<PropertyKey, unknown>,
  key: PropertyKey
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new ByokOpenAiError("invalid-request");
  }
  return descriptor.value;
}

function optionalDataProperty(
  record: Record<PropertyKey, unknown>,
  key: PropertyKey
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) {
    return undefined;
  }
  if (!("value" in descriptor)) {
    throw new ByokOpenAiError("invalid-request");
  }
  return descriptor.value;
}

function validateBoundedText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new ByokOpenAiError("invalid-request");
  }
  return value;
}

function validateApiKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !API_KEY_PATTERN.test(value)
  ) {
    throw new ByokOpenAiError("invalid-api-key");
  }
  return value;
}

function validateModel(value: unknown): OpenAiByokModel {
  if (
    typeof value !== "string" ||
    !OPENAI_BYOK_MODELS.includes(value as OpenAiByokModel)
  ) {
    throw new ByokOpenAiError("invalid-request");
  }
  return value as OpenAiByokModel;
}

function validateMaxOutputTokens(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_OPENAI_MAX_OUTPUT_TOKENS
  ) {
    throw new ByokOpenAiError("invalid-request");
  }
  return value;
}

export function normalizeOpenAiByokRequest(
  input: OpenAiByokRequest
): NormalizedOpenAiByokRequest {
  if (!isPlainRecord(input)) {
    throw new ByokOpenAiError("invalid-request");
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => !REQUEST_KEYS.has(key)) ||
    !keys.includes("apiKey") ||
    !keys.includes("instructions") ||
    !keys.includes("input")
  ) {
    throw new ByokOpenAiError("invalid-request");
  }

  const optionalModel = optionalDataProperty(input, "model");
  const optionalMaxOutputTokens = optionalDataProperty(
    input,
    "maxOutputTokens"
  );

  return Object.freeze({
    apiKey: validateApiKey(dataProperty(input, "apiKey")),
    instructions: validateBoundedText(
      dataProperty(input, "instructions"),
      MAX_OPENAI_INSTRUCTIONS_BYTES
    ),
    input: validateBoundedText(
      dataProperty(input, "input"),
      MAX_OPENAI_INPUT_BYTES
    ),
    maxOutputTokens:
      optionalMaxOutputTokens === undefined
        ? DEFAULT_OPENAI_MAX_OUTPUT_TOKENS
        : validateMaxOutputTokens(optionalMaxOutputTokens),
    model:
      optionalModel === undefined
        ? DEFAULT_OPENAI_BYOK_MODEL
        : validateModel(optionalModel)
  });
}
