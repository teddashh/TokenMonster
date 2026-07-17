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
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly timeoutMs?: number;
}

const FLAGS: ReadonlyArray<readonly [string, SquirrelEvent]> = [
  ["--squirrel-install", "install"],
  ["--squirrel-updated", "updated"],
  ["--squirrel-uninstall", "uninstall"],
  ["--squirrel-obsolete", "obsolete"],
  ["--squirrel-firstrun", "firstrun"]
];

const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TMP",
  "TEMP",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "LC_CTYPE"
]);
const MAX_ENVIRONMENT_VALUE_CHARACTERS = 32_768;

function readOwnEnvironmentString(
  source: Readonly<NodeJS.ProcessEnv>,
  key: string
): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  const value = descriptor.value as unknown;
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ENVIRONMENT_VALUE_CHARACTERS &&
    !value.includes("\0")
    ? value
    : undefined;
}

export function buildSquirrelEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env
): Readonly<NodeJS.ProcessEnv> {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return Object.freeze({});
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = readOwnEnvironmentString(source, key);
    if (value !== undefined) environment[key] = value;
  }
  return Object.freeze(environment);
}

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
      {
        detached: true,
        env: buildSquirrelEnvironment(deps.environment),
        windowsHide: true,
        stdio: "ignore"
      }
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
