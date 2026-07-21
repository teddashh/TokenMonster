# ADR 0004: Electron packaging, fuse, and signing baseline

- Status: accepted for internal packaging; signed release remains blocked
- Date: 2026-07-15

## Context

The companion needs a reproducible package before signing work can be evaluated.
Packaging must not weaken the renderer sandbox, ship source or blocked character
assets, depend on a workspace `node_modules`, or imply that an internal artifact
is signed. The local collector coordinator and IPC are wired. Internal
Linux/macOS packaging now also needs a deterministic way to select, copy,
verify, and consume one exact native Tokscale binary without allowing a runtime
command or path override.

TokenMonster already has stable Vite runtime entry paths. Packaging therefore
needs only a small, explicit orchestration layer around the stable Electron
Packager and installer APIs; a framework-owned build lifecycle is unnecessary.

## Decision

### Build and package layout

- Keep Electron exactly at `43.1.1`, Vite at `8.1.4`, and the reviewed stable
  direct packaging tools exact: `@electron/packager 18.4.4`,
  `@electron/fuses 1.8.0`, `@electron/osx-sign 1.3.3`,
  `@electron/windows-sign 1.2.2`, `cross-zip 4.0.1`,
  `electron-installer-dmg 5.0.1`, `electron-winstaller 5.4.4`, and verifier
  `@electron/asar 4.2.0`.
- The 2026-07-20 reviewed stable replacement removes every Electron Forge
  package and the root overrides. Consequently `@electron/rebuild`,
  `external-editor`, and `tmp` are absent from both the exact lock and installed
  tree. The toolchain verifier requires `npm ls --all` to exit successfully,
  permits only npm's reproducible optional-platform `@emnapi/runtime`/`tslib`
  extraneous labels, checks every direct version and API shape, and rejects any
  return of the banned packages.
- The fixed `--require-upstream-compatible` verifier mode remains part of the
  public npm job before its first TokenMonster registry-state read or mutation.
  It now validates the same Forge-free closure and passes only after all normal
  dependency and API checks pass; it is not a bypass or a deleted gate.
- Historical rationale: stable Forge 7.11.2 required cross-range overrides for
  `@electron/rebuild` and `tmp`. Without them its native-range lock produced 25
  audit findings (22 high and 3 low). Forge `8.0.0-alpha.10` removed those paths
  but introduced prerelease, packager-major, ESM, and fuse-major changes. The
  direct replacement instead uses the exact stable lower-level versions already
  exercised by the prior packaging flow, without retaining Forge's unused CLI,
  rebuild, editor, or plugin closures.
- Use the explicit Vite builds independently of packaging. Main
  is bundled to `dist/main/main/main.js`, preload to
  `dist/main/preload/*.cjs`, and renderer to `dist/renderer`.
- Runtime externalization has exactly two entries: `electron` and `node:*`.
  Workspace packages and third-party JavaScript are bundled. A packaged app
  has no runtime `node_modules`.
- Direct Electron Packager stages only `dist`, `package.json`, `README.md`, the
  checked-in runtime bundle manifest, and its checked-in Tokscale license. It
  creates one `app.asar`, with no
  `app.asar.unpacked`. A reviewed hook copies only the current native host's
  exact Tokscale files to `resources/collector/tokscale`; no package JavaScript
  or `node_modules` enters the runtime.
- Packager dependency pruning is disabled because the runtime is already
  bundled and the strict input allowlist excludes `node_modules`; it must
  not crawl workspace symlinks from production dependency declarations.
- ZIP is the cross-platform internal maker. DMG is macOS-only. No updater feed
  or release-channel metadata is emitted until signing and rollback ownership
  are approved.
- A post-package hook removes group/world-write bits from every regular file
  and directory without adding executable bits. Privileged mode bits and
  non-regular entries fail the build.

### Fuse policy

The direct `flipFuses()` call writes the first eight V1 fuses.
`strictlyRequireAllFuses` is
intentionally `false` because `@electron/fuses@1.8.0` does not name Electron
43's ninth fuse. The artifact verifier reads the binary wire directly and
requires all nine states, including the inherited ninth default:

