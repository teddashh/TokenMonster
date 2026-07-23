import { lstatSync } from "node:fs";
import { join } from "node:path";

import {
  contractVersion,
  rootDirectory,
} from "./contract.mjs";
import {
  dependencyPlan,
  inspectInstallTarget,
} from "./dependency-proof.mjs";
import { collectEnvironmentChecks } from "./environment.mjs";
import { platformName } from "./output.mjs";
import { inspectRuntime } from "./runtime-status.mjs";

function regularFileWithinRoot(parts) {
  try {
    let current = rootDirectory;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) return false;
      if (
        index === parts.length - 1
          ? !metadata.isFile()
          : !metadata.isDirectory()
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function dependencyArtifactState() {
  try {
    const target = inspectInstallTarget();
    if (!target.exists) return false;
    return !dependencyPlan().installRequired;
  } catch {
    return false;
  }
}

export function collectArtifactState() {
  return {
    dependenciesSafe: dependencyArtifactState(),
    companionBuildPresent: regularFileWithinRoot([
      "apps",
      "companion",
      "dist",
      "main",
      "main",
      "main.js",
    ]),
  };
}

export function createAuditSnapshot(
  phase,
  {
    createdAt = new Date().toISOString(),
    checks = collectEnvironmentChecks(),
    runtime = inspectRuntime().runtime,
    artifacts = collectArtifactState(),
    platform = process.platform,
  } = {},
) {
  if (!["current", "before", "after"].includes(phase)) {
    throw new Error("agent_audit_phase_invalid");
  }
  const runtimeSafe = !["invalid_state", "foreign_process"].includes(
    runtime.state,
  );
  const afterReady =
    phase !== "after" ||
    (artifacts.dependenciesSafe &&
      artifacts.companionBuildPresent &&
      runtime.state === "ready" &&
      runtime.running === true &&
      runtime.identityVerified === true &&
      runtime.ready === true);
  return {
    schemaVersion: 1,
    contractVersion,
    phase,
    createdAt,
    platform: platformName(platform),
    ok: checks.every((check) => check.ok) && runtimeSafe && afterReady,
    checks,
    artifacts,
    runtime: {
      state: runtime.state,
      running: runtime.running,
      identityVerified: runtime.identityVerified,
      ready: runtime.ready,
    },
  };
}
