# Engineering handoff — pending work after v0.1.0-rc.7

Updated: 2026-07-17. Audience: the next implementation agent (codex) and the
integrator session that reviews, commits, and ships its work.

## Shipped baseline

- **v0.1.0-rc.7** is released (tag target `f6ff493` on
  `agent/permanent-sidecar-companion`; supersedes rc.6). Tag run green on the
  full 3-OS matrix with all 7 assets, including the first real-Windows pass of
  the Squirrel `.nupkg` sidecar byte-verification step.
- rc.7 contains: the W8 UX wave (floating pet shell defaults to bottom-right
  pinned, idle animation, character-hero layout with usage stats collapsed
  below, locked roster hidden behind a count, unlock-toast coalescing), W8-F
  on-device quota estimation v1, and the W7 packaging hardening (lockfile-
  anchored sidecar verification, Squirrel `Update.exe` env allowlist).
- PR #1 stays open and must **not** be merged. The repository stays private.
- Branch flow: work lands on `fable/integration` locally and is pushed with
  `git push origin fable/integration:agent/permanent-sidecar-companion`.
  Never force-push, never rewrite history, never `git add -A`.

## Execution constraints every task inherits

- The codex sandbox **cannot**: commit inside git worktrees (parent
  `.git/worktrees/<name>` is read-only), bind loopback ports (`listen EPERM`
  — gateway integration tests skip), or download Electron (no real forge
  make). Leave changes uncommitted in the worktree; the integrator reviews
  the diff, commits, runs the loopback-dependent tests, and — for any
  packaging/verifier change — runs a real `npm run make:companion:internal`
  plus `npm run verify:companion-package` locally before push.
- Local gate parity before any push:
  `npm run typecheck && npm run lint && npm run format:check && npm test`,
  each as a bare command (piping through `grep` masks exit codes).
  `typecheck` is the **only** gate that type-checks test files — vitest
  strips types and package builds compile `src/` only.
- CI: pull-request runs default to skipping macOS (10× billing); the full
  matrix runs on tags, `main`, or a `workflow_dispatch` with
  `platforms=all`. Treat the first CI run of new code as a real review gate.
