import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  prepareReviewedSquirrelVendorOverlay,
  projectElectronWinstallerVendorInventoryForArchitecture,
  requireReviewedSquirrelReleaseMode,
  verifyReviewedSquirrelUpdater,
  verifyReviewedSquirrelUpdaterPolicy,
} from "../packaging/squirrel-updater.mjs";

const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const sourcePatchDirectory = join(
  repositoryRoot,
  ".github",
  "patches",
  "squirrel-updater",
);
const vendorReceiptPath = join(
  repositoryRoot,
  "apps",
  "companion",
  "packaging",
  "squirrel-windows",
  "electron-winstaller-5.4.4-vendor-hashes.txt",
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

  it("keeps the locked integration record verifiable without the private binary", async () => {
    await expect(verifyReviewedSquirrelUpdaterPolicy()).resolves.toEqual({
      binary: null,
    });
  });

  it("fails closed when the private reviewed binary is absent", async () => {
    await expect(verifyReviewedSquirrelUpdater()).rejects.toThrow(
      /not distributed in this repository/u,
    );
  });

  it("projects only the receipt-bound 7-Zip aliases for an arm64 host", async () => {
    const canonicalInventory = await readFile(vendorReceiptPath, "utf8");
    const arm64Inventory =
      projectElectronWinstallerVendorInventoryForArchitecture(
        canonicalInventory,
        "arm64",
      );
    const canonicalLines = canonicalInventory.trimEnd().split("\n");
    const arm64Lines = arm64Inventory.trimEnd().split("\n");
    const bindingFor = (lines: string[], name: string) => {
      const line = lines.find((candidate) => candidate.endsWith(` ${name}`));
      expect(line).toBeDefined();
      return line?.slice(0, line.lastIndexOf(" "));
    };

    expect(arm64Lines).toHaveLength(33);
    expect(bindingFor(arm64Lines, "7z.exe")).toBe(
      bindingFor(canonicalLines, "7z-arm64.exe"),
    );
    expect(bindingFor(arm64Lines, "7z.dll")).toBe(
      bindingFor(canonicalLines, "7z-arm64.dll"),
    );
    expect(
      canonicalLines
        .filter((line, index) => line !== arm64Lines[index])
        .map((line) => line.slice(line.lastIndexOf(" ") + 1)),
    ).toEqual(["7z.dll", "7z.exe"]);
    expect(
      projectElectronWinstallerVendorInventoryForArchitecture(
        canonicalInventory,
        "x64",
      ),
    ).toBe(canonicalInventory);
  });

  it("fails closed for an unsupported electron-winstaller host architecture", async () => {
    const canonicalInventory = await readFile(vendorReceiptPath, "utf8");

    expect(() =>
      projectElectronWinstallerVendorInventoryForArchitecture(
        canonicalInventory,
        "riscv64",
      ),
    ).toThrow(/only x64 or arm64/u);
  });

  it("refuses to create a vendor overlay without the private reviewed binary", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "tokenmonster-squirrel-overlay-test-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const overlayDirectory = join(temporaryRoot, "vendor");

    await expect(
      prepareReviewedSquirrelVendorOverlay(overlayDirectory, "internal"),
    ).rejects.toThrow(/not distributed in this repository/u);
  });

  it("keeps signed packaging closed while signing credentials are unaudited", () => {
    expect(() => requireReviewedSquirrelReleaseMode("internal")).not.toThrow();
    expect(() => requireReviewedSquirrelReleaseMode("signed")).toThrow(
      /unsigned-only pending audited signing credentials/u,
    );
    expect(() => requireReviewedSquirrelReleaseMode("preview")).toThrow(
      /must be internal or signed/u,
    );
  });
});
