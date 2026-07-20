import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
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
    const fullPackage = join(directory, "TokenMonster-0.1.0-rc14-full.nupkg");
    await Promise.all([
      mkdir(net45, { recursive: true }),
      mkdir(installedApplication, { recursive: true })
    ]);
    const packagedApplication = join(net45, "application.bin");
    const packagedUpdater = join(net45, "squirrel.exe");
    const packagedStub = join(net45, "TokenMonster_ExecutionStub.exe");
    const installedApplicationFile = join(
      installedApplication,
      "application.bin"
    );
    const installedUpdater = join(installedApplication, "squirrel.exe");
    const installedStub = join(installRoot, "TokenMonster.exe");
    const installedRootUpdater = join(installRoot, "Update.exe");
    const updateLog = join(installedApplication, "Squirrel-UpdateSelf.log");
    const updateLogQuarantine = join(
      installedApplication,
      ".tokenmonster-squirrel-update-self.verifying"
    );
    await Promise.all([
      writeFile(packagedApplication, "application-bytes"),
      writeFile(packagedUpdater, "squirrel-updater-bytes"),
      writeFile(packagedStub, "execution-stub-bytes"),
      writeFile(installedApplicationFile, "application-bytes"),
      writeFile(installedUpdater, "squirrel-updater-bytes"),
      writeFile(installedStub, "execution-stub-bytes"),
      writeFile(installedRootUpdater, "squirrel-updater-bytes")
    ]);
    await createZip(
      process.platform === "win32" ? payloadRoot : join(payloadRoot, "lib"),
      fullPackage
    );

    const writeUpdateSelfLog = async (
      parentEvent = "Program: About to wait for parent PID 1234",
      sourceUpdater = resolve(
        dirname(installRoot),
        "SquirrelTemp",
        "Update.exe"
      ),
      includeBom = true,
      extraLine?: string
    ) => {
      await Promise.all([
        rm(updateLog, { force: true }),
        rm(updateLogQuarantine, { force: true })
      ]);
      const lines = [
        `[20/07/26 12:00:00] info: Program: Starting Squirrel Updater: --updateSelf=${sourceUpdater}`,
        `[20/07/26 12:00:01] info: ${parentEvent}`,
        "[20/07/26 12:00:02] info: Program: Finished Squirrel Updater"
      ];
      if (extraLine !== undefined) lines.push(extraLine);
      const encodedLog = Buffer.from([...lines, ""].join("\r\n"), "utf8");
      await writeFile(
        updateLog,
        includeBom
          ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encodedLog])
          : encodedLog
      );
    };
    const invokeVerifier = () =>
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
    const verify = async (parentEvent?: string) => {
      await writeUpdateSelfLog(parentEvent);
      return invokeVerifier();
    };

    const exact = await verify();
    expect(exact.status).toBe(0);
    expect(exact.stdout).toContain(
      "installed companion, updater, and entry-point files against exact full-nupkg payload bytes"
    );
    expect(exact.stderr).toBe("");
    await expect(access(updateLog)).rejects.toThrow();
    await expect(access(updateLogQuarantine)).rejects.toThrow();

    const alternativeParentEvent = await verify(
      "Program: Parent PID 5678 no longer valid - ignoring"
    );
    expect(alternativeParentEvent.status).toBe(0);

    await writeFile(installedApplicationFile, "tampered-bytes");
    const tampered = await verify();
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain(
      "Installed companion bytes differ from the full Squirrel package"
    );

    await Promise.all([
      writeFile(installedApplicationFile, "application-bytes"),
      writeFile(join(installedApplication, "unexpected.bin"), "unexpected")
    ]);
    const unexpected = await verify();
    expect(unexpected.status).not.toBe(0);
    expect(unexpected.stderr).toContain("expected 2, installed 3");
    expect(unexpected.stderr).not.toContain("unexpected.bin");

    await Promise.all([
      rm(join(installedApplication, "unexpected.bin")),
      rm(installedApplicationFile)
    ]);
    const missing = await verify();
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("expected 2, installed 1");

    await Promise.all([
      writeFile(installedApplicationFile, "application-bytes"),
      writeFile(installedRootUpdater, "tampered-updater-bytes")
    ]);
    const tamperedUpdater = await verify();
    expect(tamperedUpdater.status).not.toBe(0);
    expect(tamperedUpdater.stderr).toContain(
      "Installed Squirrel updater differs from the full-package Squirrel executable"
    );

    await writeFile(installedRootUpdater, "squirrel-updater-bytes");
    await writeUpdateSelfLog("Program: unexpected parent event");
    const malformedLog = invokeVerifier();
    expect(malformedLog.status).not.toBe(0);
    expect(malformedLog.stderr).toContain(
      "Squirrel update-self log has an unexpected parent event"
    );

    await writeUpdateSelfLog(
      undefined,
      resolve(dirname(installRoot), "wrong", "Update.exe")
    );
    const wrongSource = invokeVerifier();
    expect(wrongSource.status).not.toBe(0);
    expect(wrongSource.stderr).toContain(
      "Squirrel update-self log names an unexpected source executable"
    );

    await writeUpdateSelfLog(
      "Program: About to wait for parent PID 2147483648"
    );
    const overflowingPid = invokeVerifier();
    expect(overflowingPid.status).not.toBe(0);
    expect(overflowingPid.stderr).toContain(
      "Squirrel update-self log has an invalid parent PID"
    );

    await writeUpdateSelfLog(undefined, undefined, false);
    const missingBom = invokeVerifier();
    expect(missingBom.status).not.toBe(0);
    expect(missingBom.stderr).toContain(
      "Squirrel update-self log lacks its canonical UTF-8 BOM"
    );

    await writeUpdateSelfLog(
      undefined,
      undefined,
      true,
      "[20/07/26 12:00:03] info: Program: unexpected extra event"
    );
    const extraLine = invokeVerifier();
    expect(extraLine.status).not.toBe(0);
    expect(extraLine.stderr).toContain(
      "Squirrel update-self log has an unexpected line count"
    );

    await writeUpdateSelfLog();
    await writeFile(updateLogQuarantine, "do-not-overwrite");
    const preexistingQuarantine = invokeVerifier();
    expect(preexistingQuarantine.status).not.toBe(0);
    expect(preexistingQuarantine.stderr).toContain(
      "Squirrel update-self verifier quarantine could not be inspected"
    );
    expect(await readFile(updateLogQuarantine, "utf8")).toBe(
      "do-not-overwrite"
    );
    expect(await readFile(updateLog)).not.toHaveLength(0);
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
