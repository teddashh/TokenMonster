import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  INVALID_WINDOWS_RELEASE_VERSIONS,
  VALID_WINDOWS_RELEASE_VERSIONS
} from "../../../scripts/release/release-version-contract.test-vectors.mjs";

import {
  authenticodeEvidenceFromInspection,
  ciReleaseVersionForRunId,
  environmentWithoutWindowsSigningSecrets,
  isWindowsRawPolicyBoundPath,
  isWindowsSignablePath,
  packageJsonWithReleaseVersion,
  prepareWindowsSigningEnvironment,
  requireReleaseVersion,
  requireSignedWindowsSquirrelInventory,
  requireSquirrelReleaseEntry,
  requireWindowsSignerSubject,
  SOURCE_COMPANION_VERSION,
  squirrelVersionFor,
  WINDOWS_RAW_BOUND_ZSTD_SIDECAR_PATH,
  WINDOWS_RFC3161_TIMESTAMP_SERVER
} from "../packaging/release-policy.mjs";

const companionDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);
const rootDirectory = resolve(companionDirectory, "..", "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("companion release policy", () => {
  it("pins the exact reviewed Windows signing implementations", async () => {
    const packageLock = JSON.parse(
      await readFile(join(rootDirectory, "package-lock.json"), "utf8")
    ) as {
      packages?: Record<string, { version?: string }>;
    };
    expect(
      packageLock.packages?.["node_modules/@electron/windows-sign"]?.version
    ).toBe("1.2.2");
    expect(
      packageLock.packages?.["node_modules/electron-winstaller"]?.version
    ).toBe("5.4.4");
  });

  it("uses the shared Windows-compatible SemVer contract", () => {
    for (const version of VALID_WINDOWS_RELEASE_VERSIONS) {
      expect(
        requireReleaseVersion({ TOKENMONSTER_RELEASE_VERSION: version })
      ).toBe(version);
    }
    // The first stable release is allowed to use the source package's exact
    // 0.1.0 version; uniqueness comes from the immutable tag and artifact.
    expect(
      requireReleaseVersion({
        TOKENMONSTER_RELEASE_VERSION: SOURCE_COMPANION_VERSION
      })
    ).toBe(SOURCE_COMPANION_VERSION);
    for (const version of [undefined, ...INVALID_WINDOWS_RELEASE_VERSIONS]) {
      expect(() =>
        requireReleaseVersion({ TOKENMONSTER_RELEASE_VERSION: version })
      ).toThrow();
    }
  });

  it("keeps package, Electron, and Squirrel version projections explicit", () => {
    expect(
      packageJsonWithReleaseVersion(
        { name: "@tokenmonster/companion", version: "0.1.0" },
        "0.1.0-rc.8"
      )
    ).toEqual({
      name: "@tokenmonster/companion",
      version: "0.1.0-rc.8"
    });
    expect(squirrelVersionFor("0.1.0-rc.8")).toBe("0.1.0-rc8");
    expect(squirrelVersionFor("0.1.1")).toBe("0.1.1");
    expect(() =>
      packageJsonWithReleaseVersion(
        { name: "@tokenmonster/companion", version: "9.9.9" },
        "0.1.0-rc.8"
      )
    ).toThrow(/source package version/u);
  });

  it("binds Squirrel RELEASES metadata to the recomputed full-package SHA-1", () => {
    const expected = {
      fileName: "TokenMonster-0.1.0-rc8-full.nupkg",
      byteSize: 123_456,
      sha1: "0123456789abcdef0123456789abcdef01234567"
    };
    expect(
      requireSquirrelReleaseEntry(
        [expected.sha1.toUpperCase(), expected.fileName, "123456"],
        expected
      )
    ).toEqual(expected);
    for (const parts of [
      ["0".repeat(40), expected.fileName, "123456"],
      [expected.sha1, "substituted-full.nupkg", "123456"],
      [expected.sha1, expected.fileName, "123455"],
      [expected.sha1, expected.fileName],
      [expected.sha1, expected.fileName, "123456", "extra"]
    ]) {
      expect(() => requireSquirrelReleaseEntry(parts, expected)).toThrow(
        /SHA-1, name, and byte size/u
      );
    }
  });

  it("allows only the exact three-file signed Windows publication set", () => {
    const fullPackageName = "TokenMonster-0.1.0-rc8-full.nupkg";
    expect(
      requireSignedWindowsSquirrelInventory(
        [fullPackageName, "TokenMonsterSetup.exe", "RELEASES"],
        fullPackageName
      )
    ).toEqual(["RELEASES", "TokenMonster-0.1.0-rc8-full.nupkg", "TokenMonsterSetup.exe"]);
    for (const files of [
      ["RELEASES", "TokenMonsterSetup.exe"],
      ["RELEASES", "TokenMonsterSetup.exe", fullPackageName, "debug.pdb"],
      [
        "RELEASES",
        "TokenMonsterSetup.exe",
        fullPackageName,
        "TokenMonster-0.1.0-rc8-delta.nupkg"
      ],
      ["nested/RELEASES", "TokenMonsterSetup.exe", fullPackageName],
      ["RELEASES", "OtherSetup.exe", fullPackageName]
    ]) {
      expect(() =>
        requireSignedWindowsSquirrelInventory(files, fullPackageName)
      ).toThrow(/exactly RELEASES/u);
    }
    expect(() =>
      requireSignedWindowsSquirrelInventory(
        ["RELEASES", "TokenMonsterSetup.exe", fullPackageName],
        "substituted-full.nupkg"
      )
    ).toThrow(/exactly RELEASES/u);
  });

  it("keeps every CI run ID injective on the source version base", () => {
    expect(ciReleaseVersionForRunId("1")).toBe("0.1.0-ci1x");
    expect(ciReleaseVersionForRunId("65535")).toBe("0.1.0-ci65535x");
    expect(ciReleaseVersionForRunId("65536")).toBe("0.1.0-ci65536x");
    expect(ciReleaseVersionForRunId("4294967295")).toBe(
      "0.1.0-ci4294967295x"
    );
    expect(ciReleaseVersionForRunId("29566777400")).toBe(
      "0.1.0-ci29566777400x"
    );
    expect(ciReleaseVersionForRunId("18446744073709551615")).toBe(
      "0.1.0-ci18446744073709551615x"
    );
    for (const runId of [
      "0",
      "01",
      "-1",
      "1.5",
      "999999999999999999999"
    ]) {
      expect(() => ciReleaseVersionForRunId(runId)).toThrow();
    }
  });

  it("derives and validates both CI and tag candidate versions", () => {
    const script = join(
      rootDirectory,
      "scripts",
      "derive-companion-release-version.mjs"
    );
    for (const [environment, expected] of [
      [
        { GITHUB_REF_TYPE: "branch", GITHUB_RUN_ID: "29566777400" },
        "0.1.0-ci29566777400x"
      ],
      [{ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.1.0-rc.8" }, "0.1.0-rc.8"],
      [{ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.1.0" }, "0.1.0"]
    ] as const) {
      const result = spawnSync(process.execPath, [script], {
        cwd: rootDirectory,
        encoding: "utf8",
        env: { ...process.env, ...environment }
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(expected);
    }
    for (const environment of [
      {
        GITHUB_REF_TYPE: "branch",
        GITHUB_RUN_ID: "999999999999999999999"
      },
      { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "0.1.0-rc.8" },
      { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.1.0+reused" }
    ]) {
      const result = spawnSync(process.execPath, [script], {
        cwd: rootDirectory,
        encoding: "utf8",
        env: { ...process.env, ...environment }
      });
      expect(result.status).not.toBe(0);
    }
  });

  it("configures SHA-256-only RFC3161 signing without returning secrets", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-sign-policy-")
    );
    temporaryDirectories.push(directory);
    const certificatePath = join(directory, "release-certificate.pfx");
    await writeFile(certificatePath, "test fixture, not a real certificate\n");
    await chmod(certificatePath, 0o600);
    const password = " secret boundary whitespace is valid ";
    const environment: Record<string, string | undefined> = {
      DEBUG: "electron-windows-sign",
      NODE_DEBUG: "child_process",
      NODE_OPTIONS: "--trace-warnings",
      TOKENMONSTER_WINDOWS_CERTIFICATE_PASSWORD: password,
      TOKENMONSTER_WINDOWS_CERTIFICATE_PATH: certificatePath,
      TOKENMONSTER_WINDOWS_SIGNER_SUBJECT:
        "CN=TokenMonster Release, O=TokenMonster"
    };

    const result = prepareWindowsSigningEnvironment(environment);

    expect(result).toEqual({
      expectedSignerSubject: "CN=TokenMonster Release, O=TokenMonster",
      windowsSign: {
        automaticallySelectCertificate: false,
        debug: false,
        description: "TokenMonster",
        hashes: ["sha256"],
        signJavaScript: false,
        timestampServer: WINDOWS_RFC3161_TIMESTAMP_SERVER
      }
    });
    expect(WINDOWS_RFC3161_TIMESTAMP_SERVER).toMatch(/^https:\/\//u);
    expect(environment["WINDOWS_CERTIFICATE_FILE"]).toBe(certificatePath);
    expect(environment["WINDOWS_CERTIFICATE_PASSWORD"]).toBe(password);
    expect(
      environment["TOKENMONSTER_WINDOWS_CERTIFICATE_PATH"]
    ).toBeUndefined();
    expect(
      environment["TOKENMONSTER_WINDOWS_CERTIFICATE_PASSWORD"]
    ).toBeUndefined();
    expect(environment["DEBUG"]).toBeUndefined();
    expect(environment["NODE_DEBUG"]).toBeUndefined();
    expect(environment["NODE_OPTIONS"]).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain(certificatePath);
  });

  it("accepts only exact valid SHA-256 RFC3161 Authenticode evidence", () => {
    const expectedSubject = "CN=TokenMonster Release, O=TokenMonster";
    const validInspection = {
      status: "Valid",
      signerSubject: expectedSubject,
      signerThumbprint: "a".repeat(40),
      timestampSubject: "CN=RFC3161 Timestamp Authority",
      timestampThumbprint: "b".repeat(40),
      signatureContainerCount: 1,
      digestOids: ["2.16.840.1.101.3.4.2.1"],
      timestampAttributeOids: ["1.3.6.1.4.1.311.3.3.1"],
      productVersion: "0.1.0-rc.8",
      fileVersion: "0.1.0-rc.8"
    };

    expect(
      authenticodeEvidenceFromInspection(validInspection, expectedSubject)
    ).toMatchObject({
      status: "Valid",
      signerSubject: expectedSubject,
      signerThumbprint: "A".repeat(40),
      timestampPresent: true,
      timestampThumbprint: "B".repeat(40),
      digestAlgorithm: "sha256",
      timestampProtocol: "RFC3161",
      productVersion: "0.1.0-rc.8"
    });
    expect(() =>
      authenticodeEvidenceFromInspection(
        { ...validInspection, signerSubject: "" },
        ""
      )
    ).toThrow(/Authenticode status, signer, RFC3161 timestamp/u);

    for (const invalidInspection of [
      { ...validInspection, status: "NotTrusted" },
      { ...validInspection, signerSubject: "CN=Unexpected" },
      { ...validInspection, timestampSubject: null },
      { ...validInspection, signatureContainerCount: 2 },
      { ...validInspection, digestOids: ["1.3.14.3.2.26"] },
      {
        ...validInspection,
        timestampAttributeOids: ["1.2.840.113549.1.9.6"]
      },
      { ...validInspection, unexpected: true }
    ]) {
      expect(() =>
        authenticodeEvidenceFromInspection(invalidInspection, expectedSubject)
      ).toThrow(/Authenticode status, signer, RFC3161 timestamp/u);
    }
  });

  it("rejects ambiguous signer inputs with secret-safe errors", async () => {
    const secretPath = resolve("/not-present/sensitive-name.pfx");
    const environment = {
      TOKENMONSTER_WINDOWS_CERTIFICATE_PASSWORD: "do-not-print-this",
      TOKENMONSTER_WINDOWS_CERTIFICATE_PATH: secretPath,
      TOKENMONSTER_WINDOWS_SIGNER_SUBJECT: "CN=TokenMonster Release"
    };
    let failure: Error | undefined;
    try {
      prepareWindowsSigningEnvironment(environment);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).not.toContain(secretPath);
    expect(failure?.message).not.toContain("do-not-print-this");
    expect(() =>
      requireWindowsSignerSubject({
        TOKENMONSTER_WINDOWS_SIGNER_SUBJECT: "friendly display name"
      })
    ).toThrow(/exact certificate subject/u);

    const directory = await mkdtemp(
      join(tmpdir(), "tokenmonster-sign-override-")
    );
    temporaryDirectories.push(directory);
    const certificatePath = join(directory, "release.pfx");
    await writeFile(certificatePath, "fixture\n");
    expect(() =>
      prepareWindowsSigningEnvironment({
        TOKENMONSTER_WINDOWS_CERTIFICATE_PASSWORD: "password",
        TOKENMONSTER_WINDOWS_CERTIFICATE_PATH: certificatePath,
        TOKENMONSTER_WINDOWS_SIGNER_SUBJECT: "CN=TokenMonster Release",
        WINDOWS_SIGN_WITH_PARAMS: "/fd sha1"
      })
    ).toThrow(/rejects unaudited WINDOWS_/u);
  });

  it("strips certificate secrets from non-signing subprocess environments", () => {
    expect(
      environmentWithoutWindowsSigningSecrets({
        KEEP: "yes",
        TOKENMONSTER_WINDOWS_CERTIFICATE_PASSWORD: "secret",
        TOKENMONSTER_WINDOWS_CERTIFICATE_PATH: "/secret/release.pfx",
        TOKENMONSTER_WINDOWS_SIGNER_SUBJECT: "CN=Expected",
        WINDOWS_CERTIFICATE_PASSWORD: "legacy-secret"
      })
    ).toEqual({
      KEEP: "yes",
      TOKENMONSTER_WINDOWS_SIGNER_SUBJECT: "CN=Expected"
    });
  });

  it("uses the injected version in direct package and maker configuration", () => {
    const configUrl = pathToFileURL(
      join(companionDirectory, "packaging", "package-config.mjs")
    ).href;
    const runnerUrl = pathToFileURL(
      join(companionDirectory, "packaging", "package-runner.mjs")
    ).href;
    const script = `
      const { default: config, deferInternalDarwinFuses } = await import(process.env.CONFIG_URL);
      const { basename } = await import("node:path");
      const { expectedPackagePath, zipArtifactPath } = await import(process.env.RUNNER_URL);
      const packagePath = expectedPackagePath("linux", "x64", config);
      process.stdout.write(JSON.stringify({
        appVersion: config.packagerConfig.appVersion,
        releaseVersion: config.releaseVersion,
        squirrelVersion: config.squirrel.version,
        windowsCompanyName: config.packagerConfig.win32metadata?.CompanyName,
        squirrelAuthors: config.squirrel.authors,
        afterCopyHookCount: config.packagerConfig.afterCopy.length,
        deferInternalDarwinArm64: deferInternalDarwinFuses("darwin", "arm64"),
        deferInternalDarwinX64: deferInternalDarwinFuses("darwin", "x64"),
        linuxPackageName: basename(packagePath),
        linuxZipName: basename(zipArtifactPath(packagePath, "linux", "x64", config)),
        internalPackagerSigning: config.packagerConfig.windowsSign ?? null,
        internalMakerSigning: config.squirrel.windowsSign ?? null
      }));
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: rootDirectory,
        encoding: "utf8",
        env: {
          ...environmentWithoutWindowsSigningSecrets(process.env),
          CONFIG_URL: configUrl,
          RUNNER_URL: runnerUrl,
          TOKENMONSTER_RELEASE_MODE: "internal",
          TOKENMONSTER_RELEASE_VERSION: "0.1.0-rc.8"
        }
      }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      appVersion: "0.1.0-rc.8",
      releaseVersion: "0.1.0-rc.8",
      squirrelVersion: "0.1.0-rc.8",
      windowsCompanyName: "Ted Huang",
      squirrelAuthors: "Ted Huang",
      afterCopyHookCount: 1,
      deferInternalDarwinArm64: true,
      deferInternalDarwinX64: true,
      linuxPackageName: "TokenMonster-linux-x64",
      linuxZipName: "TokenMonster-linux-x64-0.1.0-rc.8.zip",
      internalPackagerSigning: null,
      internalMakerSigning: null
    });
  });

  it("fails subprocess entry points closed before accepting stale versions", () => {
    for (const [script, arguments_] of [
      ["scripts/package-companion.mjs", ["package", "internal"]],
      ["scripts/verify-companion-package.mjs", ["--mode", "internal"]]
    ] as const) {
      const result = spawnSync(process.execPath, [script, ...arguments_], {
        cwd: rootDirectory,
        encoding: "utf8",
        env: {
          ...environmentWithoutWindowsSigningSecrets(process.env),
          TOKENMONSTER_RELEASE_VERSION: "0.1.0+reused"
        }
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(
        /strict .*SemVer without build metadata/u
      );
    }
  });

  it("builds the complete companion workspace dependency closure before Electron Packager", async () => {
    const source = await readFile(
      join(rootDirectory, "scripts", "package-companion.mjs"),
      "utf8"
    );

    expect(source).toContain('join(rootDirectory, "scripts", "run-workspaces.mjs")');
    expect(source).toContain('"@tokenmonster/companion"');
    expect(source).not.toContain('runNpm(["run", "build"]');
  });

  it("runs direct makers serially and binds both Squirrel version projections", async () => {
    const source = await readFile(
      join(
        companionDirectory,
        "packaging",
        "package-runner.mjs"
      ),
      "utf8"
    );
    expect(source).toContain(
      "convertVersion(configuration.releaseVersion) !== squirrelVersion"
    );
    expect(source.indexOf("await makeZipArtifact")).toBeLessThan(
      source.indexOf("await makeDmgArtifact")
    );
    expect(source.indexOf("await makeZipArtifact")).toBeLessThan(
      source.indexOf("await makeSquirrelArtifacts")
    );
    expect(source).not.toContain("Promise.all(makers)");
  });

  it("finalizes internal macOS fuses only after permission hardening", async () => {
    const runnerSource = await readFile(
      join(companionDirectory, "packaging", "package-runner.mjs"),
      "utf8"
    );
    const configSource = await readFile(
      join(companionDirectory, "packaging", "package-config.mjs"),
      "utf8"
    );
    expect(runnerSource.indexOf("await hardenPackagedPermissions")).toBeLessThan(
      runnerSource.indexOf("await finalizePackagedFuses")
    );
    expect(configSource).toContain(
      'RELEASE_MODE === "internal" &&\n    platform === "darwin"'
    );
    expect(configSource).toContain("preservedResourceDirectories.some");
    expect(configSource).toContain(
      "runtimeManifest.sidecar.extraResourceTarget"
    );
    expect(configSource).toContain("identityValidation: false");
    expect(configSource).toContain("optionsForFile: () => ({");
    expect(configSource).toContain('timestamp: "none"');
    expect(configSource).toContain(
      '["--verify", "--deep", "--strict", appPath]'
    );
  });

  it("keeps native macOS launch and Windows install smoke in CI", async () => {
    const workflow = await readFile(
      join(rootDirectory, ".github", "workflows", "ci.yml"),
      "utf8"
    );
    const windowsSmoke = await readFile(
      join(
        rootDirectory,
        "scripts",
        "release",
        "smoke-windows-squirrel-installer.ps1"
      ),
      "utf8"
    );
    const executableSmoke = await readFile(
      join(
        rootDirectory,
        "scripts",
        "release",
        "smoke-companion-executable.mjs"
      ),
      "utf8"
    );
    const installedVerifier = await readFile(
      join(
        rootDirectory,
        "scripts",
        "release",
        "verify-installed-companion.mjs"
      ),
      "utf8"
    );
    const releaseScriptTsconfig = await readFile(
      join(rootDirectory, "tsconfig.release-scripts.json"),
      "utf8"
    );
    const rootPackage = JSON.parse(
      await readFile(join(rootDirectory, "package.json"), "utf8")
    ) as { scripts?: { typecheck?: string } };
    expect(workflow).toContain(
      "Clean-install, smoke, and uninstall Windows Squirrel candidate"
    );
    expect(workflow).toContain("Smoke packaged macOS application");
    expect(workflow).toContain(
      "Clean-install, smoke, and uninstall signed Windows installer"
    );
    expect(workflow).toContain(
      "Re-verify signed Windows maker bytes after install smoke"
    );
    expect(
      workflow.indexOf(
        "Re-verify signed Windows maker bytes after install smoke"
      )
    ).toBeLessThan(workflow.indexOf("Upload verified signed installer"));
    expect(workflow).toContain("macos-internal-release-gate:");
    const stagingJob = workflow.slice(
      workflow.indexOf("  stage-companion-release:"),
      workflow.indexOf("  publish-cli-npm:")
    );
    expect(stagingJob).toContain("- macos-internal-release-gate");
    expect(windowsSmoke).toContain('@("--uninstall", "--silent")');
    expect(windowsSmoke).toContain("verify-installed-companion.mjs");
    expect(windowsSmoke).toContain("--full-package");
    expect(windowsSmoke).toContain('"--snapshot-maker"');
    expect(windowsSmoke).toContain("$makerBindingBefore");
    expect(windowsSmoke).toContain("$makerBindingAfter");
    expect(windowsSmoke).toContain("$process.WaitForExit($TimeoutMilliseconds)");
    expect(windowsSmoke).toContain("$process.Kill($true)");
    expect(windowsSmoke).toContain("Assert-PhysicalPathChain");
    expect(windowsSmoke).toContain("Set-StrictMode -Version Latest");
    expect(windowsSmoke).toContain("$current = $current.Directory");
    expect(windowsSmoke).not.toContain("--expected-directory");
    expect(installedVerifier).toContain('const SQUIRREL_PAYLOAD_PREFIX = "lib/net45/"');
    expect(installedVerifier).toContain(
      'const EXECUTION_STUB_PAYLOAD_PATH = "TokenMonster_ExecutionStub.exe"'
    );
    expect(installedVerifier).toContain("inventorySquirrelPayload");
    expect(installedVerifier).toContain("yauzl.fromRandomAccessReader");
    expect(installedVerifier).toContain("FileHandleRangeReadStream");
    expect(installedVerifier).toContain("hashOpenFileHandle");
    expect(installedVerifier).toContain("entryCount += entries.length");
    expect(installedVerifier).toContain("left.ctimeNs === right.ctimeNs");
    expect(releaseScriptTsconfig).toContain(
      '"scripts/release/smoke-companion-executable.mjs"'
    );
    expect(releaseScriptTsconfig).toContain(
      '"scripts/release/verify-installed-companion.mjs"'
    );
    expect(rootPackage.scripts?.typecheck).toContain(
      "tsc -p tsconfig.release-scripts.json"
    );
    expect(executableSmoke).toContain("TOKENMONSTER_SMOKE_OK");
    expect(executableSmoke).toContain('child.kill("SIGKILL")');
    expect(executableSmoke).toContain("FORCE_CLOSE_GRACE_MS");
    expect(executableSmoke).toContain('spawnSync(taskkillPath');
    expect(executableSmoke).toContain('/^[A-Za-z]:\\\\Windows$/iu');
  });

  it.runIf(process.platform !== "darwin" && process.platform !== "win32")(
    "rejects signed packaging on a non-native host without misreporting macOS",
    () => {
      const configUrl = pathToFileURL(
        join(companionDirectory, "packaging", "package-config.mjs")
      ).href;
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          "await import(process.env.CONFIG_URL)"
        ],
        {
          cwd: rootDirectory,
          encoding: "utf8",
          env: {
            ...environmentWithoutWindowsSigningSecrets(process.env),
            CONFIG_URL: configUrl,
            TOKENMONSTER_RELEASE_MODE: "signed",
            TOKENMONSTER_RELEASE_VERSION: "0.1.0-rc.8"
          }
        }
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(
        /native macOS or Windows host/u
      );
      expect(`${result.stdout}${result.stderr}`).not.toMatch(
        /must be produced on macOS/u
      );
    }
  );

  it("recognizes the complete PE signing extension allowlist", () => {
    for (const path of [
      "TokenMonster.exe",
      "resources/native.DLL",
      "addon.node",
      "driver.sys",
      "boot.efi",
      "screen.scr"
    ]) {
      expect(isWindowsSignablePath(path)).toBe(true);
    }
    for (const path of [
      "release.nupkg",
      "script.ps1",
      "library.js",
      "readme"
    ]) {
      expect(isWindowsSignablePath(path)).toBe(false);
    }
  });

  it("exempts only the exact raw-policy-bound Windows zstd payload", () => {
    const expected =
      `resources/sidecar/${WINDOWS_RAW_BOUND_ZSTD_SIDECAR_PATH}`;
    expect(isWindowsRawPolicyBoundPath(expected)).toBe(true);
    expect(
      isWindowsRawPolicyBoundPath(
        `C:\\staging\\resources\\sidecar\\${WINDOWS_RAW_BOUND_ZSTD_SIDECAR_PATH.replaceAll("/", "\\")}`
      )
    ).toBe(true);
    for (const path of [
      `resources/other/${WINDOWS_RAW_BOUND_ZSTD_SIDECAR_PATH}`,
      `${expected}.substituted`,
      "resources/sidecar/node_modules/other/build/Release/zstd.node",
      "TokenMonster.exe"
    ]) {
      expect(isWindowsRawPolicyBoundPath(path)).toBe(false);
    }
  });
});
