import assert from "node:assert/strict";
import test from "node:test";

import {
  collectEnvironmentChecks,
  electronSandboxAvailable,
  graphicalSessionAvailable,
  projectSafeEnvironment,
  REQUIRED_NODE_VERSION,
  REQUIRED_NPM_VERSION,
} from "../environment.mjs";

const SENSITIVE_ENVIRONMENT = {
  OPENAI_API_KEY: "openai-secret",
  ANTHROPIC_API_KEY: "anthropic-secret",
  CODEX_HOME: "/secret/codex",
  CLAUDE_CONFIG_DIR: "/secret/claude",
  GITHUB_TOKEN: "github-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  CSC_LINK: "signing-secret",
  NODE_OPTIONS: "--require=/secret/inject.cjs",
  ELECTRON_RUN_AS_NODE: "1",
  ELECTRON_OVERRIDE_DIST_PATH: "/secret/electron",
  ELECTRON_MIRROR: "https://mirror.invalid/",
  ELECTRON_CUSTOM_DIR: "hostile",
  ELECTRON_CUSTOM_FILENAME: "hostile.zip",
  ELECTRON_INSTALL_PLATFORM: "win32",
  ELECTRON_INSTALL_ARCH: "arm64",
  electron_config_cache: "/secret/cache",
  npm_config_electron_mirror: "https://mirror.invalid/",
  npm_config_electron_custom_dir: "hostile",
  npm_config_electron_custom_filename: "hostile.zip",
  npm_config_platform: "win32",
  npm_config_arch: "arm64",
  npm_config_proxy: "http://proxy-secret",
  npm_config_https_proxy: "https://proxy-secret",
  HTTP_PROXY: "http://proxy-secret",
  HTTPS_PROXY: "https://proxy-secret",
  ALL_PROXY: "socks://proxy-secret",
  NO_PROXY: "secret.internal",
  DEBUG: "*",
  TOKENMONSTER_AGENT_LAUNCH: "host-controlled",
};

test("safe environment keeps only canonical reviewed names", () => {
  const projected = projectSafeEnvironment({
    path: "/safe/bin",
    home: "/safe/home",
    DISPLAY: ":1",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/safe/dbus",
    ...SENSITIVE_ENVIRONMENT,
  });
  assert.deepEqual(projected, {
    HOME: "/safe/home",
    PATH: "/safe/bin",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/safe/dbus",
    DISPLAY: ":1",
    NO_COLOR: "1",
  });
});

test("safe environment drops secrets, proxies and injection controls", () => {
  const projected = projectSafeEnvironment(SENSITIVE_ENVIRONMENT);
  for (const name of Object.keys(SENSITIVE_ENVIRONMENT)) {
    assert.equal(Object.hasOwn(projected, name), false);
  }
  assert.deepEqual(projected, { NO_COLOR: "1" });
});

test("npm/build projection excludes GUI endpoints and disables npm logs", () => {
  const projected = projectSafeEnvironment(
    {
      HOME: "/safe/home",
      PATH: "/safe/bin",
      DISPLAY: ":1",
      WAYLAND_DISPLAY: "wayland-0",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/safe/dbus",
    },
    { gui: false, npm: true },
  );
  assert.equal(projected.HOME, "/safe/home");
  assert.equal(projected.PATH, "/safe/bin");
  assert.equal(Object.hasOwn(projected, "DISPLAY"), false);
  assert.equal(Object.hasOwn(projected, "WAYLAND_DISPLAY"), false);
  assert.equal(Object.hasOwn(projected, "DBUS_SESSION_BUS_ADDRESS"), false);
  assert.equal(projected.NPM_CONFIG_LOGS_MAX, "0");
  assert.equal(
    projected.NPM_CONFIG_USERCONFIG,
    process.platform === "win32" ? "NUL" : "/dev/null",
  );
});

test("agent marker is policy-generated rather than inherited", () => {
  const projected = projectSafeEnvironment(SENSITIVE_ENVIRONMENT, {
    agentLaunch: true,
  });
  assert.equal(projected.TOKENMONSTER_AGENT_LAUNCH, "1");
  assert.equal(Object.hasOwn(projected, "OPENAI_API_KEY"), false);
});

test("graphical session and prerequisite results are content-blind", () => {
  assert.equal(graphicalSessionAvailable("linux", { DISPLAY: ":0" }), true);
  assert.equal(graphicalSessionAvailable("linux", {}), false);
  assert.equal(graphicalSessionAvailable("darwin", {}), true);
  assert.equal(
    graphicalSessionAvailable("darwin", { SSH_CONNECTION: "redacted" }),
    false,
  );
  const checks = collectEnvironmentChecks({
    nodeVersion: "/private/node",
    npmVersion: "https://proxy.invalid",
    platform: "linux",
    graphical: false,
    sandboxAvailable: false,
    repositoryPresent: false,
  });
  assert.equal(REQUIRED_NODE_VERSION, "24.15.0");
  assert.equal(REQUIRED_NPM_VERSION, "11.12.1");
  assert.deepEqual(checks, [
    { name: "repository", ok: false, detail: "missing" },
    { name: "node", ok: false, detail: "version_mismatch" },
    { name: "npm", ok: false, detail: "version_mismatch" },
    { name: "graphical-session", ok: false, detail: "missing" },
    { name: "electron-sandbox", ok: false, detail: "missing" },
  ]);
});

test("Linux source launch requires a usable Chromium user namespace", () => {
  const calls = [];
  assert.equal(
    electronSandboxAvailable("linux", {
      suidSandboxAvailable: false,
      unshare: "/usr/bin/unshare",
      trueCommand: "/usr/bin/true",
      spawn(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0, signal: null, error: undefined };
      },
    }),
    true,
  );
  assert.deepEqual(calls[0]?.args, [
    "--user",
    "--map-root-user",
    "/usr/bin/true",
  ]);
  assert.equal(
    electronSandboxAvailable("linux", {
      suidSandboxAvailable: false,
      unshare: "/usr/bin/unshare",
      trueCommand: "/usr/bin/true",
      spawn: () => ({ status: 1, signal: null, error: undefined }),
    }),
    false,
  );
  assert.equal(
    electronSandboxAvailable("linux", {
      suidSandboxAvailable: true,
      unshare: undefined,
      trueCommand: undefined,
    }),
    true,
  );
  assert.equal(electronSandboxAvailable("win32"), true);
  assert.equal(electronSandboxAvailable("darwin"), true);
});
