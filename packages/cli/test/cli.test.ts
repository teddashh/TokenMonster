import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import type {
  CompanionGateway,
  CompanionGatewayOptions,
  CompanionContributionController,
} from "@tokenmonster/companion-gateway";
import type { ContributionCredentialHost } from "@tokenmonster/contribution-runtime";
import {
  SUPPORTED_TOKEN_TRACKER_VERSION,
  type TokenTrackerAdapter,
  type TokenTrackerAdapterOptions,
} from "@tokenmonster/token-tracker-adapter";
import {
  PINNED_TOKEN_TRACKER_VERSION,
  TokenMonsterRuntimeLeaseError,
  type ManagedTokenTracker,
  type ManagedTokenTrackerExit,
  type StartManagedTokenTrackerOptions,
} from "@tokenmonster/token-tracker-runtime";

import {
  DEFAULT_CHARACTER_CDN_BASE_URL,
  TOKENMONSTER_CLI_VERSION,
  openTokenMonsterBrowser,
  runTokenMonster,
  type TokenMonsterCliDependencies,
} from "../src/index.js";

const BOOTSTRAP_URL =
  "http://127.0.0.1:34567/__tokenmonster/bootstrap/abcdefghijklmnopqrstuvwxyzABCDEFGH";
const ERROR_CANARY = "ERROR_CANARY_must_not_escape";

class CapturedOutput {
  public value = "";

  public write(chunk: string): boolean {
    this.value += chunk;
    return true;
  }
}

function fakeAdapter(): TokenTrackerAdapter {
  return Object.freeze({
    probe: vi.fn(async () =>
      Object.freeze({
        reachable: true as const,
        schemaCompatible: true as const,
        compatibilityTarget: SUPPORTED_TOKEN_TRACKER_VERSION,
      }),
    ),
    getSummary: vi.fn(async () => {
      throw new Error("unused");
    }),
    getDaily: vi.fn(async () => {
      throw new Error("unused");
    }),
    getProviderTotals: vi.fn(async () => {
      throw new Error("unused");
    }),
    getProgressionFamilyTotals: vi.fn(async () => {
      throw new Error("unused");
    }),
    getDailyFamilySeries: vi.fn(async () => {
      throw new Error("unused");
    }),
    getDailyContentBlindFootprint: vi.fn(async () => {
      throw new Error("unused");
    }),
    getModelUsage: vi.fn(async () => {
      throw new Error("unused");
    }),
  });
}

function fakeRuntime(): ManagedTokenTracker & {
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  const stop = vi.fn(async (): Promise<void> => undefined);
  const status = Object.freeze({
    phase: "ready" as const,
    lastSuccessAt: "2026-01-01T00:00:00.000Z",
    consecutiveFailures: 0,
    canRetry: true,
  });
  return Object.freeze({
    baseUrl: "http://127.0.0.1:7681",
    version: PINNED_TOKEN_TRACKER_VERSION,
    closed: new Promise<ManagedTokenTrackerExit>(() => undefined),
    getStatus: vi.fn(() => status),
    requestRefresh: vi.fn(async () => status),
    refreshLocalUsage: vi.fn(async () => undefined),
    stop,
  });
}

function fakeGateway(): CompanionGateway & {
  start: ReturnType<
    typeof vi.fn<
      () => Promise<{
        host: "127.0.0.1";
        port: number;
        origin: string;
        bootstrapUrl: string;
      }>
    >
  >;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  const start = vi.fn(async () =>
    Object.freeze({
      host: "127.0.0.1" as const,
      port: 34_567,
      origin: "http://127.0.0.1:34567",
      bootstrapUrl: BOOTSTRAP_URL,
    }),
  );
  const close = vi.fn(async (): Promise<void> => undefined);
  return Object.freeze({ start, close });
}

