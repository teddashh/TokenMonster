import {
  contractVersion,
  exactKeys,
  readPrivateJson,
  readSafeLog,
  readyMarker,
  statePath,
} from "./contract.mjs";
import {
  processAlive,
  processMatchesRunner,
  validProcessId,
  validRunnerToken,
} from "./process-identity.mjs";

const STATE_KEYS = [
  "contractVersion",
  "pid",
  "runnerToken",
  "schemaVersion",
  "startedAt",
];

function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString() === value
  );
}

export function parseRuntimeState(value) {
  if (
    !exactKeys(value, STATE_KEYS) ||
    value.schemaVersion !== 1 ||
    value.contractVersion !== contractVersion ||
    !validProcessId(value.pid) ||
    !validRunnerToken(value.runnerToken) ||
    !validTimestamp(value.startedAt)
  ) {
    throw new Error("agent_runtime_state_invalid");
  }
  return value;
}

function failedAfterExit(markers) {
  return markers.some(
    (marker) =>
      marker.startsWith("[TOKENMONSTER_AGENT] ERROR ") ||
      marker.startsWith("[TOKENMONSTER_AGENT] EXIT signal=") ||
      (/^\[TOKENMONSTER_AGENT\] EXIT code=/u.test(marker) &&
        marker !== "[TOKENMONSTER_AGENT] EXIT code=0"),
  );
}

export function classifyRuntime({
  state,
  markers,
  alive,
  identityVerified,
}) {
  if (state === undefined) {
    return {
      state: "not_started",
      running: false,
      identityVerified: false,
      ready: false,
    };
  }
  const common = {
    pid: state.pid,
    startedAt: state.startedAt,
  };
  if (alive && !identityVerified) {
    return {
      ...common,
      state: "foreign_process",
      running: true,
      identityVerified: false,
      ready: false,
    };
  }
  if (alive) {
    const ready = markers.includes(readyMarker);
    return {
      ...common,
      state: ready ? "ready" : "building",
      running: true,
      identityVerified: true,
      ready,
    };
  }
  return {
    ...common,
    state: failedAfterExit(markers) ? "failed" : "exited",
    running: false,
    identityVerified: false,
    ready: false,
  };
}

export function inspectRuntime(overrides = {}) {
  try {
    const stateValue =
      overrides.stateValue === undefined
        ? readPrivateJson(statePath)
        : overrides.stateValue;
    const markers =
      overrides.markers === undefined ? readSafeLog() : overrides.markers;
    if (stateValue === undefined) {
      return {
        runtime: classifyRuntime({
          state: undefined,
          markers,
          alive: false,
          identityVerified: false,
        }),
        markers,
      };
    }
    const state = parseRuntimeState(stateValue);
    const alive =
      overrides.alive === undefined
        ? processAlive(state.pid)
        : overrides.alive;
    const identityVerified =
      alive &&
      (overrides.identityVerified === undefined
        ? processMatchesRunner(state.pid, state.runnerToken)
        : overrides.identityVerified);
    return {
      runtime: classifyRuntime({
        state,
        markers,
        alive,
        identityVerified,
      }),
      markers,
      privateState: state,
    };
  } catch {
    return {
      runtime: {
        state: "invalid_state",
        running: false,
        identityVerified: false,
        ready: false,
        errorCode: "runtime_state_invalid",
      },
      markers: [],
    };
  }
}
