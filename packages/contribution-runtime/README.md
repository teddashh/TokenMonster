# @tokenmonster/contribution-runtime

Shared local contribution lifecycle for TokenMonster hosts. This package owns
content-blind preview, consent, outbox sync, pause/resume/deletion, background
scheduling, and the strict TokenTracker sidecar-to-daily projection.

It has no Electron, renderer, gateway, or collector implementation. Hosts must
inject a reviewed local store, four independent secure credential slots, a
fixed reviewed cloud origin, and the strict TokenTracker adapter. The fourth
slot holds one atomic V2 pending-enrollment bundle. Contribution remains opt-in
and disabled when any required slot is not OS-backed.

Before first network enrollment, the runtime creates independent `tm_u2_`,
`tm_d2_`, and `tm_r2_` credentials plus the exact affirmative consent and
deletion idempotency key, then persists the complete bundle in one encrypted
write. Activation writes upload and deletion authority before clearing pending
state last. Startup retries the byte-identical V2 request after ambiguous
response loss and resumes safely after every intermediate credential write.
A definitive expired/no-record response deletes the pending bundle and requires
a fresh preview; it never silently generates or consents to a replacement.

Credential operations are bounded and receive abort signals. Stop and delete
abort an in-flight upload before returning; shutdown rejects new work and waits
for accepted work to quiesce before the host closes the local store.
Initialization is single-flight, and shutdown aborts and joins the underlying
credential promises even when an earlier caller-facing deadline fired. Stop stays
fail-closed if remote pause or outbox cleanup fails. Delete removes upload
authority before the first remote request, retains the stable deletion authority
needed for a response-loss retry, and treats accepted cloud deletion as
committed even when later local cleanup still needs recovery.

The runtime does not trust a host's capability claim by itself. Initialize,
set, and clear must return an exact persistence snapshot that agrees with the
slot's current status and readable value: configured secrets must be actively
OS-backed, while a cleared slot must be empty and actively memory-only. A
missing field, RAM-only write, stale readable value, backend mismatch, or other
contradiction hard-pauses enrollment, upload, deletion, and recovery until a
newly created service instance or restarted process initializes successfully.
A best-effort remote pause, an already-started protective cloud deletion, and
local authority removal may still run to reduce exposure after a failure.

Every sync re-reads current consent. A revision change, or an exact `403
application/problem+json` `CONSENT_REQUIRED` response caused by a read/upload
race, durably stops upload, clears unseen queued snapshots where possible, and
best-effort pauses the remote enrollment. Background retry cannot resume it;
the player must obtain a fresh preview and consent receipt. Startup and explicit
recovery also reconcile interrupted enrollment, pause, deletion, and terminal
local-cleanup states without inventing consent.

The projection reads only the exact adapter contract. It never reads
TokenTracker databases or queue files, never adds another scanner, never sends
hourly/session data, and never treats `unavailable` coverage as a zero day.
