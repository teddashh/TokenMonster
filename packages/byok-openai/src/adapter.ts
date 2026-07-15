import {
  DEFAULT_OPENAI_TIMEOUT_MS,
  MAX_OPENAI_TIMEOUT_MS,
  OPENAI_RESPONSES_ENDPOINT
} from "./constants.js";
import { ByokOpenAiError } from "./errors.js";
import {
  OPENAI_RESPONSE_READ_ABORTED,
  discardOpenAiResponseBody,
  extractCompletedAssistantText,
  readOpenAiResponseBody
} from "./response.js";
import type {
  OpenAiByokAdapter,
  OpenAiByokAdapterOptions,
  OpenAiByokCallOptions,
  OpenAiByokRequest,
  OpenAiByokResult,
  OpenAiFetch,
  OpenAiFetchRequestInit,
  OpenAiFetchResponse
} from "./types.js";
import { normalizeOpenAiByokRequest } from "./validation.js";

const FETCH_ABORTED = Symbol("openai-fetch-aborted");
const OPTION_KEYS = new Set<PropertyKey>(["fetch", "timeoutMs"]);
const CALL_OPTION_KEYS = new Set<PropertyKey>(["signal"]);

const nativeFetch: OpenAiFetch = async (endpoint, init) =>
  fetch(endpoint, {
    method: init.method,
    redirect: init.redirect,
    headers: init.headers,
    body: init.body,
    signal: init.signal
  });

function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function optionValue(
  options: Record<PropertyKey, unknown>,
  key: PropertyKey,
  invalidCode: "invalid-configuration" | "invalid-request" =
    "invalid-configuration"
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(options, key);
  if (descriptor === undefined) {
    return undefined;
  }
  if (!("value" in descriptor)) {
    throw new ByokOpenAiError(invalidCode);
  }
  return descriptor.value;
}

function normalizeOptions(options: OpenAiByokAdapterOptions): Readonly<{
  fetch: OpenAiFetch;
  timeoutMs: number;
}> {
  if (
    !isPlainRecord(options) ||
    Reflect.ownKeys(options).some((key) => !OPTION_KEYS.has(key))
  ) {
    throw new ByokOpenAiError("invalid-configuration");
  }
  const fetchOption = optionValue(options, "fetch");
  const timeoutOption = optionValue(options, "timeoutMs");
  if (fetchOption !== undefined && typeof fetchOption !== "function") {
    throw new ByokOpenAiError("invalid-configuration");
  }
  if (
    timeoutOption !== undefined &&
    (typeof timeoutOption !== "number" ||
      !Number.isInteger(timeoutOption) ||
      timeoutOption < 1 ||
      timeoutOption > MAX_OPENAI_TIMEOUT_MS)
  ) {
    throw new ByokOpenAiError("invalid-configuration");
  }
  return Object.freeze({
    fetch: (fetchOption as OpenAiFetch | undefined) ?? nativeFetch,
    timeoutMs: (timeoutOption as number | undefined) ?? DEFAULT_OPENAI_TIMEOUT_MS
  });
}

function normalizeCallOptions(options: OpenAiByokCallOptions): Readonly<{
  signal: AbortSignal | undefined;
}> {
  if (
    !isPlainRecord(options) ||
    Reflect.ownKeys(options).some((key) => !CALL_OPTION_KEYS.has(key))
  ) {
    throw new ByokOpenAiError("invalid-request");
  }
  const signal = optionValue(options, "signal", "invalid-request");
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new ByokOpenAiError("invalid-request");
  }
  return Object.freeze({ signal: signal as AbortSignal | undefined });
}

