import {
  replayDeletionSuppressions,
  type Clock,
  type CredentialService,
  type DeletionStoragePort,
  type SuppressionLedgerEntry,
  type SuppressionLedgerPort
} from "@tokenmonster/api-domain";

import {
  createD1MutationStorage,
  type D1MutationBindValue,
  type D1MutationDatabaseLike,
  type D1MutationSessionLike
} from "./mutation-storage.js";
import {
  createD1PublicProjectionRebuilder,
  D1PublicProjectionError
} from "./public-projection-rebuilder.js";

const DEFAULT_MAX_RESTORED_INSTALLATIONS = 10_000;
const MAX_RESTORED_INSTALLATIONS = 100_000;
const DEFAULT_MAX_ACTIVE_SUPPRESSIONS = 8_192;
const MAX_ACTIVE_SUPPRESSIONS = 8_192;
const MAX_SUPPRESSION_RETENTION_MS = 45 * 24 * 60 * 60 * 1_000;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/u;
const HMAC_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const HMAC_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/u;

const RESTORED_INSTALLATION_COUNT = `SELECT
  count(*) AS restoredInstallationCount
FROM installations`;

const DELETE_RESTORED_MUTATION_GUARDS = "DELETE FROM mutation_guards";

const RESTORED_MUTATION_GUARD_RESIDUE_COUNT = `SELECT
  (
    (SELECT count(*) FROM mutation_guards)
    + (SELECT count(*) FROM mutation_guard_installations)
    + (SELECT count(*) FROM mutation_guard_batches)
    + (SELECT count(*) FROM mutation_guard_authorities)
    + (SELECT count(*) FROM mutation_guard_usage)
    + (SELECT count(*) FROM mutation_guard_deletions)
  ) AS guardResidueCount`;

const DELETED_RESIDUE_COUNTS = `SELECT
  (
    (SELECT count(*)
      FROM usage_daily_current AS usage
      JOIN installations AS installation
        ON installation.installation_id = usage.installation_id
      WHERE installation.status = 'deleted')
    + (SELECT count(*)
      FROM collector_window_bindings AS binding
      JOIN installations AS installation
        ON installation.installation_id = binding.installation_id
      WHERE installation.status = 'deleted')
    + (SELECT count(*)
      FROM ingest_batches AS batch
      JOIN installations AS installation
        ON installation.installation_id = batch.installation_id
      WHERE installation.status = 'deleted')
    + (SELECT count(*)
      FROM quarantine_events AS quarantine
      JOIN installations AS installation
        ON installation.installation_id = quarantine.installation_id
      WHERE installation.status = 'deleted')
    + (SELECT count(*)
      FROM consent_receipts AS consent
      JOIN installations AS installation
        ON installation.installation_id = consent.installation_id
      WHERE installation.status = 'deleted')
    + (SELECT count(*)
      FROM mutation_guard_batches AS guard
      JOIN installations AS installation
        ON installation.installation_id = guard.installation_id
      WHERE installation.status = 'deleted')
    + (SELECT count(*)
      FROM mutation_guard_authorities AS guard
      JOIN installations AS installation
        ON installation.installation_id = guard.installation_id
      WHERE installation.status = 'deleted')
    + (SELECT count(*)
      FROM mutation_guard_usage AS guard
      JOIN installations AS installation
        ON installation.installation_id = guard.installation_id
      WHERE installation.status = 'deleted')
  ) AS attributableResidueCount,
  (
    (SELECT count(*)
      FROM installations
      WHERE status = 'deleted'
        AND (
          upload_token_id IS NOT NULL
          OR upload_token_hmac IS NOT NULL
          OR upload_hmac_key_id IS NOT NULL
          OR deletion_token_id IS NOT NULL
          OR deletion_token_hmac IS NOT NULL
          OR deletion_hmac_key_id IS NOT NULL
        ))
    + (SELECT count(*)
      FROM deletion_jobs AS job
      JOIN installations AS installation
        ON installation.installation_id = job.installation_id
      WHERE installation.status = 'deleted')
    + (SELECT count(*)
      FROM mutation_guard_installations AS guard
      JOIN installations AS installation
        ON installation.installation_id = guard.installation_id
      WHERE installation.status = 'deleted')
    + (SELECT count(*)
      FROM mutation_guard_deletions AS guard
      JOIN installations AS installation
        ON installation.installation_id = guard.installation_id
      WHERE installation.status = 'deleted')
  ) AS credentialResidueCount,
  (SELECT count(*)
    FROM share_cards AS share
    JOIN installations AS installation
      ON installation.installation_id = share.installation_id
    WHERE installation.status = 'deleted') AS shareResidueCount`;

