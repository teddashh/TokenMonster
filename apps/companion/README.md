# TokenMonster companion

The default Electron entry is the small floating pet shell. It owns the
TokenTracker runtime and loopback companion gateway, embeds the gateway UI in a
sandboxed `WebContentsView`, and never opens a browser tab. Start it with
`npm start --workspace @tokenmonster/companion`. The migration-only legacy
Electron experience remains available for local maintenance with
`npm start --workspace @tokenmonster/companion -- --legacy`; it is not the
default product entry.

This workspace is the local Electron companion. It presents four rights-safe,
code-native letter placeholders, deterministic offline fixed lines, a
content-blind local SQLite store, 7/28-day provider/tool insights, safe local
share/export/reset controls, an explicit local Tokscale scan coordinator, and
an optional direct OpenAI BYOK chat path. It hosts the shared
`@tokenmonster/contribution-runtime` package's explicit, off-by-default slice:
current consent plus an exact local payload preview, accountless enrollment,
background idempotent sync/manual retry, hard local stop, and deletion/status
tracking. Product lifecycle and projection logic live in that package; this
workspace only composes Electron storage, IPC, and wake events. Development
resolves the exact pinned
package. Packaged Linux/macOS builds use only the manifest- and SHA-verified
binary below `process.resourcesPath`; a missing or modified resource fails
closed. The exact upstream Tokscale MIT notice is a hash-pinned ASAR inventory
entry and package verification fails if it is absent or changed.

The renderer loads only packaged text assets through the secure custom
`tokenmonster://app` protocol. It has process sandboxing and context isolation,
no Node integration, no renderer network permission, a deny-by-default CSP,
denied permissions/downloads/navigation/window creation, a single-instance
lock, and a small typed IPC bridge with runtime validation, concurrency limits,
and per-sender rate limits.
Every privileged handler checks that the sender is the main frame of the exact
packaged app origin.

After explicit opt-in, contribution uses a non-overlapping main-process
one-shot scheduler. It wakes after startup, system resume, enablement, and a
completed local scan, then settles onto a bounded cadence. Every tick checks
the local enabled state first, and an active contributor with no due payload
makes no network request. Only closed UTC days with all four complete-scan ledger scopes and
day-atomic complete coverage are eligible; today, partial days, hourly data,
raw events, prompts, responses, paths, logs, and credentials never enter the
payload. Accepted absolute rows are mirrored locally so later missing keys
become higher-revision zero corrections. Upload retries retain the exact body
and use `batchId` as the idempotency key. The candidate window starts at UTC
today minus 29 days, so the oldest eligible bucket is still inside the
server's 30-day identifiable boundary. Each queued snapshot expires at the
earliest included bucket's start plus 30 days.

`TOKENMONSTER_API_BASE_URL` must be an exact reviewed HTTPS origin from the
compiled production allowlist (`https://tokenmonster.app` or
`https://api.tokenmonster.app`). Missing, non-HTTPS, path-bearing, or
non-allowlisted values fail closed before enrollment. Accountless enrollment
also requires all contribution credential slots to report an OS-backed
`safeStorage` backend before any request. Upload, deletion, and deletion-status
credentials use separate encrypted files and lifecycles. Linux `basic_text`
cannot opt in. Stop clears the outbox, persists a fail-closed paused lifecycle,
and calls the fixed upload-authenticated `/v1/me/pause` route while preserving
upload and deletion authority. Resume always requires a fresh consent document,
actual payload preview, and explicit confirmation; it calls `/v1/me/resume`
with the existing upload authority and never creates a second enrollment.

BYOK uses the fixed OpenAI Responses endpoint and `gpt-5.6-luna` from the main
process with `store: false`, `background: false`, redirect denial, bounded
responses, and no tools/files/conversation IDs. The key is encrypted with
Electron async `safeStorage` only when an approved OS-backed backend exists.
Linux `basic_text` and unavailable keychains stay RAM-only. In the legacy
Electron slice, conversation history is bounded to 12 messages in main-process
RAM; the renderer sends only the current character and message over fixed IPC,
and the main-process service constructs each provider request. History is never
persisted and is cleared on character change, window suspension, or permanent
service disposal. The default pet uses the legacy-compatible
`app.getPath("userData")/secrets/openai-byok.json` path, after verifying and
hardening the `secrets` directory. A private-directory, safeStorage-policy, or
vault-load failure does not block the local pet: BYOK reports unavailable while
tracking, characters, and scripted interaction remain usable. Explicit key
removal clears the slot. In the default pet, collapsing or closing the chat
drawer aborts its request and clears renderer-memory conversation history; an
OS window close hides the pet to the tray and does not claim to clear the live
session. A legacy window close suspends BYOK, aborts requests, and clears its
main-process conversation history so macOS activation can recreate a usable
window; permanent service disposal fences further access. Shutdown aborts and
then joins active chat plus every accepted
vault worker through any late-write protective cleanup before releasing local
owners. Process exit clears remaining RAM, while an explicitly persisted
encrypted key remains available for the next launch until removed.
The default pet also tracks the raw safeStorage startup behind its bounded BYOK
result, fences retry continuations, and closes any sidecar/gateway that finishes
starting after shutdown instead of adopting it. An early quit is held until the
top-level startup hands control to the pet drain; current owners, late owners,
and raw credential work all settle before the runtime lease is released.
The main-process service accepts only exact plain vault snapshots whose return,
current status, and readable key agree. Control operations are single-flight,
bounded, and abort then join active chat before mutating. A rejected, timed-out,
or contradictory mutation latches BYOK unavailable until a new service
instance; a verified clear remains available for local cleanup but does not
revive provider work. Every send revalidates the configured status and key
before contacting the fixed provider.

The repository can now produce an internal, unsigned, self-contained ASAR/ZIP
whose exact inventory, runtime imports, blocked assets/secrets, source-map
absence, raw Electron fuse wire, native Tokscale package-lock identity,
SHA-256/package-version/executable evidence, and final ZIP byte/mode inventory are
verified. Set `TOKENMONSTER_NEXT_RELEASE_VERSION` to a new, unused strict
candidate SemVer, then pass it as `TOKENMONSTER_RELEASE_VERSION` to
`npm run make:companion:internal` from the repository root; evidence is written
to `release-evidence/companion-package.json`. The injected version is bound to
the staged package, Electron application version, and Squirrel metadata; the
source workspace version remains the non-candidate placeholder `0.1.0`.

This is not an Alpha installer. Platform signing/notarization, updater metadata,
sandbox-enabled packaged smoke, and a manual real-key network smoke remain
release gates. Native Windows signed mode now configures SHA-256-only
Authenticode plus HTTPS RFC3161 timestamping and verifies the staged PE set,
Setup.exe, and every PE inside the full Squirrel package against an exact signer
subject. Certificate paths/passwords are omitted from options and evidence.
macOS signed mode is additionally blocked until a native release
pipeline binds post-sign nested Mach-O hashes, expected Developer ID/Team ID,
hardened runtime, notarization ticket, and mounted DMG contents. Windows
collection remains disabled until its no-egress process sandbox is audited.

On the current Linux workstation, a sandbox-enabled launch fails closed because
the packaged `chrome-sandbox` is user-owned mode `0755` and AppArmor restricts
unprivileged user namespaces. Do not use `--no-sandbox`; packaged launch smoke
must run on a correctly isolated/configured release host.
