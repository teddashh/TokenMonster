# Third-party and asset notices

This register is intentionally conservative. It records code and asset sources
before any public release. It is not a license for TokenMonster itself.

## tokscale

- Source: <https://github.com/junhoyeo/tokscale>
- Pinned foundation: npm package `tokscale@4.5.2` (exact, never a caret range)
- License: MIT
- Intended use: default local collector executable behind a TokenMonster-owned
  adapter. Raw session and project fields are discarded before persistence.
- Required action: preserve the upstream MIT notice in redistributed builds and
  gate every upgrade with golden contract/privacy fixtures.
- Packaged notice: the exact `v4.5.2` license text is vendored at
  `apps/companion/packaging/TOKSCALE_LICENSE.txt` and is a required, verified
  ASAR inventory entry.

## TokenTracker

- Source: <https://github.com/mm7894215/TokenTracker>
- Pinned foundation: commit `82d0c345cee5aaf486a97d9801d8212b489da775`,
  npm package `tokentracker-cli@0.79.8`
- License: MIT
- Intended use: optional, mutually exclusive process/loopback bridge for users
  already running TokenTracker. The dedicated fork is
  <https://github.com/teddashh/tokenmonster-collector>.
- Required action: preserve the upstream MIT copyright and permission notice
  in any redistributed collector build. The bridge must set
  `TOKENTRACKER_NO_TELEMETRY=1` and must not enable upstream cloud sync.

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

## Project license

TokenMonster's own source and asset license remains undecided. Do not infer an
open-source or commercial license from the third-party MIT dependencies.
