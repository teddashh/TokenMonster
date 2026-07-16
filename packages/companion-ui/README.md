# `@tokenmonster/companion-ui`

Lightweight, zh-TW-first static companion UI served by the TokenMonster
loopback gateway. The package has no browser runtime dependencies and makes no
request except a same-origin `GET /api/companion`.

The first screen always shows the code-native TokenMonster letter companion and
four sister choices. A unique highest local 28-day provider total suggests the
starting sister; ties or unavailable provider data leave the choice to the
user. A manual choice wins for the current UI session, and token volume never
becomes progression or an unlock rule.
Metrics remain placeholders until a strict, internally consistent healthy
aggregate response arrives. An unreachable or incompatible sidecar produces a
small, sanitized recovery state. Temporary unavailability retries after 5,
15, then at most 60 seconds; a compatible response or manual retry resets that
backoff. An incompatible version never retries automatically and asks the user
to restart or update TokenMonster. Raw errors, fake/demo numbers, collector
controls, cloud controls, BYOK, and reviewer-facing policy copy are
intentionally absent.

## Gateway response

The healthy JSON response is strict:

```json
{
  "status": "healthy",
  "generatedAt": "2026-07-15T12:00:00.000Z",
  "starter": {
    "outcome": "selected",
    "selectedBy": "unique-provider-total",
    "characterId": "claude",
    "providerFamily": "anthropic"
  },
  "totals": {
    "today": 30,
    "last7Days": 50,
    "last28Days": 60
  },
  "daily": [
    { "utcDate": "2026-07-10", "totalTokens": 20 },
    { "utcDate": "2026-07-15", "totalTokens": 30 }
  ]
}
```

`today`, `last7Days`, `last28Days`, and every `daily.utcDate` are UTC calendar
day buckets. The UI labels them as UTC; only the small `generatedAt` update time
is formatted in the user's local display time and says so explicitly.

Error responses are limited to `sidecar-unavailable` and
`sidecar-incompatible`. Neither raw code is rendered to the page. Unavailable
is transient and uses bounded automatic retry; incompatible is non-transient,
stops automatic and visibility-triggered retries, and offers a manual recheck
after restart or update.

## Serving the assets

After building, the gateway may import `getCompanionUiAssetDirectory()` and
read only `index.html`, `styles.css`, and the self-contained `app.js`. It serves
those immutable bytes at `/`, `/assets/companion.css`, and
`/assets/companion.js` with its own loopback session, Host, Origin, and path
traversal protections. `index.html` contains a restrictive CSP and only
references those same-origin routes.

```sh
npm run typecheck --workspace @tokenmonster/companion-ui
npm test --workspace @tokenmonster/companion-ui
npm run build --workspace @tokenmonster/companion-ui
```
