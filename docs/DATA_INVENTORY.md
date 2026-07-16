# TokenMonster data inventory

> Architecture update (2026-07-15): collector/storage entries that assume
> Tokscale/Electron describe the legacy migration slice. TokenTracker is the
> sole upstream authority under
> [ADR 0005](adr/0005-permanent-tokentracker-sidecar-adapter.md); TokenMonster
> retains only minimized aggregates and product-owned state.

> Status: Phase 0 privacy baseline
>
> Updated: 2026-07-15
>
> Owner: product/privacy owner (to assign before Private Alpha)

This document is the field-level source of truth for what TokenMonster may
read, retain, transmit, publish, and delete. A runtime implementation may keep
less data than this inventory, but it must not add a field or extend retention
without a reviewed contract and inventory change.

## 1. Data principles

- Core tracking, charts, character traits, reminders, and scripted dialogue
  work without a TokenMonster account or cloud connection.
- Token contribution and product analytics are separate, off-by-default
  consent choices.
- The default collector persists only projected aggregates. Raw upstream JSON
  is parsed in memory and then discarded.
- Prompt, response, source content, filename, path, repository, provider
  account, API key, cookie, and authorization material are forbidden in the
  contribution body, cloud database, application log, analytics, share, and
  diagnostic bundle.
- Local hourly buckets support charts and character rhythm. Cloud contribution
  contains UTC daily buckets only.
- Public copy says “tokens shared by TokenMonster contributors”; it never
  claims to represent all AI usage.

## 2. Storage and processing locations

| Location | Intended contents | Backup policy | User control |
| --- | --- | --- | --- |
| Managed TokenTracker or legacy collector process memory | Raw upstream JSON long enough to validate and project | Never backed up | Ends with request/process |
| TokenTracker adapter/gateway request memory | Strict projected metrics and, for starter selection, four 28-day provider totals until they are reduced to a decision | Never backed up or persisted | Ends with request |
| Companion SQLite | Safe local aggregates, revisions, character state, settings, bounded contribution queue | Local-only; excluded from crash bundles | Export/delete in companion |
| OS secret store | OpenAI BYOK key plus separate contribution-upload and deletion bearer secrets | Never copied into app backup | Rotate/delete in companion |
| Companion renderer memory | Current BYOK prompt/response, rendered state, and manual starter choice | Never backed up | Manual starter choice clears on reload/restart; conversation clears when conversation/window closes |
| Future local character-asset cache | Approved, integrity-verified public raster objects only; no runtime or cache is implemented yet | Planned as disposable, content-addressed local cache | Planned to be clearable; code-native fallback remains available |
| Cloudflare Worker memory | Validated request and transaction state | Never intentionally persisted | Request-scoped |
| D1 current tables | Hashed enrollment auth, consent, recent canonical buckets, optional shares | Time Travel plus independent logical export | Revoke/delete within stated window |
| D1 anonymous rollups | Irreversibly compacted historical coarse totals | Daily logical export; rebuild tested | Not attributable after compaction |
| Public API/cache | Contributor wording, coarse totals, update time, eligible breakdowns | Disposable/rebuildable | No individual profile |

## 3. Local usage data

