# ADR 0001: Keep TokenMonster separate from collector upstreams

- Status: accepted
- Date: 2026-07-15

## Context

The target directory started empty. The source brief suggested directly
forking TokenTracker, token-monitor, and ai-avatar-bot. Current audits show that
TokenTracker already supplies broad local collection, a local HTTP API, native
shells, a dashboard, pets, achievements, sharing, and optional cloud features.
It also changes rapidly and has a large parser/sync surface. token-monitor has
overlapping collection and sync machinery. AI-Sister contains the owned visual
direction but also a full, unrelated chat/community application.

## Decision

TokenMonster is its own monorepo and owns product contracts, the character
engine, public API, public site, consent, and deletion semantics.

For the first implementation:

1. `tokscale@4.5.2` is the exact-pinned default collector executable. Its
   adapter drops sessions, project labels, paths, and other non-aggregate data
   before TokenMonster persistence.
2. People already running TokenTracker may choose a mutually exclusive
   `tokentracker-cli@0.79.8` bridge. The bridge reads loopback aggregate
   endpoints, forces upstream telemetry off, and never enables upstream cloud
   sync. TokenMonster must not add tokscale and TokenTracker results together.
3. A dedicated public fork, `teddashh/tokenmonster-collector`, tracks upstream
   and is used only when a required parser/hook fix cannot live in the adapter.
4. token-monitor and ai-avatar-bot remain references; their repositories are
   not copied.
5. AI-Sister is not forked. Only reviewed assets and extracted persona facts
   enter `packages/characters`, each recorded in an asset manifest.

## Consequences

- Upstream collector fixes can be adopted by changing one pinned dependency.
- Exact pins and golden fixtures make collector upgrades explicit rather than
  silently changing totals.
- TokenMonster's cloud privacy contract does not inherit TokenTracker's InsForge
  account model or hard-coded production defaults.
- Local packaging must supervise the collector process and tolerate compatible
  API changes through adapter contract tests.
- If upstream provides no stable library/API for a required capability, the
  collector fork may carry a minimal patch with tests and an upstream-sync
  schedule.
- The product can ship its public web/API independently of desktop releases.

## Rejected options

- Wholesale TokenTracker fork in this repository: excessive merge and release
  burden, product/cloud coupling, and unrelated native/dashboard code.
- Git submodule: pins source but does not create a stable runtime contract and
  complicates installation and CI.
- Rewrite collectors: duplicates the highest-risk correctness and privacy work.
- Fork AI-Sister: imports unrelated auth, chat, billing, media, and community
  systems along with a dirty/local asset state.
