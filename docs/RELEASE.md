# Release packaging

`scripts/release/build-release.mjs` produces a single installable tarball from
the workspace without publishing any package to a registry.

```
node scripts/release/build-release.mjs [--version <exact>] [--version-suffix rc.1] [--out <dir>] [--embedded-starter-pack <zip>] [--skip-build]
```

What it does:

1. Builds every workspace package (`scripts/run-workspaces.mjs build`), unless
   `--skip-build` is passed.
2. Assembles `dist-release/staging/package/` — the CLI package's `dist/` plus a
   physical `node_modules/` containing the shipped `@tokenmonster/*` packages
   and the exact registry closure currently required by them (`zod`, `yauzl`,
   and `pend`). Each package is copied according to its own `files` allowlist;
   registry packages are bound to the repository lock's version, registry URL,
   SHA-512 integrity, and production dependency maps.
3. Writes a transformed root `package.json`: `private` is dropped, the
   workspace packages and their approved exact registry closure become
   `dependencies` + `bundleDependencies`, and `tokentracker-cli` stays an
   external registry dependency (the sidecar is resolved at runtime via
   `require.resolve`, so it must be a real install).
4. Derives a publishable `npm-shrinkwrap.json` from the repository
   `package-lock.json`. Every package reachable from the exact sidecar pin must
   have a public-registry `resolved` URL and SHA-512 integrity; missing,
   development-only, non-registry, peer-dependent, or version-drifted entries
   fail the build.
5. Obtains the exact pinned 417,332-byte starter source ZIP, either from the
   immutable build-only bootstrap URL or the optional local
   `--embedded-starter-pack` override, and verifies its SHA-256 and complete ZIP
   inventory. It release-stages only eight WebPs under
   `@tokenmonster/characters/dist/embedded-starter-assets/`: one avatar and one
   `tech` outfit for ChatGPT, Claude, Gemini, and Grok, 415,470 extracted bytes.
   This is a build input; installed clients do not request the bootstrap URL.
6. Creates `dist-release/tokenmonster-<version>.tgz` with `tar` (the staging
   directory is already named `package/`, which is the layout npm expects) and
   writes `SHASUMS256.txt`.

The tarball contains exactly those eight approved starter WebPs and no audio
asset. The characters package also carries exactly three generated authority
slots: `dist/approved-release-v2.json`,
`dist/approved-asset-pack-descriptor-v1.json`, and
`dist/approved-asset-pack-allowlist-v1.json`. All three are non-null and
strictly cross-bound to combined release
`ai-sister-media-11-voice55-2026.07.23`, whose schema-v2 manifest contains 891
images and 55 WAVs for 11 characters, 946 entries total. Its canonical
manifest SHA-256 is
`21e4675653ce66b50b61e91260f1623e6e3005177f900991e3a8eeadaf9e6474`.
Staging removes the historical schema-v1 JSON, rejects any additional character
JSON, and accepts only either three null slots or three strictly validated,
cross-bound authorities. For the non-null current set, the artifact verifier
also requires all eight starter WebPs, their exact 415,470 total bytes, hashes,
media signatures, paths, and associations, and rejects every other raster. The
four starters' 168 `zh-TW`/`en` fixed text lines are compiled JavaScript copy,
not voice assets.

The shipped gateway and characters subpath implement the explicit-consent
fixed-pack lifecycle. Default, no-consent, offline-without-cache, failed, and
revoked states make zero runtime asset requests and use the embedded four-starter
base; art outside that base uses letter mode or silence. An explicit enable
action may make exactly one state-independent GET to
`https://cdn.ted-h.com` for the 73,261,088-byte ZIP whose SHA-256 is
`7d98e0d18c470f82818e8ada67208847c3cf4ff5c10cb5f99f9215191e981f30`.
That full pack contains 891 images and 55 canonical WAVs, 946 entries and
73,043,596 extracted bytes. Failure or revocation returns to the base, and the
gateway still exposes no per-object downloader. The embedded base contains no
audio; complete-pack voice playback defaults off and uses verified local cache
hits only.

