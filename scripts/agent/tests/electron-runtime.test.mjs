import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rootDirectory } from "../contract.mjs";
import {
  resolveElectronInstaller,
  verifyReviewedElectronPackageDirectory,
} from "../electron-runtime.mjs";

test("the locked Electron installer files are byte-reviewed", () => {
  const sourceDirectory = join(rootDirectory, "node_modules", "electron");
  const fixture = mkdtempSync(join(tmpdir(), "tokenmonster-electron-"));
  try {
    mkdirSync(fixture, { recursive: true });
    for (const name of [
      "package.json",
      "install.js",
      "checksums.json",
    ]) {
      copyFileSync(join(sourceDirectory, name), join(fixture, name));
    }
    assert.equal(
      verifyReviewedElectronPackageDirectory(fixture),
      fixture,
    );
    writeFileSync(join(fixture, "install.js"), "mutated");
    assert.throws(
      () => verifyReviewedElectronPackageDirectory(fixture),
      /agent_electron_package_invalid/u,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the reviewed source task resolves only the locked installer", () => {
  assert.equal(
    resolveElectronInstaller(),
    join(rootDirectory, "node_modules", "electron", "install.js"),
  );
});
