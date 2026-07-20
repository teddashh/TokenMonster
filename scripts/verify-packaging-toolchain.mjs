import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { rootDirectory } from "./repository-files.mjs";

const arguments_ = process.argv.slice(2);
if (
  arguments_.length > 1 ||
  (arguments_.length === 1 && arguments_[0] !== "--require-upstream-compatible")
) {
  throw new Error(
    "Usage: verify-packaging-toolchain.mjs [--require-upstream-compatible]",
  );
}

const expectedCompanionToolchainPins = Object.freeze({
  "@electron/asar": "4.2.0",
  "@electron/fuses": "1.8.0",
  "@electron/osx-sign": "1.3.3",
  "@electron/packager": "18.4.4",
  "@electron/windows-sign": "1.2.2",
  "cross-zip": "4.0.1",
  "electron-installer-dmg": "5.0.1",
  "electron-winstaller": "5.4.4",
});
const bannedPackageNames = Object.freeze([
  "@electron/rebuild",
  "external-editor",
  "tmp",
]);
const permittedOptionalExtraneousProblems = Object.freeze([
  /^extraneous: @emnapi\/runtime@1\.11\.1 .+[\\/]node_modules[\\/]@emnapi[\\/]runtime$/u,
  /^extraneous: tslib@2\.8\.1 .+[\\/]node_modules[\\/]tslib$/u,
]);
const expectedOptionalExtraneousLockEntries = Object.freeze({
  "node_modules/@emnapi/runtime": "1.11.1",
  "node_modules/tslib": "2.8.1",
});

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function resolveNpmCli() {
  const nodeDirectory = dirname(realpathSync(process.execPath));
  const candidates = [
    join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    join(
      nodeDirectory,
      "..",
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function runCleanNpmList() {
  const npmCli = resolveNpmCli();
  const executable =
    npmCli === null
      ? process.platform === "win32"
        ? "npm.cmd"
        : "npm"
      : process.execPath;
  const npmArguments = ["ls", "--json", "--all"];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      executable,
      npmCli === null ? npmArguments : [npmCli, ...npmArguments],
      {
        cwd: rootDirectory,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > 8 * 1024 * 1024) {
        child.kill("SIGKILL");
        reject(new Error("npm ls output exceeded 8 MiB."));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length + chunk.length > 256 * 1024) {
        child.kill("SIGKILL");
        reject(new Error("npm ls stderr exceeded 256 KiB."));
        return;
      }
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal !== null || code !== 0) {
        reject(
          new Error(
            `Packaging dependency tree is not clean: npm ls exited with ${
              signal ?? code
            }.${stderr.length === 0 ? "" : " See captured npm diagnostics."}`,
          ),
        );
        return;
      }
      try {
        const tree = JSON.parse(stdout);
        const problems = Array.isArray(tree.problems) ? tree.problems : [];
        if (
          problems.some(
            (problem) =>
              typeof problem !== "string" ||
              !permittedOptionalExtraneousProblems.some((pattern) =>
                pattern.test(problem),
              ),
          )
        ) {
          throw new Error(
            `npm ls returned an unexpected dependency problem set: ${JSON.stringify(
              problems,
            )}`,
          );
        }
        resolvePromise(tree);
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new Error("npm ls did not return bounded JSON."),
        );
      }
    });
  });
}

function collectDependencyNames(tree, names = new Set()) {
  if (tree === null || typeof tree !== "object") return names;
  const dependencies = tree.dependencies;
  if (dependencies === null || typeof dependencies !== "object") return names;
  for (const [name, dependency] of Object.entries(dependencies)) {
    names.add(name);
    collectDependencyNames(dependency, names);
  }
  return names;
}

function lockPathContainsPackage(lockPath, packageName) {
  const suffix = `node_modules/${packageName}`;
  return lockPath === suffix || lockPath.endsWith(`/${suffix}`);
}

const rootManifest = await readJson(join(rootDirectory, "package.json"));
const companionManifest = await readJson(
  join(rootDirectory, "apps", "companion", "package.json"),
);
const packageLock = await readJson(join(rootDirectory, "package-lock.json"));

