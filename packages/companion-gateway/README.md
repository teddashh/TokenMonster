# `@tokenmonster/companion-gateway`

This package is TokenMonster's browser boundary. It hosts the companion UI and
a single aggregate endpoint on an ephemeral `127.0.0.1` port. It receives a
`TokenTrackerAdapter` and either immutable HTML/CSS/JavaScript buffers or the
companion UI's static directory from the launcher. Directory mode resolves and
reads only `index.html`, `styles.css`, and `app.js` once; request paths never
reach the filesystem. The gateway has no cloud, BYOK, or provider-log access.

The launcher opens the returned one-time bootstrap URL. That URL's random
nonce is exchanged for a separate random HttpOnly, SameSite session cookie and
is immediately invalidated; the URL nonce is never reused as session authority.
All UI assets and `GET /api/companion` require the cookie. The gateway rejects
non-loopback Host values, foreign Origin and Fetch Metadata values, non-GET
methods, query strings, and every route not listed in its source. It never
enables CORS or proxies arbitrary TokenTracker routes.

`GET /api/companion` asks the injected adapter for one bounded 28-day UTC daily
aggregate range and the optional four-family provider projection used for
starter selection. Its response is rebuilt from an allowlist and contains only
the generation timestamp, a starter decision, total token counts for
today/7 days/28 days, and UTC daily total token counts. Provider totals, model
IDs, source IDs, adapter details, and thrown messages never cross this gateway.
If the provider projection fails, metrics remain healthy and the starter
decision asks the user to choose; daily failures use stable
`sidecar-unavailable` or `sidecar-incompatible` codes.