Non-null slots must come byte-for-byte from
`npm run prepare:asset-release-slots -- ...`, which consumes the approved
manifest and fixed-pack builder descriptor, derives the exact allowlist path
from that descriptor plus one reviewed HTTPS origin, and publishes only to a
fresh output directory. Do not edit those generated files during promotion.
The assembler rejects a stale build containing the former production CDN
literal, `TOKENMONSTER_CHARACTER_CDN`, or removed downloader signatures,
including with `--skip-build`, and rejects unsupported or symbolic staging
entries. Every later image or combined image + voice release requires a new,
separately reviewed immutable pack whose request set is independent of local
usage and progression. The current combined release includes 55 canonical WAVs
with owner-authorized reference-clone evidence and per-clip spoken-content
review. The older schema-v1 inventory of 50 WAV refs remains historical and is
not a runtime authority.

## Agent-ready source development

`agent-release.json`, the shared `scripts/agent` lifecycle, and the two
explicit repository skills let an already installed Codex or Claude Code
session build and run the native Electron application from a checkout. This is
a source-development contract, not a packaging or publication lane. It creates
no extra distributable executable, installer, GitHub Release asset, npm publication, update
channel, shortcut, or OS registration. The files travel with the repository
source archive and are excluded from the CLI tarball and desktop package.
When Electron's native executable is absent, the shared lifecycle separately
verifies the exact locked Electron 43.1.1 installer package files and checksum
authority before obtaining the official native archive; it never delegates
that step to an agent-generated command or unreviewed mirror.

The complete invocation, privacy, process-ownership, and product-parity
boundary is documented in
[`AGENT_READY_SOURCE_RELEASE.md`](AGENT_READY_SOURCE_RELEASE.md).

## Desktop installers

The Windows maker uses an exact reviewed Squirrel updater candidate whose
receipts live in `apps/companion/packaging/squirrel-windows/`; the reviewed
binary itself is not tracked in this repository. Tag CI restores it from the
same run's locked reproducible rebuild after verifying the receipt digest; a
local maker run needs any byte-identical copy in that directory. The maker
verifies the complete `electron-winstaller@5.4.4` vendor inventory, creates a
disposable overlay, and replaces only `Squirrel.exe`; `node_modules` is never
mutated. The merged updater contains only the Apache-2.0 `Microsoft.Web.Xdt`
3.1.0 rebuilt from `dotnet/xdt` source — never the EULA-bound 2.1.1 DLL — and
its complete redistribution notice bundle is
`apps/companion/packaging/squirrel-windows/licenses/MERGED-RUNTIME-NOTICES.md`.
Public status is `approved-unsigned-public-test-pending-signing`: unsigned
public test installers ship through the dedicated tag lane below with the
notice bundle attached, while Authenticode-signed packaging keeps failing
closed until audited signing credentials exist and the signed install review
passes.

The `Companion installers [package]` CI job packages the floating pet shell on
Ubuntu, macOS, and Windows for manual `workflow_dispatch` runs and for pushed
commits whose message contains `[package]`. Those non-tag candidates are
unsigned internal evidence only. Each matrix runner uploads its complete direct
maker directory as a seven-day GitHub Actions artifact named
`tokenmonster-desktop-<os>`; no internal candidate is attached to a public
GitHub Release.

### Unsigned Windows public test installers

The `Unsigned Windows installer (public test)` job runs on pushed `v*` tags
only while the repository variable `TOKENMONSTER_UNSIGNED_WINDOWS_TEST_APPROVED`
is exactly `true`. The lane never reads signing secrets. Its provenance chain
is self-contained in one workflow run: the locked reproducible rebuild job
rebuilds the reviewed updater twice from pinned sources, the installer job
verifies the artifact against the `integration-review.json` digest before
restoring it, the internal maker packages `TokenMonsterSetup.exe`, `RELEASES`,
and the full `.nupkg`, the byte-level verifier re-checks the payload, and
`smoke-windows-squirrel-installer.ps1` performs a native clean install, boot,
and uninstall before the artifact upload. Published releases must label these
artifacts as unsigned test builds and attach the merged-runtime notice bundle;
Windows SmartScreen will warn on unsigned installers, which is expected until
the signed lane opens.

