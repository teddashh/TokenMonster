# @tokenmonster/collector-tokscale

This package is the narrow Tokscale parser-authority adapter for TokenMonster cloud ingestion.

It is migration-only. New collector and companion product work belongs to the
exact-pinned TokenTracker runtime/adapter/gateway path; this workspace must not
receive new product features.

## Audited boundary

- Upstream package: tokscale 4.5.2
- TokenMonster adapter: 0.1.0
- Allowed clients: claude, codex, gemini, grok
- Public output: strict IngestSnapshotV1 UTC daily buckets
- Collection window: current UTC day or previous UTC day only

The public API is `collectTokscaleDailySnapshot(input)`. Its `utcDate` may name
either allowed day, so the API intentionally does not imply current-day-only
collection.

The previous day is allowed for late writes and corrections across midnight. Hourly collection for local mood and rhythm features is planned as a separate safe command and local-only schema. This package does not send hourly data to the cloud contract.

## Fixed command policy

The adapter resolves the installed, platform-specific Tokscale 4.5.2 native binary itself. Callers cannot provide a command, executable, argv, shell, or arbitrary environment.

The only report arguments are:

    --json
    --group-by client,provider,model
    --since YYYY-MM-DD
    --until YYYY-MM-DD
    --client claude|codex|gemini|grok
    --no-spinner
    --hide-zero

Since and until are always the same allowed UTC date. The child process uses shell false, a fixed timeout, bounded stdout/stderr, and a sanitized environment. TOKSCALE_CONFIG_DIR is forced to a caller-provided absolute TokenMonster-private directory. TOKSCALE_PRICING_CACHE_ONLY is forced to 1. Upstream API token, API URL, extra directories, and headless directory variables are not inherited.

The native process is also wrapped in a fixed denied-egress OS sandbox. Linux
uses an absolute `bubblewrap` executable with a new network namespace and a
read-only host mount; macOS uses the system `sandbox-exec` network-deny profile.
Collection fails closed if the audited sandbox executable is unavailable.
Windows remains unsupported until a native isolation adapter and CI smoke test
exist; it must not silently fall back to an unrestricted spawn.

Raw stdout exists only in memory between the bounded runner and strict parser. It is never logged or persisted. Stderr is counted for the byte cap but is never returned or included in an error.

## Projection and privacy

Tokscale JSON is parsed with a schema that tolerates audited upstream extras, then immediately projected into the minimum fields needed for public aggregation. The output never includes workspace, session, path, project, messageCount, performance, warnings, diagnostics, cost, or arbitrary raw model identifiers.

Provider, tool, and model family are normalized to coarse allowlists. Unknown model values become a provider-specific other family, or other. Raw unknown values never cross the public contract.

`TIER_1_CLIENT_TOOL_SCOPE` and `toolScopeForTier1Client()` are the public,
immutable source of truth for the normalized tool owned by each complete daily
client report. Coordinator code uses this scope when a complete report is empty
or a previously present key disappears; it must not maintain a second mapping.

Tokscale input is treated as normalized non-cache input. cacheRead and cacheWrite are separate. For Codex only, reasoning is an informational subset already contained in output, so it is not added to total a second time. A non-Codex Tier-1 row with reasoning greater than zero fails closed until its upstream semantics are separately audited.

Normalization collisions are summed with BigInt in memory. Every public field and computed total must remain at or below Number.MAX_SAFE_INTEGER before conversion back to a decimal string.

## Empty reports and corrections

An empty report produces an explicit no-usage result; it must not silently preserve a previously uploaded value. The caller owns the local mirror of prior public bucket keys. When a previously present key disappears, the caller must issue a higher-revision absolute zero correction for that key.

## Upstream caveats

Tokscale 4.5.2 includes other commands and output surfaces with broader privacy implications. In particular, graph output can contain mcpServers metadata, and reasoning semantics are not uniform across every parser.

This package never invokes:

- graph
- login, logout, or whoami
- submit or autosubmit
- clients
- usage
- headless
- report task-attribution mode

Adding any upstream command requires a new fixed policy, fixture audit, privacy review, and tests. It must not be added as caller-controlled argv.

## Verification

From the repository root:

    npm run test --workspace @tokenmonster/collector-tokscale
    npm run typecheck --workspace @tokenmonster/collector-tokscale
    npm run build --workspace @tokenmonster/collector-tokscale
