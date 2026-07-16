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

`getProviderTotals(range)` projects the model-breakdown route to exactly four
safe integer totals. It maps only the audited TokenTracker source IDs `codex`,
`claude`, `gemini`, and `grok` to `openai`, `anthropic`, `google`, and `xai`.
Other bounded source IDs are valid upstream data but are ignored; model names
are never used to infer a provider. Missing mapped sources become zero, while a
duplicate mapped source is rejected as incompatible. Model IDs and costs are
validated and discarded.

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

Provider totals may be used to offer a deterministic starter-character
preselection. They are not experience points, power, levels, rewards, or
wardrobe access gates; an explicit user selection remains authoritative.

`probe()` confirms reachability and schema compatibility with the pinned
compatibility target. TokenTracker's local aggregate endpoints do not expose the
installed package version, so `probe()` deliberately does **not** claim to
attest the running process's version. The launcher must separately start the
exact pinned runtime and own its lifecycle.
