import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";

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

await rm(outDirectory, { force: true, recursive: true });
await run(npmExecutable, ["run", "build"]);
await run(npmExecutable, ["run", `forge:${command}`]);

const verificationArguments = [
  join(rootDirectory, "scripts", "verify-companion-package.mjs"),
  "--mode",
  mode
];
if (command === "make") verificationArguments.push("--require-maker");
await run(process.execPath, verificationArguments, { cwd: rootDirectory });
