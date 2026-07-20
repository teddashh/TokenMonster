import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createCompanionGateway,
  getApprovedAssetPackConfiguration,
} from "@tokenmonster/companion-gateway";
import { getCompanionUiAssetDirectory } from "@tokenmonster/companion-ui";
import { createMemorySecretSlot } from "@tokenmonster/secret-vault";
import {
  SUPPORTED_TOKEN_TRACKER_VERSION,
  createTokenTrackerAdapter,
  type TokenTrackerAdapter,
  type TokenTrackerAggregateRange,
} from "@tokenmonster/token-tracker-adapter";
import {
  PINNED_TOKEN_TRACKER_VERSION,
  TokenMonsterRuntimeLeaseError,
  acquireTokenMonsterRuntimeLease,
  startManagedTokenTracker,
  type TokenMonsterRuntimeLease,
} from "@tokenmonster/token-tracker-runtime";

import { openTokenMonsterBrowser } from "./browser.js";
import { TokenMonsterCliError } from "./errors.js";
import type {
  RunTokenMonsterOptions,
  TokenMonsterCliDependencies,
  TokenMonsterOutput,
  TokenMonsterTerminationReason,
} from "./types.js";
import {
  createCliContributionRuntime,
  type CliContributionRuntime,
} from "./contribution-host.js";

const PACKAGE_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

function installedPackageVersion(): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as unknown;
  } catch {
    throw new Error("TokenMonster package metadata is unavailable.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getOwnPropertyDescriptor(parsed, "name")?.value !== "tokenmonster"
  ) {
    throw new Error("TokenMonster package metadata is invalid.");
  }
  const version: unknown = Object.getOwnPropertyDescriptor(
    parsed,
    "version",
  )?.value;
  if (
    typeof version !== "string" ||
    version.length > 64 ||
    !PACKAGE_VERSION_PATTERN.test(version)
  ) {
    throw new Error("TokenMonster package version is invalid.");
  }
  return version;
}

// Read from the package beside the installed dist/ tree. Release staging
// rewrites that manifest to the rc version, so --version cannot drift from the
// artifact users actually installed.
export const TOKENMONSTER_CLI_VERSION = installedPackageVersion();
// Per-object asset acquisition stays disabled. A future non-null embedded
// fixed-pack authority is exposed only through the gateway's explicit,
// state-independent complete-pack consent control.
export const DEFAULT_CHARACTER_CDN_BASE_URL = null;

const HELP = `TokenMonster

Usage:
  tokenmonster             啟動本機 companion
  tokenmonster --no-open   啟動但不自動開啟瀏覽器（SSH／遠端機器）
  tokenmonster --no-character-downloads
                           本次不提供角色素材包下載控制
  tokenmonster --version   顯示版本
  tokenmonster --help      顯示說明
`;

const DATA_PROBE_TRAILING_DAYS = 365;

function trailingUtcRange(): TokenTrackerAggregateRange {
  const now = new Date();
  return Object.freeze({
    fromUtcDate: new Date(now.getTime() - DATA_PROBE_TRAILING_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10),
    toUtcDate: now.toISOString().slice(0, 10),
  });
}

const defaultDependencies: TokenMonsterCliDependencies = Object.freeze({
  acquireRuntimeLease: acquireTokenMonsterRuntimeLease,
  startRuntime: startManagedTokenTracker,
  createAdapter: createTokenTrackerAdapter,
  createGateway: createCompanionGateway,
  getApprovedAssetPackConfiguration,
  getAssetDirectory: getCompanionUiAssetDirectory,
  // Node itself exposes no audited native keychain API. Platform launchers
  // inject a reviewed host explicitly; absence is default-off and zero-cloud.
  getContributionCredentialHost: () => null,
  createContributionRuntime: createCliContributionRuntime,
  openBrowser: openTokenMonsterBrowser,
  waitForTermination: waitForTokenMonsterTermination,
});

interface ParsedArguments {
  readonly action: "run" | "help" | "version";
  readonly openBrowser: boolean;
  readonly characterDownloads: boolean;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new TokenMonsterCliError("invalid-arguments");
  }
  if (argv.length === 0) {
    return Object.freeze({
      action: "run",
      openBrowser: true,
      characterDownloads: true,
    });
  }
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return Object.freeze({
      action: "help",
      openBrowser: false,
      characterDownloads: false,
    });
  }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    return Object.freeze({
      action: "version",
      openBrowser: false,
      characterDownloads: false,
    });
  }
  const flags = new Set(argv);
  if (
    flags.size === argv.length &&
    [...flags].every(
      (flag) => flag === "--no-open" || flag === "--no-character-downloads",
    )
  ) {
    return Object.freeze({
      action: "run",
      openBrowser: !flags.has("--no-open"),
      characterDownloads: !flags.has("--no-character-downloads"),
    });
  }
  throw new TokenMonsterCliError("invalid-arguments");
}

