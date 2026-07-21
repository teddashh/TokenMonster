import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface RawBoundZstdExpectation {
  readonly bindingBytes: number;
  readonly bindingSha256: string;
}

interface AuditedPhysicalSignOptions {
  readonly automaticallySelectCertificate: false;
  readonly debug: false;
  readonly description: "TokenMonster";
  readonly files: string[];
  readonly hashes: readonly ["sha256"];
  readonly signJavaScript: false;
  readonly timestampServer: "https://timestamp.digicert.com";
}

type AuditedSigner = (options: AuditedPhysicalSignOptions) => Promise<void>;

interface WindowsSignHook {
  (
    file: unknown,
    expectation?: RawBoundZstdExpectation,
    signer?: AuditedSigner,
  ): Promise<"signed" | "skipped-raw-bound-zstd">;
  readonly auditedWindowsSignOptions: Omit<AuditedPhysicalSignOptions, "files">;
  readonly forbiddenSigningEnvironment: readonly string[];
  readonly isRawBoundZstdPath: (file: unknown) => file is string;
  readonly rawBoundZstdExpectation: RawBoundZstdExpectation;
  readonly rawBoundZstdRelativePath: string;
  readonly signPhysicalFile: (
    file: unknown,
    expectation: RawBoundZstdExpectation,
    signer: AuditedSigner,
  ) => Promise<"signed" | "skipped-raw-bound-zstd">;
  readonly validateRawBoundZstd: (
    file: unknown,
    expectation: RawBoundZstdExpectation,
  ) => void;
}

interface ZstdPolicy {
  readonly platforms?: {
    readonly "win32-x64"?: {
      readonly bindingBytes?: unknown;
      readonly bindingSha256?: unknown;
    };
  };
}

const require = createRequire(import.meta.url);
const companionDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const rootDirectory = resolve(companionDirectory, "..", "..");
const hookModulePath = join(
  companionDirectory,
  "packaging",
  "windows-sign-hook.cjs",
);
const hook = require(hookModulePath) as WindowsSignHook;
const temporaryDirectories: string[] = [];
const managedEnvironmentNames = [
  ...hook.forbiddenSigningEnvironment,
  "WINDOWS_CERTIFICATE_FILE",
  "WINDOWS_CERTIFICATE_PASSWORD",
];
const originalEnvironment = new Map<string, string | undefined>();
let originalExitCode: string | number | null | undefined;

