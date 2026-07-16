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
// argv: [electron, shim, <tracker-bin-path>, ...cli-args]
"use strict";

const { createRequire } = require("node:module");

const DEBUG = process.env.TOKENMONSTER_SIDECAR_DEBUG === "1";

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

async function main() {
  debug(`start argv=${JSON.stringify(process.argv.slice(2))}`);
  const entry = process.argv[2];
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error("sidecar-shim: missing tracker entry path");
  }
  // Same resolution the pinned bin/tracker.js performs (`../src/cli`),
  // anchored to the entry path the runtime already validated.
  const { run } = createRequire(entry)("../src/cli");
  if (typeof run !== "function") {
    throw new Error("sidecar-shim: tokentracker-cli did not export run()");
  }
  debug("cli resolved, invoking run()");
  await run(process.argv.slice(3));
}

main().then(
  () => {
    debug("run() resolved, exiting 0");
    exitWhenFlushed(0);
  },
  (error) => {
    debug("run() rejected, exiting 1");
    console.error(error && error.stack ? error.stack : String(error));
    exitWhenFlushed(1);
  }
);
