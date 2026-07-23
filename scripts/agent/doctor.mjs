import { fileURLToPath } from "node:url";

import { collectEnvironmentChecks } from "./environment.mjs";
import { emit, emitUsage, platformName } from "./output.mjs";

function parseArguments(args) {
  if (args.some((argument) => argument !== "--json")) return undefined;
  if (args.filter((argument) => argument === "--json").length > 1) {
    return undefined;
  }
  return { json: args.includes("--json") };
}

export function doctorResult(options = {}) {
  const checks = collectEnvironmentChecks(options);
  const ok = checks.every((check) => check.ok);
  return {
    ok,
    state: ok ? "ready" : "failed",
    platform: platformName(options.platform),
    checks,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (options === undefined) {
    process.exitCode = emitUsage("doctor");
  } else {
    try {
      const result = doctorResult();
      emit("doctor", result, options);
      process.exitCode = result.ok ? 0 : 1;
    } catch {
      emit(
        "doctor",
        { ok: false, state: "failed", errorCode: "doctor_failed" },
        options,
      );
      process.exitCode = 1;
    }
  }
}
