import { createHash } from "node:crypto";
import {
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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  requireAuthenticatedPrebuildDirectory,
  requireBundledZstdManifest,
  stageZstdNativeReleaseBundle,
  ZSTD_NATIVE_BUNDLE_FILE_PATHS,
  ZSTD_NATIVE_PACKAGE_FILE_PATHS,
  ZSTD_NATIVE_PREBUILD_ARCHIVE_NAMES,
  ZSTD_NATIVE_PREBUILD_RELATIVE_PATHS,
} from "../../../scripts/release/zstd-native-release-bundle.mjs";
import { ZSTD_NATIVE_POLICY } from "../../../scripts/release/zstd-native-verifier.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const installedZstdPackage = join(
  repositoryRoot,
  "node_modules",
  "@mongodb-js",
  "zstd",
);

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

function tarArchive(path, bytes) {
  const header = Buffer.alloc(512);
  writeTarText(header, 0, 100, path);
  writeTarOctal(header, 100, 8, 0o644);
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
  writeTarText(
    header,
    148,
    8,
    `${checksum.toString(8).padStart(6, "0")}\0 `,
  );
  const padding = Buffer.alloc(
    Math.ceil(bytes.length / 512) * 512 - bytes.length,
  );
  return gzipSync(
    Buffer.concat([header, bytes, padding, Buffer.alloc(1_024)]),
  );
}

async function prebuildFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tokenmonster-zstd-bundle-test-")),
  );
  const prebuilds = join(root, "authenticated-prebuilds");
  await mkdir(prebuilds);
  const policy = JSON.parse(JSON.stringify(ZSTD_NATIVE_POLICY));
  const archives = new Map();
  for (const [platformKey, entry] of Object.entries(policy.platforms)) {
    const binding = Buffer.from(`authenticated ${platformKey} binding`);
    const archive = tarArchive(entry.bindingPath, binding);
    entry.bindingBytes = binding.length;
    entry.bindingSha256 = sha256(binding);
    entry.archiveBytes = archive.length;
    entry.archiveSha256 = sha256(archive);
    archives.set(entry.archiveName, archive);
    await writeFile(join(prebuilds, entry.archiveName), archive);
  }
  return { archives, policy, prebuilds, root };
}

async function portableInventory(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await portableInventory(root, path)));
    } else {
      files.push(path.slice(root.length + 1).replaceAll("\\", "/"));
    }
  }
  return files.sort();
}