const PURGED_INSTALLATION_RESIDUE_COUNTS = `SELECT
  CASE WHEN status = 'deleted' THEN 0 ELSE 1 END AS lifecycleResidueCount,
  (
    CASE WHEN
      upload_token_id IS NULL
      AND upload_token_hmac IS NULL
      AND upload_hmac_key_id IS NULL
      AND deletion_token_id IS NULL
      AND deletion_token_hmac IS NULL
      AND deletion_hmac_key_id IS NULL
      THEN 0 ELSE 1
    END
    + (SELECT count(*) FROM deletion_jobs WHERE installation_id = ?1)
    + (SELECT count(*) FROM mutation_guard_installations
        WHERE installation_id = ?1)
    + (SELECT count(*) FROM mutation_guard_deletions
        WHERE installation_id = ?1)
  ) AS credentialResidueCount,
  (
    (SELECT count(*) FROM usage_daily_current WHERE installation_id = ?1)
    + (SELECT count(*) FROM collector_window_bindings WHERE installation_id = ?1)
    + (SELECT count(*) FROM ingest_batches WHERE installation_id = ?1)
    + (SELECT count(*) FROM quarantine_events WHERE installation_id = ?1)
    + (SELECT count(*) FROM consent_receipts WHERE installation_id = ?1)
    + (SELECT count(*) FROM mutation_guard_batches
        WHERE installation_id = ?1)
    + (SELECT count(*) FROM mutation_guard_authorities
        WHERE installation_id = ?1)
    + (SELECT count(*) FROM mutation_guard_usage
        WHERE installation_id = ?1)
  ) AS attributableResidueCount,
  (SELECT count(*) FROM share_cards WHERE installation_id = ?1)
    AS shareResidueCount
FROM installations
WHERE installation_id = ?1
LIMIT 1`;

type SuppressionMarkerDeriver = Pick<
  CredentialService,
  "deriveSuppressionMarker"
>;
type ActiveSuppressionLedger = Pick<SuppressionLedgerPort, "listActive">;
type SuppressionReplayStorage = Pick<
  DeletionStoragePort,
  "listRestoredInstallationIds" | "purgeRestoredInstallation"
>;
type UnknownRow = Readonly<Record<string, unknown>>;

export type D1RestoreDrillErrorCode =
  | "INPUT_INVALID"
  | "BOUND_EXCEEDED"
  | "EXPECTATION_MISMATCH"
  | "SUPPRESSION_REPLAY_FAILED"
  | "RESIDUE_DETECTED"
  | "PROJECTION_REJECTED"
  | "SERVICE_UNAVAILABLE";

export class D1RestoreDrillError extends Error {
  override readonly name = "D1RestoreDrillError";

  constructor(readonly code: D1RestoreDrillErrorCode) {
    super(
      code === "INPUT_INVALID"
        ? "The restore drill received invalid input."
        : code === "BOUND_EXCEEDED"
          ? "The restore drill exceeded a configured safety bound."
          : code === "EXPECTATION_MISMATCH"
            ? "The restored fixture did not match the approved count manifest."
            : code === "SUPPRESSION_REPLAY_FAILED"
              ? "Deletion suppression replay did not complete safely."
              : code === "RESIDUE_DETECTED"
                ? "Attributable restored residue remained after suppression replay."
                : code === "PROJECTION_REJECTED"
                  ? "The rebuilt projection did not match the approved checksum."
                  : "The restore drill service is unavailable."
    );
  }

  toJSON(): Readonly<{
    name: "D1RestoreDrillError";
    code: D1RestoreDrillErrorCode;
  }> {
    return Object.freeze({ name: this.name, code: this.code });
  }
}

export interface D1RestoreDrillExpectations {
  readonly activeSuppressionCount: number;
  readonly restoredInstallationCount: number;
  readonly purgedInstallationCount: number;
  readonly projectionChecksum: string;
}

export interface D1RestoreDrillDependencies {
  /** Independent from the restored primary database. */
  readonly suppressionLedger: ActiveSuppressionLedger;
  /** Uses only the non-reversible suppression-marker derivation capability. */
  readonly credentials: SuppressionMarkerDeriver;
}

