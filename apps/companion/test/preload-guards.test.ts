import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

interface PreloadGuards {
  validatedCharacterId(value: unknown): "chatgpt" | "claude" | "gemini" | "grok";
  fixedRequest(value: unknown): Readonly<{
    characterId: "chatgpt" | "claude" | "gemini" | "grok";
    trigger: "greeting" | "idle";
  }>;
  configureRequest(value: unknown): Readonly<{
    apiKey: string;
    persist: boolean;
  }>;
  chatRequest(value: unknown): Readonly<{
    characterId: "chatgpt" | "claude" | "gemini" | "grok";
    message: string;
  }>;
  collectorScanRequest(value: unknown): Readonly<{
    client: "claude" | "codex" | "gemini" | "grok";
    day: "today" | "previous";
  }>;
  usageInsightsRequest(value: unknown): Readonly<{
    windowDays: 7 | 28;
  }>;
  shareCardSaveRequest(value: unknown): Readonly<{
    windowDays: 7 | 28;
    characterId: "chatgpt" | "claude" | "gemini" | "grok";
  }>;
  localSourceResetRequest(value: unknown): Readonly<{
    confirmation: "clear-collector-derived-data";
  }>;
  contributionPreviewRequest(value: unknown): Readonly<{
    confirmation: "preview-content-blind-contribution";
  }>;
  contributionEnableRequest(value: unknown): Readonly<{
    confirmation: "enable-content-blind-contribution";
    previewId: string;
  }>;
  contributionSyncRequest(value: unknown): Readonly<{
    confirmation: "sync-content-blind-contribution";
  }>;
  contributionStopRequest(value: unknown): Readonly<{
    confirmation: "stop-content-blind-contribution";
  }>;
  contributionDeleteRequest(value: unknown): Readonly<{
    confirmation: "delete-identifiable-contribution-data";
  }>;
  contributionDeletionStatusRequest(value: unknown): Readonly<{
    confirmation: "check-contribution-deletion-status";
  }>;
  createInvokeGuard(
    invoke: (channel: string, argument?: unknown) => Promise<unknown>
  ): (channel: string, argument?: unknown) => Promise<unknown>;
}

const {
  chatRequest,
  collectorScanRequest,
  configureRequest,
  contributionDeleteRequest,
  contributionDeletionStatusRequest,
  contributionEnableRequest,
  contributionPreviewRequest,
  contributionStopRequest,
  contributionSyncRequest,
  createInvokeGuard,
  fixedRequest,
  localSourceResetRequest,
  shareCardSaveRequest,
  usageInsightsRequest,
  validatedCharacterId
} = createRequire(import.meta.url)(
  "../dist/main/preload/guards.cjs"
) as PreloadGuards;

const API_KEY = ["sk", "test_1234567890abcdef_PRELOAD_CANARY"].join("-");

