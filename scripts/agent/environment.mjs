import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { rootDirectory } from "./contract.mjs";

export const REQUIRED_NODE_VERSION = "24.15.0";
export const REQUIRED_NPM_VERSION = "11.12.1";

const SAFE_ENVIRONMENT_NAMES = [
  "APPDATA",
  "COLORTERM",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NUMBER_OF_PROCESSORS",
  "OneDrive",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SHELL",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_DIRS",
  "XDG_DATA_HOME",
  "__CF_USER_TEXT_ENCODING",
];
const SAFE_GUI_ENVIRONMENT_NAMES = [
  "DBUS_SESSION_BUS_ADDRESS",
  "DESKTOP_SESSION",
  "DISPLAY",
  "GDK_BACKEND",
  "PULSE_SERVER",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CURRENT_DESKTOP",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
];
const AGENT_READY_PIPE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const AGENT_READY_CAPABILITY_PATTERN = /^[0-9a-f]{64}$/u;

function environmentValue(source, requestedName) {
  const matches = Object.keys(source).filter(
    (candidate) => candidate.toLowerCase() === requestedName.toLowerCase(),
  );
  if (matches.length !== 1) return undefined;
  return source[matches[0]];
}

export function projectSafeEnvironment(
  source = process.env,
  {
    agentLaunch = false,
    agentReadyCapability,
    agentReadyPipeId,
    gui = true,
    npm = false,
  } = {},
) {
  const projected = {};
  const names = [
    ...SAFE_ENVIRONMENT_NAMES,
    ...(gui && !npm ? SAFE_GUI_ENVIRONMENT_NAMES : []),
  ];
  for (const name of names) {
    const value = environmentValue(source, name);
    if (value !== undefined) projected[name] = value;
  }
  projected.NO_COLOR = "1";
  if (npm) {
    projected.NPM_CONFIG_AUDIT = "false";
    projected.NPM_CONFIG_FUND = "false";
    projected.NPM_CONFIG_LOGLEVEL = "silent";
    projected.NPM_CONFIG_LOGS_MAX = "0";
    projected.NPM_CONFIG_USERCONFIG =
      process.platform === "win32" ? "NUL" : "/dev/null";
  }
  if (agentLaunch) projected.TOKENMONSTER_AGENT_LAUNCH = "1";
  const hasAgentReadyPipeId = agentReadyPipeId !== undefined;
  const hasAgentReadyCapability = agentReadyCapability !== undefined;
  if (hasAgentReadyPipeId !== hasAgentReadyCapability) {
    throw new Error("agent_ready_channel_invalid");
  }
  if (hasAgentReadyPipeId) {
    if (
      !agentLaunch ||
      typeof agentReadyPipeId !== "string" ||
      !AGENT_READY_PIPE_ID_PATTERN.test(agentReadyPipeId) ||
      typeof agentReadyCapability !== "string" ||
      !AGENT_READY_CAPABILITY_PATTERN.test(agentReadyCapability)
    ) {
      throw new Error("agent_ready_channel_invalid");
    }
    projected.TOKENMONSTER_AGENT_READY_PIPE_ID = agentReadyPipeId;
    projected.TOKENMONSTER_AGENT_READY_CAPABILITY = agentReadyCapability;
  }
  return projected;
}

