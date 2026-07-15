import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { describe, expect, it, vi } from "vitest";

import * as publicApi from "../src/index.js";
import {
  buildIsolatedSpawnInvocation,
  collectTokscaleDailySnapshotWithDependencies,
  runTokscaleDailyReport,
  type TokscaleProcessExecutor,
  type TokscaleProcessRequest
} from "../src/runner.js";
import {
  CollectorTokscaleError,
  TOKSCALE_STDERR_MAX_BYTES,
  TOKSCALE_STDOUT_MAX_BYTES,
  TOKSCALE_TIMEOUT_MS
} from "../src/index.js";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const CONFIG_DIR = "/home/tester/.tokenmonster/tokscale";

function claudeFixture(): string {
  return readFileSync(
    new URL("fixtures/claude.json", import.meta.url),
    "utf8"
  );
}

function collectInput() {
  return {
    client: "claude" as const,
    utcDate: "2026-07-15",
    configDir: CONFIG_DIR,
    batchId: "550e8400-e29b-41d4-a716-446655440000",
    generatedAt: "2026-07-15T12:34:56.000Z",
    revision: 1
  };
}

function successResult(stdout = claudeFixture()) {
  return {
    stdout,
    exitCode: 0,
    timedOut: false,
    outputTooLarge: false
  };
}

