// TokenMonster sidecar shim — forked inside an Electron utilityProcess.
//
// Electron keeps a utility process's event loop alive even after a
// run-to-completion script finishes (a bare `console.log` script never
// exits; verified empirically on Electron 43). tokentracker-cli relies on
// natural event-loop drain to exit, so forking its bin directly makes
// `--version` and `sync` invocations hang until the parent's timeout kills
// them. Instead we call the CLI's exported `run` entrypoint — the exact
// module its pinned bin/tracker.js requires — and exit explicitly when the
// returned promise settles. `serve` never settles, which matches the
// long-lived main child the runtime expects to own and kill.
//
// argv: [electron, shim, <network-guard-path>, <tracker-bin-path>, ...cli-args]
"use strict";

const { createRequire } = require("node:module");

const DEBUG = process.env.TOKENMONSTER_SIDECAR_DEBUG === "1";
const PINNED_TRACKER_VERSION = "0.80.0";
const VERSION_VERIFIED_EXIT_CODE = 42;
const MAX_VERSION_OUTPUT_BYTES = 64;

function debug(message) {
  if (DEBUG) process.stderr.write(`[shim] ${message}\n`);
}

function flushed(stream) {
  return new Promise((resolve) => {
    // A zero-length write's callback fires only after previously queued
    // chunks reach the pipe; a bare process.exit can truncate piped stdout.
    stream.write("", () => resolve());
  });
}

function exitWhenFlushed(code) {
  Promise.all([flushed(process.stdout), flushed(process.stderr)]).then(
    () => process.exit(code),
    () => process.exit(code)
  );
}

async function runVerifiedVersion(run, cliArguments) {
  const expected = Buffer.from(`v${PINNED_TRACKER_VERSION}\n`, "utf8");
  const chunks = [];
  let observedBytes = 0;
  let invalid = false;
  const originalWrite = process.stdout.write;
  const originalExit = process.exit;

  process.stdout.write = function captureVersionWrite(
    chunk,
    encodingOrCallback,
    maybeCallback
  ) {
    const callback =
      typeof encodingOrCallback === "function"
        ? encodingOrCallback
        : maybeCallback;
    try {
      const bytes =
        typeof chunk === "string"
          ? Buffer.from(
              chunk,
              typeof encodingOrCallback === "string"
                ? encodingOrCallback
                : "utf8"
            )
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : null;
      if (
        bytes === null ||
        observedBytes + bytes.length > MAX_VERSION_OUTPUT_BYTES
      ) {
        invalid = true;
      } else {
        chunks.push(bytes);
        observedBytes += bytes.length;
      }
    } catch {
      invalid = true;
    }
    if (typeof callback === "function") process.nextTick(callback);
    return true;
  };
  process.exit = function rejectNestedExit() {
    throw new Error("sidecar-shim: version command attempted direct exit");
  };

  try {
    await run(cliArguments);
  } finally {
    process.stdout.write = originalWrite;
    process.exit = originalExit;
  }

  const output = Buffer.concat(chunks, observedBytes);
  if (invalid || !output.equals(expected)) {
    throw new Error("sidecar-shim: exact version output mismatch");
  }
  return VERSION_VERIFIED_EXIT_CODE;
}

async function main() {
  debug(`start argv=${JSON.stringify(process.argv.slice(2))}`);
  const guardPath = process.argv[2];
  if (typeof guardPath !== "string" || guardPath.length === 0) {
    throw new Error("sidecar-shim: missing network guard path");
  }
  require(guardPath);
  const entry = process.argv[3];
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error("sidecar-shim: missing tracker entry path");
  }
  // Same resolution the pinned bin/tracker.js performs (`../src/cli`),
  // anchored to the entry path the runtime already validated.
  const { run } = createRequire(entry)("../src/cli");
  if (typeof run !== "function") {
    throw new Error("sidecar-shim: tokentracker-cli did not export run()");
  }
  const cliArguments = process.argv.slice(4);
  debug("cli resolved, invoking run()");
  if (cliArguments.length === 1 && cliArguments[0] === "--version") {
    return runVerifiedVersion(run, cliArguments);
  }
  await run(cliArguments);
  return 0;
}

main().then(
  (code) => {
    debug(`run() resolved, exiting ${code}`);
    exitWhenFlushed(code);
  },
  (error) => {
    debug("run() rejected, exiting 1");
    console.error(error && error.stack ? error.stack : String(error));
    exitWhenFlushed(1);
  }
);
