# ADR 0005: Use TokenTracker as the permanent collection sidecar

- Status: accepted
- Date: 2026-07-15
- Supersedes: the collector choice and collector-packaging decisions in ADR
  0001, ADR 0002, and ADR 0004

## Context

TokenMonster is a companion-first product. Its differentiating work is the
character system, explainable traits, interaction design, and optional
privacy-preserving contribution flow. Discovering every AI tool, installing
and maintaining hooks, parsing changing log formats, deduplicating records,
and supporting Windows, macOS, and Linux are not differentiating work.

TokenTracker already maintains that collection surface and exposes local
aggregate data through a loopback service. Reimplementing it with Tokscale in
TokenMonster created a second collector authority, duplicated platform work,
and coupled the product to an Electron-only runtime. Keeping a TokenTracker
fork would avoid the rewrite only temporarily: TokenMonster would then own the
merge, release, security, and compatibility burden for upstream code.

TokenTracker does not currently promise a stable downstream SDK or dashboard
plugin API. That makes a narrow, version-specific process/HTTP adapter
necessary; it does not justify copying or forking the collector.

## Decision

TokenMonster remains an independent repository, package, product, brand, and
release stream. TokenTracker is its permanent external collection runtime,
used through one narrow sidecar adapter.

The migration baseline is exact-pinned `tokentracker-cli@0.80.0`. Every future
version is also exact-pinned in the TokenMonster package manifest and lockfile;
`latest`, tags, ranges, and unreviewed runtime downloads are forbidden.

### Product ownership boundary

| TokenTracker owns | TokenMonster owns |
| --- | --- |
| AI-tool discovery and hook installation | One-command launcher and sidecar supervision |
| Log-format parsers, source updates, and deduplication | Version handshake and loopback adapter |
| The authoritative local usage store and aggregate API | Projection into TokenMonster's minimal aggregate contract |
| Windows, macOS, Linux, and WSL collector behavior | Companion UI, characters, animation, traits, and interaction |
| Upstream collector diagnostics | TokenMonster privacy, consent, contribution, and deletion UX |

TokenMonster must not become a second parser authority. It may persist bounded,
normalized aggregate snapshots, derived character state, preferences, and an
opt-in contribution outbox. Those records are TokenMonster product state or a
cache; they are not a replacement collector database and never contain raw
upstream records.

### Runtime topology

```text
npx tokenmonster
  |
  +-- TokenMonster launcher and loopback UI
  |     |
  |     +-- TokenTracker sidecar adapter
  |           |
  |           +-- exact-pinned tokentracker-cli child process
  |                 |
  |                 +-- hooks, parsers, dedupe, authoritative local store
  |
  +-- TokenMonster companion, character engine, and opt-in contribution
```

The TokenMonster launcher resolves the binary from its installed exact npm
dependency and spawns it as a child process without a shell. It does not call a
global installation or run `npx tokentracker-cli@latest`. The launcher owns
readiness, an exact version handshake, health checks, bounded restart policy,
port-conflict diagnostics, graceful shutdown, and cleanup of the instance it
started.

The adapter communicates only with a loopback endpoint bound to `127.0.0.1` or
`::1`. It uses fixed, version-reviewed aggregate endpoints, strict response
size and time limits, and an allowlisted schema projection. Raw responses exist
only in bounded process memory long enough to validate and project them.
Unknown versions, missing privacy controls, incompatible schemas, non-loopback
addresses, redirects, and malformed or oversized responses fail closed.

The upstream service is never exposed as TokenMonster's public API. A browser
talks to the TokenMonster loopback gateway, which enforces its own session,
Host, Origin, and response-schema policy before returning companion data.

### Forbidden coupling

TokenMonster will not:

- fork TokenTracker for its product runtime;
- vendor or copy TokenTracker source, generated bundles, parsers, or dashboard;
- add TokenTracker as a Git submodule or subtree;
- deep-import `tokentracker-cli` internals or files under its `src` tree;
- read TokenTracker queue files, JSONL files, SQLite databases, configuration
  internals, or other raw storage directly;
- depend on an upstream dashboard plugin or sidebar-extension API;
- patch an unsupported upstream version in TokenMonster's release artifact;
- silently fall back to Tokscale or sum results from two collectors.

If a required capability is absent from the loopback aggregate contract,
TokenMonster opens or contributes a general-purpose upstream change and stays
on the last compatible exact version. The missing capability remains
unavailable until an upstream release exposes it. A private fork is not the
fallback.

TokenMonster owns and serves its companion interface. It does not need to live
inside TokenTracker's dashboard, and its release is not blocked on an upstream
UI extension mechanism. A future native shell may wrap the same TokenMonster
loopback UI, but it must remain a thin client and must not take ownership of
collection.

### One-command user experience

The supported end-user entry point is:

```sh
npx tokenmonster
```

That command installs or uses TokenMonster, brings up its exact compatible
TokenTracker sidecar, waits for readiness, starts the companion UI, and opens
the local page. Users do not clone either repository, run `npm ci`, install
TokenTracker separately, start Electron separately, select a collector, or
manually coordinate ports.

Development commands may remain more explicit, but release acceptance includes
a clean-machine smoke of the one-command path. If the sidecar cannot start,
the UI stays responsive and presents an actionable collector diagnostic; it
does not globally disable unrelated companion controls.

### Privacy and security boundary

The TokenTracker child is third-party local software and is treated as an
untrusted data source at the adapter boundary. A TokenMonster-managed child is
started with `TOKENTRACKER_NO_TELEMETRY=1`. TokenMonster never invokes upstream
authentication, account, community, or cloud-sync controls and never enables
or alters a user's upstream account/cloud-sync preference. The child receives
no TokenMonster cloud credential, provider API key, BYOK prompt, conversation,
contribution credential, or unrelated inherited environment secret.

