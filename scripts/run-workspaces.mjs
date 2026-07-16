import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
const allowedTargets = new Set(["build", "test", "typecheck"]);
const requiredWorkspaceScripts = ["build", "test", "typecheck"];
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
];

if (!allowedTargets.has(target)) {
  throw new Error("Usage: node scripts/run-workspaces.mjs build|test|typecheck");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function workspaceDirectories(pattern) {
  if (!pattern.includes("*")) {
    return [resolve(rootDir, pattern)];
  }

  if (!pattern.endsWith("/*") || pattern.slice(0, -2).includes("*")) {
    throw new Error(`Unsupported workspace pattern: ${pattern}`);
  }

  const parent = resolve(rootDir, pattern.slice(0, -2));
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name));
}

async function loadWorkspaces() {
  const rootManifest = await readJson(join(rootDir, "package.json"));
  const patterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : rootManifest.workspaces?.packages;
  if (!Array.isArray(patterns)) {
    throw new Error("Root package.json must declare a workspaces array.");
  }

  const directories = (
    await Promise.all(patterns.map((pattern) => workspaceDirectories(pattern)))
  ).flat();
  const workspaces = [];
  for (const directory of directories.sort()) {
    let manifest;
    try {
      manifest = await readJson(join(directory, "package.json"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      throw new Error(`Workspace at ${directory} has no package name.`);
    }
    workspaces.push({ directory, manifest, name: manifest.name });
  }

  const names = new Set();
  for (const workspace of workspaces) {
    if (names.has(workspace.name)) {
      throw new Error(`Duplicate workspace package name: ${workspace.name}`);
    }
    names.add(workspace.name);
  }
  return workspaces;
}

function localDependencies(workspace, workspaceNames) {
  const names = new Set();
  for (const section of dependencySections) {
    const dependencies = workspace.manifest[section];
    if (dependencies === null || typeof dependencies !== "object") continue;
    for (const name of Object.keys(dependencies)) {
      if (workspaceNames.has(name)) names.add(name);
    }
  }
  return names;
}

function topologicalOrder(workspaces) {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const dependencies = new Map(
    workspaces.map((workspace) => [
      workspace.name,
      localDependencies(workspace, new Set(byName.keys()))
    ])
  );
  const order = [];
  const temporary = new Set();
  const permanent = new Set();

  function visit(name, trail) {
    if (permanent.has(name)) return;
    if (temporary.has(name)) {
      throw new Error(`Workspace dependency cycle: ${[...trail, name].join(" -> ")}`);
    }
    temporary.add(name);
    const nextTrail = [...trail, name];
    for (const dependency of [...dependencies.get(name)].sort()) {
      visit(dependency, nextTrail);
    }
    temporary.delete(name);
    permanent.add(name);
    order.push(byName.get(name));
  }

  for (const name of [...byName.keys()].sort()) visit(name, []);
  return { dependencies, order };
}

// Windows cannot spawn the npm .cmd shim without a shell (Node >= 20 EINVAL),
// so run npm's JS entry point with the current node binary. The two candidate
// layouts cover Windows (npm beside node.exe) and unix (bin/node + lib/...).
function resolveNpmCli() {
  const nodeDir = dirname(realpathSync(process.execPath));
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const npmCli = resolveNpmCli();

function runWorkspaceScript(workspace, script) {
  return new Promise((resolvePromise, reject) => {
    process.stdout.write(`\n> ${workspace.name} ${script}\n`);
    const npmArguments = ["run", script, "--workspace", workspace.name, "--if-present"];
    const child =
      npmCli === null
        ? spawn(process.platform === "win32" ? "npm.cmd" : "npm", npmArguments, {
            cwd: rootDir,
            shell: false,
            stdio: "inherit"
          })
        : spawn(process.execPath, [npmCli, ...npmArguments], {
            cwd: rootDir,
            shell: false,
            stdio: "inherit"
          });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${workspace.name} ${script} failed${
            signal === null ? ` with exit code ${code}` : ` from signal ${signal}`
          }.`
        )
      );
    });
  });
}

const workspaces = await loadWorkspaces();
for (const workspace of workspaces) {
  for (const script of requiredWorkspaceScripts) {
    if (typeof workspace.manifest.scripts?.[script] !== "string") {
      throw new Error(`${workspace.name} must define an explicit ${script} script.`);
    }
  }
}
const { dependencies, order } = topologicalOrder(workspaces);

if (target !== "build") {
  const dependencyNames = new Set(
    [...dependencies.values()].flatMap((names) => [...names])
  );
  for (const workspace of order) {
    if (
      dependencyNames.has(workspace.name) &&
      typeof workspace.manifest.scripts?.build === "string"
    ) {
      await runWorkspaceScript(workspace, "build");
    }
  }
}

for (const workspace of order) {
  if (typeof workspace.manifest.scripts?.[target] === "string") {
    await runWorkspaceScript(workspace, target);
  }
}
