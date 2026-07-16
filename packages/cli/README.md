# TokenMonster CLI

This package is the one-command composition point for the permanent sidecar
architecture. The intended public entry point is:

```sh
npx tokenmonster
```

It starts the exact-pinned TokenTracker child, creates the strict aggregate
adapter from the child's announced loopback URL, starts the TokenMonster-owned
gateway and companion UI on another loopback port, and opens the one-use
bootstrap URL. `--no-open` leaves the URL in the terminal for remote/headless
machines.

The package remains private during the source-slice migration. Publishing is
blocked until TokenMonster's own license and release gates are decided; users
should not yet expect the registry command to exist.

The CLI does not accept a collector executable, upstream URL, port, or storage
path. Ctrl+C/SIGTERM closes the gateway and only the child processes started by
this invocation.
