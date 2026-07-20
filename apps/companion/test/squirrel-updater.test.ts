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
import { join } from "node:path";

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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("reviewed Squirrel updater", () => {
  it("binds the vendored PE to both independent rebuild confirmations", async () => {
    const binding = await verifyReviewedSquirrelUpdater();
    expect(binding).toMatchObject({
      bytes: 1_840_640,
      sha256:
        "1673161fd4e64d1123fb828a5e5f1580cbe3c3f6b3f0893f50bb920dada473fd",
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