beforeEach(() => {
  originalExitCode = process.exitCode;
  for (const name of managedEnvironmentNames) {
    originalEnvironment.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(async () => {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  originalEnvironment.clear();
  process.exitCode = originalExitCode;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "tokenmonster-windows-sign-hook-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function configureAuditedCertificateEnvironment(
  directory: string,
): Promise<{ certificatePath: string; certificatePassword: string }> {
  const certificatePath = join(directory, "fixture-certificate.pfx");
  const certificatePassword = " fixture password ";
  await writeFile(certificatePath, "not a production certificate");
  process.env["WINDOWS_CERTIFICATE_FILE"] = certificatePath;
  process.env["WINDOWS_CERTIFICATE_PASSWORD"] = certificatePassword;
  return { certificatePath, certificatePassword };
}

function expectationFor(contents: Buffer): RawBoundZstdExpectation {
  return {
    bindingBytes: contents.byteLength,
    bindingSha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function writeRawBoundFixture(
  directory: string,
  contents: Buffer,
): Promise<string> {
  const path = join(directory, hook.rawBoundZstdRelativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
}

function childEnvironment(values: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...values };
  for (const name of hook.forbiddenSigningEnvironment) {
    delete environment[name];
  }
  return environment;
}

describe("audited Windows signing hook", () => {
  it("binds its exact exemption to the reviewed win32-x64 policy", async () => {
    const policy = JSON.parse(
      await readFile(
        join(
          rootDirectory,
          "packages",
          "token-tracker-runtime",
          "src",
          "zstd-native-policy.json",
        ),
        "utf8",
      ),
    ) as ZstdPolicy;

    expect(hook.rawBoundZstdExpectation).toEqual({
      bindingBytes: policy.platforms?.["win32-x64"]?.bindingBytes,
      bindingSha256: policy.platforms?.["win32-x64"]?.bindingSha256,
    });
    expect(hook.auditedWindowsSignOptions).toEqual({
      automaticallySelectCertificate: false,
      debug: false,
      description: "TokenMonster",
      hashes: ["sha256"],
      signJavaScript: false,
      timestampServer: "https://timestamp.digicert.com",
    });
  });

  it("recognizes only the exact normalized absolute raw-bound suffix", async () => {
    const directory = await temporaryDirectory();
    const exact = join(directory, hook.rawBoundZstdRelativePath);
    const unnormalized =
      directory +
      sep +
      "discarded" +
      sep +
      ".." +
      sep +
      hook.rawBoundZstdRelativePath;

    expect(hook.isRawBoundZstdPath(exact)).toBe(true);
    expect(hook.isRawBoundZstdPath(exact + ".copy")).toBe(false);
    expect(hook.isRawBoundZstdPath(unnormalized)).toBe(false);
    expect(
      hook.isRawBoundZstdPath(
        join(directory, "resources", "sidecar", "zstd.node"),
      ),
    ).toBe(false);
    expect(hook.isRawBoundZstdPath(hook.rawBoundZstdRelativePath)).toBe(false);
  });

  it("skips exact validated raw-bound bytes without invoking an inner signer", async () => {
    const directory = await temporaryDirectory();
    await configureAuditedCertificateEnvironment(directory);
    const contents = Buffer.from("reviewed raw-bound zstd fixture");
    const expectation = expectationFor(contents);
    const file = await writeRawBoundFixture(directory, contents);
    const calls: AuditedPhysicalSignOptions[] = [];
    const signer: AuditedSigner = async (options) => {
      calls.push(options);
    };

    await expect(hook(file, expectation, signer)).resolves.toBe(
      "skipped-raw-bound-zstd",
    );
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(originalExitCode);
  });

  it("signs every other physical file once with only fixed secret-free options", async () => {
    const directory = await temporaryDirectory();
    const { certificatePath, certificatePassword } =
      await configureAuditedCertificateEnvironment(directory);
    const file = join(directory, "TokenMonster.exe");
    await writeFile(file, "ordinary PE fixture");
    const calls: AuditedPhysicalSignOptions[] = [];
    const signer: AuditedSigner = async (options) => {
      calls.push(options);
    };

    await expect(
      hook(file, hook.rawBoundZstdExpectation, signer),
    ).resolves.toBe("signed");
    expect(calls).toEqual([
      {
        automaticallySelectCertificate: false,
        debug: false,
        description: "TokenMonster",
        files: [file],
        hashes: ["sha256"],
        signJavaScript: false,
        timestampServer: "https://timestamp.digicert.com",
      },
    ]);
    const serializedCall = JSON.stringify(calls);
    expect(serializedCall).not.toContain("hookModulePath");
    expect(serializedCall).not.toContain(certificatePath);
    expect(serializedCall).not.toContain(certificatePassword);
  });

  it("leaves child exit status nonzero when windows-sign swallows the hook rejection", async () => {
    const directory = await temporaryDirectory();
    const { certificatePath, certificatePassword } =
      await configureAuditedCertificateEnvironment(directory);
    const file = await writeRawBoundFixture(
      directory,
      Buffer.from("tampered fixture"),
    );
    const childScript = [
      'const { sign } = require("@electron/windows-sign");',
      "sign({",
      "  automaticallySelectCertificate: false,",
      "  debug: false,",
      '  description: "TokenMonster",',
      "  files: [process.env.RAW_BOUND_PATH],",
      '  hashes: ["sha256"],',
      "  hookModulePath: process.env.HOOK_MODULE_PATH,",
      "  signJavaScript: false,",
      '  timestampServer: "https://timestamp.digicert.com"',
      "}).then(() => {",
      "  if (process.exitCode !== 1) process.exitCode = 2;",
      "}).catch(() => {",
      "  process.exitCode = 3;",
      "});",
    ].join("\n");

    const result = spawnSync(process.execPath, ["--eval", childScript], {
      cwd: rootDirectory,
      encoding: "utf8",
      env: childEnvironment({
        HOOK_MODULE_PATH: hookModulePath,
        RAW_BOUND_PATH: file,
        WINDOWS_CERTIFICATE_FILE: certificatePath,
        WINDOWS_CERTIFICATE_PASSWORD: certificatePassword,
      }),
    });

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.error).toBeUndefined();
  });

  it("rejects overrides and non-absolute files before delegation", async () => {
    const directory = await temporaryDirectory();
    await configureAuditedCertificateEnvironment(directory);
    const file = join(directory, "TokenMonster.exe");
    await writeFile(file, "ordinary PE fixture");
    const calls: AuditedPhysicalSignOptions[] = [];
    const signer: AuditedSigner = async (options) => {
      calls.push(options);
    };

    process.env["WINDOWS_SIGN_DESCRIPTION"] = "injected";
    await expect(
      hook.signPhysicalFile(file, hook.rawBoundZstdExpectation, signer),
    ).rejects.toThrow(/unaudited override/u);
    delete process.env["WINDOWS_SIGN_DESCRIPTION"];
    await expect(
      hook.signPhysicalFile(
        "TokenMonster.exe",
        hook.rawBoundZstdExpectation,
        signer,
      ),
    ).rejects.toThrow(/normalized absolute path/u);
    expect(calls).toEqual([]);
  });

  it("preserves the absolute hook path and fixed options through SEA JSON serialization", async () => {
    const configuredWindowsSign = {
      ...hook.auditedWindowsSignOptions,
      hookModulePath,
    };
    const serialized = JSON.stringify(configuredWindowsSign);
    const roundTrip = JSON.parse(serialized) as {
      readonly automaticallySelectCertificate?: unknown;
      readonly debug?: unknown;
      readonly description?: unknown;
      readonly hashes?: unknown;
      readonly hookModulePath?: unknown;
      readonly signJavaScript?: unknown;
      readonly timestampServer?: unknown;
    };

    expect(roundTrip).toEqual(configuredWindowsSign);
    expect(roundTrip.hookModulePath).toBe(hookModulePath);
    expect(isAbsolute(String(roundTrip.hookModulePath))).toBe(true);
    expect(serialized).not.toContain("WINDOWS_CERTIFICATE_FILE");
    expect(serialized).not.toContain("WINDOWS_CERTIFICATE_PASSWORD");

    const source = await readFile(
      join(companionDirectory, "packaging", "package-config.mjs"),
      "utf8",
    );
    expect(source).toContain(
      'new URL("windows-sign-hook.cjs", import.meta.url)',
    );
    expect(source).toContain("hookModulePath: WINDOWS_SIGN_HOOK_MODULE_PATH");
    expect(source).toContain("makerWindowsSign: windowsSignWithHook");
    expect(source).toContain("packager: { windowsSign: windowsSignWithHook }");
    expect(source).toContain("continueOnError: false");
  });

  it.runIf(process.platform === "win32" && process.arch === "x64")(
    "validates and skips the installed production win32-x64 zstd binding",
    async () => {
      const directory = await temporaryDirectory();
      await configureAuditedCertificateEnvironment(directory);
      const installedBinding = join(
        rootDirectory,
        "node_modules",
        "@mongodb-js",
        "zstd",
        "build",
        "Release",
        "zstd.node",
      );
      const file = join(directory, hook.rawBoundZstdRelativePath);
      await mkdir(dirname(file), { recursive: true });
      await copyFile(installedBinding, file);
      const calls: AuditedPhysicalSignOptions[] = [];
      const signer: AuditedSigner = async (options) => {
        calls.push(options);
      };

      await expect(
        hook(file, hook.rawBoundZstdExpectation, signer),
      ).resolves.toBe("skipped-raw-bound-zstd");
      expect(calls).toEqual([]);
    },
  );
});
