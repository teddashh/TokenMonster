import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  SIDECAR_MAX_FILE_COUNT,
  SIDECAR_MAX_TOTAL_BYTES,
  SIDECAR_MAX_TREE_DEPTH
} from "../apps/companion/packaging/package-bounds.mjs";

export {
  SIDECAR_MAX_FILE_COUNT,
  SIDECAR_MAX_TOTAL_BYTES,
  SIDECAR_MAX_TREE_DEPTH
};
export const SIDECAR_ROOT_LOCK_PATH = "node_modules/tokentracker-cli";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lockPackages(packageLock) {
  if (!isRecord(packageLock) || !isRecord(packageLock.packages)) {
    throw new Error("package-lock.json has no packages inventory.");
  }
  return packageLock.packages;
}

export function resolveLockedDependency(packageLock, entryPath, dependency) {
  const packages = lockPackages(packageLock);
  const candidates = [`${entryPath}/node_modules/${dependency}`];
  const segments = entryPath.split("/");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index] === "node_modules") {
      candidates.push(
        [...segments.slice(0, index + 1), ...dependency.split("/")].join("/")
      );
    }
  }
  return [...new Set(candidates)].find(
    (candidate) => packages[candidate] !== undefined
  );
}

export function sidecarDependencyClosure(
  packageLock,
  rootPath = SIDECAR_ROOT_LOCK_PATH
) {
  const packages = lockPackages(packageLock);
  const closure = new Set();
  const pending = [rootPath];
  while (pending.length > 0) {
    const entryPath = pending.shift();
    if (entryPath === undefined || closure.has(entryPath)) continue;
    const lockEntry = packages[entryPath];
    if (!isRecord(lockEntry)) {
      throw new Error(`Sidecar lock entry is missing: ${entryPath}.`);
    }
    closure.add(entryPath);
    for (const dependency of Object.keys(lockEntry.dependencies ?? {}).sort()) {
      const dependencyPath = resolveLockedDependency(
        packageLock,
        entryPath,
        dependency
      );
      if (dependencyPath === undefined) {
        throw new Error(
          `Sidecar hard dependency ${dependency} is missing from package-lock.json for ${entryPath}.`
        );
      }
      pending.push(dependencyPath);
    }
    for (const dependency of Object.keys(
      lockEntry.optionalDependencies ?? {}
    ).sort()) {
      const dependencyPath = resolveLockedDependency(
        packageLock,
        entryPath,
        dependency
      );
      if (dependencyPath !== undefined) pending.push(dependencyPath);
    }
  }
  if (closure.size > SIDECAR_MAX_FILE_COUNT) {
    throw new Error("Sidecar dependency closure exceeded its package bound.");
  }
  return [...closure].sort();
}

function safeDeclaration(input) {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.includes("\\") ||
    input.includes("\0") ||
    input.startsWith("/") ||
    ["!", "*", "?", "{", "}", "[", "]"].some((character) =>
      input.includes(character)
    )
  ) {
    return false;
  }
  const segments = input.replace(/\/$/u, "").split("/");
  return (
    segments.length >= 1 &&
    segments.every(
      (segment) => segment.length >= 1 && segment !== "." && segment !== ".."
    ) &&
    !segments.includes("node_modules")
  );
}

