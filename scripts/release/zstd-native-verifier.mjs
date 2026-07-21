#!/usr/bin/env node

import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadZstdNativePolicy,
  validateZstdNativePolicy,
  verifyInstalledZstdNative,
  verifyInstalledZstdNativeFromSidecarManifest,
  zstdNativeArchiveUrl,
  zstdNativePlatformKey,
  zstdNativePlatformPolicy,
  ZSTD_NATIVE_POLICY,
} from "../../packages/token-tracker-runtime/src/zstd-native-verifier.ts";

export {
  loadZstdNativePolicy,
  validateZstdNativePolicy,
  verifyInstalledZstdNative,
  verifyInstalledZstdNativeFromSidecarManifest,
  zstdNativeArchiveUrl,
  zstdNativePlatformKey,
  zstdNativePlatformPolicy,
  ZSTD_NATIVE_POLICY,
};

async function findInstalledPackageDirectories(installRoot) {
  const sidecarPackageDirectory = join(
    installRoot,
    "node_modules",
    "tokentracker-cli",
  );
  const nestedZstdDirectory = join(
    sidecarPackageDirectory,
    "node_modules",
    "@mongodb-js",
    "zstd",
  );
  const rootZstdDirectory = join(
    installRoot,
    "node_modules",
    "@mongodb-js",
    "zstd",
  );
  const nestedMetadata = await lstat(nestedZstdDirectory).catch(() => null);
  return {
    sidecarPackageDirectory,
    zstdPackageDirectory:
      nestedMetadata === null ? rootZstdDirectory : nestedZstdDirectory,
  };
}

async function runCommandLine() {
  const [flag, installRoot] = process.argv.slice(2);
  if (
    process.argv.length !== 4 ||
    flag !== "--installed-root" ||
    installRoot === undefined
  ) {
    console.error(
      "Usage: node scripts/release/zstd-native-verifier.mjs --installed-root <directory>",
    );
    process.exitCode = 1;
    return;
  }
  const directories = await findInstalledPackageDirectories(resolve(installRoot));
  const result = await verifyInstalledZstdNative(directories);
  console.log(
    `ZSTD NATIVE VERIFY: PASS (${result.platformKey}, ${result.bindingBytes} bytes, sha256 ${result.bindingSha256})`,
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    await runCommandLine();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    console.error(`ZSTD NATIVE VERIFY: FAIL (${message})`);
    process.exitCode = 1;
  }
}
