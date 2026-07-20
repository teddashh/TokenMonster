import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  PINNED_TOKEN_TRACKER_VERSION,
  TokenTrackerRuntimeError,
  buildTokenTrackerEnvironment,
  resolveTokenTrackerExecutable,
  startManagedTokenTracker,
  type TokenTrackerRuntimeScheduler,
  type TokenTrackerSpawn,
  type TokenTrackerSpawnOptions
} from "../src/index.js";

const PUBLIC_BIN = "/package/bin/tracker.js";
const PATH_CANARY = "/private/path/PATH_CANARY_must_not_escape";
const ERROR_CANARY = "ERROR_CANARY_must_not_escape";

class FakeChild extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public readonly killCalls: NodeJS.Signals[] = [];
  public onSpawn: (() => void) | undefined;
  public killBehavior: (signal: NodeJS.Signals) => void = (signal) => {
    queueMicrotask(() => this.emitExit(null, signal));
  };

  public emitExit(
    code: number | null,
    signal: NodeJS.Signals | null = null
  ): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  public kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killCalls.push(signal);
    this.killBehavior(signal);
    return true;
  }

  public asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

interface SpawnCall {
  readonly command: string;
  readonly arguments_: readonly string[];
  readonly options: TokenTrackerSpawnOptions;
  readonly child: FakeChild;
}

function successfulVersionChild(
  version: string = PINNED_TOKEN_TRACKER_VERSION
): FakeChild {
  const child = new FakeChild();
  child.onSpawn = () => {
    child.stdout.end(`v${version}\n`);
    child.stderr.end();
    child.emitExit(0);
  };
  return child;
}

function announcedServerChild(
  chunks: readonly string[] = [
    "TokenTracker ready at http://127.0.0.1:7680\n",
    `Data: ${PATH_CANARY}\n`
  ]
): FakeChild {
  const child = new FakeChild();
  child.onSpawn = () => {
    for (const chunk of chunks) child.stdout.write(chunk);
  };
  return child;
}

function exitingRefreshChild(code = 0): FakeChild {
  const child = new FakeChild();
  child.onSpawn = () => child.emitExit(code);
  return child;
}

function queuedSpawn(children: readonly FakeChild[]): Readonly<{
  spawn: TokenTrackerSpawn;
  calls: SpawnCall[];
}> {
  const queue = [...children];
  const calls: SpawnCall[] = [];
  const spawn: TokenTrackerSpawn = (command, arguments_, options) => {
    const child = queue.shift();
    if (child === undefined) throw new Error("Unexpected spawn");
    calls.push({ command, arguments_: [...arguments_], options, child });
    queueMicrotask(() => child.onSpawn?.());
    return child.asChildProcess();
  };
  return Object.freeze({ spawn, calls });
}

class ManualScheduler implements TokenTrackerRuntimeScheduler {
  public readonly immediateCallbacks = new Map<NodeJS.Immediate, () => void>();
  public readonly intervalCallbacks = new Map<NodeJS.Timeout, () => void>();

  public setInterval(callback: () => void, delayMs: number): NodeJS.Timeout {
    const timer = setInterval(() => undefined, delayMs);
    timer.unref();
    this.intervalCallbacks.set(timer, callback);
    return timer;
  }

  public clearInterval(timer: NodeJS.Timeout): void {
    clearInterval(timer);
    this.intervalCallbacks.delete(timer);
  }

  public setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  }

  public clearTimeout(timer: NodeJS.Timeout): void {
    clearTimeout(timer);
  }

  public setImmediate(callback: () => void): NodeJS.Immediate {
    const immediate = setImmediate(() => undefined);
    clearImmediate(immediate);
    this.immediateCallbacks.set(immediate, callback);
    return immediate;
  }

  public clearImmediate(immediate: NodeJS.Immediate): void {
    clearImmediate(immediate);
    this.immediateCallbacks.delete(immediate);
  }

  public runInitialRefresh(): void {
    const callbacks = [...this.immediateCallbacks.values()];
    this.immediateCallbacks.clear();
    for (const callback of callbacks) callback();
  }

  public runIntervals(): void {
    for (const callback of this.intervalCallbacks.values()) callback();
  }
}

