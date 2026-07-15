# TokenMonster

English · [繁體中文](README.md)

TokenMonster is a local-first AI usage companion. It organizes token usage on
the user's device, presents content-blind trends, and lets explainable letter
characters react to workflow traits. A user can also preview and explicitly
opt in to contributing strictly limited UTC daily aggregates to a public
counter.

> **Current status: a testable source vertical slice, not a live service.** The
> companion, Web, API, D1, Durable Objects, `k = 20` anonymous daily compactor,
> and safe scheduled-maintenance orchestration are implemented in source. They
> do not yet have production or staging E2E evidence, and no Cloudflare account,
> D1 UUID, domain, routes, or secrets are configured. This repository must not
> be presented as a production service, public Alpha, or signed release.

## Core promises

TokenMonster's privacy boundary is a product requirement, not a setting to add
later.

- TokenMonster cloud never persists, logs, analyzes, or receives prompts,
  responses, source-code content, filenames, project paths, API keys, OAuth
  tokens, or provider credentials. It also never persists or logs raw HTTP
  request bodies.
- Local collection, charts, character derivation, fixed lines, export, and
  reset do not depend on TokenMonster cloud and must continue to work offline.
- Anonymous contribution is off by default. Only after an exact preview and
  explicit consent may the companion send closed UTC daily aggregates that
  conform to the strict schema. Hourly data, event/session counts, and the
  incomplete current day remain local.
- Public copy may only describe "tokens shared by opt-in contributors." The
  counter is neither all global AI usage nor a statistically representative
  sample.
- Character traits are derived from explainable workflow signals, not a power
  ladder. The product does not reward wasteful token use or add pay-to-win
  mechanics.
- BYOK credentials remain in the local secret store. User-initiated chat is
  transient in companion memory and travels directly from the device to the
  selected provider; it never traverses the TokenMonster API or D1.

See the [data inventory](docs/DATA_INVENTORY.md) and
[threat model](docs/THREAT_MODEL.md) for the detailed data lifecycle.

## Implemented surface and release status

| Area | Current source slice | Release status |
| --- | --- | --- |
| Local companion | Electron UI, local SQLite, content-blind 7/28-day trends, traits/fixed lines, share card, export/reset | Implemented and locally tested; native and packaged smoke remains |
| Collector | Exact-pinned `tokscale@4.5.2`, fixed argv, bounded output, strict parser, Linux/macOS denied-egress sandbox | Implemented; Windows collection remains disabled until a no-egress sandbox is audited |
| Characters | Four TokenMonster-owned letter placeholders, explainable traits, zh-TW/English fixed lines, BYOK persona context | Placeholders are usable; AI-Sister raster remains blocked on redistribution rights and brand review |
| BYOK | Companion main process calls OpenAI Responses directly with `store: false`, `background: false`, and no tools/files/conversation IDs | Implemented; a manual real-key network smoke on a safe release host remains |
| Anonymous contribution | Off by default, exact payload preview, accountless enrollment, background sync/idempotent retry, stop, delete/status | Implemented and locally tested; staging and cloud-off packet-capture E2E remain |
| Web/API | zh-TW-first React/Vite SPA, Hono Worker API, public totals, enrollment/ingest/delete/status | Implemented, built, and fail-closed in dry-run; no remote environment is configured |
| Cloud data | Guarded D1 mutations, deletion, projection, retention, Durable Object rate limits/suppression | Implemented and locally tested; real D1 migrations, capacity, and failure rehearsals remain |
| Anonymous compaction | Complete UTC-day `day-all-v1`, `k = 20` gate, mapping-free rollups, commit-time race guards | Implemented and locally tested; no staging/production E2E yet |
| Scheduled maintenance | Deletion → compaction → retention → projection; retention preserves compaction-owned input to prevent partial-day loss | Implemented and locally tested; not yet verified against real Cron Triggers/D1 |
| Installers | Internal unsigned Linux/macOS ASAR/ZIP can be produced and inspected, including the pinned Tokscale MIT notice | Not a public installer; signing, notarization, DMG/updater verification, and native smoke are STOP gates |

## Architecture

```mermaid
flowchart LR
  subgraph Local[User device: default and fully offline-capable]
    Logs[Supported tools' local usage data]
    Tokscale[Tokscale 4.5.2\nfixed command + denied egress]
    Store[(Local SQLite)]
    UI[Companion\ncharts, traits, letter characters]
    Preview[Explicit contribution preview\nbackground sync + manual retry]
    Vault[OS-backed secret store]
    BYOK[Local BYOK client]
    Logs --> Tokscale --> Store
    Store --> UI
    Store --> Preview
    Vault --> BYOK
  end

  Preview -->|closed UTC daily aggregates only| Worker[Cloudflare Worker\nWeb + Hono API]
  Worker --> D1[(D1 current aggregates)]
  Worker --> DO[Durable Objects\nquota + deletion suppression]
  D1 --> Compact[k=20 day-all compactor]
  Compact --> Rollups[(unlinkable anonymous rollups)]
  D1 --> Projection[public projection]
  Rollups --> Projection
  Projection --> Public[public contributor counter]
  BYOK -->|transient prompt; direct request| Provider[selected AI provider]
```