### Private internal test prereleases

#### Historical full rc.15 evidence

The retired one-shot `publish_internal_rc15` lane published the already-fixed
`internal/v0.1.0-rc.15` private unsigned prerelease. Its exact 11-file inventory
contains the Windows x64 maker set, macOS arm64 DMG and ZIP, Linux x64 ZIP, CLI
tarball, source receipt, and aggregate checksums. Windows is not
Authenticode-signed; macOS is ad-hoc signed and not notarized. Its GitHub
prerelease was removed before the repository went public; the exact assets are
retained privately as historical three-platform packaging evidence. The legacy
Electron artifacts do not contain the newer embedded starter base and must not
be relabeled as rc.17. The rc.15 input is no longer active, and
rc.15 is never rebuilt or overwritten.

#### Historical CLI-only rc.17 evidence

The retired one-shot `publish_internal_rc17` lane published the corrected CLI
as a **private, unsigned, CLI-only GitHub prerelease** under the isolated
`internal/v0.1.0-rc.17` tag so the owner could test installs on several
machines without weakening the public release gate. The lane accepted only
private `main` with all three runner platforms, skipped
`Companion installers [package]`, waited for repository verification, sidecar
compatibility, the exact CLI candidate, and installed-release smoke on Linux,
macOS, and Windows, then uploaded exactly four byte-compared files:

- `tokenmonster-0.1.0-rc.17.tgz`
- `TokenMonster-cli-SHA256SUMS.txt`
- `TokenMonster-internal-source-v1.json`
- `TokenMonster-internal-SHA256SUMS.txt`

The source receipt records `releaseMode: "unsigned-internal-cli"`, the exact
source commit, and all three smoked platforms. The tarball contains ChatGPT,
Claude, Gemini, and Grok avatars, their `tech` base outfits, and 168
`zh-TW`/`en` fixed text lines; the complete 891-image pack stays outside the
tarball and is downloaded only after explicit consent. The internal tag
namespace never matches the public `v*` trigger, so it cannot enter npm,
R2/CDN, Worker, signing, or automatic-update promotion.

That publication run completed, so the manual input has been removed from
`ci.yml`, and the GitHub prerelease itself was removed before the repository
went public with its exact assets retained privately. rc.17 is never rebuilt
in place; a fix after rc.17 must use a new
version such as rc.18 through the normal release path.

##### Dependency-audit status

The historical rc.17-era development audit exception is retired. The advisory
`GHSA-f88m-g3jw-g9cj` (libvips CVEs in `sharp` before 0.35.0) reached the tree
only through `miniflare`'s exact `sharp@0.34.5` pin behind the two direct
`apps/web` development tools. No fixed `miniflare` exists, so the root manifest
carries a single reviewed scoped override forcing `miniflare`'s `sharp` to
`0.35.3`. `scripts/verify-packaging-toolchain.mjs` pins that exact override
shape and fails on any other override, and CI requires a completely clean
`npm audit` — every severity, including development dependencies — with the
full audit JSON retained in `release-evidence/`. Remove the override once a
`miniflare` release stops pinning a vulnerable `sharp`.

The signed Windows installer and native macOS release gates run only when the
`TOKENMONSTER_PUBLIC_RELEASE_APPROVED` repository variable is `true`; an
unapproved version tag runs only the unsigned verification, candidate, and
cross-platform smoke lanes, so an unsigned CLI test prerelease can be cut from
a tag without tripping the closed signing path. A version-tag run with that
approval deliberately narrows the installer matrix to Windows and
requires signed mode. It decodes the bounded PFX secret into the runner's
temporary directory, verifies every signable PE except the single raw-policy-
bound zstd binding described below, verifies Squirrel metadata, uploads
only the exact Squirrel publication directory as
`tokenmonster-desktop-windows-2025`, and deletes the PFX in an `always()`
cleanup step. That directory must contain exactly `RELEASES`,
`TokenMonsterSetup.exe`, and one version-bound full `.nupkg`; delta packages,
logs, debug files, links, and any other entry fail closed. Linux signing and
macOS signing/notarization do not yet have public-release policies, so tag runs
publish neither platform.

