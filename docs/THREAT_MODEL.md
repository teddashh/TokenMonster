# TokenMonster threat model

> Architecture update (2026-07-15): Tokscale/Electron threats remain relevant
> only during migration. The permanent model is an exact-pinned managed child,
> strict loopback adapter/gateway, and TokenMonster-owned UI under
> [ADR 0005](adr/0005-permanent-tokentracker-sidecar-adapter.md).

> Status: Phase 0 baseline
>
> Updated: 2026-07-15
>
> Review cadence: before Private Alpha, each collector/source upgrade, and each
> new cloud/BYOK capability

## 1. Scope and security objectives

This model covers the permanent TokenTracker sidecar adapter/gateway, legacy
tokscale/Electron migration slice, local storage and loopback UI, OpenAI BYOK
path, Cloudflare Worker/D1 ingestion, public aggregate/share surfaces, release
artifacts, and both current placeholders and the unimplemented future
AI-Sister CDN character-asset path.

Security objectives, in priority order:

1. Never expose provider credentials, prompts, responses, source content,
   paths, or project identity through TokenMonster.
2. Never upload usage without explicit contribution consent.
3. Make replay, retry, rescan, correction, and out-of-order delivery converge
   without double counting.
4. Keep local tracking/character value available during cloud failure.
5. Prevent untrusted collector output or public input from executing code,
   injecting markup/logs, or causing unbounded resource use.
6. Keep public statistical claims honest; the counter is voluntary and not an
   attested billing ledger.

## 2. Assets and trust boundaries

Protected assets include BYOK and enrollment secrets, local usage aggregates,
consent state, current contributor buckets, anonymous rollups, character
profiles, release signing keys, asset rights records, and public-counter
integrity.

```text
AI tool logs
    │ untrusted local files
    ▼
pinned collector process ── untrusted JSON ──► strict adapter projection
                                                    │ safe local aggregate
                                                    ▼
                                          Electron main + SQLite
                                             │             │
                            direct BYOK HTTPS│             │opt-in daily snapshot
                                             ▼             ▼
                                          OpenAI       Cloudflare Worker
                                                          │ validated transaction
                                                          ▼
                                                          D1
                                                          │ coarse public read
                                                          ▼
                                                     public website
```

The implemented starter path is an additional local-only minimization
boundary, separate from the aggregate metrics path:

```text
TokenTracker local model breakdown (latest 28 UTC days)
    │ untrusted response
    ▼
strict adapter ──► four request-scoped provider totals ──► starter selector
                  (never persisted)                           │
                                                              ▼
                                                    decision-only gateway DTO
                                                              │
                                                              ▼
                                                    loopback companion UI

projection unavailable ──► manual choice; aggregate metrics continue
```

Trust-boundary rules:

- Collector files and stdout are hostile input even when produced by a pinned
  dependency.
- The Electron renderer is untrusted relative to secrets and native access.
- The contribution API trusts neither body fields nor client-computed IDs or
  hashes; bearer authentication establishes enrollment context.
- D1 canonical rows/anonymous rollups are truth. Public cache and animated UI
  are disposable projections.
- Character source files are untrusted for both technical payloads and legal
  redistribution rights.
- Numeric starter provider totals and upstream model/source metadata stop
  before the gateway. The UI receives only the starter decision, and its manual
  override currently lasts only for the in-memory UI session.
- No cloud character-asset runtime is implemented. Any future runtime trusts a
  release-embedded approved manifest, not a mutable live manifest or URL
  supplied by upstream data.

## 3. Threat actors and assumptions

- A malicious webpage attempts to reach a local loopback bridge.
- A modified log or local user attempts command/schema injection or counter
  inflation.
- An internet client replays, races, fuzzes, enumerates, or floods the API.
- A compromised dependency/action or fake executable attempts supply-chain
  execution/exfiltration.
- An XSS or compromised renderer attempts to steal BYOK/enrollment secrets.
- An operator accidentally enables body/header logging or mishandles backups.
- A curious public user tries to infer one contributor from breakdowns/shares.

