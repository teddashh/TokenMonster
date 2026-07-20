# `@tokenmonster/api`

Hono HTTP boundary for TokenMonster's Cloudflare Worker. The core handler uses
only Web-standard `Request`/`Response` APIs and injected ports. The separate
`cloudflare-worker` module is the fail-closed deploy composition for D1 and
Cloudflare Web Crypto adapters.

The currently implemented public vertical slice includes:

- process-only `/healthz`;
- version and exact collector compatibility metadata;
- immutable contribution consent documents in `zh-TW` and `en`;
- public totals with fixed contributor wording, decimal-string validation,
  ETag support, and fail-closed unavailable behavior;
- RFC Problem Details, request IDs, narrow optional CORS, and baseline security
  headers.

The mutation boundary also exposes:

- `POST /v1/enrollments`;
- `POST /v2/enrollments` for recoverable, client-held first-enrollment
  credentials;
- `POST /v1/me/ingest-snapshots`;
- `POST /v1/me/pause` and `POST /v1/me/resume` with an upload-scoped bearer;
- `DELETE /v1/me/data`;
- `GET /v1/deletions/:jobId` with its independently scoped status bearer.

Compatibility advertises snapshot schemas 1 and 2. The already-published V1
enrollment response intentionally retains its exact `["1"]` capability field so
older clients cannot lose one-time credentials after a successful enrollment;
trusted native clients use the separate V2 recoverable flow and
`/v1/compatibility` for current support. A V2 success response never echoes a
credential or installation ID. Exact replay verifies all three presented
credentials and the original accepted consent; first creation additionally
requires a current, fresh acknowledgement. The Worker keeps the
exact V1 tokscale tuple for migration and accepts the permanent V2
tuple `tokentracker-sidecar / 0.1.0 / 0.80.0`; every other sidecar source or
adapter version fails closed before storage.

Production must inject `deriveRateLimitKey` plus the matching api-domain command
callback for each enabled mutation. The deploy adapter binds those callbacks to
the api-domain storage, credential, policy, and rate-limit ports. A missing
callback or key derivation fails closed with `503 SERVICE_UNAVAILABLE`.

Deletion-status reads inject `getContributorDeletionStatus` separately and do
not use a mutation rate-key derivation. The route accepts one canonical opaque
job path, no query or request body, and an exact Bearer header; its strict V1
response exposes no installation or credential field.

`deriveRateLimitKey` may inspect edge/authentication request metadata but must
return only a non-reversible, route-scoped key. It must not retain or log the
request, raw IP, bearer credential, or provider data, and it must not consume or
clone the request body. Mutation bodies are independently limited to 64 KiB,
fixed mutation paths reject every query string, strict JSON is required where a
body is defined, and mutation responses never receive CORS headers.

`createTokenMonsterApi()` defaults `readPublicTotals` to unavailable. Production
must inject a reader backed by the rebuildable public projection. It must never
inject sample or animated values into a public deployment.

## Cloudflare Worker composition

`createCloudflareApiWorker(runtimePorts)` and
`composeCloudflareTokenMonsterApi(env, runtimePorts)` connect the existing HTTP
handlers to `@tokenmonster/api-domain`, `@tokenmonster/api-cloudflare`, and the
guarded `@tokenmonster/cloud-d1` mutation storage. The same `TOKENMONSTER_DB`
binding serves the independently rebuildable public totals reader. Invalid or
missing mutation configuration never disables health, compatibility, consent,
or a valid public projection.

Mutations have three independent enable gates:

1. `TOKENMONSTER_MUTATIONS_ENABLED` is exactly `"true"`;
2. a D1-shaped `TOKENMONSTER_DB` plus strict credential/rate-key JSON secrets
   are present;
3. the deploy composition supplies durable `RateLimitPort` and independently
   stored `SuppressionLedgerPort` implementations.

The default `cloudflareApiWorker` deliberately supplies neither of the last two
ports and therefore keeps all mutation routes at sanitized
`503 SERVICE_UNAVAILABLE`; environment flags alone cannot make it writable.
The package also provides reviewed Cloudflare RPC ports and two deploy classes
through `@tokenmonster/api/cloudflare-durable-objects`. The web entrypoint binds
them explicitly only when both namespaces exist. No process-memory fallback is
permitted.

Known environment bindings are:

- `TOKENMONSTER_DB`: D1 binding;
- `TOKENMONSTER_MUTATIONS_ENABLED`: absent/`"false"` or exact `"true"`;
- `TOKENMONSTER_CREDENTIAL_CONFIG_JSON`: strict input for
  `createCloudflareCredentialService` (`currentPepper`, optional
  `previousPepper`, `deletionStatusDerivationKey`, `suppressionKey`);
- `TOKENMONSTER_RATE_KEY_CONFIG_JSON`: strict input for
  `createNonReversibleRateLimitKeyDeriver` (`enrollmentEdgeKey`,
  `ingestTokenKey`, `deletionTokenKey`);
- `TOKENMONSTER_ALLOWED_PUBLIC_ORIGIN`: optional exact HTTPS origin without
  path, query, credentials, or fragment.

Both secret JSON bindings are capped at 8 KiB. Their nested keys use a bounded
`keyId` and a canonical unpadded base64url encoding of exactly 32 bytes. The
underlying factories reject unknown fields, duplicate IDs, reused key material,
and malformed encodings. Errors, configuration, raw IPs, bearer credentials,
and key material are never logged or returned. Enrollment derives its
non-reversible quota key from Cloudflare's `CF-Connecting-IP`; ingest/lifecycle
and delete derive distinct keys from their already validated, scope-specific
bearer. Pause and resume share a dedicated 10-per-minute lifecycle bucket while
reusing only the upload-token HMAC derivation key, never the bearer itself.

No D1 database ID or production secret is committed here. The web Wrangler
entrypoint includes only the reviewed Durable Object bindings/migration and
cron; D1 UUIDs, environments, routes, and secret values remain deployment-owned
configuration.
