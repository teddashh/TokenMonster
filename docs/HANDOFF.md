# Engineering handoff — recovered post-rc.11 work and remaining gates

Updated: 2026-07-20. Audience: the next implementation agent (codex) and the
integrator session that reviews, commits, and ships its work.

## 2026-07-20 reviewed Squirrel updater — first native run diagnosed

The official `electron-winstaller@5.4.4` updater is Squirrel.Windows 2.0.1 with
the upstream self-lock bug (SHA-256 `76359cd4b0349a83337b941332ad042c90351c2bb0a4628307740324c97984cc`).
The exact upstream correction is commit
`c98244936f6876b080366417301268058028a53c` over base
`eef37460aef77b2f9de8cd2237c1e55b344a6554`; its tree is
`0a1ebfa90cea6f8037907134d53562a26c6bb4c3` and the later upstream merge is
`45834cbfeae84d20ef2bed24ac863f02d0abec66`.

The repository now has a secret-free, exact-source rebuild workflow. Independent
Actions runs `29772122109` and `29773025781` each built two isolated trees and
produced the same unsigned PE: 1,840,640 bytes, SHA-256
`1673161fd4e64d1123fb828a5e5f1580cbe3c3f6b3f0893f50bb920dada473fd`.
The locked confirmation used Microsoft.NETCore.App 6.0.43 with roll-forward
disabled, dependency receipt
`fb9199730812ca5c569d0c44f8d79d910665651dba7b3fa4cf498996c17aac15`,
and merge-input receipt
`abddfa18198a408cd1b1d3983ce6afdd4eab4a1f4dcec5cbd4b2a0437104c419`.
Artifact IDs are `8473224183` and `8473574243`; their
archive digests and normalized provenance are committed in the integration
record.

Internal packaging verifies the complete 33-file
`electron-winstaller@5.4.4` vendor inventory, copies it to a disposable sibling
of the temporary application directory, replaces only `Squirrel.exe`, and
after maker execution accepts and unlinks only Squirrel's fixed-name, bounded
`Squirrel-Releasify.log` without reading it. It then verifies both the exact
overlay and untouched `node_modules` again. The full `.nupkg`
verifier requires exact-case `lib/net45/squirrel.exe` and exact reviewed bytes
for internal candidates. Signed mode deliberately fails closed before maker
execution while redistribution review remains open.

This is **not a public release candidate yet**. The merged runtime notice audit
found incomplete notices plus a material Microsoft.Web.Xdt 2.1.1 EULA question:
the EULA describes redistribution of its DLL object code but does not clearly
authorize ILRepack internalization. Separating or omitting the DLL is not a safe
drop-in fix because Squirrel self-update propagates only one updater EXE.
Microsoft.Web.Xdt 3.1.0 is an official Apache-2.0 alternative, but it changes
behavior and assembly identity and therefore needs a new rebuild/audit rather
than relabeling this binary. SharpCompress's embedded UnRAR/MS-PL notices and
the rest of the full runtime attribution bundle also remain release gates.

Integration commit `bfc8d0a` was pushed and manual run `29775692315` exposed one
precise integration issue: the maker succeeded, but upstream Squirrel writes
`Squirrel-Releasify.log` beside its executable and the post-maker 33-file check
correctly rejected the 34th entry. All other run jobs passed. The follow-up
allows only that physical, bounded, privacy-sensitive diagnostic, unlinks it
without reading or retaining it, and then repeats the strict 33-file overlay
and source-vendor verification. Rerun `platforms=skip-macos` and require the
native Windows package verifier, clean install, packaged startup, lifecycle
hook, silent uninstall, and zero-residue classification to pass. Only after
that should the legal owner choose approval of exact XDT 2.1.1 terms or a
separately reviewed 3.1.0 rebuild.
Do not tag, sign, publish npm/CDN assets, or make the GitHub Release public from
the current internal candidate.

## 2026-07-20 stable direct packaging replacement — native matrix pending

PR CI run `29731498189` passed at exact commit `ded282e`: both sidecar jobs,
both companion desktop jobs, Linux/Windows installed release smoke, Linux
loopback-only syscall evidence, the full verify job, packaging, audit, and
release evidence all completed successfully. The progression store no longer
gives a healthy multi-writer queue one shared one-second budget; each advancing
head has the same bounded stall budget while an independent five-second total
cap prevents churn from waiting forever. The final post-replacement local run
passed 1,749 tests across all workspaces with one platform-only skip, plus the
root strict typecheck, lint, format, secret scan, and diff checks.

The former signed/GA dependency blocker is now addressed by a reviewed stable
direct Electron packaging replacement. The companion uses exact
`@electron/packager 18.4.4`, `@electron/fuses 1.8.0`,
`@electron/osx-sign 1.3.3`, `@electron/windows-sign 1.2.2`, `cross-zip 4.0.1`,
`electron-installer-dmg 5.0.1`, `electron-winstaller 5.4.4`, and verifier
`@electron/asar 4.2.0`. All Forge packages and root overrides were removed;
the resulting Forge-free exact lock also contains none of `@electron/rebuild`,
`external-editor`, or `tmp`. A fresh `npm ci`, the default toolchain
verification, and `npm audit --audit-level=high` pass
with zero vulnerabilities. The `--require-upstream-compatible` public mode now
fails closed on the reviewed updater's redistribution status, as described in
the current section above.

The direct Linux package/make path has already passed the existing fail-closed
artifact verifier: 39 ASAR files, the reviewed fuse wire, exact collector, the
834-file sidecar closure, and full ZIP byte/mode inventory. Do not tag or
publish from this paragraph alone. The committed packaging replacement still
needs the native Windows Squirrel and macOS internal package/maker matrix,
followed by a fresh full CI run. Public Windows signing, npm, CDN, and GitHub
publication also require the protected credentials and environments; none are
currently configured in this repository.

The native Windows candidate job now treats Setup as the primary artifact: it
silently installs into a fresh ephemeral profile, byte-compares the complete
installed application to the exact `lib/net45/**` payload in the already
verified full `.nupkg`, reaches the packaged startup-smoke marker, and performs
a silent uninstall. The Squirrel execution stub is compared against its exact
full-package source separately and then used for the smoke, matching the real
user entry point. Before Setup runs and after uninstall completes, the job
binds physical identity, size, and SHA-256 for Setup, the full package, and
`RELEASES`; bounded process-tree cleanup prevents a hung installer from
escaping the job's deadline. A complete maker verification runs again after
the smoke and immediately before signed upload. This remains valid after
Authenticode mutates PE bytes; the signed tag job repeats the same flow.

Windows signing uses one deliberately narrow raw-byte exception: both Packager
and Squirrel must preserve the exact sidecar
`@mongodb-js/zstd/build/Release/zstd.node` because the runtime binds its reviewed
Windows size/SHA-256 before load. The serializable signing hook validates that
policy before skipping only this path; the native verifier requires exactly one
matching exemption and Authenticode on every other staged/nupkg PE.

