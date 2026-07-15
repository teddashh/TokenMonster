# `@tokenmonster/cloud-d1`

Cloudflare D1 adapter boundary for TokenMonster's pseudonymous contribution
data. This package contains no Worker globals and no HTTP framework code.

## Migration

`migrations/0001_initial.sql` creates the first cloud schema. It deliberately
contains no seed rows and no prompt, response, path, account, e-mail, provider
credential, raw request, or plaintext bearer-secret columns.

`migrations/0002_compaction_audit.sql` adds the content-blind audit counts and
token ledger required to verify a completed `day-all-v1` rollup. Its triggers
allow only the single coarsest `all/other/all/all` output shape, make completed
days and anonymous output immutable, and reject late usage or authority input
after closure. Dropped days retain no token totals.

Credential records contain separate public lookup IDs and 32-byte
HMAC-SHA-256 verifiers for upload, deletion, and deletion-status credentials.
The server pepper stays in the Worker secret binding and is never written to
D1. `anonymous_rollups` has no installation, credential, batch, row-hash, or
other reversible contributor mapping.

The migration uses D1-compatible SQLite foreign keys, `STRICT` tables, and
`CHECK` constraints. D1 enforces foreign keys for queries and migrations, so
the file does not try to change `PRAGMA foreign_keys` inside D1's implicit
transaction. Runtime multi-row mutations must use prepared statements inside
one `D1Database.batch()` call; D1's batch is transactional. Do not send
`BEGIN`, `COMMIT`, or client-generated SQL through the Worker. In particular,
canonical usage mutation, its receipt, and the `aggregate_dirty` upsert belong
in the same batch.

## Mutation storage

`createD1MutationStorage(db)` implements the enrollment, scoped credential
lookup, ingest, and deletion storage ports from `@tokenmonster/api-domain`.
Every domain transaction runs first against a primary-session preflight read
set and a recording facade. The adapter then submits one D1 batch that
inserts request-scoped SQL expectations, writes the recorded intent, marks the
projection dirty where required, and removes the guard. Schema triggers use
`RAISE(ABORT, ...)` when status, consent, credential verifiers, authority,
batch receipts, revisions, row hashes, or deletion state changed after
preflight. A zero-row conditional write is never treated as proof of commit.

Deletion begins by revoking both installation credentials and retains only
the deletion replay verifier plus the independently scoped status verifier in
the bounded job record. Completion purges current usage, authority bindings,
batch receipts, shares, and consent linkage, tombstones the installation, and
marks the public projection dirty in one guarded batch. The independent
suppression ledger is intentionally outside this package and must be recorded
before beginning the D1 transition.

All runtime SQL is fixed and uses prepared bindings. The adapter never accepts
a raw bearer credential, request body, prompt, response, path, filename, or
provider key. `withSession("first-primary")` is used only for preflight; it is
not represented as a transaction. Only `D1Database.batch()` is the atomic
commit boundary.

A 30-bucket ingest can require 126 guarded statements. As checked against the
Cloudflare D1 limits on 2026-07-15, this requires the planned Workers Paid
environment (1,000 queries per invocation); the Free limit of 50 is not a
supported production target. Reconfirm the limits during every release gate.

The database does not run retention by itself.
`createD1RetentionMaintenanceStorage(db)` and
`createD1RetentionMaintenanceProcessor(storage, options)` provide the bounded
scheduled hard-retention primitive. It covers every expiring D1 root:
consent receipts, authority bindings, batch receipts, current usage, shares,
security events, quarantine events, deletion jobs, deletion installation
tombstones, and abandoned mutation guards. Revoked shares are also removed.
One invocation deletes at most `maxRecords` direct roots (100 by default, hard
range 10..500), returns aggregate counts only, and uses fixed prepared SQL.
Usage-affecting deletion and `aggregate_dirty` invalidation share one atomic D1
batch. Contributor foreign-key children are drained before their parent so
stale deletion work cannot turn one tombstone into an unbounded cascade;
abandoned mutation-guard children remain bounded by the request contract. A
deletion status job and its installation remain available until the job's own
`expires_at`.

The generic retention primitive can still remove expired attributable usage
when used alone. Scheduled cloud maintenance instead passes
`preserveCompactionInputs: true`, which excludes `usage_daily_current` and
`collector_window_bindings`; the anonymous compactor owns their closure so a
backlogged day cannot be partially deleted before its cohort decision.