The cloud path accepts only coarse daily aggregates from a versioned contract.
The companion and cloud share strict schemas, but cloud never receives the
local SQLite database, provider key, or conversation content.

## Repository layout

```text
apps/
  companion/        Electron local UI, secure IPC, collection orchestration,
                    BYOK, and contribution flows
  web/              React/Vite public UI and Cloudflare Worker entry
  api/              Portable HTTP and fail-closed Cloudflare compositions
packages/
  contracts/        Versioned strict schemas shared by local and cloud code
  usage-domain/     Content-blind usage normalization and domain rules
  collector-core/   Single-authority scheduling, spool/retry, scan evidence
  collector-tokscale/ Exact-pinned Tokscale adapter and denied-egress runner
  local-store/      Local SQLite, revisions, outbox, reset/export boundaries
  monster-engine/   Deterministic, explainable trait derivation
  characters/       Catalog, fixed lines, placeholders, asset release gate
  secret-vault/     Electron safeStorage boundary
  byok-openai/      Local direct OpenAI Responses adapter
  api-domain/       Framework-free enrollment, ingest, and delete/status domain
  api-cloudflare/   Cloudflare auth, quota, and suppression adapters
  cloud-d1/         D1 schema, guarded mutations, compaction, retention,
                    and projection
docs/               Product/technical specs, runbook, threat model, ADRs,
                    and release checklist
scripts/            Repository, secret, build, and release artifact verifiers
```

The dependency direction is `apps → adapters → domain/contracts`. Domain
packages must not import Electron, Hono, D1, or UI frameworks.

## Prerequisites

- Node.js `24.15.0`
- npm `11.12.1`
- Git
- Linux real-collector denied-egress integration test: `bubblewrap` and
  `strace`
- macOS collector: the system `sandbox-exec`; public distribution additionally
  requires Apple signing/notarization identities and a controlled release host
- Cloudflare remote operations: Wrangler and an owner-approved
  account/environment; local builds and dry-runs do not need production
  credentials

Windows collection is explicitly unsupported today. Never replace isolation
with an unrestricted spawn, and never use `--no-sandbox` to bypass Electron or
collector security controls.

## Install and develop locally

```sh
git clone https://github.com/teddashh/TokenMonster.git tokenmonster
cd tokenmonster
npm ci
```

Start the Web UI's Vite development server:

```sh
npm run dev --workspace @tokenmonster/web
```

Without a `TOKENMONSTER_DB` binding, public totals intentionally return a
sanitized `503`. The UI never substitutes demo or fabricated totals.

Start the companion renderer development server:

```sh
npm run dev --workspace @tokenmonster/companion
```

Build and start the complete Electron companion:

```sh
npm run build --workspace @tokenmonster/companion
npm run start --workspace @tokenmonster/companion
```

If Chromium sandbox/AppArmor requirements are not met on the current Linux
host, launch must fail closed. Move the smoke test to a correctly isolated host
instead of adding `--no-sandbox`.

## Verify, test, and build

Run the complete local pre-commit gate:

```sh
npm run format:check
npm run lint
npm run verify:secrets
npm run typecheck
npm test
npm run build
npm run verify:packaging-toolchain
npm run verify:artifacts
npm audit --audit-level=high
```

Use npm's workspace flag for a focused check, for example:

```sh
npm test --workspace @tokenmonster/cloud-d1
npm run typecheck --workspace @tokenmonster/collector-tokscale
npm run build --workspace @tokenmonster/web
```

### Worker dry-run

This validates the build and bundle without creating or changing remote
resources:

```sh
cd apps/web
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
cd ../..
```

A successful dry-run does not mean staging or production is deployable. The
checked-in Wrangler config intentionally has no D1 UUID, custom domain, routes,
environment secrets, or mutation enable flag. Cloud writes must fail closed
whenever a required binding is missing.

### Internal companion package

```sh
npm run make:companion:internal
npm run verify:companion-package
```

This produces and audits an unsigned internal ASAR/ZIP only. Generated output
and evidence are not committed. It is not a signed/notarized installer and does
not constitute an Alpha release.

## Anonymous contribution flow

1. The user first sees an exact local payload preview. There is no enrollment
   or upload without explicit consent.
2. Only closed UTC dates with complete-scan evidence for all four collector
   scopes and complete day coverage can enter a candidate payload. Today,
   partial days, hourly data, raw events, and conversation content are
   ineligible.
3. Enrollment and upload accept only reviewed HTTPS origins, and all
   contribution credential slots require OS-backed safe storage. An insecure
   Linux `basic_text` backend cannot opt in.
4. After explicit opt-in, a main-process one-shot timer schedules background
   sync after startup, wake, and a completed local scan. It makes no request
   when no payload is due. Retries reuse the exact body and `batchId`; manual
   retry remains available, and absolute revisions let a missing key become a
   higher-revision zero correction.
5. Stop removes upload authority and the local outbox while retaining separate
   deletion authority. Delete and status use distinct credential lifecycles.
