#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  collectSidecarClosure,
  createReleaseShrinkwrap,
  exactSidecarDependencyPins,
} from "./sidecar-lock.mjs";
import {
  PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY,
  requirePublicAssetAuthority,
  requirePublicStagedFile,
} from "./public-artifact-policy.mjs";
import { resolveCliReleaseVersion } from "./cli-release-version.mjs";
import { stageZstdNativeReleaseBundle } from "./zstd-native-release-bundle.mjs";

const SCRIPT_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

// Every workspace package vendored into the release tarball. The CLI package
// is the tarball root; the rest ship physically under its node_modules so the
// artifact installs without access to a private registry.
const CLI_PACKAGE = "packages/cli";
const VENDORED_PACKAGES = [
  "packages/byok-openai",
  "packages/companion-gateway",
  "packages/companion-ui",
  "packages/contracts",
  "packages/contribution-runtime",
  "packages/local-store",
  "packages/secret-vault",
  "packages/token-tracker-adapter",
  "packages/token-tracker-runtime",
  "packages/characters",
  "packages/monster-engine",
];
// Registry roots required by the physically bundled workspaces. Their complete
// production dependency closure is resolved from the exact local install and
// bundled too; public installs must not silently reach the registry for these
// runtime dependencies.
const VENDORED_REGISTRY_ROOTS = [
  { name: "yauzl", ownerPackage: "packages/characters" },
  { name: "zod", ownerPackage: "packages/characters" },
];
const ZSTD_NATIVE_PACKAGE = Object.freeze({
  name: "@mongodb-js/zstd",
  version: "2.0.1",
});
const ZSTD_PREINSTALL_AUTHORITY = join(
  SCRIPT_ROOT,
  "packages",
  "cli",
  "release",
  "preinstall-zstd.cjs",
);
const ZSTD_PREINSTALL_COMMAND = "node preinstall-zstd.cjs";
const FORBIDDEN_ASSET_TRANSPORT_MARKERS = [
  "https://cdn.ted-h.com/tokenmonster/characters/v1",
  "TOKENMONSTER_CHARACTER_CDN",
  "CompanionCharacterFetch",
  "DownloadSemaphore",
  "asset fetch failed",
];

function usage() {
  return `Usage: node scripts/release/build-release.mjs [options]

Options:
  --out <dir>            Output directory (default: dist-release)
  --version <v>          Use one exact release version, e.g. 0.1.0-rc.11
  --version-suffix <s>   Append a prerelease suffix, e.g. rc.1
  --zstd-prebuilds <dir> Authenticated @mongodb-js/zstd native archives (required)
  --skip-build           Skip the workspace build step
  --help                 Show this help`;
}

function parseArguments(argv) {
  let outDir = join(SCRIPT_ROOT, "dist-release");
  let exactVersion = null;
  let versionSuffix = null;
  let zstdPrebuildsDirectory = null;
  let skipBuild = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (
      argument === "--out" ||
      argument === "--version" ||
      argument === "--version-suffix" ||
      argument === "--zstd-prebuilds"
    ) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--out") {
        outDir = resolve(value);
      } else if (argument === "--version") {
        exactVersion = value;
      } else if (argument === "--zstd-prebuilds") {
        zstdPrebuildsDirectory = resolve(value);
      } else {
        versionSuffix = value;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (exactVersion !== null && versionSuffix !== null) {
    throw new Error("--version and --version-suffix are mutually exclusive");
  }
  if (zstdPrebuildsDirectory === null) {
    throw new Error("--zstd-prebuilds is required");
  }
  return {
    exactVersion,
    outDir,
    versionSuffix,
    zstdPrebuildsDirectory,
    skipBuild,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: SCRIPT_ROOT,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function stageZstdPreinstallAuthority(stagingDir) {
  const before = await lstat(ZSTD_PREINSTALL_AUTHORITY);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1
  ) {
    throw new Error("Zstd preinstall authority must be one physical file");
  }
  const authorityBytes = await readFile(ZSTD_PREINSTALL_AUTHORITY);
  const after = await lstat(ZSTD_PREINSTALL_AUTHORITY);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.nlink !== after.nlink ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    authorityBytes.length !== before.size
  ) {
    throw new Error("Zstd preinstall authority changed while staging");
  }

  const stagedPath = join(stagingDir, "preinstall-zstd.cjs");
  await writeFile(stagedPath, authorityBytes, { flag: "wx", mode: 0o644 });
  const stagedMetadata = await lstat(stagedPath);
  const stagedBytes = await readFile(stagedPath);
  if (
    !stagedMetadata.isFile() ||
    stagedMetadata.isSymbolicLink() ||
    stagedMetadata.nlink !== 1 ||
    !stagedBytes.equals(authorityBytes)
  ) {
    throw new Error("Staged zstd preinstall authority is not byte-exact");
  }
}

