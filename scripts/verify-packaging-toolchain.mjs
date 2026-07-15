import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { rootDirectory } from "./repository-files.mjs";

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

process.stdout.write(
  "Verified exact Forge toolchain overrides; signed/GA remains blocked until upstream semver ranges no longer require this exception.\n"
);
