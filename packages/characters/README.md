# `@tokenmonster/characters`

Strict TypeScript character catalog, visual release gate, and offline fixed-line
engine for TokenMonster.

The starter-sister catalog has four stable IDs:

| ID        | Alias | Inspiration               |
| --------- | ----- | ------------------------- |
| `chatgpt` | Aster | OpenAI ChatGPT-inspired   |
| `claude`  | Cedar | Anthropic Claude-inspired |
| `gemini`  | Mira  | Google Gemini-inspired    |
| `grok`    | Rook  | xAI Grok-inspired         |

Every entry is explicitly `provider-inspired` and
`independent-unaffiliated`. The characters are fictional TokenMonster
presentations; they do not claim provider affiliation, partnership,
endorsement, billing authority, or access to hidden user content.

Consumers that need only catalog data can import the tree-shakable,
asset-independent `@tokenmonster/characters/catalog` subpath.

The separate `@tokenmonster/characters/asset-pack` subpath contains the strict
fixed-pack verification/cache primitive used only by the gateway-owned
explicit consent lifecycle. It remains absent from the main import. The
repository's `packages/characters/ASSET_PACK.md` records its request contract,
rights/descriptor gates, restart behavior, and revocation rules; that
subpath and implementation are part of the release package. The current three
generated slots authorize combined release
`ai-sister-media-11-voice55-2026.07.23` at reviewed origin
`https://cdn.ted-h.com` and the generated exact pack path; they do not authorize
any per-object request.

The companion progression roster is broader: 11 visible character IDs,
including GLM as a friend. The progression-only `reserved` sentinel is not a
twelfth persona and is never a CDN character ID.

## Starter selection

`selectStarterCharacter` maps the four audited local provider families to the
four stable character IDs. An explicit user choice always wins. Otherwise it
selects only a unique highest positive 28-day provider total; a tie, all-zero
history, or unavailable provider data returns `user-choice-required` so the UI
can show all four choices.

The result is presentation only. Provider totals do not become XP, power,
levels, rank, wardrobe access, or character capability, and the selector does
not return the input totals.

## Runtime use

```ts
import {
  createCharacterPresentation,
  selectFixedLine,
} from "@tokenmonster/characters";

const presentation = createCharacterPresentation("gemini", {
  mood: "steady",
  traits: ["multi-tool"],
});

const line = selectFixedLine({
  characterId: "gemini",
  locale: "zh-TW",
  trigger: "new-tool",
  mood: "steady",
  traits: ["multi-tool"],
  seed: 17,
});
```

`createCharacterPresentation` receives a readonly trait view and returns only
presentation data. Changing a character never recomputes or mutates monster
traits.

`selectFixedLine` is deterministic and local. Its strict input boundary accepts
only an allowlisted character, locale, trigger, mood, traits, and numeric seed.
It does not accept usage records, user prompts, file paths, or session data, and
it performs no network request.

`selectTapLine` adds the same local-only behavior for the full 11-character
roster. The four starter sisters reuse their existing `greeting` content IDs;
the seven friends have separate original, general-audience `zh-TW` and `en`
copy with three deterministic variants each. Tap selection accepts only a
character ID, one of those two locales, and a bounded numeric seed.

Fixed-line content schema `1`, content version `1.0.0`, and both `zh-TW` and
`en` copy cover these triggers:

- `greeting`
- `idle`
- `above-baseline`
- `below-baseline`
- `new-tool`
- `night`
- `collector-error`

Selections include character-and-trigger cooldown metadata. Copy is supportive:
it does not shame the user, state billing conclusions, or encourage additional
token consumption.

Every catalog line is parsed through a strict runtime schema and carries a
general-audience rating, an original-copy provenance ID, an explicit
`project-license-pending` status, and a deterministic general fallback ID for
tone variants. That pending status is intentional: the repository's project
license must be decided before an external release.

## Visual release gate

A code-native letter-character placeholder is always available. The legacy
`resolveCharacterVisual` and `resolveCharacterVisualFromManifest` APIs always
return that placeholder. Release staging additionally places an exact built-in
starter set beneath `dist/embedded-starter-assets/`: eight approved WebPs,
415,470 bytes total, containing one avatar and one `tech` base outfit for each
of ChatGPT, Claude, Gemini, and Grok. `getEmbeddedStarterAssetConfiguration()`
validates that complete inventory, byte count, SHA-256, and WebP signature
all-or-nothing; an ordinary source build has no staged raster directory and
returns `null` instead of weakening the letter fallback. The package also
compiles 168 original fixed text lines for those four starters: seven triggers,
three variants, and the `zh-TW` and `en` locales. These lines are text, not
prerecorded voice.

