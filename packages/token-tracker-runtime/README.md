# `@tokenmonster/token-tracker-runtime`

This package owns the exact-pinned TokenTracker child used by TokenMonster. It
resolves the public npm `bin` declaration for `tokentracker-cli@0.80.0`, starts
it without a shell, waits for its announced loopback URL, and stops only child
processes that it created.

The managed server is deliberately launched as:

```text
tokentracker-cli serve --no-open --no-sync
```

No explicit port or `PORT` environment variable is used. TokenTracker 0.80.0
otherwise treats an explicit port as authority to terminate an existing
listener. The runtime never discovers PIDs, attaches to an existing process,
or kills a process by port.

First-sync and detached retry behavior are disabled. A separate bounded,
single-flight local refresh uses the reviewed 0.80.0 command:

```text
tokentracker-cli sync --auto --background --all-local-sources
```

That exact mode scans local sources without entering TokenTracker's cloud
upload branch. It runs once after readiness and then every 60 seconds. All
stdout and stderr are drained privately; paths and raw upstream errors are
never returned or logged.

The caller supplies a readiness probe, normally the strict
`@tokenmonster/token-tracker-adapter`. This keeps process supervision separate
from aggregate projection while still failing startup on an incompatible
sidecar.
