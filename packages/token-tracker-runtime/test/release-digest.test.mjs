import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  link,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  verifyPublicTarballEntries,
  verifyReleaseDigest,
} from "../../../scripts/release/verify-release-digest.mjs";
import {
  portablePublicTarEntryKey,
  PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY,
  PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRIES,
  PUBLIC_ASSET_PACK_ALLOWLIST_ARCHIVE_ENTRY,
  PUBLIC_ASSET_PACK_DESCRIPTOR_ARCHIVE_ENTRY,
  PUBLIC_EMBEDDED_STARTER_ARCHIVE_ENTRIES,
  PUBLIC_EMBEDDED_STARTER_ASSETS,
  PUBLIC_ZSTD_PREBUILD_ARCHIVE_ENTRIES,
  PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY,
  PUBLIC_ZSTD_PREINSTALL_COMMAND,
  requireApprovedPublicAssetRelease,
  requirePublicEmbeddedStarterAsset,
  requirePublicAssetAuthority,
  requirePublicAssetReleaseSlots,
  requirePublicStagedFile,
  requirePublicTarEntry,
  requirePublicZstdPrebuildArchive,
  requirePublicZstdPreinstallBootstrap,
} from "../../../scripts/release/public-artifact-policy.mjs";
import { ZSTD_NATIVE_PACKAGE_FILE_PATHS } from "../../../scripts/release/zstd-native-release-bundle.mjs";
import { ZSTD_NATIVE_POLICY } from "../src/zstd-native-verifier.ts";

const ZSTD_POLICY_ENTRY =
  "node_modules/@tokenmonster/token-tracker-runtime/dist/zstd-native-policy.json";
const ZSTD_VERIFIER_ENTRY =
  "node_modules/@tokenmonster/token-tracker-runtime/dist/zstd-native-verifier.js";
const BUILT_ZSTD_VERIFIER = resolve(
  import.meta.dirname,
  "..",
  "dist",
  "zstd-native-verifier.js",
);
const WORKSPACE_ZSTD_PACKAGE = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "node_modules",
  "@mongodb-js",
  "zstd",
);
const CLI_ZSTD_LICENSE = resolve(
  import.meta.dirname,
  "..",
  "..",
  "cli",
  "THIRD_PARTY_LICENSES",
  "Zstandard-1.5.6-BSD.txt",
);
const CLI_ZSTD_PREINSTALL = resolve(
  import.meta.dirname,
  "..",
  "..",
  "cli",
  "release",
  "preinstall-zstd.cjs",
);
const ZSTD_PACKAGE_PREFIX = "node_modules/@mongodb-js/zstd";
const FORBIDDEN_RELEASE_DEVELOPMENT_PACKAGES = [
  "@cloudflare/vite-plugin",
  "miniflare",
  "sharp",
  "wrangler",
];
const UPSTREAM_ZSTD_MANIFEST = JSON.parse(
  await readFile(join(WORKSPACE_ZSTD_PACKAGE, "package.json"), "utf8"),
);
const ZSTD_PREINSTALL_BOOTSTRAP = await readFile(CLI_ZSTD_PREINSTALL);
const CHARACTER_SLOT_SOURCE_ROOT = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "packages",
  "characters",
  "src",
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeTarText(header, offset, length, value) {
  const bytes = Buffer.from(value, "ascii");
  if (bytes.length > length) throw new Error("test tar field is too long");
  bytes.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  writeTarText(
    header,
    offset,
    length,
    `${value.toString(8).padStart(length - 1, "0")}\0`,
  );
}

function tarEntry(path, bytes) {
  const header = Buffer.alloc(512);
  writeTarText(header, 0, 100, path);
  writeTarOctal(header, 100, 8, 0o755);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, bytes.length);
  writeTarOctal(header, 136, 12, 1_742_402_345);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeTarText(header, 257, 6, "ustar\0");
  writeTarText(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc(
    Math.ceil(bytes.length / 512) * 512 - bytes.length,
  );
  return Buffer.concat([header, bytes, padding]);
}

function tarArchive(entries) {
  return gzipSync(
    Buffer.concat([
      ...entries.map(({ path, bytes }) => tarEntry(path, bytes)),
      Buffer.alloc(1024),
    ]),
  );
}

function createTestZstdAuthority() {
  const policy = clone(ZSTD_NATIVE_POLICY);
  const archives = new Map();
  for (const [platformKey, platform] of Object.entries(policy.platforms)) {
    const binding = Buffer.from(`test zstd binding for ${platformKey}\n`);
    const archive = tarArchive([
      { path: platform.bindingPath, bytes: binding },
    ]);
    platform.bindingBytes = binding.length;
    platform.bindingSha256 = sha256(binding);
    platform.archiveBytes = archive.length;
    platform.archiveSha256 = sha256(archive);
    archives.set(platform.archiveName, archive);
  }
  return Object.freeze({ archives, policy });
}