Internal macOS packaging deliberately flips fuses only after Packager has
finished mutating the final bundle, then applies an inside-out ad-hoc signature
while preserving both manifest-bound resource roots: the pre-signed collector
files and the byte-bound sidecar closure (including its native zstd binding).
It performs a strict `codesign` verification before maker output. The native
macOS matrix must still prove that the collector and sidecar hashes remain
exact and that the packaged application actually reaches the dual-gated
startup-smoke marker.

Tag staging is also mechanically downstream of a dedicated native macOS
internal gate for the exact tag SHA. That gate retains private maker/evidence
artifacts for 30 days but publishes no macOS desktop asset.

## 2026-07-18 interrupted-batch takeover — NOT A RELEASE CANDIDATE

The earlier agent and its three active child tasks were interrupted together at
14:10:30 EDT. At takeover, this worktree was still at commit `ec2f397` with
164 modified and 115 untracked files, nothing staged, and changes continuing
for 98 files after this handoff's earlier rc.11 evidence was written. That
dirty state was preserved outside the repository before recovery; do not
discard its backups or substitute the historical rc.11 artifacts.

The rc.11 tarball and Linux ZIP described below are historical evidence for an
earlier snapshot only. Their current bytes/hashes differ from the recorded
values, so neither artifact may be promoted, published, or used as proof for
the post-candidate changes. At takeover, a fresh candidate still needed all
repository gates, a new clean-install/network trace, package verification,
Electron make, hashes, and the native release matrix. A local rc.12 candidate
was subsequently produced, but later hardening superseded it; it is historical
evidence only and must not be resumed, relabeled, or published. Native, signing,
and publication gates were never completed for it.

Recovered and revalidated at commit `b5f16f6`:

- Root TypeScript failures caused by the new contribution v2 union were fixed
  without widening the migration-only collector. That recovered snapshot
  passes typecheck across all 21 workspaces and the full root test run passes
  137 test files and 1,661/1,661 tests. These figures describe the recovered
  pre-hardening checkpoint, not the later credential-host work.
- Permanent UI reminders are wired through a narrow Electron bridge. They are
  default-off and local-only, use a migrated revision/CAS store to prevent
  cross-window overwrites, preserve unchanged pending reminders, bound
  cross-midnight catch-up, deduplicate across restart, and dispose on quit.
- The automatic-update path is now composed in the current Electron pet host
  and permanent loopback UI/control path. The Electron shell itself remains a
  retiring or optional thin host. Automatic checks use a private revision/CAS
  preference store, default off, and perform no updater network action until an
  enabled schedule fires or the player explicitly presses manual check. Fixed
  IPC/preload DTOs
  expose no renderer-controlled URL or channel; check/install are single-flight,
  updater errors are reduced to fixed codes, and `before-quit-for-update`
  enters the same sidecar/gateway/lease cleanup invariant as a normal pet quit.
  The controller also reverses Squirrel's `rc.11` to `rc11` release-name
  projection before monotonic comparison. Runtime/UI wiring and protected feed
  publication automation are complete locally, but a freshly signed public
  feed run plus native Windows install/update evidence remain release gates.
- Windows Squirrel promotion tooling now rejects any signed-job inventory other
  than exact `RELEASES`, Setup, and one version-bound full `.nupkg`; it verifies
  SHA-1/name/bytes plus SHA-256 and emits deterministic immutable and
  `latest`/`next` promotion plans. The protected executor now distinguishes
  exact missing/present/unknown current state, re-reads state around mutation,
  create-or-verifies immutable objects, commits package before no-store
  `RELEASES`, verifies every R2/CDN object, rolls metadata back on stale public
  readback, and retains old packages for client overlap. No remote mutation was
  performed in this worktree. Pinned Wrangler 4.111.0 option/version output was
  verified locally; native install/update rehearsal remains open.
- Contribution v2 cloud contracts, policy, API, and D1 storage are implemented.
  Review fixes preserve the exact v1 enrollment response, persist remote-resume
  compensation across lost responses/restart, compose deletion-status reads in
  the Cloudflare worker, and keep deletion authority usable when an independent
  upload credential is corrupt. First-enrollment response loss is now closed by
  strict `/v2/enrollments`: the native runtime persists one complete
  client-generated u2/d2/r2 bundle before requesting, exact replay verifies all
  three secrets and accepted consent, and D1 stores verifier material only.
  Crash/restart tests cover every pending-to-active write boundary. The shared
  runtime, permanent gateway/UI preview-enable-stop-delete-recover controls,
  conditional CLI composition, and shutdown/quiescence boundary now exist.
  Stop/delete hard-pause scheduling before mutation; deletion removes upload
  authority before the first cloud request; accepted deletion and ambiguous
  response loss remain recoverable. Consent drift also stops on the
  GET/ingest race where an exact ingest `403 CONSENT_REQUIRED` arrives after a
  matching consent read. The normal pure-Node entry point still injects no
  credential host, so it honestly reports unavailable/default-off and performs
  zero contribution-cloud work until an audited native OS-backed host exists.
  Whole-day zero correction remains unavailable because the exact-pinned
  sidecar cannot distinguish a complete zero day from unavailable data; never
  convert `unavailable` into zero.
- The permanent companion UI now has a complete typed zh-TW/en catalog,
  locale-aware number/date/compact formatting, Canvas share output, structured
  wardrobe/profile/progression copy, and Han-free English regressions. A strict
  content-free revision/CAS preference is stored beside progression state.
  Corrupt, linked, non-private, or noncanonical state fails closed; a storage
  failure uses one of two authenticated fixed document paths to rerender the
  entire tab in its session locale rather than leaving stale chart formatting.
- BYOK gateway, CLI RAM slot, Electron OS-backed vault composition, installed
  smoke markers, and UI exist. Client disconnects abort provider requests;
  mutations and vault operations are bounded and single-flight; active
  persistence is reported accurately; and timeout/dispose AbortSignal fences
  prevent late policy, decrypt, rotation, or write work from publishing a key
  or modifying a newer vault authority. Rotation failure clears plaintext RAM
  state while retaining the old ciphertext for a safe retry.

The permanent contribution protocol and player control surface are complete.
The remaining platform gap is an audited native OS-backed credential host for
the normal CLI; without one, contribution correctly remains unavailable,
default-off, and zero-cloud. This does not block local tracking or an honestly
scoped zero-cloud application release, but it does block claiming anonymous
contribution is usable on that host. The update surface is connected but cannot
be called production-usable until a fresh signed feed is promoted and rehearsed
on native Windows. These gaps are not reasons to weaken the local-first or
consent contracts.

## Post-rc.12 credential-host audit and fail-closed hardening

The local rc.12 artifacts below remain immutable evidence for commit `4f807a3`,
but they are no longer a current candidate after this shared runtime hardening.
Do not relabel or rebuild them in place.