| Field | Purpose | Source | Retention | Cloud/public |
| --- | --- | --- | --- | --- |
| `schemaVersion` | Decode local record | TokenMonster | Until local deletion | Version only may enter cloud |
| `collectorKind` | Enforce one parser authority | Companion choice | Until local deletion | Coarse enum enters cloud |
| `adapterVersion` | Reproduce projection behavior | Adapter package | Until local deletion | Enters cloud |
| `sourceVersion` | Quarantine parser upgrades | Exact upstream package | Until local deletion | Enters cloud |
| UTC window start/end | Render local hourly/day charts | Adapter scan request | Until local deletion | Only UTC day start enters cloud |
| provider/model family/tool | Explain coarse usage mix | Strict adapter mapping | Until local deletion | Coarse allowlisted enum only |
| token components | Charts and character inputs | Strict adapter projection | Until local deletion | Daily sums may enter cloud |
| value quality | Distinguish exact/estimated | Adapter | Until local deletion | Enters cloud |
| local revision/reconcile time | Absolute replacement and diagnostics | Companion | Until local deletion | Per-key revision enters cloud; reconcile time does not |
| `complete_scan_ledger.utc_date` | Prove a UTC date was actually scanned rather than infer a zero | Successful validated complete scan | Rolling 35 UTC days; cleared on collector-authority reset or local deletion | Never uploaded or published |
| `complete_scan_ledger.client` | Require all four qualified CLI scopes before monster analysis treats a date as observed | Fixed enum: Claude, Codex, Gemini, Grok | Rolling 35 UTC days; cleared on collector-authority reset or local deletion | Never uploaded or published |
| `complete_scan_ledger.completed_at` | Resolve repeat-scan evidence and bound retention | Companion clock after aggregate apply succeeds | Rolling 35 UTC days; cleared on collector-authority reset or local deletion | Never uploaded or published |
| local timezone | Display day/rhythm correctly | OS | Until preference reset | Never uploaded |
| adapter cursor/provenance | Avoid rescans where supported | Adapter | Until source reset | Never uploaded |

Token component semantics are fixed:

```text
input excludes cache
reasoning is an informational subset of output
total = input + output + cacheRead + cacheWrite + other
```

The adapter performs arithmetic with `BigInt`. Each wire component, including
`total`, must be a canonical decimal string no greater than
`Number.MAX_SAFE_INTEGER`.

Complete-scan evidence is local behavioral metadata, not a usage aggregate.
The V1 support/diagnostic export therefore exposes only its total row count and
does not export its dates, client scopes, or timestamps. A collector-authority
change is rejected until the user crosses the explicit source-reset boundary;
that reset transaction clears aggregates, scan evidence, cloud outbox/mirror,
monster snapshots, and last-scan time together so a new parser cannot inherit
an old parser's observation claims. Local deletion uses the same or a broader
purge boundary.

### Explicitly non-persistent collector data

The following may appear in an upstream process response but must be rejected
or discarded before TokenMonster persistence: workspace, project, session,
path, client data directory, message count, cost, performance, warning,
diagnostic, raw provider/model strings outside the allowlist, prompt, response,
and source content. Raw stdout/stderr must not be copied to application logs.

### Starter-character provider projection (implemented)

The adapter reads TokenTracker's local model-breakdown response for the latest
28 UTC days and immediately reduces it to exactly four numeric provider totals:
`openai`, `anthropic`, `google`, and `xai`. Those four values exist only in
request memory. They are not stored in TokenMonster's database, diagnostic
state, analytics, contribution queue, or cloud payload.

The four totals stop at the starter selector. The gateway response includes
only the resulting starter decision from this branch: selected character and
coarse provider-family reason, or a manual-choice-required reason and any tied
provider-family enums. It does not include numeric provider totals, upstream
model identifiers, or raw source metadata. The gateway's separate aggregate
metrics and daily series remain part of their existing content-blind DTO.

If the model-breakdown request, validation, or provider projection fails, the
gateway treats the four totals as unavailable and returns a manual-selection
decision. That optional failure does not fail or suppress the independently
loaded aggregate metrics.

## 4. Local character, settings, and diagnostics

| Record | Allowed fields | Retention | Notes |
| --- | --- | --- | --- |
| Character profile | Character manifest ID, deterministic traits, explanation keys, 28-day normalized inputs | Until local reset | No prompt/content inference |
| Mood history | Coarse mood, explanation key, day/hour aggregate references | Default 30 days | User may clear independently |
| Preferences | Locale, theme, reduced motion, reminder/quiet hours, source choice | Until reset | Cloud toggle defaults off |
| Manual starter choice | One allowlisted character ID | Current UI session only | Held in renderer memory; cleared by reload or restart and never sent to cloud |
| Reminder ledger | Rule ID, scheduled/fired time, dedupe state | 30 days | Notification text contains no project/content |
| Diagnostic state | Adapter versions, last success/error code, coarse OS/runtime version | Rolling 30 days | Detailed export requires preview |
| Share-card draft | Derived traits, selected visibility fields, local image | Until user deletes/export completes | No upload unless separately confirmed |

