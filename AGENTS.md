# TokenMonster repository guidance

TokenMonster is a local-first AI usage companion. The privacy boundary is a
load-bearing product requirement, not an implementation detail.

## Non-negotiable rules

- Never persist, log, analyze, or send to TokenMonster cloud: prompts,
  responses, source-code contents, filenames, project paths, API keys, OAuth
  tokens, or provider credentials. A user-initiated BYOK prompt may exist
  transiently in companion memory and travel directly to the selected provider
  under the documented request policy; it never traverses TokenMonster cloud.
- Anonymous contribution is opt-in and defaults off. Local tracking, charts,
  characters, and scripted interaction must continue to work when cloud
  services are disabled or unavailable.
- Cloud ingestion accepts strict UTC daily aggregate buckets and must be
  idempotent. Retries, replay, rescans, and out-of-order delivery cannot
  increase totals. Hourly data and event/session counts remain local.
- Public copy says "tokens shared by opt-in contributors". Never describe the
  counter as all global AI usage or a statistically representative sample.
- Character identity is driven by explainable workflow traits, not a strength
  ladder. Do not reward wasteful token burn or introduce pay-to-win mechanics.
- BYOK credentials remain in the local secret store and calls are routed
  through the local companion. The public API must never receive provider keys.

## Planned repository boundaries

- `apps/web`: public counter, install/consent education, and share pages.
- `apps/api`: enrollment, idempotent aggregate ingestion, deletion, and public
  aggregate reads.
- `apps/companion`: local UI and orchestration around the pinned collector.
- `packages/contracts`: versioned schemas shared by local and cloud code.
- `packages/collector-core`: one-authority scheduling, spool, and retries.
- `packages/collector-tokscale`: exact-pinned default collector adapter.
- `packages/collector-tokentracker-bridge`: optional process/HTTP bridge for
  existing TokenTracker users; it must never be summed with tokscale output.
- `packages/monster-engine`: deterministic, explainable trait derivation.
- `packages/characters`: TokenMonster-owned character manifest and scripted
  fallback lines.

Use TypeScript strict mode for new code. Keep domain logic in packages, not in
framework handlers. Add contract and privacy regression tests with every data
shape change.