The MVP does not defend against a fully compromised operating-system account.
It also cannot prove that a contributor’s local token counts are genuine or
globally deduplicate the same synced provider log across unrelated installs.
The product removes incentives to inflate and discloses these limits.

## 4. Threat register

| ID | Threat | Primary controls | Verification | Release status |
| --- | --- | --- | --- | --- |
| COL-01 | Collector emits prompt/path/session/workspace fields | Strict upstream schema, immediate allowlist projection, no raw persistence/log | Sensitive canary fixture and storage/log scan | Blocker |
| COL-02 | Command injection through date/client/config | Fixed argv builder, enum clients, ISO-day validation, `shell: false`, no arbitrary args | Unit tests inspect executable/argv/options | Blocker |
| COL-03 | Environment causes upstream network/login/extra-dir behavior | Fresh allowlisted environment, isolated config, pricing cache-only, remove sensitive tokscale vars | Spawn-policy tests and network smoke | Blocker |
| COL-04 | Hung/bomb output exhausts resources | Timeout, stdout/stderr byte caps, child kill, bounded JSON parse | Timeout/oversize tests | Blocker |
| COL-05 | Wrong binary/version silently changes totals | Resolve packaged executable, exact dependency pin, sourceVersion contract, golden fixtures, fail closed | Version mismatch and checksum/build tests | Blocker |
| COL-06 | tokscale and TokenTracker double count same logs | One parser authority setting; mutually exclusive lifecycle and contract kind | E2E tries enabling both | Blocker |
| COL-07 | Token component semantics double-add reasoning/cache | BigInt normalization; input excludes cache; reasoning subset of output; total invariant | Cross-client golden tests | Blocker |
| COL-08 | Starter provider totals, model IDs, or raw source metadata leak through the loopback gateway | Immediate four-provider projection; decision-only starter DTO; strict schemas and unknown-field rejection; no persistence/logging | Gateway response canary and persistence/log scan | Blocker on regression |
| COL-09 | Model-breakdown/projection failure takes down otherwise valid metrics | Provider totals are an independently caught optional branch; unavailable data maps to manual selection | Failure-injection test proves metrics still render and manual choice is offered | Blocker on regression |
| LOC-01 | Malicious webpage reads optional loopback API | Bridge off unless selected; loopback only; unpredictable session token; origin/CORS/CSRF defenses | Browser attack E2E | Blocker if bridge ships |
| LOC-02 | Renderer compromise reaches filesystem/process/secrets | Sandbox, context isolation, no Node integration, narrow validated IPC, CSP, navigation/window denylist | Electron security test/manual review | Blocker |
| LOC-03 | Secret stored as plaintext on Linux | Async safeStorage check; disable persistence on `basic_text`; never use localStorage/SQLite | Linux backend test | Blocker |
| BYO-01 | Key exfiltrated through proxy/custom URL | Main-process direct HTTPS to fixed OpenAI origin; no custom base URL; renderer never gets reusable key | Mock origin/redirect/IPC tests | Blocker |
| BYO-02 | Prompt/response retained or logged | `store: false`; in-memory bounded history; body/header redaction; crash bundle allowlist | Mock request plus persistence/log scan | Blocker |
| ING-01 | Replay/retry/rescan doubles public total | Server canonical key/hash, absolute snapshot, monotonic revision, transactional replace | 100x replay and reorder suite | Blocker |
| ING-02 | Same revision carries different data | Server-computed canonical hash; return 409 and security event | Conflict test | Blocker |
| ING-03 | Client spoofs contributor/bucket/hash | Bearer-derived enrollment; strict body excludes all three | Unknown-field contract tests | Blocker |
| ING-04 | Integer overflow or precision loss | Decimal-string wire, per-field MAX_SAFE, BigInt validation, checked D1 binding, text public sums | Boundary/overflow tests | Blocker |
| ING-05 | Oversized/deep/compressed body DoS | 64 KB app cap, 30 buckets, depth/schema bounds, edge/app rate limit, reject unsupported encoding | Fuzz/load suite | Blocker |
| ING-06 | Stolen bearer writes/deletes data | TLS, secret only in OS store/header, server hash, redacted logs, rotation/revoke, rate anomaly | Secret scan and revoke E2E | Blocker |
| ING-07 | Fake/extreme local totals pollute counter | Bounds, rate limits, quarantine, no rewards/rankings, methodology disclosure | Abuse fixtures and operator drill | Required before Beta |
| PUB-01 | Low-cohort breakdown identifies a contributor | Minimum cohort 20, coarse enums/days, suppress/merge small buckets, no per-user API | Threshold tests | Blocker |
| PUB-02 | Share slug enumeration/profile persistence | 128-bit+ random slug, no listing, expiry/delete, minimal optional fields | Enumeration/rate/delete tests | Required before shares |
| PUB-03 | XSS/log injection through model/tool/error | Closed normalized enums, output encoding, structured reason codes, CSP | XSS property tests | Blocker |
| PRI-01 | Usage uploads before/after consent | Off by default; versioned preview/receipt; queue cleared on disable; cloud-off network test | Packet-capture E2E | Blocker |
| PRI-02 | User expects old anonymous totals to be individually deletable | 30-day attributable window, irreversible coarse compaction, explicit pre-consent wording | Retention/delete UX test | Blocker |
| OPS-01 | D1/cache loss makes counter unrecoverable | Anonymous rollups + current canonical rows; daily logical exports; rebuild/restore drill | Scheduled restore drill | Blocker for GA |
| OPS-02 | Logs/backups retain secrets or forbidden bodies | Body/header logging disabled, structured redaction, access control, retention policy | Canary scan and access review | Blocker |
| SUP-01 | npm/GitHub Action/update supply-chain compromise | Exact pins/lockfile, action commit SHAs, audit/SBOM, reviewed update PR, signed/checksummed desktop artifacts | CI/release attestation | Blocker for GA |
| AST-01 | Unlicensed or provider-branded art ships | Manifest defaults blocked, immutable source hash, owner grant, brand review, build allowlist | Release artifact inventory | Blocker for external Alpha |
| AST-02 | Future asset runtime accepts a substituted origin/object or displays tampered content | Release-embedded approved manifest; one exact AI-Sister HTTPS CDN origin; immutable keys; SHA-256, byte-size, and MIME verification; content-addressed verified cache; code-native fallback | Redirect/origin, hash/size/MIME, cache-corruption, and offline-fallback tests | Not implemented; blocker before enablement |
| AST-03 | Future asset GET leaks usage or is described as anonymous even though the CDN sees object/IP | Fixed public object key with no query parameters; never attach token/provider totals, starter rationale, user/install ID, or local path; explicit disclosure and bounded CDN logging review | Packet capture plus CDN configuration/privacy review | Not implemented; blocker before enablement |