Diagnostic exports must use an allowlist and a canary test. They may not copy
the local database wholesale or include environment variables, home paths,
process command lines, raw collector output, credentials, prompt, or response.

### Future approved character-asset delivery (not implemented)

TokenMonster currently has no cloud character-asset downloader, CDN request
path, or runtime asset cache. The repository-only AI-Sister source/audit maps
are not release authorization and are not runtime manifests.

If that runtime is later approved, the release embeds the reviewed manifest
that is authoritative for that build. Runtime GETs may target only the exact
release-allowlisted HTTPS AI-Sister CDN origin and immutable public object keys
under `tokenmonster/characters/v1`; no arbitrary or manifest-supplied origin is
accepted. Each response must match the embedded SHA-256, byte size, and MIME
type before display. Verified files may enter a content-addressed local cache;
a failed request or validation uses the code-native local fallback or a
previously verified compatible cache entry.

The CDN necessarily observes the requested public object key and the client's
IP address. The request carries no query parameters and no token totals,
provider totals, starter rationale, user/account/install identifier, local
filename or filesystem/project path, or other usage-derived data. Enabling
this future egress requires a separate implementation, disclosure, tests, and
release approval.

## 5. BYOK interaction data

| Data | Location | Retention | Network destination |
| --- | --- | --- | --- |
| OpenAI API key | OS secret store | Until user deletes/replaces it | OpenAI Authorization header only |
| User message | Companion memory | Current UI conversation only | Directly to OpenAI |
| Model response | Companion memory | Current UI conversation only | Directly from OpenAI |
| Limited local history | Companion memory | Cleared with conversation/window | Included only in direct OpenAI request |
| Model ID/config | Companion settings | Until changed | OpenAI request |
| Error classification | Local diagnostic state | Rolling 30 days | Never includes body/header |

Every MVP Responses API request explicitly sets `store: false`. TokenMonster
does not proxy the request and does not describe this as legal Zero Data
Retention. The renderer transiently originates the password-field value during
setup, immediately clears that field, and never receives a vault-decrypted or
reusable plaintext key back from main; a narrow validated IPC performs setup and
the main process performs every provider request. On Linux, a `basic_text`
safe-storage backend disables persistent key storage.

## 6. Contribution request (`IngestSnapshotV1`)

The JSON body may contain only:

- `schemaVersion`, `batchId`, and UTC `generatedAt`;
- collector `kind`, `adapterVersion`, and `sourceVersion`;
- one to 30 buckets with UTC day start, coarse provider/model family/tool,
  value quality, monotonic revision, and token components.

The random upload credential is sent only as an HTTPS Bearer header. The
body never contains contributor/enrollment ID, bucket ID, client hash,
timezone/hour, event/session count, path, hardware ID, or a client-computed
payload hash. Strict schemas reject additional properties.

The local contribution queue retains only these already-safe bodies. It is
bounded to 30 days and is erased immediately when contribution is disabled,
unless the user explicitly chooses to finish queued uploads.

## 7. Cloud records and retention

Defaults below are product decisions for Alpha and require a privacy/legal
review before GA.

| Record | Fields | Default retention | Delete behavior |
| --- | --- | --- | --- |
| Enrollment | Internal random ID, separate upload/deletion secret verifiers, status, created/rotated timestamps | While opted in; tombstone 30 days after deletion | Revoke immediately; secrets cannot be recovered |
| Consent receipt | Enrollment ID, consent version, accepted/revoked time | While identifiable plus deletion receipt window | Removed/anonymized after 30 days |
| Current contributor bucket | Enrollment ID, UTC day, coarse dimensions, counts, quality, revision, server hash | 30 days after bucket day | Deletable and subtracted before compaction |
| Anonymous rollup | UTC period, coarse dimensions, token totals, eligible contributor cohort count | Indefinite while public counter operates | Cannot be traced back or individually removed |
| Batch receipt | Enrollment ID, batch ID, result/status hash | 7 days | Deleted with enrollment when possible |
| Share | High-entropy slug hash, derived traits/coarse totals, expiry | Default 30 days | Immediate delete and cache purge |
| Deletion receipt | Non-secret receipt ID, completion state/time | 30 days | Automatically expires |
| Security/rate event | Endpoint, coarse reason, timestamp, non-reversible rate-limit key | 30 days, shorter where feasible | Not tied to product profile |

