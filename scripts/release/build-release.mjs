#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

// Every workspace package vendored into the release tarball. The CLI package
// is the tarball root; the rest ship physically under its node_modules so the
// artifact installs without access to a private registry.
const CLI_PACKAGE = "packages/cli";
const VENDORED_PACKAGES = [
  "packages/companion-gateway",
  "packages/companion-ui",
  "packages/token-tracker-adapter",
  "packages/token-tracker-runtime",
  "packages/characters",
  "packages/monster-engine",
];
const VENDORED_REGISTRY_PACKAGES = ["zod"];

function usage() {
  return `Usage: node scripts/release/build-release.mjs [options]

Options:
  --out <dir>            Output directory (default: dist-release)
  --version-suffix <s>   Append a prerelease suffix, e.g. rc.1
  --skip-build           Skip the workspace build step
  --help                 Show this help`;
}

function parseArguments(argv) {
  let outDir = join(SCRIPT_ROOT, "dist-release");
  let versionSuffix = null;
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
    if (argument === "--out" || argument === "--version-suffix") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--out") {
        outDir = resolve(value);
      } else {
        versionSuffix = value;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { outDir, versionSuffix, skipBuild };
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

// Walk up from the repo root so this also works from a git worktree whose
// node_modules lives in the primary checkout.
async function findInstalledPackage(name) {
  let current = SCRIPT_ROOT;
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(current, "node_modules", name);
    try {
      await stat(join(candidate, "package.json"));
      return candidate;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  throw new Error(`Could not locate an installed copy of ${name}`);
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
    await cp(source, join(destination, entry), { recursive: true });
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

  const bundledNames = [];
  let sidecarPin = null;
  for (const packagePath of VENDORED_PACKAGES) {
    const manifest = await copyPackageFiles(
      join(SCRIPT_ROOT, packagePath),
      (staged) => join(stagingDir, "node_modules", ...staged.name.split("/")),
    );
    bundledNames.push(manifest.name);
    const pin = manifest.dependencies?.["tokentracker-cli"];
    if (typeof pin === "string") {
      sidecarPin = pin;
    }
  }
  const registryVersions = new Map();
  for (const name of VENDORED_REGISTRY_PACKAGES) {
    const packageDir = await findInstalledPackage(name);
    const manifest = await readJson(join(packageDir, "package.json"));
    await cp(packageDir, join(stagingDir, "node_modules", name), {
      recursive: true,
    });
    registryVersions.set(name, manifest.version);
    bundledNames.push(`${name}@${manifest.version}`);
  }
  if (sidecarPin === null) {
    throw new Error("Could not derive the tokentracker-cli pin");
  }

  const zodVersion = registryVersions.get("zod");
  const version =
    options.versionSuffix === null
      ? cliManifest.version
      : `${cliManifest.version}-${options.versionSuffix}`;
  const releaseManifest = {
    name: cliManifest.name,
    version,
    description:
      "Local-first AI usage companion with unlockable letter-person characters.",
    type: cliManifest.type,
    bin: cliManifest.bin,
    engines: cliManifest.engines,
    dependencies: {
      "@tokenmonster/companion-gateway": cliManifest.version,
      "@tokenmonster/companion-ui": cliManifest.version,
      "@tokenmonster/token-tracker-adapter": cliManifest.version,
      "@tokenmonster/token-tracker-runtime": cliManifest.version,
      "@tokenmonster/characters": cliManifest.version,
      "@tokenmonster/monster-engine": cliManifest.version,
      "tokentracker-cli": sidecarPin,
      zod: zodVersion,
    },
    bundleDependencies: [
      "@tokenmonster/companion-gateway",
      "@tokenmonster/companion-ui",
      "@tokenmonster/token-tracker-adapter",
      "@tokenmonster/token-tracker-runtime",
      "@tokenmonster/characters",
      "@tokenmonster/monster-engine",
      "zod",
    ],
  };
  await writeFile(
    join(stagingDir, "package.json"),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
  );

  const tarballName = `tokenmonster-${version}.tgz`;
  const tarballPath = join(options.outDir, tarballName);
  await rm(tarballPath, { force: true });
  // "package/" is the root directory npm expects inside the tarball; staging
  // already uses that name so plain tar works on both GNU tar and bsdtar.
  run("tar", ["-czf", tarballPath, "-C", stagingParent, "package"]);

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
  console.log(`Sidecar: tokentracker-cli@${sidecarPin} (fetched at install)`);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
