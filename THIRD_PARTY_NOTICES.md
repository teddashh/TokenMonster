# Third-party and asset notices

This register is intentionally conservative. It records code and asset sources
before any public release. It is not a license for TokenMonster itself.

## tokscale

- Source: <https://github.com/junhoyeo/tokscale>
- Pinned foundation: npm package `tokscale@4.5.2` (exact, never a caret range)
- License: MIT
- Intended use: legacy migration-only collector for the current source slice.
  It is not part of the accepted sidecar runtime and receives no new product
  work while the TokenTracker cutover is being verified.
- Required action: preserve the upstream MIT notice in redistributed builds and
  gate every upgrade with golden contract/privacy fixtures.
- Packaged notice: the exact `v4.5.2` license text is vendored at
  `apps/companion/packaging/TOKSCALE_LICENSE.txt` and is a required, verified
  ASAR inventory entry.

## TokenTracker

- Source: <https://github.com/mm7894215/TokenTracker>
- Pinned foundation: commit `b9e881ae274e10534d05c80f653118848618e083`,
  npm package `tokentracker-cli@0.80.0`
- License: MIT
- Intended use: permanent, exact-pinned local collection sidecar behind the
  TokenMonster-owned process/loopback adapter. TokenMonster does not fork,
  vendor, deep-import, or read TokenTracker's private storage.
- Required action: preserve the upstream MIT copyright and permission notice
  in redistributed builds. The managed child sets
  `TOKENTRACKER_NO_TELEMETRY=1`; TokenMonster must not invoke upstream account
  or cloud-sync controls. Every upgrade requires reviewed contract, privacy,
  lifecycle, and cross-platform smoke tests before changing the exact pin.

## yauzl and pend

- Sources: <https://github.com/thejoshwolfe/yauzl> and
  <https://github.com/andrewrk/node-pend>
- Pinned production closure: `yauzl@3.4.0` -> `pend@1.2.0`, resolved with exact
  registry integrity in `package-lock.json`
- License: MIT for both packages
- Intended use: streaming, lazy ZIP parsing for the dormant, explicitly
  consented fixed character-pack verifier. Neither package contains native code
  or an install script.
- Required action: preserve each package's upstream `LICENSE` file in any
  artifact that physically bundles this closure. The release verifier must
  continue to bind their exact names, versions, resolved registries, integrity,
  dependency identities, and physical package bytes.

## @mongodb-js/zstd and Zstandard

- Sources: <https://github.com/mongodb-js/zstd> and
  <https://github.com/facebook/zstd>
- Pinned production closure: `tokentracker-cli@0.80.0` ->
  `@mongodb-js/zstd@2.0.1`, with the native implementation built against
  Zstandard `1.5.6`
- Licenses: Apache-2.0 for `@mongodb-js/zstd`; BSD for the statically linked
  Zstandard implementation
- Intended use: the exact native compression dependency already required by
  the reviewed TokenTracker sidecar. TokenMonster does not add a second usage
  collector or import TokenTracker parser/hook code.
- Native source authority: the three release archives come from the official
  `mongodb-js/zstd` GitHub release and must pass the pinned MongoDB signer,
  redirect, detached-signature, archive SHA-256, single-entry layout, and native
  binding SHA-256 policy before candidate assembly. They are generated only in
  runner temporary/staging storage and are never committed to this repository.
- Packaged notices: the exact Apache-2.0 `LICENSE.md` from
  `@mongodb-js/zstd@2.0.1` remains inside the bundled dependency. The exact
  Zstandard `v1.5.6` BSD text is packaged at
  `packages/cli/THIRD_PARTY_LICENSES/Zstandard-1.5.6-BSD.txt`.
- Required action before public release: release owner/legal must approve
  redistribution of this exact native binary set and retention of both notices.
  This technical provenance and notice work does not choose TokenMonster's own
  license or replace that approval.

## Squirrel.Windows updater candidate

- Source: <https://github.com/Squirrel/Squirrel.Windows>
- Pinned source: base commit `eef37460aef77b2f9de8cd2237c1e55b344a6554`
  plus upstream fix commit `c98244936f6876b080366417301268058028a53c`.
