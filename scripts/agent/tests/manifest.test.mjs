import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  manifest,
  readyMarker,
  rootDirectory,
  safeLifecycleMarker,
  validateManifest,
} from "../contract.mjs";
import {
  listRepositoryTextFiles,
  repositoryRelativePath,
} from "../../repository-files.mjs";

function cloneManifest() {
  return structuredClone(manifest);
}

function assertAllObjectSchemasAreClosed(value, location = "#") {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertAllObjectSchemasAreClosed(item, `${location}/${index}`),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (value.type === "object") {
    assert.equal(
      value.additionalProperties,
      false,
      `${location} must reject additional properties`,
    );
  }
  for (const [key, child] of Object.entries(value)) {
    assertAllObjectSchemasAreClosed(child, `${location}/${key}`);
  }
}

test("the checked-in agent release manifest validates", () => {
  assert.equal(validateManifest(manifest), manifest);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.contractVersion, "1.0.0");
  assert.equal(manifest.kind, "agent-ready-source-release");
  assert.equal(manifest.trust.invocation, "explicit-only");
  assert.equal(manifest.skills.implicitInvocation, false);
  assert.equal(manifest.privacy.localOnly, true);
  assert.equal(
    readyMarker,
    "[TOKENMONSTER_AGENT] READY companion",
  );
});

test("the JSON schema closes every declared object shape", () => {
  const schema = JSON.parse(
    readFileSync(join(rootDirectory, "agent-release.schema.json"), "utf8"),
  );
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual([...schema.required].sort(), Object.keys(manifest).sort());
  assertAllObjectSchemasAreClosed(schema);
});

test("repository text gates include the Windows task-tree wrapper", async () => {
  const files = (await listRepositoryTextFiles()).map(repositoryRelativePath);
  assert.equal(
    files.includes("scripts/agent/windows-task-tree.ps1"),
    true,
  );
});

test("the contract fixes the source lane and private lifecycle paths", () => {
  assert.equal(manifest.product.package, "@tokenmonster/companion");
  assert.equal(manifest.product.distributionLane, "source-development");
  assert.deepEqual(manifest.entrypoints.stop.flags, ["--json"]);
  assert.deepEqual(manifest.runtime, {
    directory: ".agent-runtime",
    stateFile: ".agent-runtime/tokenmonster-desktop.json",
    launchLock: ".agent-runtime/launch.lock",
    logFile: ".agent-runtime/tokenmonster-desktop.log",
    launchReceipt: ".agent-runtime/last-launch.json",
    auditBefore: ".agent-runtime/audit-before.json",
    auditAfter: ".agent-runtime/audit-after.json",
    readyMarker: "[TOKENMONSTER_AGENT] READY companion",
    states: [
      "not_started",
      "building",
      "ready",
      "failed",
      "exited",
      "invalid_state",
      "foreign_process",
    ],
  });
});

test("the Windows readiness connection marker is an exact safe lifecycle value", () => {
  const markers = [
    "electron_connected",
    "companion_state",
    "companion_window",
    "companion_initialized",
    "companion_shell",
    "companion_credentials",
    "companion_services",
    "companion_bootstrap",
    "companion_view",
    "companion_ready_shell",
  ];
  for (const marker of markers) {
    const value = `[TOKENMONSTER_AGENT] STATUS ${marker}`;
    assert.equal(safeLifecycleMarker(value), true);
    assert.equal(safeLifecycleMarker(`${value} extra`), false);
  }
});

const POLICY_RELAXATIONS = [
  (value) => {
    value.unreviewed = true;
  },
  (value) => {
    value.product.unreviewed = true;
  },
  (value) => {
    value.entrypoints.launch.unreviewed = true;
  },
  (value) => {
    value.runtime.stateFile = "../state.json";
  },
  (value) => {
    value.trust.invocation = "implicit";
  },
  (value) => {
    value.privacy.auditUpload = "allowed";
  },
  (value) => {
    value.permissions.deniedBySkill =
      value.permissions.deniedBySkill.filter(
        (permission) => !permission.includes("release creation"),
      );
  },
];

for (const mutate of POLICY_RELAXATIONS) {
  test("manifest validation rejects a security policy relaxation", () => {
    const relaxed = cloneManifest();
    mutate(relaxed);
    assert.throws(() => validateManifest(relaxed), /agent_manifest_invalid/u);
  });
}
