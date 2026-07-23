import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { contractVersion, readyMarker } from "../contract.mjs";
import {
  committedState,
  createWindowsReadinessConfiguration,
  ReadinessLineGate,
  WindowsReadinessStreamGate,
  windowsPrivateHelloMarker,
} from "../runner.mjs";

test("readiness accepts one exact stdout line only once", () => {
  let reports = 0;
  const gate = new ReadinessLineGate(() => {
    reports += 1;
  });
  gate.push(Buffer.from(`${readyMarker}\n${readyMarker}\n`));
  assert.equal(reports, 1);
});

test("readiness rejects whitespace and an unterminated marker", () => {
  let reports = 0;
  for (const line of [
    ` ${readyMarker}\n`,
    `${readyMarker} \n`,
    `${readyMarker}\r\n`,
  ]) {
    const gate = new ReadinessLineGate(() => {
      reports += 1;
    });
    gate.push(Buffer.from(line));
  }
  const noNewline = new ReadinessLineGate(() => {
    reports += 1;
  });
  noNewline.push(Buffer.from(readyMarker));
  noNewline.finish();
  assert.equal(reports, 0);
});

test("stdout and stderr fragments cannot combine into readiness", () => {
  let reports = 0;
  const stdout = new ReadinessLineGate(() => {
    reports += 1;
  });
  const stderr = new ReadinessLineGate(() => {
    reports += 1;
  });
  const midpoint = Math.floor(readyMarker.length / 2);
  stdout.push(Buffer.from(readyMarker.slice(0, midpoint)));
  stderr.push(Buffer.from(`${readyMarker.slice(midpoint)}\n`));
  stdout.finish();
  stderr.finish();
  assert.equal(reports, 0);
});

test("overlong lines recover and closed gates ignore later bytes", () => {
  let reports = 0;
  const gate = new ReadinessLineGate(() => {
    reports += 1;
  });
  gate.push(Buffer.alloc(5 * 1024, 0x61));
  gate.push(Buffer.from(`\n${readyMarker}\n`));
  assert.equal(reports, 1);

  const closed = new ReadinessLineGate(() => {
    reports += 1;
  });
  closed.push(Buffer.from(readyMarker.slice(0, 8)));
  closed.finish();
  closed.push(Buffer.from(`${readyMarker.slice(8)}\n${readyMarker}\n`));
  assert.equal(reports, 1);
});

test("Windows readiness configuration uses exact random byte counts", () => {
  const requested = [];
  const configuration = createWindowsReadinessConfiguration((size) => {
    requested.push(size);
    return Buffer.alloc(size, size === 16 ? 0xab : 0xcd);
  });
  assert.deepEqual(requested, [16, 32]);
  assert.equal(configuration.pipeId, "ab".repeat(16));
  assert.equal(
    configuration.pipePath,
    `\\\\.\\pipe\\tokenmonster-agent-ready-${"ab".repeat(16)}`,
  );
  assert.equal(configuration.capability, "cd".repeat(32));
  assert.throws(
    () => createWindowsReadinessConfiguration(() => Buffer.alloc(15)),
    /agent_ready_channel_invalid/u,
  );
});

test("Windows private hello binds an exact pid and capability", () => {
  const capability = "a1".repeat(32);
  assert.equal(
    windowsPrivateHelloMarker(4242, capability),
    `[TOKENMONSTER_AGENT_PRIVATE] HELLO companion pid=4242 cap=${capability}`,
  );
  for (const [pid, value] of [
    [0, capability],
    [2_147_483_648, capability],
    [4242, capability.toUpperCase()],
    [4242, capability.slice(2)],
  ]) {
    assert.throws(
      () => windowsPrivateHelloMarker(pid, value),
      /agent_ready_marker_invalid/u,
    );
  }
});

function windowsGate(overrides = {}) {
  const events = [];
  const capability = "01".repeat(32);
  const hello = windowsPrivateHelloMarker(4242, capability);
  const gate = new WindowsReadinessStreamGate(hello, {
    onAuthenticated: () => {
      events.push("authenticated");
      return overrides.authenticatedResult ?? true;
    },
    onFatal: () => events.push("fatal"),
    onReady: () => {
      events.push("ready");
      return overrides.readyResult ?? true;
    },
    onRejected: () => events.push("rejected"),
  });
  return { capability, events, gate, hello };
}

test("Windows readiness accepts fragmented HELLO and READY only at EOF", () => {
  const { events, gate, hello } = windowsGate();
  const stream = `${hello}\n${readyMarker}\n`;
  for (const fragment of [
    stream.slice(0, 7),
    stream.slice(7, 91),
    stream.slice(91),
  ]) {
    gate.push(Buffer.from(fragment));
  }
  assert.deepEqual(events, ["authenticated"]);
  gate.finish();
  assert.deepEqual(events, ["authenticated", "ready"]);
  gate.finish();
  assert.deepEqual(events, ["authenticated", "ready"]);
});

test("Windows readiness accepts coalesced exact protocol on one stream", () => {
  const { events, gate, hello } = windowsGate();
  gate.push(Buffer.from(`${hello}\n${readyMarker}\n`));
  gate.finish();
  assert.deepEqual(events, ["authenticated", "ready"]);
});

