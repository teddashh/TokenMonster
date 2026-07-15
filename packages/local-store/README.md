# @tokenmonster/local-store

Content-blind SQLite repository for the TokenMonster companion main process.
It stores validated daily aggregate projections, content-blind per-UTC-day and
per-client complete-scan evidence, deterministic monster state, non-secret
local configuration, collector authority, and strict V1 upload spool entries.
A separate cloud mirror retains only server-accepted absolute
rows and their receipt references, so missing keys can be corrected with a
higher-revision zero without mutating accepted truth before acknowledgement.
It has no API for prompts, responses, raw collector output,
paths, provider credentials, or arbitrary JSON.

The repository owns its `node:sqlite` handle, applies transactional migrations,
uses WAL/foreign keys/a busy timeout for file-backed databases, and exposes only
bounded reads and allowlisted exports. Cloud spool bodies and token values are
never included in diagnostic summaries. Complete-scan diagnostics expose only
the total number of recorded client/day scopes; the V1 support export remains
unchanged and does not export the ledger. Ledger dates are accepted only inside
the current 35-day UTC retention window. Changing collector kind or version is
rejected until `clearCollectorAuthority()` performs an explicit transactional
source reset; that reset purges aggregates, scan evidence, cloud mirror/outbox,
monster snapshots, and the last-scan timestamp while preserving non-secret UI
preferences.

Clearing the cloud mirror is deliberately bounded. The companion must pause
contribution and stop-delete/re-enroll after mirror loss; an empty or partial
mirror must never be treated as proof that the server has no prior rows.