Every tag also runs a separate native macOS internal gate on the exact tag SHA.
It makes and verifies the unsigned internal bundle, preserves the manifest-bound
collector and sidecar bytes while applying the outer ad-hoc signature, performs
strict `codesign` verification, and requires the packaged application to reach
the dual-gated startup marker. Its maker output and package evidence remain a
private 30-day Actions artifact. Draft staging depends on this job, but no macOS
asset is attached to the public release.

The later Linux promotion job does not claim to verify Authenticode again. It
accepts only the exact three-file artifact emitted by that native signed job,
recomputes the full package SHA-1 required by Squirrel plus SHA-256 for every
promoted object, and requires `RELEASES` to contain exactly one matching full
package line. A delta, extra or nested file, path-bearing entry, wrong Squirrel
version projection, malformed UTF-8, or hash/size drift fails before any
credentialed step.

The release owner must create the matching GitHub Release as an empty
**draft** and push the tag. Keep it draft and do not attach anything while CI
runs. The protected workflow then performs four ordered transitions:

1. `release-staging` waits for every source/native/smoke gate, stages the exact
   Windows and CLI bytes on the draft, and downloads them again for byte-wise
   comparison. A partial rerun may add only missing draft assets; a mismatched
   or unknown asset fails closed.
2. `npm-release` reads the authoritative registry metadata before mutation,
   advances `next` for prereleases or `latest` for stable releases without
   allowing a downgrade, and publishes the exact cross-platform-smoked
   tarball. An exact-version rerun repairs a lagging dist-tag; the same version
   with different SHA-512 integrity fails. It reads registry metadata back,
   proves the other channel did not move, and smokes both the exact package and
   the public `next` or unversioned `npx tokenmonster` channel.
3. `release-promotion` generates `public-release-v1.json` from the exact signed
   `TokenMonsterSetup.exe` and a separate deterministic Squirrel candidate from
   the exact `RELEASES` plus full `.nupkg`. It verifies the candidate locally
   before credentials are available. The protected executor retrieves the
   exact current `latest` or `next` `RELEASES` and referenced full package from
   R2; missing, present, and unknown are distinct, and unknown stops. It
   create-or-verifies immutable objects, publicly reads each object back, then
   makes the version-named channel full package available before committing the
   mutable `RELEASES`. Channel metadata is `no-store`; version-named packages
   are immutable. A stale post-commit public readback triggers an exact
   metadata rollback, while old and candidate packages remain available for
   overlapping clients. Only after the feed and immutable Setup pass exact R2
   plus public CDN readback may a SemVer-newer canonical
   `TOKENMONSTER_PUBLIC_RELEASE_JSON` replace the Worker's current release.
4. `release` re-downloads and byte-compares every staged GitHub asset. This is
   the only job allowed to execute `gh release edit --draft=false`, and it
   cannot start until both the public npx deliverable and CDN/Worker promotion
   succeeded.

No job can make the draft public while npm approval is missing or npm
publication failed. Existing npm/CDN/GitHub bytes make a same-version rerun
idempotent; an older version or any byte/JSON drift fails instead of
overwriting. Every tag shares one global non-cancelling workflow lane. Wrangler
does not offer an atomic create-only R2 operation, so that lane plus the
protected `release-promotion` environment is the single-writer boundary, with
authoritative R2 reads immediately before and after a put. For example, after
creating and pushing the reviewed tag, create the empty draft before the CI
gates complete:

