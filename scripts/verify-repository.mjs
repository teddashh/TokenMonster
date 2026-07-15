import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { rootDirectory } from "./repository-files.mjs";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const REQUIRED_SCRIPTS = ["build", "test", "typecheck"];

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const rootManifest = await readJson(join(rootDirectory, "package.json"));
if (rootManifest.packageManager !== "npm@11.12.1") {
  throw new Error("Root packageManager must remain pinned to npm@11.12.1.");
}
if (
  rootManifest.engines?.node !== "24.15.0" ||
  rootManifest.engines?.npm !== "11.12.1"
) {
  throw new Error("Root Node and npm engines must remain exact release pins.");
}
function verifyOverrides(overrides, path = "overrides") {
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (typeof value === "string") {
      if (!EXACT_VERSION.test(value)) {
        throw new Error(`package.json: ${path}.${name} must use an exact version.`);
      }
    } else if (value !== null && typeof value === "object") {
      verifyOverrides(value, `${path}.${name}`);
    } else {
      throw new Error(`package.json: ${path}.${name} must be an exact version or object.`);
    }
  }
}
verifyOverrides(rootManifest.overrides);

const workspaceDirectories = [];
for (const pattern of rootManifest.workspaces) {
  if (!pattern.endsWith("/*")) {
    throw new Error(`Unsupported workspace pattern: ${pattern}`);
  }
  const parent = join(rootDirectory, pattern.slice(0, -2));
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      workspaceDirectories.push(join(parent, entry.name));
    }
  }
}

const manifests = [
  ["package.json", rootManifest],
  ...(await Promise.all(
    workspaceDirectories.sort().map(async (directory) => [
      `${directory.slice(rootDirectory.length + 1)}/package.json`,
      await readJson(join(directory, "package.json")),
    ]),
  )),
];

for (const [path, manifest] of manifests) {
  if (manifest.private !== true) {
    throw new Error(`${path}: every pre-Alpha package must remain private.`);
  }
  if (path !== "package.json") {
    for (const script of REQUIRED_SCRIPTS) {
      if (typeof manifest.scripts?.[script] !== "string") {
        throw new Error(`${path}: missing required ${script} script.`);
      }
    }
  }
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
        throw new Error(`${path}: ${section}.${name} must use an exact version.`);
      }
    }
  }
}

const baseTsconfig = await readJson(join(rootDirectory, "tsconfig.base.json"));
if (
  baseTsconfig.compilerOptions?.strict !== true ||
  baseTsconfig.compilerOptions?.skipLibCheck !== false
) {
  throw new Error("tsconfig.base.json must keep strict=true and skipLibCheck=false.");
}
