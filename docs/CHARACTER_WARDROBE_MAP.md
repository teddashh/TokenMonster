# TokenMonster character and wardrobe map

Status: integrity/runtime contract with public rights gate pending. Ten
art-backed personas are schema-v1 integrity-allowlisted; GLM intentionally uses
TokenMonster's built-in letter renderer.

This document defines how TokenMonster may reuse the existing AI-Sister
character work without copying its publishing pipeline or pretending that
unverified assets exist. The character is companionship and presentation; it
does not change collection accuracy, model capability, quotas, or product
power.

## Audited source and inventory truth

The source audit used the AI-Sister repository's `origin/main` commit:

```text
77b317b95b6047f1de330d5d41e4edab38de3b44
```

The active canonical roster at that commit is **four sisters plus seven
friends**, or eleven personas total:

| Role | Stable ID | Display name | Notes |
| --- | --- | --- | --- |
| sister | `chatgpt` | ChatGPT | Visual-generation material also calls her Codex; this is one persona, not two. |
| sister | `claude` | Claude | Default starter candidate. |
| sister | `gemini` | Gemini | Default starter candidate. |
| sister | `grok` | Grok | Default starter candidate. |
| friend | `deepseek` | DeepSeek | Present in the older wardrobe bank. |
| friend | `qwen` | Qwen | Present in the older wardrobe bank. |
| friend | `mistral` | Mistral | Present in the older wardrobe bank. |
| friend | `venice` | Llama | `venice` is the internal ID; Llama is the display identity. |
| friend | `sakana` | Sakana | Present in the older wardrobe bank. |
| friend | `perplexity` | Perplexity | Present in the older wardrobe bank. |
| friend | `glm` | GLM | Canonical persona, but absent from the older wardrobe matrix. |

There is no eighth friend in the audited canonical type, manifest, avatar set,
or guest catalog. The intended eighth friend remains unresolved. Do not mint a
placeholder ID, infer one from an image filename, or reserve published CDN
paths until the character is explicitly defined and approved.

The older persona-design matrix contains ten personas: the four sisters plus
Sakana, DeepSeek, Qwen, Mistral, Llama, and Perplexity. Its contracted geometry
is:

- 10 personas x 20 themes = 200 wardrobe cells;
- one outfit image per cell = 200 outfit slots;
- three reaction poses per cell = 600 pose slots;
- one custom layered set per cell = 200 layered-set slots.

The release-embedded schema-v1 integrity manifest covers those 200 wardrobe
cells, their pose objects, and 50 prerecorded WAV refs (five for each of the
same ten personas). The raw bank and layered files
remain outside the audited Git tree in AI-Sister's voice-lab workspace. GLM
therefore stays in letter mode and has no downloadable wardrobe or pose
objects or voice lines. This inventory is not public rights approval; all 860
associations still require the schema-v2 evidence in the technical spec.

## Stable theme map

Themes are cosmetic facets. A facet may change clothing, palette, ambient
scene, and scripted presentation tone. It must not change a character's
abilities, collector behavior, usage totals, rewards, or rank.

| Theme slug | Cosmetic style-facet ID | Optional recommendation trait |
| --- | --- | --- |
| `tech` | `builder` | `cli-focused` |
| `finance` | `planner` | `cache-savvy` |
| `politics` | `civic-strategist` | `multi-provider` |
| `education` | `mentor` | `tool-focused` |
| `health` | `caretaker` | `balanced` |
| `environment` | `steward` | `cache-savvy` |
| `law` | `guardian` | `provider-focused` |
| `relationship` | `listener` | `multi-provider` |
| `family` | `nurturer` | `balanced` |
| `workplace` | `organizer` | `cli-focused` |
| `science` | `researcher` | `tool-focused` |
| `culture` | `storyteller` | `multi-tool` |
| `sports` | `challenger` | `output-heavy` |
| `food` | `host` | `balanced` |
| `travel` | `explorer` | `multi-tool` |
| `psychology` | `reflector` | `night-oriented` |
| `philosophy` | `thinker` | `provider-focused` |
| `international` | `connector` | `multi-provider` |
| `media` | `communicator` | `output-heavy` |
| `festival` | `celebrator` | `output-heavy` |

The facets above normalize the source slugs for TokenMonster. They are tags,
not numerical attributes. A matching workflow trait may recommend a look, but
is never an unlock requirement. In particular, the legacy Chinese forum
category `生活` normalized to `psychology`; `life` is not a twenty-theme slug.

## Source asset vocabulary

The source matrix exposes four visual asset keys:

```text
outfit
supported
challenged
victory
```

The source path convention is informative for the AI-Sister publisher, not a
runtime path contract for TokenMonster:

```text
<voice-lab-root>/tachie/outfits_v2_norm/
  doll_<persona>__<theme>.png

<voice-lab-root>/tachie/poses/react/
  doll_<persona>__<theme>__supported.png
  doll_<persona>__<theme>__challenged.png
  doll_<persona>__<theme>__victory.png

<voice-lab-root>/tachie/parts/
  <persona>__<theme>__v2_parts/
```

