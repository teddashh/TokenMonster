import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PINNED_TOKEN_TRACKER_VERSION } from "@tokenmonster/token-tracker-runtime";

import { UTILITY_VERSION_VERIFIED_EXIT_CODE } from "../src/main/pet/sidecar.js";

const execFileAsync = promisify(execFile);

const shimPath = fileURLToPath(
  new URL("../src/main/pet/sidecar-shim.cjs", import.meta.url)
);
const guardPath = fileURLToPath(
  new URL(
    "../../../packages/token-tracker-runtime/src/network-deny.cjs",
    import.meta.url
  )
);

interface ShimRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runShim(
  args: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv> = {}
): Promise<ShimRun> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [shimPath, ...args],
      { env: { ...process.env, ...environment }, timeout: 15_000 }
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof failure.code === "number" ? failure.code : -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? ""
    };
  }
}

describe("sidecar shim", () => {
  let fixtureDirectory: string;
  let trackerEntry: string;
  let runlessEntry: string;

  beforeAll(async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), "tokenmonster-shim-"));
    // Mirrors the pinned CLI layout the shim resolves against: the entry is
    // <package>/bin/tracker.js and run() lives in <package>/src/cli.js. The
    // bin file itself never has to exist — it only anchors createRequire.
    trackerEntry = join(fixtureDirectory, "pkg", "bin", "tracker.js");
    await mkdir(join(fixtureDirectory, "pkg", "src"), { recursive: true });
    await writeFile(
      join(fixtureDirectory, "pkg", "src", "cli.js"),
      [
        "module.exports = {",
        "  async run(args) {",
        "    if (args[0] === '--fail') throw new Error('fixture boom');",
        "    if (args[0] === '--probe-child') {",
        "      const cp = require('node:child_process');",
        "      try {",
        "        new cp.ChildProcess().spawn({ file: process.execPath, args: [process.execPath, '--version'], envPairs: [], stdio: 'ignore', detached: false, windowsHide: true, windowsVerbatimArguments: false });",
        "        console.log('allowed');",
        "      } catch (error) {",
        "        console.log(error && error.code);",
        "      }",
        "      return;",
        "    }",
        "    if (args.length === 1 && args[0] === '--version') {",
        `      if (process.env.TOKENMONSTER_TEST_DIRECT_VERSION_EXIT === '1') process.exit(${UTILITY_VERSION_VERIFIED_EXIT_CODE});`,
        `      console.log('v' + (process.env.TOKENMONSTER_TEST_VERSION ?? '${PINNED_TOKEN_TRACKER_VERSION}'));`,
        "      return;",
        "    }",
        "    console.log(JSON.stringify(args));",
        "    // Large payload: proves the shim flushes stdout before exiting.",
        "    process.stdout.write('x'.repeat(100000) + '\\n');",
        "  }",
        "};",
        ""
      ].join("\n")
    );
    runlessEntry = join(fixtureDirectory, "runless", "bin", "tracker.js");
    await mkdir(join(fixtureDirectory, "runless", "src"), { recursive: true });
    await writeFile(
      join(fixtureDirectory, "runless", "src", "cli.js"),
      "module.exports = {};\n"
    );
  });

  afterAll(async () => {
    await rm(fixtureDirectory, { recursive: true, force: true });
  });

  it("runs the CLI entry, flushes stdout, and exits 0 when run() resolves", async () => {
    const result = await runShim([
      guardPath,
      trackerEntry,
      "--echo",
      "extra"
    ]);
    expect(result.code).toBe(0);
    const [argsLine, payload] = result.stdout.split("\n");
    expect(JSON.parse(argsLine ?? "")).toEqual(["--echo", "extra"]);
    expect(payload).toHaveLength(100000);
  });

  it("captures and reports the exact pinned version through its exit code", async () => {
    const result = await runShim([
      guardPath,
      trackerEntry,
      "--version"
    ]);
    expect(result).toEqual({
      code: UTILITY_VERSION_VERIFIED_EXIT_CODE,
      stdout: "",
      stderr: ""
    });
  });

  it("rejects drift, overflow, and a nested direct exit during the version probe", async () => {
    const versionArgs = [guardPath, trackerEntry, "--version"];
    const drift = await runShim(versionArgs, {
      TOKENMONSTER_TEST_VERSION: "0.80.1"
    });
    expect(drift.code).toBe(1);
    expect(drift.stdout).toBe("");
    expect(drift.stderr).toContain("exact version output mismatch");

    const overflow = await runShim(versionArgs, {
      TOKENMONSTER_TEST_VERSION: "x".repeat(100)
    });
    expect(overflow.code).toBe(1);
    expect(overflow.stdout).toBe("");
    expect(overflow.stderr).toContain("exact version output mismatch");

    const nestedExit = await runShim(versionArgs, {
      TOKENMONSTER_TEST_DIRECT_VERSION_EXIT: "1"
    });
    expect(nestedExit.code).toBe(1);
    expect(nestedExit.stdout).toBe("");
    expect(nestedExit.stderr).toContain("version command attempted direct exit");
  });

  it("exits 1 and reports the error when run() rejects", async () => {
    const result = await runShim([guardPath, trackerEntry, "--fail"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("fixture boom");
  });

  it("exits 1 when the entry path argument is missing", async () => {
    const result = await runShim([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("missing network guard path");
  });

  it("exits 1 when the tracker entry path argument is missing", async () => {
    const result = await runShim([guardPath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("missing tracker entry path");
  });

  it("exits 1 when the CLI does not export run()", async () => {
    const result = await runShim([guardPath, runlessEntry]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("did not export run()");
  });

  it("loads the guard before the CLI can use the low-level child launcher", async () => {
    const result = await runShim([guardPath, trackerEntry, "--probe-child"]);
    expect(result).toEqual({
      code: 0,
      stdout: "TOKENMONSTER_SIDECAR_EGRESS_BLOCKED\n",
      stderr: ""
    });
  });
});
