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
Background sync has local scheduler/service tests; staging packet capture and
server pause/resume are not implemented. The
Worker exports and binds separate SQLite-backed Durable Objects for
route-scoped quota and deletion suppression; mutation routes still require the
independent D1, flag, and secret gates. The download control is also
unavailable until a signed Alpha artifact exists.

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
