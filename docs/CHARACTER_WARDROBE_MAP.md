# TokenMonster character and wardrobe map

Status: architecture contract. Asset publication is blocked until rights and
brand approval are recorded.

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

Those numbers describe the source map and filename contract. They are not a
claim that every external file passed review or still exists. The raw bank and
layered files live outside the audited Git tree in AI-Sister's voice-lab
workspace. GLM therefore has a known gap of 20 outfits, 60 poses, and 20
layered sets relative to that bank.

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
| `wardrobe-unlocked` | `victory` | `applause`, `laugh`; only after an explicit wardrobe action, never token volume |

Every moving state has an `idle-static` reduced-motion fallback. Asset fallback
order is deterministic:

1. requested persona + theme + action;
2. requested persona + theme + `outfit`;
3. requested persona + approved default theme + `outfit`;
4. bundled lightweight neutral placeholder.

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

Tokens are measurements, never game currency:

- token count, cost, model price, and provider spend never unlock an outfit;
- token count never powers up, levels, evolves, or ranks a character;
- high usage is never praised as stronger or better;
- low or zero usage is never punished or depicted as neglect;
- wardrobe availability is determined by approved bundle availability and user
  choice, not consumption;
- semantic `victory` is tied only to an explicit user action or system recovery,
  never to crossing a token threshold.

Explainable workflow traits may later influence optional copy or a suggested
cosmetic facet, but they must remain local, content-blind, reversible, and
non-competitive.

## Publishing boundary

Approved, pre-rendered, immutable bundles and their public manifest live in
AI-Sister's existing Cloudflare R2/CDN under the dedicated prefix:

```text
tokenmonster/characters/v1/
```

Recommended public layout:

```text
tokenmonster/characters/v1/manifest.json
tokenmonster/characters/v1/<persona>/<theme>/<bundle-version>/bundle.json
tokenmonster/characters/v1/<persona>/<theme>/<bundle-version>/<rendered-file>
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

## Public manifest contract

The public manifest is an availability index, not a Cartesian-product promise.
It lists only bundles that passed visual, rights, and brand review. Each entry
must include at least:

```json
{
  "schemaVersion": 1,
  "bundleId": "claude.tech.2026-07-15.1",
  "persona": "claude",
  "theme": "tech",
  "version": "2026-07-15.1",
  "format": "tokenmonster-rendered-raster-v1",
  "actions": ["outfit", "supported", "challenged", "victory"],
  "bundleManifest": "claude/tech/2026-07-15.1/bundle.json",
  "sha256": "<lowercase-hex-sha256>",
  "bytes": 123456,
  "approval": "approved",
  "minimumRendererVersion": 1
}
```

The bundle manifest records every downloadable file's relative path, MIME
type, byte length, SHA-256 digest, pixel dimensions, action association, and
reduced-motion fallback. Paths must be relative and must not contain local
filesystem locations, user identifiers, prompts, credentials, or arbitrary
external URLs.

Published manifest and bundle versions are immutable. Correction means
publishing a new version and updating the top-level manifest; it never means
silently replacing bytes beneath an existing hash.

## Download, cache, and integrity behavior

TokenMonster downloads approved bundles on demand from the single configured
AI-Sister CDN origin and caches them in the operating system's local application
cache, outside the repository.

The client must:

1. fetch only fixed HTTPS URLs derived from the allowlisted CDN origin and
   validated manifest fields;
2. enforce response size, timeout, MIME, file-count, and path bounds;
3. verify byte length and SHA-256 before making a bundle visible;
4. unpack into a temporary cache entry and atomically promote it after every
   file passes validation;
5. key cache entries by immutable bundle version and digest;
6. retain the last verified approved bundle for offline use;
7. fall back locally when the CDN, manifest, or integrity check fails;
8. never send token totals, provider totals, local paths, user IDs, credentials,
   or collector data in an asset request, query string, or telemetry event.

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

- The public prefix contains a versioned top-level manifest and at least one
  rights-approved bundle for each of the four starter sisters.
- Every published file is immutable and integrity-addressed.
- A clean TokenMonster install can download, validate, cache, render, and use an
  offline fallback without access to AI-Sister source or voice-lab paths.
- Tie, no-data, and missing-provider-dimension cases show the manual starter
  picker.
- Reduced motion works for every published bundle.
- A missing theme, action, GLM cell, or unresolved persona degrades to a visual
  fallback without fake data or a collector failure.
- No test or product path uses token volume as unlock, power, level, or reward.
