import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRuntime,
  inspectRuntime,
  parseRuntimeState,
} from "../runtime-status.mjs";

const state = {
  schemaVersion: 1,
  contractVersion: "1.0.0",
  pid: 4242,
  runnerToken: "12345678-1234-4234-8234-123456789abc",
  startedAt: "2026-07-23T00:00:00.000Z",
};

test("runtime state parser is exact and content-blind", () => {
  assert.deepEqual(parseRuntimeState(state), state);
  assert.throws(
    () => parseRuntimeState({ ...state, path: "/private/repo" }),
    /agent_runtime_state_invalid/u,
  );
});

test("runtime classification requires live verified ownership for ready", () => {
  assert.equal(
    classifyRuntime({
      state,
      markers: ["[TOKENMONSTER_AGENT] READY companion"],
      alive: true,
      identityVerified: true,
    }).state,
    "ready",
  );
  assert.equal(
    classifyRuntime({
      state,
      markers: [],
      alive: true,
      identityVerified: false,
    }).state,
    "foreign_process",
  );
  assert.equal(
    classifyRuntime({
      state,
      markers: ["[TOKENMONSTER_AGENT] EXIT signal=SIGTERM"],
      alive: false,
      identityVerified: false,
    }).state,
    "failed",
  );
});

test("invalid persisted state maps to one fixed public error", () => {
  assert.deepEqual(inspectRuntime({ stateValue: {}, markers: [] }), {
    runtime: {
      state: "invalid_state",
      running: false,
      identityVerified: false,
      ready: false,
      errorCode: "runtime_state_invalid",
    },
    markers: [],
  });
});