async function declaredFilesUnder(
  packageDirectory,
  path,
  files,
  depth = 0
) {
  if (depth > SIDECAR_MAX_TREE_DEPTH) {
    throw new Error("Declared sidecar package inventory exceeded its depth bound.");
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Declared sidecar package path is a symbolic link: ${path}.`);
  }
  if (metadata.isDirectory()) {
    for (const entry of (await readdir(path)).sort((left, right) =>
      left.localeCompare(right)
    )) {
      await declaredFilesUnder(
        packageDirectory,
        join(path, entry),
        files,
        depth + 1
      );
    }
    return;
  }
  if (!metadata.isFile()) {
    throw new Error(`Declared sidecar package path is not regular: ${path}.`);
  }
  const relativePath = relative(packageDirectory, path).split(sep).join("/");
  if (relativePath.startsWith("../") || relativePath === "..") {
    throw new Error("Declared sidecar package path escaped its package directory.");
  }
  files.add(relativePath);
  if (files.size > SIDECAR_MAX_FILE_COUNT) {
    throw new Error("Declared sidecar package inventory exceeded its file bound.");
  }
}

export async function declaredSidecarPackageFiles(
  packageDirectory,
  packageManifest
) {
  if (
    !isRecord(packageManifest) ||
    !Array.isArray(packageManifest.files) ||
    packageManifest.files.length < 1 ||
    packageManifest.files.length > 64 ||
    !isRecord(packageManifest.bin)
  ) {
    throw new Error("Sidecar package files/bin declarations are missing.");
  }
  const declarations = [
    "package.json",
    ...packageManifest.files,
    ...Object.values(packageManifest.bin)
  ];
  const files = new Set();
  for (const declaration of declarations) {
    if (!safeDeclaration(declaration)) {
      throw new Error(`Unsafe sidecar package file declaration: ${declaration}.`);
    }
    const path = resolve(packageDirectory, declaration.replace(/\/$/u, ""));
    if (
      path !== packageDirectory &&
      !path.startsWith(`${packageDirectory}${sep}`)
    ) {
      throw new Error("Sidecar package declaration escaped its package directory.");
    }
    await declaredFilesUnder(packageDirectory, path, files);
  }
  return [...files].sort();
}

export async function stagedSidecarPackagePaths(targetDirectory) {
  const packagePaths = new Set();
  async function scanNodeModules(nodeModulesDirectory, relativeDirectory, depth) {
    if (depth > SIDECAR_MAX_TREE_DEPTH) {
      throw new Error("Staged sidecar dependency inventory exceeded its depth bound.");
    }
    const entries = (await readdir(nodeModulesDirectory, {
      withFileTypes: true
    })).sort((left, right) => left.name.localeCompare(right.name));
    if (entries.length === 0) {
      throw new Error("Staged sidecar contains an empty node_modules directory.");
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".bin") {
        throw new Error(
          `Unexpected staged sidecar node_modules entry: ${relativeDirectory}/${entry.name}.`
        );
      }
      if (entry.name.startsWith("@")) {
        const scopeDirectory = join(nodeModulesDirectory, entry.name);
        const scopedEntries = (await readdir(scopeDirectory, {
          withFileTypes: true
        })).sort((left, right) => left.name.localeCompare(right.name));
        if (scopedEntries.length === 0) {
          throw new Error("Staged sidecar contains an empty package scope.");
        }
        for (const scopedEntry of scopedEntries) {
          if (!scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) {
            throw new Error("Staged sidecar scope contains a non-package entry.");
          }
          await recordPackage(
            join(scopeDirectory, scopedEntry.name),
            `${relativeDirectory}/${entry.name}/${scopedEntry.name}`,
            depth
          );
        }
      } else {
        await recordPackage(
          join(nodeModulesDirectory, entry.name),
          `${relativeDirectory}/${entry.name}`,
          depth
        );
      }
    }
  }
  async function recordPackage(packageDirectory, lockPath, depth) {
    const packageJsonPath = join(packageDirectory, "package.json");
    const packageJsonMetadata = await lstat(packageJsonPath);
    if (!packageJsonMetadata.isFile() || packageJsonMetadata.isSymbolicLink()) {
      throw new Error(`Staged sidecar package has no regular manifest: ${lockPath}.`);
    }
    packagePaths.add(lockPath);
    if (packagePaths.size > SIDECAR_MAX_FILE_COUNT) {
      throw new Error("Staged sidecar dependency inventory exceeded its package bound.");
    }
    const nestedNodeModules = join(packageDirectory, "node_modules");
    try {
      const nestedMetadata = await lstat(nestedNodeModules);
      if (!nestedMetadata.isDirectory() || nestedMetadata.isSymbolicLink()) {
        throw new Error("Staged nested node_modules is not a regular directory.");
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await scanNodeModules(
      nestedNodeModules,
      `${lockPath}/node_modules`,
      depth + 1
    );
  }
  const topLevelEntries = await readdir(targetDirectory);
  if (topLevelEntries.length !== 1 || topLevelEntries[0] !== "node_modules") {
    throw new Error(
      `Sidecar extraResource top-level inventory mismatch: ${JSON.stringify(topLevelEntries.sort())}.`
    );
  }
  await scanNodeModules(join(targetDirectory, "node_modules"), "node_modules", 0);
  return [...packagePaths].sort();
}

export function packageNameFromLockPath(lockPath) {
  const segments = lockPath.split("/");
  const nodeModulesIndex = segments.lastIndexOf("node_modules");
  const first = segments[nodeModulesIndex + 1];
  const second = segments[nodeModulesIndex + 2];
  if (
    nodeModulesIndex === -1 ||
    first === undefined ||
    first.length === 0 ||
    (first.startsWith("@") && (second === undefined || second.length === 0))
  ) {
    throw new Error(`Invalid package-lock package path: ${lockPath}.`);
  }
  return first.startsWith("@") ? `${first}/${second}` : first;
}

export function assertSquirrelSidecarInventory(
  archiveFiles,
  expectedSidecarInventory,
  sidecarPrefix = "lib/net45/resources/sidecar/"
) {
  if (!(archiveFiles instanceof Map) || !(expectedSidecarInventory instanceof Map)) {
    throw new Error("Squirrel sidecar inventories must be maps.");
  }
  const actualSidecarNames = [...archiveFiles.keys()]
    .filter(
      (name) => typeof name === "string" && name.startsWith(sidecarPrefix)
    )
    .sort();
  const expectedSidecarNames = [...expectedSidecarInventory.keys()]
    .map((name) => `${sidecarPrefix}${name}`)
    .sort();
  if (
    JSON.stringify(actualSidecarNames) !== JSON.stringify(expectedSidecarNames)
  ) {
    const missing = expectedSidecarNames.filter(
      (name) => !actualSidecarNames.includes(name)
    );
    const unexpected = actualSidecarNames.filter(
      (name) => !expectedSidecarNames.includes(name)
    );
    throw new Error(
      `Squirrel .nupkg sidecar inventory mismatch; missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}.`
    );
  }
  for (const [name, expected] of expectedSidecarInventory) {
    const actual = archiveFiles.get(`${sidecarPrefix}${name}`);
    if (
      !isRecord(expected) ||
      !isRecord(actual) ||
      actual.bytes !== expected.bytes ||
      actual.sha256 !== expected.sha256
    ) {
      throw new Error(`Squirrel .nupkg sidecar content mismatch: ${name}.`);
    }
  }
  return expectedSidecarInventory.size;
}
