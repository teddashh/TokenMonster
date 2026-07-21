import { EventEmitter } from "node:events";
import { basename, dirname, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildSquirrelEnvironment,
  classifySquirrelArgv,
  handleSquirrelStartup,
  type SquirrelStartupDependencies
} from "../src/main/squirrel-startup.js";

const execPath = "/Users/example/app-0.1.0/TokenMonster.exe";

function spawnedProcess(): EventEmitter & { unref: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), { unref: vi.fn() });
}

function dependencies(
  argv: readonly string[],
  platform: NodeJS.Platform = "win32"
): {
  deps: SquirrelStartupDependencies;
  child: ReturnType<typeof spawnedProcess>;
  spawn: ReturnType<typeof vi.fn>;
  spawnSync: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
} {
  const child = spawnedProcess();
  const spawn = vi.fn(() => child);
  const spawnSync = vi.fn(() => ({ status: 0 }));
  const quit = vi.fn();
  const unlink = vi.fn();
  return {
    deps: {
      argv,
      platform,
      execPath,
      spawn: spawn as unknown as SquirrelStartupDependencies["spawn"],
      spawnSync:
        spawnSync as unknown as SquirrelStartupDependencies["spawnSync"],
      quit,
      environment: {
        LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
        PATH: "C:\\Windows\\System32",
        HTTP_PROXY: "http://proxy.invalid",
        npm_config_https_proxy: "http://npm-proxy.invalid"
      },
      timeoutMs: 50,
      unlink
    },
    child,
    spawn,
    spawnSync,
    quit,
    unlink
  };
}

describe("classifySquirrelArgv", () => {
  it.each([
    ["--squirrel-install", "install"],
    ["--squirrel-updated", "updated"],
    ["--squirrel-uninstall", "uninstall"],
    ["--squirrel-obsolete", "obsolete"],
    ["--squirrel-firstrun", "firstrun"]
  ] as const)("classifies %s", (flag, expected) => {
    expect(classifySquirrelArgv(["TokenMonster.exe", flag], "win32")).toBe(
      expected
    );
  });

  it("scans dev-offset argv and returns the first flag", () => {
    expect(
      classifySquirrelArgv(
        ["electron.exe", "app", "--squirrel-uninstall", "--squirrel-install"],
        "win32"
      )
    ).toBe("uninstall");
  });

  it("returns null without a flag or off Windows", () => {
    expect(classifySquirrelArgv(["TokenMonster.exe"], "win32")).toBeNull();
    expect(
      classifySquirrelArgv(["TokenMonster", "--squirrel-install"], "linux")
    ).toBeNull();
  });
});

describe("buildSquirrelEnvironment", () => {
  it("keeps Windows launch essentials and drops proxies and unrelated input", () => {
    const environment = buildSquirrelEnvironment({
      USERPROFILE: "C:\\Users\\example",
      LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
      PATH: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      HTTP_PROXY: "http://proxy.invalid",
      HTTPS_PROXY: "https://proxy.invalid",
      ALL_PROXY: "socks5://proxy.invalid",
      NO_PROXY: "localhost",
      npm_config_proxy: "http://npm-proxy.invalid",
      npm_config_https_proxy: "http://npm-proxy.invalid",
      OPENAI_API_KEY: "secret"
    });

    expect(environment).toEqual({
      USERPROFILE: "C:\\Users\\example",
      LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
      PATH: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows"
    });
    expect(Object.isFrozen(environment)).toBe(true);
  });

  it("rejects malformed environment values without invoking getters", () => {
    const source = Object.create(null) as NodeJS.ProcessEnv;
    Object.defineProperty(source, "PATH", {
      enumerable: true,
      get: () => {
        throw new Error("getter must not run");
      }
    });
    source["TEMP"] = "bad\0value";
    expect(buildSquirrelEnvironment(source)).toEqual({});
  });
});

