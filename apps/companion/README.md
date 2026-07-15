# TokenMonster companion

This workspace is the local Electron companion. It presents four rights-safe,
code-native letter placeholders, deterministic offline fixed lines, a
content-blind local SQLite store, 7/28-day provider/tool insights, safe local
share/export/reset controls, an explicit local Tokscale scan coordinator, and
an optional direct OpenAI BYOK chat path. It also contains an explicit,
off-by-default contribution slice: current consent plus an exact local payload
preview, accountless enrollment, background idempotent sync/manual retry, hard local
stop, and deletion/status tracking. Development resolves the exact pinned
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
cannot opt in. Stop clears the upload authority and outbox but deliberately
keeps deletion authority; because the server pause/resume routes are not part
of the deployed slice, stop cannot resume and the user must delete then
preview/re-enroll.

BYOK uses the fixed OpenAI Responses endpoint and `gpt-5.6-luna` from the main
process with `store: false`, `background: false`, redirect denial, bounded
responses, and no tools/files/conversation IDs. The key is encrypted with
Electron async `safeStorage` only when an approved OS-backed backend exists.
Linux `basic_text` and unavailable keychains stay RAM-only. Conversation
history is bounded to 12 messages in RAM and is cleared on character change,
key removal, window close, and process shutdown.

The repository can now produce an internal, unsigned, self-contained ASAR/ZIP
whose exact inventory, runtime imports, blocked assets/secrets, source-map
absence, raw Electron fuse wire, native Tokscale package-lock identity,
SHA-256/package-version/executable evidence, and final ZIP byte/mode inventory are
verified. Run
`npm run make:companion:internal` from the repository root; evidence is written
to `release-evidence/companion-package.json`.

This is not an Alpha installer. Platform signing/notarization, updater metadata,
sandbox-enabled packaged smoke, and a manual real-key network smoke remain
release gates. macOS signed mode is additionally blocked until a native release
pipeline binds post-sign nested Mach-O hashes, expected Developer ID/Team ID,
hardened runtime, notarization ticket, and mounted DMG contents. Windows
collection remains disabled until its no-egress process sandbox is audited.

On the current Linux workstation, a sandbox-enabled launch fails closed because
the packaged `chrome-sandbox` is user-owned mode `0755` and AppArmor restricts
unprivileged user namespaces. Do not use `--no-sandbox`; packaged launch smoke
must run on a correctly isolated/configured release host.
