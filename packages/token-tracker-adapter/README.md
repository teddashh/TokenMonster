# `@tokenmonster/token-tracker-adapter`

This package is TokenMonster's permanent sidecar boundary around the local
TokenTracker runtime. It targets exactly `tokentracker-cli@0.80.0` and does not
vendor, fork, or deep-import TokenTracker.

The adapter only performs fixed `GET` requests to these audited local routes:

- `/functions/tokentracker-usage-summary`
- `/functions/tokentracker-usage-daily`
- `/functions/tokentracker-usage-model-breakdown`

It never reads `queue.jsonl`, calls TokenTracker cloud/auth/community routes, or
accepts arbitrary endpoint paths. A custom base URL must be canonical plain HTTP
on `127.0.0.1` with an explicit port; `localhost`, LAN addresses, credentials,
paths, query strings, and fragments are rejected.

Responses are time- and size-bounded, checked against the strict 0.80.0 response
shape, and immediately projected into TokenMonster-owned content-blind DTOs.
Cost, conversation counts, model identifiers, and upstream source metadata are
validated only for compatibility and are not returned by this package.

The legacy `getProviderTotals(range)` name is retained for compatibility. It
maps four TokenTracker collector IDs to historical starter labels, but those
IDs identify tools, not an attested request provider: Claude Code can use a
custom provider while remaining `source=claude`. These totals may inform the
existing reversible starter suggestion only; they must never produce provider
traits. Other bounded source IDs are ignored, model names are never used for
inference, and duplicate mapped sources are incompatible. Model IDs and costs
are validated and discarded.

```ts
import { createTokenTrackerAdapter } from "@tokenmonster/token-tracker-adapter";

const adapter = createTokenTrackerAdapter({
  baseUrl: "http://127.0.0.1:7680"
});

const summary = await adapter.getSummary({
  fromUtcDate: "2026-07-01",
  toUtcDate: "2026-07-15"
});

const providerTotals = await adapter.getProviderTotals({
  fromUtcDate: "2026-06-18",
  toUtcDate: "2026-07-15"
});
```

`summary.activeDays` is the number of nonempty daily usage buckets in that
range. It does not indicate collector coverage, observation completeness, or
trait maturity.

## Conservative local profile footprint

`getDailyContentBlindFootprint(query)` is the bounded player-profile input for
`@tokenmonster/monster-engine`. The query must span exactly 28 UTC dates and
include one of the engine's four v1 character IDs. The returned value passes
`DailyContentBlindFootprintV1Schema`, uses `timezone: "UTC"`, and deliberately
has no hourly rhythm. It therefore cannot assert a local-night trait.

This method is separate from the legacy aggregate methods above. It sends
`scope=personal` to both audited routes, requires the exact `"personal"` echo,
and accepts only the pinned 0.80.0 account exclusion metadata for `cursor`.
An account-scoped source in model breakdown is incompatible even if the outer
response claims personal scope.

For every positive daily row, the adapter requests that single UTC date's
model breakdown and validates all of the following before returning anything:

- raw model totals match the exact audited semantics of their 0.80.0 collector;
  Codex uses subset reasoning, Claude and Grok report no reasoning, and Gemini
  uses additive thoughts with an optional reported-total remainder;
- each model sum equals its source totals for every token component;
- all source sums equal the daily totals, and model-name totals reconcile with
  the daily route's private model map; and
- source IDs and per-source model IDs are unique and every intermediate sum is
  a safe integer.

Model rows are used to validate and canonicalize the source layer, never added
to it as a second layer. Canonical output always satisfies
`total = input + output + cacheRead + cacheWrite + other` and
`reasoning <= output`. A Gemini reported-total remainder is preserved in
`other` instead of being invented as output. Exact source IDs attest only the
following tools:

| TokenTracker source | Provider | Model family | Tool |
| --- | --- | --- | --- |
| `codex` | `other` | `other` | `codex-cli` |
| `claude` | `other` | `other` | `claude-code` |
| `gemini` | `other` | `other` | `gemini-cli` |
| `grok` | `other` | `other` | `grok-build` |

Every other local source is combined into `other` without inspecting model
names; its component split is unverified, so only its reconciled total is kept
in `tokens.other`. In particular, raw `glm` and `zcode` remain `other`. Source
IDs, model IDs, costs, conversation counts, and exclusion metadata never leave
the adapter DTO.

Because TokenTracker 0.80.0 supplies no per-component quality bit, every
aggregate is conservatively marked `valueQuality: "estimated"`. Cache-read
coverage is likewise `unavailable`; reported cache-read counts move to `other`
so Grok's hard-coded zero and unverified collectors cannot create a cache
trait. Provider fields are schema placeholders, not evidence, so profile
presentation must suppress provider-focused, multi-provider, and provider
balance traits until an upstream provider-attestation field exists. A positive
day is `observed` only after full reconciliation. Missing and empty daily rows
are `unavailable`, not invented zero-usage observations; consequently the
engine's coverage gates, rather than the adapter, decide when a profile is
mature.

Provider totals may be used to offer a deterministic starter-character
preselection. They are not experience points, power, levels, rewards, or
wardrobe access gates; an explicit user selection remains authoritative.

`probe()` confirms reachability and schema compatibility with the pinned
compatibility target. TokenTracker's local aggregate endpoints do not expose the
installed package version, so `probe()` deliberately does **not** claim to
attest the running process's version. The launcher must separately start the
exact pinned runtime and own its lifecycle.