function executable() {
  return Object.freeze({
    command: "/node",
    argumentPrefix: Object.freeze([PUBLIC_BIN])
  });
}

describe("managed environment", () => {
  it("denies command discovery while dropping credentials, proxies, and port authority", () => {
    const environment = buildTokenTrackerEnvironment({
      HOME: "/home/person",
      CODEX_HOME: "/custom/codex",
      APPDATA: "C:\\Users\\person\\AppData",
      PATH: PATH_CANARY,
      PATHEXT: ".EXE;.CMD",
      HTTP_PROXY: "http://proxy.invalid",
      HTTPS_PROXY: "https://proxy.invalid",
      NODE_OPTIONS: `--require=${PATH_CANARY}`,
      OPENAI_API_KEY: "secret",
      OPENCODE_GO_AUTH_COOKIE: "secret-cookie",
      ZCODE_CREDENTIAL_SECRET: "secret-zcode",
      TOKENTRACKER_DEVICE_TOKEN: "secret-device",
      PORT: "4321"
    });

    expect(environment).toMatchObject({
      HOME: "/home/person",
      CODEX_HOME: "/custom/codex",
      APPDATA: "C:\\Users\\person\\AppData",
      TOKENTRACKER_NO_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
      TOKENTRACKER_SKIP_FIRST_SYNC: "1",
      TOKENTRACKER_AUTO_RETRY_NO_SPAWN: "1",
      TOKENTRACKER_NO_STAR_PROMPT: "1"
    });
    expect(environment).not.toHaveProperty("HTTP_PROXY");
    expect(environment).not.toHaveProperty("HTTPS_PROXY");
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("OPENCODE_GO_AUTH_COOKIE");
    expect(environment).not.toHaveProperty("ZCODE_CREDENTIAL_SECRET");
    expect(environment).not.toHaveProperty("TOKENTRACKER_DEVICE_TOKEN");
    expect(environment).not.toHaveProperty("PORT");
    expect(environment["PATH"]).toMatch(/network-deny\.cjs$/u);
    expect(environment["PATH"]).not.toContain(PATH_CANARY);
    expect(environment).not.toHaveProperty("PATHEXT");
    expect(Object.isFrozen(environment)).toBe(true);
  });

  it("keeps the manifest and compatibility target on one exact version", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8")
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies?.["tokentracker-cli"]).toBe(
      PINNED_TOKEN_TRACKER_VERSION
    );
    expect(PINNED_TOKEN_TRACKER_VERSION).toBe("0.80.0");
  });

  it("keeps the packaged sidecar manifest on the runtime pin", async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL(
          "../../../apps/companion/packaging/runtime-bundle-manifest.json",
          import.meta.url
        ),
        "utf8"
      )
    ) as { sidecar?: { package?: string; version?: string } };
    expect(manifest.sidecar?.package).toBe("tokentracker-cli");
    expect(manifest.sidecar?.version).toBe(PINNED_TOKEN_TRACKER_VERSION);
  });
});

