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
  ensurePrivateDirectoryAt,
  readPrivateJson,
  readPrivateText,
  resolveContainedRuntimePath,
  runtimeRelativePathIsSafe,
} from "../contract.mjs";

function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "tokenmonster-agent-"));
  chmodSync(directory, 0o700);
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("private reads accept only bounded private regular files", () => {
  withFixture((directory) => {
    const path = join(directory, "state.json");
    writeFileSync(path, '{"state":"ready"}\n', { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.deepEqual(readPrivateJson(path), { state: "ready" });
    writeFileSync(path, "123456789", { mode: 0o600 });
    assert.throws(
      () => readPrivateText(path, 8),
      /agent_runtime_file_oversized/u,
    );
  });
});

test("private reads reject leaf and parent symlinks", (context) => {
  withFixture((directory) => {
    const target = join(directory, "target.json");
    const leaf = join(directory, "leaf.json");
    writeFileSync(target, "{}\n", { mode: 0o600 });
    chmodSync(target, 0o600);
    try {
      symlinkSync(target, leaf);
    } catch (error) {
      if (error?.code === "EPERM") {
        context.skip("symbolic links unavailable");
        return;
      }
      throw error;
    }
    assert.throws(() => readPrivateText(leaf), /agent_runtime_file_invalid/u);

    const actual = join(directory, "actual");
    const linked = join(directory, "linked");
    mkdirSync(actual, { mode: 0o700 });
    symlinkSync(actual, linked, "dir");
    assert.throws(
      () => readPrivateText(join(linked, "state.json")),
      /agent_runtime_directory_invalid/u,
    );
  });
});

test(
  "existing permissive directories and files fail closed",
  { skip: process.platform === "win32" },
  () => {
    withFixture((directory) => {
      const permissiveDirectory = join(directory, "runtime");
      mkdirSync(permissiveDirectory, { mode: 0o755 });
      chmodSync(permissiveDirectory, 0o755);
      assert.throws(
        () => ensurePrivateDirectoryAt(permissiveDirectory),
        /agent_runtime_permissions_invalid/u,
      );
      const permissiveFile = join(directory, "state.json");
      writeFileSync(permissiveFile, "{}\n", { mode: 0o644 });
      chmodSync(permissiveFile, 0o644);
      assert.throws(
        () => readPrivateText(permissiveFile),
        /agent_runtime_permissions_invalid/u,
      );
    });
  },
);

test("corrupt JSON and runtime path escape fail closed", () => {
  withFixture((directory) => {
    const path = join(directory, "state.json");
    writeFileSync(path, "{bad", { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.throws(() => readPrivateJson(path), /agent_runtime_json_invalid/u);
    assert.equal(runtimeRelativePathIsSafe("../state.json"), false);
    assert.equal(runtimeRelativePathIsSafe(".agent-runtime/../x"), false);
    assert.throws(
      () =>
        resolveContainedRuntimePath(
          directory,
          "../state.json",
        ),
      /agent_runtime_path_invalid/u,
    );
  });
});
