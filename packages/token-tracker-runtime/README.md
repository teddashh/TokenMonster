# `@tokenmonster/token-tracker-runtime`

This package owns the exact-pinned TokenTracker child used by TokenMonster. It
resolves the public npm `bin` declaration for `tokentracker-cli@0.80.0`, starts
it without a shell, waits for its announced loopback URL, and stops only child
processes that it created.

The package also exposes the user-scoped runtime lease shared by the CLI and
Electron entry points. Linux uses an abstract Unix socket, Windows uses a named
pipe, and macOS uses one deterministic `127.0.0.1` TCP listener whose handshake
is bound to the opaque scope identifier. Before deriving that identifier, the
runtime creates and verifies the private state directory and uses its native
canonical path; symlink spellings therefore converge, and Windows path casing
is folded. Root, special-file, replaced, and—where the platform exposes a
numeric UID—foreign-owned scopes fail closed. These authorities are released by
the OS after a crash. An occupied macOS port that does not return the exact
scoped protocol fails closed instead of selecting a second authority. Callers
acquire the lease before spawning the sidecar and release it only after the
gateway and managed child have stopped.

Before any child spawn, the runtime also resolves the exact zstd dependency as
the sidecar would and checks `@mongodb-js/zstd@2.0.1`'s
`build/Release/zstd.node` byte length and SHA-256 against the shipped
`zstd-native-policy.json` entry for Linux x64, macOS arm64, or Windows x64.
This check is local-only and fail-closed: a missing, substituted, source-built,
or unsupported native binding becomes the sanitized `sidecar-incompatible`
startup error. Network signature re-auditing is a separate release-owner
command and is never part of player startup.

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
