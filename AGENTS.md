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
- Local usage milestones may unlock characters, wardrobe, and actions; unlocks
  stay explainable, local-only, and monotonic. Progression is never purchasable
  and must not reward wasteful token burn.
- BYOK credentials remain in the local secret store and calls are routed
  through the local companion. The public API must never receive provider keys.

## Repository boundaries

- `apps/web`: public counter, install/consent education, and share pages.
- `apps/api`: enrollment, idempotent aggregate ingestion, deletion, and public
  aggregate reads.
- `apps/companion`: legacy Electron migration slice. It receives no new
  collector or product features and is retired after sidecar cutover, unless a
  future release reduces it to an optional thin shell over the same loopback UI.
- `packages/cli`: the `tokenmonster` command and intended published
  `npx tokenmonster` entry point. It composes and shuts down the managed runtime,
  adapter, gateway, UI, and browser launch.
- `packages/companion-ui`: lightweight static companion UI; it renders only
  strict TokenMonster gateway DTOs and contains no collector logic.
- `packages/companion-gateway`: TokenMonster-owned loopback session and fixed
  browser API/static routes. It never proxies arbitrary upstream endpoints.
- `packages/contracts`: versioned schemas shared by local and cloud code.
- `packages/token-tracker-adapter`: the only aggregate data boundary. It talks
  to the exact-tested sidecar through fixed loopback HTTP routes, validates all
  responses, and projects them to content-blind TokenMonster DTOs.
- `packages/token-tracker-runtime`: exact-pinned public-bin resolution, managed
  child lifecycle, and audited local-only refresh. It never discovers or kills
  a process by PID/port and terminates only child objects it created.
- `packages/monster-engine`: deterministic, explainable trait derivation.
- `packages/characters`: TokenMonster-owned character manifest and scripted
  fallback lines.

TokenTracker is the sole upstream collection engine. TokenMonster is an
independent companion product, not a TokenTracker fork or alternate collector.
Do not vendor, subtree, submodule, deep-import, or copy TokenTracker parser and
hook code. Do not read its queue files or provider databases. Do not add a
second scanner or local usage authority. The legacy `collector-core` and
`collector-tokscale` workspaces are migration-only and must not receive new
product features.

Production releases pin one tested `tokentracker-cli` version. Dependency update
bots may propose upgrades, but compatibility and privacy contract tests must
pass before the pin changes. Never float to `latest` at runtime. The supported
user flow is one TokenMonster command; npm dependencies and sidecar lifecycle
are implementation details, not manual installation steps.

Use TypeScript strict mode for new code. Keep domain logic in packages, not in
framework handlers. Add contract and privacy regression tests with every data
shape change.