The `v2_parts` output is a project-specific layered **2.5D** representation. It
is not a Live2D, Spine, VRM, Rive, GLTF, or other standard rig. TokenMonster
must not describe it as one, depend on undocumented raw layer filenames, or
embed the AI-Sister generation scripts. The public bundle format defined below
is the only integration boundary.

## Semantic state and action map

TokenMonster owns transient companion state. AI-Sister owns approved visual
assets. State, action, and wardrobe theme remain separate dimensions:

```text
persona + theme + semantic action + bundle version
```

| TokenMonster semantic state | Source pose | Preferred actions |
| --- | --- | --- |
| `idle-static` | `outfit` | none |
| `idle` | `outfit` | `preen`, `tidy_hair`, `sip` |
| `connecting` | `outfit` | `lean_in`, `tilt` |
| `learning` | `outfit` | `tilt`, `lean_in` |
| `resting` | `outfit` | `sip`, `stretch` |
| `quiet` | `outfit` | `check_phone`, `tidy_hair` |
| `steady` | `supported` | `nod`, `lean_in` |
| `lively` | `supported` | `laugh`, `applause` |
| `notice` | `outfit` | `tilt`, `lean_in` |
| `error` | `challenged` | `frown`, `shake` |
| `wardrobe-unlocked` | `victory` | `applause`, `laugh`; celebrates a locally recorded milestone without assigning power or rank |

Every moving state has an `idle-static` reduced-motion fallback. Asset fallback
order is deterministic:

1. requested persona + theme + action;
2. requested persona + theme + `outfit`;
3. requested persona + approved default theme + `outfit`;
4. built-in lightweight letter renderer.

Missing visual assets never change the underlying collector or metrics state.
They only change presentation.

## Starter selection

The four sisters are the default starter candidate set. Selection happens
locally from a privacy-safe 28-day aggregate, if that aggregate is available:

| Local provider family | Starter persona |
| --- | --- |
| OpenAI, ChatGPT, or Codex | `chatgpt` |
| Anthropic or Claude | `claude` |
| Google or Gemini | `gemini` |
| xAI, Grok, or Grok Build | `grok` |

The algorithm is:

1. Sum each supported provider family's local token usage over the latest 28
   UTC dates, including the current UTC date, using a versioned, content-blind
   aggregate contract.
2. If exactly one provider has the strictly highest positive total, choose its
   sister as the suggested starter.
3. If the maximum is tied, all totals are zero, history is absent, or the
   provider dimension is unavailable, show the four-sister manual picker.
4. The user may always override the suggestion. Store the choice locally.

The pinned sidecar's fixed model-breakdown route exposes source-level totals.
The implemented TokenMonster adapter accepts only exact source IDs for these
four families and never infers a provider from a model name. If that optional
projection is missing, malformed, or unavailable, totals and charts continue
to work and TokenMonster uses the manual picker.
No provider totals, selection rationale, or usage-selected asset key are sent
to an asset CDN or TokenMonster cloud. Current release entry points are
cache-only. A future user-consented request may identify only a fixed pack and
version; its object set and order must not vary with persona, theme, unlock,
pose, trigger, or any usage-derived state.

## Unlock and progression rules

Tokens remain measurements, not spendable game currency. Progression is
local-only, monotonic, explainable, and never purchasable:

- the uniquely highest positive OpenAI/Anthropic/Google/xAI family selects and
  unlocks its starter sister; a manual sister choice takes precedence;
- ChatGPT, Claude, Gemini, and Grok also unlock at the first local token for
  their corresponding family;
- DeepSeek and Qwen use their own cumulative family totals; Mistral and
  Perplexity use active-day streaks; Venice/Llama and GLM use lifetime totals;
  Sakana uses distinct active-provider breadth;
- after a character unlocks, its 20 ordered wardrobe themes currently unlock
  from that character's local provider-family cumulative total. A matching
  local trait can move a theme ahead by one tier. This implementation cannot
  advance GLM because pinned sidecar source `zcode` is co-mingled and remains
  `other`; GLM art must not merge until a reviewed per-character lifetime
  wardrobe rule and monotonic migration fixtures replace this target-contract
  gap;
- `supported` and `challenged` pose sets are available with character unlock;
  `victory` and allowlisted actions use active-day-streak milestones;
- persisted unlock timestamps prevent rescans, corrections, or later quiet
  periods from relocking an item.

The UI explains progress without praising high volume, shaming low/zero usage,
assigning power or rank, or encouraging wasteful token burn.

## Publishing boundary

After the schema-v2 rights gate, approved pre-rendered immutable objects may be
published to AI-Sister's existing Cloudflare R2/CDN under the dedicated prefix:

```text
tokenmonster/characters/v1/
```

Conditional publisher object layout:

```text
tokenmonster/characters/v1/objects/<sha256>.<webp|png|wav>
```

These per-object paths are publisher inventory, not a runtime lazy-fetch
contract. Current TokenMonster entry points are network-disabled; any future
runtime transport must use the consented fixed-pack boundary below.

