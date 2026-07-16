import { spawn as nodeSpawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

export type SquirrelEvent =
  | "install"
  | "updated"
  | "uninstall"
  | "obsolete"
  | "firstrun";

export interface SquirrelStartupDependencies {
  readonly argv: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly spawn: typeof nodeSpawn;
  readonly quit: () => void;
  readonly timeoutMs?: number;
}

const FLAGS: ReadonlyArray<readonly [string, SquirrelEvent]> = [
  ["--squirrel-install", "install"],
  ["--squirrel-updated", "updated"],
  ["--squirrel-uninstall", "uninstall"],
  ["--squirrel-obsolete", "obsolete"],
  ["--squirrel-firstrun", "firstrun"]
];

export function classifySquirrelArgv(
  argv: readonly string[],
  platform: NodeJS.Platform
): SquirrelEvent | null {
  if (platform !== "win32") return null;
  for (const argument of argv) {
    const match = FLAGS.find(([flag]) => flag === argument);
    if (match !== undefined) return match[1];
  }
  return null;
}

export function handleSquirrelStartup(
  deps: SquirrelStartupDependencies
): boolean {
  const event = classifySquirrelArgv(deps.argv, deps.platform);
  if (event === null || event === "firstrun") return false;
  if (event === "obsolete") {
    deps.quit();
    return true;
  }

  const action = event === "uninstall" ? "removeShortcut" : "createShortcut";
  try {
    const child = deps.spawn(
      resolve(dirname(deps.execPath), "..", "Update.exe"),
      [`--${action}=${basename(deps.execPath)}`],
      { detached: true, windowsHide: true, stdio: "ignore" }
    );
    let finished = false;
    const quit = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      deps.quit();
    };
    const timeout = setTimeout(quit, deps.timeoutMs ?? 1_000);
    child.once("close", quit);
    child.once("error", quit);
    child.unref();
  } catch {
    deps.quit();
  }
  return true;
}

export function handleDefaultSquirrelStartup(quit: () => void): boolean {
  return handleSquirrelStartup({
    argv: process.argv,
    platform: process.platform,
    execPath: process.execPath,
    spawn: nodeSpawn,
    quit
  });
}