const TEST_ZSTD = createTestZstdAuthority();

function zstdShrinkwrapEntry(overrides = {}) {
  return {
    version: "2.0.1",
    resolved: "https://registry.npmjs.org/@mongodb-js/zstd/-/zstd-2.0.1.tgz",
    integrity:
      "sha512-hbQKltFj0hMrhe+Udh9gjkzswIJJVOo55vEHgfHbb6wjPpo4Oc3kng2bao/XnzLPCdd5Q1PXbWTC91LYPQrCtA==",
    hasInstallScript: true,
    license: "Apache-2.0",
    dependencies: {
      "node-addon-api": "^4.3.0",
      "prebuild-install": "^7.1.3",
    },
    engines: { node: ">= 16.20.1" },
    inBundle: true,
    ...overrides,
  };
}

const directories = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixture(entryName = "index.js", options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tokenmonster-digest-"));
  directories.push(directory);
  const version = options.version ?? "0.1.0-rc.11";
  const tarballName = `tokenmonster-${version}.tgz`;
  const packageDirectory = join(directory, "package");
  await mkdir(packageDirectory);
  const zstdDependency = options.zstdDependency ?? "2.0.1";
  const bundleDependencies = options.bundleDependencies ?? ["@mongodb-js/zstd"];
  const releaseDependencies = options.releaseDependencies ?? {
    "@mongodb-js/zstd": zstdDependency,
  };
  const releaseBundleDependencies =
    options.releaseBundleDependencies ?? bundleDependencies;
  const shrinkwrapRootDependencies =
    options.shrinkwrapRootDependencies ?? {
      "@mongodb-js/zstd": zstdDependency,
    };
  const shrinkwrapRootBundleDependencies =
    options.shrinkwrapRootBundleDependencies ?? bundleDependencies;
  const releaseScripts = Object.prototype.hasOwnProperty.call(
    options,
    "releaseScripts",
  )
    ? options.releaseScripts
    : { preinstall: PUBLIC_ZSTD_PREINSTALL_COMMAND };
  const releaseManifest = {
    name: "tokenmonster",
    version,
    dependencies: releaseDependencies,
    bundleDependencies: releaseBundleDependencies,
  };
  if (releaseScripts !== undefined) releaseManifest.scripts = releaseScripts;
  await writeFile(
    join(packageDirectory, "package.json"),
    `${JSON.stringify(releaseManifest)}\n`,
  );
  if (options.includeZstdPreinstall !== false) {
    await writeFile(
      join(packageDirectory, "preinstall-zstd.cjs"),
      options.zstdPreinstallBytes ?? ZSTD_PREINSTALL_BOOTSTRAP,
    );
  }
  if (options.includeZstdTransitiveLicense !== false) {
    const licensePath = join(
      packageDirectory,
      "THIRD_PARTY_LICENSES",
      "Zstandard-1.5.6-BSD.txt",
    );
    await mkdir(dirname(licensePath), { recursive: true });
    if (options.zstdTransitiveLicense !== undefined) {
      await writeFile(licensePath, options.zstdTransitiveLicense);
    } else {
      await copyFile(CLI_ZSTD_LICENSE, licensePath);
    }
  }
  const entryPath = join(packageDirectory, entryName);
  await mkdir(dirname(entryPath), { recursive: true });
  await writeFile(entryPath, "fixture text\n");
  if (options.hardlinkEntry !== undefined) {
    const hardlinkPath = join(packageDirectory, options.hardlinkEntry);
    await mkdir(dirname(hardlinkPath), { recursive: true });
    await link(entryPath, hardlinkPath);
  }
  if (options.symlinkEntry !== undefined) {
    const symlinkPath = join(packageDirectory, options.symlinkEntry);
    await mkdir(dirname(symlinkPath), { recursive: true });
    await symlink(entryPath, symlinkPath, "file");
  }
  for (const additionalEntry of options.additionalEntries ?? []) {
    const additionalPath = join(packageDirectory, additionalEntry);
    await mkdir(dirname(additionalPath), { recursive: true });
    await writeFile(additionalPath, "additional fixture text\n");
  }
  if (options.includeAssetSlots !== false) {
    for (const archiveEntry of PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRIES) {
      if ((options.omitAssetSlots ?? []).includes(archiveEntry)) continue;
      const destination = join(
        packageDirectory,
        archiveEntry.slice("package/".length),
      );
      await mkdir(dirname(destination), { recursive: true });
      const override = options.assetSlotOverrides?.[archiveEntry];
      await writeFile(
        destination,
        override ??
          (await readFile(
            join(CHARACTER_SLOT_SOURCE_ROOT, basename(archiveEntry)),
          )),
      );
    }
  }
  if (options.includeZstdPolicy !== false) {
    const policyPath = join(packageDirectory, ZSTD_POLICY_ENTRY);
    await mkdir(dirname(policyPath), { recursive: true });
    await writeFile(
      policyPath,
      `${JSON.stringify(options.zstdPolicy ?? TEST_ZSTD.policy, null, 2)}\n`,
    );
  }
  if (options.includeZstdVerifier !== false) {
    const verifierPath = join(packageDirectory, ZSTD_VERIFIER_ENTRY);
    await mkdir(dirname(verifierPath), { recursive: true });
    await writeFile(
      verifierPath,
      options.zstdVerifier ?? (await readFile(BUILT_ZSTD_VERIFIER)),
    );
  }
  if (options.includeZstdBundle !== false) {
    for (const relativePath of ZSTD_NATIVE_PACKAGE_FILE_PATHS) {
      if ((options.omitZstdPaths ?? []).includes(relativePath)) continue;
      const destination = join(
        packageDirectory,
        ZSTD_PACKAGE_PREFIX,
        relativePath,
      );
      await mkdir(dirname(destination), { recursive: true });
      if (relativePath === "package.json") {
        await writeFile(
          destination,
          `${JSON.stringify(options.zstdManifest ?? UPSTREAM_ZSTD_MANIFEST)}\n`,
        );
      } else if (
        relativePath === "LICENSE.md" &&
        options.zstdPackageLicense !== undefined
      ) {
        await writeFile(destination, options.zstdPackageLicense);
      } else {
        await copyFile(join(WORKSPACE_ZSTD_PACKAGE, relativePath), destination);
      }
    }
    for (const [archiveName, archive] of TEST_ZSTD.archives) {
      const relativePath = `prebuilds/${archiveName}`;
      if ((options.omitZstdPaths ?? []).includes(relativePath)) continue;
      const destination = join(
        packageDirectory,
        ZSTD_PACKAGE_PREFIX,
        relativePath,
      );
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, archive);
    }
  }
  const shrinkwrap = {
    name: "tokenmonster",
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "tokenmonster",
        version,
        dependencies: shrinkwrapRootDependencies,
        bundleDependencies: shrinkwrapRootBundleDependencies,
      },
      [ZSTD_PACKAGE_PREFIX]: zstdShrinkwrapEntry(
        options.zstdShrinkwrapOverrides,
      ),
      ...(options.additionalZstdShrinkwrapPath === undefined
        ? {}
        : {
            [options.additionalZstdShrinkwrapPath]: zstdShrinkwrapEntry(),
          }),
      ...(options.additionalShrinkwrapPackages ?? {}),
    },
  };
  await writeFile(
    join(packageDirectory, "npm-shrinkwrap.json"),
    `${JSON.stringify(shrinkwrap, null, 2)}\n`,
  );
  const archive = spawnSync(
    "tar",
    ["-czf", join(directory, tarballName), "-C", directory, "package"],
    { encoding: "utf8" },
  );
  if (archive.status !== 0) {
    throw new Error(`test tar creation failed: ${archive.stderr}`);
  }
  const bytes = await readFile(join(directory, tarballName));
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(
    join(directory, "SHASUMS256.txt"),
    `${digest}  ${tarballName}\n`,
  );
  return { directory, tarballName, bytes: bytes.length, digest };
}