// Walk up from the repo root so this also works from a git worktree whose
// node_modules lives in the primary checkout.
function packageNameSegments(name) {
  if (typeof name !== "string" || name.length === 0 || name.includes("\0")) {
    throw new Error("Registry dependency has an invalid package name");
  }
  const segments = name.split("/");
  const validSegment = (segment) =>
    /^[a-z0-9][a-z0-9._~-]*$/u.test(segment);
  if (
    (name.startsWith("@") &&
      (segments.length !== 2 ||
        !validSegment(segments[0]?.slice(1) ?? "") ||
        !validSegment(segments[1] ?? ""))) ||
    (!name.startsWith("@") &&
      (segments.length !== 1 || !validSegment(segments[0] ?? "")))
  ) {
    throw new Error(`Registry dependency has an unsafe package name: ${name}`);
  }
  return segments;
}

async function findInstalledPackage(name, startDirectory) {
  const segments = packageNameSegments(name);
  let current = resolve(startDirectory);
  for (let depth = 0; depth < 16; depth += 1) {
    const candidate = join(current, "node_modules", ...segments);
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`${name} is not a physical installed package`);
      }
      const manifest = await readJson(join(candidate, "package.json"));
      if (manifest.name !== name) {
        throw new Error(`${name} resolved to a mismatched package manifest`);
      }
      return candidate;
    } catch (error) {
      if (error instanceof Error && !error.message.includes("ENOENT")) {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  throw new Error(`Could not locate an installed copy of ${name}`);
}

async function collectVendoredRegistryPackages() {
  const pending = [];
  for (const root of VENDORED_REGISTRY_ROOTS) {
    const ownerDirectory = join(SCRIPT_ROOT, root.ownerPackage);
    const ownerManifest = await readJson(join(ownerDirectory, "package.json"));
    const exactVersion = ownerManifest.dependencies?.[root.name];
    if (
      typeof exactVersion !== "string" ||
      !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u.test(
        exactVersion,
      )
    ) {
      throw new Error(
        `${ownerManifest.name} must exact-pin bundled registry dependency ${root.name}`,
      );
    }
    pending.push({
      name: root.name,
      fromDirectory: ownerDirectory,
      exactVersion,
    });
  }

  const packages = new Map();
  while (pending.length > 0) {
    const request = pending.shift();
    if (request === undefined) break;
    const packageDirectory = await findInstalledPackage(
      request.name,
      request.fromDirectory,
    );
    const manifest = await readJson(join(packageDirectory, "package.json"));
    if (
      typeof manifest.version !== "string" ||
      manifest.version.length === 0 ||
      manifest.version.includes("\0")
    ) {
      throw new Error(`${request.name} has an invalid installed version`);
    }
    if (
      request.exactVersion !== undefined &&
      manifest.version !== request.exactVersion
    ) {
      throw new Error(
        `${request.name}@${manifest.version} does not match exact pin ${request.exactVersion}`,
      );
    }
    const existing = packages.get(request.name);
    if (existing !== undefined) {
      if (existing.manifest.version !== manifest.version) {
        throw new Error(
          `Bundled registry dependency ${request.name} resolves to multiple versions`,
        );
      }
      continue;
    }
    if (
      manifest.peerDependencies !== undefined &&
      Object.keys(manifest.peerDependencies).length > 0
    ) {
      throw new Error(
        `${request.name}@${manifest.version} has peer dependencies; review the release bundler before adding it`,
      );
    }
    packages.set(request.name, { packageDirectory, manifest });

    const dependencyFields = [
      manifest.dependencies ?? {},
      manifest.optionalDependencies ?? {},
    ];
    const dependencyNames = new Set(
      dependencyFields.flatMap((dependencies) => Object.keys(dependencies)),
    );
    for (const dependencyName of [...dependencyNames].sort()) {
      packageNameSegments(dependencyName);
      const specifiers = dependencyFields
        .map((dependencies) => dependencies[dependencyName])
        .filter((specifier) => specifier !== undefined);
      if (
        specifiers.some(
          (specifier) =>
            typeof specifier !== "string" ||
            specifier.length === 0 ||
            specifier.includes("\0"),
        )
      ) {
        throw new Error(
          `${request.name} has an invalid dependency specifier for ${dependencyName}`,
        );
      }
      pending.push({
        name: dependencyName,
        fromDirectory: packageDirectory,
      });
    }
  }
  return [...packages.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

async function copyPackageFiles(packageDir, destinationFor) {
  const manifest = await readJson(join(packageDir, "package.json"));
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${manifest.name} must declare a files allowlist`);
  }
  const destination = destinationFor(manifest);
  await mkdir(destination, { recursive: true });
  await writeFile(
    join(destination, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  for (const entry of manifest.files) {
    const source = join(packageDir, entry);
    try {
      await stat(source);
    } catch {
      continue;
    }
    await cp(source, join(destination, entry), {
      recursive: true,
      dereference: true,
    });
  }
  // Every workspace package ships compiled output; a missing dist means the
  // build step was skipped on an unbuilt tree and the artifact would be empty.
  try {
    await stat(join(destination, "dist"));
  } catch {
    throw new Error(`${manifest.name} has no dist/ — build the workspaces first`);
  }
  return manifest;
}

async function requireStagedAssetAuthority(stagingDir) {
  const charactersDist = join(
    stagingDir,
    "node_modules",
    "@tokenmonster",
    "characters",
    "dist",
  );
  // Old incremental builds may leave this historical schema-v1 integrity file
  // behind. It is never public authority and is removed before inventorying.
  await rm(join(charactersDist, "approved-manifest.json"), { force: true });

  const jsonFileNames = (await readdir(charactersDist, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(jsonFileNames) !== '["approved-release-v2.json"]') {
    throw new Error(
      `Character runtime JSON inventory is not the single v2 authority slot: ${JSON.stringify(jsonFileNames)}`,
    );
  }

  const authorityPath = join(charactersDist, "approved-release-v2.json");
  const releaseModule = await import(
    pathToFileURL(join(charactersDist, "asset-release.js")).href
  );
  requirePublicAssetAuthority(
    PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY,
    await readFile(authorityPath),
    (authority) => releaseModule.AssetReleaseManifestV2Schema.parse(authority),
  );
}

async function assertAssetTransportDisabled(directory, root = directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Release staging contains a symbolic link: ${path}`);
    }
    if (metadata.isDirectory()) {
      await assertAssetTransportDisabled(path, root);
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`Release staging contains an unsupported entry: ${path}`);
    }
    const contents = await readFile(path);
    const archiveEntry = `package/${relative(root, path).split(sep).join("/")}`;
    requirePublicStagedFile(archiveEntry, contents);
    for (const marker of FORBIDDEN_ASSET_TRANSPORT_MARKERS) {
      if (contents.includes(marker)) {
        throw new Error(
          `Release staging contains disabled asset transport marker: ${marker}`,
        );
      }
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  if (!options.skipBuild) {
    run(process.execPath, [
      join(SCRIPT_ROOT, "scripts", "run-workspaces.mjs"),
      "build",
      "tokenmonster",
    ]);
  }

  const stagingParent = join(options.outDir, "staging");
  const stagingDir = join(stagingParent, "package");
  await rm(stagingParent, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  const cliManifest = await copyPackageFiles(
    join(SCRIPT_ROOT, CLI_PACKAGE),
    () => stagingDir,
  );
  if (cliManifest.scripts?.preinstall !== undefined) {
    throw new Error("Source CLI manifest must not declare preinstall");
  }
  await stageZstdPreinstallAuthority(stagingDir);

  const bundledNames = [];
  const bundledManifests = [];
  let sidecarPin = null;
  for (const packagePath of VENDORED_PACKAGES) {
    const manifest = await copyPackageFiles(
      join(SCRIPT_ROOT, packagePath),
      (staged) => join(stagingDir, "node_modules", ...staged.name.split("/")),
    );
    bundledNames.push(manifest.name);
    bundledManifests.push(manifest);
    const pin = manifest.dependencies?.["tokentracker-cli"];
    if (typeof pin === "string") {
      sidecarPin = pin;
    }
  }
  const registryVersions = new Map();
  for (const [name, { packageDirectory, manifest }] of
    await collectVendoredRegistryPackages()) {
    await cp(
      packageDirectory,
      join(stagingDir, "node_modules", ...packageNameSegments(name)),
      {
        recursive: true,
        dereference: false,
      },
    );
    registryVersions.set(name, manifest.version);
    bundledNames.push(`${name}@${manifest.version}`);
    bundledManifests.push(manifest);
  }
  const zstdPackageDirectory = await findInstalledPackage(
    ZSTD_NATIVE_PACKAGE.name,
    SCRIPT_ROOT,
  );
  const { manifest: zstdManifest } = await stageZstdNativeReleaseBundle({
    installedPackageDirectory: zstdPackageDirectory,
    prebuildsDirectory: options.zstdPrebuildsDirectory,
    destinationPackageDirectory: join(
      stagingDir,
      "node_modules",
      ...packageNameSegments(ZSTD_NATIVE_PACKAGE.name),
    ),
  });
  if (
    zstdManifest.name !== ZSTD_NATIVE_PACKAGE.name ||
    zstdManifest.version !== ZSTD_NATIVE_PACKAGE.version
  ) {
    throw new Error(
      `Native release bundle must be ${ZSTD_NATIVE_PACKAGE.name}@${ZSTD_NATIVE_PACKAGE.version}`,
    );
  }
  registryVersions.set(ZSTD_NATIVE_PACKAGE.name, ZSTD_NATIVE_PACKAGE.version);
  bundledNames.push(
    `${ZSTD_NATIVE_PACKAGE.name}@${ZSTD_NATIVE_PACKAGE.version}`,
  );
  bundledManifests.push(zstdManifest);
  if (sidecarPin === null) {
    throw new Error("Could not derive the tokentracker-cli pin");
  }

  await requireStagedAssetAuthority(stagingDir);

  const rootLock = await readJson(join(SCRIPT_ROOT, "package-lock.json"));
  // npm ignores a dependency package's shrinkwrap when installing the public
  // tarball under npx/global/user prefixes. Promote every audited sidecar
  // closure version to an exact direct pin so upstream semver ranges cannot
  // resolve newer, unreviewed bytes before the post-install lock comparison.
  const sidecarDependencyPins = exactSidecarDependencyPins(
    rootLock,
    sidecarPin,
  );
  const registryDependencies = Object.fromEntries(registryVersions);
  const version = resolveCliReleaseVersion(cliManifest.version, options);
  const releaseManifest = {
    name: cliManifest.name,
    version,
    description:
      "Local-first AI usage companion with unlockable letter-person characters.",
    type: cliManifest.type,
    bin: cliManifest.bin,
    engines: cliManifest.engines,
    scripts: {
      preinstall: ZSTD_PREINSTALL_COMMAND,
    },
    dependencies: {
      "@tokenmonster/byok-openai": cliManifest.version,
      "@tokenmonster/companion-gateway": cliManifest.version,
      "@tokenmonster/companion-ui": cliManifest.version,
      "@tokenmonster/contracts": cliManifest.version,
      "@tokenmonster/contribution-runtime": cliManifest.version,
      "@tokenmonster/local-store": cliManifest.version,
      "@tokenmonster/secret-vault": cliManifest.version,
      "@tokenmonster/token-tracker-adapter": cliManifest.version,
      "@tokenmonster/token-tracker-runtime": cliManifest.version,
      "@tokenmonster/characters": cliManifest.version,
      "@tokenmonster/monster-engine": cliManifest.version,
      ...sidecarDependencyPins,
      ...registryDependencies,
    },
    bundleDependencies: [
      "@tokenmonster/byok-openai",
      "@tokenmonster/companion-gateway",
      "@tokenmonster/companion-ui",
      "@tokenmonster/contracts",
      "@tokenmonster/contribution-runtime",
      "@tokenmonster/local-store",
      "@tokenmonster/secret-vault",
      "@tokenmonster/token-tracker-adapter",
      "@tokenmonster/token-tracker-runtime",
      "@tokenmonster/characters",
      "@tokenmonster/monster-engine",
      ...registryVersions.keys(),
    ],
  };
  await writeFile(
    join(stagingDir, "package.json"),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
  );
  const shrinkwrap = createReleaseShrinkwrap({
    rootLock,
    releaseManifest,
    bundledManifests,
  });
  const sidecarClosure = collectSidecarClosure(shrinkwrap, sidecarPin);
  const bundledSidecarPackages = sidecarClosure.filter(
    ({ entry }) => entry.inBundle === true,
  );
  if (
    !bundledSidecarPackages.some(
      ({ name, version }) =>
        name === ZSTD_NATIVE_PACKAGE.name &&
        version === ZSTD_NATIVE_PACKAGE.version,
    )
  ) {
    throw new Error(
      `${ZSTD_NATIVE_PACKAGE.name}@${ZSTD_NATIVE_PACKAGE.version} is not bundled in the sidecar closure`,
    );
  }
  await writeFile(
    join(stagingDir, "npm-shrinkwrap.json"),
    `${JSON.stringify(shrinkwrap, null, 2)}\n`,
  );
  await assertAssetTransportDisabled(stagingDir);

  const tarballName = `tokenmonster-${version}.tgz`;
  const tarballPath = join(options.outDir, tarballName);
  await rm(tarballPath, { force: true });
  // "package/" is the root directory npm expects inside the tarball; staging
  // already uses that name so plain tar works on both GNU tar and bsdtar.
  // Relative paths only: GNU tar reads "D:\..." as a remote host:file target.
  run("tar", ["-czf", tarballName, "-C", "staging", "package"], {
    cwd: options.outDir,
  });

  const tarballBytes = await readFile(tarballPath);
  const digest = createHash("sha256").update(tarballBytes).digest("hex");
  await writeFile(
    join(options.outDir, "SHASUMS256.txt"),
    `${digest}  ${tarballName}\n`,
  );

  console.log(`Release: ${tarballPath}`);
  console.log(`Size:    ${tarballBytes.length} bytes`);
  console.log(`SHA256:  ${digest}`);
  console.log(`Bundled: ${bundledNames.join(", ")}`);
  console.log(
    `Sidecar: tokentracker-cli@${sidecarPin} (${sidecarClosure.length} exact registry package records locked by npm-shrinkwrap.json; authenticated zstd archives bundled for dependency preinstall)`,
  );
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
