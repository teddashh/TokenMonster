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

- Keep Electron exactly at `43.7.7`, Vite at `8.1.4`, and the reviewed stable
  direct packaging tools exact: `@electron/packager 20.3.0`,
  `@electron/fuses 1.8.0`, `@electron/osx-sign 1.3.3`,
  `@electron/windows-sign 1.2.2`, `cross-zip 4.0.1`,
  `electron-winstaller 5.4.4`, and verifier `@electron/asar 4.2.0`. The macOS
  DMG comes from the system `hdiutil`, so no npm DMG tool is pinned.
- The 2026-07-20 reviewed stable replacement removes every Electron Forge
  package and the root overrides. Consequently `@electron/rebuild`,
  `external-editor`, and `tmp` are absent from both the exact lock and installed
  tree. The toolchain verifier requires `npm ls --all` to exit successfully,
  permits only npm's reproducible optional-platform `@emnapi/runtime`,
  `@img/sharp-wasm32`, and `tslib` extraneous labels at exact versions, checks
  every direct version and API shape, and rejects any return of the banned
  packages. The one root override it permits is the reviewed miniflare sharp
  security override from the 2026-10-07 amendment, together with the one
  `invalid: sharp` line that override makes `npm ls` print.
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

## Amendments

### 2026-10-01: Electron 43.1.1 to 43.7.7

Electron moved from `43.1.1` to the `43.7.7` patch release to close four high
advisories: GHSA-9qh4-3jw8-366w, GHSA-j84w-jfhq-vhvj and GHSA-gr2m-v5gq-v685,
fixed in 43.4.1, and GHSA-qmv3-fv6v-rmhq, fixed in 43.5.0. The packaging tool
pins above did not change.

`scripts/agent/electron-runtime.mjs` pins the reviewed digests of the new npm
package files. Against 43.1.1, `index.js`, `cli.js` and the declared
dependencies are unchanged; `install.js` now loads its archive extractor
(`@electron-internal/extract-zip`, as before) only when it has to unpack a
download, and `checksums.json` lists the 43.7.7 archives.

As the fuse policy requires, the raw wire was reviewed again: the 43.7.7
binary still carries one version 1 wire of nine fuses with the same defaults,
and the packaged internal app passed the artifact verifier's nine-state check.

### 2026-10-05: @electron/packager 18.4.4 to 20.3.0

`@electron/packager` moved from `18.4.4` to exact `20.3.0` so the unpatched
`extract-zip` package leaves the tree. Packager 20.0.1 replaced it with
`@electron-internal/extract-zip`. The same upgrade drops `@electron/get` 3
and `got`, which also removes `http-cache-semantics` 4.2.0. The macOS DMG
tools stay on their current pins, so `image-size` remains through
`electron-installer-dmg` and `appdmg`.

Node.js 24.15.0 already satisfies packager 19's requirement of Node.js
>=22.12.0, and the packaging scripts were already ESM, so the engine pin
stays.

`extract-zip` also brought `@types/yauzl` 2.10.3 into the root tree. The
release verifier `scripts/release/verify-installed-companion.mjs` imports the
hoisted `yauzl` 2.10.0 under `@ts-check`, so the root devDependencies now pin
`@types/yauzl` at that same `2.10.3`. `packages/characters` keeps its own
exact `yauzl` 3.4.0 and `@types/yauzl` 3.4.0.

Packager 19 and 20 breaking changes adapted here:

- Hooks take one object and return a promise. `packageAfterCopyHook` follows
  that shape. `HookFunctionErrorCallback` is gone.
- `asar: true` now unpacks native `.node` files. The companion passes an empty
  `asar` options object so the package stays one `app.asar` with no
  `app.asar.unpacked`.
- `derefSymlinks` now defaults to true. The companion sets it to false, which
  was the packager 18 behavior.
- `sanitizePackageJson` now strips development fields unless replaced. A
  replacement that returns the copied manifest lets the afterCopy hook rewrite
  only the release version, which the artifact verifier checks.