function normalizeDependencies(
  overrides: Partial<TokenMonsterCliDependencies> | undefined,
): TokenMonsterCliDependencies {
  const dependencies = { ...defaultDependencies, ...(overrides ?? {}) };
  if (
    typeof dependencies.acquireRuntimeLease !== "function" ||
    typeof dependencies.startRuntime !== "function" ||
    typeof dependencies.createAdapter !== "function" ||
    typeof dependencies.createGateway !== "function" ||
    typeof dependencies.getApprovedAssetPackConfiguration !== "function" ||
    typeof dependencies.getAssetDirectory !== "function" ||
    typeof dependencies.getContributionCredentialHost !== "function" ||
    typeof dependencies.createContributionRuntime !== "function" ||
    typeof dependencies.openBrowser !== "function" ||
    typeof dependencies.waitForTermination !== "function"
  ) {
    throw new TokenMonsterCliError("invalid-arguments");
  }
  return Object.freeze(dependencies);
}

function write(output: TokenMonsterOutput, value: string): void {
  output.write(value);
}

function writeRunningMessage(
  output: TokenMonsterOutput,
  bootstrapUrl: string,
): void {
  write(
    output,
    `\nTokenMonster 已啟動：\n\n  ${bootstrapUrl}\n\n按 Ctrl+C 停止。\n`,
  );
}

function writeRemoteHint(output: TokenMonsterOutput, port: number): void {
  write(
    output,
    `\n遠端機器請在自己的電腦另開 SSH tunnel：\n` +
      `  ssh -L ${port}:127.0.0.1:${port} <user>@<host>\n` +
      `再用上面的網址開啟。\n`,
  );
}

export function waitForTokenMonsterTermination(
  runtimeClosed: Promise<
    import("@tokenmonster/token-tracker-runtime").ManagedTokenTrackerExit
  >,
): Promise<TokenMonsterTerminationReason> {
  return new Promise<TokenMonsterTerminationReason>((resolveReason) => {
    let settled = false;
    const cleanup = (): void => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    const finish = (reason: TokenMonsterTerminationReason): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveReason(Object.freeze(reason));
    };
    const onSigint = (): void => finish({ kind: "signal", signal: "SIGINT" });
    const onSigterm = (): void => finish({ kind: "signal", signal: "SIGTERM" });
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    void runtimeClosed.then((exit) => finish({ kind: "runtime-exit", exit }));
  });
}

