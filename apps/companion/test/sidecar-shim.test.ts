import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const shimPath = fileURLToPath(
  new URL("../src/main/pet/sidecar-shim.cjs", import.meta.url)
);

interface ShimRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runShim(args: readonly string[]): Promise<ShimRun> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [shimPath, ...args],
      { timeout: 15_000 }
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
    const result = await runShim([trackerEntry, "--version", "extra"]);
    expect(result.code).toBe(0);
    const [argsLine, payload] = result.stdout.split("\n");
    expect(JSON.parse(argsLine ?? "")).toEqual(["--version", "extra"]);
    expect(payload).toHaveLength(100000);
  });

  it("exits 1 and reports the error when run() rejects", async () => {
    const result = await runShim([trackerEntry, "--fail"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("fixture boom");
  });

  it("exits 1 when the entry path argument is missing", async () => {
    const result = await runShim([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("missing tracker entry path");
  });

  it("exits 1 when the CLI does not export run()", async () => {
    const result = await runShim([runlessEntry]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("did not export run()");
  });
});