The contribution runtime no longer trusts a credential host merely because its
initial snapshot says persistence is available. `activePersistence` is now a
required secret-slot status field. Initialize, set, and clear accept only exact
plain snapshots whose capability, active persistence, backend, configured bit,
`slot.status()`, and `slot.get()` agree. A missing field, a write whose own
status reports a RAM downgrade, a clear that leaves stale readable authority,
or any rejected/timed-out mutation makes secure storage unavailable until a
newly created service instance or restarted process initializes successfully.
Entry guards then block authority-expanding and data-bearing cloud work;
representative regressions cover initialization, enrollment preparation,
recovery, deletion, and quiescence. A best-effort remote pause, an already
started protective cloud deletion, and local authority removal may still run
to reduce exposure after a failure.
Snapshot checks cannot prove physical durability against a host that lies
consistently, so native provenance and real restart tests remain mandatory.

Making `SecretSlotStatus.activePersistence` required is a source-level contract
change for implementors of the private `@tokenmonster/secret-vault` package.
It does not change a persisted document, cloud contract, or loopback DTO, so it
requires implementor updates and recompilation but no data migration.

The loopback gateway and legacy Electron main-process BYOK service now apply
equivalent exact return/status/readback checks, pin the initialized host
identity, validate the key before provider use, serialize bounded control work,
and revalidate immediately before each fixed-destination provider request.
`persist: false` cannot be misreported as OS-backed, while an honest
`persist: true` RAM downgrade remains usable and is reported as memory-only.
Contradiction, rejection, or timeout latches provider work unavailable for the
service instance; verified local clear remains available without reviving it.
Gateway close additionally aborts and joins accepted initialization, late
mutation, and protective-cleanup work. In the legacy Electron slice, window
close now suspends the conversation without disposing credential authority, so
macOS activation can create another usable window. Permanent and fatal shutdown
both use the same `before-quit` drain: all local owners stop accepting work
first; active legacy collector scans, raw BYOK initialization/control/
protective-cleanup work, and contribution workers are joined; the store is
closed; and only then is the runtime lease released. Local-source reset also
joins the collector before clearing its authority. A stopped collector
authority cannot be rewritten as degraded by a late directory-check failure.
Fatal startup or window-creation errors first request the same graceful quit
and use `app.exit(1)` only as the terminal step after that ordering completes,
so the OS still receives a nonzero status without bypassing cleanup.
Legacy startup itself is fenced across lease acquisition, directory/SQLite
opens, credential initialization, collector setup, and renderer loading. Quit
stops and disposes current owners, joins the startup, captures any late-opened
owner, then quiesces before store and lease release. A genuine renderer load
failure records fatal intent before Electron synchronously emits
`window-all-closed`; a user-requested close is normalized as cancellation, and
a window destroyed by an already requested shutdown remains non-fatal.
The default pet has the equivalent early-quit handoff and retry fence: its
bounded BYOK result retains a joinable raw safeStorage worker, and a sidecar or
gateway that finishes starting after shutdown is closed rather than adopted.
Current and late pet owners plus raw credential work settle before its runtime
lease is released. The existing dual-gated CI smoke mode alone retains its
10-second forced-exit fallback after first attempting this wind-down.

