import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runOwnedTask } from "../owned-task.mjs";
import { parseWindowsCommandLine } from "../process-identity.mjs";
import {
  createWindowsAbandonedTaskCleanup,
  installParentDisconnectWatchdog,
  parseProcessGroupSnapshot,
  quoteWindowsArgument,
  sendTaskResult,
  taskkillResultSucceeded,
  terminateVerifiedWindowsChildTree,
} from "../task-runner.mjs";
import { acknowledgeAbandonedLaunchTask } from "../launch-lock.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 424242;
  child.exitCode = null;
  child.signalCode = null;
  child.send = (_message, callback) => callback(null);
  return child;
}

test("owned task timeout waits for verified tree cleanup", async () => {
  const child = fakeChild();
  let verified = false;
  const result = await runOwnedTask("build", 1, {
    spawnTask: () => child,
    terminate: async (pid, verify) => {
      assert.equal(pid, child.pid);
      verified = verify();
      child.signalCode = "SIGTERM";
      child.emit("exit", null, "SIGTERM");
      return true;
    },
  });
  assert.equal(verified, true);
  assert.equal(result, "timeout");
});

test("owned task reports timeout cleanup failure deterministically", async () => {
  const child = fakeChild();
  const result = await runOwnedTask("dependency_install", 1, {
    spawnTask: () => child,
    terminate: async () => false,
  });
  assert.equal(result, "timeout_cleanup_failed");
});

test("owned task clears its lock identity only after full tree cleanup", async () => {
  const child = fakeChild();
  let activeTask;
  let clearedTask;
  let authorized;
  child.send = (message, callback) => {
    authorized = message;
    callback(null);
  };
  const pending = runOwnedTask("build", 1_000, {
    spawnTask: () => child,
    onSpawn: (value) => {
      activeTask = value;
    },
    onCleaned: (value) => {
      clearedTask = value;
    },
    terminate: async (pid, verify) => {
      assert.equal(pid, child.pid);
      assert.equal(verify(), true);
      child.signalCode = "SIGTERM";
      child.emit("exit", null, "SIGTERM");
      return true;
    },
  });
  child.emit("spawn");
  assert.deepEqual(authorized, {
    type: "authorize",
    runnerToken: activeTask.runnerToken,
    task: "build",
  });
  child.emit("message", {
    type: "task_result",
    runnerToken: activeTask.runnerToken,
    task: "build",
    result: "succeeded",
  });
  assert.equal(await pending, "succeeded");
  assert.deepEqual(clearedTask, activeTask);
});

test("owned task retains lock evidence when result cleanup fails", async () => {
  const child = fakeChild();
  let activeTask;
  let cleared = false;
  const pending = runOwnedTask("dependency_install", 1_000, {
    spawnTask: () => child,
    onSpawn: (value) => {
      activeTask = value;
    },
    onCleaned: () => {
      cleared = true;
    },
    terminate: async () => false,
  });
  child.emit("spawn");
  child.emit("message", {
    type: "task_result",
    runnerToken: activeTask.runnerToken,
    task: "dependency_install",
    result: "failed",
  });
  assert.equal(await pending, "cleanup_failed");
  assert.equal(cleared, false);
});

test("task result send failures are explicit", async () => {
  const token = "12345678-1234-4123-8123-123456789abc";
  const failedChannel = {
    connected: true,
    send(_message, callback) {
      callback(new Error("closed"));
    },
  };
  assert.equal(
    await sendTaskResult(token, "build", "succeeded", failedChannel),
    false,
  );
  assert.equal(
    await sendTaskResult(token, "build", "succeeded", {
      connected: false,
    }),
    false,
  );
});

test("Windows task wrapper preserves exact argument boundaries", () => {
  const values = [
    "",
    "plain",
    "two words",
    "C:\\path with spaces\\",
    'embedded"quote',
    'slashes\\\\"quote',
  ];
  const commandLine = values.map(quoteWindowsArgument).join(" ");
  assert.deepEqual(parseWindowsCommandLine(commandLine), values);
});

test("POSIX task quiescence accepts only the runner and probe", () => {
  const options = {
    processGroupId: 424200,
    runnerPid: 424200,
    probePid: 424201,
  };
  assert.equal(
    parseProcessGroupSnapshot(
      "424200 424200 Ssl\n424201 424200 R\n",
      options,
    ),
    true,
  );
  assert.equal(
    parseProcessGroupSnapshot(
      "424200 424200 Ssl\n424201 424200 R\n424202 424200 S\n",
      options,
    ),
    false,
  );
  assert.equal(
    parseProcessGroupSnapshot(
      "424200 424200 Ssl\n424201 424200 R\n424202 424200 Z\n",
      options,
    ),
    true,
  );
  assert.equal(
    parseProcessGroupSnapshot("hostile output\n", options),
    undefined,
  );
});

test("task watchdog kills its process group when launcher IPC dies", () => {
  const channel = new EventEmitter();
  channel.connected = true;
  let kills = 0;
  const watchdog = installParentDisconnectWatchdog({
    channel,
    killTree: () => {
      kills += 1;
    },
  });
  assert.equal(watchdog.armed, true);
  channel.emit("disconnect");
  channel.emit("disconnect");
  assert.equal(kills, 1);
  assert.equal(watchdog.armed, false);
});

test("disarmed task watchdog ignores a later disconnect", () => {
  const channel = new EventEmitter();
  channel.connected = true;
  let kills = 0;
  const watchdog = installParentDisconnectWatchdog({
    channel,
    killTree: () => {
      kills += 1;
    },
  });
  watchdog.disarm();
  channel.emit("disconnect");
  assert.equal(kills, 0);
});