At compaction, current contributor buckets are combined into a coarse
anonymous rollup only after the publication anonymity rule is satisfied. The
rollup must not contain enrollment IDs or a reversible contributor mapping.
Consent UI must state plainly that deletion can remove attributable data in
the current 30-day window; older totals have already been mixed into an
anonymous historical total and cannot be individually extracted or removed.

Public totals are rebuildable from anonymous rollups plus current canonical
buckets. A disposable cache is never the only copy.

## 8. Public data

The public aggregate endpoint may return:

- total tokens shared;
- today’s tokens shared;
- active contributing installations in the documented rolling window;
- last successfully rebuilt/confirmed time;
- coarse breakdowns only when at least 20 current contributors qualify;
- methodology and contributor-only wording.

It never returns enrollment IDs, per-contributor series, hours/timezones,
event/session counts, or enumerable character profiles. Animated counters end
at the most recently confirmed value.

## 9. Operational logs, metrics, and analytics

- Application access/error logs never include request bodies, Authorization
  headers, token dimensions, provider keys, prompt, response, or raw exception
  objects containing upstream output.
- A request correlation ID is random and short-lived; `batchId` is not reused
  as an analytics identity.
- Infrastructure metrics use counts, latency, status class, queue depth, and
  build/schema version only.
- Product analytics is a separate opt-in. It may record coarse UI event name,
  app version, coarse platform, and success/failure; no usage dimensions,
  character footprint, paths, or interaction content.
- Third-party session replay and autocapture are prohibited.
- Cloudflare account-level edge-log retention and access must be recorded and
  reviewed before production; application code must not create its own raw-IP
  log.

## 10. Deletion and incident requirements

1. Turning contribution off prevents creation of new cloud requests and clears
   the queue according to the user’s explicit choice.
2. “Stop and delete” uses the separate deletion credential, revokes both
   credentials first, deletes current buckets,
   consent and shares transactionally where possible, rebuilds public totals,
   and returns a non-secret receipt.
3. Logical exports follow the same retention. Expired identifiable records are
   removed from future exports; backup expiry and Time Travel limitations are
   disclosed in the privacy notice.
4. Any forbidden field or secret found in wire, D1, log, analytics, crash
   report, or share triggers contribution shutdown, credential revocation,
   scope assessment, purge, notification decision, and a regression test
   before re-enable.
5. Schema, purpose, destination, or retention changes require a new consent
   version when they materially expand processing.

## 11. Release checks

- Contract and privacy-canary tests pass on every pull request.
- Cloud-off packet capture contains no enrollment or usage request.
- BYOK mock proves `store: false` and the approved OpenAI origin.
- On Linux `basic_text`, BYOK and contribution/deletion credentials cannot be
  persisted; without a usable OS secret service the product remains local-only.
- Retention/compaction and deletion are tested with an attributable current
  bucket plus an already-anonymous historical rollup.
- A clean diagnostic export contains no forbidden key or canary value.
- Starter-selection tests prove that the 28-day model breakdown becomes four
  request-scoped provider totals, only the decision crosses the gateway, and a
  projection failure falls back to manual choice without breaking metrics.
- Until an approved asset runtime exists, packet capture shows no character
  asset request. Before enablement, tests must pin the exact AI-Sister CDN
  origin, embedded approved manifest, SHA-256/size/MIME checks, immutable cache,
  no-query request shape, and local fallback.
- The production privacy page matches this inventory field-for-field.
