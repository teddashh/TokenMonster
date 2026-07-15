# ADR 0003: D1 mutation adapters require an atomic guarded batch

- Status: Proposed; blocks enabling production mutation routes
- Date: 2026-07-15

## Context

Enrollment, absolute ingest, correction, pause, rotation, and deletion must not
accept a credential or revision in one database state and then write against a
different state. `@tokenmonster/api-domain` therefore models ingest and delete
as serialized transaction callbacks.

Cloudflare D1's current Worker API documents `D1Database.batch()` as a SQL
transaction: statements run sequentially and a failing statement rolls the
whole sequence back. The Sessions API provides sequential consistency and a
`first-primary` option, but it does not expose an interactive transaction that
stays open across arbitrary Worker `await` calls.

Sources checked on 2026-07-15:

- [D1 Database Worker API — batch and withSession](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)

## Decision

Production D1 adapters must not implement a domain transaction callback as a
plain sequence of D1 reads followed by writes. `withSession("first-primary")`
may provide the preflight read set, but it is not the commit proof.

The adapter will use an optimistic, guarded commit:

1. Read the installation, scoped credential verifier, consent/status,
   authority bindings, batch receipt, and affected current rows from primary.
2. Run the pure domain callback against that immutable read set while recording
   its intended writes.
3. Submit one prepared `D1Database.batch()` containing:
   - a random, request-scoped mutation guard;
   - SQL assertions that the installation/credential/consent state is unchanged;
   - per-day authority assertions;
   - per-key expected absence or exact revision/hash assertions;
   - the receipt, absolute row replacements, and aggregate-dirty write;
   - deletion of the request-scoped guard.
4. Implement assertions with schema-owned triggers or constraints that use
   `RAISE(ABORT, ...)`. A conditional statement that silently changes zero rows
   is not sufficient, because later statements could otherwise commit.
5. Map every guard failure to a fixed domain conflict/service code without
   returning SQL, payload, credential, or stored values.

Enrollment is a single guarded batch. Deletion records its independent
suppression marker before the hot-data transition (privacy-first), then uses a
guarded D1 batch to revoke upload authority and create the job. Completion is a
separate atomic purge batch and projection-dirty write.

Request guard rows are transaction-scoped in normal operation and removed in
the same batch. They contain only random request IDs, expected verifier digests,
and bounded expiry metadata; a scheduled cleanup is defense in depth.

## Verification gate

Mutation routing stays fail-closed (`503`) until the adapter passes all of:

- a 30-row Miniflare/local-D1 commit and forced statement rollback;
- two concurrent higher revisions for the same key;
- equal-revision/different-hash conflict with zero partial writes;
- credential rotation or pause between preflight and commit;
- authority binding race;
- deletion racing ingest;
- identical batch replay and batch-ID reuse;
- staging D1 tests against the exact migration and Worker build.

## Consequences

- The HTTP/domain layers remain portable and contain no D1 types.
- The D1 adapter is more involved than an in-memory transaction port, but it
  preserves the product's public-total and deletion invariants under races.
- D1 single-writer execution improves throughput predictability but is never
  treated as an application-level transaction invariant.
- A future backend with real interactive serializable transactions may provide
  a simpler adapter without changing wire contracts.

## Rejected alternatives

- **Multiple D1 calls inside a Session:** sequentially consistent, not one
  atomic transaction.
- **Read then unconditional `batch()`:** another request can change the read set
  before the batch begins.
- **Conditional upserts that may no-op:** cannot prove the remaining statements
  rolled back.
- **Increment-only public counters:** cannot safely handle replay, downward
  correction, expiry, or deletion.
