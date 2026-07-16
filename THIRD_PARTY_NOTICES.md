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
  to source commit `0325b0489130116b9ddc597accc7e521434b6c2e` in
  [`packages/characters/ai-sister-source-map.json`](packages/characters/ai-sister-source-map.json).
  It is a repository-only planning record, not a ship allowlist. If assets pass
  the release gate, rendered bundles and their integrity manifest are published
  from AI-Sister's existing Cloudflare R2/CDN; raw candidate parts remain in the
  AI-Sister production workspace and are not copied into TokenMonster.

## Project license

TokenMonster's own source and asset license remains undecided. Do not infer an
open-source or commercial license from the third-party MIT dependencies.