`getApprovedAssetManifest()` reads the package's generated rights-authority
slot, `src/approved-release-v2.json`.
`getApprovedAssetPackConfiguration()` joins it with the generated
`src/approved-asset-pack-descriptor-v1.json` and
`src/approved-asset-pack-allowlist-v1.json` transport slots. All three are
non-null and strictly cross-bound to combined release
`ai-sister-media-11-voice55-2026.07.23`: 891 image associations and 55 voice
associations for 11 characters, 946 entries total, manifest canonical SHA-256
`21e4675653ce66b50b61e91260f1623e6e3005177f900991e3a8eeadaf9e6474`, and
one 73,261,088-byte ZIP with SHA-256
`7d98e0d18c470f82818e8ada67208847c3cf4ff5c10cb5f99f9215191e981f30`.
The complete combined pack is not copied into the npm tarball. Only the exact
eight starter WebPs above are release-staged there; no audio binary is
embedded.

The four entries pinned in [`asset-manifest.json`](asset-manifest.json) remain
historical schema-v1 candidate records and do not themselves grant rights.
Their former `blocked` values are superseded for the current combined release
by the structured v2 authority and its private approval evidence. Those legacy
rows do not authorize or select the release-staged starter subset; the release
policy cross-binds each of the eight exact bytes to the current v2 authority.
The manifest and its schema are repository-only audit records and are excluded
from the package's release files. The historical
`src/approved-manifest.json` likewise contains schema-v1 integrity metadata,
not public rights approval; release staging removes it and rejects every
character runtime JSON except the exact three generated release slots. Its
historical name must not be treated as a legal or brand decision.

Every new image or voice association must pass schema v2 (or later) with the
complete structured provenance, grant/license scope, brand/content review,
disclosure, and release fields in the technical specification. The current 891
image rows and 55 voice rows passed that gate. Existing schema-v1 rows are not
grandfathered; source availability and a successful hash build are not
approval.

The broader AI-Sister roster, 20 wardrobe themes, pose vocabulary, layered
candidate inventory, semantic action map, and planned delivery boundary are
recorded in [`ai-sister-source-map.json`](ai-sister-source-map.json). That map
and its schema are also repository-only and never compile into this package.
The approved pre-rendered media pack and manifest are published on AI-Sister's
Cloudflare R2/CDN. The reviewed origin is `https://cdn.ted-h.com`; immutable
paths remain below `/tokenmonster/characters/v1/` and are authorized only by
the generated exact-path allowlist.

The TokenMonster gateway still rejects per-object origins and accepts only
`cdnBaseUrl: null`; selected-file requests would reveal local progression
through their public hashes. Its separate fixed-pack consent path makes exactly
one state-independent request after the player explicitly enables it. Default,
no-consent, offline-without-cache, failed, and revoked states remain zero-GET:
the four original starters use their release-embedded avatar, `tech` outfit,
and bilingual text, while art outside that base uses the letter/silent fallback.
A failed install or revocation returns to the same base set. Raw layered parts
are not copied or downloaded.

Voice playback is local-preference controlled and defaults off. The gateway
exposes only bounded lines for unlocked characters, and shipping entry points
play only hash-verified WAV cache hits. Trigger-selected network fetches are
disabled. The combined pack contains 55 canonical, metadata-stripped WAVs:
five triggers for each of the 11 characters. Every row uses
`owner-authorized-reference-clone` evidence with an opaque
owner/rights-holder authorization reference and a separate
spoken-content-review reference; no private receipt contents are copied into
the public manifest. The audio remains outside the npm tarball and becomes
available only with the complete explicitly consented pack.

## Monster-engine integration

Mood and trait IDs are imported directly from
`@tokenmonster/monster-engine@0.1.0`. Use
`createCharacterPresentationFromMonsterDerivation` and
`selectFixedLineFromMonsterDerivation` to pass an actual validated derivation
through the strict content-blind projection. Character switching changes only
presentation and preserves those exact engine IDs.

## Structured persona context

Each catalog entry exposes a versioned, structured persona context suitable for
a later BYOK adapter. It contains tone guidance, a visible-context allowlist,
and machine-readable safeguards. It is data rather than a provider-system-prompt
claim, and must remain separated from credentials and hidden content.

## Dependencies and commands

Runtime dependencies are pinned exactly to the workspace monster engine at
`0.1.0`, `zod@4.4.3`, and the streaming ZIP parser `yauzl@3.4.0`. The latter's
production closure is only `pend@1.2.0`; both are JavaScript-only and have no
install scripts. TypeScript, Vitest, and the dev-only ZIP fixture writer are
supplied through the workspace development install.

```sh
npm run typecheck --workspace @tokenmonster/characters
npm test --workspace @tokenmonster/characters
npm run build --workspace @tokenmonster/characters
```
