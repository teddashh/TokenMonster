import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  symlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensurePrivateChildDirectory,
  ensurePrivateCollectorDirectory,
  verifyPrivateChildDirectory,
  verifyPrivateCollectorDirectory
} from "../src/main/private-directory.js";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tokenmonster-private-dir-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("private collector directory", () => {
  it("creates a generic private storage child and rejects unsafe components", async () => {
    const root = await temporaryRoot();
    const target = await ensurePrivateChildDirectory(root, ["data"]);
    expect(target).toBe(join(root, "data"));
    await expect(
      verifyPrivateChildDirectory(root, target ?? "", ["data"])
    ).resolves.toBe(true);
    await expect(
      ensurePrivateChildDirectory(root, ["..", "outside"])
    ).resolves.toBeNull();
  });

  it("creates and revalidates only the fixed private child path", async () => {
    const root = await temporaryRoot();
    const target = await ensurePrivateCollectorDirectory(root);
    expect(target).toBe(join(root, "collector", "tokscale"));
    await expect(
      verifyPrivateCollectorDirectory(root, target ?? "")
    ).resolves.toBe(true);
    await expect(
      verifyPrivateCollectorDirectory(root, join(root, "elsewhere"))
    ).resolves.toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a group- or world-writable storage root",
    async () => {
      const root = await temporaryRoot();
      await chmod(root, 0o777);
      await expect(
        ensurePrivateChildDirectory(root, ["data"])
      ).resolves.toBeNull();
      await expect(ensurePrivateCollectorDirectory(root)).resolves.toBeNull();
    }
  );

  it.skipIf(process.platform === "win32")(
    "rejects a generic storage child symlink",
    async () => {
      const root = await temporaryRoot();
      const outside = await temporaryRoot();
      await symlink(outside, join(root, "data"), "dir");
      await expect(
        ensurePrivateChildDirectory(root, ["data"])
      ).resolves.toBeNull();
      await expect(
        verifyPrivateChildDirectory(root, join(root, "data"), ["data"])
      ).resolves.toBe(false);
    }
  );

  it.skipIf(process.platform === "win32")(
    "rejects an intermediate symlink without creating below its target",
    async () => {
      const root = await temporaryRoot();
      const outside = await temporaryRoot();
      await symlink(outside, join(root, "collector"), "dir");

      await expect(ensurePrivateCollectorDirectory(root)).resolves.toBeNull();
      await expect(
        verifyPrivateCollectorDirectory(
          root,
          join(root, "collector", "tokscale")
        )
      ).resolves.toBe(false);
      await expect(mkdir(join(outside, "tokscale"))).resolves.toBeUndefined();
    }
  );

  it.skipIf(process.platform === "win32")(
    "rejects a final symlink and detects replacement after creation",
    async () => {
      const root = await temporaryRoot();
      const outside = await temporaryRoot();
      await mkdir(join(root, "collector"), { mode: 0o700 });
      await symlink(outside, join(root, "collector", "tokscale"), "dir");
      await expect(ensurePrivateCollectorDirectory(root)).resolves.toBeNull();
      await expect(
        verifyPrivateCollectorDirectory(
          root,
          join(root, "collector", "tokscale")
        )
      ).resolves.toBe(false);
    }
  );
});
