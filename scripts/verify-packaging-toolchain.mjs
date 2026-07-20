import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { rootDirectory } from "./repository-files.mjs";

const arguments_ = process.argv.slice(2);
if (
  arguments_.length > 1 ||
  (arguments_.length === 1 &&
    arguments_[0] !== "--require-upstream-compatible")
) {
  throw new Error(
    "Usage: verify-packaging-toolchain.mjs [--require-upstream-compatible]"
  );
}
const requireUpstreamCompatible =
  arguments_[0] === "--require-upstream-compatible";

const expectedProblems = [
  /^invalid: @electron\/rebuild@4\.2\.0 .+[\\/]node_modules[\\/]@electron[\\/]rebuild$/u,
  /^invalid: tmp@0\.2\.7 .+[\\/]node_modules[\\/]tmp$/u
];

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function runNpmList() {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      executable,
      ["ls", "@electron/rebuild", "tmp", "--json", "--all"],
      {
        cwd: rootDirectory,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > 1024 * 1024) {
        child.kill("SIGKILL");
        reject(new Error("npm ls output exceeded 1 MiB."));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length + chunk.length > 64 * 1024) {
        child.kill("SIGKILL");
        reject(new Error("npm ls stderr exceeded 64 KiB."));
        return;
      }
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null || code !== 1) {
        reject(
          new Error(
            `Expected reviewed npm override status 1, received ${signal ?? code}.`
          )
        );
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        reject(new Error("npm ls did not return bounded JSON."));
      }
    });
  });
}

const rootManifest = await readJson(join(rootDirectory, "package.json"));
const companionManifest = await readJson(
  join(rootDirectory, "apps", "companion", "package.json")
);
const expectedCompanionToolchainPins = {
  "@electron-forge/cli": "7.11.2",
  "@electron-forge/maker-dmg": "7.11.2",
  "@electron-forge/maker-squirrel": "7.11.2",
  "@electron-forge/maker-zip": "7.11.2",
  "@electron-forge/plugin-fuses": "7.11.2",
  "@electron/fuses": "1.8.0"
};
for (const [name, version] of Object.entries(expectedCompanionToolchainPins)) {
  if (companionManifest.devDependencies?.[name] !== version) {
    throw new Error(`${name} must remain exact at reviewed version ${version}.`);
  }
}
for (const transitiveTool of ["@electron/rebuild", "external-editor", "tmp"]) {
  for (const dependencyGroup of ["dependencies", "devDependencies"]) {
    if (companionManifest[dependencyGroup]?.[transitiveTool] !== undefined) {
      throw new Error(
        `${transitiveTool} must remain a transitive Forge tool, not a companion ${dependencyGroup} entry.`
      );
    }
  }
}
const expectedOverrides = {
  "@electron-forge/cli@7.11.2": {
    "@electron/rebuild": "4.2.0",
    tmp: "0.2.7"
  }
};
if (JSON.stringify(rootManifest.overrides) !== JSON.stringify(expectedOverrides)) {
  throw new Error("Packaging overrides differ from the reviewed exact set.");
}

const installedManifests = await Promise.all(
  [
    ["@electron-forge/cli", "7.11.2"],
    ["@electron-forge/core", "7.11.2"],
    ["@electron-forge/core-utils", "7.11.2"],
    ["@electron-forge/shared-types", "7.11.2"],
    ["@electron/rebuild", "4.2.0"],
    ["external-editor", "3.1.0"],
    ["tmp", "0.2.7"]
  ].map(async ([name, version]) => {
    const manifest = await readJson(
      join(rootDirectory, "node_modules", ...name.split("/"), "package.json")
    );
    if (manifest.version !== version) {
      throw new Error(`${name} must resolve exactly to ${version}.`);
    }
    return [name, manifest];
  })
);
const byName = new Map(installedManifests);
for (const forgePackage of [
  "@electron-forge/core",
  "@electron-forge/core-utils",
  "@electron-forge/shared-types"
]) {
  if (byName.get(forgePackage)?.dependencies?.["@electron/rebuild"] !== "^3.7.0") {
    throw new Error(`${forgePackage} upstream rebuild range changed; review override.`);
  }
}
if (byName.get("external-editor")?.dependencies?.tmp !== "^0.0.33") {
  throw new Error("external-editor upstream tmp range changed; review override.");
}

const npmTree = await runNpmList();
const problems = [...(npmTree.problems ?? [])].sort();
if (
  problems.length !== expectedProblems.length ||
  !expectedProblems.every((pattern) => problems.some((problem) => pattern.test(problem)))
) {
  throw new Error(`Unexpected packaging dependency problem set: ${JSON.stringify(problems)}`);
}

const rebuildModule = await import("@electron/rebuild");
if (typeof rebuildModule.rebuild !== "function") {
  throw new Error("Overridden @electron/rebuild does not expose the Forge API.");
}

if (requireUpstreamCompatible && problems.length > 0) {
  throw new Error(
    "Signed/GA publication is blocked until stable Forge ranges accept the reviewed safe dependency versions."
  );
}

process.stdout.write(
  "Verified exact Forge toolchain overrides. Classification: external dev-tool supply-chain semver gate, not an application/runtime defect; signed/GA remains blocked until a stable upstream range accepts the safe versions.\n"
);