function compositionDependencies(
  overrides: Partial<TokenMonsterCliDependencies> = {},
) {
  const runtime = fakeRuntime();
  const adapter = fakeAdapter();
  const gateway = fakeGateway();
  const runtimeLease = Object.freeze({
    release: vi.fn(async (): Promise<void> => undefined),
  });
  const captured: {
    runtimeOptions?: StartManagedTokenTrackerOptions;
    adapterOptions?: TokenTrackerAdapterOptions;
    gatewayOptions?: CompanionGatewayOptions;
  } = {};
  const dependencies: TokenMonsterCliDependencies = {
    acquireRuntimeLease: vi.fn(async () => runtimeLease),
    startRuntime: async (options) => {
      captured.runtimeOptions = options;
      await options.readinessProbe(
        runtime.baseUrl,
        new AbortController().signal,
      );
      return runtime;
    },
    createAdapter: (options) => {
      captured.adapterOptions = options;
      return adapter;
    },
    createGateway: (options) => {
      captured.gatewayOptions = options;
      return gateway;
    },
    getApprovedAssetPackConfiguration: () => null,
    getEmbeddedStarterAssetConfiguration: () => null,
    getAssetDirectory: () => "/package/companion-ui/dist/public",
    getContributionCredentialHost: () => null,
    createContributionRuntime: vi.fn(async () => {
      throw new Error("CONTRIBUTION_RUNTIME_MUST_NOT_START_WITHOUT_HOST");
    }),
    openBrowser: vi.fn(async () => true),
    waitForTermination: vi.fn(async () => ({
      kind: "signal" as const,
      signal: "SIGINT" as const,
    })),
    ...overrides,
  };
  return { dependencies, runtimeLease, runtime, adapter, gateway, captured };
}

