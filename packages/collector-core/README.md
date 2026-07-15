# `@tokenmonster/collector-core`

This package coordinates one explicit, content-blind local daily scan. It has
no timer, renderer, Electron, HTTP client, cloud credential, or background
network behavior.

The coordinator verifies the exact running collector authority, accepts only a
complete strict collector projection, validates the whole local replacement
set, and then calls the local store's atomic daily batch upsert. A complete scan
also turns keys missing from that client/tool scope into local zero rows.

Cloud work is a separate post-commit step. It runs only when an injected
contribution state is active and its consent revision is current. One strict
`IngestSnapshotV1` of 1–30 buckets and at most 64 KiB may be placed in the local
outbox. Missing accepted mirror keys become higher-revision zero corrections.
If the mirror plan is truncated or the complete correction set cannot fit one
V1 batch, no partial cloud batch is queued; the local commit remains valid and
the result reports a fixed `blocked` reason.

`createTokscaleDailyCollector()` is the production adapter around the pinned
`@tokenmonster/collector-tokscale` package. Tests inject collector, store,
clock, UUID, and contribution ports, so they never spawn a process, open
SQLite, schedule work, or call a network.
