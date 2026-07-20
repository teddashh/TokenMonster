# `@tokenmonster/companion-gateway`

This package is TokenMonster's fixed loopback browser boundary. It receives a
strict `TokenTrackerAdapter`, collector controller, character configuration,
and either immutable UI buffers or the companion UI's static directory. It
binds only an ephemeral `127.0.0.1` port and never proxies arbitrary upstream
routes. It has no direct TokenMonster-cloud client or credential and no
provider-log, filename, or project-path access. Fixed contribution actions
delegate only to an injected local controller; the browser can supply neither
a TokenMonster-cloud endpoint nor a contribution credential. Its only
prompt/response boundary is the optional fixed BYOK chat API: content exists
transiently in companion memory and travels directly to the selected provider,
never through TokenMonster cloud.

The launcher opens a one-use bootstrap URL. Its random nonce is exchanged for
a separate random HttpOnly, SameSite session cookie and immediately
invalidated. Protected routes reject unauthenticated requests, non-loopback
Host values, foreign Origin or Fetch Metadata, unexpected methods, query
strings, bodies, keys, and every path outside the source allowlist. CORS is
never enabled.

The fixed API surface contains:

- companion totals plus collector status and refresh;
- bounded family/model analytics and the 24-hour UTC-day quota estimate;
- the eleven-character roster, local character/wardrobe selection, bounded
  tap interaction, local progression projection, and a separate 28-day player
  profile;
- exact fixed-pack status and explicit complete-pack enable/revoke control;
- fixed BYOK status/configure/clear/chat routes for the local OpenAI adapter;
- strict anonymous-contribution status, preview, enable, stop, delete, and
  interrupted-state recovery controls backed only by an injected local
  controller;
- a content-free `zh-TW`/`en` UI locale preference shared by the CLI and
  Electron hosts;
- exact static UI files and content-addressed character object paths.

Responses are rebuilt from strict TokenMonster DTOs. Raw sidecar source/model
metadata, numeric starter-family totals, adapter details, local paths, and
thrown messages never cross the gateway. Collector and projection failures use
stable fail-closed states while preserving the last healthy local view where
the contract permits it.

`GET /api/contribution/status` is session-gated, query-free, and content-blind.
It reports only availability, local lifecycle state, bounded outbox count,
action capability booleans, and reduced deletion state. It never returns
enrollment/deletion IDs, consent revisions, credentials, cloud endpoints, or
thrown text. Missing, throwing, contradictory, accessor-bearing, or otherwise
malformed controller input becomes one canonical unavailable/default-off
response.

The five contribution mutation routes accept only exact, bounded bodies with a
fixed confirmation phrase: local payload preview, preview-ID-bound enable,
stop, delete, and recovery. Responses are rebuilt from strict action-specific
DTOs and postconditions; a controller cannot smuggle extra data or claim enable,
stop, deletion, or recovery success while returning a contradictory state.
Requests remain single-flight, browser disconnect does not cancel an accepted
privacy mutation, and gateway close waits for accepted contribution work before
resolving. The gateway never accepts a cloud URL, bearer credential, raw
enrollment request, or arbitrary upstream operation from the browser.

BYOK routes require the same loopback session and exact-origin protections as
the rest of the API. The gateway accepts one bounded control operation or chat
at a time, bounds vault initialization/configure/clear waits, and aborts the
provider request when the browser disconnects or the gateway closes. API keys
remain in the injected local secret slot, are never returned, and are sent only
to the fixed OpenAI Responses endpoint. Provider requests force `store: false`;
the gateway does not persist conversation history, prompts, or responses.

Character objects are cache-only. Configuration accepts exactly
`cdnBaseUrl: null`; there is no fetch hook or per-object downloader. An
allowlisted, unlocked object is served only after its cache bytes match the
SHA-256 filename and size bound. A missing, corrupt, locked, malformed, or
unapproved object returns a fail-closed response, and the UI uses code-native
letter art or silence. Any future network delivery requires a separately
reviewed, explicitly consented fixed-pack protocol whose request set and order
are independent of local usage and progression.

That fixed-pack protocol is implemented behind default-null authorities. It
accepts only a complete schema-v2 release, descriptor, and exact HTTPS
origin/path binding. `GET /api/characters/assets` reads only local status, and
`POST /api/characters/assets/consent` accepts exactly one boolean. Enable
verifies or downloads the one immutable complete pack before activating art.
Restart verifies a consented cache without automatic network retry. Disable
switches to letter mode immediately, persists revocation, and removes only the
release's exact objects without network I/O. Status errors are stable codes and
never include an origin, local path, response body, or thrown text.

`POST /api/characters/interact` accepts only the currently selected, unlocked
character with action `tap` and locale `zh-TW` or `en`. It returns either one
bounded catalog line or an `animation-only` cooldown result. Its mode-0600
atomic daily store contains only each character's last shown instant, daily
count, and next deterministic seed; it never stores returned copy or an event
history and the route performs no adapter or network call.

`GET|POST /api/preferences/locale` is session-gated and query-free. The POST
also requires the exact loopback Origin and accepts only `{locale,
expectedRevision}`. Its goal-idempotent CAS makes a response-lost retry of an
already-selected locale succeed without increasing the revision. The strict
canonical mode-0600 store is derived beside `progressionStorePath`, contains
only schema version, revision, and locale, and is shared across changing
ephemeral ports. It uses no cloud service or localStorage. Corrupt,
noncanonical, symlinked, non-private, or inaccessible state is preserved and
fails closed to the session-only `zh-TW` default; errors never expose a path.
POSIX reads use no-follow and all platforms compare lstat/open-handle identity.
The authenticated fixed document routes `/session/locale/zh-TW` and
`/session/locale/en` provide a content-free per-tab fallback that forces a full
UI re-render; they accept no query except the exact optional `?view=pet`.

`GET /api/characters/profile` always requests exactly the current 28 UTC dates
for the fixed analytical character ID; it accepts no query parameters. The
response exposes only learning/readiness, coverage and freshness bands,
allowlisted tool/cache/output traits, mood/energy, evolution, and banded reason
codes. It labels the input `estimated-positive-days`, never claims missing or
empty dates are observed, and suppresses provider-distribution traits because
the collector source bucket does not attest the model provider.

The gateway, not the adapter, marks the final UTC bucket as `partial`. The
engine therefore derives mood from D-1, the latest complete UTC date, against
earlier available dates; today's unfinished total cannot make morning usage
look artificially quiet. If D-1 is unavailable, mood is `unknown`. The current
upstream cannot attest a complete zero-use day, so production does not emit
`resting` until that capability exists.

The mode-0600 `character-profile-v1.json` snapshot persists only the strict
derived state and banded explanations, never the footprint or token
components. It provides engine continuity and a stale response only when the
snapshot is at most 48 hours old and ends on the current or previous UTC date.
Invalid, future, older, or extra-key snapshots are ignored; upstream failures
otherwise use the gateway's generic fail-closed error envelope.