```sh
: "${TOKENMONSTER_NEXT_RELEASE_VERSION:?set a new, unused SemVer prerelease}"
TOKENMONSTER_NEXT_RELEASE_TAG="v$TOKENMONSTER_NEXT_RELEASE_VERSION"
git push origin "$TOKENMONSTER_NEXT_RELEASE_TAG"
gh release create "$TOKENMONSTER_NEXT_RELEASE_TAG" --draft --prerelease --verify-tag --title "$TOKENMONSTER_NEXT_RELEASE_TAG"
```

Tag publication additionally requires repository variables
`TOKENMONSTER_PUBLIC_RELEASE_APPROVED=true` and
`TOKENMONSTER_NPM_PUBLISH_APPROVED=true`. Store the exact signer-subject
variable and Windows PFX/password secrets only in the protected
`release-signing` environment, not as repository-wide secrets. Configure these
additional protected environments without checking values into the repo:

- `npm-release`: secret `TOKENMONSTER_NPM_TOKEN`;
- `release-promotion`: secret
  `TOKENMONSTER_CLOUDFLARE_RELEASE_API_TOKEN`, plus variables
  `TOKENMONSTER_CLOUDFLARE_ACCOUNT_ID`,
  `TOKENMONSTER_WINDOWS_RELEASE_R2_BUCKET`, `TOKENMONSTER_WEB_WORKER_NAME`, and
  the exact HTTPS `TOKENMONSTER_PUBLIC_RELEASE_ENDPOINT_URL` ending in
  `/v1/releases/current`;
- `release-staging` and `release`: required reviewers, with no additional
  long-lived credential beyond the job-scoped GitHub token.

Reviewers approve signing, staging, npm, CDN/Worker promotion, and final GitHub
publication independently. Approval variables are not substitutes for the
rights and privacy checklist.

The pure-JavaScript authority in
`scripts/release/release-version-contract.mjs` is shared by the desktop policy,
CLI assembler, and web release parser. A first stable `v0.1.0` tag is valid.
While the CLI source package remains `0.1.0`, an attempted `0.1.1` CLI artifact
fails until the reviewed source version is advanced; prereleases must remain on
the same source base.
Non-tag CI candidates also keep that source base and encode the complete
GitHub run ID as a collision-free alphanumeric prerelease identifier such as
`0.1.0-ci29566777400x`; they never overflow Windows numeric version fields.

`prepare-windows-promotion.mjs` emits the canonical public binding, its
prompt-free promotion manifest, and `windows-squirrel-candidate-v1.json`.
The Squirrel candidate derives `latest` for stable versions and `next` for
prereleases from the same strict SemVer authority as npm. It names immutable
objects below `tokenmonster/releases/windows/squirrel/v<version>/` and fixed
feed objects below `tokenmonster/releases/windows/squirrel/<channel>/`.
`verify-windows-squirrel-candidate.mjs` recomputes the candidate from the copied
physical files without network or credentials. `promote-windows-squirrel-feed.mjs`
is the credential-scoped adapter around the dependency-injected executor; it
uses only pinned Wrangler diagnostics, bounded commands, fixed R2/CDN keys, and
content-free evidence. `verify-windows-promotion.mjs` rechecks the candidate
while consuming the full recalled Setup object and emits
`promotion-evidence-v1.json`. CI also retains
`windows-squirrel-promotion-evidence-v1.json`; no evidence contains Cloudflare
credentials or hand-authored release metadata.

`plan-windows-squirrel-promotion.mjs` is the pure state transition tool. Supply
the prepared candidate JSON and directory, plus either an authoritative prior
candidate JSON and a locally recalled exact two-file channel directory, or
`--missing` only after an authoritative lookup proves the channel absent. The
planner rehashes both local states. It always plans immutable objects as
create-or-verify-exact, writes the full package before `RELEASES`, and retires
the old channel package only after the metadata commit. An identical rerun is
`idempotent`; an older version, cross-channel input, same-version byte drift,
or recalled-byte mismatch fails. The protected workflow now performs the
authoritative R2 lookup, create-or-verify immutable write, current-channel
retrieval, ordered feed execution, CDN recall, Worker binding update, and exact
public readback. Missing state is accepted only after the pinned adapters or
exact public `404` response classify it authoritatively. These paths have local
deterministic coverage, but no credentialed protected-environment run has yet
produced real promotion evidence.

