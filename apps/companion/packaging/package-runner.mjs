// @ts-check

import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { packager } from "@electron/packager";
import crossZip from "cross-zip";
import { createDMG } from "electron-installer-dmg";
import { convertVersion, createWindowsInstaller } from "electron-winstaller";

import packagingConfiguration, {
  finalizePackagedFuses,
  hardenPackagedPermissions,
} from "./package-config.mjs";
import { squirrelVersionFor } from "./release-policy.mjs";
import { verifySquirrelAwareExecutable } from "./squirrel-awareness.mjs";
import {
  finalizeReviewedSquirrelVendorOverlay,
  prepareReviewedSquirrelVendorOverlay,
  requireReviewedSquirrelReleaseMode,
} from "./squirrel-updater.mjs";

/** @typedef {"make" | "package"} PackagingCommand */
/** @typedef {import("@electron/packager").Options} PackagerOptions */
/** @typedef {import("@electron/packager").TargetArch} TargetArch */
/** @typedef {import("@electron/packager").TargetPlatform} TargetPlatform */
/** @typedef {import("electron-winstaller").SquirrelWindowsOptions} SquirrelWindowsOptions */
/** @typedef {typeof packagingConfiguration} PackagingConfiguration */

const companionDirectory = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const outDirectory = join(companionDirectory, "out");
const makeDirectory = join(outDirectory, "make");
const zip = promisify(crossZip.zip);

/**
 * @param {unknown} command
 * @returns {PackagingCommand}
 */
function requireCommand(command) {
  if (command !== "make" && command !== "package") {
    throw new Error("Usage: package-runner.mjs make|package");
  }
  return command;
}

export function expectedPackagePath(
  /** @type {TargetPlatform} */
  platform = process.platform,
  /** @type {TargetArch} */
  arch = process.arch,
  /** @type {PackagingConfiguration} */
  configuration = packagingConfiguration,
) {
  return join(outDirectory, `${configuration.appName}-${platform}-${arch}`);
}

export function zipArtifactPath(
  /** @type {string} */
  packagePath,
  /** @type {TargetPlatform} */
  platform = process.platform,
  /** @type {TargetArch} */
  arch = process.arch,
  /** @type {PackagingConfiguration} */
  configuration = packagingConfiguration,
) {
  return join(
    makeDirectory,
    "zip",
    platform,
    arch,
    `${basename(packagePath)}-${configuration.releaseVersion}.zip`,
  );
}

export async function makeZipArtifact(
  /** @type {string} */
  packagePath,
  /** @type {TargetPlatform} */
  platform = process.platform,
  /** @type {TargetArch} */
  arch = process.arch,
  /** @type {PackagingConfiguration} */
  configuration = packagingConfiguration,
) {
  const artifactPath = zipArtifactPath(
    packagePath,
    platform,
    arch,
    configuration,
  );
  const inputPath =
    platform === "darwin"
      ? join(packagePath, `${configuration.appName}.app`)
      : packagePath;
  await mkdir(dirname(artifactPath), { recursive: true });
  await rm(artifactPath, { force: true });
  await zip(inputPath, artifactPath);
  return artifactPath;
}

export async function makeDmgArtifact(
  /** @type {string} */
  packagePath,
  /** @type {PackagingConfiguration} */
  configuration = packagingConfiguration,
) {
  if (process.platform !== "darwin") {
    throw new Error("DMG creation requires a native macOS host.");
  }
  await mkdir(makeDirectory, { recursive: true });
  const artifactPath = join(makeDirectory, `${configuration.dmg.name}.dmg`);
  await createDMG({
    appPath: join(packagePath, `${configuration.appName}.app`),
    format: configuration.dmg.format,
    name: configuration.dmg.name,
    out: makeDirectory,
    overwrite: true,
  });
  return artifactPath;
}

