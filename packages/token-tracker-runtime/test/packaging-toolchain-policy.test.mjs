import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const rootDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const adr = await readFile(
  resolve(rootDirectory, "docs/adr/0004-electron-packaging-and-signing.md"),
  "utf8"
);
const handoff = await readFile(
  resolve(rootDirectory, "docs/HANDOFF.md"),
  "utf8"
);
const workflow = await readFile(
  resolve(rootDirectory, ".github/workflows/ci.yml"),
  "utf8"
);

describe("packaging toolchain policy", () => {
  it("verifies and labels the reviewed exceptions as an external dev-tool gate", () => {
    const result = spawnSync(
      process.execPath,
      [resolve(rootDirectory, "scripts/verify-packaging-toolchain.mjs")],
      {
        cwd: rootDirectory,
        encoding: "utf8"
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "external dev-tool supply-chain semver gate, not an application/runtime defect"
    );
  });

  it("fails public release mode while stable Forge rejects the safe versions", () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve(rootDirectory, "scripts/verify-packaging-toolchain.mjs"),
        "--require-upstream-compatible"
      ],
      {
        cwd: rootDirectory,
        encoding: "utf8"
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Signed/GA publication is blocked until stable Forge ranges accept the reviewed safe dependency versions."
    );
  });

  it("keeps the stable and prerelease findings explicit in release documentation", () => {
    expect(adr).toContain("8.0.0-alpha.10");
    expect(adr).toContain("25 audit findings (22 high and 3 low)");
    expect(adr).toContain("external, dev-only packaging supply-chain semver gate");
    expect(adr).toContain("application/runtime defect");
    expect(handoff).toContain("external dev-only toolchain");
    expect(handoff).toContain("not an application/runtime bug");
    expect(workflow).toContain(
      "This gate is not an application runtime dependency."
    );
    const npmPublicationJob = workflow.slice(
      workflow.indexOf("  publish-cli-npm:"),
      workflow.indexOf("  promote-windows-release:")
    );
    expect(npmPublicationJob).toContain(
      "npm run verify:packaging-toolchain -- --require-upstream-compatible"
    );
    expect(npmPublicationJob.indexOf("--require-upstream-compatible")).toBeLessThan(
      npmPublicationJob.indexOf("Plan a monotonic npm publication")
    );
  });
});