export interface D1RestoreDrillOptions {
  readonly expectations: D1RestoreDrillExpectations;
  readonly maxRestoredInstallations?: number;
  readonly maxActiveSuppressions?: number;
  /** Dependency injection exists for deterministic isolated drills. */
  readonly now?: () => Date;
  /** Dependency injection exists for deterministic evidence tests. */
  readonly createRevisionId?: () => string;
}

export interface D1RestoreProjectionCounts {
  readonly allTimeTokenCount: string;
  readonly todayUtcTokenCount: string;
  readonly contributorCount: string;
}

export interface D1RestoreDrillEvidence extends D1RestoreProjectionCounts {
  readonly activeSuppressionCount: number;
  readonly restoredInstallationCount: number;
  readonly purgedInstallationCount: number;
  readonly attributableResidueCount: 0;
  readonly credentialResidueCount: 0;
  readonly shareResidueCount: 0;
  readonly projectionChecksum: string;
  readonly evidenceChecksum: string;
}

export type D1RestoreDrillRunner = () => Promise<D1RestoreDrillEvidence>;

function fail(code: D1RestoreDrillErrorCode): never {
  throw new D1RestoreDrillError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validLimit(value: unknown, maximum: number): value is number {
  return validCount(value) && value >= 1 && value <= maximum;
}

function canonicalInstant(value: unknown): string {
  if (typeof value !== "string") fail("SUPPRESSION_REPLAY_FAILED");
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < Date.parse("2020-01-01T00:00:00.000Z") ||
    milliseconds >= Date.parse("2100-01-01T00:00:00.000Z") ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail("SUPPRESSION_REPLAY_FAILED");
  }
  return value;
}

function invocationClock(now: () => Date): Readonly<{
  at: string;
  clock: Clock;
  now: () => Date;
}> {
  let value: Date;
  try {
    value = now();
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
  const milliseconds = value instanceof Date ? value.getTime() : Number.NaN;
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < Date.parse("2020-01-01T00:00:00.000Z") ||
    milliseconds >= Date.parse("2100-01-01T00:00:00.000Z")
  ) {
    return fail("SERVICE_UNAVAILABLE");
  }
  return Object.freeze({
    at: new Date(milliseconds).toISOString(),
    clock: Object.freeze({ now: () => new Date(milliseconds) }),
    now: () => new Date(milliseconds)
  });
}

function expectations(
  input: unknown,
  maxRestoredInstallations: number,
  maxActiveSuppressions: number
): D1RestoreDrillExpectations {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "activeSuppressionCount",
      "restoredInstallationCount",
      "purgedInstallationCount",
      "projectionChecksum"
    ])
  ) {
    fail("INPUT_INVALID");
  }
  const activeSuppressionCount = input["activeSuppressionCount"];
  const restoredInstallationCount = input["restoredInstallationCount"];
  const purgedInstallationCount = input["purgedInstallationCount"];
  const projectionChecksum = input["projectionChecksum"];
  if (
    !validCount(activeSuppressionCount) ||
    activeSuppressionCount > maxActiveSuppressions ||
    !validCount(restoredInstallationCount) ||
    restoredInstallationCount > maxRestoredInstallations ||
    !validCount(purgedInstallationCount) ||
    purgedInstallationCount > activeSuppressionCount ||
    purgedInstallationCount > restoredInstallationCount ||
    typeof projectionChecksum !== "string" ||
    !CHECKSUM_PATTERN.test(projectionChecksum)
  ) {
    fail("INPUT_INVALID");
  }
  return Object.freeze({
    activeSuppressionCount,
    restoredInstallationCount,
    purgedInstallationCount,
    projectionChecksum
  });
}

function suppressionEntries(
  input: unknown,
  at: string,
  maximum: number
): readonly SuppressionLedgerEntry[] {
  if (!Array.isArray(input)) fail("SUPPRESSION_REPLAY_FAILED");
  if (input.length > maximum) fail("BOUND_EXCEEDED");
  const atMilliseconds = Date.parse(at);
  const parsed = input.map((value) => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["suppressionMarker", "recordedAt", "expiresAt"])
    ) {
      return fail("SUPPRESSION_REPLAY_FAILED");
    }
    const marker = value["suppressionMarker"];
    const recordedAt = canonicalInstant(value["recordedAt"]);
    const expiresAt = canonicalInstant(value["expiresAt"]);
    if (
      typeof marker !== "string" ||
      (!HMAC_BASE64URL_PATTERN.test(marker) && !HMAC_HEX_PATTERN.test(marker)) ||
      Date.parse(recordedAt) > atMilliseconds ||
      Date.parse(expiresAt) <= atMilliseconds ||
      Date.parse(expiresAt) <= Date.parse(recordedAt) ||
      Date.parse(expiresAt) - Date.parse(recordedAt) >
        MAX_SUPPRESSION_RETENTION_MS
    ) {
      return fail("SUPPRESSION_REPLAY_FAILED");
    }
    return Object.freeze({
      suppressionMarker: marker,
      recordedAt,
      expiresAt
    });
  });
  if (
    new Set(parsed.map(({ suppressionMarker }) => suppressionMarker)).size !==
    parsed.length
  ) {
    fail("SUPPRESSION_REPLAY_FAILED");
  }
  return Object.freeze(parsed);
}