- Gateway contract rule (historically codex's blind spot): the router in
  `packages/companion-gateway/src/gateway.ts` (`parseFixedTarget`) is
  fail-closed — it rejects every query string except the two usage APIs and
  exactly `?view=pet` on `/`, and DTO parsers on both sides use exact-key
  validation. Any new URL path, query param, or DTO field must, in the same
  branch: update the router allowlist + rejection tests, update the gateway
  serializer and the UI parser in `packages/companion-ui/src/public/dto.ts`,
  and extend the key-order test in `packages/companion-gateway/test/
  gateway.test.ts`. The one-shot bootstrap URL stays query-free; layout
  selectors ride a second navigation (see `apps/companion/src/main/pet/pet.ts`).
- Privacy boundary: everything in `AGENTS.md` applies. Additionally: status
  DTOs never expose raw upstream error text, and quota estimation must stay
  entirely on-device and labeled 「估算」 — never fabricate provider-side
  numbers or call provider quota endpoints (none exist).
- Assets/secrets: the tachie asset bank (`~/voice-lab/video-mvp/tachie`) is
  READ-ONLY. R2/SES/OpenAI credentials exist only at `oracle1:~/secrets/
  r2.env` (mode 600); variable names may appear in code, values never leave
  that host. Never commit rasters, audio, or other binaries to this repo.

## P1 — GLM character onboarding (W8-E) — BLOCKED on assets

**Goal:** ship the already-designed GLM (Zhipu) 字母人 as a fifth character.

**Blocker:** the avatar + 九宮格 sprite sheet Ted uploaded cannot be located —
not in the asset bank, not on oracle1, and the Google Drive connector is
unauthorized. Unblock = Ted re-authorizes Drive in claude.ai settings or
states the file location. No engineering work can start before that.

Plan once assets are in hand:

1. *(integrator)* Stage the source art in a new writable directory — never
   write into the read-only bank — and run the pipeline:
   `ASSET_BANK_DIR=<staging> node scripts/asset-pipeline/build-manifest.mjs`
   to produce the webp set + manifest entries.
2. *(integrator)* Publish to R2 from oracle1 (bucket `oracle1-static`, prefix
   `tokenmonster/characters/v1`), same flow as the core four.
3. *(codex)* Add `glm` to `packages/characters/src/approved-manifest.json` /
   `approved-manifest.ts`, `catalog.ts`, `starter-selection.ts`,
   `fixed-lines.ts` (zh-TW lines), and unlock rules in `progression.ts`.
4. **Open design question to settle first:** what usage signals GLM's
   unlocks. The current four characters key off their provider families as
   reported by tokentracker-cli. Confirm whether the sidecar reports a
   GLM/Zhipu family at all; if not, gate GLM behind cross-family milestones
   (total-usage tiers) instead. Do not invent a family the adapter never
   emits — the projection layer is strict and will reject it.
5. *(codex)* Tests: manifest schema fixtures, progression unlock coverage,
   and the characters DTO key-order test if the roster shape changes.

**Acceptance:** GLM appears locked-by-default in the roster count, unlocks
per the chosen rule, wardrobe/voice load lazily from CDN, and all four
existing characters' unlock fixtures still pass unchanged.

## P2 — Quota estimation v2: real rolling windows

**Current v1 (shipped in rc.7):** the estimator only has UTC-day buckets, so
every plan honestly reports `windowKind: "utc-day"`, `windowHours: 24`, and
rolling budgets (Claude 5 h, ChatGPT 5 h, SuperGrok 2 h) are linearly
day-scaled via `dailyEquivalentBudget` in
`packages/companion-gateway/src/quota-estimator.ts`. The UI parser in
`packages/companion-ui/src/public/dto.ts` **pins** `windowHours === 24` /
`windowKind === "utc-day"` — that pin is deliberate and must be relaxed in
lockstep with the server or the panel breaks loudly.

Plan:

1. Investigate whether the pinned `tokentracker-cli`'s fixed loopback routes
   expose sub-day (hourly) aggregates. Hourly data is allowed locally per
   `AGENTS.md` (it must simply never be uploaded). If the sidecar cannot
   serve it, this task is blocked upstream — do **not** approximate rolling
   windows from day buckets and present them as real.
2. If available: add an hourly usage query to
   `packages/token-tracker-adapter` with the same strict projection
   discipline as the daily path (exact-key validation, content-blind DTOs).
3. Gateway: compute the true window (`quotaWindowStart` from
   `plan.window.hours`, sum tokens inside it, remaining = budget − used) and
   report the plan's real `windowKind`/`windowHours`. Keep the utc-day
   fallback for plans/families where hourly data is absent.
4. DTO change ⇒ full contract checklist (router untouched, but gateway
   serializer + `dto.ts` parser + key-order test move together). UI copy:
   「約剩 N%・視窗 5 小時」 etc.; keep the 「估算」/非官方 framing everywhere.
5. Tests: window-boundary fixtures (tokens straddling the window edge),
   fallback path, parser rejection of mixed shapes.

## P3 — Quota panel refresh on usage updates (small)

The panel (`packages/companion-ui/src/public/quota-panel.ts`) fetches on boot
and after a plan change only; a collector rescan updates the usage panels but
leaves the quota estimate stale until reload. Piggyback the existing
usage-refresh trigger in the UI so the same cycle re-fetches
`/api/usage/quota` — reuse the panel's `currentRequest` race guard; no new
gateway surface. Test: a refreshed snapshot with changed totals re-renders
the percentages.

## P4 — Quota catalog drift guard (small)

`QUOTA_PLAN_OPTIONS` in `packages/companion-ui/src/public/dto.ts` mirrors the
server catalog in `packages/companion-gateway/src/quota-catalog.ts`. Drift
already fails loudly (parse error), but only at runtime. Preferred fix: a
cross-package test that imports both and asserts family/plan-id equality —
cheaper than serving the catalog over a new DTO. Serving it via the quota GET
response is the v2 alternative if plans start changing often; that route
requires the full DTO checklist from P2 step 4.

## Waiting on Ted (not engineering tasks)

- GLM avatar + 九宮格 location, or re-authorize the claude.ai Google Drive
  connector (unblocks P1).
- Interactive `agy` login (restores the second review CLI; grok remains
  available for reviews meanwhile).
- Windows retest of **rc.7** (`TokenMonsterSetup.exe`) covering the six W8
  feedback items and the new quota panel.