describe("handleSquirrelStartup", () => {
  it("creates the executable shortcut on install, then quits", () => {
    const { deps, child, spawn, quit } = dependencies([
      "TokenMonster.exe",
      "--squirrel-install"
    ]);
    expect(handleSquirrelStartup(deps)).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      resolve(dirname(execPath), "..", "Update.exe"),
      [`--createShortcut=${basename(execPath)}`],
      {
        detached: true,
        env: {
          LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
          PATH: "C:\\Windows\\System32"
        },
        windowsHide: true,
        stdio: "ignore"
      }
    );
    expect(quit).not.toHaveBeenCalled();
    child.emit("close");
    expect(quit).toHaveBeenCalledOnce();
  });

  it("removes the execution stub and shortcut on uninstall", () => {
    const { deps, spawn, spawnSync, quit, unlink } = dependencies([
      "TokenMonster.exe",
      "--squirrel-uninstall"
    ]);
    expect(handleSquirrelStartup(deps)).toBe(true);
    expect(unlink).toHaveBeenCalledWith(
      resolve(dirname(execPath), "..", basename(execPath))
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenCalledWith(
      resolve(dirname(execPath), "..", "Update.exe"),
      [`--removeShortcut=${basename(execPath)}`],
      {
        env: {
          LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
          PATH: "C:\\Windows\\System32"
        },
        killSignal: "SIGKILL",
        stdio: "ignore",
        timeout: 50,
        windowsHide: true
      }
    );
    expect(quit).toHaveBeenCalledOnce();
  });

  it("bounds uninstall shortcut cleanup with the production timeout", () => {
    const { deps, spawnSync } = dependencies([
      "TokenMonster.exe",
      "--squirrel-uninstall"
    ]);
    const { timeoutMs: _timeoutMs, ...defaultTimeoutDeps } = deps;

    expect(handleSquirrelStartup(defaultTimeoutDeps)).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeout: 6_000 })
    );
  });

  it("continues shortcut cleanup when execution-stub removal fails", () => {
    const { deps, spawnSync, quit, unlink } = dependencies([
      "TokenMonster.exe",
      "--squirrel-uninstall"
    ]);
    unlink.mockImplementation(() => {
      throw new Error("locked");
    });

    expect(handleSquirrelStartup(deps)).toBe(true);
    expect(unlink).toHaveBeenCalledOnce();
    expect(spawnSync).toHaveBeenCalledWith(
      expect.any(String),
      [`--removeShortcut=${basename(execPath)}`],
      expect.any(Object)
    );
    expect(quit).toHaveBeenCalledOnce();
  });

  it("quits after a bounded uninstall shortcut timeout result", () => {
    const { deps, spawnSync, quit } = dependencies([
      "TokenMonster.exe",
      "--squirrel-uninstall"
    ]);
    spawnSync.mockReturnValue({
      error: new Error("timed out"),
      output: [],
      pid: 1,
      signal: "SIGKILL",
      status: null,
      stderr: null,
      stdout: null
    });

    expect(handleSquirrelStartup(deps)).toBe(true);
    expect(spawnSync).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("quits when the uninstall shortcut worker cannot be spawned", () => {
    const { deps, spawnSync, quit } = dependencies([
      "TokenMonster.exe",
      "--squirrel-uninstall"
    ]);
    spawnSync.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    expect(handleSquirrelStartup(deps)).toBe(true);
    expect(spawnSync).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("does not unlink outside a versioned Squirrel app directory", () => {
    const { deps, spawnSync, unlink, quit } = dependencies([
      "TokenMonster.exe",
      "--squirrel-uninstall"
    ]);

    expect(
      handleSquirrelStartup({
        ...deps,
        execPath: "/Users/example/TokenMonster.exe"
      })
    ).toBe(true);
    expect(unlink).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("quits obsolete versions without spawning", () => {
    const { deps, spawn, quit } = dependencies([
      "TokenMonster.exe",
      "--squirrel-obsolete"
    ]);
    expect(handleSquirrelStartup(deps)).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("does not handle first-run startup", () => {
    const { deps, spawn, quit } = dependencies([
      "TokenMonster.exe",
      "--squirrel-firstrun"
    ]);
    expect(handleSquirrelStartup(deps)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it("still quits when spawning Update.exe throws", () => {
    const { deps, spawn, quit } = dependencies([
      "TokenMonster.exe",
      "--squirrel-updated"
    ]);
    spawn.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    expect(handleSquirrelStartup(deps)).toBe(true);
    expect(quit).toHaveBeenCalledOnce();
  });

  it("bounds the wait for Update.exe to exit", () => {
    vi.useFakeTimers();
    try {
      const { deps, quit } = dependencies([
        "TokenMonster.exe",
        "--squirrel-install"
      ]);
      expect(handleSquirrelStartup(deps)).toBe(true);
      expect(quit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(50);
      expect(quit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing off Windows", () => {
    const { deps, spawn, quit } = dependencies(
      ["TokenMonster", "--squirrel-install"],
      "darwin"
    );
    expect(handleSquirrelStartup(deps)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });
});