export async function runTokenMonster(
  options: RunTokenMonsterOptions = {},
): Promise<number> {
  const stdout = (options.stdout ?? process.stdout) as TokenMonsterOutput;
  const stderr = (options.stderr ?? process.stderr) as TokenMonsterOutput;
  let parsed: ParsedArguments;
  let dependencies: TokenMonsterCliDependencies;
  try {
    parsed = parseArguments(options.argv ?? []);
    dependencies = normalizeDependencies(options.dependencies);
  } catch (error) {
    const cliError =
      error instanceof TokenMonsterCliError
        ? error
        : new TokenMonsterCliError("invalid-arguments");
    write(stderr, `${cliError.message}\n`);
    return 2;
  }

  if (parsed.action === "help") {
    write(stdout, HELP);
    return 0;
  }
  if (parsed.action === "version") {
    write(stdout, `v${TOKENMONSTER_CLI_VERSION}\n`);
    return 0;
  }
  if (PINNED_TOKEN_TRACKER_VERSION !== SUPPORTED_TOKEN_TRACKER_VERSION) {
    write(
      stderr,
      `${new TokenMonsterCliError("sidecar-start-failed").message}\n`,
    );
    return 1;
  }
  const environment = options.environment ?? process.env;
  const homeDirectory =
    options.homeDirectory ?? environment["HOME"] ?? homedir();

  let runtimeLease: TokenMonsterRuntimeLease | null = null;
  let runtime: Awaited<
    ReturnType<TokenMonsterCliDependencies["startRuntime"]>
  > | null = null;
  let gateway: ReturnType<TokenMonsterCliDependencies["createGateway"]> | null =
    null;
  let adapter: TokenTrackerAdapter | null = null;
  let contributionRuntime: CliContributionRuntime | null = null;
  let exitCode = 0;

  try {
    try {
      runtimeLease = await dependencies.acquireRuntimeLease({
        scopeDirectory: join(homeDirectory, ".tokenmonster"),
      });
    } catch (error) {
      write(
        stderr,
        `${
          new TokenMonsterCliError(
            error instanceof TokenMonsterRuntimeLeaseError &&
              error.code === "already-running"
              ? "already-running"
              : "runtime-lease-failed",
          ).message
        }\n`,
      );
      return 1;
    }
    try {
      runtime = await dependencies.startRuntime({
        readinessProbe: async (baseUrl, signal): Promise<void> => {
          if (signal.aborted) throw new Error("aborted");
          const candidate = dependencies.createAdapter({ baseUrl });
          await candidate.probe();
          if (signal.aborted) throw new Error("aborted");
          adapter = candidate;
        },
        dataAvailabilityProbe: async (baseUrl): Promise<boolean> => {
          const candidate = adapter ?? dependencies.createAdapter({ baseUrl });
          const summary = await candidate.getSummary(trailingUtcRange());
          return summary.tokens.totalTokens > 0;
        },
      });
    } catch {
      write(
        stderr,
        `${new TokenMonsterCliError("sidecar-start-failed").message}\n`,
      );
      exitCode = 1;
    }
    if (runtime !== null && adapter === null) {
      write(
        stderr,
        `${new TokenMonsterCliError("sidecar-start-failed").message}\n`,
      );
      exitCode = 1;
    }

    if (runtime !== null && adapter !== null) {
      try {
        try {
          const credentialHost = dependencies.getContributionCredentialHost();
          if (credentialHost !== null) {
            contributionRuntime = await dependencies.createContributionRuntime({
              credentialHost,
              stateDirectory: join(homeDirectory, ".tokenmonster"),
              adapter,
            });
          }
        } catch {
          // Contribution is optional and fail-closed. Core local tracking and
          // UI remain available without a credential authority.
          contributionRuntime = null;
        }
        gateway = dependencies.createGateway({
          adapter,
          collector: runtime,
          byok: createMemorySecretSlot(),
          contribution: contributionRuntime?.controller ?? null,
          assetDirectory: dependencies.getAssetDirectory(),
          characters: {
            manifest: null,
            assetPack: parsed.characterDownloads
              ? dependencies.getApprovedAssetPackConfiguration()
              : null,
            cacheDirectory: join(homeDirectory, ".tokenmonster", "asset-cache"),
            cdnBaseUrl: DEFAULT_CHARACTER_CDN_BASE_URL,
            progressionStorePath: join(
              homeDirectory,
              ".tokenmonster",
              "progression-v1.json",
            ),
          },
        });
        const address = await gateway.start();
        writeRunningMessage(stdout, address.bootstrapUrl);
        if (parsed.openBrowser) {
          const opened = await dependencies.openBrowser(address.bootstrapUrl);
          if (!opened) writeRemoteHint(stdout, address.port);
        } else {
          writeRemoteHint(stdout, address.port);
        }
      } catch {
        write(
          stderr,
          `${new TokenMonsterCliError("gateway-start-failed").message}\n`,
        );
        exitCode = 1;
      }
    }

    if (runtime !== null && gateway !== null && exitCode === 0) {
      const reason = await dependencies.waitForTermination(runtime.closed);
      if (reason.kind === "runtime-exit" && !reason.exit.expected) {
        write(
          stderr,
          "TokenTracker sidecar 已停止；TokenMonster 將一起關閉。\n",
        );
        exitCode = 1;
      }
    }
  } finally {
    if (gateway !== null) {
      try {
        await gateway.close();
      } catch {
        exitCode = 1;
      }
    }
    if (contributionRuntime !== null) {
      try {
        await contributionRuntime.close();
      } catch {
        exitCode = 1;
      }
    }
    if (runtime !== null) {
      try {
        await runtime.stop();
      } catch {
        exitCode = 1;
      }
    }
    if (runtimeLease !== null) {
      try {
        await runtimeLease.release();
      } catch {
        write(
          stderr,
          `${new TokenMonsterCliError("runtime-lease-failed").message}\n`,
        );
        exitCode = 1;
      }
    }
  }
  return exitCode;
}