test("Windows readiness rejects malformed or incomplete pre-auth streams", () => {
  const cases = [
    (hello) => `${hello.replace("pid=4242", "pid=4243")}\n`,
    (hello) => `${hello.slice(0, -1)}2\n`,
    (hello) => `${hello}\r\n`,
    (hello) => ` ${hello}\n`,
    (hello) => hello,
    () => "x".repeat(257),
  ];
  for (const invalid of cases) {
    const { events, gate, hello } = windowsGate();
    gate.push(Buffer.from(invalid(hello)));
    gate.finish();
    assert.deepEqual(events, ["rejected"]);
  }
});

test("Windows readiness fails authenticated protocol violations closed", () => {
  for (const suffix of [
    "",
    "wrong\n",
    `${readyMarker}\r\n`,
    `${readyMarker}\nextra`,
    `${readyMarker}\nextra\n`,
  ]) {
    const { events, gate, hello } = windowsGate();
    gate.push(Buffer.from(`${hello}\n${suffix}`));
    gate.finish();
    assert.deepEqual(events, ["authenticated", "fatal"]);
  }

  const failedSocket = windowsGate();
  failedSocket.gate.push(
    Buffer.from(`${failedSocket.hello}\n${readyMarker}\n`),
  );
  failedSocket.gate.fail();
  assert.deepEqual(failedSocket.events, [
    "authenticated",
    "fatal",
  ]);
});

test("separate Windows clients cannot combine protocol fragments", () => {
  const first = windowsGate();
  const second = windowsGate();
  const midpoint = Math.floor(first.hello.length / 2);
  first.gate.push(Buffer.from(first.hello.slice(0, midpoint)));
  first.gate.finish();
  second.gate.push(
    Buffer.from(`${first.hello.slice(midpoint)}\n${readyMarker}\n`),
  );
  second.gate.finish();
  assert.deepEqual(first.events, ["rejected"]);
  assert.deepEqual(second.events, ["rejected"]);
});

test("Windows readiness callback rejection is fatal", () => {
  const authenticationFailure = windowsGate({
    authenticatedResult: false,
  });
  authenticationFailure.gate.push(
    Buffer.from(`${authenticationFailure.hello}\n`),
  );
  assert.deepEqual(authenticationFailure.events, [
    "authenticated",
    "fatal",
  ]);

  const readyFailure = windowsGate({ readyResult: false });
  readyFailure.gate.push(
    Buffer.from(`${readyFailure.hello}\n${readyMarker}\n`),
  );
  readyFailure.gate.finish();
  assert.deepEqual(readyFailure.events, [
    "authenticated",
    "ready",
    "fatal",
  ]);
});

test("runner listens before spawn, keeps fd3 IPC, and uses stdout only off Windows", async () => {
  const source = await readFile(
    new URL("../runner.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(
    source.indexOf("await listenWindowsReadinessServer") <
      source.indexOf("child = spawn"),
  );
  expectSource(
    source,
    /agentReadyCapability: windowsReadiness\?\.capability,\s+agentReadyPipeId: windowsReadiness\?\.pipeId/u,
  );
  expectSource(
    source,
    /stdio: \["ignore", "pipe", "pipe", "ipc"\]/u,
  );
  expectSource(
    source,
    /child\.stdout\.on\("data", \(chunk\) => \{\s+if \(process\.platform !== "win32"\) readyGate\.push\(chunk\);\s+\}\)/u,
  );
  expectSource(
    source,
    /void terminateProcessTree\(\s+childPid,\s+\(\) =>\s+child\.pid === childPid &&\s+child\.exitCode === null &&\s+child\.signalCode === null,\s+\)/u,
  );
  assert.equal(source.includes("child.stdio[4]"), false);
});

test("runner commit identity binds both the exact pid and token", () => {
  const state = {
    schemaVersion: 1,
    contractVersion,
    pid: 4242,
    runnerToken: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-07-23T00:00:00.000Z",
  };
  assert.equal(
    committedState(state, state.runnerToken, state.pid),
    true,
  );
  assert.equal(
    committedState(
      state,
      "22222222-2222-4222-8222-222222222222",
      state.pid,
    ),
    false,
  );
  assert.equal(
    committedState(state, state.runnerToken, state.pid + 1),
    false,
  );
  assert.equal(
    committedState({ ...state, extra: true }, state.runnerToken, state.pid),
    false,
  );
});

test("runner rechecks ownership for every marker and terminals only in finally", async () => {
  const source = await readFile(
    new URL("../runner.mjs", import.meta.url),
    "utf8",
  );
  expectSource(
    source,
    /function safeAppendOwned\(marker, runnerToken\) \{\s+try \{\s+const state = readPrivateJson\(statePath\);\s+if \(!committedState\(state, runnerToken\)\) return false;\s+appendSafeLog\(marker\)/u,
  );
  expectSource(
    source,
    /finally \{\s+if \(committed\) \{\s+safeAppendOwned\(terminalMarker, runnerToken\);\s+\}\s+\}/u,
  );
  assert.equal(source.includes("launch_not_committed"), false);
});

function expectSource(source, pattern) {
  assert.match(source, pattern);
}
