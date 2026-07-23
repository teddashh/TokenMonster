import assert from "node:assert/strict";
import test from "node:test";

import { createAuditSnapshot } from "../audit-model.mjs";

const checks = [
  { name: "repository", ok: true, detail: "available" },
  { name: "node", ok: true, detail: "24.15.0" },
  { name: "npm", ok: true, detail: "11.12.1" },
  { name: "graphical-session", ok: true, detail: "available" },
];
const readyRuntime = {
  state: "ready",
  running: true,
  identityVerified: true,
  ready: true,
};

test("before audit allows an intentionally absent build", () => {
  const snapshot = createAuditSnapshot("before", {
    checks,
    runtime: {
      state: "not_started",
      running: false,
      identityVerified: false,
      ready: false,
    },
    artifacts: {
      dependenciesSafe: false,
      companionBuildPresent: false,
    },
    platform: "linux",
  });
  assert.equal(snapshot.ok, true);
});

test("after audit requires double-proof, build and verified readiness", () => {
  const incomplete = createAuditSnapshot("after", {
    checks,
    runtime: readyRuntime,
    artifacts: {
      dependenciesSafe: false,
      companionBuildPresent: true,
    },
    platform: "linux",
  });
  assert.equal(incomplete.ok, false);

  const building = createAuditSnapshot("after", {
    checks,
    runtime: { ...readyRuntime, state: "building", ready: false },
    artifacts: {
      dependenciesSafe: true,
      companionBuildPresent: true,
    },
    platform: "linux",
  });
  assert.equal(building.ok, false);

  const complete = createAuditSnapshot("after", {
    checks,
    runtime: readyRuntime,
    artifacts: {
      dependenciesSafe: true,
      companionBuildPresent: true,
    },
    platform: "linux",
  });
  assert.equal(complete.ok, true);
  assert.equal(JSON.stringify(complete).includes(process.cwd()), false);
});
