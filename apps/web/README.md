# `@tokenmonster/web`

The first public TokenMonster slice is a zh-TW-first React SPA and a Hono API
served from one Cloudflare Worker deployment. Static assets are asset-first;
only `/v1/*` and `/healthz` are routed worker-first.

The deploy entry uses the strict Cloudflare API composition. Without the
`TOKENMONSTER_DB` D1 binding, the counter fails closed as unavailable and the
minute cron is a no-op. With a valid binding, its locally tested maintenance
order is `deletion -> compactor -> preserving retention -> projection`. The
compactor closes at most the oldest one fully ended and expired UTC day per
cron, writes one mapping-free `day-all-v1` rollup only at k>=20, and atomically
drops the whole day without a rollup when below k or outside safe capacity.
Commit-time guards recheck the input and migration triggers make closure
immutable; retention preserves compaction-owned usage and bindings. The final
step rebuilds authoritative public projection from current accepted rows plus
anonymous historical rollups. No placeholder or animated total is shown.

The HTTP enrollment/ingest/delete/status surface is exercised by a Companion
source slice with real payload preview, OS-backed scoped secrets, background
sync/idempotent retry, local stop, delete and deletion-status handling.
Background sync has local scheduler/service tests; server pause/resume now has
domain/HTTP/D1/Worker tests, while Companion wiring and staging packet capture
remain pending. The
Worker exports and binds separate SQLite-backed Durable Objects for
route-scoped quota and deletion suppression; mutation routes still require the
independent D1, flag, and secret gates. The download control independently
fails closed until the single `TOKENMONSTER_PUBLIC_RELEASE_JSON` binding is the
exact canonical JSON generated from one promoted signed Windows x64 artifact.
The URL must be the version-bound
`https://cdn.ted-h.com/tokenmonster/releases/windows/v<version>/TokenMonsterSetup.exe`
object; a missing, non-canonical, reordered, query-bearing, foreign-host, or
version-drifted configuration keeps the CTA disabled. A genuinely absent
binding returns the precise `404 PUBLIC_RELEASE_NOT_CONFIGURED` bootstrap
state; a configured but invalid binding returns `503 PUBLIC_RELEASE_UNAVAILABLE`.
The
protected release workflow generates this JSON from the exact signed Setup
bytes, verifies the bucket and authoritatively reads the versioned R2 object
before and after any missing-key put, recalls the full public object and
compares SHA-256 plus byte length, then monotonically sets and reads back this
one binding. Same-version JSON drift and version downgrades fail. Four
hand-authored metadata fields can no longer light the CTA. This
runtime Worker projection lets a release owner open a verified download
without changing the React source or baking mutable release metadata into the
client bundle.

Character presentation uses only stable catalog metadata and code-native
letter placeholders. The production build fails if any blocked candidate asset
path or WebP marker enters the client output.

```sh
npm run typecheck -w @tokenmonster/web
npm test -w @tokenmonster/web
npm run build -w @tokenmonster/web
```

No D1 IDs, deployment routes, domains, secrets, or analytics are configured in
this package. The Durable Object class bindings/migration and one-minute cron
are checked in and pass Wrangler dry-run, but any current deploy still has no
`TOKENMONSTER_DB`: public totals/writes return `503` and scheduled D1 work is a
no-op. Real D1 migration rehearsal, staging E2E, backup/restore and suppression
replay, signed/native Companion smoke, legal/license approval and raster rights
remain STOP gates. Deployment is intentionally a separate owner-approved
release step; none of the source-test claims above are production evidence.
