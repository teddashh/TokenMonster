import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { join } from "node:path";

import { projectSafeEnvironment } from "./environment.mjs";

const TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMMAND_LINE_CAP = 16 * 1024;

export function validProcessId(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

export function validRunnerToken(value) {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function processAlive(pid) {
  if (!validProcessId(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function fixedPosixPs(platform) {
  const candidates =
    platform === "darwin"
      ? ["/bin/ps", "/usr/bin/ps"]
      : ["/usr/bin/ps", "/bin/ps"];
  for (const candidate of candidates) {
    try {
      if (lstatSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next fixed operating-system location.
    }
  }
  return undefined;
}

function fixedPowerShell() {
  const systemRoot = process.env.SystemRoot;
  if (
    typeof systemRoot !== "string" ||
    !/^[A-Za-z]:\\Windows$/iu.test(systemRoot)
  ) {
    return undefined;
  }
  const candidate = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    const metadata = lstatSync(candidate);
    return metadata.isSymbolicLink() || !metadata.isFile()
      ? undefined
      : candidate;
  } catch {
    return undefined;
  }
}

function windowsProcessDetails(pid) {
  const command = fixedPowerShell();
  if (command === undefined) return undefined;
  const script =
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';` +
    "if($null -ne $p){" +
    "$o=[ordered]@{ExecutablePath=$p.ExecutablePath;CommandLine=$p.CommandLine};" +
    "[Console]::Out.Write(($o|ConvertTo-Json -Compress))}";
  const result = spawnSync(
    command,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ],
    {
      encoding: "utf8",
      env: projectSafeEnvironment(process.env, { gui: false }),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: COMMAND_LINE_CAP,
    },
  );
  if (result.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(String(result.stdout ?? ""));
    if (
      Object.keys(parsed).length !== 2 ||
      typeof parsed.ExecutablePath !== "string" ||
      typeof parsed.CommandLine !== "string" ||
      parsed.CommandLine.length > 8 * 1024
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function parseWindowsCommandLine(commandLine) {
  if (
    typeof commandLine !== "string" ||
    commandLine.length === 0 ||
    commandLine.length > 8 * 1024
  ) {
    return undefined;
  }
  const args = [];
  let index = 0;
  while (index < commandLine.length) {
    while (/\s/u.test(commandLine[index] ?? "")) index += 1;
    if (index >= commandLine.length) break;
    let value = "";
    let quoted = false;
    while (index < commandLine.length) {
      if (!quoted && /\s/u.test(commandLine[index])) break;
      let slashes = 0;
      while (commandLine[index] === "\\") {
        slashes += 1;
        index += 1;
      }
      if (commandLine[index] === '"') {
        value += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) {
          value += '"';
          index += 1;
        } else if (
          quoted &&
          commandLine[index + 1] === '"'
        ) {
          value += '"';
          index += 2;
        } else {
          quoted = !quoted;
          index += 1;
        }
        continue;
      }
      value += "\\".repeat(slashes);
      if (index < commandLine.length) {
        value += commandLine[index];
        index += 1;
      }
    }
    if (quoted) return undefined;
    args.push(value);
    while (/\s/u.test(commandLine[index] ?? "")) index += 1;
  }
  return args;
}

function linuxProcessArgv(pid) {
  if (process.platform !== "linux" || !validProcessId(pid)) {
    return undefined;
  }
  const path = `/proc/${pid}/cmdline`;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const buffer = Buffer.alloc(COMMAND_LINE_CAP + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (count === 0) break;
      offset += count;
    }
    if (offset === 0 || offset > COMMAND_LINE_CAP) return undefined;
    const values = buffer
      .subarray(0, offset)
      .toString("utf8")
      .split("\0");
    if (values.at(-1) === "") values.pop();
    return values.every((value) => value.length > 0)
      ? values
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function processCommandLine(pid, platform = process.platform) {
  if (!validProcessId(pid)) return undefined;
  if (platform === "win32") {
    return windowsProcessDetails(pid)?.CommandLine;
  }
  const command = fixedPosixPs(platform);
  if (command === undefined) return undefined;
  const result = spawnSync(command, ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    env: projectSafeEnvironment(process.env, { gui: false }),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: COMMAND_LINE_CAP,
  });
  if (result.status !== 0) return undefined;
  const line = String(result.stdout ?? "").trim();
  return line.length > 0 && line.length <= 8 * 1024 ? line : undefined;
}

function expectedAgentArgv(scriptName, runnerToken, task) {
  return [
    process.execPath,
    join("scripts", "agent", scriptName),
    ...(runnerToken === undefined ? [] : [runnerToken]),
    ...(task === undefined ? [] : [task]),
  ];
}

function exactArguments(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function exactAgentProcess(
  pid,
  expected,
  injectedCommandLine,
) {
  if (process.platform === "linux") {
    return exactArguments(linuxProcessArgv(pid), expected);
  }
  if (process.platform === "win32") {
    if (injectedCommandLine !== undefined) {
      return exactArguments(
        parseWindowsCommandLine(injectedCommandLine),
        expected,
      );
    }
    const details = windowsProcessDetails(pid);
    return (
      details !== undefined &&
      details.ExecutablePath.toLowerCase() ===
        expected[0].toLowerCase() &&
      exactArguments(
        parseWindowsCommandLine(details.CommandLine),
        expected,
      )
    );
  }
  if (expected.some((value) => /\s/u.test(value))) return false;
  const commandLine =
    injectedCommandLine ?? processCommandLine(pid, process.platform);
  return commandLine === expected.join(" ");
}

export function windowsProcessDetailsMatch(
  details,
  expectedExecutablePath,
  expectedArgv,
) {
  if (
    details === undefined ||
    typeof details.ExecutablePath !== "string" ||
    typeof details.CommandLine !== "string" ||
    typeof expectedExecutablePath !== "string" ||
    expectedExecutablePath.length === 0 ||
    !Array.isArray(expectedArgv) ||
    expectedArgv.length === 0 ||
    expectedArgv[0] !== expectedExecutablePath ||
    expectedArgv.some(
      (argument) =>
        typeof argument !== "string" || argument.includes("\0"),
    ) ||
    details.ExecutablePath.toLowerCase() !==
      expectedExecutablePath.toLowerCase()
  ) {
    return false;
  }
  const actualArgv = parseWindowsCommandLine(details.CommandLine);
  return (
    actualArgv !== undefined &&
    actualArgv.length === expectedArgv.length &&
    actualArgv[0].toLowerCase() ===
      expectedArgv[0].toLowerCase() &&
    actualArgv
      .slice(1)
      .every((argument, index) => argument === expectedArgv[index + 1])
  );
}

export function processMatchesExactWindowsInvocation(
  pid,
  executablePath,
  argv,
  readDetails = windowsProcessDetails,
) {
  return (
    validProcessId(pid) &&
    windowsProcessDetailsMatch(
      readDetails(pid),
      executablePath,
      argv,
    )
  );
}

export function processMatchesRunner(pid, runnerToken, commandLine) {
  return (
    validRunnerToken(runnerToken) &&
    exactAgentProcess(
      pid,
      expectedAgentArgv("runner.mjs", runnerToken),
      commandLine,
    )
  );
}

export function processMatchesTaskRunner(pid, runnerToken, commandLine) {
  return (
    validRunnerToken(runnerToken) &&
    ["dependency_install", "electron_install", "build"].some((task) =>
      exactAgentProcess(
        pid,
        expectedAgentArgv(
          "task-runner.mjs",
          runnerToken,
          task,
        ),
        commandLine,
      )
    )
  );
}

export function processMatchesLauncher(pid, commandLine) {
  return exactAgentProcess(
    pid,
    expectedAgentArgv("launch.mjs"),
    commandLine,
  );
}