AI-Sister retains:

- raw layered parts and source artwork;
- generation prompts and generation tooling;
- approval ledger and rights evidence;
- the publisher that validates, renders, packages, hashes, and uploads bundles;
- rollback authority for a published asset version.

The target schema-v2 boundary lets TokenMonster receive only public,
rights-approved output. The current schema-v1 runtime manifest is a historical
integrity exception and remains a public-release STOP until migration. In
either case TokenMonster does not mount the voice-lab workspace, read AI-Sister
databases, deep-import AI-Sister code, or become a second asset publisher.

## Release manifest contract

The target strict schema-v2 manifest is embedded in the TokenMonster release
rather than downloaded at runtime and lists only objects that passed the public
release gate. The current embedded schema-v1 manifest records integrity and
association only and does not meet that approval contract. Each object records
at least its relative hash-named path, bytes, SHA-256, media shape, and its
character/theme/pose or voice association:

```json
{
  "path": "objects/<sha256>.webp",
  "bytes": 63198,
  "sha256": "<lowercase-hex-sha256>",
  "width": 347,
  "height": 840
}
```

Paths are relative and contain no local filesystem location, user identifier,
prompt, credential, or arbitrary external URL. The current schema-v1 runtime
manifest contains ten characters with 20 themes each and 50 voice lines (five
per character); GLM has neither image nor voice entries. These integrity rows
lack structured public rights evidence and are not grandfathered into approval.

Published manifest and bundle versions are immutable. Correction means
publishing a new version and updating the top-level manifest; it never means
silently replacing bytes beneath an existing hash.

## Download, cache, and integrity behavior

The gateway accepts only `cdnBaseUrl: null` and has no network fetch hook or
per-object downloader. It may serve only integrity-verified bytes already under
`~/.tokenmonster/asset-cache`; a miss returns a local letter fallback or silence
without network access. `--no-character-downloads` is a backward-compatible
no-op while this fail-closed policy is active.

The previous per-object downloader is not a release-safe design. Public
manifest associations let a CDN map a hash key back to a character, theme,
pose, or voice trigger. Requests chosen by starter, unlock, today totals, or
connection state would therefore disclose local usage-derived state even with
no query string.

The dormant `@tokenmonster/characters/asset-pack` subpath now implements the
verification/cache mechanics below, but no current runtime imports it. A real
downloader remains blocked on a rights-approved schema-v2 manifest, embedded
pack descriptor and exact origin/path allowlist, consent UI, and installed
packet-capture review. When those release inputs exist, the wiring must:

1. run only after a separate, sufficiently disclosed user action;
2. fetch one fixed, versioned pack whose request set and order are independent
   of all local usage, selection, progression, pose, and trigger state;
3. accept only an allowlisted HTTPS origin and reject redirects;
4. enforce bounded transfer and extraction sizes;
5. verify each schema-v2 entry's bytes, media type, and SHA-256 before display
   or an atomic mode-`0600` cache write;
6. reverify every cache hit and delete corrupt or oversized entries;
7. retain verified objects for offline use and fall back locally on any error;
8. perform all character, theme, pose, and voice selection only after the full
   pack is local.

Prerecorded voice playback defaults off. The gateway exposes bounded lines
only for unlocked characters: `greeting` is gesture-armed and once per
character/UI session, `unlock` accompanies its toast, `quiet`/`active` reflect
a healthy zero/nonzero today aggregate with a one-hour trigger throttle, and
`error` fires only on entry to refresh-failed. Current entry points play these
only from verified cache, so the trigger never becomes a network key.

## Rights and brand gate

No character bundle may be uploaded under the public prefix until a human has
recorded both:

- rights approval for the source and derivative artwork; and
- brand approval for names, logos, marks, costume treatment, and public use.

Approval must identify the exact persona, theme, action set, source revision,
publisher revision, and output hashes. A technically complete asset with
missing or ambiguous rights remains unpublished. The unresolved eighth friend,
GLM wardrobe expansion, and any regenerated brand-mark artwork all pass this
same gate.

## Acceptance criteria for the first asset release

- A public release embeds a schema-v2 rights-approved manifest for ten
  art-backed roster members, each with 20 themes and pose art; any included
  voice has its independent evidence, and GLM reliably uses letter mode until
  its own art and progression gates pass.
- Every published file is immutable and integrity-addressed.
- A clean TokenMonster install remains fully usable in letter/silent mode and
  makes no asset request. After the separately reviewed fixed-pack flow exists,
  an explicit download can validate, cache, and render without access to
  AI-Sister source or voice-lab paths.
- Tie, no-data, and missing-provider-dimension cases show the manual starter
  picker.
- Reduced motion works for every published bundle.
- A missing theme, action, GLM cell, or unresolved persona degrades to a visual
  fallback without fake data or a collector failure.
- Local milestones may unlock characters, themes, poses, and actions, but no
  path treats tokens as currency, purchasable progression, power, or rank.
