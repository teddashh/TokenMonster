# TokenMonster character and wardrobe map

Status: combined schema-v2 release approved and published. All 11 personas have
approved raster associations and five canonical WAVs each: 891 images plus 55
voice clips, or 946 entries. TokenMonster release candidates embed a
zero-request starter base of eight WebPs (415,470 bytes): one avatar and one
`tech` outfit for each of ChatGPT, Claude, Gemini, and Grok. Those four also
have 168 built-in `zh-TW`/`en` text lines, and the seven friends have 42
built-in tap lines; no audio is embedded. The letter/silent renderer remains
the fallback outside that base.

This document defines how TokenMonster may reuse the existing AI-Sister
character work without copying its publishing pipeline or pretending that
unverified assets exist. The character is companionship and presentation; it
does not change collection accuracy, model capability, quotas, or product
power.

## Audited source and inventory truth

The source audit (recorded 2026-07-23) used the AI-Sister repository's
`origin/main` commit:

```text
77b317b95b6047f1de330d5d41e4edab38de3b44
```

The active canonical roster at that commit is **four sisters plus seven
friends**, or eleven personas total:

| Role   | Stable ID    | Display name | Unlock milestone                                         | Notes                                                                          |
| ------ | ------------ | ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| sister | `chatgpt`    | ChatGPT      | Chosen as starter, or first local OpenAI-family token    | Visual-generation material also calls her Codex; this is one persona, not two. |
| sister | `claude`     | Claude       | Chosen as starter, or first local Anthropic-family token |                                                                                |
| sister | `gemini`     | Gemini       | Chosen as starter, or first local Google-family token    |                                                                                |
| sister | `grok`       | Grok         | Chosen as starter, or first local xAI-family token       |                                                                                |
| friend | `deepseek`   | DeepSeek     | 100,000 local DeepSeek-family tokens                     |                                                                                |
| friend | `qwen`       | Qwen         | 250,000 local Qwen-family tokens                         |                                                                                |
| friend | `mistral`    | Mistral      | 3-day active-day streak                                  |                                                                                |
| friend | `venice`     | Llama        | 500,000 lifetime local tokens                            | `venice` is the internal ID; Llama is the display identity.                    |
| friend | `sakana`     | Sakana       | 4 distinct active providers                              |                                                                                |
| friend | `perplexity` | Perplexity   | 7-day active-day streak                                  |                                                                                |
| friend | `glm`        | GLM          | 5,000,000 lifetime local tokens                          | Canonical persona; absent only from the older ten-persona matrix.              |

There is no eighth friend in the audited canonical type, manifest, avatar set,
or guest catalog. The intended eighth friend remains unresolved. Do not mint a
roster ID, infer one from an image filename, or reserve published CDN paths
until the character is explicitly defined and approved. The progression
engine's internal `reserved` milestone slot (eight distinct active providers)
is not such an ID: the companion roster exposes only the eleven personas
above, and the slot has no display identity, art, or CDN path.

The local candidate bank observed by the audit covers all eleven personas,
including GLM. Its contracted geometry is:

- 11 personas x 20 themes = 220 wardrobe cells;
- one outfit image per cell = 220 outfit slots;
- three reaction poses per cell = 660 pose slots;
- one custom layered set per cell = 220 layered-set slots.

Those counts are observed local candidates, not release evidence. The raw bank
and layered files remain outside the audited Git tree in AI-Sister's
voice-lab workspace and are never copied into TokenMonster.

An older persona-design matrix covered only ten personas: the four sisters
plus Sakana, DeepSeek, Qwen, Mistral, Llama, and Perplexity, without GLM. The
historical schema-v1 integrity manifest still reflects that set: 200 wardrobe
cells, their 600 pose objects, and 50 prerecorded WAV refs (five for each of
the ten personas). That inventory is not public rights approval and is not
shipped as runtime authority.

The current schema-v2 release `ai-sister-media-11-voice55-2026.07.23`
supersedes it with 11 avatars, 220 outfits, 660 poses, and 55 canonical WAVs:
891 image associations and five voice triggers for every one of the 11
personas, including GLM. Its canonical manifest SHA-256 is
`21e4675653ce66b50b61e91260f1623e6e3005177f900991e3a8eeadaf9e6474`.
The older 50-WAV schema-v1 inventory remains historical audit input rather than
runtime authority.

