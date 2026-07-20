import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const rootDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const adr = await readFile(
  resolve(rootDirectory, "docs/adr/0004-electron-packaging-and-signing.md"),
  "utf8",
);
const handoff = await readFile(
  resolve(rootDirectory, "docs/HANDOFF.md"),
  "utf8",
);
const workflow = await readFile(
  resolve(rootDirectory, ".github/workflows/ci.yml"),
  "utf8",
);

describe("packaging toolchain policy", () => {
  it("verifies the exact stable direct tools and Forge-free closure", () => {
    const result = spawnSync(
      process.execPath,
      [resolve(rootDirectory, "scripts/verify-packaging-toolchain.mjs")],
      {
        cwd: rootDirectory,
        encoding: "utf8",
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "successful npm dependency tree, and Forge-free packaging closure",
    );
  });

  it("keeps public release mode closed in the same strict clean-tree verifier", () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve(rootDirectory, "scripts/verify-packaging-toolchain.mjs"),
        "--require-upstream-compatible",
      ],
      {
        cwd: rootDirectory,
        encoding: "utf8",
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "internal-only pending redistribution review",
    );
  });

  it("keeps the stable replacement and strict publication gate explicit", () => {
    expect(adr).toContain("`@electron/packager 18.4.4`");
    expect(adr).toContain("`@electron/windows-sign 1.2.2`");
    expect(adr).toContain("Forge-free closure");
    expect(adr).toContain("native-range lock produced 25");
    expect(adr).toContain("audit findings (22 high and 3 low)");
    expect(handoff).toContain(
      "dependency blocker is now addressed by a reviewed stable",
    );
    expect(handoff).toContain("direct Electron packaging replacement");
    expect(handoff).toContain("Forge-free exact lock");
    expect(workflow).toContain(
      "former Forge override exception has been removed",
    );
    const npmPublicationJob = workflow.slice(
      workflow.indexOf("  publish-cli-npm:"),
      workflow.indexOf("  promote-windows-release:"),
    );
    expect(npmPublicationJob).toContain(
      "npm run verify:packaging-toolchain -- --require-upstream-compatible",
    );
    expect(npmPublicationJob).toContain(
      "Require the reviewed stable direct packaging toolchain",
    );
    expect(
      npmPublicationJob.indexOf("--require-upstream-compatible"),
    ).toBeLessThan(
      npmPublicationJob.indexOf("Plan a monotonic npm publication"),
    );
  });
});