Unsigned internal Windows builds may trigger SmartScreen; unnotarized internal
macOS builds may require right-clicking and choosing Open. They are test
artifacts, not public installers.

Every desktop package/make is a uniquely identified candidate. Set
`TOKENMONSTER_RELEASE_VERSION` to the tag-bound or CI-derived strict
Windows-compatible SemVer. The first stable `0.1.0` may equal the source
package version; its immutable tag and exact artifact bytes provide the release
identity. Prereleases use a label and an optional numeric component such as
`rc.8`. The label must not end in a digit; numeric counters belong after the
dot, so ambiguous forms such as `rc8` and `a1.2` are rejected. Numeric
components must fit Windows version resources. Build metadata (`+...`) is
rejected because Squirrel drops it and could silently reuse an earlier package
identity. Require a deliberately chosen, previously unused identity:

```sh
: "${TOKENMONSTER_NEXT_RELEASE_VERSION:?set a new, unused SemVer prerelease}"
TOKENMONSTER_RELEASE_VERSION="$TOKENMONSTER_NEXT_RELEASE_VERSION" npm run make:companion:internal
```

The source package remains `0.1.0`. The direct packaging runner injects the
candidate into the staged `package.json`, Electron `appVersion`, Windows
executable ProductVersion, and Squirrel maker metadata. The verifier binds the
packaged `package.json`, full
`.nupkg` filename, embedded ASAR, `.nuspec`, and `RELEASES` byte count to that
same version and writes the result to
`release-evidence/companion-package.json`.

Both native Windows candidate and signed tag jobs also install the exact Setup
into a clean ephemeral profile. Every ordinary `lib/net45/**` payload file in
the already verified full `.nupkg` must exactly match the installed `app-*`
tree. The package's `TokenMonster_ExecutionStub.exe` must separately match the
installed root `TokenMonster.exe`, which is the real user entry point used by
the dual-gated packaged startup smoke; the job then silently uninstalls it.
Setup, the full package, and `RELEASES` are bound by physical file identity,
size, and SHA-256 before installation and after uninstall. Installer and
uninstaller processes have explicit time and process-tree cleanup bounds; the
startup smoke has explicit output, time, and close bounds. The full maker
verifier runs again after this flow before any signed artifact upload.

Windows packages ship without the tokscale collector binary: its runtime
manifest target is explicitly disabled until a Windows no-egress process
sandbox is audited, and the runtime already refuses to spawn it there. The
app shows the same collector-unavailable status as Windows development
builds; sidecar usage accounting is unaffected.

To build the same internal maker output locally, set the release version and run
`npm run make:internal` inside `apps/companion`. Direct package/make itself is
headless. A display (or `xvfb`) is needed only to launch the packaged Chromium
app; network is needed only when an exact Electron/tool artifact is absent from
the local cache.

### Signed Windows candidates

Signed mode runs only on the matching native host. Windows uses the modern
`windowsSign` integration shared by Electron Packager and
`electron-winstaller`, with SHA-256 only and the fixed HTTPS RFC3161 endpoint
`https://timestamp.digicert.com`. Configure a native Windows shell with:

```powershell
if (-not $env:TOKENMONSTER_NEXT_RELEASE_VERSION) {
  throw "Set TOKENMONSTER_NEXT_RELEASE_VERSION to a new, unused SemVer prerelease"
}
$env:TOKENMONSTER_RELEASE_VERSION = $env:TOKENMONSTER_NEXT_RELEASE_VERSION
$env:TOKENMONSTER_WINDOWS_CERTIFICATE_PATH = "C:\secure\tokenmonster.pfx"
$env:TOKENMONSTER_WINDOWS_CERTIFICATE_PASSWORD = "<secret>"
$env:TOKENMONSTER_WINDOWS_SIGNER_SUBJECT = "CN=..., O=..."
npm run make:companion:signed
```