|                                Wire index | State                                    |
| ----------------------------------------: | ---------------------------------------- |
|                             0 `RunAsNode` | disabled                                 |
|                1 `EnableCookieEncryption` | enabled                                  |
|  2 `EnableNodeOptionsEnvironmentVariable` | disabled                                 |
|         3 `EnableNodeCliInspectArguments` | disabled                                 |
| 4 `EnableEmbeddedAsarIntegrityValidation` | enabled                                  |
|                   5 `OnlyLoadAppFromAsar` | enabled                                  |
|  6 `LoadBrowserProcessSpecificV8Snapshot` | enabled                                  |
|      7 `GrantFileProtocolExtraPrivileges` | disabled                                 |
|       8 `WasmTrapHandlers` in Electron 43 | enabled, inherited and raw-wire verified |

An Electron upgrade is blocked until the raw wire length and every expected
state are reviewed again.

Signed Windows and macOS candidates flip fuses before the platform signer so
the final trusted signature covers the changed runtime. Internal macOS builds
defer the fuse change until Packager has finished ASAR and plist mutation,
harden filesystem permissions, and then use the exact `@electron/osx-sign`
inside-out API with an ad-hoc identity. The manifest-bound Tokscale directory
and byte-bound sidecar closure are excluded from rewriting so their existing
Mach-O signatures and raw hashes remain the upstream-reviewed bytes; the outer
app seal still covers those files. A strict
`codesign --verify --deep --strict` and native startup smoke are mandatory
before the internal maker artifact is accepted.

Electron's prebuilt archive provides `v8_context_snapshot.bin`, while fuse 6
requires the browser process to load `browser_v8_context_snapshot.bin`. A
bounded direct Packager hook copies the exact per-platform/architecture runtime snapshot
to the browser-specific sibling name. The artifact verifier requires both
files to exist and be byte-identical; otherwise the packaged app would fail
before main-process startup.

### Artifact verification

The package gate extracts `app.asar` into a private temporary directory and
compares every path and byte with the built runtime inventory. It rejects:

- missing or extra ASAR entries, unpacked files, `node_modules`, source/tests,
  source maps, `.env` files, symlinks, or unknown binary app content;
- raster, audio, video, SVG, embedded `data:image/`, high-confidence secret
  patterns, and any bare runtime import other than `electron` or `node:*`;
- an entrypoint mismatch, an oversized inventory, a missing maker artifact,
  or a fuse wire that differs from the nine reviewed states.

Every ASAR file must also carry SHA-256 header and per-block integrity metadata
that exactly matches the extracted bytes. This verifies the archive metadata;
the platform-enforced embedded integrity fuse still requires macOS/Windows
packaged smoke and signing evidence.

For Linux ZIP output, the verifier reads the central directory without
extracting it, rejects traversal, duplicate/case-colliding paths, links,
non-regular entries, privileged/writeable modes and bounded-size violations,
then compares every file byte hash, size and mode plus every directory path and
mode with the already inspected staged app. Windows PowerShell ZIPs do not
round-trip POSIX modes, while macOS app ZIPs contain framework symlinks. On
those native hosts the verifier therefore records only bounded entry/path
safety, sizes and packaged-executable presence; it does not claim byte-for-byte
equivalence with staging. Those reduced non-Linux ZIP checks are private
matrix evidence, not public Windows release evidence: the tag workflow uploads
only the separately verified three-file Squirrel publication directory. A ZIP
hash alone is not release evidence.

The verifier writes hashes and inventory to
`release-evidence/companion-package.json`. Internal evidence explicitly says
`declaredSigned: false` and records the exact collector target, package-lock
integrity, package version, and per-file hashes/modes. Linux evidence also
records the final ZIP content-inventory hash; Windows/macOS evidence labels its
reduced ZIP verification as `entry-safety-and-executable-presence` instead.
Evidence schema v2 also binds a unique injected candidate version to the
packaged application and Squirrel metadata; source `0.1.0` and SemVer build
metadata are rejected as candidate identities.

### Signing and native collector gates

`TOKENMONSTER_RELEASE_MODE` accepts only `internal` or `signed`; omission means
internal. Every package requires a strict Windows-compatible
`TOKENMONSTER_RELEASE_VERSION` distinct from the source placeholder. Signed
mode runs only on the matching native macOS or Windows host.

macOS signed mode fails before packaging unless all of the following are
present and structurally valid:

- fixed bundle ID `com.tokenmonster.companion`;
- `TOKENMONSTER_MAC_DEVELOPER_ID`, matching the configured Team ID;
- private absolute Apple API key path with mode `0600` or stricter;
- Apple API key ID, issuer ID, and Team ID.