describe("managed sidecar lifecycle", () => {
  it("uses the public bin, safe serve argv, exact version handshake, and injected probe", async () => {
    const scheduler = new ManualScheduler();
    const main = announcedServerChild();
    const processQueue = queuedSpawn([successfulVersionChild(), main]);
    const probe = vi.fn(
      async (_baseUrl: string, _signal: AbortSignal): Promise<void> => undefined
    );

    const runtime = await startManagedTokenTracker({
      readinessProbe: probe,
      spawn: processQueue.spawn,
      resolveExecutable: executable,
      refreshIntervalMs: false,
      scheduler,
      sourceEnvironment: { HOME: "/home/person", PORT: "9999" }
    });

    expect(runtime.baseUrl).toBe("http://127.0.0.1:7680");
    expect(runtime.version).toBe("0.80.0");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0]).toBe("http://127.0.0.1:7680");
    expect(processQueue.calls.map((call) => call.arguments_)).toEqual([
      [
        "--require",
        expect.stringMatching(/network-deny\.cjs$/u),
        PUBLIC_BIN,
        "--version"
      ],
      [
        "--require",
        expect.stringMatching(/network-deny\.cjs$/u),
        PUBLIC_BIN,
        "serve",
        "--no-open",
        "--no-sync"
      ]
    ]);
    for (const call of processQueue.calls) {
      expect(call.command).toBe("/node");
      expect(call.options).toMatchObject({
        shell: false,
        detached: false,
        windowsHide: true
      });
      expect(call.options.env).not.toHaveProperty("PORT");
      expect(call.options.env).not.toHaveProperty("TOKENTRACKER_DEVICE_TOKEN");
      expect(call.options.env["NODE_OPTIONS"]).toMatch(
        /^--require=".*network-deny\.cjs"$/u
      );
      expect(call.options.env["NODE_OPTIONS"]).not.toContain(PATH_CANARY);
      expect(call.options.env["PATH"]).toMatch(/network-deny\.cjs$/u);
      expect(call.options.env["PATH"]).not.toContain(PATH_CANARY);
      expect(call.options.env).not.toHaveProperty("PATHEXT");
    }

    const firstStop = runtime.stop();
    const secondStop = runtime.stop();
    expect(secondStop).toBe(firstStop);
    await firstStop;
    expect(main.killCalls).toEqual(["SIGTERM"]);
    await expect(runtime.closed).resolves.toMatchObject({ expected: true });
  });

  it("recognizes a canonical loopback URL split across chunks and exposes no child output", async () => {
    const scheduler = new ManualScheduler();
    const main = announcedServerChild([
      `setup ${PATH_CANARY}\nhttp://127.0.`,
      "0.1:76",
      "81\n"
    ]);
    const processQueue = queuedSpawn([successfulVersionChild(), main]);

    const runtime = await startManagedTokenTracker({
      readinessProbe: async () => undefined,
      spawn: processQueue.spawn,
      resolveExecutable: executable,
      refreshIntervalMs: false,
      scheduler
    });

    expect(runtime.baseUrl).toBe("http://127.0.0.1:7681");
    expect(JSON.stringify(runtime)).not.toContain(PATH_CANARY);
    await runtime.stop();
  });

  it("fails closed on a version mismatch without starting the server", async () => {
    const processQueue = queuedSpawn([successfulVersionChild("0.81.0")]);

    await expect(
      startManagedTokenTracker({
        readinessProbe: async () => undefined,
        spawn: processQueue.spawn,
        resolveExecutable: executable,
        refreshIntervalMs: false
      })
    ).rejects.toMatchObject({ code: "version-mismatch" });
    expect(processQueue.calls).toHaveLength(1);
  });

  it("sanitizes incompatible probe failures and stops only its managed child", async () => {
    const main = announcedServerChild();
    const unrelated = new FakeChild();
    const processQueue = queuedSpawn([successfulVersionChild(), main]);

    await expect(
      startManagedTokenTracker({
        readinessProbe: async () => {
          throw Object.assign(new Error(ERROR_CANARY), {
            code: "incompatible-schema"
          });
        },
        spawn: processQueue.spawn,
        resolveExecutable: executable,
        refreshIntervalMs: false,
        shutdownTimeoutMs: 10
      })
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TokenTrackerRuntimeError);
      expect(error).toMatchObject({ code: "sidecar-incompatible" });
      expect(JSON.stringify(error)).not.toContain(ERROR_CANARY);
      return true;
    });
    expect(main.killCalls).toEqual(["SIGTERM"]);
    expect(unrelated.killCalls).toEqual([]);
  });

  it("bounds startup and escalates signals only against the owned child", async () => {
    const main = new FakeChild();
    main.killBehavior = (signal) => {
      if (signal === "SIGKILL") {
        queueMicrotask(() => main.emitExit(null, "SIGKILL"));
      }
    };
    const unrelated = new FakeChild();
    const processQueue = queuedSpawn([successfulVersionChild(), main]);

    await expect(
      startManagedTokenTracker({
        readinessProbe: async () => undefined,
        spawn: processQueue.spawn,
        resolveExecutable: executable,
        startupTimeoutMs: 2,
        shutdownTimeoutMs: 2,
        refreshIntervalMs: false
      })
    ).rejects.toMatchObject({ code: "startup-timeout" });
    expect(main.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    expect(unrelated.killCalls).toEqual([]);
  });
});

