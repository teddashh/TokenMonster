import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  environmentWithoutWindowsSigningSecrets,
  prepareWindowsSigningEnvironment,
  requireReleaseVersion
} from "../apps/companion/packaging/release-policy.mjs";
import { rootDirectory } from "./repository-files.mjs";

const [command, mode] = process.argv.slice(2);
if (!new Set(["make", "package"]).has(command)) {
  throw new Error("Usage: package-companion.mjs make|package internal|signed");
}
if (!new Set(["internal", "signed"]).has(mode)) {
  throw new Error("Usage: package-companion.mjs make|package internal|signed");
}
const releaseVersion = requireReleaseVersion(process.env);
if (
  mode === "signed" &&
  process.platform !== "darwin" &&
  process.platform !== "win32"
) {
  throw new Error(
    "Signed companion releases require a native macOS or Windows host."
  );
}
if (mode === "signed" && command !== "make") {
  throw new Error("Signed companion releases require complete maker output.");
}

if (mode === "signed" && process.platform === "win32") {
  // Validate every secret-bearing input before deleting old output or building.
  // The helper mutates only this disposable clone.
  prepareWindowsSigningEnvironment({ ...process.env });
}

const companionDirectory = join(rootDirectory, "apps", "companion");
const outDirectory = join(companionDirectory, "out");
const windowsSignerDiagnosticPaths = [
  join(companionDirectory, "electron-windows-sign.log"),
  join(rootDirectory, "electron-windows-sign.log"),
  join(
    rootDirectory,
    "node_modules",
    "electron-winstaller",
    "vendor",
    "electron-windows-sign.log"
  )
];

// Windows cannot spawn the npm .cmd shim without a shell (Node >= 20 EINVAL),
// so run npm's JS entry point with the current node binary, exactly like
// run-workspaces.mjs does.
function resolveNpmCli() {
  const nodeDir = dirname(realpathSync(process.execPath));
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const npmCli = resolveNpmCli();
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const releaseEnvironment = {
  ...process.env,
  TOKENMONSTER_RELEASE_MODE: mode,
  TOKENMONSTER_RELEASE_VERSION: releaseVersion
};
const buildEnvironment =
  environmentWithoutWindowsSigningSecrets(releaseEnvironment);
const verificationEnvironment =
  environmentWithoutWindowsSigningSecrets(releaseEnvironment);
const forgeEnvironment =
  mode === "internal"
    ? environmentWithoutWindowsSigningSecrets(releaseEnvironment)
    : { ...releaseEnvironment };
if (mode === "signed" && process.platform === "win32") {
  // Prevent Node or dependency debug channels from printing the signtool argv.
  delete forgeEnvironment.DEBUG;
  delete forgeEnvironment.NODE_DEBUG;
  delete forgeEnvironment.NODE_OPTIONS;
}

function run(executable, arguments_, options = {}) {
  const { environment = releaseEnvironment, ...spawnOptions } = options;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: companionDirectory,
      env: environment,
      shell: false,
      stdio: "inherit",
      ...spawnOptions
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${executable} ${arguments_.join(" ")} failed${
            signal === null ? ` with exit code ${code}` : ` from ${signal}`
          }.`
        )
      );
    });
  });
}

function runNpm(npmArguments, environment) {
  return npmCli === null
    ? run(npmExecutable, npmArguments, { environment })
    : run(process.execPath, [npmCli, ...npmArguments], { environment });
}

await rm(outDirectory, { force: true, recursive: true });
// Build the complete local dependency closure before Forge stages the app.
// A package-local build can otherwise consume stale workspace dist/ output
// even though the companion sources themselves were rebuilt.
await run(
  process.execPath,
  [
    join(rootDirectory, "scripts", "run-workspaces.mjs"),
    "build",
    "@tokenmonster/companion"
  ],
  {
    cwd: rootDirectory,
    environment: buildEnvironment
  }
);
if (mode === "signed" && process.platform === "win32") {
  await Promise.all(
    windowsSignerDiagnosticPaths.map((path) => rm(path, { force: true }))
  );
}
try {
  await runNpm(["run", `forge:${command}`], forgeEnvironment);
} finally {
  if (mode === "signed" && process.platform === "win32") {
    // electron-winstaller's SEA bridge writes process arguments even when its
    // debug namespace is disabled. Its options are secret-free, but the
    // release wrapper still removes the tool-owned diagnostic deterministically.
    await Promise.all(
      windowsSignerDiagnosticPaths.map((path) => rm(path, { force: true }))
    );
  }
}

const verificationArguments = [
  join(rootDirectory, "scripts", "verify-companion-package.mjs"),
  "--mode",
  mode
];
if (command === "make") verificationArguments.push("--require-maker");

const internalDmgPath = join(outDirectory, "make", "TokenMonster.dmg");
const heldInternalDmgPath = join(
  outDirectory,
  "TokenMonster.dmg.verification-pending"
);
const holdInternalDmg =
  command === "make" && mode === "internal" && process.platform === "darwin";

// The package verifier audits ZIP contents but intentionally has no native DMG audit yet.
if (holdInternalDmg) await rename(internalDmgPath, heldInternalDmgPath);
try {
  await run(process.execPath, verificationArguments, {
    cwd: rootDirectory,
    environment: verificationEnvironment
  });
} finally {
  if (holdInternalDmg) await rename(heldInternalDmgPath, internalDmgPath);
}
