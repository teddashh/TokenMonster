import assert from "node:assert/strict";
import test from "node:test";

import {
  parseWindowsCommandLine,
  processMatchesExactWindowsInvocation,
  validRunnerToken,
  windowsProcessDetailsMatch,
} from "../process-identity.mjs";

test("Windows command-line parsing preserves reviewed argv boundaries", () => {
  assert.deepEqual(
    parseWindowsCommandLine(
      '"C:\\Program Files\\node.exe" scripts\\agent\\runner.mjs 1234',
    ),
    [
      "C:\\Program Files\\node.exe",
      "scripts\\agent\\runner.mjs",
      "1234",
    ],
  );
  assert.equal(
    parseWindowsCommandLine('"C:\\Program Files\\node.exe'),
    undefined,
  );
  assert.equal(
    parseWindowsCommandLine("node runner token extra").length,
    4,
  );
});

test("runner ownership tokens are strict v4 UUIDs", () => {
  assert.equal(
    validRunnerToken("12345678-1234-4234-8234-123456789abc"),
    true,
  );
  assert.equal(validRunnerToken("token with spaces"), false);
  assert.equal(
    validRunnerToken("12345678-1234-1234-8234-123456789abc"),
    false,
  );
});

test("Windows exact invocation rejects executable, payload and argv drift", () => {
  const executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const argv = [
    executable,
    "-NoLogo",
    "-File",
    "C:\\repo\\scripts\\agent\\windows-task-tree.ps1",
    "-Payload",
    "reviewed-base64",
  ];
  const details = {
    ExecutablePath: executable.toUpperCase(),
    CommandLine: argv.map((value) => `"${value}"`).join(" "),
  };
  assert.equal(
    windowsProcessDetailsMatch(details, executable, argv),
    true,
  );
  assert.equal(
    windowsProcessDetailsMatch(
      { ...details, ExecutablePath: "C:\\foreign.exe" },
      executable,
      argv,
    ),
    false,
  );
  assert.equal(
    windowsProcessDetailsMatch(
      {
        ...details,
        CommandLine: details.CommandLine.replace(
          "reviewed-base64",
          "mutated-base64",
        ),
      },
      executable,
      argv,
    ),
    false,
  );
  assert.equal(
    windowsProcessDetailsMatch(
      { ...details, CommandLine: `${details.CommandLine} "extra"` },
      executable,
      argv,
    ),
    false,
  );
  assert.equal(
    processMatchesExactWindowsInvocation(
      1234,
      executable,
      argv,
      () => details,
    ),
    true,
  );
});
