# `@tokenmonster/api-domain`

Pure versioned enrollment, authenticated ingest, pause/resume lifecycle,
deletion orchestration, and scoped deletion-status queries for TokenMonster.
The package has no Hono, Cloudflare, D1, or Node runtime dependency. Adapters
provide credentials, clocks, opaque IDs, rate limits, and atomic storage.

Ingest accepts both migration-compatible `IngestSnapshotV1` and permanent
sidecar `IngestSnapshotV2`. The same idempotency, absolute revision,
day-authority, retention, deletion, and privacy behavior applies to both.
Collector support remains a fail-closed adapter policy; the production V2
identity is exactly `tokentracker-sidecar / 0.1.0 / 0.80.0`.

Raw bearer credentials are transient outputs only. Storage ports accept only
public lookup IDs and 32-byte HMAC-SHA-256 digests. Deletion suppression is an
external, replayable boundary so restoring an old primary backup cannot
resurrect identifiable contributor data.

Recoverable V2 enrollment accepts three credentials already durably held by a
trusted client. First creation requires the current consent revision, rejects
acknowledgements more than ten minutes old, and keeps the existing five-minute
future-skew bound. An exact recovery replay bypasses only those current-policy
and freshness checks: it still verifies all three stored credential verifiers
and exact accepted consent. Creation and replay converge through one atomic
storage operation. V1 enrollment behavior and response shape are unchanged.

Pause and resume use only the upload-scoped credential and reauthenticate it
inside the atomic lifecycle transaction. Pause is an idempotent state change
that retains existing current/anonymous totals; resume requires the current
affirmative consent document and atomically records its immutable receipt.
Repeated controls return stored timestamps/receipts without duplicate events,
and deleting/deleted states fail closed.

`getContributorDeletionStatus` accepts only the opaque job ID and its separate
status bearer. Its result contains lifecycle timestamps and the historical
retention disclosure, never an installation ID or credential artifact.