describe("local-only refresh", () => {
  it("is single-flight and uses only the reviewed no-upload argv", async () => {
    const scheduler = new ManualScheduler();
    const main = announcedServerChild();
    const refresh = new FakeChild();
    const processQueue = queuedSpawn([
      successfulVersionChild(),
      main,
      refresh
    ]);
    const runtime = await startManagedTokenTracker({
      readinessProbe: async () => undefined,
      spawn: processQueue.spawn,
      resolveExecutable: executable,
      refreshIntervalMs: false,
      scheduler
    });

    const first = runtime.refreshLocalUsage();
    const second = runtime.refreshLocalUsage();
    expect(second).toBe(first);
    expect(processQueue.calls[2]?.arguments_).toEqual([
      "--require",
      expect.stringMatching(/network-deny\.cjs$/u),
      PUBLIC_BIN,
      "sync",
      "--auto",
      "--background",
      "--all-local-sources"
    ]);
    expect(processQueue.calls[2]?.options.stdio).toBe("ignore");
    refresh.emitExit(0);
    await first;
    await runtime.stop();
  });

  it("maps refresh output and failures to a fixed error", async () => {
    const scheduler = new ManualScheduler();
    const main = announcedServerChild();
    const processQueue = queuedSpawn([
      successfulVersionChild(),
      main,
      exitingRefreshChild(3)
    ]);
    const runtime = await startManagedTokenTracker({
      readinessProbe: async () => undefined,
      spawn: processQueue.spawn,
      resolveExecutable: executable,
      refreshIntervalMs: false,
      scheduler
    });

    await expect(runtime.refreshLocalUsage()).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toMatchObject({ code: "refresh-failed" });
        expect(JSON.stringify(error)).not.toContain(ERROR_CANARY);
        return true;
      }
    );
    await runtime.stop();
  });

  it("records an asynchronously scheduled initial-refresh failure", async () => {
    const scheduler = new ManualScheduler();
    const main = announcedServerChild();
    const processQueue = queuedSpawn([
      successfulVersionChild(),
      main,
      exitingRefreshChild(2)
    ]);
    const runtime = await startManagedTokenTracker({
      readinessProbe: async () => undefined,
      spawn: processQueue.spawn,
      resolveExecutable: executable,
      refreshIntervalMs: false,
      scheduler
    });

    scheduler.runInitialRefresh();
    await vi.waitFor(() =>
      expect(runtime.getStatus()).toMatchObject({
        phase: "refresh-failed",
        lastSuccessAt: null,
        consecutiveFailures: 1,
        canRetry: true
      })
    );
    await runtime.stop();
  });

  it("reports syncing before the first refresh, then failure, recovery, and stale state", async () => {
    const scheduler = new ManualScheduler();
    const main = announcedServerChild();
    const processQueue = queuedSpawn([
      successfulVersionChild(),
      main,
      exitingRefreshChild(3),
      exitingRefreshChild(0),
      exitingRefreshChild(4)
    ]);
    let now = new Date("2026-07-15T12:00:00.000Z");
    const runtime = await startManagedTokenTracker({
      readinessProbe: async () => undefined,
      dataAvailabilityProbe: async () => true,
      clock: () => now,
      spawn: processQueue.spawn,
      resolveExecutable: executable,
      refreshIntervalMs: false,
      scheduler
    });

    expect(runtime.getStatus()).toEqual({
      phase: "syncing",
      lastSuccessAt: null,
      consecutiveFailures: 0,
      canRetry: false
    });
    await expect(runtime.refreshLocalUsage()).rejects.toMatchObject({
      code: "refresh-failed"
    });
    expect(runtime.getStatus()).toMatchObject({
      phase: "refresh-failed",
      lastSuccessAt: null,
      consecutiveFailures: 1,
      canRetry: true
    });

    now = new Date("2026-07-15T12:00:05.000Z");
    await runtime.refreshLocalUsage();
    expect(runtime.getStatus()).toEqual({
      phase: "ready",
      lastSuccessAt: "2026-07-15T12:00:05.000Z",
      consecutiveFailures: 0,
      canRetry: true
    });

    now = new Date("2026-07-15T12:00:10.000Z");
    await expect(runtime.refreshLocalUsage()).rejects.toMatchObject({
      code: "refresh-failed"
    });
    expect(runtime.getStatus()).toEqual({
      phase: "stale",
      lastSuccessAt: "2026-07-15T12:00:05.000Z",
      consecutiveFailures: 1,
      canRetry: true
    });
    await runtime.stop();
  });

  it("marks a successful zero-data probe as ready-no-data", async () => {
    const scheduler = new ManualScheduler();
    const main = announcedServerChild();
    const processQueue = queuedSpawn([
      successfulVersionChild(),
      main,
      exitingRefreshChild(0)
    ]);
    const runtime = await startManagedTokenTracker({
      readinessProbe: async () => undefined,
      dataAvailabilityProbe: async () => false,
      clock: () => new Date("2026-07-15T12:00:00.000Z"),
      spawn: processQueue.spawn,
      resolveExecutable: executable,
      refreshIntervalMs: false,
      scheduler
    });

    await runtime.refreshLocalUsage();
    expect(runtime.getStatus()).toEqual({
      phase: "ready-no-data",
      lastSuccessAt: "2026-07-15T12:00:00.000Z",
      consecutiveFailures: 0,
      canRetry: true
    });
    await runtime.stop();
  });

  it("deduplicates requested refreshes and delays a retrigger until five seconds", async () => {
    const scheduler = new ManualScheduler();
    const main = announcedServerChild();
    const firstRefresh = new FakeChild();
    const processQueue = queuedSpawn([
      successfulVersionChild(),
      main,
      firstRefresh,
      exitingRefreshChild(0)
    ]);
    let now = new Date("2026-07-15T12:00:00.000Z");
    const runtime = await startManagedTokenTracker({
      readinessProbe: async () => undefined,
      clock: () => now,
      spawn: processQueue.spawn,
      resolveExecutable: executable,
      refreshIntervalMs: false,
      scheduler
    });

    const first = runtime.requestRefresh();
    const duplicate = runtime.requestRefresh();
    expect(processQueue.calls).toHaveLength(3);
    firstRefresh.emitExit(0);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      expect.objectContaining({ phase: "ready" }),
      expect.objectContaining({ phase: "ready" })
    ]);

    now = new Date("2026-07-15T12:00:04.999Z");
    const retrigger = runtime.requestRefresh();
    expect(processQueue.calls).toHaveLength(3);
    await expect(retrigger).resolves.toMatchObject({ phase: "ready" });
    expect(processQueue.calls).toHaveLength(4);
    await runtime.stop();
  });

  it("runs an immediate refresh, keeps periodic work single-flight, and cancels it on stop", async () => {
    const scheduler = new ManualScheduler();
    const main = announcedServerChild();
    const refresh = new FakeChild();
    const processQueue = queuedSpawn([
      successfulVersionChild(),
      main,
      refresh
    ]);
    const runtime = await startManagedTokenTracker({
      readinessProbe: async () => undefined,
      spawn: processQueue.spawn,
      resolveExecutable: executable,
      refreshIntervalMs: 10_000,
      scheduler
    });

    expect(processQueue.calls).toHaveLength(2);
    scheduler.runInitialRefresh();
    scheduler.runIntervals();
    expect(processQueue.calls).toHaveLength(3);
    refresh.emitExit(0);
    await vi.waitFor(() => expect(scheduler.intervalCallbacks.size).toBe(1));
    await runtime.stop();
    expect(scheduler.intervalCallbacks.size).toBe(0);
    expect(scheduler.immediateCallbacks.size).toBe(0);
  });
});

describe("public runtime resolution", () => {
  it("resolves the exact dependency's declared public bin", async () => {
    const resolved = await resolveTokenTrackerExecutable();
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.argumentPrefix).toHaveLength(1);
    expect(resolved.argumentPrefix[0]).toMatch(/bin[/\\]tracker\.js$/u);
  });
});