No third-party native keychain package was added. The audit found no package
that can currently satisfy the complete cross-platform proof. In particular,
the reviewed `@napi-rs/keyring` 1.3.0 tag (tag object
`875e452d75c7f1f2579e25ef10a598109852fa75`, commit
`e46be75c3ba8d5fde6b88a17c6153b87ffe4b946`) [silently falls back from Linux
Secret Service to kernel keyutils](https://github.com/Brooooooklyn/keyring-node/blob/e46be75c3ba8d5fde6b88a17c6153b87ffe4b946/src/linux_credential_builder.rs)
and its [async API collapses important lookup/delete errors](https://github.com/Brooooooklyn/keyring-node/blob/e46be75c3ba8d5fde6b88a17c6153b87ffe4b946/src/async_entry.rs),
so it does not expose enough backend evidence for this boundary. General shell
or PATH-discovered command helpers are also rejected because some platforms
cannot keep secrets out of argv and their discovery/timeout behavior is
ambiguous. A future fixed-path, TokenMonster-owned macOS helper is acceptable
only if it is audited, signed/notarized, exact-pinned, and passes the same
bounded-operation and provenance gates as an in-process binding.

The implementation direction is a TokenMonster-owned, exact-pinned native
bridge behind the existing `AsyncSafeStoragePort` and encrypted vault: user-
scoped DPAPI on Windows; an audited Keychain binding or fixed signed/notarized
helper on macOS; and a Secret-Service-only Linux binding with no
keyutils, session collection, plaintext, file, environment, or runtime-download
fallback. It must add bounded read-only preflight before contribution SQLite is
opened, join native work before the runtime lease is released, use fixed opaque
service/item identifiers rather than paths, and pass real process-restart,
locked/headless, crash-boundary, canary-scan, binary inventory/hash/provenance,
and native OS/architecture tests. Until then the normal CLI remains unavailable,
default-off, and zero-cloud.

### Post-hardening clean-checkout evidence

The credential, startup, shutdown, and collector hardening is committed in
`87aa002`; the verification-only process-barrier stabilization is committed in
`082e3f3`. The latter exact snapshot
(`082e3f3789a01beed114c92b40cecfe7133d1a31`) was cloned with `--no-hardlinks`
into a new empty temporary directory and installed with `npm ci` under Node
24.15.0/npm 11.12.1. The install added 589 packages, audited 611 packages, and
reported zero vulnerabilities. Both the implementation worktree and that clean
clone passed the following gates:

- `npm run typecheck` across all 21 workspaces
- `npm test`: 140 test files and **1,727/1,727 tests**; the Electron companion
  accounts for 37 files and 265 tests
- `npm run lint`, `npm run format:check`, `npm run verify:secrets`, and
  `git diff --check`
- `npm run build`, including the Electron main/preload/renderer bundle verifier
- `npm run verify:artifacts`
- `npm run verify:packaging-toolchain`; the reviewed override set passes its
  default internal classification
- `npm audit --audit-level=high`: 0 vulnerabilities
- `npm ls --depth=0`: exit 0. A fresh npm 11.12.1 install still labels optional
  `@emnapi/runtime` and `tslib` entries extraneous, matching the earlier clean
  checkout rather than indicating reused-worktree residue
- `npm run verify:zstd-native-prebuild`: installed Linux x64 binding passes
- `npm run audit:zstd-native-prebuild`: Linux x64, macOS arm64, and Windows x64
  archives/bindings plus the pinned MongoDB signer pass

The strict
`npm run verify:packaging-toolchain -- --require-upstream-compatible` gate exits
1 as designed: signed/GA publication remains blocked until stable Forge ranges
accept the reviewed safe dependency versions. At that checkpoint no new release
version had been selected, no Electron make/package or candidate archive had
been produced, and `npm run verify:companion-package` remained a required
next-candidate gate. No tag, push, signing, publication, CDN promotion, or
public release occurred.

### Local-only `0.1.0-rc.13` candidate evidence — unsigned and unpublished

After the hardening and verification commits, `0.1.0-rc.13` was confirmed
unused across local/origin tags, GitHub releases, and the public npm registry.
Exact commit `4771bb4b1a3cedb1e67480f3a533f6bfb4372d99` was then cloned with
`--no-hardlinks` into a new empty temporary directory. A fresh `npm ci` under
Node 24.15.0/npm 11.12.1 added 589 packages, audited 611 packages, and reported
zero vulnerabilities. That exact clean checkout repeated the 21-workspace
typecheck, 140 test files and **1,727/1,727 tests** (including 37 companion
files and 265 tests), lint, format, secret scan, diff check, build, release
artifact verifier, default packaging-toolchain verifier, `npm audit`,
`npm ls --depth=0`, and the installed/all-platform zstd verification gates.

- `tokenmonster-0.1.0-rc.13.tgz`: 1,182,265 bytes, 1,027 safe entries,
  SHA-256
  `e2e619026753e76495e1acfdf44beb96316ecc8aa42f3aa8ca0557eb18c08e9d`.
  The strict version/digest/inventory verifier passed both before and after
  desktop make. `SHASUMS256.txt` is 95 bytes with SHA-256
  `7ca46e3f65c3b1577d64f37f988b029c2d0c9904135b228f9600070aeaf69f43`.
- A fresh empty-prefix install of those exact tarball bytes passed the complete
  installed smoke. It verified the 41-package registry closure and integrities,
  exact `tokentracker-cli@0.80.0`, the authenticated Linux zstd binding,
  rc.13 CLI/package identity, all 18 player artifacts, launch/status, the
  default-off contribution contract and five authenticated fail-closed
  mutations with no SQLite/vault state, RAM-only key-free BYOK, the clean
  profile, all 11 characters, starter interaction, fixed 404s, shutdown, and
  remote-helper suppression.
- A system `strace` of that same installed smoke passed the loopback-only
  verifier: 3 loopback binds, 23 loopback connects, and no external
  destination.
- `TokenMonster-linux-x64-0.1.0-rc.13.zip`: 142,512,303 bytes and 1,052 ZIP
  entries, SHA-256
  `67da01f5b33fd9249ad05b7551e8c101c2495921647428668d7ec51b254272e5`.
  Schema-v2 package evidence (9,249 bytes, SHA-256
  `bd4ffdd9ae6b1f996bbf4fa275340f6c17634c8ae99ff0b23ca683e28b59dbbf`)
  verified 39 ASAR files, one fuse wire, one maker artifact, collector 4.5.2,
  and `tokentracker-cli@0.80.0` with 834 files and 13,754,682 bytes.
- Exact-candidate packaged startup was attempted with an isolated HOME and the
  repository's double-gated smoke flags. It failed closed with exit 133 before
  application boot and emitted no `TOKENMONSTER_SMOKE_OK`: this host keeps
  `kernel.apparmor_restrict_unprivileged_userns=1`, while the staged
  `chrome-sandbox` is user-owned mode 0755. No `--no-sandbox` argument, global
  `sysctl` change, or setuid workaround was used. Repeat on an appropriately
  isolated Linux release host.
- The documented Wrangler deploy dry-run passed against the built web Worker:
  six assets, 419.66 KiB total/87.13 KiB gzip, then `--dry-run` exited without
  remote mutation. This does not replace staging bindings or cloud rehearsal.
- The strict upstream-compatible packaging verifier still exited 1 exactly as
  designed. As of 2026-07-20, stable Forge 7.11.2 still requires rebuild
  `^3.7.0`, and external-editor 3.1.0 still requires tmp `^0.0.33`; the reviewed
  safe pins remain outside those ranges. Forge 8 remains prerelease-only.

The immutable local bytes and machine evidence are preserved under the ignored
`dist-release/0.1.0-rc.13` directory. They were not tagged, pushed, signed,
published to npm/GitHub/CDN, or promoted to a public feed. This is a Linux
unsigned internal candidate only; native Windows/macOS, signing/notarization,
protected feed, credentialed staging, and legal approval remain open gates.

The first pushed PR CI run for that snapshot (`29729787069`) then exposed two
release-proof portability defects. Windows companion tests passed Linux as the
vault's simulated platform and asserted POSIX mode bits on NTFS; production
already passes the native platform. The Ubuntu installed-smoke trace contained
a valid `strace -f` socket call split across `<unfinished ...>` and `resumed`
lines, which the strict parser had not modeled. Follow-up commit
`2fd40a88f5a2dc7bbe11e4f76eec8638ce1b0a84` binds those tests to native
semantics, accepts only fully inspectable safe unfinished socket arguments,
and adds a tag-only exact-version packaged Linux boot gate. The existing
non-tag packaged smoke now also requires both exit zero and an exact success
marker instead of discarding the process status.

Focused regressions, format/lint/secret scans, all 21 workspace typechecks,
the full **1,731-test** root run, build, artifact, default packaging-toolchain,
npm audit, and dependency-tree checks pass locally. A real 8-child strace
fixture produced 1,048 unfinished socket lines and still verified exactly two
loopback listeners, 1,280 loopback connections, and no external destination.
Because that correction follows the candidate source commit, the local rc.13
bytes above are now **superseded evidence only**. Do not tag or publish them;
build fresh rc.13 bytes from the reviewed post-fix commit after CI is green.

## Continuation verification status — 2026-07-20

By the final recovery pass, the interrupted tree contained 183 modified and two
deleted tracked files plus 168 untracked files. It was preserved outside the
repository as a mode-0600 binary patch plus an archive containing every
untracked file, then split into scoped local commits without using
`git add -A`. Two test harness defects found during recovery were also fixed
without changing production code: the progression child-start barrier now
allows cold imports and awaits child teardown, while the asset-pack concurrency
test follows the actual mutex winner instead of assuming invocation order.

The resulting source tree passed these root gates. The same committed snapshot
(`b5f16f6`) was then cloned into an empty temporary directory and installed with
`npm ci` under Node 24.15.0/npm 11.12.1; that clean checkout repeated every gate
listed below. The install added 589 packages, audited 611 packages, and reported
zero vulnerabilities.

- `npm run typecheck` across all 21 workspaces
- `npm test`: 137 test files and **1,661/1,661 tests**
- `npm run lint`
- `npm run format:check`
- `npm run verify:secrets`
- `git diff --check`
- `npm run build`, including the Electron main/preload/renderer bundle verifier
- `npm run verify:artifacts`
- `npm run verify:packaging-toolchain` (the exact reviewed override set passes;
  the external dev-tool range exception remains a signed/GA gate, not an
  application/runtime defect)
- `npm audit --audit-level=high`: 0 vulnerabilities
- `npm ls --depth=0` exited successfully. npm 11.12.1 labels optional
  `@emnapi/runtime` and `tslib` entries as extraneous immediately after a fresh
  `npm ci`, so this is reproducible optional/platform lockfile behavior rather
  than reused-worktree residue; the successful clean-checkout install and
  repeated gates are the clean-install evidence
- `npm run verify:zstd-native-prebuild`
- `npm run audit:zstd-native-prebuild`: Linux x64, macOS arm64, and Windows x64
  archives/bindings plus the pinned MongoDB signer all pass

At that checkpoint, a fresh **local-only** `0.1.0-rc.12` candidate was built
from exact clean commit `4f807a3` (whose only change after the fully tested
`b5f16f6` snapshot is this handoff evidence). It was not tagged, pushed,
signed, published, or a public release. Subsequent credential-host hardening
superseded it, so the following bytes are historical immutable evidence only
and must not be promoted or relabeled. The old rc.11 artifacts also remain
superseded and must never be reused.

- `tokenmonster-0.1.0-rc.12.tgz`: 1,179,164 bytes, 1,027 portable entries,
  SHA-256
  `ca88682da77336d3d63a7e5258d6153271fa6d249746b26739b8bcd924e19dda`.
  The strict digest/inventory verifier passed before and after desktop make.
- An empty-prefix install of that exact tarball passed the complete installed
  smoke: the 41-package sidecar closure and Linux zstd prebuild matched their
  lock/integrity records; CLI/package version was rc.12; 18 player artifacts,
  bootstrap/status, default-off contribution, five fail-closed contribution
  mutations with no SQLite/vault state, RAM-only key-free BYOK, the clean
  profile, all 11 characters, starter persistence/tap, asset 404s, shutdown,
  and remote-helper suppression all passed.
- A system `strace` of the same installed smoke passed the loopback-only
  verifier: 3 loopback binds, 23 loopback connects, and no external
  destination.
- `TokenMonster-linux-x64-0.1.0-rc.12.zip`: 142,505,021 bytes, 1,052 ZIP
  entries, SHA-256
  `9c66f544968c11a71eb4375d93ec10510f4614edd647392e60e5f70c69c49a4a`.
  Schema-v2 package evidence verified 39 ASAR files, one fuse wire, one maker
  artifact, collector 4.5.2, and `tokentracker-cli@0.80.0` with 834 files and
  13,754,682 bytes. The candidate bytes and machine evidence are preserved in
  a mode-0700 repository-external local evidence directory; individual files
  are mode 0600 and are not committed.
- Sandboxed packaged startup did **not** pass on this workstation. It failed
  closed before application boot because AppArmor restricts unprivileged user
  namespaces and the unpacked Electron `chrome-sandbox` is user-owned mode
  0755 rather than root-owned mode 4755. No `--no-sandbox` flag or global
  `sysctl` workaround was used. Repeat this gate on the correctly isolated CI
  or release host.

At creation time, the same immutable CLI tarball still lacked macOS and Windows
installed smoke. Do not complete or promote that obsolete candidate now. The
next versioned candidate must be built from the post-hardening commit and repeat
clean install, artifact, sandbox-enabled packaged boot, signed Squirrel, public
feed readback, and the native release matrix. The feed verifier/planner/executor
has deterministic local coverage, including response-loss recovery and
rollback, but no credentialed R2/CDN run occurred.

## Shipped baseline

- **v0.1.0-rc.7** is released (tag target `f6ff493` on
  `agent/permanent-sidecar-companion`; supersedes rc.6). Tag run green on the
  full 3-OS matrix with all 7 assets, including the first real-Windows pass of
  the Squirrel `.nupkg` sidecar byte-verification step.
- rc.7 contains: the W8 UX wave (floating pet shell defaults to bottom-right
  pinned, idle animation, character-hero layout with usage stats collapsed
  below, locked roster hidden behind a count, unlock-toast coalescing), W8-F
  on-device quota estimation v1, and the W7 packaging hardening (lockfile-
  anchored sidecar verification, Squirrel `Update.exe` env allowlist).
- PR #1 stays open and must **not** be merged. The repository stays private.
- Branch flow: work lands on `fable/integration` locally and is pushed with
  `git push origin fable/integration:agent/permanent-sidecar-companion`.
  Never force-push, never rewrite history, never `git add -A`.

## Previously verified rc.11 baseline — superseded by later dirty changes

The items below describe the player-facing snapshot that was verified before
the interrupted post-candidate batch. They remain useful implementation
context, but no longer constitute current release evidence. At that checkpoint
the work was local and uncommitted; do not describe rc.11 as public until a
fresh candidate is deliberately reviewed, committed, and green on the native
release matrix.

- Clean installs begin with no forced character. The player can choose any of
  the four starter sisters; selection, unlock, restart persistence, concurrent
  requests, and fixed-clock ordering all share one deterministic authority.
  The compact Electron pet now turns into a focused 2×2 starter sheet until
  that choice is complete, so a clean install never asks the player to choose
  while hiding every choice behind the full-dashboard icon.
- The collection now has 11 character interactions, a 1.6-second tap cooldown,
  a 48-interaction daily cap, persisted local state, and bilingual scripted
  fallback lines. Letter-mode characters have 20 code-native wardrobe themes
  and visible collection/unlock feedback without waiting for binary art.
- A strict local 28-day 「今日默契」 profile derives explainable traits from
  aggregate usage only. It ignores the incomplete current UTC day, changes at
  most one trait per full day, survives short evidence gaps, and returns to
  learning only after the bounded retention window.
- The companion creates a real 1200×630 PNG share card locally, optionally
  hides the total, and saves through a narrow Electron preload/IPC bridge. The
  browser fallback reports only that a download started. Share generation
  rechecks the selected character, wardrobe, profile, usage snapshot, and
  mutation revision before exporting.
- UI mutations are single-flight and revision-gated: stale reads cannot undo a
  newer selection, tap requests cannot overlap, profile freshness is bounded,
  and visibility/offline/midnight transitions cannot leave a false-current
  profile on screen. The actual production UI bundle was visually exercised
  before and after first selection; the four-choice onboarding and resulting
  1/11 collection state rendered correctly.
- Quota plan writes now show saving/saved/retry feedback, usage refreshes update
  the panel, and a failed background refresh keeps the last estimate while
  explicitly labelling it 「暫時未更新」. Asset-pack response recovery likewise
  refuses to call an unchanged pre-mutation GET a successful enable/revoke/
  cleanup action.
- The process-wide runtime lease uses one OS authority per canonical state
  directory, including crash-safe macOS loopback ownership. Fixed-pack install
  and startup residue recovery serialize on the canonical cache root; recovery
  is zero-network and removes only strict TokenMonster markers.
- Public release transitions are monotonic and rerun-safe: one non-cancelling
  tag lane guards npm `latest`/`next`, immutable R2 bytes, the Worker release
  binding, and final GitHub metadata. Older versions and same-version byte
  drift fail instead of overwriting a public channel.

## Execution constraints every task inherits

- Some codex runners cannot commit inside git worktrees (the parent
  `.git/worktrees/<name>` is read-only), bind loopback ports (`listen EPERM`),
  or download Electron. Leave changes uncommitted when those limits apply; the
  integrator reviews the diff, commits, runs loopback-dependent tests, and —
  for any packaging/verifier change — runs a real
  `npm run make:companion:internal` plus
  `npm run verify:companion-package` before push. The 2026-07-18 runner was
  unrestricted: gateway tests, installed smoke, network trace, real Electron
  context-bridge verification, and Linux forge make all ran. Do not assume the
  next runner has that profile, and do not discard this evidence merely because
  a later sandbox cannot reproduce it.
- Local gate parity before any push:
  `npm run typecheck && npm run lint && npm run format:check && npm test`,
  each as a bare command (piping through `grep` masks exit codes).
  `typecheck` is the **only** gate that type-checks test files — vitest
  strips types and package builds compile `src/` only.
- CI: pull-request runs default to skipping macOS (10× billing); the full
  matrix runs on tags, `main`, or a `workflow_dispatch` with
  `platforms=all`. Treat the first CI run of new code as a real review gate.
- Gateway contract rule (historically codex's blind spot): the router in
  `packages/companion-gateway/src/gateway.ts` (`parseFixedTarget`) is
  fail-closed — it rejects every query string except the two usage APIs and
  exactly `?view=pet` on `/`, and DTO parsers on both sides use exact-key
  validation. Any new URL path, query param, or DTO field must, in the same
  branch: update the router allowlist + rejection tests, update the gateway
  serializer and the UI parser in `packages/companion-ui/src/public/dto.ts`,
  and extend the key-order test in `packages/companion-gateway/test/
  gateway.test.ts`. The one-shot bootstrap URL stays query-free; layout
  selectors ride a second navigation (see `apps/companion/src/main/pet/pet.ts`).
- Privacy boundary: everything in `AGENTS.md` applies. Additionally: status
  DTOs never expose raw upstream error text, and quota estimation must stay
  entirely on-device and labeled 「估算」 — never fabricate provider-side
  numbers or call provider quota endpoints (none exist).
- Assets/secrets: the tachie asset bank (`~/voice-lab/video-mvp/tachie`) is
  READ-ONLY. R2/SES/OpenAI credentials exist only at `oracle1:~/secrets/
  r2.env` (mode 600); variable names may appear in code, values never leave
  that host. Never commit rasters, audio, or other binaries to this repo.

## P1 — GLM asset onboarding (W8-E) — APPROVAL REPORTED; EVIDENCE TRANSCRIPTION PENDING

GLM is already the eleventh roster character. It appears in the locked count,
uses the built-in letter visual when no approved art exists, and unlocks at a
cross-family `lifetime-total` milestone of 5,000,000 local tokens. It is a
friend, so it intentionally does not belong in `catalog.ts`,
`starter-selection.ts`, or `fixed-lines.ts`; those files cover only the four
starter sisters.

The source art is now located and verified. The avatar is the tracked
`web/public/avatars/glm.png` at AI-Sister commit
`77b317b95b6047f1de330d5d41e4edab38de3b44`; the read-only tachie bank supplies
20 normalized outfits and three poses for every outfit. The controlled build
contains exactly 81 unique images (one avatar + 20 outfits + 60 poses), no
voice, and 5,238,148 bytes of content-addressed WebP output. All 81 staged
hashes match their source, and visual review found a consistent GLM identity
and transparent output.

AI-Sister's README at that exact source commit says **personal use only**. That
notice is evidence that upload/access alone is not a commercial or
redistribution grant; it reinforces, rather than replaces, the explicit owner
approval requirement below.

Rechecked after the owner's 2026-07-18 update: AI-Sister is clean at
`46be94ec708c3a01676a599da527d3852b9a40ca`. The three commits after the pinned
GLM source change only the reels review/outbox flow; they do not change the GLM
asset set, README license notice, or rights evidence. Keep the content
provenance pinned to the exact GLM source commit above rather than advancing it
to an unrelated repository HEAD.

The mandatory prompt-free evidence chain is also complete: 81 public evidence
rows, 161 upstream generation/normalization steps, and 101 owner-private raw
receipts. Every output was rebuilt through the controlled ffmpeg invocation
and compared byte-for-byte; provenance rejects renamed junk, stale manifests,
partial sets, mutable encoder drift, broken receipt chains, symlinks, escapes,
and source/output hash drift. Public evidence contains no prompt, local path,
filesystem URI, or HTTP URL. The canonical build-provenance SHA-256 is
`884a7841d04876f5dc2d6c1035dabfc264f4bb42ae5d2f5970c8293a8fbd5eb7`.

The self-contained owner workspace is persisted outside the repository at
`~/voice-lab/video-mvp/tokenmonster-release-work/glm-2026-07-18` (root and
directories mode 700, files mode 600, 271 files, no symlinks). It contains the
exact writable staging tree, 101 private receipts, 81 WebPs, manifest/report,
source evidence, receipted provenance, reproducible evidence builder, and the
pending rights ledger. The read-only source bank was not modified.

The product acquisition path is no longer dormant. The current worktree has a
strict v2 authority + descriptor + allowlist join, one complete fixed-pack
request, persisted local consent, cache verification, and player-facing
enable/repair/revoke UI. Art activates only after a complete verified cache;
partial/failed installs remain letter mode, startup never retries the network,
and revoke switches back in the same session and removes only this release's
exact objects. CLI and Electron use this same path. Mobile layout and
same-session letter → doll → letter transitions are tested. The embedded
authority, descriptor, and allowlist remain `null`, so the current build still
performs zero asset requests and cannot ship unapproved art.

The current user reports that GLM approval already exists, so the approval
decision is no longer treated as a product blocker. Evidence transcription is
still incomplete: the owner-private workspace contains no grant receipt, and
its pinned ledger still has 81 pending rows, all scopes false, no review
reference IDs, and no approval time. This prevents only assembly/publication of
the optional GLM art pack. It does **not** block a TokenMonster application
release: the embedded authority remains `null`, GLM stays in code-native letter
mode, and the release performs zero GLM asset requests.

Do not invent reference IDs or silently broaden the reported approval. Before
the optional art pack is assembled, transcribe the existing approval into the
exact public/commercial/modify/redistribute, brand/content/disclosure,
general-audience, transform, bilingual-alt-text, and timestamp fields required
by the owner-review template. The assembler was run against the current
pending ledger and correctly left no `asset-release-manifest-v2.json`.

Resolved signal decision: the exact-pinned `tokentracker-cli@0.80.0` does have
a ZCode/Z.ai collector and reports its rows as exact source `zcode`. That source
is not an exact GLM attestation: ZCode intentionally retains non-OpenAI,
non-Anthropic, non-Google custom-provider turns in the same bucket. The adapter
therefore keeps `zcode` and unsupported raw `glm` IDs in `other`; it never
infers family from model names. The existing lifetime-total character unlock
remains correct. Do not map `zcode` to GLM. If a future exact pin adds a pure
GLM source, add the mapping and compatibility tests in that same update.

Minimum completion sequence to receipt and publish the existing approval:

1. Record the owner's exact statement in an owner-private grant receipt and
   fill the already-pinned pending ledger with the grant/review reference IDs,
   all four image scopes, general content rating, non-official disclosure,
   allowed transforms, bilingual alt text, release approval, and timestamp.
   Do not alter any source/output snapshot.
2. Run `assemble-release.mjs` with the persisted integrity manifest, receipted
   provenance, and approved ledger. Require exactly 81 approved image rows and
   zero voice rows. Then run `build-fixed-pack.mjs`; require two independent
   builds to be byte-identical and production `installFixedAssetPack` to accept
   the result.
3. Publish only the generated manifest and immutable ZIP/descriptor to the
   source-map's versioned R2 paths from `oracle1`; never publish staging,
   prompts, private receipts, or the rights ledger. Embed the exact v2 authority,
   descriptor, and HTTPS allowlist through the generated release slots—never
   hand-author hashes or an alternate URL.
4. Rebuild and run the installed packet trace. It must show exactly one fixed
   asset request independent of local character, unlock, wardrobe, pose,
   interaction, or usage state; default/revoked/offline runs must show zero.
   Exercise enable, restart, repair, and revoke in the real installed UI.

**Acceptance:** the existing letter fallback remains usable offline and on a
clean install with zero asset egress; approved GLM art (and optional separately
approved voice) renders only from verified cache until the consented fixed-pack
flow passes privacy review; public assets carry schema-v2 rights evidence; and
all prior character unlocks remain unchanged.

## P2 — Quota estimation v2: real rolling windows — OPTIONAL UPSTREAM CAPABILITY

**Current v1 (shipped in rc.7):** the estimator only has UTC-day buckets, so
every plan honestly reports `windowKind: "utc-day"`, `windowHours: 24`, and
rolling budgets (Claude 5 h, ChatGPT 5 h, SuperGrok 2 h) are linearly
day-scaled via `dailyEquivalentBudget` in
`packages/companion-gateway/src/quota-estimator.ts`. The UI parser in
`packages/companion-ui/src/public/dto.ts` **pins** `windowHours === 24` /
`windowKind === "utc-day"` — that pin is deliberate and must be relaxed in
lockstep with the server or the panel breaks loudly.

Investigation completed against the installed, integrity-locked 0.80.0 npm
artifact and rechecked against the exact 0.81.1 through 0.81.3 artifacts on
2026-07-18. It was re-audited against the newly published exact 0.82.1 registry
artifact on 2026-07-19 at integrity
`sha512-6mupPBHEDskwVsnfLznn8Jvr8st5020wfK6EJ8xUkMuEb13dmQLXBkU6DYZKLCXVUCisJ4PQqw3WK63/EjHy9Q==`:

- `/functions/tokentracker-usage-hourly` exists, but returns only one requested
  calendar day of hourly buckets combined across every source. Its default day
  key comes from UTC, while bucketing honors optional `tz` / `tz_offset_minutes`
  and otherwise uses host-local time. Buckets contain no source/provider field.
- The hourly handler ignores a `source` query parameter. Its `models` map is
  already merged across sources, and model-name inference is forbidden.
- The route also collapses the underlying source-keyed 30-minute data to
  source-less whole-hour labels, so it cannot represent an exact arbitrary
  2 h/5 h boundary.
- `/functions/tokentracker-usage-limits` is not a safe substitute. A single
  unscoped read discovers credentials for many providers, can refresh and
  persist provider OAuth tokens, calls multiple third-party quota endpoints,
  and returns plan/error metadata. It has no exact-source, no-network aggregate
  mode. TokenMonster must not silently trigger that credential/network surface
  from its aggregate-only adapter.
- 0.81.1 through 0.82.1 have the same relevant public contract, so an exact-pin
  bump alone does not unblock it. 0.82.1 still labels the route a day-view stub.
  Its private collector state does retain source-keyed 30-minute buckets, which
  proves the upstream change can be a narrow content-blind projection rather
  than a new collector, but TokenMonster must not read that private state.

Keep v1 and the UI's strict 24 h/`utc-day` pin unchanged. The upstream unblock
contract is a local-only UTC route with an attested exact source plus canonical
bucket start, ideally accepting ISO-instant `from`/`to` and returning 30-minute
or finer content-blind token totals. It must omit model, cost, conversation,
identity, and content fields. After an upstream release: exact-pin it, add a
strict adapter projection, prove hourly data never reaches cloud contribution,
then update estimator + UI parser + key-order/boundary/fallback tests together.

## P3 — Quota panel refresh on usage updates — COMPLETE IN LOCAL RC.11

`packages/companion-ui/src/public/main.ts` now refreshes the quota panel on
every successfully rendered usage snapshot. Tests cover changed percentages,
preserve the last good panel on a transient background failure, abort stale
reads, and serialize plan mutation against usage-driven refreshes so an older
operation cannot overwrite newer state. No gateway surface changed.

## P4 — Catalog drift guards — COMPLETE IN LOCAL RC.11

`packages/companion-gateway/test/quota-catalog-drift.test.ts` imports the
server catalog and UI options directly and asserts exact ordered
family-to-plan-ID/label equality. The companion catalog guard likewise pins
the exact ordered asset IDs, gateway roster IDs, UI IDs, progression themes,
and UI themes. No production dependency, DTO, or route was added.

## Historical rc.11 verification evidence — superseded by takeover changes

The earlier rc.11 snapshot passed the following gates after its
player-onboarding, asset-settlement, runtime-race, publication, and Electron
ESM packaging fixes. This evidence does not apply to the current dirty bytes;
the current takeover verification is recorded above.

- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm run verify:secrets`
- `npm test`: **1,370 tests across all 20 workspaces** — contracts 62, usage 23,
  api-domain 30, api-cloudflare 21, cloud-d1 99, api 59, BYOK 49, engine 50,
  characters 183, collector-tokscale 49, local-store 39, collector-core 14,
  adapter 67, gateway 75, companion UI 188, secret-vault 27, runtime 95,
  Electron companion 180, web 39, and CLI 21.
- `npm run build`
- `npm run verify:artifacts`
- `npm run verify:packaging-toolchain`
- `npm run verify:zstd-native-prebuild`
- `npm run audit:zstd-native-prebuild` for Linux x64, macOS arm64, and Windows
  x64, including the pinned MongoDB signer fingerprint.

The CLI candidate is
`dist-release/rc.11/tokenmonster-0.1.0-rc.11.tgz` (1,039,365 bytes, 928 safe
entries, SHA-256
`38f1a2756b1e827ca28c06fe5d35fc8eff1645bfbe3a4afb5075547fc838b4dc`).
A fresh isolated install passed the release smoke: exact 41-package sidecar
closure, CLI/manifest version `0.1.0-rc.11`, current compiled player artifacts,
bootstrap/status, exact clean-learning profile DTO, 11-character no-forced-
starter roster, stale zero-byte crash-lock recovery,
starter choice/persistence/tap loop, fail-closed asset routes, shutdown, and
remote-helper suppression. A system `strace` of that same smoke
recorded 3 loopback binds and 12 loopback connects with no external destination.

The real Electron 43 renderer test passed the sandboxed
`Uint8Array -> contextBridge -> ipcMain` PNG path. A full
`TOKENMONSTER_RELEASE_VERSION=0.1.0-rc.11 npm run make:companion:internal`
then passed dependency-closure build, Forge package/make, ASAR inventory, fuse,
collector, and sidecar verification. Its Linux ZIP is
`apps/companion/out/make/zip/linux/x64/TokenMonster-linux-x64-0.1.0-rc.11.zip`
(142,425,601 bytes, SHA-256
`95814beac59cf16ac6363cebdc8163eaea556db4fba5a2847e2d35d6ccf88648`):
910 files, 1,052 ZIP entries, 33 ASAR inventory files, collector 4.5.2, and
`tokentracker-cli@0.80.0` with 834 files. Machine-readable evidence is in
`release-evidence/companion-package.json`.

The Electron build originally exposed a real packaged-only failure: bundled
`yauzl` received Vite browser stubs for Node builtins, and merely externalizing
those builtins still left native ESM without `require`. The main bundle now
binds `createRequire(import.meta.url)`, and the normal build/test verifier
dynamically evaluates the exact production ESM bundle through every eager
CommonJS factory after removing only the Electron display import and final app
entry call. Browser stubs, a missing bridge, or an eager factory crash fail the
gate before packaging.

The final real packaged UI pass exposed another release-only player blocker:
an old zero-byte `progression-v1.json.lock` let roster reads fall back safely
but permanently returned `400 invalid-request` for the first starter choice
and also blocked wardrobe/interaction writes. The store now recovers only a
stale malformed legacy lock whose filesystem identity, timestamps, size, and
bytes remain unchanged; fresh malformed locks stay busy. Current contenders
publish complete UUID choosing/ticket records into a private Lamport bakery
queue, and only the deterministic winner may touch the fixed compatibility
interlock. Valid records are removed immediately only when their PID is
definitely dead; a live/EPERM/reused PID remains busy even past the TTL. The v2
fixed record is deliberately opaque to rc.7, while v2 never steals a valid bare
JSON rc.7 record; this prevents cross-version stale cleaners from deleting one
another's replacement. Six rounds of ten synchronized real Node processes
preserved all unique updates while migrating a stale zero-byte lock. The actual
stale 2026-07-16 lock self-recovered on startup, and the installed smoke
deliberately seeds the same failure before running starter choice, persistence,
and tap.

For that rc.11 snapshot, earlier multi-model review rounds found and closed
stale-read/profile races, trait-transition compaction, release-smoke gaps,
preload chunking, sender hash handling, marker/symlink/stale-dist bypasses, and
stale doll fallback. Later interrupted-batch reviews found additional issues in
newer contribution, reminder, update, and BYOK work; those fixes and their
current verification are recorded in the takeover section above. The last Grok
4.5 attempt failed inside its terminal-tool configuration before producing a
review, so it is not counted as agreement. Agy 1.1.4 required a fresh login and
Fable 5 was blocked by the account USD budget; neither is review evidence.

## Optional non-gating follow-ups

**GLM art-pack evidence capture:** the user reports approval is already
granted. This is not an application-release gate. Locate/reference the existing
owner-private statement and transcribe every scope/review/presentation field
described in P1 only before assembling or publishing the optional pack. GLM
voice remains optional; the code-native letter fallback is release-safe.

**Real 2 h/5 h quota windows:** this is not an application-release gate. The
current strict 24 h UTC-day estimator is honest and release-safe. Keep it until
TokenTracker exposes the exact-source, content-blind, no-credential/no-network
aggregate route described in P2; never infer a rolling window from daily or
source-merged hourly data.

## Actual release gates and product gaps — exact minimum handoff

- **Native contribution credential host:** recoverable v2, the shared runtime,
  gateway/UI preview-enable-stop-delete-recover controls, and conditional CLI
  composition are complete, including exact mutation-postcondition checks
  against dishonest or downgraded hosts. The normal pure-Node CLI still needs
  the audited, exact-pinned platform bridge and native matrix described above.
  Keep contribution unavailable, default-off, and zero-cloud until that
  authority exists; never fall back to plaintext, memory-only, keyutils/session
  storage, environment-variable, general shell/PATH helper, or provider-key
  persistence.
- **Cloud staging and privacy rehearsal:** create the isolated staging Worker,
  D1 database, domain bindings, and protected secrets only in the approved
  environment. Then run the real Wrangler migration and staging E2E, exercise
  backup/restore with deletion-suppression replay, monitoring and incident
  recovery, cloud-off packet capture, sleep/wake soak, and sandboxed packaged
  E2E. These are operational release proofs, not unresolved application logic;
  production mutation remains disabled until the evidence is reviewed.
- **BYOK provider rehearsal:** on an approved release host, exercise
  configure/status/chat/clear with a dedicated safe provider key and benign
  prompt, verify the fixed provider destination and `store: false` request,
  and prove the key and conversation never enter logs, disk state, or
  TokenMonster cloud. This operational proof remains outstanding.
- **Native Windows rc.13 candidate:** the local rc.13 CLI tarball and unsigned
  Linux ZIP do not satisfy this gate. Build and verify the exact approved
  release identity on the Windows release host only after the signed/GA
  dependency gate and protected release scope are approved. Install it as a
  clean user, choose
  each starter across repeated runs, restart to verify selection/unlocks, tap a
  character, save the real PNG,
  exercise the refreshed quota panel, and run the existing Squirrel `.nupkg`
  sidecar byte-verification. Also exercise the Windows locale-store branch,
  where lstat/open-handle identity checks replace POSIX `O_NOFOLLOW`. Neither
  retesting rc.7 nor finishing the obsolete rc.12 bytes is sufficient for this
  worktree. Linux cross-packaging is not a substitute: this host has no
  Wine/Mono toolchain, and the collector
  packaging hook deliberately rejects a target platform that differs from the
  native host so it can execute and verify the exact platform binary.
- **Windows Squirrel feed execution:** verifier, monotonic plan, authoritative
  current-state retrieval, credential-scoped ordered mutation, cache policy,
  rollback, and exact R2/public readback are wired locally. Run them only with
  a freshly versioned signed tag in the protected single-writer environment;
  preserve the emitted evidence and complete native install/update rehearsal
  before treating the connected updater surface as production-usable. A local
  post-hardening rc.13 CLI tarball and unsigned Linux ZIP now exist, but no
  signed Windows Squirrel artifact was built or published.
- **Stable direct packaging native proof:** the Forge semver blocker is removed
  in the Forge-free exact lock described above. The default internal toolchain
  gate passes, while the strict public gate now deliberately fails closed on
  the reviewed updater's unresolved redistribution status. Linux direct
  package/ZIP evidence passes. Keep signed/GA publication fail-closed until a
  legally reviewable updater passes fresh GitHub CI native Windows Squirrel and
  macOS internal maker matrices; preserve their exact artifact evidence.
- **macOS signed artifact:** nested Tokscale Mach-O re-sign/hash binding,
  hardened runtime/Team ID, notarization ticket, mounted-DMG verification, and
  native smoke are not complete. Internal unsigned packaging evidence is not a
  substitute for this gate.
- **Integrator publication:** the recovered hardening through `ded282e` is
  pushed on `agent/permanent-sidecar-companion`, PR 1 remains draft, and the
  direct packaging replacement plus reviewed updater integration is committed
  through `bfc8d0a`. Manual run `29775692315` passed every job except the
  diagnosed Windows maker post-overlay check described above; rerun after its
  narrow log-residue fix before claiming native Windows evidence.
  Configure the protected signing/npm/CDN release environments and the four
  exact public download bindings only after the immutable Windows bytes exist;
  never call the historical local rc.12 artifacts shipped.
- **Legal owner:** choose the project license, privacy-policy/terms publication,
  TokenMonster name/trademark position, and protected release approvals.