That launch policy controls TokenMonster's behavior; it is not a claim that
third-party code has no independent network behavior. An upstream version
cannot be adopted unless smoke tests show that the no-telemetry setting is
honored and detect no unexpected egress from the managed collection flow.

If a future advanced mode attaches to an explicitly user-managed TokenTracker
instance, TokenMonster can verify its exact version and loopback endpoint but
cannot guarantee or change that instance's account, telemetry, or cloud-sync
configuration. The UI must disclose that ownership boundary. Attach mode is
never the default one-command path and does not weaken the adapter's data
minimization or TokenMonster-cloud consent rules.

The adapter requests only content-blind aggregate data needed by TokenMonster.
It drops unknown fields and must never persist, log, analyze, or send to
TokenMonster cloud prompts, responses, source-code content, filenames, project
paths, raw events, credentials, upstream device identifiers, or upstream
account state.

TokenMonster cloud behavior is unchanged: anonymous contribution is off by
default and only a user-reviewed, closed UTC daily aggregate may leave the
device after explicit consent. Local collection, companion display, character
logic, and scripted interaction do not require TokenMonster cloud.

### Upstream update policy

A dependency-update bot proposes TokenTracker upgrades as reviewable pull
requests. Each upgrade changes the exact manifest pin, lockfile integrity,
third-party notice when needed, adapter fixtures, and recorded source version
together. These pull requests never auto-merge merely because a new version
exists.

The old pin remains the release version until the candidate passes at least:

1. package/bin resolution and exact version-handshake tests;
2. spawn, readiness, health, shutdown, restart, and port-conflict tests;
3. strict aggregate endpoint and schema fixtures;
4. semantic fixtures for totals, deduplication, dates, tools, and model mapping;
5. malformed, oversized, redirected, and unknown-field response tests;
6. privacy tests proving the managed child receives the no-telemetry launch
   policy, TokenMonster does not invoke upstream account/cloud controls, and
   sensitive fields do not cross the adapter;
7. loopback binding plus Host/Origin/session enforcement tests; and
8. clean-machine `npx tokenmonster` smoke tests on supported Windows, macOS,
   and Linux runners.

An upstream source addition becomes a TokenMonster-supported source only after
its aggregate behavior passes TokenMonster fixtures. Upstream marketing or a
successful install alone does not expand TokenMonster's support claim.

### Migration and removal plan

The current Tokscale/Electron vertical slice is migration input, not a second
permanent runtime.

1. Add `packages/token-tracker-runtime`, `packages/token-tracker-adapter`, and a
   TokenMonster CLI/loopback gateway behind an internal migration flag.
2. Make the runtime supervise exact-pinned `tokentracker-cli`; keep HTTP
   validation/projection in the adapter and expose only reviewed aggregate
   endpoints through TokenMonster domain contracts.
3. Pass the cross-platform contract, privacy, lifecycle, and one-command gates.
4. Cut over at a closed UTC-day boundary. New records use the existing
   `tokentracker-bridge` provenance. Historical `tokscale` records remain
   identifiable and are never added to overlapping TokenTracker records.
5. Make the sidecar the sole collection authority. There is no runtime source
   selector and no automatic fallback collector.
6. Remove `packages/collector-tokscale`, its native binaries, sandbox wrappers,
   custom scan scheduling, packaging manifests, Electron collection ownership,
   and obsolete duplicate-usage persistence. Retain only TokenMonster-owned
   derived state, local preferences, and opt-in outbox data.
7. Remove the TokenMonster collector fork from documentation and release
   inputs. It may be archived as historical work but is never a dependency.
8. Rework the Electron package as optional or retire it. The supported product
   path remains the CLI-supervised sidecar and loopback companion UI.

No new feature work is added to the Tokscale path during migration. It may
receive only changes required to keep the existing source slice testable until
the cutover gate passes.

## Consequences

- TokenMonster keeps its own repository, product identity, UX, and release
  cadence without owning a fork.
- New parser and tool support arrives through reviewed TokenTracker dependency
  updates instead of copied code or a second implementation.
- The unstable upstream local API is contained behind one exact-version
  adapter and contract suite.
- Users receive the familiar one-command, localhost experience without cloning
  repositories or installing a separate desktop stack.
- TokenMonster cannot locally hot-fix upstream parser gaps. It must contribute
  upstream or stay pinned, which is an intentional ownership boundary.
- Upstream process behavior and API drift remain supply-chain and privacy risks;
  exact pins, local-only launch policy, fixtures, and cross-platform smoke are
  release gates rather than optional hardening.

## Rejected alternatives

- **Maintain a TokenTracker fork:** makes upstream merge and release work a
  permanent TokenMonster responsibility.
- **Vendor, subtree, or submodule TokenTracker:** preserves source coupling and
  complicates installation without providing a stable contract.
- **Keep Tokscale as a fallback:** creates two authorities, doubles platform
  work, and makes totals ambiguous.
- **Read upstream queue/database files:** couples TokenMonster to private raw
  formats and expands its privacy surface.
- **Deep-import upstream modules:** bypasses the only observable process/API
  boundary and breaks on internal refactors.
- **Build inside the upstream dashboard:** makes TokenMonster delivery depend
  on an extension API and upstream UI release policy.
- **Rewrite the collectors:** duplicates the part of the system that changes
  fastest and contributes least to TokenMonster's companion differentiation.