Signed verification additionally requires `codesign --verify --deep --strict`,
Gatekeeper assessment, and a DMG. These checks are necessary but do not by
themselves authorize a release.

Windows signed mode requires an absolute regular non-symbolic PFX path,
password, and exact expected certificate subject in the audited
`TOKENMONSTER_WINDOWS_*` environment. Both Electron Packager and Squirrel use
the modern `windowsSign` interface with SHA-256 only and a fixed HTTPS RFC3161
timestamp server; legacy `WINDOWS_*` overrides and signer debug injection are
rejected or removed. A serializable audited signing hook preserves only the
exact raw-policy-bound sidecar zstd binding after validating its checked-in
Windows size and SHA-256; Authenticode would otherwise change bytes that the
runtime must reject. Native verification requires exactly that one raw-byte
exception, then checks `Valid`, the exact subject, the RFC3161 counter-signature
OID, and SHA-256 SignedCms digests for every other PE in the staged app,
Setup.exe, and full `.nupkg` payload. The ZIP-based nupkg is explicitly recorded
as a non-Authenticode container rather than mislabeled as signed.

Native Windows install evidence binds physical identity, size, and SHA-256 for
Setup, `RELEASES`, and the full nupkg both before installation and after bounded
uninstall. The nupkg reader uses one validated file handle for complete hashing
and bounded positional ZIP reads, while installed directory traversal rejects
links, reparse traversal, identity changes, entry-count overflow, and byte
overflow. The signed maker is fully reverified after this smoke and before
upload, so installed bytes cannot be compared against a post-verification
substitution.

The runtime manifest declares exact `tokscale@4.5.2` package-lock integrity,
file SHA-256, mode and source/target inventory for macOS and Linux x64/arm64,
plus audited-but-disabled Windows packages. Direct Packager only accepts a native host
build and validates the selected optional package and copied bytes without
executing native payloads on the release host. At startup, the main process rereads
the ASAR-protected policy and revalidates the exact extraResource inventory,
mode and hashes. Only then does it pass the fixed absolute path derived below
`process.resourcesPath` to the collector adapter. Missing, extra, linked or
modified resources leave collection unavailable; there is no packaged fallback
to module resolution.

This makes unsigned internal Linux/macOS collector packaging reviewable, but it
does not make a signed macOS artifact ready. Electron's recursive macOS signing
pass may rewrite the nested Tokscale Mach-O and arm64 dylib after the upstream
hash gate. `signedReleaseStatus` therefore remains
`blocked-native-resigning-audit`, and both the packaging runner and verifier reject signed
mode. A native macOS release change must bind post-sign nested hashes to the
expected Developer ID/Team ID, hardened runtime and notarization ticket, then
mount and inspect the final DMG. DMG verification currently fails closed.

## Consequences

- A Linux CI host can build and inspect a self-contained internal package and
  ZIP without launching Electron or disabling its sandbox.
- The package is useful for bundle and collector review but is not an Alpha
  installer. It is unsigned, has no secure updater, and has no packaged
  sandbox-enabled smoke evidence.
- The current Linux workstation cannot run that smoke safely: Packager's copied
  `chrome-sandbox` is user-owned mode `0755`, while AppArmor restricts
  unprivileged user namespaces. Electron aborts unless the helper is root-owned
  mode `4755`. The release process must use a properly isolated/configured
  Linux runner; `--no-sandbox` is never an accepted workaround.
- macOS signing/notarization remains fail closed until credentials, nested
  collector re-sign/hash handling, entitlements/identity/DMG verification,
  real-device smoke, and release-owner approval exist. Windows collection and
  signing remain separate future decisions because no Windows no-egress process
  sandbox is approved.

## References

- [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)
- [Electron ASAR archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives)
- [Electron ASAR integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)
- [Electron Packager options](https://electron.github.io/packager/main/interfaces/Options.html)
- [Electron Packager](https://github.com/electron/packager)
- [Electron macOS signing](https://github.com/electron/osx-sign)
- [Electron Installer DMG](https://github.com/electron-userland/electron-installer-dmg)
- [Electron Windows Installer](https://github.com/electron/windows-installer)
- [cross-zip](https://github.com/feross/cross-zip)
- [Electron native Node modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules/)
- [Electron 43.1.1 release](https://releases.electronjs.org/release/v43.1.1)