- `asarIntegrityDigest` defaults to true on a macOS host and rewrites the
  Electron Framework. The companion sets it to false so that binary stays as
  Electron ships it until the existing fuse and `osx-sign` steps.
- The `download` option type changed with `@electron/get` 5 (built-in fetch
  instead of `got`). This repository does not pass `download`.
- Published `TargetArch` and `TargetPlatform` types were removed. Call sites
  now use `OfficialArch` and `OfficialPlatform`.

### 2026-10-07: sharp 0.35.5 override and source-map-js 1.2.2

Two high advisories reached the development tree: GHSA-wq5f-xc86-pv6w in
`sharp` 0.35.4, fixed in 0.35.5, and GHSA-68fv-2mgg-jv7q in `source-map-js`
1.2.1, fixed in 1.2.2. Both are development dependencies only, and
`npm audit --omit=dev` was already clean.

`source-map-js` moved to 1.2.2 inside its existing ranges.

`sharp` comes only from `miniflare` 5.20260930.0-alpha, which pins it to
exactly 0.35.4, through `wrangler` 4.145.0 and `@cloudflare/vite-plugin`
1.62.3. Even `wrangler` 4.148.0 still brings a `miniflare` that pins 0.35.4,
so the reviewed root override returns as `{"miniflare": {"sharp": "0.35.5"}}`,
the same shape that d357cf7 retired. The toolchain verifier again permits
exactly that override and the one `invalid: sharp@0.35.5` line it makes
`npm ls` print, and its optional `@img/sharp-wasm32` entry moves to 0.35.5.
The override goes away the same way as in d357cf7 once `miniflare` pins a
patched `sharp` itself.

npm 11.12.1 does not carry root overrides into workspace packages when it
starts from an existing lock, so `npm install` alone left `sharp` at 0.35.4.
The `sharp` and `@img/sharp-*` lock entries therefore come from a clean
resolve with the override in place (the `@img/sharp-libvips-*` packages move
to 1.3.4 with it), and every other lock entry is unchanged. `npm ci` installs
that lock, and a second `npm install --package-lock-only` leaves it as it is.

`image-size` remains through `electron-installer-dmg` and `appdmg` (3 high
findings) and needs a separate packaging decision. `electron-installer-dmg`
always passes its default `background.png` to `appdmg`, so `appdmg` calls the
old `sizeOf(path, callback)` API of `image-size`, which the only patched line,
`image-size` 2.x, no longer has.

### 2026-10-07: macOS DMG through hdiutil

That separate packaging decision: `electron-installer-dmg` 5.0.1 and `appdmg`
0.6.6 leave the tree, and with them the last 3 high findings of the full
development audit, all one `image-size` advisory.

`makeDmgArtifact` now copies `TokenMonster.app` with `ditto` into a temporary
folder next to a link to `/Applications`, then runs `hdiutil create` with the
volume name `TokenMonster`, that folder as `-srcfolder`, `-fs HFS+` and the
configured `ULFO` format. The image shows the same two items as before. It no
longer has the background picture or the fixed window layout that `appdmg`
wrote. The DMG stays an internal artifact: the public desktop asset is Windows
only, and DMG release verification is still closed.

The lock drops `electron-installer-dmg`, `appdmg`, `image-size` and 44 other
entries that only they used. The toolchain verifier no longer pins or imports
a DMG tool and bans `electron-installer-dmg` and `appdmg` together with the
other retired packages. The full development audit reports 0 findings.

## References

- [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)
- [Electron ASAR archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives)
- [Electron ASAR integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)
- [Electron Packager options](https://electron.github.io/packager/main/interfaces/Options.html)
- [Electron Packager](https://github.com/electron/packager)
- [Electron macOS signing](https://github.com/electron/osx-sign)
- [Electron Windows Installer](https://github.com/electron/windows-installer)
- [cross-zip](https://github.com/feross/cross-zip)
- [Electron native Node modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules/)
- [Electron 43.7.7 release](https://releases.electronjs.org/release/v43.7.7)