## Stable theme map

Themes are cosmetic facets. A facet may change clothing, palette, ambient
scene, and scripted presentation tone. It must not change a character's
abilities, collector behavior, usage totals, rewards, or rank.

| Tier | Theme slug      | Cosmetic style-facet ID | Optional recommendation trait | Own-family tokens | GLM lifetime tokens |
| ---: | --------------- | ----------------------- | ----------------------------- | ----------------: | ------------------: |
|    1 | `tech`          | `builder`               | `cli-focused`                 |                 1 |           5,000,000 |
|    2 | `finance`       | `planner`               | `cache-savvy`                 |             5,000 |           5,250,000 |
|    3 | `politics`      | `civic-strategist`      | `multi-provider`              |            10,000 |           5,500,000 |
|    4 | `education`     | `mentor`                | `tool-focused`                |            25,000 |           5,750,000 |
|    5 | `health`        | `caretaker`             | `balanced`                    |            50,000 |           6,000,000 |
|    6 | `environment`   | `steward`               | `cache-savvy`                 |           100,000 |           6,500,000 |
|    7 | `law`           | `guardian`              | `provider-focused`            |           175,000 |           7,000,000 |
|    8 | `relationship`  | `listener`              | `multi-provider`              |           250,000 |           7,500,000 |
|    9 | `family`        | `nurturer`              | `balanced`                    |           400,000 |           8,000,000 |
|   10 | `workplace`     | `organizer`             | `cli-focused`                 |           600,000 |           9,000,000 |
|   11 | `science`       | `researcher`            | `tool-focused`                |           850,000 |          10,000,000 |
|   12 | `culture`       | `storyteller`           | `multi-tool`                  |         1,200,000 |          11,000,000 |
|   13 | `sports`        | `challenger`            | `output-heavy`                |         1,700,000 |          12,000,000 |
|   14 | `food`          | `host`                  | `balanced`                    |         2,300,000 |          13,500,000 |
|   15 | `travel`        | `explorer`              | `multi-tool`                  |         3,000,000 |          15,000,000 |
|   16 | `psychology`    | `reflector`             | `night-oriented`              |         4,000,000 |          17,000,000 |
|   17 | `philosophy`    | `thinker`               | `provider-focused`            |         5,500,000 |          19,000,000 |
|   18 | `international` | `connector`             | `multi-provider`              |         7,000,000 |          22,000,000 |
|   19 | `media`         | `communicator`          | `output-heavy`                |         9,000,000 |          25,000,000 |
|   20 | `festival`      | `celebrator`            | `output-heavy`                |        12,000,000 |          30,000,000 |