export async function makeSquirrelArtifacts(
  /** @type {string} */
  packagePath,
  /** @type {TargetArch} */
  arch = process.arch,
  /** @type {PackagingConfiguration} */
  configuration = packagingConfiguration,
) {
  if (process.platform !== "win32") {
    throw new Error("Squirrel creation requires a native Windows host.");
  }
  const squirrelVersion = squirrelVersionFor(configuration.releaseVersion);
  if (convertVersion(configuration.releaseVersion) !== squirrelVersion) {
    throw new Error("Squirrel version projections do not match.");
  }
  const outputDirectory = join(makeDirectory, "squirrel.windows", arch);
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "tokenmonster-squirrel-maker-"),
  );
  const temporaryDirectory = join(temporaryRoot, "application");
  const vendorDirectory = join(temporaryRoot, "vendor");
  try {
    await cp(packagePath, temporaryDirectory, { recursive: true });
    await prepareReviewedSquirrelVendorOverlay(
      vendorDirectory,
      configuration.releaseMode,
    );
    await rm(outputDirectory, { force: true, recursive: true });
    await mkdir(outputDirectory, { recursive: true });
    await createWindowsInstaller(
      /** @type {SquirrelWindowsOptions} */ ({
        ...configuration.squirrel,
        appDirectory: temporaryDirectory,
        outputDirectory,
        vendorDirectory,
      }),
    );
    await finalizeReviewedSquirrelVendorOverlay(vendorDirectory);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
  return Object.freeze([
    join(outputDirectory, "RELEASES"),
    join(outputDirectory, configuration.squirrel.setupExe),
    join(
      outputDirectory,
      `${configuration.squirrel.name}-${squirrelVersion}-full.nupkg`,
    ),
  ]);
}

export async function makeArtifacts(
  /** @type {string} */
  packagePath,
  /** @type {TargetPlatform} */
  platform = process.platform,
  /** @type {TargetArch} */
  arch = process.arch,
  /** @type {PackagingConfiguration} */
  configuration = packagingConfiguration,
) {
  const artifacts = [
    await makeZipArtifact(packagePath, platform, arch, configuration),
  ];
  if (platform === "darwin") {
    artifacts.push(await makeDmgArtifact(packagePath, configuration));
  } else if (platform === "win32") {
    artifacts.push(
      ...(await makeSquirrelArtifacts(packagePath, arch, configuration)),
    );
  }
  return artifacts;
}

export async function runCompanionPackaging(
  /** @type {unknown} */
  command,
  {
    platform = process.platform,
    arch = process.arch,
    configuration = packagingConfiguration,
  } = /** @type {{
    platform?: TargetPlatform,
    arch?: TargetArch,
    configuration?: PackagingConfiguration
  }} */ ({}),
) {
  const parsedCommand = requireCommand(command);
  if (platform === "win32") {
    requireReviewedSquirrelReleaseMode(configuration.releaseMode);
    if (configuration.packagerConfig.icon === undefined) {
      throw new Error(
        "The four-sisters app icon staging is missing; package through scripts/package-companion.mjs.",
      );
    }
  }
  const packagePaths = await packager(
    /** @type {PackagerOptions} */ ({
      ...configuration.packagerConfig,
      arch,
      dir: companionDirectory,
      electronVersion: configuration.electronVersion,
      out: outDirectory,
      platform,
    }),
  );
  const expected = expectedPackagePath(platform, arch, configuration);
  const [actualPackagePath] = packagePaths;
  if (
    packagePaths.length !== 1 ||
    actualPackagePath === undefined ||
    resolve(actualPackagePath) !== resolve(expected)
  ) {
    throw new Error("Electron Packager returned an unexpected output path.");
  }
  if (platform === "win32") {
    await verifySquirrelAwareExecutable(
      join(expected, `${configuration.appName}.exe`),
    );
  }
  await hardenPackagedPermissions(packagePaths);
  await finalizePackagedFuses(expected, platform, arch);
  const artifacts =
    parsedCommand === "make"
      ? await makeArtifacts(expected, platform, arch, configuration)
      : [];
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    packagePaths: Object.freeze([...packagePaths]),
  });
}

const invokedPath = process.argv[1];
if (
  typeof invokedPath === "string" &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  await runCompanionPackaging(process.argv[2]);
}
