import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { rootDirectory } from "./repository-files.mjs";

const [command, mode] = process.argv.slice(2);
if (!new Set(["make", "package"]).has(command)) {
  throw new Error("Usage: package-companion.mjs make|package internal|signed");
}
if (!new Set(["internal", "signed"]).has(mode)) {
  throw new Error("Usage: package-companion.mjs make|package internal|signed");
}

const companionDirectory = join(rootDirectory, "apps", "companion");
const outDirectory = join(companionDirectory, "out");

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
  TOKENMONSTER_RELEASE_MODE: mode
};

function run(executable, arguments_, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: companionDirectory,
      env: releaseEnvironment,
      shell: false,
      stdio: "inherit",
      ...options
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

function runNpm(npmArguments) {
  return npmCli === null
    ? run(npmExecutable, npmArguments)
    : run(process.execPath, [npmCli, ...npmArguments]);
}

await rm(outDirectory, { force: true, recursive: true });
await runNpm(["run", "build"]);
await runNpm(["run", `forge:${command}`]);

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
  await run(process.execPath, verificationArguments, { cwd: rootDirectory });
} finally {
  if (holdInternalDmg) await rename(heldInternalDmgPath, internalDmgPath);
}
