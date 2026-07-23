import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import {
  parseLaunchArguments,
} from "../launch.mjs";
import {
  rootDirectory,
  runtimeDirectory,
} from "../contract.mjs";

test("launch flags reject contradictory and unbounded requests", () => {
  assert.equal(
    parseLaunchArguments(["--dry-run", "--wait"]),
    undefined,
  );
  assert.equal(
    parseLaunchArguments(["--timeout-ms", "1000"]),
    undefined,
  );
  assert.equal(
    parseLaunchArguments(["--wait", "--timeout-ms", "999"]),
    undefined,
  );
  assert.deepEqual(
    parseLaunchArguments([
      "--json",
      "--wait",
      "--timeout-ms",
      "60000",
    ]),
    {
      json: true,
      dryRun: false,
      wait: true,
      timeoutMs: 60000,
    },
  );
});

test("dry-run does not create or modify the runtime directory", () => {
  const before = existsSync(runtimeDirectory)
    ? statSync(runtimeDirectory).mtimeMs
    : undefined;
  const result = spawnSync(
    process.execPath,
    [join(rootDirectory, "scripts", "agent", "launch.mjs"), "--dry-run", "--json"],
    {
      cwd: rootDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    },
  );
  assert.equal(result.stderr, "");
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  const after = existsSync(runtimeDirectory)
    ? statSync(runtimeDirectory).mtimeMs
    : undefined;
  assert.equal(after, before);
});

test("usage errors never echo hostile argv or repository paths", () => {
  const secret = "/private/project/OPENAI-secret";
  const result = spawnSync(
    process.execPath,
    [join(rootDirectory, "scripts", "agent", "doctor.mjs"), secret],
    {
      cwd: rootDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stdout.includes(rootDirectory), false);
});
