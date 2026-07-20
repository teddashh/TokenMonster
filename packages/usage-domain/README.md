# @tokenmonster/usage-domain

Pure TypeScript server domain for TokenMonster's revisioned daily usage
protocol. It contains no Hono, D1, filesystem, network, or logging adapter.

## Trust boundary

`preflightIngestBatch` accepts an unknown JSON body and a separate authenticated
enrollment context. The body is parsed through the strict exported
V1-or-V2 supported snapshot schema; client-provided enrollment IDs, bucket IDs, payload
hashes, authorization values, event counts, timezones, and other unknown fields
are rejected. Canonical usage keys are derived only from:

    authenticated enrollment
    + bucketStart
    + provider
    + modelFamily
    + tool

An enrollment and UTC day are bound to the exact collector kind, adapter
version, and source version. A tokscale/permanent-sidecar switch, or an in-day parser
version switch, fails with `AUTHORITY_CONFLICT` instead of combining totals.

## Canonical hashing and atomic decisions

Canonical batch and server-row serialization use RFC 8785-compatible ordering
for the strict JSON values admitted by this domain. SHA-256 defaults to Web
Crypto and may be injected for a controlled runtime or test. Hashes are always
server-computed lowercase hexadecimal digests; client hashes are never read.

`preflightIngestBatch` returns a mutation-free plan with one of four row
decisions:

- insert a missing row;
- replace an existing row with a higher absolute revision, including a
  decrease or all-zero correction;
- no-op an identical equal revision;
- no-op a lower stale revision.

Equal revision plus a different server row hash rejects the whole batch with
`REVISION_CONFLICT`. Batch-ID reuse, authority conflicts, invalid fields,
expired rows, and future UTC days also fail before a plan is returned.
`applyIngestBatchPlan` checks the plan's expected state version before cloning
and applying all row, binding, and receipt mutations. A storage adapter must
preserve that boundary in one transaction and retry preflight after a
conditional-write race; it must not apply plan entries one at a time.

## Retention and public projection

- Identifiable rows and authority bindings expire at bucket day plus 30 days.
- Batch receipts expire at `receivedAt + 7 days`.
- Expired rows are grouped into the coarsest UTC-day `scope: "all"` cohort.
- At least 20 distinct enrollments with non-zero period totals create an
  anonymous rollup. Zero-only corrections do not satisfy the privacy gate; a
  smaller cohort is dropped.
- Anonymous rollups contain period, scope, compaction version, contributor
  count, and decimal token sums only. They contain no enrollment IDs,
  contributor set, model/tool key, batch list, or reversible mapping.
- Enrollment deletion removes current rows, bindings, and receipts. Existing
  anonymous rollups remain and the deletion plan states that explicitly.

Public current, anonymous, and all-time totals are summed with `BigInt` and
returned as canonical decimal strings. Active current contributors count only
enrollments whose current-window rows sum to more than zero; zero correction
rows do not inflate the count.

## Verification

From the repository root:

    npm run test --workspace @tokenmonster/usage-domain
    npm run typecheck --workspace @tokenmonster/usage-domain
    npm run build --workspace @tokenmonster/usage-domain