test("task watchdog rejects partial taskkill results", () => {
  assert.equal(
    taskkillResultSucceeded({
      status: 0,
      signal: null,
      error: undefined,
    }),
    true,
  );
  assert.equal(
    taskkillResultSucceeded({
      status: null,
      signal: "SIGTERM",
      error: undefined,
    }),
    false,
  );
  assert.equal(
    taskkillResultSucceeded({
      status: 1,
      signal: null,
      error: undefined,
    }),
    false,
  );
});

test("Windows parent loss kills once, records quiescence, then acknowledges", () => {
  const activeTask = Object.freeze({
    pid: 1234,
    runnerToken: "11111111-1111-4111-8111-111111111111",
    task: "build",
  });
  const killed = [];
  let acknowledgementAttempts = 0;
  const exits = [];
  const child = {
    pid: 4321,
    exitCode: null,
    signalCode: null,
  };
  const identity = Object.freeze({
    executablePath: "C:\\Windows\\powershell.exe",
    argv: Object.freeze([
      "C:\\Windows\\powershell.exe",
      "-Payload",
      "reviewed",
    ]),
  });
  const cleanup = createWindowsAbandonedTaskCleanup(activeTask, {
    terminateChildTree(candidate, candidateIdentity) {
      assert.equal(candidate, child);
      assert.equal(candidateIdentity, identity);
      killed.push(candidate.pid);
      return true;
    },
    acknowledge(candidate) {
      assert.equal(candidate, activeTask);
      acknowledgementAttempts += 1;
      return acknowledgementAttempts === 2
        ? "acknowledged"
        : "retry";
    },
    exit(code) {
      exits.push(code);
    },
  });

  cleanup.onSpawn(child, identity);
  assert.equal(cleanup.cleanup(), false);
  assert.deepEqual(killed, [4321]);
  assert.equal(acknowledgementAttempts, 0);
  assert.deepEqual(exits, []);

  assert.equal(cleanup.cleanup(), false);
  assert.deepEqual(killed, [4321]);
  assert.equal(acknowledgementAttempts, 0);

  child.exitCode = 1;
  cleanup.onClose(child, true);
  assert.equal(cleanup.cleanup(), false);
  assert.equal(acknowledgementAttempts, 1);
  assert.equal(cleanup.cleanup(), true);
  assert.equal(acknowledgementAttempts, 2);
  assert.deepEqual(exits, [1]);
});

test("Windows observed exit and substituted child refs are never taskkilled", () => {
  const activeTask = Object.freeze({
    pid: 1234,
    runnerToken: "11111111-1111-4111-8111-111111111111",
    task: "electron_install",
  });
  const child = {
    pid: 4321,
    exitCode: null,
    signalCode: null,
  };
  const identity = Object.freeze({
    executablePath: "C:\\Windows\\powershell.exe",
    argv: Object.freeze(["C:\\Windows\\powershell.exe", "-File", "safe.ps1"]),
  });
  let kills = 0;
  let acknowledgements = 0;
  const cleanup = createWindowsAbandonedTaskCleanup(activeTask, {
    terminateChildTree: () => {
      kills += 1;
      return true;
    },
    acknowledge: () => {
      acknowledgements += 1;
      return "already_absent";
    },
    exit: () => undefined,
  });

  cleanup.onSpawn(child, identity);
  child.exitCode = 1;
  assert.equal(cleanup.cleanup(), false);
  cleanup.onClose({ ...child }, true);
  assert.equal(cleanup.cleanup(), false);
  assert.equal(kills, 0);
  assert.equal(acknowledgements, 0);

  cleanup.onClose(child, true);
  assert.equal(cleanup.cleanup(), true);
  assert.equal(kills, 0);
  assert.equal(acknowledgements, 1);
});

test("Windows verified termination rechecks child state before taskkill", () => {
  const child = {
    pid: 4321,
    exitCode: null,
    signalCode: null,
  };
  const identity = Object.freeze({
    executablePath: "C:\\Windows\\powershell.exe",
    argv: Object.freeze(["C:\\Windows\\powershell.exe", "-Payload", "safe"]),
  });
  let taskkills = 0;
  assert.equal(
    terminateVerifiedWindowsChildTree(child, identity, {
      matchesInvocation: () => {
        child.exitCode = 0;
        return true;
      },
      runTaskkill: () => {
        taskkills += 1;
        return { status: 0, signal: null, error: undefined };
      },
      alive: () => false,
    }),
    false,
  );
  assert.equal(taskkills, 0);
});

test("Windows unregistered task exits when its dead-owner lock is already clear", () => {
  const activeTask = Object.freeze({
    pid: 1234,
    runnerToken: "11111111-1111-4111-8111-111111111111",
    task: "dependency_install",
  });
  const lock = Object.freeze({
    schemaVersion: 1,
    contractVersion: "1.0.0",
    pid: 5678,
    ownerToken: "22222222-2222-4222-8222-222222222222",
    activeTask: null,
    createdAt: "2026-07-23T00:00:00.000Z",
  });
  let writes = 0;
  const acknowledgement = acknowledgeAbandonedLaunchTask(activeTask, {
    platform: "win32",
    selfPid: activeTask.pid,
    matchesTaskRunner: () => true,
    ownerAlive: () => false,
    readLock: () => lock,
    writeLock: () => {
      writes += 1;
    },
  });
  assert.equal(acknowledgement, "already_absent");
  assert.equal(writes, 0);

  const exits = [];
  const cleanup = createWindowsAbandonedTaskCleanup(activeTask, {
    terminateChildTree: () => {
      throw new Error("no child tree may be killed");
    },
    acknowledge: () => acknowledgement,
    exit: (code) => exits.push(code),
  });
  assert.equal(cleanup.cleanup(), true);
  assert.deepEqual(exits, [1]);
});