The PFX path must be absolute, readable, regular, non-symbolic, and end in
`.pfx`; the expected subject must be the exact Authenticode certificate subject.
Legacy/custom `WINDOWS_*` signing overrides are rejected. The password and PFX
path are excluded from signer options and release evidence, and signing
subprocess debug/Node injection variables are removed so the required signtool
password argument is not logged.

The native verifier fails closed unless PowerShell reports `Valid`, the exact
signer subject, a timestamp certificate, and SHA-256 SignedCms digests for every
signable PE in the staged app, `TokenMonsterSetup.exe`, and full `.nupkg`, with
one narrow exception. Both signing passes preserve exactly
`resources/sidecar/node_modules/@mongodb-js/zstd/build/Release/zstd.node` because
the runtime's checked-in native policy requires its reviewed raw size and
SHA-256; adding Authenticode would change those bytes and make the sidecar fail
closed. The signing hook skips only that exact path after validating it against
the Windows native policy. Staging and nupkg verification then require exactly
one such exemption and bind it to the complete sidecar inventory; every other
PE still requires Authenticode. A `.nupkg` is a ZIP container, not an
Authenticode binary, so evidence records its signed PE payloads and the separate
raw-policy-bound exception instead of claiming the container is signed.
The real release still requires the owner-controlled certificate/CI secrets and
a clean Windows install/update rehearsal.

## Installing a release tarball

Use a directory-local install:

```
mkdir tokenmonster-app && cd tokenmonster-app
npm install /path/to/tokenmonster-<version>.tgz
npx tokenmonster
```

Requires Node.js 24.15.0 and npm 11.12.1 exactly, matching the tested release
toolchain and runtime contract; other npm versions are unsupported. The public
package carries both exact engine requirements. The install fetches exactly one
package family from the registry: `tokentracker-cli` (the sidecar) and its
dependencies. npm consumes the release-embedded shrinkwrap, so transitive `^`
ranges in the upstream manifest cannot float beyond the reviewed versions and
package integrities in the repository lock.

**Native prebuild gate:** the checked-in
`packages/token-tracker-runtime/src/zstd-native-policy.json` binds the exact
`tokentracker-cli@0.80.0` → `@mongodb-js/zstd@2.0.1` chain to the reviewed
Linux x64, macOS arm64, and Windows x64 release archives and extracted
`build/Release/zstd.node` byte lengths/SHA-256 digests. Candidate assembly first
downloads and authenticates all three official archives into a fresh temporary
directory, then bundles only those exact archives with the fixed ten-file
`@mongodb-js/zstd` package inventory. npm therefore installs the current
platform binding from candidate-local bytes instead of making a second GitHub
request. That single authority
also pins the exact compiled runtime-verifier SHA-256, so merely preserving its
archive path cannot substitute verifier code. It ships in
`@tokenmonster/token-tracker-runtime`; the product verifies the actual resolved
sidecar package identity and current platform's native binding from local bytes
before spawning even the version-probe child. The installed-release smoke
repeats the same authority check. A missing prebuild, an unreviewed source
build, an unsupported platform, or any substituted byte fails closed; neither
the product nor smoke downloads verification material. Public tar inventory
also rejects case-folded, Unicode-normalized, reserved-name, and other
non-portable path collisions before platform extraction.

Release owners can repeat the separate controlled network audit with GnuPG
installed:

```
npm run audit:zstd-native-prebuild
```

