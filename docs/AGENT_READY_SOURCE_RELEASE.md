# Agent-ready source-development launch

This contract lets an already installed and authenticated Codex or Claude Code
session start the reviewed TokenMonster Electron application directly from a
repository checkout. It is an operational source-development workflow, not a
release, installer, or replacement for the protected packaging lanes.

## User entry points

Invoke the repository skill and state the intended operation explicitly:

| Agent       | Start                                      | Status                                      | Stop                                      |
| ----------- | ------------------------------------------ | ------------------------------------------- | ----------------------------------------- |
| Codex       | `$launch-tokenmonster start`               | `$launch-tokenmonster status`               | `$launch-tokenmonster stop`               |
| Claude Code | `/launch-tokenmonster start`               | `/launch-tokenmonster status`               | `/launch-tokenmonster stop`               |
| Direct CLI  | Follow the canonical commands listed below | `node scripts/agent/status.mjs --json --lines 80` | `node scripts/agent/stop.mjs --json` |

The agent must not launch merely because it inspected this repository or found
the skill. Codex has implicit invocation disabled, and Claude Code has model
invocation disabled. A user must request start or restart explicitly.

## Product parity and limits

The source workflow runs the same TokenMonster application/runtime against its
normal local data and the checked-in approved character and voice authority.
Normal consent, local-first, secret-store, and voice-default-off behavior still
applies.

It does **not** install TokenMonster. It provides no Start-menu or desktop
shortcut, Add/Remove Programs entry, installed auto-update channel, uninstall
flow, Windows signing, notarization, or installer identity. Use a published
installer when those behaviors matter.

The source and installed applications can compete for the same local data,
managed children, loopback endpoints, and runtime ownership. If an installed
TokenMonster may be running, ask the user to close it before continuing. Never
search for or terminate an installed process by PID, port, executable name, or
process scan.

## Canonical launch workflow

Run from the repository root, and keep the sequence exact:

```sh
node scripts/agent/audit.mjs --phase before --write --json
node scripts/agent/doctor.mjs --json
node scripts/agent/launch.mjs --wait --timeout-ms 600000 --json
node scripts/agent/audit.mjs --phase after --write --json
```

1. The before audit records the reviewed pre-launch repository/runtime state.
2. Doctor checks the exact local prerequisites. A failed check is terminal:
   report it without installing or changing a host tool.
3. If either the root lockfile digest or the installed hidden-lock digest proof
   is missing or has drifted, the reviewed launcher runs repository-local
   `npm ci --no-audit --no-fund`. Electron 43 no longer downloads its native
   executable during `npm ci`, so the launcher has a separate owned
   `electron_install` task: it byte-verifies the locked Electron
   `package.json`, `install.js`, and `checksums.json`, strips mirror, proxy,
   platform, architecture, and credential overrides, then obtains only the
   official checksum-verified Electron 43.1.1 artifact when it is absent.
   Every launch then performs the scoped companion build. It never downloads
   or installs an AI CLI, global package, host runtime, or host tool.
4. Launch owns only the process trees it creates. After dependency/build work
   completes, it waits at most ten minutes and accepts only this exact
   readiness line:

   ```text
   [TOKENMONSTER_AGENT] READY companion
   ```

5. The after audit records the resulting state. Do not claim success unless the
   launch and after audit both succeed.

Every machine-readable response must use the JSON envelope
`schemaVersion: 1` and `contractVersion: "1.0.0"`. Parse stdout as JSON; do not
infer success from prose, a listening port, a process name, or an Electron
window.

For a non-mutating preview of the launch plan, a user may explicitly request:

```sh
node scripts/agent/launch.mjs --dry-run --json
```

The dry run does not replace either audit or doctor in an actual launch.

On Linux, doctor also verifies that Chromium can retain an operating-system
sandbox. It accepts a working unprivileged user namespace or an already
configured root-owned mode-4755 Electron `chrome-sandbox` helper. If neither is
available, launch stops at prerequisites. The skill must not add
`--no-sandbox`, elevate, change helper ownership/mode, install an AppArmor
profile, or weaken host security; report the fixed failed check instead.

## Runtime contract paths

All runtime records are repository-relative under `.agent-runtime/`. Never
replace these with machine-specific absolute paths in reports or documentation.

| Purpose              | Repository-relative path                         |
| -------------------- | ------------------------------------------------ |
| Runtime directory    | `.agent-runtime/`                                |
| Owned-process state  | `.agent-runtime/tokenmonster-desktop.json`       |
| Launch lock          | `.agent-runtime/launch.lock`                      |
| Bounded safe log     | `.agent-runtime/tokenmonster-desktop.log`         |
| Last-launch receipt  | `.agent-runtime/last-launch.json`                 |
| Before-audit receipt | `.agent-runtime/audit-before.json`                |
| After-audit receipt  | `.agent-runtime/audit-after.json`                 |

These files are operational evidence, not release artifacts. Do not commit,
publish, upload, or copy their contents into prompts or issue reports. Use the
bounded status command to read the reviewed safe-log projection.

## Status, audit, and stop

Status is read-only and returns the owned runtime state plus at most the
requested number of safe-log lines:

```sh
node scripts/agent/status.mjs --json --lines 80
```

An explicitly requested current-state audit uses:

```sh
node scripts/agent/audit.mjs --phase current --json
```

Stop only the child recorded as owned by this repository:

```sh
node scripts/agent/stop.mjs --json
```

If state is invalid, do not guess at ownership, delete state, or kill anything.
Report the fixed error code and leave recovery to an explicit human inspection.

For an explicit restart, stop the repository-owned source runtime first, then
run the complete canonical launch workflow.

## Security and change boundary

The agent and source-launch tools must not:

- read, print, install, update, authenticate, or modify Codex or Claude Code
  credentials, configuration, executables, caches, or session data;
- enumerate, inspect, or report arbitrary environment values, `.env` files,
  API keys, OAuth tokens, provider credentials, OS-keychain values, or signing
  material; the launcher may only project its fixed safe allowlist into owned
  child processes without reporting those values;
- install global packages, system packages, runtimes, or host tools;
- discover or terminate processes they did not create and record;
- substitute a second collector, scanner, gateway, or upstream authority;
- run package, make, signing, publishing, or release commands;
- commit, push, open a pull request, create a tag, or upload an artifact.

Repository-local exact-lock dependency work performed by the reviewed launcher
is not permission to modify the lockfile or install anything globally. On
failure, preserve the failure result, report the unmet prerequisite, and stop.

## Completion report

Report:

- the requested operation and whether it succeeded;
- the JSON contract/schema versions;
- the exact readiness marker for a successful launch;
- only repository-relative state, receipt, audit, and safe-log paths;
- the honest source-development-versus-installer distinction.

Never include raw environment values, credentials, prompt or response content,
source filenames discovered from usage data, absolute project paths, or
unbounded process output.
