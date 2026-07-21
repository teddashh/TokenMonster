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

`migrations/0003_lifecycle.sql` is the additive upgrade for pause/resume. It
adds the affirmative-consent replay lookup index and pause-state relational
triggers without rebuilding the foreign-key-connected mutation guard graph.
The adapter also rejects any inconsistent row that predates the triggers, and
the fixed pause/resume statements are the only lifecycle writers. Lifecycle
commits reuse the existing `ingest` upload-authority guard class so the closed
operation enum in an already-applied `0001` remains compatible.

`migrations/0004_sidecar_contribution.sql` widens the authority, current-usage,
and authority-guard collector checks to include `tokentracker-sidecar`. Because
SQLite cannot alter checks in place, it rebuilds only those three tables,
copies all V1 rows, restores their indexes and mutation/closed-day triggers,
and preserves the foreign-key graph. Unknown collector kinds remain rejected.

`migrations/0005_recoverable_enrollment.sql` adds the V2 recovery lookup. It
stores only a 24-character public lookup ID, a 32-byte HMAC verifier, verifier
key ID, and foreign keys to the atomic installation/consent pair. Raw upload,
deletion, and recovery bearer secrets have no columns. Deleting the
installation cascades the recovery verifier so it cannot become a status or
account-recovery channel.

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

`createD1MutationStorage(db)` implements V1 and recoverable V2 enrollment,
scoped credential
lookup, ingest, pause/resume lifecycle, and deletion storage ports from
`@tokenmonster/api-domain`.
Every domain transaction runs first against a primary-session preflight read
set and a recording facade. The adapter then submits one D1 batch that
inserts request-scoped SQL expectations, writes the recorded intent, marks the
projection dirty where required, and removes the guard. Schema triggers use
`RAISE(ABORT, ...)` when status, consent, credential verifiers, authority,
batch receipts, revisions, row hashes, or deletion state changed after
preflight. A zero-row conditional write is never treated as proof of commit.

Pause changes only `active -> paused`, preserves current and anonymous totals,
and makes repeated pause calls return the original timestamp. Resume requires a
current affirmative consent acknowledgement; status/revision update and the new
immutable consent receipt commit in one guarded batch. Repeating resume while
already active on the current revision returns the latest stored granted
receipt without creating another event. Both paths reverify the upload
credential inside the transaction, and ingest continues to reject `paused`.

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

## Suppression-aware isolated restore drill

`createD1SuppressionAwareRestoreDrill` is the no-route orchestration primitive
for an already-restored, isolated D1 database. It accepts only the isolated D1
binding, independent active-suppression reader, suppression-marker derivation
capability, hard bounds, and an approved count/checksum manifest. One invocation
uses a fixed clock and performs these phases in order:

1. snapshot and validate the active suppression ledger and restored row count;
2. run bounded `replayDeletionSuppressions` and guarded D1 purges;
3. recheck the ledger snapshot, installation count, tombstone lifecycle,
   upload/deletion, restored deletion-job, and abandoned mutation-guard
   credential revocation; clear every offline guard shadow; then audit
   attributable rows, quarantine rows, consent, and shares;
4. rebuild the public projection and compare its count-only checksum.

Success returns only suppression/installation/residue counts, three public
projection counts, and SHA-256 projection/evidence checksums. Installation IDs,
suppression markers, credential artifacts, timestamps, and revisions are never
returned or logged. Any ledger drift, capacity overflow, manifest mismatch,
purge residue, or projection mismatch rejects with a fixed error and never
publishes evidence. The IDs needed for exact post-purge checks exist only
transiently inside the bounded invocation. Because an isolated restore has no
legitimate in-flight writer, every restored `mutation_guards` snapshot is
discarded before rebuild; this also prevents an orphan shadow from retaining a
token HMAC or deletion verifier after its installation row is gone. A failed
drill database remains isolated and must be discarded, never attached to a
route.

The executable local verification uses a real SQLite D1-shaped restore fixture:

```sh
npm run test:restore-drill --workspace @tokenmonster/cloud-d1
```

This command is local evidence, not a remote Cloudflare restore. A real monthly
drill still needs an owner-created D1 database with no public route, the
independent suppression Durable Object reader, the suppression-key derivation
binding, and an approved count/checksum manifest. No public admin endpoint or
remote invocation identity is implemented or claimed here.

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
npm run test:restore-drill --workspace @tokenmonster/cloud-d1
npm run build --workspace @tokenmonster/cloud-d1
```

The migration suite applies all SQL migrations to Node 24 `node:sqlite` in memory,
inspects tables/columns/indexes, exercises a transactional valid roundtrip,
verifies privacy absence, and proves database rejection of ledger, credential,
cohort, projection, and lifecycle invariant violations. A separate fake-D1
suite locks the public reader query, bindings, and fail-closed behavior. The
mutation suite uses the exact migration to cover 30-row atomic ingest, replay,
stale/equal/higher revisions, pause/resume replay and consent rollback,
status/credential/authority/lifecycle races, deletion racing ingest, credential
revocation, hot-data purge, and absence of raw bearer bindings.

The anonymous-compaction suite covers closed-day eligibility, k=19/20,
active/paused/deleting and quarantine boundaries, whole-day capacity drop,
commit-time races, atomic rollback, multi-day ordering, immutable retry and
content-blind checksums. Retention and Worker integration tests lock the
preserved-input mode and scheduler order.
