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

The CLI also gives the loopback gateway an explicit memory-only OpenAI BYOK
slot. A key configured through the companion stays only in this process, is
never written to disk, and is cleared when TokenMonster exits. Request history
is supplied as a bounded, stateless UI request and calls travel directly to the
fixed OpenAI endpoint with `store: false`; neither keys nor conversation text
traverse TokenMonster cloud.

The CLI now contains the permanent contribution composition: fixed cloud
origin, private local aggregate/outbox store, shared recoverable V2 runtime,
background scheduler, and the gateway/UI preview, enable, stop, delete, and
recovery controls. That composition is created only when a platform launcher
injects a reviewed `ContributionCredentialHost` whose four slots are genuinely
OS-backed. Shutdown hard-pauses scheduling, rejects new operations, drains
accepted gateway/runtime work, and closes the store last.

The pure-Node entry point implemented in this private source slice does not yet
have such a native credential provider, so its default host returns no
contribution authority. The gateway therefore reports canonical
`secure-storage-unavailable`, contribution stays off, and startup performs no
TokenMonster-cloud contribution request. This is an honest platform-integration
gap, not permission to use plaintext,
memory-only, environment-variable, or provider-key storage for contribution
credentials. The implemented control surface becomes available only after an
audited native host is explicitly composed and tested.

The package remains private during the source-slice migration. Publishing is
blocked until TokenMonster's own license and release gates are decided; users
should not yet expect the registry command to exist.

The CLI does not accept a collector executable, upstream URL, port, or storage
path. Ctrl+C/SIGTERM closes the gateway and only the child processes started by
this invocation.