## 5. Collector process policy

The tokscale adapter may run only a report command equivalent to:

```text
tokscale --json --group-by client,provider,model
         --since YYYY-MM-DD --until YYYY-MM-DD
         --client <approved-client> --no-spinner --hide-zero
```

Approved clients for the first adapter are Claude Code, Codex CLI, Gemini CLI,
and Grok Build. Dates are a single validated UTC day. The adapter must not
expose command strings, shell selection, arbitrary flags, executable paths, or
environment overrides to renderer/public input.

The process receives an isolated `TOKSCALE_CONFIG_DIR`, cache-only pricing, and
a minimal environment needed for the target OS. It explicitly removes
`TOKSCALE_API_TOKEN`, API URL, extra-directory, headless-directory, autosubmit,
and unrelated credential variables. It never invokes graph, clients, login,
submit, autosubmit, usage, or integration-management commands.

## 6. Electron and BYOK security requirements

- `nodeIntegration: false`, `contextIsolation: true`, renderer sandbox on.
- Preload exports a narrow typed interface; main validates sender, origin,
  schema, size, model allowlist, and rate before every IPC action.
- Deny unexpected navigation, new windows, permission requests, downloads, and
  external protocol handling. Use a restrictive CSP with no remote script.
- Only main process touches SQLite, collector processes, notifications,
  `safeStorage`, and provider HTTPS.
- The key is decrypted only for the direct provider request and is never sent
  back over IPC. Redirects to a different origin are rejected.