`createD1AnonymousCompactionProcessor(db, options)` implements the locally
tested `day-all-v1` k=20 closure. It selects only the oldest UTC day that has
fully ended and whose complete current-row set has expired, and processes at
most one day per call. Eligible active/paused contributors with positive,
accepted usage authorize the single mapping-free `all/other/all/all` rollup.
If the cohort is below 20, the complete day exceeds the bounded safe input
capacity, or the public signed-int64 safety ceiling would be crossed, the
entire day is privacy-dropped without a rollup or token-valued drop audit.

Both paths recheck lifecycle, expiry, row/cohort counts and, for a rollup,
totals and cleanup counts inside the commit batch. Rollup/drop audit,
mapping-free output where applicable, expired receipt/quarantine cleanup,
complete-day usage and orphan binding deletion, and projection invalidation
are atomic. Migration triggers close the day against late input and make the
result immutable; a stale preflight or failed statement rolls back all source
cleanup.

The checked-in Worker composes scheduled work as
`deletion -> compactor -> preserving retention -> projection`. A failed
deletion pass suppresses irreversible compaction for that run; safe retention
and projection work may continue, while the schedule still reports failure.
This source-tested path is not production evidence. Cloudflare account/D1/
domain/secrets, real migration rehearsal, staging E2E, monitoring,
backup/restore and suppression replay remain release STOP gates. Repository-wide
STOP gates also include Companion background sync, signed/native smoke,
legal/license approval and raster rights.

A deploy-owned Worker can compose the primitive without granting it mutation
preflight or credential access:

```ts
const processRetention = createD1RetentionMaintenanceProcessor(
  createD1RetentionMaintenanceStorage(env.TOKENMONSTER_DB, {
    preserveCompactionInputs: true
  }),
  {
    maxRecords: 100,
    now: () => new Date(event.scheduledTime)
  }
);
await processRetention();
```

`createD1DeletionMaintenanceProcessor(storage, options)` provides the deletion
workflow primitive. One invocation lists at most `maxJobs` queued opaque IDs
(25 by default and never more than 100) and completes each through the existing
guarded atomic purge. It either returns only `{ examinedJobs, completedJobs }`
or rejects with a sanitized fixed error; it never returns job or installation
identifiers. A deploy-owned scheduled Worker must still invoke it and monitor
failures.

`createD1PublicProjectionRebuilder` provides the scheduled rebuild primitive.
It replaces the one public cache row from accepted, unexpired current truth
plus mapping-free `anonymous_rollups`; rolling contributors count only current
installations with positive accepted usage. Projection replacement and dirty
marker cleanup share one D1 batch. Counts at or above 80% of signed-int64
capacity fail closed and leave the dirty marker for operator intervention.

Apply the migration with the environment-specific Wrangler workflow, for
example:

```sh
wrangler d1 migrations apply TOKENMONSTER_DB --env staging --remote
```

Production database IDs and credentials must not be committed to this
package.

## Public totals reader

`createD1PublicTotalsReader(db)` accepts a deliberately small structural D1
interface and returns a zero-argument async function structurally compatible
with the API package's `readPublicTotals` port. It issues one fixed prepared
query and binds `("global", "all")`; it never concatenates request data.

The reader returns `null` when the projection is absent or when D1 returns an
unexpected shape/type. It accepts only canonical unsigned signed-int64 decimal
strings, a canonical UTC instant, and a bounded data revision. It performs no
logging, so malformed rows cannot disclose SQL or projection data through this
adapter.

## Package checks

```sh
npm run typecheck --workspace @tokenmonster/cloud-d1
npm test --workspace @tokenmonster/cloud-d1
npm run build --workspace @tokenmonster/cloud-d1
```

The migration suite applies both SQL migrations to Node 24 `node:sqlite` in memory,
inspects tables/columns/indexes, exercises a transactional valid roundtrip,
verifies privacy absence, and proves database rejection of ledger, credential,
cohort, projection, and lifecycle invariant violations. A separate fake-D1
suite locks the public reader query, bindings, and fail-closed behavior. The
mutation suite uses the exact migration to cover 30-row atomic ingest, replay,
stale/equal/higher revisions, forced rollback, status/credential/authority
races, deletion racing ingest, credential revocation, hot-data purge, and
absence of raw bearer bindings.

The anonymous-compaction suite covers closed-day eligibility, k=19/20,
active/paused/deleting and quarantine boundaries, whole-day capacity drop,
commit-time races, atomic rollback, multi-day ordering, immutable retry and
content-blind checksums. Retention and Worker integration tests lock the
preserved-input mode and scheduler order.
