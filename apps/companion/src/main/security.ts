import { extname, normalize, resolve, sep } from "node:path";

import type { BrowserWindowConstructorOptions } from "electron";

import { IPC_CHANNELS } from "../shared/ipc.js";

const RENDERER_PATHS = new Set(["/", "/index.html"]);
const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=UTF-8",
  ".html": "text/html; charset=UTF-8",
  ".js": "text/javascript; charset=UTF-8",
  ".json": "application/json; charset=UTF-8"
});

const IPC_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  [IPC_CHANNELS.bootstrap]: 60,
  [IPC_CHANNELS.usageInsights]: 60,
  [IPC_CHANNELS.selectCharacter]: 60,
  [IPC_CHANNELS.fixedInteraction]: 60,
  [IPC_CHANNELS.configureByok]: 10,
  [IPC_CHANNELS.clearByok]: 10,
  [IPC_CHANNELS.byokChat]: 20,
  [IPC_CHANNELS.scanUsage]: 10,
  [IPC_CHANNELS.saveShareCard]: 5,
  [IPC_CHANNELS.exportLocalData]: 5,
  [IPC_CHANNELS.exportSupportDiagnostic]: 5,
  [IPC_CHANNELS.resetLocalSourceData]: 3,
  [IPC_CHANNELS.contributionStatus]: 60,
  [IPC_CHANNELS.contributionPreview]: 10,
  [IPC_CHANNELS.contributionEnable]: 5,
  [IPC_CHANNELS.contributionSync]: 20,
  [IPC_CHANNELS.contributionStop]: 10,
  [IPC_CHANNELS.contributionDelete]: 5,
  [IPC_CHANNELS.contributionDeletionStatus]: 20
});

function isAppAuthority(url: URL): boolean {
  return (
    url.protocol === "tokenmonster:" &&
    url.hostname === "app" &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

export const RENDERER_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'"
].join("; ");

export type SecureWebPreferences = NonNullable<
  BrowserWindowConstructorOptions["webPreferences"]
>;

export function secureWebPreferences(
  preloadPath: string,
  developmentTools: boolean
): SecureWebPreferences {
  return Object.freeze({
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: false,
    devTools: developmentTools
  });
}

export interface IpcSenderLike {
  readonly mainFrame: unknown;
}

export interface IpcEventLike {
  readonly sender: IpcSenderLike;
  readonly senderFrame: Readonly<{ url: string }> | null;
}

export function isTrustedIpcSender(event: IpcEventLike): boolean {
  const frame = event.senderFrame;
  return (
    frame !== null &&
    frame === event.sender.mainFrame &&
    isTrustedRendererUrl(frame.url)
  );
}

export interface GuardedSessionLike {
  setPermissionCheckHandler(handler: () => boolean): void;
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: unknown,
      callback: (allowed: boolean) => void
    ) => void
  ): void;
  on(
    event: "will-download",
    listener: (
      event: Readonly<{ preventDefault(): void }>,
      item: Readonly<{ cancel(): void }>
    ) => void
  ): unknown;
}

export function installSessionGuards(guardedSession: GuardedSessionLike): void {
  guardedSession.setPermissionCheckHandler(() => false);
  guardedSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  );
  guardedSession.on("will-download", (event, item) => {
    event.preventDefault();
    try {
      item.cancel();
    } catch {
      // preventDefault is authoritative; item cancellation is defense in depth.
    }
  });
}

export interface IpcRequestGate {
  enter(sender: object, channel: string): () => void;
}

export function createIpcRequestGate(
  now: () => number = Date.now
): IpcRequestGate {
  type SenderState = {
    readonly requestTimes: Map<string, number[]>;
    readonly activeChannels: Set<string>;
  };
  const states = new WeakMap<object, SenderState>();
  return Object.freeze({
    enter(sender: object, channel: string): () => void {
      const limit = IPC_LIMITS[channel];
      if (limit === undefined) throw new Error("IPC_REQUEST_REJECTED");
      const at = now();
      if (!Number.isFinite(at)) throw new Error("IPC_REQUEST_REJECTED");
      const state = states.get(sender) ?? {
        requestTimes: new Map<string, number[]>(),
        activeChannels: new Set<string>()
      };
      states.set(sender, state);
      if (state.activeChannels.has(channel)) {
        throw new Error("IPC_REQUEST_BUSY");
      }
      const recent = (state.requestTimes.get(channel) ?? []).filter(
        (timestamp) => timestamp > at - 60_000
      );
      if (recent.length >= limit) throw new Error("IPC_RATE_LIMITED");
      recent.push(at);
      state.requestTimes.set(channel, recent);
      state.activeChannels.add(channel);
      let released = false;
      return () => {
        if (!released) {
          released = true;
          state.activeChannels.delete(channel);
        }
      };
    }
  });
}

export function isTrustedRendererUrl(input: string): boolean {
  if (
    /%(?:2e|2f|5c)/iu.test(input) ||
    input.includes("/../") ||
    input.includes("/./")
  ) {
    return false;
  }
  try {
    const url = new URL(input);
    return (
      isAppAuthority(url) &&
      url.search === "" &&
      url.hash === "" &&
      RENDERER_PATHS.has(url.pathname)
    );
  } catch {
    return false;
  }
}

export function resolveRendererAsset(
  rendererRoot: string,
  requestUrl: string
): Readonly<{ path: string; contentType: string }> | null {
  if (
    /%(?:2e|2f|5c)/iu.test(requestUrl) ||
    requestUrl.includes("/../") ||
    requestUrl.includes("/./")
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (
    !isAppAuthority(url) ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
  if (
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    return null;
  }

  const root = resolve(rendererRoot);
  const candidate = resolve(root, normalize(relativePath));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return null;
  }
  const contentType = CONTENT_TYPES[extname(candidate).toLowerCase()];
  if (contentType === undefined) {
    return null;
  }
  return Object.freeze({ path: candidate, contentType });
}