function regularNpmCli(candidate) {
  try {
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return undefined;
    return candidate;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function fixedUnshare() {
  for (const candidate of ["/usr/bin/unshare", "/bin/unshare"]) {
    try {
      const metadata = lstatSync(candidate);
      if (!metadata.isSymbolicLink() && metadata.isFile()) return candidate;
    } catch {
      // Try the next fixed operating-system location.
    }
  }
  return undefined;
}

function fixedTrue() {
  for (const candidate of ["/usr/bin/true", "/bin/true"]) {
    try {
      const metadata = lstatSync(candidate);
      if (!metadata.isSymbolicLink() && metadata.isFile()) return candidate;
    } catch {
      // Try the next fixed operating-system location.
    }
  }
  return undefined;
}

function configuredSuidSandbox() {
  const candidate = join(
    rootDirectory,
    "node_modules",
    "electron",
    "dist",
    "chrome-sandbox",
  );
  try {
    const metadata = lstatSync(candidate);
    return (
      !metadata.isSymbolicLink() &&
      metadata.isFile() &&
      metadata.uid === 0 &&
      (metadata.mode & 0o7777) === 0o4755
    );
  } catch {
    return false;
  }
}

export function electronSandboxAvailable(
  platform = process.platform,
  options = {},
) {
  if (platform !== "linux") return true;
  const suidSandboxAvailable =
    options.suidSandboxAvailable ?? configuredSuidSandbox();
  if (suidSandboxAvailable) return true;
  const unshare = options.unshare ?? fixedUnshare();
  const trueCommand = options.trueCommand ?? fixedTrue();
  if (unshare === undefined || trueCommand === undefined) return false;
  const result = (options.spawn ?? spawnSync)(
    unshare,
    ["--user", "--map-root-user", trueCommand],
    {
      env: projectSafeEnvironment(process.env, { gui: false }),
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
    },
  );
  return (
    result.status === 0 &&
    result.signal === null &&
    result.error === undefined
  );
}

export function resolveNpmInvocation() {
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
  ].map(regularNpmCli).filter(Boolean);
  if (candidates.length === 0) return undefined;
  return { command: process.execPath, prefixArgs: [candidates[0]] };
}

export function npmCommandArgs(invocation, args) {
  if (
    invocation === undefined ||
    !Array.isArray(invocation.prefixArgs) ||
    !Array.isArray(args)
  ) {
    throw new Error("agent_npm_command_invalid");
  }
  return {
    command: invocation.command,
    args: [...invocation.prefixArgs, ...args],
  };
}

export function graphicalSessionAvailable(
  platform = process.platform,
  environment = process.env,
) {
  if (platform === "linux") {
    return Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
  }
  if (platform === "darwin") {
    return !environment.SSH_CONNECTION && !environment.SSH_TTY;
  }
  if (platform === "win32") {
    return !environment.SSH_CONNECTION && !environment.SSH_CLIENT;
  }
  return false;
}

export function collectEnvironmentChecks(options = {}) {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const npmVersion = options.npmVersion ?? probeNpmVersion();
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const repositoryPresent =
    options.repositoryPresent ??
    [
      "package.json",
      "package-lock.json",
      "scripts/run-workspaces.mjs",
      "apps/companion/package.json",
    ].every((relativePath) => {
      try {
        const metadata = lstatSync(join(rootDirectory, relativePath));
        return !metadata.isSymbolicLink() && metadata.isFile();
      } catch {
        return false;
      }
    });
  const graphical =
    options.graphical ??
    graphicalSessionAvailable(platform, environment);
  const sandbox =
    options.sandboxAvailable ??
    electronSandboxAvailable(platform);
  return [
    {
      name: "repository",
      ok: repositoryPresent,
      detail: repositoryPresent ? "available" : "missing",
    },
    {
      name: "node",
      ok: nodeVersion === REQUIRED_NODE_VERSION,
      detail:
        nodeVersion === REQUIRED_NODE_VERSION
          ? REQUIRED_NODE_VERSION
          : "version_mismatch",
    },
    {
      name: "npm",
      ok: npmVersion === REQUIRED_NPM_VERSION,
      detail:
        npmVersion === REQUIRED_NPM_VERSION
          ? REQUIRED_NPM_VERSION
          : npmVersion === null
            ? "missing"
            : "version_mismatch",
    },
    {
      name: "graphical-session",
      ok: graphical,
      detail: graphical ? "available" : "missing",
    },
    {
      name: "electron-sandbox",
      ok: sandbox,
      detail: sandbox ? "available" : "missing",
    },
  ];
}

export function probeNpmVersion() {
  const invocation = resolveNpmInvocation();
  if (invocation === undefined) return null;
  const npm = npmCommandArgs(invocation, ["--version"]);
  const result = spawnSync(npm.command, npm.args, {
    cwd: rootDirectory,
    encoding: "utf8",
    env: projectSafeEnvironment(process.env, { npm: true }),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const version = String(result.stdout ?? "").trim();
  return /^\d+\.\d+\.\d+$/u.test(version) ? version : null;
}