describe("CLI surface", () => {
  it("derives its displayed version from the package manifest", async () => {
    const manifest = JSON.parse(
      await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { version?: unknown };

    expect(TOKENMONSTER_CLI_VERSION).toBe(manifest.version);
  });

  it("keeps the normal pure-Node launcher default-off without opening contribution state", async () => {
    const [source, hostSource, manifestText] = await Promise.all([
      readFile(join(import.meta.dirname, "..", "src", "cli.ts"), "utf8"),
      readFile(
        join(import.meta.dirname, "..", "src", "contribution-host.ts"),
        "utf8",
      ),
      readFile(join(import.meta.dirname, "..", "package.json"), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as {
      dependencies?: Record<string, unknown>;
    };

    expect(source).toContain("getContributionCredentialHost: () => null");
    expect(source).toContain("contributionRuntime?.controller ?? null");
    expect(source).not.toContain("createContributionService");
    expect(source).not.toContain("createEncryptedSecretSlot");
    expect(hostSource).toContain("createContributionService");
    expect(hostSource).toContain("refreshSidecarContributionProjection");
    expect(manifest.dependencies).toHaveProperty(
      "@tokenmonster/contribution-runtime",
    );
  });

  it("handles help, version, and invalid arguments without starting a runtime", async () => {
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const startRuntime = vi.fn();

    await expect(
      runTokenMonster({
        argv: ["--help"],
        stdout,
        stderr,
        dependencies: { startRuntime },
      }),
    ).resolves.toBe(0);
    expect(stdout.value).toContain("tokenmonster --no-open");
    expect(stdout.value).toContain("--no-character-downloads");
    expect(startRuntime).not.toHaveBeenCalled();

    stdout.value = "";
    await expect(
      runTokenMonster({
        argv: ["--version"],
        stdout,
        stderr,
        dependencies: { startRuntime },
      }),
    ).resolves.toBe(0);
    expect(stdout.value).toBe(`v${TOKENMONSTER_CLI_VERSION}\n`);

    await expect(
      runTokenMonster({ argv: ["--port", "9999"], stdout, stderr }),
    ).resolves.toBe(2);
    expect(stderr.value).toContain("不支援這個參數");
  });

  it("rejects a non-callable embedded starter authority before startup", async () => {
    const stderr = new CapturedOutput();
    const startRuntime = vi.fn();

    await expect(
      runTokenMonster({
        stderr,
        dependencies: {
          startRuntime,
          getEmbeddedStarterAssetConfiguration:
            null as unknown as TokenMonsterCliDependencies["getEmbeddedStarterAssetConfiguration"],
        },
      }),
    ).resolves.toBe(2);

    expect(startRuntime).not.toHaveBeenCalled();
    expect(stderr.value).toContain("不支援這個參數");
  });

  it("composes the announced runtime URL, adapter, UI, gateway, and browser", async () => {
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const { dependencies, runtimeLease, runtime, adapter, gateway, captured } =
      compositionDependencies();

    const result = await runTokenMonster({
      argv: [],
      homeDirectory: "/home/tester",
      stdout,
      stderr,
      dependencies,
    });

    expect(result).toBe(0);
    expect(dependencies.acquireRuntimeLease).toHaveBeenCalledWith({
      scopeDirectory: join("/home/tester", ".tokenmonster"),
    });
    expect(captured.adapterOptions).toEqual({ baseUrl: runtime.baseUrl });
    expect(adapter.probe).toHaveBeenCalledTimes(1);
    const byok = captured.gatewayOptions?.byok;
    if (byok === undefined || byok === null) {
      throw new Error("CLI did not compose a BYOK secret slot");
    }
    expect(captured.gatewayOptions).toEqual({
      adapter,
      collector: runtime,
      byok,
      contribution: null,
      assetDirectory: "/package/companion-ui/dist/public",
      characters: {
        manifest: null,
        baseAssets: null,
        assetPack: null,
        cacheDirectory: join("/home/tester", ".tokenmonster", "asset-cache"),
        cdnBaseUrl: DEFAULT_CHARACTER_CDN_BASE_URL,
        progressionStorePath: join(
          "/home/tester",
          ".tokenmonster",
          "progression-v1.json",
        ),
      },
    });
    expect(await byok.initialize()).toEqual({
      configured: false,
      persistence: "memory-only",
      activePersistence: "memory-only",
      backend: "memory-only",
    });
    const keyCanary = ["sk", "cli_memory_1234567890abcdef_CANARY"].join("-");
    expect(await byok.set(keyCanary, { persist: true })).toMatchObject({
      configured: true,
      persistence: "memory-only",
    });
    expect(JSON.stringify(byok.status())).not.toContain(keyCanary);
    await byok.clear();
    expect(byok.get()).toBeNull();
    expect(gateway.start).toHaveBeenCalledWith();
    expect(dependencies.createContributionRuntime).not.toHaveBeenCalled();
    expect(dependencies.openBrowser).toHaveBeenCalledWith(BOOTSTRAP_URL);
    expect(dependencies.waitForTermination).toHaveBeenCalledWith(
      runtime.closed,
    );
    expect(gateway.close).toHaveBeenCalledTimes(1);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtimeLease.release).toHaveBeenCalledTimes(1);
    expect(stdout.value).toContain(BOOTSTRAP_URL);
    expect(stderr.value).toBe("");
  });

  it("composes only an explicitly injected credential host and closes it before the sidecar", async () => {
    const events: string[] = [];
    const credentialHost = Object.freeze({
      openCredentialSlots: vi.fn(),
    }) as unknown as ContributionCredentialHost;
    const controller = Object.freeze({}) as CompanionContributionController;
    const close = vi.fn(async () => {
      events.push("contribution-close");
    });
    const createContributionRuntime = vi.fn(async () =>
      Object.freeze({ controller, close }),
    );
    const { dependencies, adapter, runtime, gateway, captured } =
      compositionDependencies({
        getContributionCredentialHost: () => credentialHost,
        createContributionRuntime,
      });
    gateway.close.mockImplementationOnce(async () => {
      events.push("gateway-close");
    });
    runtime.stop.mockImplementationOnce(async () => {
      events.push("runtime-stop");
    });

    await expect(
      runTokenMonster({
        argv: ["--no-open"],
        homeDirectory: "/home/tester",
        dependencies,
      }),
    ).resolves.toBe(0);

    expect(createContributionRuntime).toHaveBeenCalledWith({
      credentialHost,
      stateDirectory: join("/home/tester", ".tokenmonster"),
      adapter,
    });
    expect(captured.gatewayOptions?.contribution).toBe(controller);
    expect(events).toEqual([
      "gateway-close",
      "contribution-close",
      "runtime-stop",
    ]);
  });

  it("keeps the local companion running when injected contribution composition fails", async () => {
    const createContributionRuntime = vi.fn(async () => {
      throw new Error(ERROR_CANARY);
    });
    const { dependencies, captured } = compositionDependencies({
      getContributionCredentialHost: () =>
        Object.freeze({ openCredentialSlots: vi.fn() }) as unknown as ContributionCredentialHost,
      createContributionRuntime,
    });

    await expect(
      runTokenMonster({ argv: ["--no-open"], dependencies }),
    ).resolves.toBe(0);
    expect(createContributionRuntime).toHaveBeenCalledTimes(1);
    expect(captured.gatewayOptions?.contribution).toBeNull();
  });

  it("keeps the local companion running when credential-host lookup itself fails", async () => {
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const createContributionRuntime = vi.fn();
    const { dependencies, captured, gateway } = compositionDependencies({
      getContributionCredentialHost: () => {
        throw new Error(ERROR_CANARY);
      },
      createContributionRuntime,
    });

    await expect(
      runTokenMonster({
        argv: ["--no-open"],
        stdout,
        stderr,
        dependencies,
      }),
    ).resolves.toBe(0);
    expect(createContributionRuntime).not.toHaveBeenCalled();
    expect(captured.gatewayOptions?.contribution).toBeNull();
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(stderr.value).toBe("");
    expect(stdout.value).not.toContain(ERROR_CANARY);
  });

  it("passes embedded starter assets with the complete fixed-pack authority", async () => {
    const baseAssets = Object.freeze({
      marker: "embedded-starters",
    }) as unknown as NonNullable<
      CompanionGatewayOptions["characters"]["baseAssets"]
    >;
    const assetPack = Object.freeze({
      marker: "approved-pack",
    }) as unknown as NonNullable<
      CompanionGatewayOptions["characters"]["assetPack"]
    >;
    const getEmbeddedStarterAssetConfiguration = vi.fn(() => baseAssets);
    const getApprovedAssetPackConfiguration = vi.fn(() => assetPack);
    const { dependencies, captured } = compositionDependencies({
      getEmbeddedStarterAssetConfiguration,
      getApprovedAssetPackConfiguration,
    });

    await expect(
      runTokenMonster({ argv: ["--no-open"], dependencies }),
    ).resolves.toBe(0);

    expect(getEmbeddedStarterAssetConfiguration).toHaveBeenCalledTimes(1);
    expect(getApprovedAssetPackConfiguration).toHaveBeenCalledTimes(1);
    expect(captured.gatewayOptions?.characters.manifest).toBeNull();
    expect(captured.gatewayOptions?.characters.baseAssets).toBe(baseAssets);
    expect(captured.gatewayOptions?.characters.assetPack).toBe(assetPack);
  });

  it("probes data availability through the adapter trailing-year summary", async () => {
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const { dependencies, adapter, captured } = compositionDependencies();

    await expect(
      runTokenMonster({ argv: ["--no-open"], stdout, stderr, dependencies }),
    ).resolves.toBe(0);

    const probe = captured.runtimeOptions?.dataAvailabilityProbe;
    expect(typeof probe).toBe("function");
    const summary = (totalTokens: number) =>
      Object.freeze({
        fromUtcDate: "2025-07-17",
        toUtcDate: "2026-07-16",
        activeDays: totalTokens > 0 ? 1 : 0,
        tokens: Object.freeze({
          inputTokens: totalTokens,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens,
        }),
      });
    vi.mocked(adapter.getSummary).mockResolvedValueOnce(summary(123));
    await expect(probe?.("http://127.0.0.1:7681")).resolves.toBe(true);
    vi.mocked(adapter.getSummary).mockResolvedValueOnce(summary(0));
    await expect(probe?.("http://127.0.0.1:7681")).resolves.toBe(false);
    const range = vi.mocked(adapter.getSummary).mock.calls[0]?.[0];
    expect(range?.fromUtcDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(range?.toUtcDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(range && range.fromUtcDate < range.toUtcDate).toBe(true);
  });

  it("supports a headless remote flow without trying to open a browser", async () => {
    const stdout = new CapturedOutput();
    const { dependencies } = compositionDependencies();

    await expect(
      runTokenMonster({
        argv: ["--no-open"],
        stdout,
        dependencies,
      }),
    ).resolves.toBe(0);

    expect(dependencies.openBrowser).not.toHaveBeenCalled();
    expect(stdout.value).toContain(
      "ssh -L 34567:127.0.0.1:34567 <user>@<host>",
    );
  });

  it("keeps character assets cache-only even when legacy overrides are present", async () => {
    const stdout = new CapturedOutput();
    const first = compositionDependencies();
    await expect(
      runTokenMonster({
        argv: ["--no-open"],
        homeDirectory: "/home/tester",
        environment: {
          TOKENMONSTER_CHARACTER_CDN: "https://assets.example.test/characters",
        },
        stdout,
        dependencies: first.dependencies,
      }),
    ).resolves.toBe(0);
    expect(first.captured.gatewayOptions?.characters).toMatchObject({
      cacheDirectory: join("/home/tester", ".tokenmonster", "asset-cache"),
      cdnBaseUrl: null,
      progressionStorePath: join(
        "/home/tester",
        ".tokenmonster",
        "progression-v1.json",
      ),
    });

    const baseAssets = Object.freeze({
      marker: "embedded-starters",
    }) as unknown as NonNullable<
      CompanionGatewayOptions["characters"]["baseAssets"]
    >;
    const getEmbeddedStarterAssetConfiguration = vi.fn(() => baseAssets);
    const second = compositionDependencies({
      getEmbeddedStarterAssetConfiguration,
    });
    const assetPackGetter = vi.spyOn(
      second.dependencies,
      "getApprovedAssetPackConfiguration",
    );
    await expect(
      runTokenMonster({
        argv: ["--no-open", "--no-character-downloads"],
        homeDirectory: "/home/tester",
        environment: {
          TOKENMONSTER_CHARACTER_CDN: "https://must-not-be-used.example.test",
        },
        stdout,
        dependencies: second.dependencies,
      }),
    ).resolves.toBe(0);
    expect(second.captured.gatewayOptions?.characters.cdnBaseUrl).toBeNull();
    expect(second.captured.gatewayOptions?.characters.baseAssets).toBe(
      baseAssets,
    );
    expect(second.captured.gatewayOptions?.characters.assetPack).toBeNull();
    expect(getEmbeddedStarterAssetConfiguration).toHaveBeenCalledTimes(1);
    expect(assetPackGetter).not.toHaveBeenCalled();
  });

  it("sanitizes runtime startup failures and never starts the gateway", async () => {
    const stderr = new CapturedOutput();
    const createGateway = vi.fn();

    const result = await runTokenMonster({
      stderr,
      dependencies: {
        acquireRuntimeLease: async () => ({
          release: async (): Promise<void> => undefined,
        }),
        startRuntime: async () => {
          throw new Error(ERROR_CANARY);
        },
        createGateway,
      },
    });

    expect(result).toBe(1);
    expect(stderr.value).toContain("sidecar 無法啟動");
    expect(stderr.value).not.toContain(ERROR_CANARY);
    expect(createGateway).not.toHaveBeenCalled();
  });

  it("rejects a second CLI or Electron owner before starting the sidecar", async () => {
    const stderr = new CapturedOutput();
    const startRuntime = vi.fn();
    const privateHome = "/private/USER_PATH_CANARY";

    await expect(
      runTokenMonster({
        homeDirectory: privateHome,
        stderr,
        dependencies: {
          acquireRuntimeLease: async () => {
            throw new TokenMonsterRuntimeLeaseError("already-running");
          },
          startRuntime,
        },
      }),
    ).resolves.toBe(1);

    expect(startRuntime).not.toHaveBeenCalled();
    expect(stderr.value).toContain("已在執行中");
    expect(stderr.value).not.toContain(privateHome);
  });

  it("sanitizes an unavailable runtime lease without exposing its cause", async () => {
    const stderr = new CapturedOutput();
    const startRuntime = vi.fn();

    await expect(
      runTokenMonster({
        stderr,
        dependencies: {
          acquireRuntimeLease: async () => {
            throw new Error(ERROR_CANARY);
          },
          startRuntime,
        },
      }),
    ).resolves.toBe(1);

    expect(startRuntime).not.toHaveBeenCalled();
    expect(stderr.value).toContain("本機執行權");
    expect(stderr.value).not.toContain(ERROR_CANARY);
  });

  it("stops the runtime when gateway startup fails", async () => {
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const { dependencies, runtime } = compositionDependencies({
      createGateway: () => {
        throw new Error(ERROR_CANARY);
      },
    });

    await expect(
      runTokenMonster({ stdout, stderr, dependencies }),
    ).resolves.toBe(1);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(stderr.value).toContain("本機介面無法啟動");
    expect(stderr.value).not.toContain(ERROR_CANARY);
  });

  it("returns failure and cleans up after an unexpected managed runtime exit", async () => {
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const { dependencies, runtime, gateway } = compositionDependencies({
      waitForTermination: async () => ({
        kind: "runtime-exit",
        exit: Object.freeze({ expected: false, code: 1, signal: null }),
      }),
    });

    await expect(
      runTokenMonster({ stdout, stderr, dependencies }),
    ).resolves.toBe(1);
    expect(stderr.value).toContain("sidecar 已停止");
    expect(gateway.close).toHaveBeenCalledTimes(1);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });

  it("releases the shared lease only after gateway and sidecar shutdown", async () => {
    const events: string[] = [];
    const { dependencies, runtimeLease, runtime, gateway } =
      compositionDependencies();
    gateway.close.mockImplementationOnce(async () => {
      events.push("gateway-close");
    });
    runtime.stop.mockImplementationOnce(async () => {
      events.push("runtime-stop");
    });
    runtimeLease.release.mockImplementationOnce(async () => {
      events.push("lease-release");
    });

    await expect(
      runTokenMonster({ argv: ["--no-open"], dependencies }),
    ).resolves.toBe(0);
    expect(events).toEqual(["gateway-close", "runtime-stop", "lease-release"]);
  });

  it("returns failure when owned process cleanup fails", async () => {
    const { dependencies, runtimeLease, runtime, gateway } =
      compositionDependencies();
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    gateway.close.mockRejectedValueOnce(new Error(ERROR_CANARY));
    runtime.stop.mockRejectedValueOnce(new Error(ERROR_CANARY));
    runtimeLease.release.mockRejectedValueOnce(new Error(ERROR_CANARY));

    await expect(
      runTokenMonster({ dependencies, stdout, stderr }),
    ).resolves.toBe(1);
    expect(gateway.close).toHaveBeenCalledTimes(1);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtimeLease.release).toHaveBeenCalledTimes(1);
    expect(stderr.value).not.toContain(ERROR_CANARY);
  });

  it("keeps the runtime package pin equal to the adapter compatibility target", () => {
    expect(PINNED_TOKEN_TRACKER_VERSION).toBe(SUPPORTED_TOKEN_TRACKER_VERSION);
  });

  it("declares the intended tokenmonster bin while remaining private", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { name?: string; private?: boolean; bin?: Record<string, string> };
    expect(manifest).toMatchObject({
      name: "tokenmonster",
      private: true,
      bin: { tokenmonster: "./dist/bin.js" },
    });
  });
});

describe("browser launcher", () => {
  it.each([
    ["darwin" as const, {}, "open"],
    ["win32" as const, {}, "explorer.exe"],
    ["linux" as const, {}, "xdg-open"],
    ["linux" as const, { WSL_DISTRO_NAME: "Ubuntu" }, "wslview"],
  ])(
    "uses a shell-free platform command on %s",
    async (platform, environment, expected) => {
      const child = new EventEmitter() as ChildProcess;
      child.unref = vi.fn();
      const spawn = vi.fn((_command, _arguments, options) => {
        queueMicrotask(() => child.emit("spawn"));
        expect(options.shell).toBe(false);
        return child;
      });

      await expect(
        openTokenMonsterBrowser(BOOTSTRAP_URL, {
          platform,
          environment,
          spawn,
        }),
      ).resolves.toBe(true);
      expect(spawn.mock.calls[0]?.[0]).toBe(expected);
      expect(spawn.mock.calls[0]?.[1]).toEqual([BOOTSTRAP_URL]);
      expect(child.unref).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects arbitrary URLs before spawning", async () => {
    const spawn = vi.fn();
    await expect(
      openTokenMonsterBrowser("https://example.com/?token=secret", { spawn }),
    ).resolves.toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});
