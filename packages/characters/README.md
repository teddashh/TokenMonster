# `@tokenmonster/characters`

Strict TypeScript character catalog, visual release gate, and offline fixed-line
engine for TokenMonster.

The catalog has four stable IDs:

| ID | Alias | Inspiration |
| --- | --- | --- |
| `chatgpt` | Aster | OpenAI ChatGPT-inspired |
| `claude` | Cedar | Anthropic Claude-inspired |
| `gemini` | Mira | Google Gemini-inspired |
| `grok` | Rook | xAI Grok-inspired |

Every entry is explicitly `provider-inspired` and
`independent-unaffiliated`. The characters are fictional TokenMonster
presentations; they do not claim provider affiliation, partnership,
endorsement, billing authority, or access to hidden user content.

Consumers that need only catalog data can import the tree-shakable,
asset-independent `@tokenmonster/characters/catalog` subpath.

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

A code-native letter-character placeholder is always available. The v1 runtime
approved-asset allowlist is intentionally empty: `resolveCharacterVisual` and
`resolveCharacterVisualFromManifest` always return a placeholder. In
particular, flipping the legacy v1 manifest's three status strings cannot
release an asset because that schema does not contain the complete structured
rights evidence required by the technical specification.

The four entries currently pinned in
[`asset-manifest.json`](asset-manifest.json) all remain blocked pending an
explicit redistribution grant and brand review. No AI-Sister portrait binary is
copied into this package. The manifest and its schema are repository-only audit
records and are excluded from the package's release files. A real portrait
requires a future schema v2 (or later), complete rights fields, and a separate
reviewed runtime allowlist change; source availability alone is not approval.

The broader AI-Sister roster, 20 wardrobe themes, pose vocabulary, layered
candidate inventory, semantic action map, and planned delivery boundary are
recorded in [`ai-sister-source-map.json`](ai-sister-source-map.json). That map
and its schema are also repository-only and never compile into this package.
After approval, pre-rendered versioned assets remain on AI-Sister's existing
Cloudflare R2/CDN under `tokenmonster/characters/v1`; TokenMonster downloads
only the selected files on demand, verifies their hashes, and caches them
locally. Raw layered parts are not copied or downloaded.

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
`0.1.0` and `zod@4.4.3`. TypeScript and Vitest are supplied by the root
workspace.

```sh
npm run typecheck --workspace @tokenmonster/characters
npm test --workspace @tokenmonster/characters
npm run build --workspace @tokenmonster/characters
```