function primarySession(db: D1MutationDatabaseLike): D1MutationSessionLike {
  try {
    return db.withSession("first-primary");
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
}

async function firstRow(
  session: D1MutationSessionLike,
  query: string,
  values: readonly D1MutationBindValue[] = []
): Promise<UnknownRow> {
  let row: unknown;
  try {
    const statement = session.prepare(query);
    row = await (values.length === 0
      ? statement.first<unknown>()
      : statement.bind(...values).first<unknown>());
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
  if (!isRecord(row)) fail("SERVICE_UNAVAILABLE");
  return row;
}

async function clearRestoredMutationGuards(
  db: D1MutationDatabaseLike
): Promise<void> {
  try {
    // An isolated restore has no legitimate in-flight writer. Clearing every
    // abandoned guard also covers a shadow row whose installation no longer
    // exists in the restored primary snapshot.
    await db.batch([db.prepare(DELETE_RESTORED_MUTATION_GUARDS)]);
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
}

function rowCount(row: UnknownRow, key: string): number {
  const value = row[key];
  if (!validCount(value)) fail("SERVICE_UNAVAILABLE");
  return value;
}

function boundedStorage(
  storage: SuppressionReplayStorage,
  maximum: number,
  scanned: { value: number },
  purgedInstallationIds: string[]
): SuppressionReplayStorage {
  return Object.freeze({
    async *listRestoredInstallationIds(): AsyncIterable<string> {
      for await (const installationId of storage.listRestoredInstallationIds()) {
        scanned.value += 1;
        if (scanned.value > maximum) fail("BOUND_EXCEEDED");
        yield installationId;
      }
    },
    async purgeRestoredInstallation(
      installationId: string,
      at: string
    ): Promise<boolean> {
      const purged = await storage.purgeRestoredInstallation(installationId, at);
      if (purged) purgedInstallationIds.push(installationId);
      return purged;
    }
  });
}

function sameSuppressionSnapshot(
  left: readonly SuppressionLedgerEntry[],
  right: readonly SuppressionLedgerEntry[]
): boolean {
  if (left.length !== right.length) return false;
  const rightByMarker = new Map(
    right.map((entry) => [entry.suppressionMarker, entry] as const)
  );
  return left.every((entry) => {
    const match = rightByMarker.get(entry.suppressionMarker);
    return (
      match?.recordedAt === entry.recordedAt &&
      match.expiresAt === entry.expiresAt
    );
  });
}

function canonicalDecimal(
  value: unknown,
  errorCode: "INPUT_INVALID" | "SERVICE_UNAVAILABLE"
): string {
  if (
    typeof value !== "string" ||
    !DECIMAL_PATTERN.test(value) ||
    (value.length === 19 && value > "9223372036854775807")
  ) {
    fail(errorCode);
  }
  return value;
}

async function sha256(value: string): Promise<string> {
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value)
    );
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function checksumD1RestoreProjection(
  input: D1RestoreProjectionCounts
): Promise<string> {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "allTimeTokenCount",
      "todayUtcTokenCount",
      "contributorCount"
    ])
  ) {
    fail("INPUT_INVALID");
  }
  const allTimeTokenCount = canonicalDecimal(
    input["allTimeTokenCount"],
    "INPUT_INVALID"
  );
  const todayUtcTokenCount = canonicalDecimal(
    input["todayUtcTokenCount"],
    "INPUT_INVALID"
  );
  const contributorCount = canonicalDecimal(
    input["contributorCount"],
    "INPUT_INVALID"
  );
  if (
    BigInt(todayUtcTokenCount) > BigInt(allTimeTokenCount) ||
    BigInt(contributorCount) > BigInt(allTimeTokenCount)
  ) {
    fail("INPUT_INVALID");
  }
  return sha256(
    [
      "tokenmonster-restore-projection-v1",
      allTimeTokenCount,
      todayUtcTokenCount,
      contributorCount
    ].join("\u0000")
  );
}

