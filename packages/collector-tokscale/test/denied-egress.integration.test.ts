import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  buildIsolatedSpawnInvocation,
  resolveTokscaleBinaryPath,
  type TokscaleProcessRequest
} from "../src/runner.js";
import {
  TOKSCALE_STDERR_MAX_BYTES,
  TOKSCALE_STDOUT_MAX_BYTES,
  TOKSCALE_TIMEOUT_MS
} from "../src/index.js";

const isAuditedLinuxTarget =
  process.platform === "linux" && ["x64", "arm64"].includes(process.arch);

it.runIf(isAuditedLinuxTarget)(
  "runs the pinned native binary with AF_INET and AF_INET6 denied",
  () => {
    const root = mkdtempSync(join(tmpdir(), "tokenmonster-egress-"));
    const home = join(root, "home");
    const configDir = join(root, "config");
    mkdirSync(home);
    mkdirSync(configDir);

    try {
      const request: TokscaleProcessRequest = {
        command: resolveTokscaleBinaryPath(),
        args: [
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
        ],
        env: {
          HOME: home,
          TZ: "UTC",
          TOKSCALE_CONFIG_DIR: configDir,
          TOKSCALE_PRICING_CACHE_ONLY: "1"
        },
        shell: false,
        timeoutMs: TOKSCALE_TIMEOUT_MS,
        stdoutMaxBytes: TOKSCALE_STDOUT_MAX_BYTES,
        stderrMaxBytes: TOKSCALE_STDERR_MAX_BYTES
      };
      const invocation = buildIsolatedSpawnInvocation(request);

      const result = spawnSync(
        "/usr/bin/strace",
        [
          "-f",
          "-qq",
          "-e",
          "trace=network",
          invocation.command,
          ...invocation.args
        ],
        {
          encoding: "utf8",
          env: request.env,
          maxBuffer: TOKSCALE_STDOUT_MAX_BYTES + TOKSCALE_STDERR_MAX_BYTES,
          timeout: TOKSCALE_TIMEOUT_MS
        }
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(result.stderr).not.toMatch(/socket\(AF_INET6?[,)]/u);
      expect(result.stderr).not.toMatch(/connect\(/u);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
  30_000
);
