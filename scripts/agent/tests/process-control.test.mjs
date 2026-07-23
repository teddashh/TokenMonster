import assert from "node:assert/strict";
import test from "node:test";

import {
  deadProcessTreeAbsent,
  stoppedRuntimeCanBeCleared,
  taskkillSucceeded,
  terminateProcessTree,
} from "../process-control.mjs";

test("termination re-verifies identity before SIGKILL escalation", async () => {
  const signals = [];
  let verifications = 0;
  const result = await terminateProcessTree(
    424242,
    () => {
      verifications += 1;
      return verifications === 1;
    },
    {
      platform: "linux",
      alive: () => true,
      groupAlive: () => true,
      waitForGroupExit: async () => false,
      kill: (pid, signal) => {
        signals.push([pid, signal]);
      },
    },
  );
  assert.equal(result, false);
  assert.deepEqual(signals, [[-424242, "SIGTERM"]]);
  assert.equal(verifications, 2);
});

test("termination waits for descendants after the leader exits", async () => {
  const signals = [];
  let leaderAlive = true;
  let groupAlive = true;
  let waits = 0;
  const result = await terminateProcessTree(
    424243,
    () => true,
    {
      platform: "linux",
      alive: () => leaderAlive,
      groupAlive: () => groupAlive,
      waitForGroupExit: async () => {
        waits += 1;
        if (waits === 1) return false;
        groupAlive = false;
        return true;
      },
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === "SIGTERM") leaderAlive = false;
      },
    },
  );
  assert.equal(result, true);
  assert.deepEqual(signals, [
    [-424243, "SIGTERM"],
    [-424243, "SIGKILL"],
  ]);
});

test("a dead leader with live POSIX descendants fails closed", async () => {
  const absent = deadProcessTreeAbsent(424244, {
    platform: "linux",
    alive: () => false,
    groupAlive: () => true,
  });
  assert.equal(absent, false);

  const result = await terminateProcessTree(
    424244,
    () => false,
    {
      platform: "linux",
      alive: () => false,
      groupAlive: () => true,
      kill: () => {
        throw new Error("must not kill an unverified group");
      },
    },
  );
  assert.equal(result, false);
});

test("Windows dead state requires an exact final runner terminal marker", () => {
  const options = {
    platform: "win32",
    alive: () => false,
    groupAlive: () => true,
  };
  assert.equal(
    stoppedRuntimeCanBeCleared(424245, [], options),
    false,
  );
  assert.equal(
    stoppedRuntimeCanBeCleared(
      424245,
      ["[TOKENMONSTER_AGENT] EXIT code=0"],
      options,
    ),
    true,
  );
  assert.equal(
    stoppedRuntimeCanBeCleared(
      424245,
      ["[TOKENMONSTER_AGENT] EXIT code=0 "],
      options,
    ),
    false,
  );
});

test("Windows taskkill cleanup accepts only an unambiguous success", () => {
  assert.equal(
    taskkillSucceeded({ status: 0, signal: null, error: undefined }),
    true,
  );
  assert.equal(
    taskkillSucceeded({ status: 1, signal: null, error: undefined }),
    false,
  );
  assert.equal(
    taskkillSucceeded({ status: 0, signal: "SIGTERM", error: undefined }),
    false,
  );
  assert.equal(
    taskkillSucceeded({
      status: 0,
      signal: null,
      error: new Error("timeout"),
    }),
    false,
  );
});
