# ADR 0002: Electron companion and a single Cloudflare Worker deployment

- Status: accepted for MVP
- Date: 2026-07-15

## Context

TokenMonster needs privileged local file/process access for collectors, an
offline dashboard and character, OS-backed secret storage, an optional public
contribution service, and a public installation/counter site. A browser-only
application cannot safely scan the supported local AI-tool data. Splitting a
new public site and API into separate deployments would add versioning and
rollback failure modes before traffic requires that separation.

## Decision

### Local companion

- Use Electron with a React/Vite renderer.
- The main process owns collector subprocesses, local SQLite, notifications,
  OS secret storage, updates, and provider HTTPS.
- Use `node:sqlite` behind a repository port for the MVP. Domain packages do
  not import Electron or SQLite types.
- Enable renderer sandbox and context isolation; disable Node integration.
  Preload exposes narrow, schema-validated IPC only.
- Store OpenAI and contribution credentials with Electron async
  `safeStorage`. If Linux reports the `basic_text` backend and no Secret
  Service/KWallet is available, do not persist either credential; persistent
  BYOK and cloud contribution remain unavailable on that installation.
- OpenAI BYOK requests go directly from the main process to the fixed OpenAI
  API origin with `store: false`; TokenMonster cloud never proxies them.

macOS is the first signed/notarized target, followed by Windows. Linux can ship
only after secret storage, packaging, update, and CI gates pass; an unsigned
preview is not GA.

### Public web and API

- Use one Cloudflare Worker deployment unit.
- Serve the React/Vite build through Workers Static Assets and route `/v1/*`
  to a Hono API entry in the same artifact.
- Use D1 Paid for current canonical contribution rows, anonymous historical
  rollups, consent/enrollment state, deletion state, and disposable public
  projections.
- Keep `apps/web` and `apps/api` as source/domain boundaries even though they
  deploy together. Web code has no direct D1 binding.
- Impose application limits of 64 KiB and 30 daily buckets per ingest request.
- Use separate development, staging, and production Workers, domains, D1
  databases, rate-limit state, backup storage, and secrets.
- D1 Time Travel is not the only backup. Create encrypted daily logical
  exports, and regularly test restore plus public-total rebuild.

## Consequences

- Local tracking, charts, character logic, reminders, and scripted dialogue
  remain available when TokenMonster cloud is unavailable.
- Provider and enrollment secrets stay outside renderer/local database and do
  not enter the public Worker.
- Public static assets and API contracts roll forward/back together, reducing
  early deployment skew.
- Domain ports preserve a later path to Tauri/native shells, Postgres, object
  storage, or split frontend/API hosting without changing contracts.
- Electron packaging, sandbox review, code signing, notarization, and secure
  auto-update become mandatory release work.
- D1 single-writer/capacity behavior requires small transactional batches,
  capacity alerts, rollup compaction, and a documented sharding trigger.

## Rejected options

- Browser-only local collector: cannot meet local file/process and durable
  OS-secret requirements without an unsafe privileged bridge.
- A new Cloudflare Pages project plus a separate Worker: adds deployment and
  contract skew; current Cloudflare Static Assets support the single-Worker
  topology.
- Central BYOK proxy: would place provider credentials and conversation content
  inside TokenMonster's trust boundary.
- Reusing TokenTracker's complete native shell/cloud product: imports unrelated
  account, telemetry, dashboard, and release behavior.
- D1 cache-only counter: cannot reconstruct downward corrections, deletion, or
  replay-safe totals.
