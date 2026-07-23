import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  hashRegularFile,
  inspectInstallTarget,
} from "../dependency-proof.mjs";

function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "tokenmonster-proof-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("bounded digest accepts a regular file and rejects oversize", () => {
  withFixture((directory) => {
    const path = join(directory, "lock.json");
    writeFileSync(path, "locked");
    assert.match(hashRegularFile(path), /^[0-9a-f]{64}$/u);
    assert.throws(
      () => hashRegularFile(path, 5),
      /agent_dependency_file_oversized/u,
    );
  });
});

test("dependency digest and install target reject symlinks", (context) => {
  withFixture((directory) => {
    const target = join(directory, "target");
    const link = join(directory, "link");
    writeFileSync(target, "locked");
    try {
      symlinkSync(target, link);
    } catch (error) {
      if (error?.code === "EPERM") {
        context.skip("symbolic links unavailable");
        return;
      }
      throw error;
    }
    assert.throws(
      () => hashRegularFile(link),
      /agent_dependency_file_invalid/u,
    );

    const modulesTarget = join(directory, "modules-target");
    const modulesLink = join(directory, "node_modules");
    mkdirSync(modulesTarget);
    symlinkSync(modulesTarget, modulesLink, "dir");
    assert.throws(
      () => inspectInstallTarget(modulesLink),
      /agent_dependency_target_invalid/u,
    );
  });
});

test("npm ci target must be a real directory when present", () => {
  withFixture((directory) => {
    const missing = join(directory, "missing");
    assert.deepEqual(inspectInstallTarget(missing), { exists: false });
    const file = join(directory, "node_modules");
    writeFileSync(file, "not a directory");
    assert.throws(
      () => inspectInstallTarget(file),
      /agent_dependency_target_invalid/u,
    );
    rmSync(file);
    mkdirSync(file);
    assert.deepEqual(inspectInstallTarget(file), { exists: true });
  });
});
