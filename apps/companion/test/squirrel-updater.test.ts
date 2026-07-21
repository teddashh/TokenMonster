import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  finalizeReviewedSquirrelVendorOverlay,
  prepareReviewedSquirrelVendorOverlay,
  requireReviewedSquirrelReleaseMode,
  REVIEWED_SQUIRREL_UPDATER,
  verifyElectronWinstallerVendor,
  verifyReviewedSquirrelUpdater,
  verifyReviewedSquirrelVendorOverlay,
} from "../packaging/squirrel-updater.mjs";

const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const sourcePatchDirectory = join(
  repositoryRoot,
  ".github",
  "patches",
  "squirrel-updater",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("reviewed Squirrel updater", () => {
  it("binds the next candidate source patches before remote execution", async () => {
    const patches = [
      {
        bytes: 4_545,
        name: "retry-delete-tree.patch",
        sha256:
          "81a6bb631b7459773fbad1b4fbe7a878c698ab9e6016899a3f422b3fa32e2b1a",
      },
      {
        bytes: 640,
        name: "xdt-3.1.0-squirrel.patch",
        sha256:
          "a781b27842680ae01b70b7308ea5a5154e3897e94c7c645a9cd172385fcc0137",
      },
      {
        bytes: 665,
        name: "xdt-3.1.0-nuget-core.patch",
        sha256:
          "31a098f17a1409f03ff270bc819b7cebf8bcf94ca872f1484aa2699d6e5a4dce",
      },
    ] as const;

    const contents = await Promise.all(
      patches.map(async (patch) => {
        const bytes = await readFile(join(sourcePatchDirectory, patch.name));
        expect(bytes.byteLength).toBe(patch.bytes);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          patch.sha256,
        );
        const source = bytes.toString("utf8");
        expect(source).not.toContain("\r");
        return source;
      }),
    );

    expect(contents[0]).toContain("const int attempts = 32;");
    expect(contents[0]).toContain("const int delayMilliseconds = 250;");
    expect(contents[0]).toContain("await Task.Delay(5000);");
    expect(contents[0]).toContain("Task.Delay(15000)");
    expect(contents[0]).toContain(
      "DeleteDirectoryOrJustGiveUpRetriesTransientFileLocks",
    );
    expect(contents[0]).toContain(
      "DeleteDirectoryOrJustGiveUpReturnsAfterBoundedRetriesForPermanentFileLocks",
    );
    expect(contents[0]).toContain("FileShare.None");
    expect(contents[1]).toContain(
      '<PackageReference Include="Microsoft.Web.Xdt" Version="3.1.0" />',
    );
    expect(contents[2]).toContain("GIT binary patch");
    expect(contents[2]).toContain(
      "a5972a3ef600f41d2ca056872321e2c20757357d..a00ea88e7de4b53cf02ef5611de6e05ded2d7554",
    );
    expect(contents[2]).toContain(
      "8cceb007316817f8855d5fe7e99fc725d0534dfc..7b537c87913ae0f241c71e7d34889df098181d9d",
    );
  });

  it("binds the vendored PE to the locked rebuild confirmation", async () => {
    const binding = await verifyReviewedSquirrelUpdater();
    expect(binding).toMatchObject({
      bytes: 1_841_664,
      sha256:
        "83b754a9b24742675678c5d8fa024a8140c2d18eb640116a87a364f0a897388a",
    });
    expect(binding.bytes).toBe(REVIEWED_SQUIRREL_UPDATER.bytes);
    expect(binding.sha256).toBe(REVIEWED_SQUIRREL_UPDATER.sha256);
  });

  it("creates an exact disposable vendor overlay without changing node_modules", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "tokenmonster-squirrel-overlay-test-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const overlayDirectory = join(temporaryRoot, "vendor");
    const sourceBefore = await verifyElectronWinstallerVendor();

    const prepared = await prepareReviewedSquirrelVendorOverlay(
      overlayDirectory,
      "internal",
    );

    expect(prepared).toEqual({
      directory: overlayDirectory,
      updaterSha256: REVIEWED_SQUIRREL_UPDATER.sha256,
    });
    await expect(
      verifyReviewedSquirrelVendorOverlay(overlayDirectory),
    ).resolves.toEqual(prepared);
    const updaterPath = join(overlayDirectory, "Squirrel.exe");
    const updaterStat = await lstat(updaterPath, { bigint: true });
    const stockUpdaterStat = await lstat(
      join(sourceBefore.directory, "Squirrel.exe"),
      { bigint: true },
    );
    const updater = await readFile(updaterPath);
    expect(updaterStat.isFile()).toBe(true);
    expect(updaterStat.isSymbolicLink()).toBe(false);
    expect([updaterStat.dev, updaterStat.ino]).not.toEqual([
      stockUpdaterStat.dev,
      stockUpdaterStat.ino,
    ]);
    expect(updater.byteLength).toBe(REVIEWED_SQUIRREL_UPDATER.bytes);
    expect(createHash("sha256").update(updater).digest("hex")).toBe(
      REVIEWED_SQUIRREL_UPDATER.sha256,
    );
    await expect(verifyElectronWinstallerVendor()).resolves.toEqual(
      sourceBefore,
    );
  });

  it("removes only Squirrel's bounded releasify log before final verification", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "tokenmonster-squirrel-finalize-test-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const overlayDirectory = join(temporaryRoot, "vendor");
    await prepareReviewedSquirrelVendorOverlay(overlayDirectory, "internal");
    const logPath = join(overlayDirectory, "Squirrel-Releasify.log");
    await writeFile(logPath, "reviewed test diagnostic\n", "utf8");

    await expect(
      finalizeReviewedSquirrelVendorOverlay(overlayDirectory),
    ).resolves.toEqual({
      directory: overlayDirectory,
      updaterSha256: REVIEWED_SQUIRREL_UPDATER.sha256,
    });
    await expect(lstat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects any other maker residue", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "tokenmonster-squirrel-residue-test-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const overlayDirectory = join(temporaryRoot, "vendor");
    await prepareReviewedSquirrelVendorOverlay(overlayDirectory, "internal");
    await writeFile(join(overlayDirectory, "unexpected.log"), "no\n", "utf8");

    await expect(
      finalizeReviewedSquirrelVendorOverlay(overlayDirectory),
    ).rejects.toThrow(/unexpected file inventory/u);
  });

  it("rejects an oversized Squirrel releasify log", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "tokenmonster-squirrel-log-bound-test-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const overlayDirectory = join(temporaryRoot, "vendor");
    await prepareReviewedSquirrelVendorOverlay(overlayDirectory, "internal");
    const logPath = join(overlayDirectory, "Squirrel-Releasify.log");
    await writeFile(logPath, "", "utf8");
    await truncate(logPath, 4 * 1024 * 1024 + 1);

    await expect(
      finalizeReviewedSquirrelVendorOverlay(overlayDirectory),
    ).rejects.toThrow(/not a bounded physical file/u);
  });

  it("keeps signed/public packaging closed while redistribution review is open", () => {
    expect(() => requireReviewedSquirrelReleaseMode("internal")).not.toThrow();
    expect(() => requireReviewedSquirrelReleaseMode("signed")).toThrow(
      /internal-only pending redistribution review/u,
    );
    expect(() => requireReviewedSquirrelReleaseMode("preview")).toThrow(
      /must be internal or signed/u,
    );
  });
});
