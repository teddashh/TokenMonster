# @tokenmonster/monster-engine

`monster-engine` turns a 28-day, content-blind local usage footprint into a
deterministic character state. It is a pure TypeScript package: no filesystem,
network, clock, randomness, analytics, or provider calls occur during
derivation.

## Privacy boundary

The runtime schema accepts only:

- a fixed character presentation ID;
- an exact 28-date local calendar window and a runtime-validated IANA timezone
  (`UTC` is also accepted);
- observed/unavailable day coverage;
- allowlisted provider, coarse model-family, and tool dimensions;
- canonical decimal token components; and
- optional `localHourlyRhythm` totals with explicit wall-clock/DST quality.

All Zod objects are strict. Prompts, responses, filenames, paths, projects,
sessions, tasks, messages, costs, account identifiers, and credentials have no
field in this contract and are rejected if present. Model families are a closed
registry matching the normalized tokscale adapter outputs; raw model strings
are rejected. Provider/model-family combinations are also checked.

`DailyContentBlindFootprintV1` deliberately has no hourly member. The extended
`ContentBlindFootprintV1` adds `localHourlyRhythm` for the local companion only.
Neither type is the cloud upload wire format: cloud code must use the strict
`IngestSnapshotV1` contract from `@tokenmonster/contracts`, which never contains
hour, timezone, or character data.

## Token semantics

Every input count is a canonical non-negative decimal string no larger than
`Number.MAX_SAFE_INTEGER`. The engine converts counts to `BigInt` before doing
any sums or ratio comparisons. `input` excludes cache tokens, and `reasoning`
is an informational subset of `output`:

    total = input + output + cacheRead + cacheWrite + other

Invalid totals and `reasoning > output` fail before derivation. Aggregate sums
may exceed JavaScript's safe-number range because they remain `BigInt`; no raw
sum is returned to the presentation layer.

## v0.1 identity rules

A ready identity requires at least 14 observed days and 7 active days. Below
either gate, the engine returns `identityStatus: "learning"`, no asserted
traits, and banded explanations.

Ready identities contain two or three allowlisted traits. The base dimensions
describe tool surface and provider concentration/diversity. At most one
additional cache, output, or local-night pattern is selected by deterministic
threshold margin. The v0.1 families include:

- `cli-focused`, `tool-focused`, and `multi-tool`;
- `provider-focused` and `multi-provider`;
- `cache-savvy`, `output-heavy`, and `night-oriented`; and
- `balanced` as the provider-distribution fallback.

The first ready profile and a learning-to-ready transition may establish the
complete two-or-three-trait identity. After that, a contiguous next-local-day
derivation changes at most one ordered trait slot. Remaining candidate changes
are held with allowlisted explanations and
`identityContinuity.provisional: true`; successive daily windows converge one
slot at a time. A correction or recomputation for the same 28-day window keeps
the prior identity exactly and emits `no-change`, never a weekly review.
If a ready profile temporarily falls below the rolling coverage gate, its main
traits are likewise held provisionally instead of disappearing all at once;
the coverage band and explanations still disclose that the current evidence is
insufficient.

State carries versioned continuity metadata with the provisional flag and the
last identity review date. A previous state is accepted only for the same
timezone and either the same window or its immediately preceding contiguous
local-day window. Future, gapped, differently zoned, wrong-version, and
otherwise malformed prior states fail closed instead of influencing identity.

Night orientation requires at least seven complete hourly days plus both
`timeQuality: "exact-iana-local"` and `dstQuality: "timezone-aware"`. Estimated,
UTC-only, fixed-offset, unknown-DST, or under-covered rhythm never produces a
night trait. The window timezone is looked up through the runtime's IANA
timezone database, so a slash-shaped invention such as `Mars/Olympus` is
rejected before it can claim exact local/DST quality. The companion must not
upgrade source quality merely to obtain a trait.

All ratios use fixed integer basis points. Scaling every count by ten therefore
does not alter identity, mood, evolution, or explanations. Selecting a different
`characterId` changes only presentation identity, not analytical traits.

## Mood, evolution, and explanations

Mood compares the latest observed local day with the user's own observed prior
days. Unavailable days do not become zero-usage days and do not enter the
baseline. If the latest day is unavailable, mood is `unknown`. Cosmetic energy
is one of `dormant`, `low`, `medium`, or `high`; it is capped and never grants
power, rarity, levels, unlocks, permissions, or ranking.

Evolution uses event cadence for initial coverage, coverage completion, or a
trait-structure change. Unchanged daily and same-window results use explicit
`none` / `no-change` metadata. A stable identity receives a weekly review only
after seven real local calendar dates since its initial profile, most recent
identity change, or prior weekly review. It does not use random mutation.

Every visible identity, trait, mood, and evolution result points to a structured
explanation containing an allowlisted `reasonCode`, versioned `templateId`,
window, coverage, and value bands. Explanations never contain raw token values
or inferred task labels such as debug or research.

## Versioning and configuration

```ts
deriveMonsterState(footprint, previousStateOrNull, {
  engineVersion: "0.1.0"
});
```

The v0.1 configuration schema intentionally accepts only the exact engine
version. Thresholds are frozen constants in `MONSTER_THRESHOLDS_V1`; callers
cannot override them under the same version. Unknown configuration fields and
mismatched versions fail closed. Changing a rule or threshold requires a new
engine version so past explanations are not silently reinterpreted.

## Known limits

- The engine describes observed workflow shape, not productivity, intent, cost,
  wellbeing, or task type.
- Zero cache tokens cannot mean cache coverage unless the adapter explicitly
  supplies `cacheReadAvailability: "observed"`.
- Hourly input is already-aggregated local data. The engine does not assign
  timestamps, resolve DST, or repair timezone changes.
- v0.1 does not infer debug, research, testing, deployment, project, or session
  behavior.

Run from the repository root:

    npm test --workspace @tokenmonster/monster-engine
    npm run typecheck --workspace @tokenmonster/monster-engine
    npm run build --workspace @tokenmonster/monster-engine