if (Object.hasOwn(rootManifest, "overrides")) {
  throw new Error(
    "The stable direct packaging toolchain must not require root overrides.",
  );
}
for (const [name, version] of Object.entries(expectedCompanionToolchainPins)) {
  if (companionManifest.devDependencies?.[name] !== version) {
    throw new Error(
      `${name} must remain exact at reviewed version ${version}.`,
    );
  }
  if (companionManifest.dependencies?.[name] !== undefined) {
    throw new Error(`${name} must remain a packaging-only devDependency.`);
  }
}
for (const dependencyGroup of ["dependencies", "devDependencies"]) {
  for (const name of Object.keys(companionManifest[dependencyGroup] ?? {})) {
    if (name.startsWith("@electron-forge/")) {
      throw new Error("Electron Forge must remain absent from the companion.");
    }
    if (bannedPackageNames.includes(name)) {
      throw new Error(
        `${name} must remain absent from companion dependencies.`,
      );
    }
  }
}

const lockPaths = Object.keys(packageLock.packages ?? {});
for (const [lockPath, version] of Object.entries(
  expectedOptionalExtraneousLockEntries,
)) {
  const lockEntry = packageLock.packages?.[lockPath];
  if (lockEntry?.version !== version || lockEntry.optional !== true) {
    throw new Error(
      `${lockPath} must remain the reviewed optional ${version} lock entry.`,
    );
  }
}
for (const lockPath of lockPaths) {
  if (
    lockPath === "node_modules/@electron-forge" ||
    lockPath.includes("node_modules/@electron-forge/")
  ) {
    throw new Error(`Forge package remains in the exact lock: ${lockPath}.`);
  }
  for (const bannedName of bannedPackageNames) {
    if (lockPathContainsPackage(lockPath, bannedName)) {
      throw new Error(
        `Banned packaging dependency remains in the exact lock: ${bannedName}.`,
      );
    }
  }
}

for (const [name, version] of Object.entries(expectedCompanionToolchainPins)) {
  const installedManifest = await readJson(
    join(rootDirectory, "node_modules", ...name.split("/"), "package.json"),
  );
  if (installedManifest.version !== version) {
    throw new Error(`${name} must resolve exactly to ${version}.`);
  }
}

const npmTree = await runCleanNpmList();
const installedNames = collectDependencyNames(npmTree);
for (const name of installedNames) {
  if (name.startsWith("@electron-forge/")) {
    throw new Error(`Forge package remains installed: ${name}.`);
  }
}
for (const bannedName of bannedPackageNames) {
  if (installedNames.has(bannedName)) {
    throw new Error(
      `Banned packaging dependency remains installed: ${bannedName}.`,
    );
  }
}

const [asar, fuses, osxSign, packager, windowsSign, crossZip, dmg, squirrel] =
  await Promise.all([
    import("@electron/asar"),
    import("@electron/fuses"),
    import("@electron/osx-sign"),
    import("@electron/packager"),
    import("@electron/windows-sign"),
    import("cross-zip"),
    import("electron-installer-dmg"),
    import("electron-winstaller"),
  ]);
if (
  typeof asar.extractAll !== "function" ||
  typeof asar.getRawHeader !== "function"
) {
  throw new Error("@electron/asar does not expose the reviewed verifier API.");
}
if (
  typeof fuses.flipFuses !== "function" ||
  typeof fuses.getCurrentFuseWire !== "function" ||
  fuses.FuseVersion?.V1 === undefined
) {
  throw new Error("@electron/fuses does not expose the reviewed direct API.");
}
if (typeof osxSign.signApp !== "function") {
  throw new Error(
    "@electron/osx-sign does not expose the reviewed direct API.",
  );
}
if (
  typeof packager.packager !== "function" ||
  typeof packager.serialHooks !== "function"
) {
  throw new Error(
    "@electron/packager does not expose the reviewed direct API.",
  );
}
if (
  typeof windowsSign.sign !== "function" ||
  typeof windowsSign.createSeaSignTool !== "function"
) {
  throw new Error(
    "@electron/windows-sign does not expose the reviewed hook and SEA APIs.",
  );
}
if (typeof crossZip.zip !== "function") {
  throw new Error("cross-zip does not expose the reviewed ZIP API.");
}
if (typeof dmg.createDMG !== "function") {
  throw new Error(
    "electron-installer-dmg does not expose the reviewed DMG API.",
  );
}
if (
  typeof squirrel.createWindowsInstaller !== "function" ||
  typeof squirrel.convertVersion !== "function"
) {
  throw new Error(
    "electron-winstaller does not expose the reviewed Squirrel API.",
  );
}

process.stdout.write(
  `Verified exact stable direct Electron packaging toolchain, successful npm dependency tree, and Forge-free packaging closure. Signed/GA upstream-compatible gate ${
    arguments_[0] === "--require-upstream-compatible" ? "passes" : "is ready"
  }.\n`,
);
