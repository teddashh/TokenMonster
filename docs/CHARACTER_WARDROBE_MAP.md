# TokenMonster character and wardrobe map

Status: launch contract. Ten art-backed personas are release-allowlisted;
GLM intentionally uses TokenMonster's built-in letter renderer.

This document defines how TokenMonster may reuse the existing AI-Sister
character work without copying its publishing pipeline or pretending that
unverified assets exist. The character is companionship and presentation; it
does not change collection accuracy, model capability, quotas, or product
power.

## Audited source and inventory truth

The source audit used the AI-Sister repository's `origin/main` commit:

```text
0325b0489130116b9ddc597accc7e521434b6c2e
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

The release-embedded manifest now covers those 200 wardrobe cells and their
pose objects for the ten art-backed personas. The raw bank and layered files
remain outside the audited Git tree in AI-Sister's voice-lab workspace. GLM
therefore stays in letter mode and has no downloadable wardrobe or pose
objects.

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
No provider totals or selection rationale are sent to the asset CDN or
TokenMonster cloud. A bundle request necessarily identifies the requested
public persona/theme object to the CDN; TokenMonster sends no separate
selection record, user identifier, or usage-derived value with it.

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
- after a character unlocks, its 20 ordered wardrobe themes unlock from that
  character's local provider-family cumulative total. A matching local trait
  can move a theme ahead by one tier;
- `supported` and `challenged` pose sets are available with character unlock;
  `victory` and allowlisted actions use active-day-streak milestones;
- persisted unlock timestamps prevent rescans, corrections, or later quiet
  periods from relocking an item.

The UI explains progress without praising high volume, shaming low/zero usage,
assigning power or rank, or encouraging wasteful token burn.

## Publishing boundary

Approved, pre-rendered, immutable objects live in AI-Sister's existing
Cloudflare R2/CDN under the dedicated prefix:

```text
tokenmonster/characters/v1/
```

Runtime public layout:

```text
tokenmonster/characters/v1/objects/<sha256>.<webp|png|wav>
```

AI-Sister retains:

- raw layered parts and source artwork;
- generation prompts and generation tooling;
- approval ledger and rights evidence;
- the publisher that validates, renders, packages, hashes, and uploads bundles;
- rollback authority for a published asset version.

TokenMonster receives only the public, approved output. It does not mount the
voice-lab workspace, read AI-Sister databases, deep-import AI-Sister code, or
become a second asset publisher.

## Release manifest contract

The strict manifest is embedded in the TokenMonster release rather than
downloaded at runtime. It lists only objects that passed the release gate. Each
object records at least its relative hash-named path, bytes, SHA-256, media
shape, and its character/theme/pose or voice association:

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
prompt, credential, or arbitrary external URL. The current manifest contains
ten characters with 20 themes each and an empty `voice` list.

Published manifest and bundle versions are immutable. Correction means
publishing a new version and updating the top-level manifest; it never means
silently replacing bytes beneath an existing hash.

## Download, cache, and integrity behavior

TokenMonster downloads an approved object only after its character/theme is
unlocked. It uses the single configured HTTPS CDN origin and caches verified
bytes under `~/.tokenmonster/asset-cache`, outside the repository.

The client must:

1. fetch only fixed HTTPS URLs derived from the allowlisted CDN origin and
   validated manifest fields;
2. deny redirects and enforce a 10-second timeout and 4 MiB response cap;
3. verify SHA-256 before making an object visible or writing it to cache;
4. write through a mode-`0600` temporary file and atomically promote it;
5. reverify every cache hit and delete corrupt or oversized entries;
6. retain verified objects for offline use;
7. return a local letter fallback when the CDN, manifest, or integrity check fails;
8. never send token totals, provider totals, local paths, user IDs, credentials,
   or collector data in an asset request, query string, or telemetry event.

`--no-character-downloads` removes the CDN origin from the gateway
configuration. No image or future voice download is then possible; verified
cache objects and built-in letter mode remain available. Voice objects ship in
a later manifest revision behind this same gate, and playback defaults off in
the UI until the user enables it.

The ordinary CDN layer can observe the requested static object and client IP,
as with any asset request. TokenMonster must add no usage-derived parameters or
identifiers. Character selection and starter scoring remain local.

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

- The release embeds an approved manifest for ten art-backed roster members,
  each with 20 themes and pose art; GLM reliably uses letter mode.
- Every published file is immutable and integrity-addressed.
- A clean TokenMonster install can download, validate, cache, render, and use an
  offline fallback without access to AI-Sister source or voice-lab paths.
- Tie, no-data, and missing-provider-dimension cases show the manual starter
  picker.
- Reduced motion works for every published bundle.
- A missing theme, action, GLM cell, or unresolved persona degrades to a visual
  fallback without fake data or a collector failure.
- Local milestones may unlock characters, themes, poses, and actions, but no
  path treats tokens as currency, purchasable progression, power, or rank.