async function evidenceChecksum(
  evidence: Omit<D1RestoreDrillEvidence, "evidenceChecksum">
): Promise<string> {
  return sha256(
    [
      "tokenmonster-restore-evidence-v1",
      evidence.activeSuppressionCount,
      evidence.restoredInstallationCount,
      evidence.purgedInstallationCount,
      evidence.attributableResidueCount,
      evidence.credentialResidueCount,
      evidence.shareResidueCount,
      evidence.allTimeTokenCount,
      evidence.todayUtcTokenCount,
      evidence.contributorCount,
      evidence.projectionChecksum
    ].join("\u0000")
  );
}

/**
 * Runs only against an already-restored, isolated D1 binding with no public
 * route. Active deletion suppressions are replayed before any projection
 * rebuild. Successful evidence contains counts and checksums only.
 */
export function createD1SuppressionAwareRestoreDrill(
  db: D1MutationDatabaseLike,
  dependencies: D1RestoreDrillDependencies,
  options: D1RestoreDrillOptions
): D1RestoreDrillRunner {
  const maxRestoredInstallations =
    options?.maxRestoredInstallations ?? DEFAULT_MAX_RESTORED_INSTALLATIONS;
  const maxActiveSuppressions =
    options?.maxActiveSuppressions ?? DEFAULT_MAX_ACTIVE_SUPPRESSIONS;
  if (
    db === null ||
    typeof db !== "object" ||
    typeof db.prepare !== "function" ||
    typeof db.batch !== "function" ||
    typeof db.withSession !== "function" ||
    dependencies === null ||
    typeof dependencies !== "object" ||
    dependencies.suppressionLedger === null ||
    typeof dependencies.suppressionLedger !== "object" ||
    typeof dependencies.suppressionLedger.listActive !== "function" ||
    dependencies.credentials === null ||
    typeof dependencies.credentials !== "object" ||
    typeof dependencies.credentials.deriveSuppressionMarker !== "function" ||
    options === null ||
    typeof options !== "object" ||
    !validLimit(maxRestoredInstallations, MAX_RESTORED_INSTALLATIONS) ||
    !validLimit(maxActiveSuppressions, MAX_ACTIVE_SUPPRESSIONS) ||
    (options.now !== undefined && typeof options.now !== "function") ||
    (options.createRevisionId !== undefined &&
      typeof options.createRevisionId !== "function")
  ) {
    fail("INPUT_INVALID");
  }
  const expected = expectations(
    options.expectations,
    maxRestoredInstallations,
    maxActiveSuppressions
  );
  const now = options.now ?? (() => new Date());

  return async () => {
    try {
      const invocation = invocationClock(now);
      let listedSuppressions: unknown;
      try {
        listedSuppressions = await dependencies.suppressionLedger.listActive(
          invocation.at
        );
      } catch {
        return fail("SUPPRESSION_REPLAY_FAILED");
      }
      const activeSuppressions = suppressionEntries(
        listedSuppressions,
        invocation.at,
        maxActiveSuppressions
      );
      if (activeSuppressions.length !== expected.activeSuppressionCount) {
        fail("EXPECTATION_MISMATCH");
      }

      const preflight = await firstRow(
        primarySession(db),
        RESTORED_INSTALLATION_COUNT
      );
      const restoredInstallationCount = rowCount(
        preflight,
        "restoredInstallationCount"
      );
      if (restoredInstallationCount > maxRestoredInstallations) {
        fail("BOUND_EXCEEDED");
      }
      if (
        restoredInstallationCount !== expected.restoredInstallationCount
      ) {
        fail("EXPECTATION_MISMATCH");
      }

      const storage = createD1MutationStorage(db, { now: invocation.now });
      const scanned = { value: 0 };
      const purgedInstallationIds: string[] = [];
      let replay: Awaited<ReturnType<typeof replayDeletionSuppressions>>;
      try {
        replay = await replayDeletionSuppressions({
          clock: invocation.clock,
          credentials: dependencies.credentials,
          storage: boundedStorage(
            storage,
            maxRestoredInstallations,
            scanned,
            purgedInstallationIds
          ),
          suppressionLedger: Object.freeze({
            listActive: async () => activeSuppressions
          })
        });
      } catch {
        return fail("SUPPRESSION_REPLAY_FAILED");
      }
      if (
        scanned.value !== restoredInstallationCount ||
        replay.examinedMarkers !== activeSuppressions.length ||
        replay.purgedInstallations !== expected.purgedInstallationCount ||
        purgedInstallationIds.length !== replay.purgedInstallations ||
        new Set(purgedInstallationIds).size !== purgedInstallationIds.length
      ) {
        fail("EXPECTATION_MISMATCH");
      }

      const postReplayInstallationCount = rowCount(
        await firstRow(primarySession(db), RESTORED_INSTALLATION_COUNT),
        "restoredInstallationCount"
      );
      if (postReplayInstallationCount !== restoredInstallationCount) {
        fail("EXPECTATION_MISMATCH");
      }

      let replayedSuppressions: unknown;
      try {
        replayedSuppressions = await dependencies.suppressionLedger.listActive(
          invocation.at
        );
      } catch {
        return fail("SUPPRESSION_REPLAY_FAILED");
      }
      const postReplaySuppressions = suppressionEntries(
        replayedSuppressions,
        invocation.at,
        maxActiveSuppressions
      );
      if (
        !sameSuppressionSnapshot(activeSuppressions, postReplaySuppressions)
      ) {
        fail("SUPPRESSION_REPLAY_FAILED");
      }

      await clearRestoredMutationGuards(db);
      if (
        rowCount(
          await firstRow(
            primarySession(db),
            RESTORED_MUTATION_GUARD_RESIDUE_COUNT
          ),
          "guardResidueCount"
        ) !== 0
      ) {
        fail("RESIDUE_DETECTED");
      }

      for (const installationId of purgedInstallationIds) {
        const purgedResidue = await firstRow(
          primarySession(db),
          PURGED_INSTALLATION_RESIDUE_COUNTS,
          [installationId]
        );
        if (
          rowCount(purgedResidue, "lifecycleResidueCount") !== 0 ||
          rowCount(purgedResidue, "attributableResidueCount") !== 0 ||
          rowCount(purgedResidue, "credentialResidueCount") !== 0 ||
          rowCount(purgedResidue, "shareResidueCount") !== 0
        ) {
          fail("RESIDUE_DETECTED");
        }
      }

      const residue = await firstRow(
        primarySession(db),
        DELETED_RESIDUE_COUNTS
      );
      const attributableResidueCount = rowCount(
        residue,
        "attributableResidueCount"
      );
      const credentialResidueCount = rowCount(
        residue,
        "credentialResidueCount"
      );
      const shareResidueCount = rowCount(residue, "shareResidueCount");
      if (
        attributableResidueCount !== 0 ||
        credentialResidueCount !== 0 ||
        shareResidueCount !== 0
      ) {
        fail("RESIDUE_DETECTED");
      }

      let projection: Awaited<
        ReturnType<ReturnType<typeof createD1PublicProjectionRebuilder>>
      >;
      try {
        projection = await createD1PublicProjectionRebuilder(db, {
          now: invocation.now,
          ...(options.createRevisionId === undefined
            ? {}
            : { createRevisionId: options.createRevisionId })
        })();
      } catch (error: unknown) {
        return fail(
          error instanceof D1PublicProjectionError
            ? "PROJECTION_REJECTED"
            : "SERVICE_UNAVAILABLE"
        );
      }
      const projectionCounts = Object.freeze({
        allTimeTokenCount: canonicalDecimal(
          projection.allTimeTokens,
          "SERVICE_UNAVAILABLE"
        ),
        todayUtcTokenCount: canonicalDecimal(
          projection.todayUtcTokens,
          "SERVICE_UNAVAILABLE"
        ),
        contributorCount: canonicalDecimal(
          projection.contributors,
          "SERVICE_UNAVAILABLE"
        )
      });
      const projectionChecksum = await checksumD1RestoreProjection(
        projectionCounts
      );
      if (projectionChecksum !== expected.projectionChecksum) {
        fail("PROJECTION_REJECTED");
      }

      const evidenceWithoutChecksum = Object.freeze({
        activeSuppressionCount: activeSuppressions.length,
        restoredInstallationCount,
        purgedInstallationCount: replay.purgedInstallations,
        attributableResidueCount: 0 as const,
        credentialResidueCount: 0 as const,
        shareResidueCount: 0 as const,
        ...projectionCounts,
        projectionChecksum
      });
      return Object.freeze({
        ...evidenceWithoutChecksum,
        evidenceChecksum: await evidenceChecksum(evidenceWithoutChecksum)
      });
    } catch (error: unknown) {
      if (error instanceof D1RestoreDrillError) throw error;
      return fail("SERVICE_UNAVAILABLE");
    }
  };
}