- The reviewed internal binary is not tracked in this repository. Its
  reproducible-build receipts, provenance, and integration review remain bound
  under `apps/companion/packaging/squirrel-windows/`; Windows Squirrel
  packaging fails closed unless a privately stored reviewed binary matching
  the `integration-review.json` receipt is restored to that directory.
- Intended use: replace only the known-buggy `Squirrel.exe` in a disposable,
  fully inventoried `electron-winstaller@5.4.4` vendor overlay.
- Runtime license inventory: Squirrel.Windows MIT; the pinned NuGet fork
  Apache-2.0; `Microsoft.Web.Xdt@3.1.0` rebuilt from the Apache-2.0
  `dotnet/xdt` source (never the EULA-bound 2.1.1 DLL); WpfAnimatedGif 1.4.15
  Apache-2.0; Mono.Cecil 0.11.2 MIT; DeltaCompressionDotNet 1.1.0 under the
  selected MS-PL option; and SharpCompress 0.17.1 MIT with its embedded
  third-party notices.
- The complete redistribution notice bundle lives at
  `apps/companion/packaging/squirrel-windows/licenses/MERGED-RUNTIME-NOTICES.md`
  and must accompany every public distribution of the Windows Squirrel
  installer artifacts.
- Status: `approved-unsigned-public-test-pending-signing`. Unsigned public
  test installers may ship with the notice bundle after the native
  clean-install/start/uninstall smoke passes; Authenticode-signed
  distribution stays closed until audited signing credentials exist and the
  signed install review passes.

ILRepack 2.0.24 is a reproducible-build tool rather than runtime code. Its
Apache-2.0 license remains in the build artifact provenance; it is not presented
as a license for the merged runtime components.

## token-monitor

- Source: <https://github.com/Javis603/token-monitor>
- License: MIT
- Intended use: architecture reference only for multi-device sync, SSE, and
  Cloudflare deployment patterns. No source has been imported.

## ai-avatar-bot

- Source: <https://github.com/YuriCrystal/ai-avatar-bot>
- Code license: MIT
- Intended use: interaction-engine reference only. No source or sample model
  has been imported.
- Excluded from production: the Haru sample model, Live2D Cubism proprietary
  runtime, and the unofficial `msedge-tts` service path.

## AI-Sister character work

- Source repository: <https://github.com/teddashh/Multi-Ai-Chatapp>, pinned for
  review to commit `02c65ae57113fc29c64ab0a8835adc2e300b764f`.
- Candidate MVP assets: the four tracked WebP portraits for ChatGPT, Claude,
  Gemini, and Grok; a curated, transcoded subset of owner-approved full-body
  artwork may be added later.
- Current rights status: the source repository has no standalone license and
  its README says personal use only. The separate full-body asset workspace is
  not git-backed and has no complete provenance/license record.
- Required action before public release: owner approval in writing, generation
  and edit history where available, an
  explicit commercial/public-use decision, and an unaffiliated/fan-character
  disclosure. Real-speaker voice references and generated voice clones are not
  approved for TokenMonster.
- Provenance gate: candidate source paths, immutable commit, dimensions and
  SHA-256 values are recorded in
  [`packages/characters/asset-manifest.json`](packages/characters/asset-manifest.json).
- A broader roster, wardrobe, pose, and layered-parts audit is separately pinned
  to source commit `77b317b95b6047f1de330d5d41e4edab38de3b44` in
  [`packages/characters/ai-sister-source-map.json`](packages/characters/ai-sister-source-map.json).
  It is a repository-only planning record, not a ship allowlist. If assets pass
  the release gate, rendered bundles and their integrity manifest are published
  from AI-Sister's existing Cloudflare R2/CDN; raw candidate parts remain in the
  AI-Sister production workspace and are not copied into TokenMonster.

## Project license

TokenMonster's own source code is licensed under the MIT License; see the
[`LICENSE`](LICENSE) file at the repository root. Third-party components and
character assets remain subject to their own licenses and grants as documented
in this file.