describe("authenticated zstd native release bundle", () => {
  it("pins the ten published package files and three policy archive slots", () => {
    expect(ZSTD_NATIVE_PACKAGE_FILE_PATHS).toEqual([
      "LICENSE.md",
      "README.md",
      "addon/compression.cpp",
      "addon/compression.h",
      "addon/compression_worker.h",
      "addon/zstd.cpp",
      "binding.gyp",
      "index.d.ts",
      "lib/index.js",
      "package.json",
    ]);
    expect(ZSTD_NATIVE_PREBUILD_ARCHIVE_NAMES).toEqual(
      Object.values(ZSTD_NATIVE_POLICY.platforms).map(
        ({ archiveName }) => archiveName,
      ),
    );
    expect(ZSTD_NATIVE_PREBUILD_RELATIVE_PATHS).toEqual(
      ZSTD_NATIVE_PREBUILD_ARCHIVE_NAMES.map(
        (archiveName) => `prebuilds/${archiveName}`,
      ),
    );
    expect(ZSTD_NATIVE_BUNDLE_FILE_PATHS).toHaveLength(13);
  });

  it("requires the exact registry manifest and install fallback contract", async () => {
    const manifest = JSON.parse(
      await readFile(join(installedZstdPackage, "package.json"), "utf8"),
    );
    expect(requireBundledZstdManifest(manifest)).toMatchObject({
      name: "@mongodb-js/zstd",
      version: "2.0.1",
      dependencies: {
        "node-addon-api": "^4.3.0",
        "prebuild-install": "^7.1.3",
      },
      scripts: {
        install: "prebuild-install --runtime napi || npm run clean-install",
        "clean-install": "npm run install-zstd && npm run compile",
      },
    });
    manifest.scripts.install = "node unreviewed.js";
    expect(() => requireBundledZstdManifest(manifest)).toThrow(/pinned/u);
  });

  it("stages only the fixed package inventory and authenticated archives", async () => {
    const fixture = await prebuildFixture();
    const destination = join(fixture.root, "staged", "@mongodb-js", "zstd");
    try {
      const authenticated = await requireAuthenticatedPrebuildDirectory(
        fixture.prebuilds,
        fixture.policy,
      );
      expect(authenticated.archives).toHaveLength(3);
      const result = await stageZstdNativeReleaseBundle({
        installedPackageDirectory: installedZstdPackage,
        prebuildsDirectory: fixture.prebuilds,
        destinationPackageDirectory: destination,
        policy: fixture.policy,
      });
      expect(result.manifest).toMatchObject({
        name: "@mongodb-js/zstd",
        version: "2.0.1",
      });
      expect(
        requireBundledZstdManifest(
          JSON.parse(await readFile(join(destination, "package.json"), "utf8")),
        ),
      ).toEqual(result.manifest);
      expect(await readFile(join(destination, "package.json"))).toEqual(
        await readFile(join(installedZstdPackage, "package.json")),
      );
      expect(await portableInventory(destination)).toEqual(
        [...ZSTD_NATIVE_BUNDLE_FILE_PATHS].sort(),
      );
      await expect(
        lstat(join(destination, "build", "Release", "zstd.node")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      for (const [archiveName, expectedBytes] of fixture.archives) {
        expect(await readFile(join(destination, "prebuilds", archiveName))).toEqual(
          expectedBytes,
        );
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects extra, missing, substituted, and non-file prebuild entries", async () => {
    const fixture = await prebuildFixture();
    try {
      await writeFile(join(fixture.prebuilds, "unexpected"), "no");
      await expect(
        requireAuthenticatedPrebuildDirectory(
          fixture.prebuilds,
          fixture.policy,
        ),
      ).rejects.toThrow(/exactly the three/u);
      await rm(join(fixture.prebuilds, "unexpected"));

      const archiveName = ZSTD_NATIVE_PREBUILD_ARCHIVE_NAMES[0];
      const archivePath = join(fixture.prebuilds, archiveName);
      const original = await readFile(archivePath);
      const changed = Buffer.from(original);
      changed[0] ^= 0xff;
      await writeFile(archivePath, changed);
      await expect(
        requireAuthenticatedPrebuildDirectory(
          fixture.prebuilds,
          fixture.policy,
        ),
      ).rejects.toThrow(/SHA-256 differs/u);
      await writeFile(archivePath, original);

      const missingName = ZSTD_NATIVE_PREBUILD_ARCHIVE_NAMES[1];
      await rm(join(fixture.prebuilds, missingName));
      await expect(
        requireAuthenticatedPrebuildDirectory(
          fixture.prebuilds,
          fixture.policy,
        ),
      ).rejects.toThrow(/exactly the three/u);
      await mkdir(join(fixture.prebuilds, missingName));
      await expect(
        requireAuthenticatedPrebuildDirectory(
          fixture.prebuilds,
          fixture.policy,
        ),
      ).rejects.toThrow(/physical file/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("requires a fresh destination and rejects an invalid parent", async () => {
    const fixture = await prebuildFixture();
    const existing = join(fixture.root, "existing");
    await mkdir(existing);
    try {
      await expect(
        stageZstdNativeReleaseBundle({
          installedPackageDirectory: installedZstdPackage,
          prebuildsDirectory: fixture.prebuilds,
          destinationPackageDirectory: existing,
          policy: fixture.policy,
        }),
      ).rejects.toThrow(/must not already exist/u);

      const invalidParent = join(fixture.root, "blocked-parent");
      await writeFile(invalidParent, "not a directory");
      const partialDestination = join(invalidParent, "zstd");
      await expect(
        stageZstdNativeReleaseBundle({
          installedPackageDirectory: installedZstdPackage,
          prebuildsDirectory: fixture.prebuilds,
          destinationPackageDirectory: partialDestination,
          policy: fixture.policy,
        }),
      ).rejects.toThrow();
      expect(await lstat(partialDestination).catch(() => null)).toBeNull();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects symbolic prebuild archives and directory roots",
    async () => {
      const fixture = await prebuildFixture();
      const archiveName = ZSTD_NATIVE_PREBUILD_ARCHIVE_NAMES[0];
      const archivePath = join(fixture.prebuilds, archiveName);
      const backingPath = join(fixture.root, "archive-backing.tar.gz");
      try {
        await writeFile(backingPath, await readFile(archivePath));
        await rm(archivePath);
        await symlink(backingPath, archivePath);
        await expect(
          requireAuthenticatedPrebuildDirectory(
            fixture.prebuilds,
            fixture.policy,
          ),
        ).rejects.toThrow(/physical file/u);

        const rootLink = join(fixture.root, "prebuild-root-link");
        await symlink(fixture.prebuilds, rootLink, "dir");
        await expect(
          requireAuthenticatedPrebuildDirectory(rootLink, fixture.policy),
        ).rejects.toThrow(/physical directory/u);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );
});
