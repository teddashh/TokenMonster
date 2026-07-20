import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  UiLocalePreferenceError,
  loadUiLocalePreference,
  parseUiLocalePreference,
  saveUiLocalePreference,
  uiLocalePreferencePath,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function privateDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

describe("UI locale preference store", () => {
  it("accepts only the exact versioned content-free shape", () => {
    expect(
      parseUiLocalePreference({
        schemaVersion: 1,
        revision: 2,
        locale: "en",
      }),
    ).toEqual({ schemaVersion: 1, revision: 2, locale: "en" });
    for (const invalid of [
      null,
      { schemaVersion: 1, revision: 0, locale: "fr" },
      { schemaVersion: 1, revision: -1, locale: "en" },
      { schemaVersion: 1, revision: 0, locale: "en", path: "/private" },
    ]) {
      expect(() => parseUiLocalePreference(invalid)).toThrow(
        UiLocalePreferenceError,
      );
    }
  });

  it("uses goal-idempotent CAS and writes canonical private bytes", async () => {
    const directory = await privateDirectory("tokenmonster-locale-store-");
    const path = uiLocalePreferencePath(join(directory, "progression-v1.json"));
    await expect(loadUiLocalePreference(path)).resolves.toEqual({
      schemaVersion: 1,
      revision: 0,
      locale: "zh-TW",
    });
    await expect(saveUiLocalePreference(path, "en", 0)).resolves.toEqual({
      schemaVersion: 1,
      revision: 1,
      locale: "en",
    });
    // A response-lost retry with the stale revision is idempotent because the
    // requested goal is already the authoritative value.
    await expect(saveUiLocalePreference(path, "en", 0)).resolves.toEqual({
      schemaVersion: 1,
      revision: 1,
      locale: "en",
    });
    await expect(saveUiLocalePreference(path, "zh-TW", 0)).rejects.toMatchObject(
      { code: "revision-conflict" },
    );
    expect(await readFile(path, "utf8")).toBe(
      '{"schemaVersion":1,"revision":1,"locale":"en"}\n',
    );
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves noncanonical or corrupt bytes and fails closed", async () => {
    const directory = await privateDirectory("tokenmonster-locale-corrupt-");
    const path = uiLocalePreferencePath(join(directory, "progression-v1.json"));
    const corruptions = [
      '{ "schemaVersion": 1, "revision": 0, "locale": "en" }\n',
      '{"schemaVersion":1,"revision":0,"locale":"zh-TW","locale":"en"}\n',
      '{"schemaVersion":1,"revision":0,"locale":"en"}',
      "not-json\n",
    ];
    for (const bytes of corruptions) {
      await writeFile(path, bytes, { mode: 0o600 });
      await chmod(path, 0o600);
      await expect(loadUiLocalePreference(path)).rejects.toMatchObject({
        code: "storage-unavailable",
      });
      await expect(saveUiLocalePreference(path, "en", 0)).rejects.toMatchObject(
        { code: "storage-unavailable" },
      );
      expect(await readFile(path, "utf8")).toBe(bytes);
    }
  });

  it("rejects symlinked preference files and parent directories", async () => {
    const root = await privateDirectory("tokenmonster-locale-symlink-");
    const realDirectory = join(root, "real");
    await mkdir(realDirectory, { mode: 0o700 });
    const realFile = join(realDirectory, "real.json");
    await writeFile(
      realFile,
      '{"schemaVersion":1,"revision":0,"locale":"en"}\n',
      { mode: 0o600 },
    );
    const fileLink = join(realDirectory, "ui-locale-preference.json");
    await symlink(realFile, fileLink);
    await expect(loadUiLocalePreference(fileLink)).rejects.toMatchObject({
      code: "storage-unavailable",
    });

    const directoryLink = join(root, "linked");
    await symlink(realDirectory, directoryLink, "dir");
    await expect(
      loadUiLocalePreference(join(directoryLink, "ui-locale-preference.json")),
    ).rejects.toMatchObject({ code: "storage-unavailable" });
  });
});
