import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_PACKAGED_COLLECTOR_RESOURCE_BYTES } from "../packaging/package-bounds.mjs";
import {
  assertSquirrelSidecarInventory,
  declaredSidecarPackageFiles,
  packageNameFromLockPath,
  SIDECAR_MAX_FILE_COUNT,
  SIDECAR_MAX_TOTAL_BYTES,
  SIDECAR_MAX_TREE_DEPTH,
  sidecarDependencyClosure,
  stagedSidecarPackagePaths
} from "../../../scripts/companion-packaging-policy.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe("companion packaging policy", () => {
  it("derives only the lockfile production closure with npm-style resolution", () => {
    const packageLock = {
      packages: {
        "node_modules/tokentracker-cli": {
          dependencies: { alpha: "1.0.0", nested: "1.0.0" },
          optionalDependencies: { optional: "1.0.0", absent: "1.0.0" }
        },
        "node_modules/alpha": { dependencies: { shared: "1.0.0" } },
        "node_modules/shared": {},
        "node_modules/tokentracker-cli/node_modules/nested": {},
        "node_modules/optional": {},
        "node_modules/dev-only": { dev: true }
      }
    };

    expect(sidecarDependencyClosure(packageLock)).toEqual([
      "node_modules/alpha",
      "node_modules/optional",
      "node_modules/shared",
      "node_modules/tokentracker-cli",
      "node_modules/tokentracker-cli/node_modules/nested"
    ]);
    expect(() =>
      sidecarDependencyClosure({
        packages: {
          "node_modules/tokentracker-cli": {
            dependencies: { missing: "1.0.0" }
          }
        }
      })
    ).toThrow(/hard dependency missing/u);
  });

  it("expands the declared package files and bins without accepting extras", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-policy-test-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "bin"));
    await mkdir(join(directory, "src", "nested"), { recursive: true });
    await writeFile(join(directory, "package.json"), "{}\n");
    await writeFile(join(directory, "README.md"), "readme\n");
    await writeFile(join(directory, "README.extra.md"), "not declared\n");
    await writeFile(join(directory, "bin", "tracker.js"), "#!/usr/bin/env node\n");
    await writeFile(join(directory, "src", "index.js"), "export {};\n");
    await writeFile(join(directory, "src", "nested", "data.json"), "{}\n");

    await expect(
      declaredSidecarPackageFiles(directory, {
        files: ["src/", "README.md"],
        bin: { tracker: "bin/tracker.js" }
      })
    ).resolves.toEqual([
      "README.md",
      "bin/tracker.js",
      "package.json",
      "src/index.js",
      "src/nested/data.json"
    ]);
  });

  it("enumerates every staged package path, including nested and scoped deps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-stage-test-"));
    temporaryDirectories.push(directory);
    for (const packagePath of [
      ["node_modules", "root"],
      ["node_modules", "@scope", "example"],
      ["node_modules", "root", "node_modules", "nested"]
    ]) {
      const packageDirectory = join(directory, ...packagePath);
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(join(packageDirectory, "package.json"), "{}\n");
    }
    await expect(stagedSidecarPackagePaths(directory)).resolves.toEqual([
      "node_modules/@scope/example",
      "node_modules/root",
      "node_modules/root/node_modules/nested"
    ]);
    await mkdir(join(directory, "node_modules", ".bin"));
    await expect(stagedSidecarPackagePaths(directory)).rejects.toThrow(
      /Unexpected staged sidecar/u
    );
  });

  it("requires the exact Squirrel sidecar byte inventory", () => {
    const expected = new Map([
      ["node_modules/example/index.js", { bytes: 3, sha256: "abc" }]
    ]);
    const archive = new Map([
      ["[Content_Types].xml", { bytes: 1, sha256: "xml" }],
      [
        "lib/net45/resources/sidecar/node_modules/example/index.js",
        { bytes: 3, sha256: "abc" }
      ]
    ]);
    expect(assertSquirrelSidecarInventory(archive, expected)).toBe(1);
    archive.set("lib/net45/resources/sidecar/unexpected", {
      bytes: 1,
      sha256: "extra"
    });
    expect(() => assertSquirrelSidecarInventory(archive, expected)).toThrow(
      /inventory mismatch/u
    );
  });

  it("keeps shared package bounds and scoped lock names explicit", () => {
    expect(SIDECAR_MAX_TREE_DEPTH).toBe(32);
    expect(SIDECAR_MAX_FILE_COUNT).toBe(8_192);
    expect(SIDECAR_MAX_TOTAL_BYTES).toBe(256 * 1_024 * 1_024);
    expect(MAX_PACKAGED_COLLECTOR_RESOURCE_BYTES).toBe(32 * 1_024 * 1_024);
    expect(packageNameFromLockPath("node_modules/@scope/example")).toBe(
      "@scope/example"
    );
    expect(
      packageNameFromLockPath("node_modules/a/node_modules/example")
    ).toBe("example");
  });
});
