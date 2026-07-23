import { fileURLToPath } from "node:url";

import {
  auditAfterPath,
  auditBeforePath,
  writePrivateJson,
} from "./contract.mjs";
import { createAuditSnapshot } from "./audit-model.mjs";
import { emit, emitUsage } from "./output.mjs";

export function parseAuditArguments(args) {
  let json = false;
  let write = false;
  let phase = "current";
  let phaseSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json" && !json) {
      json = true;
    } else if (argument === "--write" && !write) {
      write = true;
    } else if (
      argument === "--phase" &&
      !phaseSeen &&
      index + 1 < args.length &&
      ["current", "before", "after"].includes(args[index + 1])
    ) {
      phase = args[index + 1];
      phaseSeen = true;
      index += 1;
    } else {
      return undefined;
    }
  }
  if (write && phase === "current") return undefined;
  return { json, write, phase };
}

export function audit(options) {
  const snapshot = createAuditSnapshot(options.phase);
  if (options.write) {
    writePrivateJson(
      options.phase === "before" ? auditBeforePath : auditAfterPath,
      snapshot,
    );
  }
  return { ...snapshot, written: options.write };
}

function main() {
  const options = parseAuditArguments(process.argv.slice(2));
  if (options === undefined) {
    process.exitCode = emitUsage("audit");
    return;
  }
  try {
    const result = audit(options);
    emit("audit", result, options);
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    emit(
      "audit",
      {
        ok: false,
        state: "failed",
        errorCode: "audit_failed",
      },
      options,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