- Requests use `store: false`, no background mode, conversation object, hosted
  file search, file upload, or arbitrary tool execution in MVP.
- Renderer and crash reporting treat prompt/response as sensitive transient
  content; detailed memory dumps are off by default.

## 7. Ingestion state machine

For a canonical key `(authenticated enrollment, UTC day, provider,
modelFamily, tool)`:

| Incoming state | Server action |
| --- | --- |
| No current row | Insert absolute values and revision |
| Same revision, same server hash | Success/no-op |
| Same revision, different server hash | `409 Conflict`, no mutation |
| Lower revision | Stale success/no-op |
| Higher revision | Transactionally replace absolute values, including decreases |

`batchId` deduplicates a request retry but never replaces per-key revision.
Public totals are computed from accepted rows/rollups, not a blind
`counter += clientDelta` operation.

## 8. Privacy, deletion, and inference controls

- Before opt-in, render the actual contract-shaped body with representative
  values and a clear “never uploaded” list.
- Cloud accepts UTC days, never local hours/timezones. Event/session counts are
  not accepted because they add behavioral granularity without powering the
  public counter.
- Character traits use local content-blind aggregates. Missing task metadata
  cannot be replaced with guesses such as “debugging” or “researching.”
- Starter selection reduces the local 28-day model breakdown to four transient
  provider totals, then exposes only a coarse decision. Manual selection is an
  in-memory UI-session value and is not uploaded or currently persisted.
- Public breakdowns require 20 eligible current contributors; otherwise merge
  into `other` or suppress.
- Revocation invalidates credentials immediately. Current attributable data
  and shares are deleted and totals rebuilt. Already compacted anonymous
  historical totals are disclosed as non-extractable.
- Token contribution cannot unlock core local features, ranking, power, or
  high-volume rewards.

## 9. Security testing and incident response

Required automated suites:

- contract unknown-field/privacy canaries and boundary arithmetic;
- adapter fixed-command, sanitized-environment, timeout, output-cap,
  schema-drift, sensitive-extra, and four-client golden tests;
- TokenTracker model-breakdown projection tests proving four request-scoped
  totals, decision-only gateway output, and manual fallback without metric
  failure;
- replay/revision/reorder/downward-correction and transactional-failure tests;
- cloud-off egress and OpenAI `store: false` mock capture;
- Electron preload/IPC authorization and loopback browser attack tests;
- XSS/fuzz/request-size/rate-limit/share-enumeration tests;
- deletion across current bucket, share, cache, consent, and credential;
- clean build, audit, SBOM, secret scan, signed artifact inventory, and restore
  drill before GA.
- Before any character-asset egress is enabled: exact-origin/redirect denial,
  embedded-manifest, SHA-256/size/MIME, cache-corruption, no-query packet
  capture, CDN disclosure/logging, and local-fallback tests.

If a forbidden field or secret reaches cloud wire, persistence, logs,
analytics, diagnostics, crash reports, or a share:

1. disable the affected collection/contribution/BYOK path;
2. revoke potentially exposed credentials and preserve a minimal audit trail;
3. identify all sinks, purge where possible, and assess notification duties;
4. add a fixture that reproduces the leak;
5. complete security/privacy review before re-enabling.

## 10. Accepted residual risks

The following are accepted for MVP only when prominently documented:

- local usage can be modified by the device owner; public totals are voluntary
  self-reported aggregates, not audited provider billing;
- two installations can double count the same synchronized source history;
- unsupported consumer web subscriptions cannot be fully measured;
- D1 and CDN availability can delay the public counter, while local functions
  continue;
- approved provider-inspired characters remain unofficial and must carry an
  unaffiliated disclosure after brand review.
- no AI-Sister cloud asset GET occurs in the current implementation. If the
  future approved runtime is enabled, the AI-Sister CDN will observe the
  requested public object and client IP even though no token, user, or local
  path data is attached.

Any change that adds raw events, hours/timezones to cloud, provider proxying,
file/tool execution in BYOK chat, public per-user profiles, voice cloning, or
token-volume rewards requires a new threat-model review and explicit product
approval.
