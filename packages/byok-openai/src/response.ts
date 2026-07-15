import { Buffer } from "node:buffer";

import { MAX_OPENAI_RESPONSE_BYTES } from "./constants.js";
import { ByokOpenAiError } from "./errors.js";
import type {
  OpenAiFetchResponse,
  OpenAiStreamReader
} from "./types.js";

const ABORTED = Symbol("openai-response-read-aborted");
const MAX_OPENAI_RESPONSE_CHUNKS = 4_096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(ABORTED);
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        reject(new ByokOpenAiError("network-error"));
      }
    );
  });
}

function cancelReader(reader: OpenAiStreamReader): void {
  if (reader.cancel === undefined) {
    return;
  }
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best-effort and provider errors must stay sanitized.
  }
}

export function discardOpenAiResponseBody(
  response: OpenAiFetchResponse
): void {
  try {
    const body = response.body;
    if (body !== null) {
      cancelReader(body.getReader());
    }
  } catch {
    // Releasing a provider connection is best-effort and must not expose errors.
  }
}

async function readStreamBounded(
  reader: OpenAiStreamReader,
  signal: AbortSignal,
  deadlineMs: number
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let chunkCount = 0;

  try {
    while (true) {
      if (performance.now() >= deadlineMs) {
        throw new ByokOpenAiError("request-timeout");
      }
      const result = await abortable(reader.read(), signal);
      if (performance.now() >= deadlineMs) {
        throw new ByokOpenAiError("request-timeout");
      }
      if (result.done) {
        break;
      }
      if (
        !(result.value instanceof Uint8Array) ||
        result.value.byteLength === 0
      ) {
        throw new ByokOpenAiError("malformed-response");
      }
      chunkCount += 1;
      if (chunkCount > MAX_OPENAI_RESPONSE_CHUNKS) {
        throw new ByokOpenAiError("response-too-large");
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_OPENAI_RESPONSE_BYTES) {
        cancelReader(reader);
        throw new ByokOpenAiError("response-too-large");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    cancelReader(reader);
    throw error;
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    totalBytes
  ).toString("utf8");
}

function declaredContentLength(response: OpenAiFetchResponse): number | null {
  const rawLength = response.headers.get("content-length");
  if (rawLength === null || !/^\d+$/u.test(rawLength)) {
    return null;
  }
  const parsed = Number(rawLength);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export async function readOpenAiResponseBody(
  response: OpenAiFetchResponse,
  signal: AbortSignal,
  deadlineMs: number
): Promise<string> {
  const declaredLength = declaredContentLength(response);
  if (
    declaredLength !== null &&
    declaredLength > MAX_OPENAI_RESPONSE_BYTES
  ) {
    discardOpenAiResponseBody(response);
    throw new ByokOpenAiError("response-too-large");
  }

  const contentType = response.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    mediaType !== "application/json"
  ) {
    discardOpenAiResponseBody(response);
    throw new ByokOpenAiError("malformed-response");
  }

  if (response.body !== null) {
    return readStreamBounded(response.body.getReader(), signal, deadlineMs);
  }

  const text = await abortable(response.text(), signal);
  if (Buffer.byteLength(text, "utf8") > MAX_OPENAI_RESPONSE_BYTES) {
    throw new ByokOpenAiError("response-too-large");
  }
  return text;
}

export function extractCompletedAssistantText(rawBody: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw new ByokOpenAiError("malformed-response");
  }

  if (!isRecord(parsed)) {
    throw new ByokOpenAiError("malformed-response");
  }
  const responseStatus = ownValue(parsed, "status");
  if (typeof responseStatus !== "string") {
    throw new ByokOpenAiError("malformed-response");
  }
  if (responseStatus !== "completed") {
    throw new ByokOpenAiError("incomplete-response");
  }

  const output = ownValue(parsed, "output");
  if (!Array.isArray(output)) {
    throw new ByokOpenAiError("malformed-response");
  }
  if (output.length === 0) {
    throw new ByokOpenAiError("empty-response");
  }

  const textParts: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) {
      throw new ByokOpenAiError("malformed-response");
    }
    const itemType = ownValue(item, "type");
    if (itemType === "reasoning") {
      continue;
    }
    if (itemType !== "message") {
      throw new ByokOpenAiError("unsupported-response");
    }
    if (ownValue(item, "role") !== "assistant") {
      throw new ByokOpenAiError("unsupported-response");
    }
    const itemStatus = ownValue(item, "status");
    if (typeof itemStatus !== "string") {
      throw new ByokOpenAiError("malformed-response");
    }
    if (itemStatus !== "completed") {
      throw new ByokOpenAiError("incomplete-response");
    }

    const content = ownValue(item, "content");
    if (!Array.isArray(content)) {
      throw new ByokOpenAiError("malformed-response");
    }
    for (const part of content) {
      if (!isRecord(part)) {
        throw new ByokOpenAiError("malformed-response");
      }
      if (ownValue(part, "type") !== "output_text") {
        throw new ByokOpenAiError("unsupported-response");
      }
      const text = ownValue(part, "text");
      if (typeof text !== "string") {
        throw new ByokOpenAiError("malformed-response");
      }
      textParts.push(text);
    }
  }

  const text = textParts.join("");
  if (text.length === 0) {
    throw new ByokOpenAiError("empty-response");
  }
  return text;
}

export { ABORTED as OPENAI_RESPONSE_READ_ABORTED };
