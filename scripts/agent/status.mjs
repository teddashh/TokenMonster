import { fileURLToPath } from "node:url";

import { inspectRuntime } from "./runtime-status.mjs";
import { emit, emitUsage } from "./output.mjs";

function parseArguments(args) {
  let json = false;
  let lines = 5;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json" && !json) {
      json = true;
    } else if (argument === "--lines" && index + 1 < args.length) {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 80) {
        return undefined;
      }
      lines = value;
      index += 1;
    } else {
      return undefined;
    }
  }
  return { json, lines };
}

export function statusResult(lines = 5) {
  const status = inspectRuntime();
  return {
    ok: !["invalid_state", "foreign_process"].includes(
      status.runtime.state,
    ),
    ...status.runtime,
    markers: status.markers.slice(-lines),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (options === undefined) {
    process.exitCode = emitUsage("status");
  } else {
    const result = statusResult(options.lines);
    emit("status", result, options);
    process.exitCode = result.ok ? 0 : 1;
  }
}
