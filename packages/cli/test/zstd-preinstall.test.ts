import { createHash } from "node:crypto";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

type PrebuildPolicyEntry = Readonly<{
  platform: string;
  arch: string;
  archiveName: string;
  archiveBytes: number;
  archiveSha256: string;
}>;

type PrebuildPolicy = Readonly<Record<string, PrebuildPolicyEntry>>;

type PreinstallAuthority = Readonly<{
  installBundledZstdPrebuilds(options: {
    releasePackageRoot: string;
    platform: string;
    arch: string;
    prebuildPolicy: PrebuildPolicy;
  }): Promise<Readonly<{ platformKey: string }>>;
  UPSTREAM_ZSTD_FILE_PATHS: readonly string[];
}>;

const require = createRequire(import.meta.url);
const authority = require("../release/preinstall-zstd.cjs") as PreinstallAuthority;
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const installedZstdRoot = join(
  repositoryRoot,
  "node_modules",
  "@mongodb-js",
  "zstd",
);
const installedSidecarManifest = join(
  repositoryRoot,
  "node_modules",
  "tokentracker-cli",
  "package.json",
);
const PLATFORM_KEYS = ["darwin-arm64", "linux-x64", "win32-x64"] as const;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function testPrebuilds(): Readonly<{
  policy: PrebuildPolicy;
  archives: ReadonlyMap<string, Buffer>;
}> {
  const archives = new Map<string, Buffer>();
  const policy: Record<string, PrebuildPolicyEntry> = {};
  for (const [index, platformKey] of PLATFORM_KEYS.entries()) {
    const [platform, arch] = platformKey.split("-") as [string, string];
    const archiveName = `zstd-v2.0.1-napi-v4-${platformKey}.tar.gz`;
    const bytes = Buffer.from(
      `authenticated-test-prebuild:${platformKey}:${"x".repeat(index + 1)}`,
      "utf8",
    );
    archives.set(archiveName, bytes);
    policy[platformKey] = Object.freeze({
      platform,
      arch,
      archiveName,
      archiveBytes: bytes.length,
      archiveSha256: sha256(bytes),
    });
  }
  return Object.freeze({ policy: Object.freeze(policy), archives });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function copyUpstreamZstdPackage(destinationRoot: string): Promise<void> {
  for (const relativePath of authority.UPSTREAM_ZSTD_FILE_PATHS) {
    const destination = join(destinationRoot, ...relativePath.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(
      join(installedZstdRoot, ...relativePath.split("/")),
      destination,
    );
  }
}

async function addArchives(
  packageRoot: string,
  archives: ReadonlyMap<string, Buffer>,
  names = [...archives.keys()],
): Promise<void> {
  const prebuildRoot = join(packageRoot, "prebuilds");
  await mkdir(prebuildRoot, { recursive: true });
  for (const archiveName of names) {
    const bytes = archives.get(archiveName);
    if (bytes === undefined) throw new Error("test archive is missing");
    await writeFile(join(prebuildRoot, archiveName), bytes);
  }
}

type Fixture = Readonly<{
  temporaryRoot: string;
  releaseRoot: string;
  sourceRoot: string;
  destinationRoot: string;
  policy: PrebuildPolicy;
  archives: ReadonlyMap<string, Buffer>;
}>;

async function createFixture(options: {
  nestedSidecar?: boolean;
  escapedSidecar?: boolean;
  destinationArchiveNames?: readonly string[];
} = {}): Promise<Fixture> {
  const physicalTemporaryDirectory = await realpath(tmpdir());
  const temporaryRoot = await mkdtemp(
    join(physicalTemporaryDirectory, "tokenmonster-zstd-test-"),
  );
  temporaryRoots.push(temporaryRoot);
  const consumerRoot = join(temporaryRoot, "consumer");
  const parentNodeModules = join(consumerRoot, "node_modules");
  const releaseRoot = join(parentNodeModules, "tokenmonster");
  const sourceRoot = join(
    releaseRoot,
    "node_modules",
    "@mongodb-js",
    "zstd",
  );
  const { policy, archives } = testPrebuilds();

  await writeJson(join(releaseRoot, "package.json"), {
    name: "tokenmonster",
    version: "0.1.0-test.1",
    scripts: { preinstall: "node preinstall-zstd.cjs" },
    dependencies: {
      "@mongodb-js/zstd": "2.0.1",
      "tokentracker-cli": "0.80.0",
    },
    bundleDependencies: ["@mongodb-js/zstd"],
  });
  await copyUpstreamZstdPackage(sourceRoot);
  await addArchives(sourceRoot, archives);

  const sidecarRoot = options.escapedSidecar
    ? join(temporaryRoot, "node_modules", "tokentracker-cli")
    : options.nestedSidecar
      ? join(releaseRoot, "node_modules", "tokentracker-cli")
      : join(parentNodeModules, "tokentracker-cli");
  await mkdir(sidecarRoot, { recursive: true });
  await copyFile(installedSidecarManifest, join(sidecarRoot, "package.json"));

  const destinationRoot = options.nestedSidecar
    ? sourceRoot
    : options.escapedSidecar
      ? join(temporaryRoot, "node_modules", "@mongodb-js", "zstd")
      : join(parentNodeModules, "@mongodb-js", "zstd");
  if (destinationRoot !== sourceRoot) {
    await copyUpstreamZstdPackage(destinationRoot);
    if ((options.destinationArchiveNames?.length ?? 0) > 0) {
      await addArchives(
        destinationRoot,
        archives,
        [...(options.destinationArchiveNames ?? [])],
      );
    }
  }

  return Object.freeze({
    temporaryRoot,
    releaseRoot,
    sourceRoot,
    destinationRoot,
    policy,
    archives,
  });
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("dependency-owned zstd preinstall", () => {
  it("fills an exact existing subset with exclusive physical files and reruns safely", async () => {
    const { releaseRoot, destinationRoot, policy, archives } =
      await createFixture({
        destinationArchiveNames: [
          "zstd-v2.0.1-napi-v4-darwin-arm64.tar.gz",
        ],
      });

    await expect(
      authority.installBundledZstdPrebuilds({
        releasePackageRoot: releaseRoot,
        platform: "linux",
        arch: "x64",
        prebuildPolicy: policy,
      }),
    ).resolves.toEqual({ platformKey: "linux-x64" });

    for (const [archiveName, expectedBytes] of archives) {
      const archivePath = join(destinationRoot, "prebuilds", archiveName);
      await expect(readFile(archivePath)).resolves.toEqual(expectedBytes);
      expect((await lstat(archivePath)).nlink).toBe(1);
    }
    expect(
      (await readdir(destinationRoot)).some((name) =>
        name.startsWith(".tokenmonster-zstd-prebuilds-"),
      ),
    ).toBe(false);

    await expect(
      authority.installBundledZstdPrebuilds({
        releasePackageRoot: releaseRoot,
        platform: "linux",
        arch: "x64",
        prebuildPolicy: policy,
      }),
    ).resolves.toEqual({ platformKey: "linux-x64" });
  });

  it("accepts the exact nested npm layout when source and sidecar target coincide", async () => {
    const { releaseRoot, policy } = await createFixture({ nestedSidecar: true });

    await expect(
      authority.installBundledZstdPrebuilds({
        releasePackageRoot: releaseRoot,
        platform: "darwin",
        arch: "arm64",
        prebuildPolicy: policy,
      }),
    ).resolves.toEqual({ platformKey: "darwin-arm64" });
  });

  it("fails closed on a differing existing archive without leaking its path", async () => {
    const archiveName = "zstd-v2.0.1-napi-v4-linux-x64.tar.gz";
    const { temporaryRoot, releaseRoot, destinationRoot, policy } =
      await createFixture({ destinationArchiveNames: [archiveName] });
    const archivePath = join(destinationRoot, "prebuilds", archiveName);
    const altered = await readFile(archivePath);
    altered[0] = altered[0] === 0 ? 1 : 0;
    await writeFile(archivePath, altered);

    let failure: unknown;
    try {
      await authority.installBundledZstdPrebuilds({
        releasePackageRoot: releaseRoot,
        platform: "linux",
        arch: "x64",
        prebuildPolicy: policy,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(temporaryRoot);
    expect((failure as Error).message).toContain("exact physical file");
  });

  it("rejects package hardlinks and an unexpected prebuild inventory", async () => {
    const hardlinked = await createFixture();
    await link(
      join(hardlinked.sourceRoot, "LICENSE.md"),
      join(hardlinked.temporaryRoot, "license-hardlink"),
    );
    await expect(
      authority.installBundledZstdPrebuilds({
        releasePackageRoot: hardlinked.releaseRoot,
        platform: "linux",
        arch: "x64",
        prebuildPolicy: hardlinked.policy,
      }),
    ).rejects.toThrow("inventory contains an invalid entry");

    const unexpected = await createFixture();
    await mkdir(join(unexpected.destinationRoot, "prebuilds"));
    await writeFile(
      join(unexpected.destinationRoot, "prebuilds", "unreviewed.tar.gz"),
      "unreviewed",
    );
    await expect(
      authority.installBundledZstdPrebuilds({
        releasePackageRoot: unexpected.releaseRoot,
        platform: "linux",
        arch: "x64",
        prebuildPolicy: unexpected.policy,
      }),
    ).rejects.toThrow("inventory must be exact");
  });

  it("rejects an allowed npm package slot when it is a symlink or junction", async () => {
    const fixture = await createFixture();
    await rm(fixture.destinationRoot, { recursive: true });
    await symlink(fixture.sourceRoot, fixture.destinationRoot, "junction");

    await expect(
      authority.installBundledZstdPrebuilds({
        releasePackageRoot: fixture.releaseRoot,
        platform: "linux",
        arch: "x64",
        prebuildPolicy: fixture.policy,
      }),
    ).rejects.toThrow("must be a physical directory");
  });

  it("rejects a package resolved from a higher ancestor outside fixed npm layouts", async () => {
    const escaped = await createFixture({ escapedSidecar: true });

    await expect(
      authority.installBundledZstdPrebuilds({
        releasePackageRoot: escaped.releaseRoot,
        platform: "win32",
        arch: "x64",
        prebuildPolicy: escaped.policy,
      }),
    ).rejects.toThrow("resolved outside the fixed npm layout");
  });

  it("requires the exact release lifecycle and bundle membership", async () => {
    const fixture = await createFixture();
    await writeJson(join(fixture.releaseRoot, "package.json"), {
      name: "tokenmonster",
      scripts: { preinstall: "node preinstall-zstd.cjs" },
      dependencies: {
        "@mongodb-js/zstd": "2.0.1",
        "tokentracker-cli": "0.80.0",
      },
      bundleDependencies: [],
    });

    await expect(
      authority.installBundledZstdPrebuilds({
        releasePackageRoot: fixture.releaseRoot,
        platform: "linux",
        arch: "x64",
        prebuildPolicy: fixture.policy,
      }),
    ).rejects.toThrow("release manifest must be exact");
  });
});