function verifyFixture(directory, options = {}) {
  return verifyReleaseDigest(directory, {
    // Unit fixtures contain no committed raster bytes. Production callers do
    // not provide this override and must carry the exact reviewed starter set.
    embeddedStarterAssets: [],
    zstdPolicy: TEST_ZSTD.policy,
    ...options,
  });
}

describe("cross-platform release digest verifier", () => {
  it("accepts one exact canonical tarball record", async () => {
    const { directory, tarballName, bytes, digest } = await fixture();
    await expect(verifyFixture(directory)).resolves.toMatchObject({
      tarballName,
      bytes,
      sha256: digest,
      entryCount: 36,
      version: "0.1.0-rc.11",
    });
    await expect(
      verifyFixture(directory, { expectedVersion: "0.1.0-rc.11" }),
    ).resolves.toBeDefined();
    await expect(
      verifyFixture(directory, { expectedVersion: "0.1.0-rc.12" }),
    ).rejects.toThrow(/expected release version/u);
  });

  it("rejects changed bytes and ambiguous tarball inventories", async () => {
    const changed = await fixture();
    await writeFile(join(changed.directory, changed.tarballName), "changed");
    await expect(verifyFixture(changed.directory)).rejects.toThrow(
      /SHA-256 differs/u,
    );

    const ambiguous = await fixture();
    await writeFile(join(ambiguous.directory, "tokenmonster-extra.tgz"), "x");
    await expect(verifyFixture(ambiguous.directory)).rejects.toThrow(
      /exactly the checksummed tarball/u,
    );
  });

  it("rejects hardlink tar entries before reading package content", async () => {
    const hardlinked = await fixture("review-source", {
      hardlinkEntry: "review-target",
    });
    await expect(verifyFixture(hardlinked.directory)).rejects.toThrow(
      /regular files or directories/u,
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlink tar entries before reading package content",
    async () => {
      const symlinked = await fixture("review-source", {
        symlinkEntry: "review-target",
      });
      await expect(verifyFixture(symlinked.directory)).rejects.toThrow(
        /regular files or directories/u,
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "detects a tarball path overwritten after its immutable read",
    async () => {
      const original = await fixture("original.js");
      const replacement = await fixture("replacement.js");
      const wrapperDirectory = await mkdtemp(
        join(tmpdir(), "tokenmonster-tar-wrapper-"),
      );
      directories.push(wrapperDirectory);
      const realTar = spawnSync("sh", ["-c", "command -v tar"], {
        encoding: "utf8",
      }).stdout.trim();
      expect(realTar).not.toBe("");
      const wrapperPath = join(wrapperDirectory, "tar");
      await writeFile(
        wrapperPath,
        [
          "#!/bin/sh",
          'if [ ! -e "$TOKENMONSTER_TEST_SWAP_DONE" ]; then',
          '  : > "$TOKENMONSTER_TEST_SWAP_DONE"',
          '  cp "$TOKENMONSTER_TEST_SWAP_SOURCE" "$TOKENMONSTER_TEST_SWAP_TARGET"',
          "fi",
          'exec "$TOKENMONSTER_TEST_REAL_TAR" "$@"',
          "",
        ].join("\n"),
      );
      await chmod(wrapperPath, 0o755);

      const previousEnvironment = {
        path: process.env.PATH,
        done: process.env.TOKENMONSTER_TEST_SWAP_DONE,
        source: process.env.TOKENMONSTER_TEST_SWAP_SOURCE,
        target: process.env.TOKENMONSTER_TEST_SWAP_TARGET,
        realTar: process.env.TOKENMONSTER_TEST_REAL_TAR,
      };
      process.env.PATH = `${wrapperDirectory}:${process.env.PATH ?? ""}`;
      process.env.TOKENMONSTER_TEST_SWAP_DONE = join(
        wrapperDirectory,
        "swapped",
      );
      process.env.TOKENMONSTER_TEST_SWAP_SOURCE = join(
        replacement.directory,
        replacement.tarballName,
      );
      process.env.TOKENMONSTER_TEST_SWAP_TARGET = join(
        original.directory,
        original.tarballName,
      );
      process.env.TOKENMONSTER_TEST_REAL_TAR = realTar;
      try {
        await expect(verifyFixture(original.directory)).rejects.toThrow(
          /changed during verification/u,
        );
      } finally {
        for (const [name, value] of [
          ["PATH", previousEnvironment.path],
          ["TOKENMONSTER_TEST_SWAP_DONE", previousEnvironment.done],
          ["TOKENMONSTER_TEST_SWAP_SOURCE", previousEnvironment.source],
          ["TOKENMONSTER_TEST_SWAP_TARGET", previousEnvironment.target],
          ["TOKENMONSTER_TEST_REAL_TAR", previousEnvironment.realTar],
        ]) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    },
  );

  it("rejects binary asset extensions case-insensitively", async () => {
    const denied = await fixture("avatar.PNG");
    await expect(verifyFixture(denied.directory)).rejects.toThrow(
      /forbidden binary asset/u,
    );
  });

  it.each(FORBIDDEN_RELEASE_DEVELOPMENT_PACKAGES)(
    "rejects development-only package %s by name from every release surface",
    async (packageName) => {
      const expectedError = new RegExp(
        `forbidden development-only package ${packageName.replace(
          /[.*+?^${}()|[\]\\]/gu,
          "\\$&",
        )}`,
        "u",
      );
      const dependencyVersion = "1.0.0";
      const candidates = [
        await fixture("index.js", {
          releaseDependencies: {
            "@mongodb-js/zstd": "2.0.1",
            [packageName]: dependencyVersion,
          },
        }),
        await fixture("index.js", {
          releaseBundleDependencies: ["@mongodb-js/zstd", packageName],
        }),
        await fixture("index.js", {
          shrinkwrapRootDependencies: {
            "@mongodb-js/zstd": "2.0.1",
            [packageName]: dependencyVersion,
          },
        }),
        await fixture("index.js", {
          shrinkwrapRootBundleDependencies: [
            "@mongodb-js/zstd",
            packageName,
          ],
        }),
        await fixture("index.js", {
          additionalShrinkwrapPackages: {
            [`node_modules/${packageName}`]: { version: dependencyVersion },
          },
        }),
      ];
      for (const candidate of candidates) {
        await expect(verifyFixture(candidate.directory)).rejects.toThrow(
          expectedError,
        );
      }

      expect(() =>
        verifyPublicTarballEntries([
          "package/",
          `package/node_modules/${packageName}/index.js`,
        ]),
      ).toThrow(expectedError);
    },
    // Five sequential subprocess verifications legitimately exceed the
    // default 5s budget on the slowest CI runners.
    { timeout: 30_000 },
  );

  it("keeps package-name boundaries exact in the tar inventory allowlist", () => {
    for (const packageName of [
      "@cloudflare/vite-plugin-extra",
      "miniflare-worker",
      "sharpness",
      "wrangler-tools",
    ]) {
      expect(() =>
        verifyPublicTarballEntries([
          "package/",
          `package/node_modules/${packageName}/index.js`,
        ]),
      ).not.toThrow();
    }
  });

  it("requires the fixed embedded starter inventory by default", async () => {
    const missing = await fixture();
    await expect(
      verifyReleaseDigest(missing.directory, {
        zstdPolicy: TEST_ZSTD.policy,
      }),
    ).rejects.toThrow(/embedded starter asset inventory/u);
  });

  it("allows only the exact reviewed zstd archives and bootstrap", () => {
    expect(PUBLIC_ZSTD_PREBUILD_ARCHIVE_ENTRIES).toHaveLength(3);
    const platform = TEST_ZSTD.policy.platforms["linux-x64"];
    const entry = PUBLIC_ZSTD_PREBUILD_ARCHIVE_ENTRIES.find((candidate) =>
      candidate.endsWith(`/${platform.archiveName}`),
    );
    expect(entry).toBeDefined();
    const archive = TEST_ZSTD.archives.get(platform.archiveName);
    expect(archive).toBeDefined();
    for (const candidate of PUBLIC_ZSTD_PREBUILD_ARCHIVE_ENTRIES) {
      expect(requirePublicTarEntry(candidate)).toBe(candidate);
    }
    expect(requirePublicTarEntry(PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY)).toBe(
      PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY,
    );
    expect(
      requirePublicStagedFile(
        PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY,
        ZSTD_PREINSTALL_BOOTSTRAP,
      ),
    ).toBe(PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY);
    expect(
      requirePublicZstdPreinstallBootstrap(
        PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY,
        ZSTD_PREINSTALL_BOOTSTRAP,
      ),
    ).toBe(PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY);
    const changedBootstrap = Buffer.from(ZSTD_PREINSTALL_BOOTSTRAP);
    changedBootstrap[0] ^= 0xff;
    expect(() =>
      requirePublicZstdPreinstallBootstrap(
        PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY,
        changedBootstrap,
      ),
    ).toThrow(/SHA-256/u);
    expect(() =>
      requirePublicZstdPreinstallBootstrap(
        PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY,
        ZSTD_PREINSTALL_BOOTSTRAP.subarray(0, -1),
      ),
    ).toThrow(/byte length/u);
    expect(() =>
      requirePublicZstdPreinstallBootstrap(
        PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY,
        Buffer.concat([ZSTD_PREINSTALL_BOOTSTRAP, Buffer.from("x")]),
      ),
    ).toThrow(/byte length/u);
    expect(() =>
      requirePublicTarEntry("package/unreviewed-preinstall.cjs"),
    ).toThrow(/unreviewed root script/u);
    expect(() =>
      requirePublicTarEntry(
        "package/node_modules/@mongodb-js/zstd/prebuilds/unreviewed.tar.gz",
      ),
    ).toThrow(/forbidden binary asset/u);
    expect(requirePublicStagedFile(entry, archive, TEST_ZSTD.policy)).toBe(
      entry,
    );
    expect(
      requirePublicZstdPrebuildArchive(entry, archive, TEST_ZSTD.policy),
    ).toBe(entry);

    const changed = Buffer.from(archive);
    changed[changed.length - 1] ^= 0xff;
    expect(() =>
      requirePublicZstdPrebuildArchive(entry, changed, TEST_ZSTD.policy),
    ).toThrow(/SHA-256/u);
    expect(() =>
      requirePublicStagedFile(
        "package/node_modules/example/index.js",
        Buffer.from([0]),
      ),
    ).toThrow(/unknown binary/u);

    const duplicateArchive = tarArchive([
      { path: platform.bindingPath, bytes: Buffer.from("one") },
      { path: platform.bindingPath, bytes: Buffer.from("two") },
    ]);
    const duplicatePolicy = clone(TEST_ZSTD.policy);
    duplicatePolicy.platforms["linux-x64"].archiveBytes =
      duplicateArchive.length;
    duplicatePolicy.platforms["linux-x64"].archiveSha256 =
      sha256(duplicateArchive);
    expect(() =>
      requirePublicZstdPrebuildArchive(
        entry,
        duplicateArchive,
        duplicatePolicy,
      ),
    ).toThrow(/one entry/u);
  });

  it("allows only the eight hash-pinned embedded starter WebP paths", () => {
    expect(PUBLIC_EMBEDDED_STARTER_ARCHIVE_ENTRIES).toHaveLength(8);
    expect(PUBLIC_EMBEDDED_STARTER_ASSETS).toHaveLength(8);
    for (const entry of PUBLIC_EMBEDDED_STARTER_ARCHIVE_ENTRIES) {
      expect(requirePublicTarEntry(entry)).toBe(entry);
    }
    expect(() =>
      requirePublicTarEntry(
        "package/node_modules/@tokenmonster/characters/dist/embedded-starter-assets/objects/unreviewed.webp",
      ),
    ).toThrow(/forbidden binary asset/u);
    const expected = PUBLIC_EMBEDDED_STARTER_ASSETS[0];
    expect(() =>
      requirePublicEmbeddedStarterAsset(
        expected.archiveEntry,
        Buffer.alloc(expected.bytes),
      ),
    ).toThrow(/bytes differ/u);
  });

  it("accepts the portable shapes used by the current public inventory", () => {
    const inventory = [
      "package/",
      "package/README.md",
      "package/npm-shrinkwrap.json",
      "package/node_modules/@tokenmonster/token-tracker-runtime/dist/network-deny.d.cts",
      "package/node_modules/zod/src/v4/core/json-schema-processors.ts",
    ];
    for (const entry of inventory) {
      expect(requirePublicTarEntry(entry)).toBe(entry);
    }
    expect(portablePublicTarEntryKey("package/README.md")).toBe(
      "package/readme.md",
    );
  });

  it("rejects ASCII case collisions and non-portable Windows names", async () => {
    expect(() =>
      verifyPublicTarballEntries([
        "package/",
        "package/index.js",
        "package/Index.js",
      ]),
    ).toThrow(/portable path collision/u);

    const reserved = await fixture("CON");
    await expect(verifyFixture(reserved.directory)).rejects.toThrow(
      /portable names/u,
    );
  });

  it("rejects Unicode instead of approximating portable case folding", async () => {
    const nonPortableEntries = [
      "package/\u03a3.js",
      "package/\u03c2.js",
      "package/COM\u00b9.txt",
      "package/caf\u00e9.js",
      "package/cafe\u0301.js",
    ];
    for (const entry of nonPortableEntries) {
      expect(() => requirePublicTarEntry(entry)).toThrow(/portable names/u);
      expect(() => portablePublicTarEntryKey(entry)).toThrow(/portable names/u);
    }

    const sigmaCaseFold = await fixture("\u03a3.js", {
      additionalEntries: ["\u03c2.js"],
    });
    await expect(verifyFixture(sigmaCaseFold.directory)).rejects.toThrow(
      /portable names/u,
    );

    const normalization = await fixture("caf\u00e9.js", {
      additionalEntries: ["cafe\u0301.js"],
    });
    await expect(verifyFixture(normalization.directory)).rejects.toThrow(
      /portable names/u,
    );

    const superscriptDeviceName = await fixture("COM\u00b9.txt");
    await expect(
      verifyFixture(superscriptDeviceName.directory),
    ).rejects.toThrow(/portable names/u);
  });

  it("rejects trailing dots, spaces, illegal characters, and long components", () => {
    const nonPortableEntries = [
      "package/trailing.",
      "package/trailing ",
      "package/has space.js",
      "package/has:colon.js",
      "package/.hidden",
      `package/${"a".repeat(256)}.js`,
    ];
    for (const entry of nonPortableEntries) {
      expect(() => requirePublicTarEntry(entry)).toThrow(/portable names/u);
    }
  });

  it("requires the exact shipped zstd policy and verifier inventory", async () => {
    const missingPolicy = await fixture("index.js", {
      includeZstdPolicy: false,
    });
    await expect(verifyFixture(missingPolicy.directory)).rejects.toThrow(
      /omits the shipped zstd native policy/u,
    );

    const missingVerifier = await fixture("index.js", {
      includeZstdVerifier: false,
    });
    await expect(verifyFixture(missingVerifier.directory)).rejects.toThrow(
      /omits the shipped zstd native verifier/u,
    );

    const changedPolicy = clone(TEST_ZSTD.policy);
    changedPolicy.platforms["linux-x64"].archiveSha256 = "0".repeat(64);
    const drifted = await fixture("index.js", {
      zstdPolicy: changedPolicy,
    });
    await expect(verifyFixture(drifted.directory)).rejects.toThrow(
      /differs from the release authority/u,
    );

    const verifierBytes = await readFile(BUILT_ZSTD_VERIFIER);
    verifierBytes[0] ^= 0xff;
    const changedVerifier = await fixture("index.js", {
      zstdVerifier: verifierBytes,
    });
    await expect(verifyFixture(changedVerifier.directory)).rejects.toThrow(
      /verifier differs from its pinned bytes/u,
    );
  });

  it("binds one exact zstd bootstrap to the only release lifecycle hook", async () => {
    const missingBootstrap = await fixture("index.js", {
      includeZstdPreinstall: false,
    });
    await expect(verifyFixture(missingBootstrap.directory)).rejects.toThrow(
      /omits the fixed zstd preinstall bootstrap/u,
    );

    const changedBootstrap = Buffer.from(ZSTD_PREINSTALL_BOOTSTRAP);
    changedBootstrap[0] ^= 0xff;
    const driftedBootstrap = await fixture("index.js", {
      zstdPreinstallBytes: changedBootstrap,
    });
    await expect(verifyFixture(driftedBootstrap.directory)).rejects.toThrow(
      /preinstall SHA-256 differs/u,
    );

    const missingHook = await fixture("index.js", {
      releaseScripts: undefined,
    });
    await expect(verifyFixture(missingHook.directory)).rejects.toThrow(
      /scripts must contain only the fixed zstd preinstall command/u,
    );

    const changedHook = await fixture("index.js", {
      releaseScripts: { preinstall: "node another-script.cjs" },
    });
    await expect(verifyFixture(changedHook.directory)).rejects.toThrow(
      /scripts must contain only the fixed zstd preinstall command/u,
    );

    const extraHook = await fixture("index.js", {
      releaseScripts: {
        preinstall: PUBLIC_ZSTD_PREINSTALL_COMMAND,
        postinstall: "node postinstall.cjs",
      },
    });
    await expect(verifyFixture(extraHook.directory)).rejects.toThrow(
      /scripts must contain only the fixed zstd preinstall command/u,
    );
  });

  it("requires the exact bundled zstd files without a raw or host build", async () => {
    const archiveName = TEST_ZSTD.policy.platforms["linux-x64"].archiveName;
    const missingArchive = await fixture("index.js", {
      omitZstdPaths: [`prebuilds/${archiveName}`],
    });
    await expect(verifyFixture(missingArchive.directory)).rejects.toThrow(
      /fixed policy/u,
    );

    const missingLicense = await fixture("index.js", {
      omitZstdPaths: ["LICENSE.md"],
    });
    await expect(verifyFixture(missingLicense.directory)).rejects.toThrow(
      /fixed policy|license/u,
    );

    const missingTransitiveLicense = await fixture("index.js", {
      includeZstdTransitiveLicense: false,
    });
    await expect(
      verifyFixture(missingTransitiveLicense.directory),
    ).rejects.toThrow(/pinned Zstandard license/u);

    const changedPackageLicense = await fixture("index.js", {
      zstdPackageLicense: "changed license\n",
    });
    await expect(
      verifyFixture(changedPackageLicense.directory),
    ).rejects.toThrow(/reviewed bytes/u);

    const changedTransitiveLicense = await fixture("index.js", {
      zstdTransitiveLicense: "changed license\n",
    });
    await expect(
      verifyFixture(changedTransitiveLicense.directory),
    ).rejects.toThrow(/reviewed bytes/u);

    const rawBinding = await fixture("index.js", {
      additionalEntries: [
        "node_modules/@mongodb-js/zstd/build/Release/zstd.node",
      ],
    });
    await expect(verifyFixture(rawBinding.directory)).rejects.toThrow(
      /forbidden binary asset/u,
    );

    const hostBuild = await fixture("index.js", {
      additionalEntries: ["node_modules/@mongodb-js/zstd/build/config.gypi"],
    });
    await expect(verifyFixture(hostBuild.directory)).rejects.toThrow(
      /fixed policy/u,
    );
  });

  it("binds zstd in the package manifest and shrinkwrap as one licensed bundle", async () => {
    const wrongRootPin = await fixture("index.js", {
      zstdDependency: "2.0.2",
    });
    await expect(verifyFixture(wrongRootPin.directory)).rejects.toThrow(
      /exact-pin bundled/u,
    );

    const manifest = clone(UPSTREAM_ZSTD_MANIFEST);
    manifest.license = "UNKNOWN";
    const wrongManifest = await fixture("index.js", {
      zstdManifest: manifest,
    });
    await expect(verifyFixture(wrongManifest.directory)).rejects.toThrow(
      /manifest differs/u,
    );

    const unbundled = await fixture("index.js", {
      zstdShrinkwrapOverrides: { inBundle: false },
    });
    await expect(verifyFixture(unbundled.directory)).rejects.toThrow(
      /bundled provenance/u,
    );

    const ambiguous = await fixture("index.js", {
      additionalZstdShrinkwrapPath:
        "node_modules/tokentracker-cli/node_modules/@mongodb-js/zstd",
    });
    await expect(verifyFixture(ambiguous.directory)).rejects.toThrow(
      /ambiguous zstd package path/u,
    );
  });

  it("allows only the three fixed character authority JSON paths", async () => {
    for (const entry of PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRIES) {
      expect(requirePublicTarEntry(entry)).toBe(entry);
    }

    const exact = await fixture();
    await expect(verifyFixture(exact.directory)).resolves.toBeDefined();

    const legacy = await fixture(
      "node_modules/@tokenmonster/characters/dist/approved-manifest.json",
    );
    await expect(verifyFixture(legacy.directory)).rejects.toThrow(
      /non-authority character JSON/u,
    );
  });

  it("requires all three trusted asset slots with exact source bytes", async () => {
    const missing = await fixture("index.js", {
      includeAssetSlots: false,
    });
    await expect(verifyFixture(missing.directory)).rejects.toThrow(
      /omits trusted asset slot/u,
    );

    const partial = await fixture("index.js", {
      omitAssetSlots: [PUBLIC_ASSET_PACK_ALLOWLIST_ARCHIVE_ENTRY],
    });
    await expect(verifyFixture(partial.directory)).rejects.toThrow(
      /omits trusted asset slot/u,
    );

    const tampered = await fixture("index.js", {
      assetSlotOverrides: {
        [PUBLIC_ASSET_PACK_DESCRIPTOR_ARCHIVE_ENTRY]: Buffer.from("null \n"),
      },
    });
    await expect(verifyFixture(tampered.directory)).rejects.toThrow(
      /differs from trusted source bytes/u,
    );

    expect(() =>
      requireApprovedPublicAssetRelease({
        releaseManifest: Buffer.from("null\n"),
        descriptor: Buffer.from("null\n"),
        allowlist: Buffer.from("null\n"),
      }),
    ).toThrow(/differs from the reviewed release policy/u);
  });

  it("rejects malformed and legacy authority content before staging", () => {
    const strictV2 = (authority) => {
      if (authority.releaseId !== "valid-release") {
        throw new Error("strict v2 validation failed");
      }
      return authority;
    };
    expect(
      requirePublicAssetAuthority(
        PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY,
        Buffer.from("null\n"),
        strictV2,
      ),
    ).toBeNull();
    expect(() =>
      requirePublicAssetAuthority(
        PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY,
        Buffer.from('{"schemaVersion":"1"}\n'),
        strictV2,
      ),
    ).toThrow(/null or schema-v2/u);
    expect(() =>
      requirePublicAssetAuthority(
        PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY,
        Buffer.from('{"schemaVersion":"2"}\n'),
        strictV2,
      ),
    ).toThrow(/strict v2 validation failed/u);
  });

  it("requires all three asset release slots to be null or strictly cross-bound", () => {
    const nullSlot = Buffer.from("null\n");
    const release = Buffer.from(
      '{"schemaVersion":"2","releaseId":"valid-release"}\n',
    );
    const descriptor = Buffer.from(
      '{"schemaVersion":"1","releaseId":"valid-release"}\n',
    );
    const allowlist = Buffer.from(
      '{"schemaVersion":"1","releaseId":"valid-release"}\n',
    );
    const validators = {
      validateReleaseV2: (value) => value,
      validateDescriptorV1: (value) => value,
      validateAllowlistV1: (value) => value,
      validateBinding: ({
        releaseManifest,
        descriptor: candidateDescriptor,
      }) => {
        if (releaseManifest.releaseId !== candidateDescriptor.releaseId) {
          throw new Error("strict cross-binding failed");
        }
      },
    };

    expect(
      requirePublicAssetReleaseSlots(
        {
          releaseManifest: nullSlot,
          descriptor: nullSlot,
          allowlist: nullSlot,
        },
        validators,
      ),
    ).toBeNull();
    expect(() =>
      requirePublicAssetReleaseSlots(
        { releaseManifest: release, descriptor: nullSlot, allowlist: nullSlot },
        validators,
      ),
    ).toThrow(/all null or all configured/u);
    expect(() =>
      requirePublicAssetReleaseSlots(
        {
          releaseManifest: release,
          descriptor: Buffer.from('{"schemaVersion":"2"}\n'),
          allowlist,
        },
        validators,
      ),
    ).toThrow(/pack descriptor must be null or schema-v1/u);
    expect(() =>
      requirePublicAssetReleaseSlots(
        { releaseManifest: release, descriptor, allowlist },
        {
          validateReleaseV2: validators.validateReleaseV2,
          validateDescriptorV1: validators.validateDescriptorV1,
          validateAllowlistV1: validators.validateAllowlistV1,
        },
      ),
    ).toThrow(/strict cross-binding validation/u);
    expect(
      requirePublicAssetReleaseSlots(
        { releaseManifest: release, descriptor, allowlist },
        validators,
      ),
    ).toMatchObject({
      releaseManifest: { releaseId: "valid-release" },
      descriptor: { releaseId: "valid-release" },
      allowlist: { releaseId: "valid-release" },
    });
    expect(() =>
      requirePublicAssetReleaseSlots(
        {
          releaseManifest: release,
          descriptor: Buffer.from(
            '{"schemaVersion":"1","releaseId":"other-release"}\n',
          ),
          allowlist,
        },
        validators,
      ),
    ).toThrow(/strict cross-binding failed/u);
  });
});
