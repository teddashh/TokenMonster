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

Electron Forge's Vite plugin remains experimental. TokenMonster already has
stable runtime entry paths, so adopting that plugin would add lifecycle and
directory changes without improving the release boundary.

## Decision

### Build and package layout

- Keep Electron exactly at `43.1.1`, Vite at `8.1.4`, Electron Forge CLI,
  ZIP/DMG makers, and fuse plugin exactly at `7.11.2`, and `@electron/fuses`
  exactly at `1.8.0`.
- Forge 7.11.2 still declares `@electron/rebuild ^3.7.0`, whose resolved tree
  is currently covered by high-severity `node-tar` advisories. The root uses a
  narrowly scoped exact override to `@electron/rebuild 4.2.0`; the CLI's
  `external-editor` tree similarly overrides vulnerable `tmp ^0.0.33` to exact
  `tmp 0.2.7`. `npm audit` must be clean and the full Forge package operation
  must pass. Because these replacements cross the upstream-declared ranges,
  the policy script permits exactly those two `npm ls` exceptions and any
  signed/GA release stays blocked until Forge's ranges natively accept safe
  versions or an equally reviewed upstream fix replaces the overrides. The
  verifier's default mode keeps internal packaging and signed-candidate review
  usable with that exact audited set. Its fixed `--require-upstream-compatible`
  mode validates the same installed tree and then rejects any remaining
  cross-range problem; after installing the exact lock, the public npm job runs
  that strict mode before its first TokenMonster registry-state read or
  mutation, transitively blocking CDN and GitHub publication while preserving
  non-public candidate and draft evidence.
- A registry recheck on 2026-07-19 confirmed that 7.11.2 is still the latest
  stable Forge release. A temporary native-range lock with the two overrides
  removed produced 25 audit findings (22 high and 3 low); the relevant paths
  resolved through `@electron/rebuild 3.7.2` to `tar 6`, and through
  `external-editor 3.1.0` to `tmp 0.0.33`. There is no safe version inside
  either published upstream range.
- Forge `8.0.0-alpha.10` accepts `@electron/rebuild ^4.0.1` and removes the
  CLI's `external-editor`/`tmp` path, and an exact temporary alpha resolution
  audited clean. It is not a drop-in GA fix: it is a prerelease with ESM and
  packager-major changes, and its fuse plugin requires `@electron/fuses ^2`
  while this reviewed configuration pins 1.8.0. Adopting it requires a full
  packaging, fuse, artifact, and native-host matrix review.
- This is an external, dev-only packaging supply-chain semver gate, not an
  application/runtime defect. The packaged app has no runtime `node_modules`,
  and none of `@electron/rebuild`, `external-editor`, or `tmp` is declared as a
  companion dependency. Close the gate only when a stable upstream release
  natively accepts the safe versions, or after a reviewed stable packaging
  replacement passes the same cross-platform release checks.
- Use three explicit Vite builds, not the experimental Forge Vite plugin. Main
  is bundled to `dist/main/main/main.js`, preload to
  `dist/main/preload/*.cjs`, and renderer to `dist/renderer`.
- Runtime externalization has exactly two entries: `electron` and `node:*`.
  Workspace packages and third-party JavaScript are bundled. A packaged app
  has no runtime `node_modules`.
- Forge packages only `dist`, `package.json`, `README.md`, and the checked-in
  runtime bundle manifest. It creates one `app.asar`, with no
  `app.asar.unpacked`. A reviewed hook copies only the current native host's
  exact Tokscale files to `resources/collector/tokscale`; no package JavaScript
  or `node_modules` enters the runtime.
- Packager dependency pruning is disabled because the runtime is already
  bundled and the strict input allowlist excludes `node_modules`; Forge must
  not crawl workspace symlinks from production dependency declarations.
- ZIP is the cross-platform internal maker. DMG is macOS-only. No updater feed
  or release-channel metadata is emitted until signing and rollback ownership
  are approved.
- A post-package hook removes group/world-write bits from every regular file
  and directory without adding executable bits. Privileged mode bits and
  non-regular entries fail the build.

### Fuse policy

The fuse plugin writes the first eight V1 fuses. `strictlyRequireAllFuses` is
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

Electron's prebuilt archive provides `v8_context_snapshot.bin`, while fuse 6
requires the browser process to load `browser_v8_context_snapshot.bin`. A
bounded Forge hook copies the exact per-platform/architecture runtime snapshot
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

For ZIP output, the verifier also reads the central directory without extracting
it, rejects traversal, duplicate/case-colliding paths, links, non-regular entries,
privileged/writeable modes and bounded-size violations, then compares every
file byte hash, size, file mode, directory path and directory mode with the
already inspected staged app. A ZIP hash alone is not release evidence.

The verifier writes hashes and inventory to
`release-evidence/companion-package.json`. Internal evidence explicitly says
`declaredSigned: false` and records the exact collector target, package-lock
integrity, package version, per-file hashes/modes, and final ZIP content-inventory
hash. Evidence schema v2 also binds a unique injected candidate version to the
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
rejected or removed. Native verification checks `Valid`, the exact subject,
the RFC3161 counter-signature OID, and SHA-256 SignedCms digests for every PE in
the staged app, Setup.exe, and the full `.nupkg` payload. The ZIP-based nupkg is
explicitly recorded as a non-Authenticode container rather than mislabeled as
signed.

The runtime manifest declares exact `tokscale@4.5.2` package-lock integrity,
file SHA-256, mode and source/target inventory for macOS and Linux x64/arm64,
plus audited-but-disabled Windows packages. Forge only accepts a native host
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
`blocked-native-resigning-audit`, and both Forge and the verifier reject signed
mode. A native macOS release change must bind post-sign nested hashes to the
expected Developer ID/Team ID, hardened runtime and notarization ticket, then
mount and inspect the final DMG. DMG verification currently fails closed.

## Consequences

- A Linux CI host can build and inspect a self-contained internal package and
  ZIP without launching Electron or disabling its sandbox.
- The package is useful for bundle and collector review but is not an Alpha
  installer. It is unsigned, has no secure updater, and has no packaged
  sandbox-enabled smoke evidence.
- The current Linux workstation cannot run that smoke safely: Forge's copied
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

- [Electron Forge CLI](https://www.electronforge.io/cli)
- [Electron Forge build lifecycle](https://www.electronforge.io/core-concepts/build-lifecycle)
- [Electron Forge Vite plugin status](https://www.electronforge.io/config/plugins/vite)
- [Electron Forge fuses plugin](https://www.electronforge.io/config/plugins/fuses)
- [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)
- [Electron ASAR archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives)
- [Electron ASAR integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)
- [Electron Packager options](https://electron.github.io/packager/main/interfaces/Options.html)
- [Forge macOS code signing](https://www.electronforge.io/guides/code-signing/code-signing-macos)
- [Forge DMG maker](https://www.electronforge.io/config/makers/dmg)
- [Electron native Node modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules/)
- [Electron 43.1.1 release](https://releases.electronjs.org/release/v43.1.1)
- [npm dependency overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides)