That command downloads only the exact v2.0.1 archive and `.sig` URLs from the
official `mongodb-js/zstd` GitHub release plus
`https://pgp.mongodb.com/node-driver.asc`. It uses a fresh temporary keyring,
requires primary fingerprint
`9CABA99E47FA20E21F8409E5C6666E424A119C64`, verifies each detached signature,
then checks the pinned archive bytes/digest, safe single-entry tar layout, and
extracted binding bytes/digest. The mutable public key response is not checked
in or trusted by URL alone: both its official origin and exact fingerprint are
pinned. Temporary key/signature material and keyring are removed on success or
failure. Audit-only mode removes the archives as well. Candidate mode accepts
only `--all --output <fresh-directory>` and retains exactly the three
authenticated archives there; partial-platform output is forbidden. Run the
audit for all three platforms before approving any sidecar/zstd pin or policy
change. `npm run verify:zstd-native-prebuild` is the network-free check for the
current repository install. Release smoke uses a fresh npm cache and an
unreachable zstd binary host, so a missing local archive cannot be hidden by a
prior cache entry or successful network fallback.

The bundled `@mongodb-js/zstd@2.0.1` Apache-2.0 license and the Zstandard 1.5.6
BSD notice are required release inventory. Native redistribution still needs
the release owner/legal approval recorded by the deployment runbook; technical
authentication does not grant or infer TokenMonster's own project license.

**Do not use `npm install -g` on the tarball.** npm has a global-install quirk
with bundled dependencies: transitive install scripts (the sidecar's
`@mongodb-js/zstd` needs `prebuild-install`) run without the nested
`node_modules/.bin` on `PATH` and the install fails. Directory-local installs
hoist correctly on every platform.

## Testing from a repo clone (all platforms, including Windows)

Prerequisite: Node 24.15.0 and npm 11.12.1 exactly — the workspace root pins
both engines with `engine-strict`, so `npm ci` rejects any other version.
Adapt path quoting to the current shell; all invoked Node/npm tools are
cross-platform.

```sh
git clone <repo> && cd TokenMonster
npm ci
: "${TOKENMONSTER_NEXT_RELEASE_VERSION:?set a new, unused SemVer prerelease}"
candidate_dir="dist-release/$TOKENMONSTER_NEXT_RELEASE_VERSION"
zstd_parent="$(cd "$(mktemp -d)" && pwd -P)"
zstd_prebuilds="$zstd_parent/prebuilds"
node scripts/release/audit-zstd-native-prebuild.mjs \
  --all --output "$zstd_prebuilds"
node scripts/release/build-release.mjs \
  --version "$TOKENMONSTER_NEXT_RELEASE_VERSION" \
  --out "$candidate_dir" \
  --zstd-prebuilds "$zstd_prebuilds"
node scripts/release/verify-release-digest.mjs "$candidate_dir" --expected-version "$TOKENMONSTER_NEXT_RELEASE_VERSION"
mkdir tokenmonster-app
npm install --prefix tokenmonster-app "$candidate_dir/tokenmonster-$TOKENMONSTER_NEXT_RELEASE_VERSION.tgz"
node scripts/release/smoke-installed.mjs tokenmonster-app
```

Notes:

- Do NOT run a full workspace build on Windows (`npm run build` at the root);
  the Electron app's vite build currently fails there. The release script
  builds only the CLI's reviewed shipped workspace closure (dependency-closure
  scoping in `run-workspaces.mjs`), which is Windows-clean and CI-verified.
- `node scripts/release/smoke-installed.mjs <install-dir>` runs the same
  automated smoke CI uses against the directory you installed into. Before
  launch, it compares the installed consumer lock and every physical sidecar
  package identity with the release shrinkwrap and checks the current
  platform's zstd binding against the authenticated native policy; a
  substituted or incomplete dependency closure fails the smoke.
- On a machine with no real TokenTracker usage the dashboard is an honest
  empty state and every character stays locked. To exercise unlocks, wardrobe,
  and voice anyway, run `node scripts/qa/seed-demo-store.mjs` (after the
  release build) BEFORE the first launch — it writes a demo progression store
  and refuses to touch an existing one. Reset by deleting `~/.tokenmonster`.
- CI builds one immutable tarball artifact named
  `tokenmonster-release-candidate-<commit-sha>`; Linux, macOS, and Windows all
  download, digest-check, install, and smoke the same bytes rather than
  rebuilding platform-specific candidates.