The facets above normalize the source slugs for TokenMonster. They are tags,
not numerical attributes. A matching workflow trait may recommend a look, and
can move that theme one tier earlier, but is never an unlock requirement. The
two threshold columns are the local unlock ladders described under
[Unlock and progression rules](#unlock-and-progression-rules). In particular,
the legacy Chinese forum category `生活` normalized to `psychology`; `life` is
not a twenty-theme slug.

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
  doll_<persona>__<theme>__<state>.json

<voice-lab-root>/tachie/parts/
  <persona>__<theme>__v2_parts/
    parts.json
    source.json
```

The audited path templates also cover per-pose reaction metadata (JSON) and,
for each layered set, a `parts.json` layer manifest and a `source.json` source
record.

The `v2_parts` output is a project-specific layered **2.5D** representation. It
is not a Live2D, Spine, VRM, Rive, GLTF, or other standard rig, so using it
would require a TokenMonster renderer port. The audited capabilities are layer
compositing, idle sway, breathing, blink, viseme lip sync, and static
reaction-pose swaps. TokenMonster must not describe it as a standard rig,
depend on undocumented raw layer filenames, or embed the AI-Sister generation
scripts. The public bundle format defined below is the only integration
boundary.

The audited action vocabulary has 16 allowlisted actions: `preen`,
`check_phone`, `tidy_hair`, `sip`, `stretch`, `nod`, `shake`, `laugh`, `smirk`,
`frown`, `pout`, `arms_crossed`, `lean_in`, `eyeroll`, `applause`, and `tilt`.

## Semantic state and action map

TokenMonster owns transient companion state. AI-Sister owns approved visual
assets. State, action, and wardrobe theme remain separate dimensions:

```text
persona + theme + semantic action + bundle version
```

| TokenMonster semantic state | Source pose  | Preferred actions                                                                            |
| --------------------------- | ------------ | -------------------------------------------------------------------------------------------- |
| `idle-static`               | `outfit`     | none                                                                                         |
| `idle`                      | `outfit`     | `preen`, `tidy_hair`, `sip`                                                                  |
| `connecting`                | `outfit`     | `lean_in`, `tilt`                                                                            |
| `learning`                  | `outfit`     | `tilt`, `lean_in`                                                                            |
| `resting`                   | `outfit`     | `sip`, `stretch`                                                                             |
| `quiet`                     | `outfit`     | `check_phone`, `tidy_hair`                                                                   |
| `steady`                    | `supported`  | `nod`, `lean_in`                                                                             |
| `lively`                    | `supported`  | `laugh`, `applause`                                                                          |
| `notice`                    | `outfit`     | `tilt`, `lean_in`                                                                            |
| `error`                     | `challenged` | `frown`, `shake`                                                                             |
| `wardrobe-unlocked`         | `victory`    | `applause`, `laugh`; celebrates a locally recorded milestone without assigning power or rank |

Every moving state has an `idle-static` reduced-motion fallback. Asset fallback
order is deterministic:

1. requested persona + theme + action in the active manifest;
2. requested persona + theme + `outfit` in the active manifest;
3. requested persona + the active manifest's approved default outfit;
4. built-in lightweight letter renderer.

Before complete-pack activation, and again after a full-pack failure or revoke,
the active manifest is the release-embedded starter base. Step 3 therefore
resolves the four starters to their `tech` base outfits without a request; other
missing art reaches step 4.

Missing visual assets never change the underlying collector or metrics state.
They only change presentation.

## Starter selection

The four sisters are the only starter candidates, and the starter is always an
explicit player choice; local usage never picks one on the player's behalf. A
clean install deals one face-down first-meet card. Drawing it picks one of the
four sisters uniformly at random on the device, while 想自己挑也可以 opens the
classic four-card picker instead. Either path stores only a local preference,
and the player can switch companions at any time.

The four-card picker may mark one sister as recommended (依本機用量推薦). That
recommendation is computed locally from a privacy-safe 28-day aggregate, if
that aggregate is available:

| Local provider family     | Starter persona |
| ------------------------- | --------------- |
| OpenAI, ChatGPT, or Codex | `chatgpt`       |
| Anthropic or Claude       | `claude`        |
| Google or Gemini          | `gemini`        |
| xAI, Grok, or Grok Build  | `grok`          |

The recommendation algorithm is:

1. Sum each supported provider family's local token usage over the latest 28
   UTC dates, including the current UTC date, using a versioned, content-blind
   aggregate contract.
2. If exactly one provider has the strictly highest positive total, mark its
   sister as recommended.
3. If the maximum is tied, all totals are zero, history is absent, or the
   provider dimension is unavailable, show no recommendation.
4. A recommendation never selects or persists a starter; only the player's
   draw or pick does. A starter that an earlier build selected automatically
   and persisted locally stays active until the player picks another.

The pinned sidecar's fixed model-breakdown route exposes source-level totals.
The implemented TokenMonster adapter accepts only exact source IDs for these
four families and never infers a provider from a model name. If that optional
projection is missing, malformed, or unavailable, totals and charts continue
to work and the picker simply shows no recommendation.
No provider totals, selection rationale, or usage-selected asset key are sent
to an asset CDN or TokenMonster cloud. Default, no-consent,
offline-without-cache, failed, and revoked states use the release-embedded base
and make no runtime asset request. Explicit image-pack enablement identifies
only the fixed release and version; its object set and order do not vary with
persona, theme, unlock, pose, trigger, or any usage-derived state.

## Unlock and progression rules

Tokens remain measurements, not spendable game currency. Progression is
local-only, monotonic, explainable, and never purchasable:

- only the player's explicit draw or pick selects a starter. The chosen sister
  unlocks at selection, even with zero usage, together with her `tech` base
  outfit, and a former starter keeps that base outfit after a switch;
- ChatGPT, Claude, Gemini, and Grok also unlock at the first local token for
  their corresponding family, without becoming the selected starter;
- friends unlock at the milestones in the roster table: DeepSeek and Qwen use
  their own cumulative family totals; Mistral and Perplexity use active-day
  streaks; Venice/Llama and GLM use lifetime totals; Sakana uses distinct
  active-provider breadth;
- after a character unlocks, its 20 ordered wardrobe themes unlock from that
  character's local provider-family cumulative total, using the own-family
  column of the theme table. A matching local trait moves a theme ahead by one
  tier;
- GLM's wardrobe instead follows the GLM lifetime column, from 5,000,000 to
  30,000,000 lifetime local tokens, because the pinned sidecar keeps raw `glm`
  and `zcode` sources in `other`, so a GLM family total never accrues. A trait
  never moves a GLM theme below her 5,000,000-token unlock, and themes
  persisted before this ladder keep their original timestamps;
- `supported` and `challenged` pose sets are available with character unlock,
  and `victory` needs a 3-day active-day streak. Of the 16 allowlisted
  actions, `laugh` needs a 7-day streak and `applause` a 14-day streak; the
  other 14 are available with character unlock;
- persisted unlock timestamps prevent rescans, corrections, or later quiet
  periods from relocking an item.

The UI explains progress without praising high volume, shaming low/zero usage,
assigning power or rank, or encouraging wasteful token burn.

## Publishing boundary

Approved pre-rendered immutable images are published to AI-Sister's existing
Cloudflare R2/CDN under the dedicated origin and prefix:

```text
https://cdn.ted-h.com/tokenmonster/characters/v1/
```

The current public object layout is:

```text
tokenmonster/characters/v1/packs/ai-sister-media-11-voice55-2026.07.23/7d98e0d18c470f82818e8ada67208847c3cf4ff5c10cb5f99f9215191e981f30.zip
tokenmonster/characters/v1/releases/ai-sister-media-11-voice55-2026.07.23/asset-release-manifest-v2.json
```

The ZIP is 73,261,088 bytes and contains 891 image entries plus 55 WAV entries,
946 entries and 73,043,596 extracted bytes in total; its SHA-256 is its
filename. Both objects were published immutably and read back byte-for-byte
through the public CDN. Individual media objects are not a runtime lazy-fetch
contract.

AI-Sister retains:

- raw layered parts and source artwork;
- generation prompts and generation tooling;
- approval ledger and rights evidence;
- the publisher that validates, renders, packages, hashes, and uploads bundles;
- rollback authority for a published asset version.

The schema-v2 boundary lets TokenMonster receive only public, rights-approved
output. The historical schema-v1 manifest remains audit input only and is not
shipped. TokenMonster does not mount the voice-lab workspace, read AI-Sister
databases, deep-import AI-Sister code, or become a second asset publisher.

## Release manifest contract

The strict schema-v2 manifest is embedded in the TokenMonster release rather
than trusted from a runtime response and lists only objects that passed the
public release gate. The current combined manifest has 891 image associations
and 55 voice associations for all 11 characters. Each object records at least
its relative hash-named path, bytes, SHA-256, media shape, and its
character/theme/pose or voice-trigger association:

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
prompt, credential, or arbitrary external URL. Historical schema-v1 rows lack
structured public rights evidence and are not grandfathered into approval.
Release staging binds the current v2 authority to the exact descriptor,
allowlist origin/path, release ID, pack hash, and manifest canonical hash.

Published manifest and bundle versions are immutable. Correction means
publishing a new version and updating the top-level manifest; it never means
silently replacing bytes beneath an existing hash.

## Download, cache, and integrity behavior

The gateway accepts only `cdnBaseUrl: null` for per-object delivery and has no
lazy-fetch hook or per-object downloader. Default, no-consent,
offline-without-cache, failed, and revoked states serve the all-or-nothing,
integrity-verified release-embedded starter base without network access. The
base contains the four starter avatars and `tech` outfits plus 168 bilingual
text lines; it contains no voice. Objects outside that base come only from
verified `~/.tokenmonster/asset-cache` bytes, and a miss returns a local letter
fallback or silence. `--no-character-downloads` remains a backward-compatible
option that disables the complete pack, not the embedded base.

The previous per-object downloader is not a release-safe design. Public
manifest associations let a CDN map a hash key back to a character, theme,
pose, or voice trigger. Requests chosen by starter, unlock, today totals, or
connection state would therefore disclose local usage-derived state even with
no query string.

The `@tokenmonster/characters/asset-pack` subpath implements the current
explicit-consent verification/cache path. The embedded schema-v2 manifest,
pack descriptor, and exact origin/path allowlist authorize only the one current
combined media pack. The wiring must:

1. run only after a separate, sufficiently disclosed user action;
2. fetch one fixed, versioned pack whose request set and order are independent
   of all local usage, selection, progression, pose, and trigger state;
3. accept only an allowlisted HTTPS origin and reject redirects;
4. enforce bounded transfer and extraction sizes;
5. verify each schema-v2 entry's bytes, media type, and SHA-256 before display
   or an atomic mode-`0600` cache write;
6. reverify every cache hit and delete corrupt or oversized entries;
7. retain verified objects for offline use and fall back to the embedded starter
   base on any full-pack error;
8. allow each starter's avatar and `tech` base outfit from embedded bytes, but
   perform all other theme, pose, and prerecorded-voice selection only after the
   full pack is local.

Prerecorded voice playback defaults off. The gateway exposes bounded lines
only for unlocked characters: `greeting` is gesture-armed and once per
character/UI session, `unlock` accompanies its toast, `quiet`/`active` reflect
a healthy zero/nonzero today aggregate with a one-hour trigger throttle, and
`error` fires only on entry to refresh-failed. The current release has one WAV
per character for each of those five triggers. Playback uses only verified
local cache hits; triggers never become network keys.

## Rights and brand gate

No new character bundle may be uploaded under the public prefix until a human
has recorded both:

- rights approval for the source and derivative artwork; and
- brand approval for names, logos, marks, costume treatment, and public use.

Approval must identify the exact persona, theme, action set, source revision,
publisher revision, and output hashes. The current 891 images and 55 WAVs
passed this gate with private evidence, per-clip voice review, and required
unaffiliated disclosure. A technically complete new asset with missing or
ambiguous rights remains unpublished. The unresolved eighth friend, later
wardrobe expansion, and any regenerated brand-mark artwork all pass this same
gate.

## Acceptance criteria for the first asset release

- The release embeds one schema-v2 rights-approved manifest for all 11 roster
  members, each with an avatar, 20 themes, pose art, and five prerecorded
  voice triggers: 891 images plus 55 WAVs, 946 entries in total.
- Candidate staging embeds exactly eight of those approved WebPs, 415,470 bytes:
  four starter avatars plus their `tech` base outfits. It also includes 168
  `zh-TW`/`en` fixed text lines and no audio.
- Every published file is immutable and integrity-addressed.
- A clean TokenMonster install uses the four-starter base with zero runtime
  asset requests; media outside the base remains fully usable through
  letter/silent fallback. An explicit enable action downloads exactly one
  946-entry, 73,261,088-byte fixed pack, then validates and caches its 891
  images and 55 WAVs without access to AI-Sister source or voice-lab paths.
  Failure or revocation returns to the starter base and silence.
- A clean install asks the player to draw a random first sister or pick one
  of the four; usage never selects a starter, and tie, no-data, and
  missing-provider-dimension cases show no recommendation.
- Reduced motion works for every published bundle.
- A missing theme, action, or unresolved persona degrades to a visual
  fallback without fake data or a collector failure.
- Local milestones may unlock characters, themes, poses, and actions, but no
  path treats tokens as currency, purchasable progression, power, or rank.
