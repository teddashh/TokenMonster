import {
  copyFile,
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Format,
  NtExecutable,
  NtExecutableResource,
  Resource,
} from "resedit";
import { afterEach, describe, expect, it } from "vitest";

import {
  markSquirrelAwareExecutable,
  verifySquirrelAwareExecutable,
} from "../packaging/squirrel-awareness.mjs";

const require = createRequire(import.meta.url);
const squirrelAwareFixture = require.resolve(
  "electron-winstaller/vendor/Setup.exe",
);
const authenticodeFixture = require.resolve(
  "@electron/windows-sign/vendor/signtool.exe",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function copiedFixture(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "tokenmonster-squirrel-awareness-")),
  );
  temporaryDirectories.push(directory);
  const executablePath = join(directory, "Setup.exe");
  await copyFile(squirrelAwareFixture, executablePath);
  return executablePath;
}

async function writeSquirrelAwareVersion(
  executablePath: string,
  value: string,
): Promise<void> {
  const executable = NtExecutable.from(await readFile(executablePath));
  const resources = NtExecutableResource.from(executable);
  const versions = Resource.VersionInfo.fromEntries(resources.entries);
  if (versions.length !== 1) {
    throw new Error("Test fixture must have exactly one version resource.");
  }
  const version = versions[0];
  if (version === undefined) {
    throw new Error("Test fixture version resource is unavailable.");
  }
  const languages = version.getAllLanguagesForStringValues();
  if (languages.length !== 1) {
    throw new Error("Test fixture must have exactly one string language.");
  }
  const language = languages[0];
  if (language === undefined) {
    throw new Error("Test fixture string language is unavailable.");
  }
  version.setStringValue(language, "SquirrelAwareVersion", value, false);
  version.outputToResourceEntries(resources.entries);
  resources.outputResource(executable);
  await writeFile(executablePath, Buffer.from(executable.generate()));
}

async function appendTestCertificateTable(
  executablePath: string,
): Promise<void> {
  const bytes = Buffer.from(await readFile(executablePath));
  const dosHeader = Format.ImageDosHeader.from(bytes);
  const ntHeaders = Format.ImageNtHeaders.from(bytes, dosHeader.newHeaderAddress);
  const certificateLength = 8;
  ntHeaders.optionalHeaderDataDirectory.set(
    Format.ImageDirectoryEntry.Certificate,
    {
      size: certificateLength,
      virtualAddress: bytes.length,
    },
  );
  await writeFile(
    executablePath,
    Buffer.concat([bytes, Buffer.alloc(certificateLength)]),
  );
}

async function changeVersionResourceId(
  executablePath: string,
  id: number,
): Promise<void> {
  const executable = NtExecutable.from(await readFile(executablePath));
  const resources = NtExecutableResource.from(executable);
  const versionEntries = resources.entries.filter((entry) => entry.type === 16);
  if (versionEntries.length !== 1 || versionEntries[0] === undefined) {
    throw new Error("Test fixture must have one version-resource entry.");
  }
  versionEntries[0].id = id;
  resources.outputResource(executable);
  await writeFile(executablePath, Buffer.from(executable.generate()));
}

describe("Squirrel awareness metadata", () => {
  it("restores and verifies the exact Squirrel 2.0.1 marker", async () => {
    const executablePath = await copiedFixture();

    await expect(
      verifySquirrelAwareExecutable(executablePath),
    ).resolves.toEqual({
      language: "040904B0",
      version: "1",
    });

    await writeSquirrelAwareVersion(executablePath, "0");
    await expect(
      verifySquirrelAwareExecutable(executablePath),
    ).rejects.toThrow(/lacks its exact Squirrel awareness marker/u);

    await expect(markSquirrelAwareExecutable(executablePath)).resolves.toEqual(
      {
        language: "040904B0",
        version: "1",
      },
    );
    await expect(
      verifySquirrelAwareExecutable(executablePath),
    ).resolves.toEqual({
      language: "040904B0",
      version: "1",
    });
  });

  it("rejects a hard-linked executable before reading or changing it", async () => {
    const executablePath = await copiedFixture();
    const linkedPath = join(executablePath, "..", "Setup-linked.exe");
    await link(executablePath, linkedPath);

    await expect(
      verifySquirrelAwareExecutable(executablePath),
    ).rejects.toThrow(/one bounded physical file/u);
    await expect(markSquirrelAwareExecutable(linkedPath)).rejects.toThrow(
      /one bounded physical file/u,
    );
  });

  it("binds a stable physical file through a canonicalized directory alias", async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "tokenmonster-squirrel-alias-")),
    );
    temporaryDirectories.push(directory);
    const physicalDirectory = join(directory, "physical");
    const aliasDirectory = join(directory, "alias");
    await mkdir(physicalDirectory);
    await symlink(physicalDirectory, aliasDirectory, "junction");
    const physicalExecutable = join(physicalDirectory, "Setup.exe");
    await copyFile(squirrelAwareFixture, physicalExecutable);

    await expect(
      verifySquirrelAwareExecutable(join(aliasDirectory, "Setup.exe")),
    ).resolves.toEqual({ language: "040904B0", version: "1" });
  });

  it("rejects a marker that exceeds Squirrel's version-resource byte bound", async () => {
    const executablePath = await copiedFixture();
    await writeSquirrelAwareVersion(executablePath, "1".repeat(4_096));

    await expect(
      verifySquirrelAwareExecutable(executablePath),
    ).rejects.toThrow(/Squirrel version-resource byte bound/u);
    await expect(markSquirrelAwareExecutable(executablePath)).rejects.toThrow(
      /Squirrel version-resource byte bound/u,
    );
  });

  it("verifies but never rewrites a PE with a certificate table", async () => {
    const executablePath = await copiedFixture();
    await appendTestCertificateTable(executablePath);

    await expect(
      verifySquirrelAwareExecutable(executablePath),
    ).resolves.toEqual({ language: "040904B0", version: "1" });
    await expect(markSquirrelAwareExecutable(executablePath)).rejects.toThrow(
      /malformed PE resources/u,
    );
  });

  it("rejects a nonstandard version-resource identifier", async () => {
    const executablePath = await copiedFixture();
    await changeVersionResourceId(executablePath, 2);

    await expect(
      verifySquirrelAwareExecutable(executablePath),
    ).rejects.toThrow(/one standard version-resource entry/u);
    await expect(markSquirrelAwareExecutable(executablePath)).rejects.toThrow(
      /one standard version-resource entry/u,
    );
  });

  it("reads a real signed PE without permitting signed-byte mutation", async () => {
    const executablePath = await copiedFixture();
    const signedBytes = await readFile(authenticodeFixture);
    await writeFile(executablePath, signedBytes);

    await expect(
      verifySquirrelAwareExecutable(executablePath),
    ).rejects.toThrow(/lacks its exact Squirrel awareness marker/u);
    await expect(markSquirrelAwareExecutable(executablePath)).rejects.toThrow(
      /malformed PE resources/u,
    );
    await expect(readFile(executablePath)).resolves.toEqual(signedBytes);
  });
});
