# @tokenmonster/contracts

This workspace owns the versioned, public JSON contracts shared by TokenMonster collectors and ingestion services.

## IngestSnapshotV1

Version 1 sends revisioned UTC daily aggregate buckets. Raw usage events and event/session counts remain on the collector. Every token count is a canonical non-negative decimal string no greater than Number.MAX_SAFE_INTEGER so the D1 binding can convert it to a JavaScript integer without precision loss. Public all-time sums are returned separately from SQL int64 storage as text.

The input field is normalized non-cache input. cacheRead and cacheWrite are disjoint from input. reasoning is informational metadata that is already a subset of output and must never be added to total a second time. The total field must equal:

    input + output + cacheRead + cacheWrite + other

Every snapshot declares exactly one mutually exclusive parser authority:

- tokscale
- tokentracker-bridge

The ingestion service must bind a contributor to one authority for a given source window. TokenTracker bridge aggregates must not be added to tokscale aggregates for the same usage.

collector.adapterVersion records the TokenMonster adapter package version. collector.sourceVersion separately records the audited upstream parser version, such as tokscale 4.5.2 or TokenTracker 0.79.8. Both are required SemVer values so a parser upgrade can be quarantined independently from an adapter release.

All objects are strict. Unknown keys are rejected, including privacy-sensitive fields such as prompt, response, path, project, account, and API key fields.

Authentication is deliberately not part of IngestSnapshotV1. An ingestion client sends its credential in the HTTP Authorization header. Credentials must never be added to, merged into, or logged with the JSON body.

Hourly data stays in the local domain for mood and rhythm features. The public privacy boundary accepts UTC daily buckets only.

The server derives enrollment identity from bearer authentication. It must not accept enrollmentId, bucketId, or payloadHash in the body. A canonical server bucket is identified by:

    authenticated enrollment + bucketStart + provider + modelFamily + tool

The server computes its own canonical payload hash. For an existing bucket:

- same revision and same hash is an idempotent no-op
- same revision and a different hash is rejected as a conflict
- a lower revision is stale and ignored
- a higher revision replaces the absolute bucket value, including downward corrections

## Contribution API V1

`contribution-api-v1` owns the strict JSON request and response shapes around
enrollment, immutable consent events, ingest receipts, pause/resume, credential
rotation, and deletion status. It deliberately keeps bearer authentication and
idempotency keys in HTTP headers rather than JSON bodies.

Enrollment and resume require an affirmative contribution consent
acknowledgement. Consent updates can record a later revocation. Enrollment and
credential rotation responses are the only contracts that carry the one-time
upload/deletion credential pair; neither exposes a stable installation ID.
Upload, deletion, and deletion-status credentials have distinct typed prefixes
and a 256-bit base64url secret component so accidental role substitution fails
schema validation.

Deletion job IDs are opaque. Status responses expose only lifecycle state,
timestamps, and the required disclosure that already anonymous historical totals
cannot be attributed back to one installation. All objects are strict so prompt,
account, path, credential, or arbitrary metadata fields cannot be smuggled into
these boundaries.

batchId identifies a whole-batch retry; it is not an authentication credential.

## Commands

From the repository root:

    npm test
    npm run typecheck
    npm run build
