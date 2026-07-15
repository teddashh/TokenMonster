import type { OpenAiByokModel } from "./constants.js";

export interface OpenAiByokRequest {
  readonly apiKey: string;
  readonly instructions: string;
  readonly input: string;
  readonly maxOutputTokens?: number;
  readonly model?: OpenAiByokModel;
}

export interface OpenAiByokResult {
  readonly text: string;
}

export interface OpenAiByokCallOptions {
  readonly signal?: AbortSignal;
}

export interface OpenAiFetchHeaders {
  get(name: string): string | null;
}

export interface OpenAiStreamReadResult {
  readonly done: boolean;
  readonly value?: Uint8Array;
}

export interface OpenAiStreamReader {
  read(): Promise<OpenAiStreamReadResult>;
  cancel?(reason?: unknown): Promise<void>;
}

export interface OpenAiResponseBody {
  getReader(): OpenAiStreamReader;
}

export interface OpenAiFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: OpenAiFetchHeaders;
  readonly body: OpenAiResponseBody | null;
  text(): Promise<string>;
}

export interface OpenAiFetchRequestInit {
  readonly method: "POST";
  readonly redirect: "error";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export type OpenAiFetch = (
  endpoint: typeof import("./constants.js").OPENAI_RESPONSES_ENDPOINT,
  init: OpenAiFetchRequestInit
) => Promise<OpenAiFetchResponse>;

export interface OpenAiByokAdapterOptions {
  readonly fetch?: OpenAiFetch;
  readonly timeoutMs?: number;
}

export interface OpenAiByokAdapter {
  respond(
    request: OpenAiByokRequest,
    options?: OpenAiByokCallOptions
  ): Promise<OpenAiByokResult>;
}
