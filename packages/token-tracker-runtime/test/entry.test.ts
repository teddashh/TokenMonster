import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PINNED_TOKEN_TRACKER_VERSION,
  resolveTokenTrackerEntry
} from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

async function fixture(): Promise<Readonly<{
  root: string;
  packageRoot: string;
  manifestPath: string;
  entryPath: string;
}>> {
  // realpath: macOS tmpdir lives behind a symlink (/var → /private/var) and
  // resolveTokenTrackerEntry returns canonical paths.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tokenmonster-runtime-entry-"))
  );
  directories.push(root);
  const packageRoot = join(root, "package");
  const manifestPath = join(packageRoot, "package.json");
  const entryPath = join(packageRoot, "bin", "tracker.js");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await writeFile(entryPath, "#!/usr/bin/env node\n");
  await writeManifest(manifestPath, {});
  return Object.freeze({ root, packageRoot, manifestPath, entryPath });
}

async function writeManifest(
  manifestPath: string,
  overrides: Readonly<Record<string, unknown>>
): Promise<void> {
  await writeFile(
    manifestPath,
    JSON.stringify({
      name: "tokentracker-cli",
      version: PINNED_TOKEN_TRACKER_VERSION,
      bin: { "tokentracker-cli": "bin/tracker.js" },
      ...overrides
    })
  );
}

describe("TokenTracker entry resolution", () => {
  it("returns the real declared bin for a valid manifest", async () => {
    const input = await fixture();
    await expect(resolveTokenTrackerEntry(input.manifestPath)).resolves.toBe(
      input.entryPath
    );
  });

  it("rejects a package with the wrong name", async () => {
    const input = await fixture();
    await writeManifest(input.manifestPath, { name: "not-tokentracker" });
    await expect(resolveTokenTrackerEntry(input.manifestPath)).rejects.toMatchObject(
      { code: "version-mismatch" }
    );
  });

  it("rejects a package with the wrong version", async () => {
    const input = await fixture();
    await writeManifest(input.manifestPath, { version: "0.0.0" });
    await expect(resolveTokenTrackerEntry(input.manifestPath)).rejects.toMatchObject(
      { code: "version-mismatch" }
    );
  });

  it("rejects an absolute declared bin", async () => {
    const input = await fixture();
    await writeManifest(input.manifestPath, {
      bin: { "tokentracker-cli": resolve(input.entryPath) }
    });
    await expect(resolveTokenTrackerEntry(input.manifestPath)).rejects.toMatchObject(
      { code: "runtime-not-found" }
    );
  });

  it("rejects a declared bin that escapes through a symlink", async () => {
    const input = await fixture();
    const outsideDirectory = join(input.root, "outside");
    await mkdir(outsideDirectory);
    await writeFile(join(outsideDirectory, "tracker.js"), "outside\n");
    await rm(join(input.packageRoot, "bin"), { recursive: true });
    await symlink(outsideDirectory, join(input.packageRoot, "bin"), "junction");
    await expect(resolveTokenTrackerEntry(input.manifestPath)).rejects.toMatchObject(
      { code: "runtime-not-found" }
    );
  });

  it("rejects a missing declared bin", async () => {
    const input = await fixture();
    await rm(input.entryPath);
    await expect(resolveTokenTrackerEntry(input.manifestPath)).rejects.toMatchObject(
      { code: "runtime-not-found" }
    );
  });
});
