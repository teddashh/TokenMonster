# `@tokenmonster/api-domain`

Pure enrollment, authenticated ingest, deletion orchestration, and scoped
deletion-status queries for the TokenMonster V1 API. The package has no Hono,
Cloudflare, D1, or Node runtime dependency. Adapters provide credentials,
clocks, opaque IDs, rate limits, and atomic storage.

Raw bearer credentials are transient outputs only. Storage ports accept only
public lookup IDs and 32-byte HMAC-SHA-256 digests. Deletion suppression is an
external, replayable boundary so restoring an old primary backup cannot
resurrect identifiable contributor data.

`getContributorDeletionStatus` accepts only the opaque job ID and its separate
status bearer. Its result contains lifecycle timestamps and the historical
retention disclosure, never an installation ID or credential artifact.
