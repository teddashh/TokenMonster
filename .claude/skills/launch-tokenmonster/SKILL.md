---
name: launch-tokenmonster
description: Run the reviewed TokenMonster Electron source-development launch, status, or stop workflow from the checked-out repository.
disable-model-invocation: true
---

# Launch TokenMonster from source

Read
[`../../../docs/AGENT_READY_SOURCE_RELEASE.md`](../../../docs/AGENT_READY_SOURCE_RELEASE.md)
completely before running a command. Treat that document and `CLAUDE.md` as the
authority.

The requested operation is: `$ARGUMENTS`.

## Select the operation

- Start or restart only after an explicit user request. If no explicit operation
  appears in the invocation or conversation, ask whether to start, inspect
  status, or stop.
- For status or safe-log inspection, run only the documented status command.
- For stop, stop only the source runtime owned by this repository.
- If an installed TokenMonster may be running, ask the user to close it before
  starting the source runtime. Never discover or kill a process by PID, port,
  or executable name.

## Launch

Run these commands from the repository root in this order:

```sh
node scripts/agent/audit.mjs --phase before --write --json
node scripts/agent/doctor.mjs --json
node scripts/agent/launch.mjs --wait --timeout-ms 600000 --json
node scripts/agent/audit.mjs --phase after --write --json
```

Stop on any failed audit or doctor result. Do not bypass a check, install a
missing host tool, or improvise another launch path. Confirm the JSON envelope
uses `schemaVersion: 1` and `contractVersion: "1.0.0"`. Treat
`[TOKENMONSTER_AGENT] READY companion` as the only readiness marker.
The reviewed launcher may obtain the official checksum-verified Electron
43.1.1 native artifact when absent. On Linux, never bypass a failed
`electron-sandbox` check with `--no-sandbox`, elevation, permission changes, or
host policy changes.

## Status and stop

```sh
node scripts/agent/status.mjs --json --lines 80
node scripts/agent/stop.mjs --json
```

If state is invalid, do not delete it or guess at ownership. Report the fixed
error code and leave recovery to explicit human inspection. Never use this
workflow to stop an installed copy.

## Boundaries

- Do not read, print, install, update, or modify Codex or Claude Code
  credentials, configuration, executables, or session data.
- Do not read or print environment variables, `.env` files, API keys, OAuth
  tokens, provider credentials, or signing material.
- Do not install global packages or host tools.
- Do not package, make, sign, publish, release, commit, or push.
- Report only repository-relative runtime paths and the safe JSON/log fields
  documented by the contract.
- Describe the result as a source-development Electron launch. It uses the same
  application runtime, normal local data, and approved voice authority as the
  application, but it is not an installer and provides no shortcut,
  Add/Remove Programs, or installed auto-update parity.
