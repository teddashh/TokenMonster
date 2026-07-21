import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions
} from "node:child_process";

export interface TokenMonsterBrowserOpenOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly spawn?: (
    command: string,
    arguments_: readonly string[],
    options: SpawnOptions
  ) => ChildProcess;
}

function isSafeBootstrapUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      /^\/__tokenmonster\/bootstrap\/[A-Za-z0-9_-]{32,128}$/u.test(
        url.pathname
      )
    );
  } catch {
    return false;
  }
}

function browserCommand(
  url: string,
  platform: NodeJS.Platform,
  environment: Readonly<NodeJS.ProcessEnv>
): Readonly<{ command: string; arguments_: readonly string[] }> {
  if (platform === "darwin") {
    return Object.freeze({ command: "open", arguments_: Object.freeze([url]) });
  }
  if (platform === "win32") {
    return Object.freeze({
      command: "explorer.exe",
      arguments_: Object.freeze([url])
    });
  }
  const underWsl =
    typeof environment["WSL_DISTRO_NAME"] === "string" ||
    typeof environment["WSL_INTEROP"] === "string";
  return Object.freeze({
    command: underWsl ? "wslview" : "xdg-open",
    arguments_: Object.freeze([url])
  });
}

export async function openTokenMonsterBrowser(
  url: string,
  options: TokenMonsterBrowserOpenOptions = {}
): Promise<boolean> {
  if (!isSafeBootstrapUrl(url)) return false;
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const spawn = options.spawn ?? ((command, arguments_, spawnOptions) =>
    nodeSpawn(command, [...arguments_], spawnOptions));
  const invocation = browserCommand(url, platform, environment);
  let child: ChildProcess;
  try {
    child = spawn(invocation.command, invocation.arguments_, {
      detached: true,
      env: { ...environment },
      shell: false,
      stdio: "ignore",
      windowsHide: true
    });
  } catch {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      child.off("spawn", onSpawn);
      child.off("error", onError);
      resolve(opened);
    };
    const onSpawn = (): void => {
      child.unref();
      finish(true);
    };
    const onError = (): void => finish(false);
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}