6. Cloud compacts only a complete expired day into `day-all-v1`. At least 20
   eligible contributors are required before a mapping-free coarse rollup is
   written. Below-threshold expired attributable rows are deleted as a whole
   day and never exposed as a small cohort.

Important limitation: the scheduler currently has local fake-timer and service
tests only. Staging packet capture, retry/out-of-order E2E, and real-D1
compaction/retention race rehearsals remain pending.

The companion cloud origin is supplied through `TOKENMONSTER_API_BASE_URL` and
must exactly match a compiled HTTPS allowlist. Never place production secrets
in `.env`, the repository, logs, screenshots, or release evidence.

## BYOK boundary

The current optional BYOK path calls the OpenAI Responses API directly from the
Electron main process:

- The API key prefers OS-backed Electron `safeStorage`; an insecure or
  unavailable backend permits a RAM-only session and does not write the key to
  disk.
- Prompts/responses stay in bounded memory and are cleared on character change,
  key removal, window close, and process shutdown.
- Requests explicitly use `store: false` and `background: false`, with files,
  tools, hosted search, conversation IDs, and redirects disabled.
- The TokenMonster Worker, D1, analytics, and public API never receive provider
  credentials or BYOK conversation content.

BYOK still sends content directly to the provider selected by the user and is
subject to that provider's terms and data policies. TokenMonster must not
describe this direct path as "content never leaves the device."

## Cloud configuration and deployment

Follow the [deployment runbook](docs/DEPLOYMENT_RUNBOOK.md) for every remote
deployment. Critical bindings/settings include `TOKENMONSTER_DB`, separate
Durable Object namespaces, `TOKENMONSTER_MUTATIONS_ENABLED`, credential/rate-key
secret configuration, and the exact allowed public origin. Actual names, UUIDs,
routes, and secret values belong to the environment and must not be committed.

Production and staging are both **STOP**. At minimum, the following gates remain:

- owner-approved Cloudflare account, D1 Paid, isolated dev/staging/production
  environments, D1 UUIDs, custom domains, routes, secrets, and reviewed origins;
- real Wrangler D1 migrations plus staging E2E for API/Cron/Durable Objects/
  `k = 20` compaction, load/SLO tests, and failure-injection evidence;
- staging packet-capture, sleep/wake, and long-running retry-soak evidence for
  the companion background contribution scheduler;
- signed/notarized installers, nested-native/DMG/updater verification, and
  native packaged smoke on supported platforms;
- encrypted logical backups, deletion-suppression replay, restore-from-zero,
  and rollback drills;
- privacy/terms/legal review, a project-license decision, and third-party
  redistribution review;
- AI-Sister raster redistribution rights, provenance evidence, and independent
  brand review. Only code-native letter placeholders may be used today.

Until every gate has reproducible evidence, do not create production D1 state,
enable mutations, publish a download link, or call this project live.

## Collector and character sources

The default collector is fixed to `tokscale@4.5.2`. The adapter accepts no
caller-controlled executable, argv, or arbitrary environment, and immediately
projects upstream JSON into a minimized, allowlisted daily aggregate schema.
The `tokentracker-cli@0.79.8` bridge is only a planned, mutually exclusive
compatibility path. It is not an implemented feature and must never be summed
with Tokscale output.

The maintained fork for minimal parser/sandbox patches is
[teddashh/tokenmonster-collector](https://github.com/teddashh/tokenmonster-collector).

AI-Sister/`multi-ai-chat-app` is a design reference and candidate persona
source only. This repository does not contain approved, releasable AI-Sister
raster art. All four provider-inspired characters currently use
TokenMonster-owned, independent-unaffiliated letter placeholders.

## Documentation

- [Product specification](docs/PRODUCT_SPEC.md)
- [Technical specification](docs/TECHNICAL_SPEC.md)
- [Implementation and launch plan](docs/IMPLEMENTATION_PLAN.md)
- [Deployment runbook](docs/DEPLOYMENT_RUNBOOK.md)
- [Private Alpha release checklist](docs/ALPHA_RELEASE_CHECKLIST.md)
- [Data inventory](docs/DATA_INVENTORY.md)
- [Threat model](docs/THREAT_MODEL.md)
- [ADR 0001: repository boundaries](docs/adr/0001-repository-boundaries.md)
- [ADR 0002: runtime and deployment](docs/adr/0002-runtime-and-deployment.md)
- [ADR 0003: D1 atomic mutation adapter](docs/adr/0003-d1-atomic-mutation-adapter.md)
- [ADR 0004: Electron packaging and signing](docs/adr/0004-electron-packaging-and-signing.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Contributing

This is a private, pre-release repository. Any change to a data shape,
collector command, character asset, network destination, credential lifecycle,
or retention behavior must update contracts, privacy regression tests, the data
inventory, threat model, and release checklist together. Never add prompts,
responses, paths, filenames, raw model labels, keys, or real-user fixtures to
tests, logs, analytics, or issue attachments.

## License

The project license is pending, and this repository currently grants no public
use or redistribution permission. Third-party components remain subject to
their respective licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Until legal/rights review and an explicit license file are complete, this
project is for internal development and evaluation only.