function abortableFetch(
  fetchImpl: OpenAiFetch,
  init: OpenAiFetchRequestInit,
  signal: AbortSignal
): Promise<OpenAiFetchResponse> {
  if (signal.aborted) {
    return Promise.reject(FETCH_ABORTED);
  }
  return new Promise<OpenAiFetchResponse>((resolve, reject) => {
    const onAbort = (): void => {
      reject(FETCH_ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    fetchImpl(OPENAI_RESPONSES_ENDPOINT, init).then(
      (response) => {
        signal.removeEventListener("abort", onAbort);
        resolve(response);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        reject(new ByokOpenAiError("network-error"));
      }
    );
  });
}

function errorForStatus(status: number): ByokOpenAiError {
  if (status === 401 || status === 403) {
    return new ByokOpenAiError("provider-authentication-failed");
  }
  if (status === 429) {
    return new ByokOpenAiError("provider-rate-limited");
  }
  if ([400, 404, 405, 409, 413, 415, 422].includes(status)) {
    return new ByokOpenAiError("provider-request-rejected");
  }
  if (status === 408 || status >= 500) {
    return new ByokOpenAiError("provider-unavailable");
  }
  return new ByokOpenAiError("provider-error");
}

function validateFetchResponse(response: OpenAiFetchResponse): Readonly<{
  ok: boolean;
  status: number;
}> {
  if (
    typeof response !== "object" ||
    response === null ||
    typeof response.ok !== "boolean" ||
    typeof response.status !== "number" ||
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    response.ok !== (response.status >= 200 && response.status <= 299) ||
    typeof response.headers?.get !== "function" ||
    typeof response.text !== "function"
  ) {
    throw new ByokOpenAiError("network-error");
  }
  return Object.freeze({ ok: response.ok, status: response.status });
}

async function respond(
  fetchImpl: OpenAiFetch,
  timeoutMs: number,
  request: OpenAiByokRequest,
  callOptions: OpenAiByokCallOptions
): Promise<OpenAiByokResult> {
  let normalized: ReturnType<typeof normalizeOpenAiByokRequest>;
  try {
    normalized = normalizeOpenAiByokRequest(request);
  } catch (error) {
    if (error instanceof ByokOpenAiError) {
      throw error;
    }
    throw new ByokOpenAiError("invalid-request");
  }
  let externalSignal: AbortSignal | undefined;
  try {
    externalSignal = normalizeCallOptions(callOptions).signal;
  } catch (error) {
    if (error instanceof ByokOpenAiError) {
      throw error;
    }
    throw new ByokOpenAiError("invalid-request");
  }
  if (externalSignal !== undefined && isSignalAborted(externalSignal)) {
    throw new ByokOpenAiError("request-aborted");
  }
  const body = JSON.stringify({
    model: normalized.model,
    instructions: normalized.instructions,
    input: normalized.input,
    max_output_tokens: normalized.maxOutputTokens,
    background: false,
    store: false
  });
  const controller = new AbortController();
  const deadlineMs = performance.now() + timeoutMs;
  let timedOut = false;
  let callerAborted = false;
  const onCallerAbort = (): void => {
    callerAborted = true;
    controller.abort();
  };
  externalSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (externalSignal !== undefined && isSignalAborted(externalSignal)) {
    onCallerAbort();
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();

  const init: OpenAiFetchRequestInit = Object.freeze({
    method: "POST",
    redirect: "error",
    headers: Object.freeze({
      Accept: "application/json",
      Authorization: "Bearer " + normalized.apiKey,
      "Content-Type": "application/json"
    }),
    body,
    signal: controller.signal
  });

  try {
    let response: OpenAiFetchResponse;
    try {
      response = await abortableFetch(fetchImpl, init, controller.signal);
    } catch (error) {
      if (timedOut) {
        throw new ByokOpenAiError("request-timeout");
      }
      if (callerAborted || error === FETCH_ABORTED) {
        throw new ByokOpenAiError("request-aborted");
      }
      throw new ByokOpenAiError("network-error");
    }
    if (timedOut || performance.now() >= deadlineMs) {
      discardOpenAiResponseBody(response);
      throw new ByokOpenAiError("request-timeout");
    }
    if (callerAborted) {
      throw new ByokOpenAiError("request-aborted");
    }

    let responseStatus: Readonly<{ ok: boolean; status: number }>;
    try {
      responseStatus = validateFetchResponse(response);
    } catch (error) {
      if (error instanceof ByokOpenAiError) {
        throw error;
      }
      throw new ByokOpenAiError("network-error");
    }
    if (!responseStatus.ok) {
      discardOpenAiResponseBody(response);
      throw errorForStatus(responseStatus.status);
    }

    let rawBody: string;
    try {
      rawBody = await readOpenAiResponseBody(
        response,
        controller.signal,
        deadlineMs
      );
    } catch (error) {
      if (timedOut) {
        throw new ByokOpenAiError("request-timeout");
      }
      if (callerAborted || error === OPENAI_RESPONSE_READ_ABORTED) {
        throw new ByokOpenAiError("request-aborted");
      }
      if (error instanceof ByokOpenAiError) {
        throw error;
      }
      throw new ByokOpenAiError("network-error");
    }
    if (timedOut || performance.now() >= deadlineMs) {
      throw new ByokOpenAiError("request-timeout");
    }
    if (callerAborted) {
      throw new ByokOpenAiError("request-aborted");
    }

    return Object.freeze({
      text: extractCompletedAssistantText(rawBody)
    });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onCallerAbort);
  }
}

export function createOpenAiByokAdapter(
  options: OpenAiByokAdapterOptions = {}
): OpenAiByokAdapter {
  let normalized: ReturnType<typeof normalizeOptions>;
  try {
    normalized = normalizeOptions(options);
  } catch (error) {
    if (error instanceof ByokOpenAiError) {
      throw error;
    }
    throw new ByokOpenAiError("invalid-configuration");
  }
  return Object.freeze({
    respond: (
      request: OpenAiByokRequest,
      callOptions: OpenAiByokCallOptions = {}
    ) => respond(normalized.fetch, normalized.timeoutMs, request, callOptions)
  });
}
