import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  RENDERER_CSP,
  createIpcRequestGate,
  installSessionGuards,
  isTrustedIpcSender,
  isTrustedRendererUrl,
  resolveRendererAsset,
  secureWebPreferences,
  type GuardedSessionLike
} from "../src/main/security.js";
import { IPC_CHANNELS } from "../src/shared/ipc.js";

describe("companion renderer security boundary", () => {
  it.each([
    "tokenmonster://app/",
    "tokenmonster://app/index.html"
  ])("accepts only the two trusted document URLs: %s", (url) => {
    expect(isTrustedRendererUrl(url)).toBe(true);
  });

  it.each([
    "https://app/index.html",
    "http://app/index.html",
    "file:///index.html",
    "tokenmonster://evil/index.html",
    "tokenmonster://app/index.html?redirect=https://evil.test",
    "tokenmonster://app/index.html#frame",
    "tokenmonster://user:pass@app/index.html",
    "not a url"
  ])("rejects navigation to %s", (url) => {
    expect(isTrustedRendererUrl(url)).toBe(false);
  });

  it("maps allowlisted renderer text assets within the renderer root", () => {
    const root = resolve("/tmp/tokenmonster-renderer");
    expect(resolveRendererAsset(root, "tokenmonster://app/")).toEqual({
      path: resolve(root, "index.html"),
      contentType: "text/html; charset=UTF-8"
    });
    expect(
      resolveRendererAsset(root, "tokenmonster://app/assets/app-123.js")
    ).toEqual({
      path: resolve(root, "assets/app-123.js"),
      contentType: "text/javascript; charset=UTF-8"
    });
  });

  it.each([
    "tokenmonster://app/../secret.txt",
    "tokenmonster://app/%2e%2e/secret.js",
    "tokenmonster://app/assets%5csecret.js",
    "tokenmonster://app/avatar.webp",
    "tokenmonster://app/app.js?x=1",
    "tokenmonster://other/app.js"
  ])("fails closed for unsafe asset URL %s", (url) => {
    expect(resolveRendererAsset("/tmp/tokenmonster-renderer", url)).toBeNull();
  });

  it("ships a network- and media-denying CSP", () => {
    expect(RENDERER_CSP).toContain("connect-src 'none'");
    expect(RENDERER_CSP).toContain("img-src 'none'");
    expect(RENDERER_CSP).toContain("object-src 'none'");
    expect(RENDERER_CSP).toContain("script-src 'self'");
    expect(RENDERER_CSP).not.toContain("unsafe-eval");
    expect(RENDERER_CSP).not.toContain("unsafe-inline");
  });

  it("pins every security-relevant BrowserWindow preference", () => {
    expect(secureWebPreferences("/app/preload.cjs", false)).toEqual({
      preload: "/app/preload.cjs",
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
      spellcheck: false
    });
  });

  it("trusts only the exact main frame at the fixed app document", () => {
    const mainFrame = { url: "tokenmonster://app/index.html" };
    expect(
      isTrustedIpcSender({ sender: { mainFrame }, senderFrame: mainFrame })
    ).toBe(true);
    expect(
      isTrustedIpcSender({
        sender: { mainFrame },
        senderFrame: { url: mainFrame.url }
      })
    ).toBe(false);
    expect(
      isTrustedIpcSender({
        sender: { mainFrame },
        senderFrame: { url: "tokenmonster://evil/index.html" }
      })
    ).toBe(false);
  });

  it("denies permissions and cancels every download", () => {
    let permissionCheck: (() => boolean) | undefined;
    let permissionRequest:
      | ((webContents: unknown, permission: unknown, callback: (allowed: boolean) => void) => void)
      | undefined;
    let download:
      | ((event: { preventDefault(): void }, item: { cancel(): void }) => void)
      | undefined;
    const guardedSession: GuardedSessionLike = {
      setPermissionCheckHandler: (handler) => {
        permissionCheck = handler;
      },
      setPermissionRequestHandler: (handler) => {
        permissionRequest = handler;
      },
      on: (_event, listener) => {
        download = listener;
      }
    };
    installSessionGuards(guardedSession);

    expect(permissionCheck?.()).toBe(false);
    let allowed = true;
    permissionRequest?.({}, "camera", (result) => {
      allowed = result;
    });
    expect(allowed).toBe(false);
    const preventDefault = vi.fn();
    const cancel = vi.fn();
    download?.({ preventDefault }, { cancel });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("limits per-sender IPC concurrency, rate, and unknown channels", () => {
    let now = 100_000;
    const gate = createIpcRequestGate(() => now);
    const sender = {};
    const release = gate.enter(sender, IPC_CHANNELS.byokChat);
    expect(() => gate.enter(sender, IPC_CHANNELS.byokChat)).toThrow(
      "IPC_REQUEST_BUSY"
    );
    release();
    for (let index = 1; index < 20; index += 1) {
      gate.enter(sender, IPC_CHANNELS.byokChat)();
    }
    expect(() => gate.enter(sender, IPC_CHANNELS.byokChat)).toThrow(
      "IPC_RATE_LIMITED"
    );
    now += 60_001;
    expect(() => gate.enter(sender, IPC_CHANNELS.byokChat)()).not.toThrow();

    const releaseScan = gate.enter(sender, IPC_CHANNELS.scanUsage);
    expect(() => gate.enter(sender, IPC_CHANNELS.scanUsage)).toThrow(
      "IPC_REQUEST_BUSY"
    );
    releaseScan();
    for (let index = 1; index < 10; index += 1) {
      gate.enter(sender, IPC_CHANNELS.scanUsage)();
    }
    expect(() => gate.enter(sender, IPC_CHANNELS.scanUsage)).toThrow(
      "IPC_RATE_LIMITED"
    );
    for (let index = 0; index < 3; index += 1) {
      gate.enter(sender, IPC_CHANNELS.resetLocalSourceData)();
    }
    expect(() =>
      gate.enter(sender, IPC_CHANNELS.resetLocalSourceData)
    ).toThrow("IPC_RATE_LIMITED");
    const localActionSender = {};
    for (const channel of [
      IPC_CHANNELS.usageInsights,
      IPC_CHANNELS.saveShareCard,
      IPC_CHANNELS.exportLocalData,
      IPC_CHANNELS.exportSupportDiagnostic,
      IPC_CHANNELS.contributionStatus,
      IPC_CHANNELS.contributionPreview,
      IPC_CHANNELS.contributionEnable,
      IPC_CHANNELS.contributionSync,
      IPC_CHANNELS.contributionStop,
      IPC_CHANNELS.contributionDelete,
      IPC_CHANNELS.contributionDeletionStatus
    ]) {
      expect(() => gate.enter(localActionSender, channel)()).not.toThrow();
    }
    expect(() => gate.enter(sender, "tokenmonster:unknown")).toThrow(
      "IPC_REQUEST_REJECTED"
    );
  });
});
