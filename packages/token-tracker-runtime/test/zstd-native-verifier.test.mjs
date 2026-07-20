import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  inspectZstdPrebuildArchive,
  validateGpgVerificationStatus,
} from "../../../scripts/release/audit-zstd-native-prebuild.mjs";
import {
  loadZstdNativePolicy,
  validateZstdNativePolicy,
  verifyInstalledZstdNative,
  zstdNativeArchiveUrl,
  zstdNativePlatformKey,
} from "../../../scripts/release/zstd-native-verifier.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const workspaceSidecarDirectory = join(
  repositoryRoot,
  "node_modules",
  "tokentracker-cli",
);
const workspaceZstdDirectory = join(
  repositoryRoot,
  "node_modules",
  "@mongodb-js",
  "zstd",
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
  writeTarOctal(header, 100, 8, 0o777);
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
  const padding = Buffer.alloc(Math.ceil(bytes.length / 512) * 512 - bytes.length);
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

async function installedFixture() {
  const root = await mkdtemp(join(tmpdir(), "tokenmonster-zstd-installed-test-"));
  const sidecarPackageDirectory = join(root, "tokentracker-cli");
  const zstdPackageDirectory = join(root, "zstd");
  const bindingPath = join(zstdPackageDirectory, "build", "Release", "zstd.node");
  await mkdir(sidecarPackageDirectory, { recursive: true });
  await mkdir(dirname(bindingPath), { recursive: true });
  await copyFile(
    join(workspaceSidecarDirectory, "package.json"),
    join(sidecarPackageDirectory, "package.json"),
  );
  await copyFile(
    join(workspaceZstdDirectory, "package.json"),
    join(zstdPackageDirectory, "package.json"),
  );
  await copyFile(
    join(workspaceZstdDirectory, "build", "Release", "zstd.node"),
    bindingPath,
  );
  return { root, sidecarPackageDirectory, zstdPackageDirectory, bindingPath };
}

describe("authenticated @mongodb-js/zstd native prebuild policy", () => {
  it("pins the exact sidecar chain, official signer, URL shape, and three CI platforms", async () => {
    const policy = await loadZstdNativePolicy();
    expect(policy).toMatchObject({
      schemaVersion: "1",
      dependency: {
        sidecarPackage: "tokentracker-cli",
        sidecarVersion: "0.80.0",
        nativePackage: "@mongodb-js/zstd",
        nativeVersion: "2.0.1",
        sidecarDependencySpecifier: "^2.0.1",
      },
      source: {
        repositoryUrl: "https://github.com/mongodb-js/zstd",
        releaseTag: "v2.0.1",
        releaseAssetBaseUrl:
          "https://github.com/mongodb-js/zstd/releases/download/v2.0.1",
        signingKeyUrl: "https://pgp.mongodb.com/node-driver.asc",
        signingKeyFingerprint:
          "9CABA99E47FA20E21F8409E5C6666E424A119C64",
        napiVersion: 4,
      },
      runtimeVerifier: {
        archiveEntry:
          "node_modules/@tokenmonster/token-tracker-runtime/dist/zstd-native-verifier.js",
        sha256:
          "36c117e8ade4c63ba7fd4843df9589450799eee117d3c86367073547a7286734",
      },
    });
    expect(Object.keys(policy.platforms)).toEqual([
      "linux-x64",
      "darwin-arm64",
      "win32-x64",
    ]);
    expect(policy.platforms).toEqual({
      "linux-x64": {
        platform: "linux",
        arch: "x64",
        archiveName: "zstd-v2.0.1-napi-v4-linux-x64.tar.gz",
        archiveBytes: 399393,
        archiveSha256:
          "92c56d6e7b2cdd3614c98e08e7c28caef208977a943f44b3ddeca690ed25da4b",
        bindingPath: "build/Release/zstd.node",
        bindingBytes: 955312,
        bindingSha256:
          "5dcaf25b03359d2786b3cb39ae5f305739e65e627f30236585ceece1ab896c94",
      },
      "darwin-arm64": {
        platform: "darwin",
        arch: "arm64",
        archiveName: "zstd-v2.0.1-napi-v4-darwin-arm64.tar.gz",
        archiveBytes: 579039,
        archiveSha256:
          "1ce2361053c84792c29d4fa0bcea0242d7c7ce4c0c2867d8529f6175bb2a253c",
        bindingPath: "build/Release/zstd.node",
        bindingBytes: 1469032,
        bindingSha256:
          "3aebbdd58549b5d43dfc424129b6e572912612d9d65490dade37c22aebeb1872",
      },
      "win32-x64": {
        platform: "win32",
        arch: "x64",
        archiveName: "zstd-v2.0.1-napi-v4-win32-x64.tar.gz",
        archiveBytes: 240073,
        archiveSha256:
          "10aa97840eaf7449806c4e600cb8f48f7926dc89bf08fdc5d99295fa7e21729e",
        bindingPath: "build/Release/zstd.node",
        bindingBytes: 611840,
        bindingSha256:
          "a9a5067d0363dba5299f4072ae1525fed633029ddbc8d943dd1dd77a6342cf93",
      },
    });
    for (const entry of Object.values(policy.platforms)) {
      expect(zstdNativeArchiveUrl(policy, entry)).toBe(
        `${policy.source.releaseAssetBaseUrl}/${entry.archiveName}`,
      );
    }
  });

  it("fails closed on policy URL, fingerprint, shape, and platform drift", async () => {
    const policy = await loadZstdNativePolicy();
    const changedUrl = clone(policy);
    changedUrl.source.signingKeyUrl = "https://example.test/node-driver.asc";
    expect(() => validateZstdNativePolicy(changedUrl)).toThrow(
      /signingKeyUrl/u,
    );

    const changedFingerprint = clone(policy);
    changedFingerprint.source.signingKeyFingerprint = "0".repeat(40);
    expect(() => validateZstdNativePolicy(changedFingerprint)).toThrow(
      /signingKeyFingerprint/u,
    );

    const extraPlatform = clone(policy);
    extraPlatform.platforms["darwin-x64"] = clone(
      extraPlatform.platforms["darwin-arm64"],
    );
    expect(() => validateZstdNativePolicy(extraPlatform)).toThrow(
      /exactly/u,
    );

    const extraField = clone(policy);
    extraField.platforms["linux-x64"].unreviewed = true;
    expect(() => validateZstdNativePolicy(extraField)).toThrow(/exactly/u);

    const changedVerifier = clone(policy);
    changedVerifier.runtimeVerifier.sha256 = "A".repeat(64);
    expect(() => validateZstdNativePolicy(changedVerifier)).toThrow(
      /lowercase SHA-256/u,
    );
    const changedVerifierPath = clone(policy);
    changedVerifierPath.runtimeVerifier.archiveEntry = "dist/other.js";
    expect(() => validateZstdNativePolicy(changedVerifierPath)).toThrow(
      /runtimeVerifier\.archiveEntry/u,
    );
  });

  it("verifies the current installed native binding entirely from local bytes", async () => {
    const result = await verifyInstalledZstdNative({
      sidecarPackageDirectory: workspaceSidecarDirectory,
      zstdPackageDirectory: workspaceZstdDirectory,
    });
    expect(result).toMatchObject({
      platformKey: zstdNativePlatformKey(),
      sidecar: "tokentracker-cli@0.80.0",
      nativePackage: "@mongodb-js/zstd@2.0.1",
      bindingPath: "build/Release/zstd.node",
    });
  });

  it("rejects same-size binding substitution and installed package drift", async () => {
    const fixture = await installedFixture();
    try {
      await expect(
        verifyInstalledZstdNative({
          sidecarPackageDirectory: fixture.sidecarPackageDirectory,
          zstdPackageDirectory: fixture.zstdPackageDirectory,
        }),
      ).resolves.toMatchObject({ platformKey: zstdNativePlatformKey() });

      const binding = await readFile(fixture.bindingPath);
      binding[0] ^= 0xff;
      await writeFile(fixture.bindingPath, binding);
      await expect(
        verifyInstalledZstdNative({
          sidecarPackageDirectory: fixture.sidecarPackageDirectory,
          zstdPackageDirectory: fixture.zstdPackageDirectory,
        }),
      ).rejects.toThrow(/SHA-256 differs/u);

      const zstdManifestPath = join(fixture.zstdPackageDirectory, "package.json");
      const zstdManifest = JSON.parse(await readFile(zstdManifestPath, "utf8"));
      zstdManifest.version = "2.0.2";
      await writeFile(zstdManifestPath, `${JSON.stringify(zstdManifest)}\n`);
      await expect(
        verifyInstalledZstdNative({
          sidecarPackageDirectory: fixture.sidecarPackageDirectory,
          zstdPackageDirectory: fixture.zstdPackageDirectory,
        }),
      ).rejects.toThrow(/package version/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("accepts only one exact, digest-bound native entry in the prebuild archive", async () => {
    const policy = await loadZstdNativePolicy();
    const entry = policy.platforms[zstdNativePlatformKey()];
    expect(entry).toBeDefined();
    const binding = await readFile(
      join(workspaceZstdDirectory, "build", "Release", "zstd.node"),
    );
    expect(binding.length).toBe(entry.bindingBytes);
    expect(sha256(binding)).toBe(entry.bindingSha256);

    const archive = tarArchive([{ path: entry.bindingPath, bytes: binding }]);
    expect(inspectZstdPrebuildArchive(archive, entry)).toEqual({
      bindingPath: entry.bindingPath,
      bindingBytes: entry.bindingBytes,
      bindingSha256: entry.bindingSha256,
    });
    expect(() =>
      inspectZstdPrebuildArchive(
        tarArchive([{ path: "../zstd.node", bytes: binding }]),
        entry,
      ),
    ).toThrow(/must be exactly/u);
    expect(() =>
      inspectZstdPrebuildArchive(
        tarArchive([
          { path: entry.bindingPath, bytes: binding },
          { path: entry.bindingPath, bytes: binding },
        ]),
        entry,
      ),
    ).toThrow(/one entry/u);
    expect(() =>
      inspectZstdPrebuildArchive(
        gzipSync(tarEntry(entry.bindingPath, binding)),
        entry,
      ),
    ).toThrow(/termination/u);

    const corruptTar = gunzipSync(archive);
    corruptTar[0] ^= 0x01;
    expect(() =>
      inspectZstdPrebuildArchive(gzipSync(corruptTar), entry),
    ).toThrow(/checksum/u);
  });

  it("requires one valid detached signature from the pinned primary key", () => {
    const fingerprint = "9CABA99E47FA20E21F8409E5C6666E424A119C64";
    const validStatus = [
      "[GNUPG:] NEWSIG",
      "[GNUPG:] GOODSIG C6666E424A119C64 MongoDB Node Driver Release Signing Key",
      `[GNUPG:] VALIDSIG ${fingerprint} 2025-03-19 1742402345 0 4 0 1 8 00 ${fingerprint}`,
      "[GNUPG:] TRUST_UNDEFINED 0 pgp",
      "",
    ].join("\n");
    expect(validateGpgVerificationStatus(validStatus, fingerprint)).toEqual({
      signingFingerprint: fingerprint,
      primaryFingerprint: fingerprint,
    });
    expect(() =>
      validateGpgVerificationStatus(
        validStatus.replaceAll(fingerprint, "0".repeat(40)),
        fingerprint,
      ),
    ).toThrow(/pinned MongoDB key/u);
    expect(() =>
      validateGpgVerificationStatus(
        `${validStatus}[GNUPG:] BADSIG C6666E424A119C64 bad\n`,
        fingerprint,
      ),
    ).toThrow(/one valid/u);
  });
});