describe("preload runtime guards", () => {
  it("copies only allowlisted primitive character and fixed-line values", () => {
    expect(validatedCharacterId("gemini")).toBe("gemini");
    expect(() => validatedCharacterId("unknown")).toThrow(
      "IPC_REQUEST_REJECTED"
    );
    const source = { characterId: "claude", trigger: "greeting" };
    const result = fixedRequest(source);
    expect(result).toEqual(source);
    expect(result).not.toBe(source);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => fixedRequest({ ...source, prompt: "PRIVATE" })).toThrow(
      "IPC_REQUEST_REJECTED"
    );
  });

  it("rejects accessors and hostile prototypes without invoking them", () => {
    const getter = vi.fn(() => "hidden");
    const accessor = Object.defineProperties(
      {},
      {
        characterId: { value: "chatgpt", enumerable: true },
        message: { get: getter, enumerable: true }
      }
    );
    expect(() => chatRequest(accessor)).toThrow("IPC_REQUEST_REJECTED");
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      chatRequest(
        Object.assign(Object.create({ inherited: true }) as object, {
          characterId: "chatgpt",
          message: "hello"
        })
      )
    ).toThrow("IPC_REQUEST_REJECTED");
  });

  it("enforces API key and UTF-8 byte caps before structured clone", () => {
    const configured = configureRequest({ apiKey: API_KEY, persist: false });
    expect(configured).toEqual({ apiKey: API_KEY, persist: false });
    expect(Object.isFrozen(configured)).toBe(true);
    expect(() => configureRequest({ apiKey: "invalid", persist: false })).toThrow(
      "IPC_REQUEST_REJECTED"
    );
    expect(() =>
      chatRequest({ characterId: "chatgpt", message: "界".repeat(1_400) })
    ).toThrow("IPC_REQUEST_REJECTED");
    expect(
      chatRequest({ characterId: "chatgpt", message: "安全訊息" })
    ).toEqual({ characterId: "chatgpt", message: "安全訊息" });
  });

  it("copies only an exact explicit collector client/day request", () => {
    expect(
      collectorScanRequest({ client: "codex", day: "today" })
    ).toEqual({ client: "codex", day: "today" });
    expect(
      collectorScanRequest({ client: "claude", day: "previous" })
    ).toEqual({ client: "claude", day: "previous" });
    expect(() =>
      collectorScanRequest({ client: "cursor", day: "today" })
    ).toThrow("IPC_REQUEST_REJECTED");
    expect(() =>
      collectorScanRequest({
        client: "codex",
        day: "today",
        configDir: "/private"
      })
    ).toThrow("IPC_REQUEST_REJECTED");
  });

  it("strictly bounds local insight, share-card, and reset controls", () => {
    expect(usageInsightsRequest({ windowDays: 7 })).toEqual({
      windowDays: 7
    });
    expect(
      shareCardSaveRequest({ windowDays: 28, characterId: "claude" })
    ).toEqual({ windowDays: 28, characterId: "claude" });
    expect(
      localSourceResetRequest({
        confirmation: "clear-collector-derived-data"
      })
    ).toEqual({ confirmation: "clear-collector-derived-data" });
    expect(() => usageInsightsRequest({ windowDays: 14 })).toThrow(
      "IPC_REQUEST_REJECTED"
    );
    expect(() =>
      shareCardSaveRequest({
        windowDays: 7,
        characterId: "chatgpt",
        path: "/private"
      })
    ).toThrow("IPC_REQUEST_REJECTED");
    expect(() =>
      localSourceResetRequest({ confirmation: "yes" })
    ).toThrow("IPC_REQUEST_REJECTED");
  });

  it("accepts only fixed contribution actions and an opaque preview UUID", () => {
    expect(
      contributionPreviewRequest({
        confirmation: "preview-content-blind-contribution"
      })
    ).toEqual({ confirmation: "preview-content-blind-contribution" });
    expect(
      contributionEnableRequest({
        confirmation: "enable-content-blind-contribution",
        previewId: "10000000-0000-4000-8000-000000000001"
      })
    ).toEqual({
      confirmation: "enable-content-blind-contribution",
      previewId: "10000000-0000-4000-8000-000000000001"
    });
    expect(
      contributionSyncRequest({
        confirmation: "sync-content-blind-contribution"
      })
    ).toEqual({ confirmation: "sync-content-blind-contribution" });
    expect(
      contributionStopRequest({
        confirmation: "stop-content-blind-contribution"
      })
    ).toEqual({ confirmation: "stop-content-blind-contribution" });
    expect(
      contributionDeleteRequest({
        confirmation: "delete-identifiable-contribution-data"
      })
    ).toEqual({ confirmation: "delete-identifiable-contribution-data" });
    expect(
      contributionDeletionStatusRequest({
        confirmation: "check-contribution-deletion-status"
      })
    ).toEqual({ confirmation: "check-contribution-deletion-status" });
    expect(() =>
      contributionEnableRequest({
        confirmation: "enable-content-blind-contribution",
        previewId: "PRIVATE_PATH",
        prompt: "PRIVATE"
      })
    ).toThrow("IPC_REQUEST_REJECTED");
    expect(() =>
      contributionDeleteRequest({ confirmation: "pause" })
    ).toThrow("IPC_REQUEST_REJECTED");
  });

  it("permits only one in-flight invocation per channel", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    const invoke = vi.fn(
      (_channel: string, _argument?: unknown) =>
        new Promise<unknown>((resolve) => {
          resolveFirst = resolve;
        })
    );
    const guarded = createInvokeGuard(invoke);
    const first = guarded("tokenmonster:byok-chat", { safe: true });
    await expect(
      guarded("tokenmonster:byok-chat", { safe: true })
    ).rejects.toThrow("IPC_REQUEST_BUSY");
    resolveFirst?.("done");
    await expect(first).resolves.toBe("done");

    const next = guarded("tokenmonster:byok-chat", { safe: true });
    resolveFirst?.("again");
    await expect(next).resolves.toBe("again");
  });
});
