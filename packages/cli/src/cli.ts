import { createCompanionGateway } from "@tokenmonster/companion-gateway";
import { getCompanionUiAssetDirectory } from "@tokenmonster/companion-ui";
import {
  SUPPORTED_TOKEN_TRACKER_VERSION,
  createTokenTrackerAdapter,
  type TokenTrackerAdapter
} from "@tokenmonster/token-tracker-adapter";
import {
  PINNED_TOKEN_TRACKER_VERSION,
  startManagedTokenTracker
} from "@tokenmonster/token-tracker-runtime";

import { openTokenMonsterBrowser } from "./browser.js";
import { TokenMonsterCliError } from "./errors.js";
import type {
  RunTokenMonsterOptions,
  TokenMonsterCliDependencies,
  TokenMonsterOutput,
  TokenMonsterTerminationReason
} from "./types.js";

export const TOKENMONSTER_CLI_VERSION = "0.1.0" as const;

const HELP = `TokenMonster

Usage:
  tokenmonster             啟動本機 companion
  tokenmonster --no-open   啟動但不自動開啟瀏覽器（SSH／遠端機器）
  tokenmonster --version   顯示版本
  tokenmonster --help      顯示說明
`;

const defaultDependencies: TokenMonsterCliDependencies = Object.freeze({
  startRuntime: startManagedTokenTracker,
  createAdapter: createTokenTrackerAdapter,
  createGateway: createCompanionGateway,
  getAssetDirectory: getCompanionUiAssetDirectory,
  openBrowser: openTokenMonsterBrowser,
  waitForTermination: waitForTokenMonsterTermination
});

interface ParsedArguments {
  readonly action: "run" | "help" | "version";
  readonly openBrowser: boolean;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new TokenMonsterCliError("invalid-arguments");
  }
  if (argv.length === 0) {
    return Object.freeze({ action: "run", openBrowser: true });
  }
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return Object.freeze({ action: "help", openBrowser: false });
  }
  if (
    argv.length === 1 &&
    (argv[0] === "--version" || argv[0] === "-v")
  ) {
    return Object.freeze({ action: "version", openBrowser: false });
  }
  if (argv.length === 1 && argv[0] === "--no-open") {
    return Object.freeze({ action: "run", openBrowser: false });
  }
  throw new TokenMonsterCliError("invalid-arguments");
}

function normalizeDependencies(
  overrides: Partial<TokenMonsterCliDependencies> | undefined
): TokenMonsterCliDependencies {
  const dependencies = { ...defaultDependencies, ...(overrides ?? {}) };
  if (
    typeof dependencies.startRuntime !== "function" ||
    typeof dependencies.createAdapter !== "function" ||
    typeof dependencies.createGateway !== "function" ||
    typeof dependencies.getAssetDirectory !== "function" ||
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
  bootstrapUrl: string
): void {
  write(
    output,
    `\nTokenMonster 已啟動：\n\n  ${bootstrapUrl}\n\n按 Ctrl+C 停止。\n`
  );
}

function writeRemoteHint(
  output: TokenMonsterOutput,
  port: number
): void {
  write(
    output,
    `\n遠端機器請在自己的電腦另開 SSH tunnel：\n` +
      `  ssh -L ${port}:127.0.0.1:${port} <user>@<host>\n` +
      `再用上面的網址開啟。\n`
  );
}

export function waitForTokenMonsterTermination(
  runtimeClosed: Promise<import("@tokenmonster/token-tracker-runtime").ManagedTokenTrackerExit>
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
    const onSigterm = (): void =>
      finish({ kind: "signal", signal: "SIGTERM" });
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    void runtimeClosed.then((exit) => finish({ kind: "runtime-exit", exit }));
  });
}

export async function runTokenMonster(
  options: RunTokenMonsterOptions = {}
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
    write(stderr, `${new TokenMonsterCliError("sidecar-start-failed").message}\n`);
    return 1;
  }

  let runtime: Awaited<ReturnType<TokenMonsterCliDependencies["startRuntime"]>> | null = null;
  let gateway: ReturnType<TokenMonsterCliDependencies["createGateway"]> | null = null;
  let adapter: TokenTrackerAdapter | null = null;
  let exitCode = 0;

  try {
    try {
      runtime = await dependencies.startRuntime({
        readinessProbe: async (baseUrl, signal): Promise<void> => {
          if (signal.aborted) throw new Error("aborted");
          const candidate = dependencies.createAdapter({ baseUrl });
          await candidate.probe();
          if (signal.aborted) throw new Error("aborted");
          adapter = candidate;
        }
      });
    } catch {
      write(
        stderr,
        `${new TokenMonsterCliError("sidecar-start-failed").message}\n`
      );
      exitCode = 1;
    }
    if (runtime !== null && adapter === null) {
      write(
        stderr,
        `${new TokenMonsterCliError("sidecar-start-failed").message}\n`
      );
      exitCode = 1;
    }

    if (runtime !== null && adapter !== null) {
      try {
        gateway = dependencies.createGateway({
          adapter,
          assetDirectory: dependencies.getAssetDirectory()
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
          `${new TokenMonsterCliError("gateway-start-failed").message}\n`
        );
        exitCode = 1;
      }
    }

    if (runtime !== null && gateway !== null && exitCode === 0) {
      const reason = await dependencies.waitForTermination(runtime.closed);
      if (reason.kind === "runtime-exit" && !reason.exit.expected) {
        write(stderr, "TokenTracker sidecar 已停止；TokenMonster 將一起關閉。\n");
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
    if (runtime !== null) {
      try {
        await runtime.stop();
      } catch {
        exitCode = 1;
      }
    }
  }
  return exitCode;
}