describe("bounded Tokscale runner", () => {
  it("wraps the native process in a fixed denied-egress sandbox", () => {
    const request: TokscaleProcessRequest = {
      command: "/opt/tokenmonster/tokscale",
      args: ["--json"],
      env: { HOME: "/home/tester" },
      shell: false,
      timeoutMs: TOKSCALE_TIMEOUT_MS,
      stdoutMaxBytes: TOKSCALE_STDOUT_MAX_BYTES,
      stderrMaxBytes: TOKSCALE_STDERR_MAX_BYTES
    };
    const linux = buildIsolatedSpawnInvocation(
      request,
      "linux",
      (path) => path === "/usr/bin/bwrap"
    );
    expect(linux.command).toBe("/usr/bin/bwrap");
    expect(linux.args).toContain("--unshare-net");
    expect(linux.args).not.toContain("--tmpfs");
    expect(linux.args.at(-2)).toBe(request.command);
    expect(linux.args.at(-1)).toBe("--json");

    const mac = buildIsolatedSpawnInvocation(
      request,
      "darwin",
      (path) => path === "/usr/bin/sandbox-exec"
    );
    expect(mac.command).toBe("/usr/bin/sandbox-exec");
    expect(mac.args).toContain("(version 1) (allow default) (deny network*)");

    expect(() =>
      buildIsolatedSpawnInvocation(request, "win32", () => true)
    ).toThrowError(
      expect.objectContaining<Partial<CollectorTokscaleError>>({
        code: "network-isolation-unavailable"
      })
    );
    expect(() =>
      buildIsolatedSpawnInvocation(request, "linux", () => false)
    ).toThrowError(
      expect.objectContaining<Partial<CollectorTokscaleError>>({
        code: "network-isolation-unavailable"
      })
    );
  });

  it("runs the fixed command policy and immediately returns a projected contract", async () => {
    let capturedRequest: TokscaleProcessRequest | undefined;
    const execute: TokscaleProcessExecutor = async (request) => {
      capturedRequest = request;
      return successResult();
    };

    const snapshot =
      await collectTokscaleDailySnapshotWithDependencies(collectInput(), {
        execute,
        now: () => NOW,
        parentEnv: {
          HOME: "/home/tester",
          PATH: "/private/bin",
          TOKSCALE_API_TOKEN: "must-not-pass"
        }
      });

    expect(snapshot.buckets[0]?.tool).toBe("claude-code");
    expect(capturedRequest).toBeDefined();
    expect(isAbsolute(capturedRequest!.command)).toBe(true);
    expect(capturedRequest!.args).toEqual([
      "--json",
      "--group-by",
      "client,provider,model",
      "--since",
      "2026-07-15",
      "--until",
      "2026-07-15",
      "--client",
      "claude",
      "--no-spinner",
      "--hide-zero"
    ]);
    expect(capturedRequest).toMatchObject({
      shell: false,
      timeoutMs: TOKSCALE_TIMEOUT_MS,
      stdoutMaxBytes: TOKSCALE_STDOUT_MAX_BYTES,
      stderrMaxBytes: TOKSCALE_STDERR_MAX_BYTES
    });
    expect(capturedRequest!.env).toEqual({
      HOME: "/home/tester",
      TZ: "UTC",
      TOKSCALE_CONFIG_DIR: CONFIG_DIR,
      TOKSCALE_PRICING_CACHE_ONLY: "1"
    });
  });

  it("accepts only an absolute packaged binary while preserving fixed argv", async () => {
    let capturedRequest: TokscaleProcessRequest | undefined;
    const execute: TokscaleProcessExecutor = async (request) => {
      capturedRequest = request;
      return successResult();
    };
    await collectTokscaleDailySnapshotWithDependencies(collectInput(), {
      binaryPath: "/opt/tokenmonster/collector/tokscale",
      execute,
      now: () => NOW
    });
    expect(capturedRequest?.command).toBe(
      "/opt/tokenmonster/collector/tokscale"
    );
    expect(capturedRequest?.args).toEqual(
      expect.arrayContaining(["--json", "--client", "claude"])
    );
    await expect(
      collectTokscaleDailySnapshotWithDependencies(collectInput(), {
        binaryPath: "../../bin/sh",
        execute,
        now: () => NOW
      })
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("rejects arbitrary command and argv fields before invoking the executor", async () => {
    const execute = vi.fn<TokscaleProcessExecutor>(async () => successResult());
    const unsafeInput = {
      ...collectInput(),
      command: "/bin/sh",
      argv: ["-c", "cat ~/.ssh/id_rsa"]
    };

    await expect(
      collectTokscaleDailySnapshotWithDependencies(
        unsafeInput as never,
        {
          execute,
          now: () => NOW
        }
      )
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed on timeout without exposing raw output", async () => {
    await expect(
      runTokscaleDailyReport(
        {
          client: "claude",
          utcDate: "2026-07-15",
          configDir: CONFIG_DIR
        },
        {
          now: () => NOW,
          execute: async () => ({
            stdout: "sensitive partial stdout",
            exitCode: null,
            timedOut: true,
            outputTooLarge: false
          })
        }
      )
    ).rejects.toEqual(
      expect.objectContaining<Partial<CollectorTokscaleError>>({
        code: "process-timeout",
        message: expect.not.stringContaining("sensitive")
      })
    );
  });

  it("fails closed when stdout exceeds the byte cap", async () => {
    await expect(
      runTokscaleDailyReport(
        {
          client: "claude",
          utcDate: "2026-07-15",
          configDir: CONFIG_DIR
        },
        {
          now: () => NOW,
          execute: async () =>
            successResult("x".repeat(TOKSCALE_STDOUT_MAX_BYTES + 1))
        }
      )
    ).rejects.toMatchObject({ code: "output-too-large" });
  });

  it("honors an executor-side stdout or stderr cap termination", async () => {
    await expect(
      runTokscaleDailyReport(
        {
          client: "claude",
          utcDate: "2026-07-15",
          configDir: CONFIG_DIR
        },
        {
          now: () => NOW,
          execute: async () => ({
            stdout: "",
            exitCode: null,
            timedOut: false,
            outputTooLarge: true
          })
        }
      )
    ).rejects.toMatchObject({ code: "output-too-large" });
  });

  it("sanitizes a non-zero process failure", async () => {
    await expect(
      runTokscaleDailyReport(
        {
          client: "claude",
          utcDate: "2026-07-15",
          configDir: CONFIG_DIR
        },
        {
          now: () => NOW,
          execute: async () => ({
            stdout: "private upstream failure",
            exitCode: 2,
            timedOut: false,
            outputTooLarge: false
          })
        }
      )
    ).rejects.toEqual(
      expect.objectContaining<Partial<CollectorTokscaleError>>({
        code: "process-failed",
        message: expect.not.stringContaining("private")
      })
    );
  });

  it("does not expose arbitrary process execution through the package API", () => {
    expect("executeTokscaleProcess" in publicApi).toBe(false);
    expect("runTokscaleDailyReport" in publicApi).toBe(false);
    expect("collectTokscaleDailySnapshot" in publicApi).toBe(true);
    expect(
      "collectTokscaleDailySnapshotFromPinnedBinary" in publicApi
    ).toBe(true);
    expect("collectCurrentDayTokscaleSnapshot" in publicApi).toBe(false);
  });
});
