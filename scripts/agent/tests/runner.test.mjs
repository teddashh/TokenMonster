import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { contractVersion, readyMarker } from "../contract.mjs";
import {
  committedState,
  ReadinessLineGate,
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
