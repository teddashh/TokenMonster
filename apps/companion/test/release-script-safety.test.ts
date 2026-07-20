import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  truncate,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import crossZip from "cross-zip";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const rootDirectory = resolve(testDirectory, "../../..");
const installedVerifier = join(
  rootDirectory,
  "scripts",
  "release",
  "verify-installed-companion.mjs"
);
const executableSmoke = join(
  rootDirectory,
  "scripts",
  "release",
  "smoke-companion-executable.mjs"
);
const installedSmoke = join(
  rootDirectory,
  "scripts",
  "release",
  "smoke-installed.mjs"
);

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(rootDirectory, ".release-script-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

function snapshotMaker(
  setup: string,
  fullPackage: string,
  releases: string
) {
  return spawnSync(
    process.execPath,
    [
      installedVerifier,
      "--snapshot-maker",
      "--setup",
      setup,
      "--full-package",
      fullPackage,
      "--releases",
      releases
    ],
    {
      cwd: rootDirectory,
      encoding: "utf8",
      timeout: 10_000
    }
  );
}

function createZip(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    crossZip.zip(inputPath, outputPath, (error) => {
      if (error !== undefined && error !== null) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });
}

describe("release script physical-byte gates", () => {
  it.runIf(process.platform !== "win32")(
    "never skips the installed smoke when invoked through a symlink",
    async () => {
      const directory = await temporaryDirectory();
      const linkedSmoke = join(directory, "smoke-installed.mjs");
      await symlink(installedSmoke, linkedSmoke);

      for (const entryPoint of [installedSmoke, linkedSmoke]) {
        const result = spawnSync(process.execPath, [entryPoint], {
          cwd: rootDirectory,
          encoding: "utf8",
          timeout: 10_000
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("SMOKE usage:");
      }
    }
  );

  it("binds the three co-located maker artifacts and detects byte changes", async () => {
    const directory = await temporaryDirectory();
    const setup = join(directory, "TokenMonsterSetup.exe");
    const fullPackage = join(
      directory,
      "TokenMonster-0.1.0-rc14-full.nupkg"
    );
    const releases = join(directory, "RELEASES");
    await Promise.all([
      writeFile(setup, "setup-v1"),
      writeFile(fullPackage, "package-v1"),
      writeFile(releases, "release-v1")
    ]);

    const before = snapshotMaker(setup, fullPackage, releases);
    expect(before.status).toBe(0);
    const binding = JSON.parse(before.stdout) as {
      files: Array<{ bytes: number; role: string; sha256: string }>;
      makerArtifactBindingContractVersion: number;
    };
    expect(binding.makerArtifactBindingContractVersion).toBe(1);
    expect(binding.files.map(({ role }) => role)).toEqual([
      "setup",
      "full-package",
      "releases"
    ]);

    await writeFile(fullPackage, "package-v2");
    const after = snapshotMaker(setup, fullPackage, releases);
    expect(after.status).toBe(0);
    expect(after.stdout).not.toBe(before.stdout);
  });

  it("compares a real nupkg through one open handle and rejects installed tampering", async () => {
    const directory = await temporaryDirectory();
    const payloadRoot = join(directory, "payload");
    const net45 = join(payloadRoot, "lib", "net45");
    const installRoot = join(directory, "TokenMonster");
    const installedApplication = join(installRoot, "app-0.1.0");
    const fullPackage = join(
      directory,
      "TokenMonster-0.1.0-rc14-full.nupkg"
    );
    await Promise.all([
      mkdir(net45, { recursive: true }),
      mkdir(installedApplication, { recursive: true })
    ]);
    const packagedApplication = join(net45, "application.bin");
    const packagedStub = join(net45, "TokenMonster_ExecutionStub.exe");
    const installedApplicationFile = join(
      installedApplication,
      "application.bin"
    );
    const installedStub = join(installRoot, "TokenMonster.exe");
    await Promise.all([
      writeFile(packagedApplication, "application-bytes"),
      writeFile(packagedStub, "execution-stub-bytes"),
      writeFile(installedApplicationFile, "application-bytes"),
      writeFile(installedStub, "execution-stub-bytes")
    ]);
    await createZip(
      process.platform === "win32" ? payloadRoot : join(payloadRoot, "lib"),
      fullPackage
    );

    const verify = () =>
      spawnSync(
        process.execPath,
        [
          installedVerifier,
          "--full-package",
          fullPackage,
          "--installed-directory",
          installedApplication,
          "--install-root",
          installRoot
        ],
        {
          cwd: rootDirectory,
          encoding: "utf8",
          timeout: 10_000
        }
      );

    const exact = verify();
    expect(exact.status).toBe(0);
    expect(exact.stdout).toContain(
      "installed companion and entry-point files against exact full-nupkg payload bytes"
    );
    expect(exact.stderr).toBe("");

    await writeFile(installedApplicationFile, "tampered-bytes");
    const tampered = verify();
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain(
      "Installed companion bytes differ from the full Squirrel package"
    );
  });

  it("rejects maker artifacts outside one physical directory and oversized input", async () => {
    const directory = await temporaryDirectory();
    const otherDirectory = join(directory, "other");
    await mkdir(otherDirectory);
    const setup = join(directory, "TokenMonsterSetup.exe");
    const fullPackage = join(
      otherDirectory,
      "TokenMonster-0.1.0-rc14-full.nupkg"
    );
    const releases = join(directory, "RELEASES");
    await Promise.all([
      writeFile(setup, "setup"),
      writeFile(fullPackage, "package"),
      writeFile(releases, "release")
    ]);

    const splitDirectory = snapshotMaker(setup, fullPackage, releases);
    expect(splitDirectory.status).not.toBe(0);
    expect(splitDirectory.stderr).toContain(
      "maker artifacts must share one physical directory"
    );

    const localPackage = join(
      directory,
      "TokenMonster-0.1.0-rc14-full.nupkg"
    );
    await writeFile(localPackage, "package");
    await truncate(setup, 512 * 1024 * 1024 + 1);
    const oversized = snapshotMaker(setup, localPackage, releases);
    expect(oversized.status).not.toBe(0);
    expect(oversized.stderr).toContain("oversized file");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a linked maker artifact",
    async () => {
      const directory = await temporaryDirectory();
      const target = join(directory, "real-setup.exe");
      const setup = join(directory, "TokenMonsterSetup.exe");
      const fullPackage = join(
        directory,
        "TokenMonster-0.1.0-rc14-full.nupkg"
      );
      const releases = join(directory, "RELEASES");
      await Promise.all([
        writeFile(target, "setup"),
        writeFile(fullPackage, "package"),
        writeFile(releases, "release")
      ]);
      await symlink(target, setup);

      const result = snapshotMaker(setup, fullPackage, releases);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("must be a physical file");
    }
  );

  it.runIf(process.platform !== "win32")(
    "accepts one dual-gated marker from a physical executable",
    async () => {
      const directory = await temporaryDirectory();
      const executable = join(directory, "smoke-ok.mjs");
      await writeFile(
        executable,
        `#!/usr/bin/env node
if (process.env.TOKENMONSTER_SMOKE !== "1" || !process.argv.includes("--tokenmonster-smoke")) process.exit(2);
process.stdout.write("TOKENMONSTER_SMOKE_OK\\n");
`
      );
      await chmod(executable, 0o700);

      const result = spawnSync(process.execPath, [executableSmoke, executable], {
        cwd: rootDirectory,
        encoding: "utf8",
        timeout: 10_000
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        "Verified packaged companion startup smoke.\n"
      );
    }
  );

  it.runIf(process.platform !== "win32")(
    "bounds close when a descendant holds the output pipes",
    async () => {
      const directory = await temporaryDirectory();
      const executable = join(directory, "smoke-noisy.mjs");
      await writeFile(
        executable,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";
spawn(process.execPath, ["--eval", "setTimeout(() => {}, 30000)"], { stdio: "inherit" });
process.stdout.write("x".repeat(1024 * 1024 + 1));
setTimeout(() => {}, 30000);
`
      );
      await chmod(executable, 0o700);

      const result = spawnSync(process.execPath, [executableSmoke, executable], {
        cwd: rootDirectory,
        encoding: "utf8",
        timeout: 10_000
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("exceeded its output bound");
    }
  );
});
