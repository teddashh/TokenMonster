import type {
  Clock,
  ContributionPolicy,
  CredentialScope,
  CredentialService,
  IssuedCredential,
  OpaqueIdGenerator,
  OpaqueIdKind,
  PresentedCredential,
  RateLimitPort,
  StoredCredential,
  SuppressionLedgerEntry,
  SuppressionLedgerPort
} from "@tokenmonster/api-domain";
import {
  ApiDomainError,
  completeContributorDeletion,
  enrollContributor,
  enrollContributorRecoverably,
  getContributorDeletionStatus,
  ingestSnapshot,
  pauseContribution,
  requestContributorDeletion,
  resumeContribution
} from "@tokenmonster/api-domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  createD1DeletionMaintenanceProcessor,
  createD1MutationStorage,
  D1MutationAdapterError,
  type D1MutationStorage
} from "../src/index.js";
import { SqliteD1Database } from "./sqlite-d1.js";

const NOW = "2026-07-15T18:30:00.000Z";
const RESTORED_GUARD_EXPIRES_AT = "2026-08-14T18:30:00.000Z";
const RATE_KEY = "rate_key_AAAAAAAA";
const DELETE_KEY = "delete_request_AAAAAAAA";

function base64Url(byte: number): string {
  const bytes = new Uint8Array(32).fill(byte);
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

class FixedClock implements Clock {
  now(): Date {
    return new Date(NOW);
  }
}

class DeterministicIds implements OpaqueIdGenerator {
  #index = 0;

  generate(kind: OpaqueIdKind): string {
    this.#index += 1;
    const body = String(this.#index).padStart(22, "A");
    if (kind === "installation") return `ins_${body}`;
    if (kind === "consent-event") return `cr_${body}`;
    return `del_${body}`;
  }
}

class DeterministicCredentials implements CredentialService {
  readonly #byBearer = new Map<string, StoredCredential>();
  readonly #statusByJob = new Map<string, IssuedCredential>();
  #index = 0;

  async issue(scope: "upload" | "deletion"): Promise<IssuedCredential> {
    this.#index += 1;
    return this.#make(scope, `publictoken${String(this.#index).padStart(6, "0")}`, this.#index);
  }

  async acceptPresentedV2(
    scope: "upload" | "deletion" | "enrollment-recovery",
    bearerToken: string
  ): Promise<StoredCredential> {
    const letter = scope === "upload" ? "u" : scope === "deletion" ? "d" : "r";
    const match = new RegExp(
      `^tm_${letter}2_([A-Za-z0-9_-]{24})\\.([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$`,
      "u"
    ).exec(bearerToken);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error("invalid V2 credential");
    }
    const seed = [...`${scope}:${match[2]}`].reduce(
      (total, character) => (total + character.charCodeAt(0)) % 251,
      1
    );
    const stored: StoredCredential = Object.freeze({
      scope,
      publicTokenId: match[1],
      hmacDigest: base64Url(seed),
      hmacKeyId: "pepper-v2"
    });
    this.#byBearer.set(bearerToken, stored);
    return stored;
  }

  async issueDeletionStatus(jobId: string): Promise<IssuedCredential> {
    const existing = this.#statusByJob.get(jobId);
    if (existing !== undefined) return existing;
    const issued = this.#make(
      "deletion-status",
      `statusid${jobId.slice(-14)}`,
      90
    );
    this.#statusByJob.set(jobId, issued);
    return issued;
  }

  async inspect(bearerToken: string): Promise<PresentedCredential | null> {
    const match = /^tm_(?:[uds]1|[udr]2)_([A-Za-z0-9_-]{16,32})\./u.exec(
      bearerToken
    );
    return match?.[1] === undefined
      ? null
      : Object.freeze({ publicTokenId: match[1] });
  }

  async verify(
    bearerToken: string,
    expected: StoredCredential
  ): Promise<boolean> {
    const actual = this.#byBearer.get(bearerToken);
    return (
      actual !== undefined &&
      actual.scope === expected.scope &&
      actual.publicTokenId === expected.publicTokenId &&
      actual.hmacDigest === expected.hmacDigest &&
      actual.hmacKeyId === expected.hmacKeyId
    );
  }

  async deriveSuppressionMarker(): Promise<string> {
    return base64Url(120);
  }

  #make(
    scope: CredentialScope,
    publicTokenId: string,
    seed: number
  ): IssuedCredential {
    const prefix =
      scope === "upload" ? "u" : scope === "deletion" ? "d" : "s";
    const bearerToken = `tm_${prefix}1_${publicTokenId}.${base64Url(seed + 30)}`;
    const stored: StoredCredential = Object.freeze({
      scope,
      publicTokenId,
      hmacDigest: base64Url(seed),
      hmacKeyId: scope === "deletion-status" ? "status-v1" : "pepper-v1"
    });
    this.#byBearer.set(bearerToken, stored);
    return Object.freeze({ bearerToken, entropyBits: 256 as const, stored });
  }
}

class TestPolicy implements ContributionPolicy {
  readonly currentConsentDocumentRevision = "contribution-2026-07-15";

  isCollectorSupported(collector: {
    readonly kind:
      | "tokscale"
      | "tokentracker-bridge"
      | "tokentracker-sidecar";
    readonly adapterVersion: string;
    readonly sourceVersion: string;
  }): boolean {
    return (
      collector.adapterVersion === "0.1.0" &&
      ((collector.kind === "tokscale" && collector.sourceVersion === "4.5.2") ||
        (collector.kind === "tokentracker-sidecar" &&
          collector.sourceVersion === "0.80.0"))
    );
  }
}

class AllowRateLimit implements RateLimitPort {
  async consume(): Promise<Readonly<{ allowed: true }>> {
    return Object.freeze({ allowed: true as const });
  }
}

class MemorySuppressionLedger implements SuppressionLedgerPort {
  readonly entries: SuppressionLedgerEntry[] = [];

  async record(entry: SuppressionLedgerEntry): Promise<void> {
    this.entries.push(Object.freeze({ ...entry }));
  }

  async listActive(): Promise<readonly SuppressionLedgerEntry[]> {
    return Object.freeze([...this.entries]);
  }
}

function enrollmentBody(): unknown {
  return {
    contractVersion: 1,
    consent: {
      purpose: "contribution",
      documentRevision: "contribution-2026-07-15",
      granted: true,
      acknowledgedAt: "2026-07-15T18:20:00.000Z"
    }
  };
}

const RECOVERABLE_CREDENTIALS = Object.freeze({
  uploadToken: `tm_u2_${"u".repeat(24)}.${"U".repeat(43)}`,
  deletionToken: `tm_d2_${"d".repeat(24)}.${"D".repeat(42)}E`,
  recoveryToken: `tm_r2_${"r".repeat(24)}.${"R".repeat(42)}I`
});

function recoverableEnrollmentBody(): unknown {
  return {
    contractVersion: 2,
    credentials: RECOVERABLE_CREDENTIALS,
    consent: {
      purpose: "contribution",
      documentRevision: "contribution-2026-07-15",
      granted: true,
      acknowledgedAt: NOW
    }
  };
}

function bucketStart(daysAgo: number): string {
  const start = Date.parse("2026-07-15T00:00:00.000Z");
  return new Date(start - daysAgo * 86_400_000).toISOString();
}

function snapshot(input: {
  readonly batchId?: string;
  readonly revision?: number;
  readonly total?: string;
  readonly bucketCount?: number;
  readonly sidecar?: boolean;
} = {}): unknown {
  const total = input.total ?? "2500";
  const buckets = Array.from({ length: input.bucketCount ?? 1 }, (_, index) => ({
    bucketStart: bucketStart(index),
    provider: "openai",
    modelFamily: "gpt-5",
    tool: "codex-cli",
    valueQuality: "exact",
    revision: input.revision ?? 1,
    tokens: {
      input: total,
      output: "0",
      cacheRead: "0",
      cacheWrite: "0",
      reasoning: "0",
      other: "0",
      total
    }
  }));
  return {
    schemaVersion: input.sidecar === true ? "2" : "1",
    batchId: input.batchId ?? "6b0b8cb1-cd48-47ef-b676-c5a71d02a74b",
    generatedAt: "2026-07-15T18:22:04.000Z",
    collector: {
      kind: input.sidecar === true ? "tokentracker-sidecar" : "tokscale",
      adapterVersion: "0.1.0",
      sourceVersion: input.sidecar === true ? "0.80.0" : "4.5.2"
    },
    buckets
  };
}

type Setup = Readonly<{
  db: SqliteD1Database;
  storage: D1MutationStorage;
  clock: FixedClock;
  credentials: DeterministicCredentials;
  ids: DeterministicIds;
  policy: TestPolicy;
  rateLimit: AllowRateLimit;
  suppressionLedger: MemorySuppressionLedger;
  uploadToken: string;
  deletionToken: string;
}>;

const openDatabases: SqliteD1Database[] = [];

async function setup(
  options: Readonly<{ storageNow?: () => Date }> = {}
): Promise<Setup> {
  const db = new SqliteD1Database();
  openDatabases.push(db);
  let guardIndex = 0;
  const storage = createD1MutationStorage(db, {
    now: options.storageNow ?? (() => new Date(NOW)),
    createRequestId: () => {
      guardIndex += 1;
      return `guard_request_${String(guardIndex).padStart(8, "0")}`;
    }
  });
  const clock = new FixedClock();
  const credentials = new DeterministicCredentials();
  const ids = new DeterministicIds();
  const policy = new TestPolicy();
  const rateLimit = new AllowRateLimit();
  const suppressionLedger = new MemorySuppressionLedger();
  const enrollment = await enrollContributor(
    { body: enrollmentBody(), rateLimitKey: RATE_KEY },
    { clock, credentials, ids, policy, rateLimit, storage }
  );
  return Object.freeze({
    db,
    storage,
    clock,
    credentials,
    ids,
    policy,
    rateLimit,
    suppressionLedger,
    uploadToken: enrollment.credentials.uploadToken,
    deletionToken: enrollment.credentials.deletionToken
  });
}

function ingestDependencies(context: Setup) {
  return {
    clock: context.clock,
    credentials: context.credentials,
    policy: context.policy,
    rateLimit: context.rateLimit,
    storage: context.storage
  };
}

function lifecycleDependencies(context: Setup) {
  return {
    clock: context.clock,
    ids: context.ids,
    credentials: context.credentials,
    policy: context.policy,
    rateLimit: context.rateLimit,
    storage: context.storage
  };
}

function resumeBody(): unknown {
  return {
    contractVersion: 1,
    consent: {
      purpose: "contribution",
      documentRevision: "contribution-2026-07-15",
      granted: true,
      acknowledgedAt: "2026-07-15T18:25:00.000Z"
    }
  };
}

function seedRestoredDeletionGuard(
  context: Setup,
  installationId: string
): void {
  const requestId = "restored-delete-guard-0001";
  context.db.database
    .prepare(
      `INSERT INTO mutation_guards (request_id, operation, expires_at)
       VALUES (?, 'complete-delete', ?)`
    )
    .run(requestId, RESTORED_GUARD_EXPIRES_AT);
  context.db.database
    .prepare(
      `INSERT INTO mutation_guard_deletions (
        request_id, installation_id, idempotency_key, expected_exists,
        expected_job_id, expected_state, expected_status_token_id,
        expected_status_token_hmac, expected_status_hmac_key_id,
        expected_replay_token_id, expected_replay_token_hmac,
        expected_replay_hmac_key_id,
        expected_anonymous_historical_totals_retained,
        expected_requested_at, expected_finished_at, expected_expires_at
      ) SELECT ?, installation_id, idempotency_key, 1, job_id, state,
        status_token_id, status_token_hmac, status_hmac_key_id,
        replay_token_id, replay_token_hmac, replay_hmac_key_id,
        anonymous_historical_totals_retained, requested_at, finished_at,
        expires_at
      FROM deletion_jobs WHERE installation_id = ?`
    )
    .run(requestId, installationId);
}

function ingestCommand(token: string, body: unknown) {
  const batchId = (body as { batchId: string }).batchId;
  return {
    bearerToken: token,
    idempotencyKey: batchId,
    snapshot: body,
    rateLimitKey: RATE_KEY
  };
}

async function expectDomainCode(
  operation: Promise<unknown>,
  code: ApiDomainError["code"]
): Promise<void> {
  try {
    await operation;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ApiDomainError);
    expect((error as ApiDomainError).code).toBe(code);
    return;
  }
  throw new Error("Expected ApiDomainError");
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

describe("production-shaped D1 mutation storage", () => {
  it("atomically enrolls and looks up only scoped HMAC artifacts", async () => {
    const context = await setup();
    expect(
      context.db.database.prepare("SELECT COUNT(*) AS count FROM installations").get()
    ).toEqual({ count: 1 });
    expect(
      context.db.database.prepare("SELECT COUNT(*) AS count FROM consent_receipts").get()
    ).toEqual({ count: 1 });

    const uploadPublicId = /^tm_u1_([^.]*)\./u.exec(context.uploadToken)?.[1];
    const deletionPublicId = /^tm_d1_([^.]*)\./u.exec(context.deletionToken)?.[1];
    expect(uploadPublicId).toBeDefined();
    expect(deletionPublicId).toBeDefined();
    await expect(
      context.storage.findCredentialCandidate("upload", uploadPublicId!)
    ).resolves.toMatchObject({ credential: { scope: "upload" } });
    await expect(
      context.storage.findCredentialCandidate("deletion", deletionPublicId!)
    ).resolves.toMatchObject({ credential: { scope: "deletion" } });

    const boundStrings = context.db.boundValues.flat().filter(
      (value): value is string => typeof value === "string"
    );
    const uploadSecret = context.uploadToken.split(".")[1];
    const deletionSecret = context.deletionToken.split(".")[1];
    expect(boundStrings).not.toContain(context.uploadToken);
    expect(boundStrings).not.toContain(context.deletionToken);
    expect(JSON.stringify(boundStrings)).not.toContain(context.uploadToken);
    expect(JSON.stringify(boundStrings)).not.toContain(context.deletionToken);
    expect(JSON.stringify(boundStrings)).not.toContain(uploadSecret);
    expect(JSON.stringify(boundStrings)).not.toContain(deletionSecret);
    expect(context.db.primarySessionCount).toBeGreaterThan(0);
  });

  it("atomically creates and exactly replays a verifier-only recoverable enrollment", async () => {
    const context = await setup();
    const command = {
      body: recoverableEnrollmentBody(),
      rateLimitKey: RATE_KEY
    };
    const dependencies = {
      clock: context.clock,
      ids: context.ids,
      credentials: context.credentials,
      policy: context.policy,
      rateLimit: context.rateLimit,
      storage: context.storage
    };
    const first = await enrollContributorRecoverably(command, dependencies);
    const replay = await enrollContributorRecoverably(command, dependencies);

    expect(replay).toEqual(first);
    expect(
      context.db.database.prepare(
        "SELECT COUNT(*) AS count FROM recoverable_enrollments"
      ).get()
    ).toEqual({ count: 1 });
    const recovered = await context.storage.findRecoverableEnrollment(
      "r".repeat(24)
    );
    expect(recovered).toMatchObject({
      installation: { status: "active" },
      recoveryCredential: {
        scope: "enrollment-recovery",
        publicTokenId: "r".repeat(24)
      }
    });
    const persisted = JSON.stringify(
      context.db.database.prepare(
        `SELECT recovery_token_id, hex(recovery_token_hmac) AS recovery_hmac,
          recovery_hmac_key_id, installation_id, consent_event_id
         FROM recoverable_enrollments`
      ).all()
    );
    for (const bearer of Object.values(RECOVERABLE_CREDENTIALS)) {
      expect(persisted).not.toContain(bearer);
      expect(persisted).not.toContain(bearer.split(".")[1]);
    }
    const boundStrings = context.db.boundValues
      .flat()
      .filter((value): value is string => typeof value === "string");
    expect(JSON.stringify(boundStrings)).not.toContain("tm_u2_");
    expect(JSON.stringify(boundStrings)).not.toContain("tm_d2_");
    expect(JSON.stringify(boundStrings)).not.toContain("tm_r2_");
  });

  it("makes concurrent exact recoverable enrollment requests converge", async () => {
    const context = await setup();
    const command = {
      body: recoverableEnrollmentBody(),
      rateLimitKey: RATE_KEY
    };
    const dependencies = {
      clock: context.clock,
      ids: context.ids,
      credentials: context.credentials,
      policy: context.policy,
      rateLimit: context.rateLimit,
      storage: context.storage
    };
    const [first, second] = await Promise.all([
      enrollContributorRecoverably(command, dependencies),
      enrollContributorRecoverably(command, dependencies)
    ]);
    expect(second).toEqual(first);
    expect(
      context.db.database.prepare(
        "SELECT COUNT(*) AS count FROM recoverable_enrollments"
      ).get()
    ).toEqual({ count: 1 });
  });

  it("cascades the enrollment-recovery verifier during contributor deletion", async () => {
    const context = await setup();
    await enrollContributorRecoverably(
      { body: recoverableEnrollmentBody(), rateLimitKey: RATE_KEY },
      {
        clock: context.clock,
        ids: context.ids,
        credentials: context.credentials,
        policy: context.policy,
        rateLimit: context.rateLimit,
        storage: context.storage
      }
    );
    const accepted = await requestContributorDeletion(
      {
        bearerToken: RECOVERABLE_CREDENTIALS.deletionToken,
        idempotencyKey: "recoverable_delete_0001",
        rateLimitKey: RATE_KEY
      },
      {
        clock: context.clock,
        ids: context.ids,
        credentials: context.credentials,
        rateLimit: context.rateLimit,
        storage: context.storage,
        suppressionLedger: context.suppressionLedger
      }
    );
    await completeContributorDeletion(
      { jobId: accepted.jobId },
      { clock: context.clock, storage: context.storage }
    );
    expect(
      context.db.database.prepare(
        "SELECT COUNT(*) AS count FROM recoverable_enrollments"
      ).get()
    ).toEqual({ count: 0 });
  });

  it("rolls enrollment back when a later consent insert collides", async () => {
    const context = await setup();
    const upload = await context.credentials.issue("upload");
    const deletion = await context.credentials.issue("deletion");
    const existingEventId = (
      context.db.database.prepare(
        "SELECT event_id AS eventId FROM consent_receipts LIMIT 1"
      ).get() as { eventId: string }
    ).eventId;
    const installationId = `ins_${"Z".repeat(22)}`;
    await expect(
      context.storage.createEnrollmentAtomically({
        installation: Object.freeze({
          installationId,
          status: "active" as const,
          consentDocumentRevision: "contribution-2026-07-15",
          uploadCredential: upload.stored,
          deletionCredential: deletion.stored,
          createdAt: NOW,
          pausedAt: null,
          deletingAt: null,
          deletedAt: null
        }),
        consentReceipt: Object.freeze({
          eventId: existingEventId,
          installationId,
          purpose: "contribution" as const,
          documentRevision: "contribution-2026-07-15",
          granted: true as const,
          acknowledgedAt: NOW,
          recordedAt: NOW
        })
      })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(
      context.db.database.prepare(
        "SELECT COUNT(*) AS count FROM installations WHERE installation_id = ?"
      ).get(installationId)
    ).toEqual({ count: 0 });
  });

  it("atomically pauses, blocks ingest, resumes with consent, and replays both controls", async () => {
    const context = await setup();
    const dependencies = lifecycleDependencies(context);
    const pauseCommand = {
      bearerToken: context.uploadToken,
      rateLimitKey: RATE_KEY
    };
    const firstPause = await pauseContribution(pauseCommand, dependencies);
    const replayedPause = await pauseContribution(pauseCommand, dependencies);
    expect(replayedPause).toEqual(firstPause);
    expect(
      context.db.database.prepare(
        "SELECT status, paused_at AS pausedAt FROM installations"
      ).get()
    ).toEqual({ status: "paused", pausedAt: NOW });
    await expectDomainCode(
      ingestSnapshot(
        ingestCommand(context.uploadToken, snapshot()),
        ingestDependencies(context)
      ),
      "INSTALLATION_PAUSED"
    );

    const resumeCommand = {
      bearerToken: context.uploadToken,
      body: resumeBody(),
      rateLimitKey: RATE_KEY
    };
    const firstResume = await resumeContribution(resumeCommand, dependencies);
    const replayedResume = await resumeContribution(resumeCommand, dependencies);
    expect(replayedResume).toEqual(firstResume);
    expect(
      context.db.database.prepare(
        "SELECT status, paused_at AS pausedAt FROM installations"
      ).get()
    ).toEqual({ status: "active", pausedAt: null });
    expect(
      context.db.database.prepare(
        "SELECT COUNT(*) AS count FROM consent_receipts"
      ).get()
    ).toEqual({ count: 2 });
    expect(
      context.db.database.prepare(
        "SELECT COUNT(*) AS count FROM mutation_guards"
      ).get()
    ).toEqual({ count: 0 });
  });

  it("accepts domain lifecycle timestamps independent of the storage guard clock", async () => {
    const context = await setup({
      storageNow: () => new Date("2026-07-15T18:30:00.137Z")
    });
    const dependencies = lifecycleDependencies(context);

    const paused = await pauseContribution(
      { bearerToken: context.uploadToken, rateLimitKey: RATE_KEY },
      dependencies
    );
    expect(paused.pausedAt).toBe(NOW);

    const resumed = await resumeContribution(
      {
        bearerToken: context.uploadToken,
        body: resumeBody(),
        rateLimitKey: RATE_KEY
      },
      dependencies
    );
    expect(resumed.resumedAt).toBe(NOW);
    expect(
      context.db.database.prepare(
        "SELECT status, paused_at AS pausedAt FROM installations"
      ).get()
    ).toEqual({ status: "active", pausedAt: null });
    expect(
      context.db.database.prepare(
        `SELECT recorded_at AS recordedAt
         FROM consent_receipts
         ORDER BY recorded_at DESC, event_id DESC
         LIMIT 1`
      ).get()
    ).toEqual({ recordedAt: NOW });
  });

  it("rolls back resume status when the immutable consent insert fails", async () => {
    const context = await setup();
    const dependencies = lifecycleDependencies(context);
    await pauseContribution(
      { bearerToken: context.uploadToken, rateLimitKey: RATE_KEY },
      dependencies
    );
    context.db.database.prepare(`INSERT INTO consent_receipts (
      event_id, installation_id, purpose, document_revision, granted,
      occurred_at, recorded_at, expires_at
    ) SELECT ?, installation_id, 'contribution', ?, 1, ?, ?, ?
      FROM installations`).run(
      `cr_${String(3).padStart(22, "A")}`,
      "contribution-2026-07-15",
      "2026-07-15T18:24:00.000Z",
      NOW,
      "2099-12-31T23:59:59.999Z"
    );

    await expectDomainCode(
      resumeContribution(
        {
          bearerToken: context.uploadToken,
          body: resumeBody(),
          rateLimitKey: RATE_KEY
        },
        dependencies
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(
      context.db.database.prepare(
        "SELECT status, paused_at AS pausedAt FROM installations"
      ).get()
    ).toEqual({ status: "paused", pausedAt: NOW });
  });

  it("lets one concurrent pause win and rejects the stale lifecycle preflight", async () => {
    const context = await setup();
    const dependencies = lifecycleDependencies(context);
    const command = {
      bearerToken: context.uploadToken,
      rateLimitKey: RATE_KEY
    };
    context.db.beforeNextBatch = async () => {
      await pauseContribution(command, dependencies);
    };
    await expectDomainCode(
      pauseContribution(command, dependencies),
      "SERVICE_UNAVAILABLE"
    );
    expect(
      context.db.database.prepare(
        "SELECT status, paused_at AS pausedAt FROM installations"
      ).get()
    ).toEqual({ status: "paused", pausedAt: NOW });
  });

  it("accepts 30 rows in one atomic batch and leaves no guard residue", async () => {
    const context = await setup();
    const body = snapshot({ bucketCount: 30 });
    const result = await ingestSnapshot(
      ingestCommand(context.uploadToken, body),
      ingestDependencies(context)
    );
    expect(result.summary.appliedBuckets).toBe(30);
    expect(
      context.db.database.prepare("SELECT COUNT(*) AS count FROM usage_daily_current").get()
    ).toEqual({ count: 30 });
    expect(
      context.db.database.prepare("SELECT COUNT(*) AS count FROM mutation_guards").get()
    ).toEqual({ count: 0 });
  });

  it("durably applies and reads the V2 permanent-sidecar authority", async () => {
    const context = await setup();
    const body = snapshot({ sidecar: true });
    const first = await ingestSnapshot(
      ingestCommand(context.uploadToken, body),
      ingestDependencies(context)
    );
    const replay = await ingestSnapshot(
      ingestCommand(context.uploadToken, body),
      ingestDependencies(context)
    );

    expect(first.summary.appliedBuckets).toBe(1);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(
      context.db.database.prepare(
        `SELECT collector_kind AS kind, adapter_version AS adapterVersion,
          source_version AS sourceVersion
         FROM collector_window_bindings`
      ).get()
    ).toEqual({
      kind: "tokentracker-sidecar",
      adapterVersion: "0.1.0",
      sourceVersion: "0.80.0"
    });
    expect(
      context.db.database.prepare(
        `SELECT collector_kind AS kind, total_tokens AS total
         FROM usage_daily_current`
      ).get()
    ).toEqual({ kind: "tokentracker-sidecar", total: 2500 });
    expect(
      context.db.database.prepare(
        "SELECT COUNT(*) AS count FROM mutation_guards"
      ).get()
    ).toEqual({ count: 0 });
  });

  it("rolls back earlier row writes when a later receipt statement fails", async () => {
    const context = await setup();
    context.db.beforeNextBatch = () => {
      context.db.database.exec(`CREATE TRIGGER forced_receipt_failure
        BEFORE INSERT ON ingest_batches
        BEGIN
          SELECT RAISE(ABORT, 'forced');
        END`);
    };
    await expectDomainCode(
      ingestSnapshot(
        ingestCommand(context.uploadToken, snapshot()),
        ingestDependencies(context)
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(
      context.db.database.prepare("SELECT COUNT(*) AS count FROM usage_daily_current").get()
    ).toEqual({ count: 0 });
    expect(
      context.db.database.prepare("SELECT COUNT(*) AS count FROM collector_window_bindings").get()
    ).toEqual({ count: 0 });
    expect(
      context.db.database.prepare("SELECT COUNT(*) AS count FROM aggregate_dirty").get()
    ).toEqual({ count: 0 });
  });

  it("replays receipts and handles higher, stale, and equal revisions absolutely", async () => {
    const context = await setup();
    const dependencies = ingestDependencies(context);
    const firstBody = snapshot();
    const first = await ingestSnapshot(
      ingestCommand(context.uploadToken, firstBody),
      dependencies
    );
    const replay = await ingestSnapshot(
      ingestCommand(context.uploadToken, firstBody),
      dependencies
    );
    expect(replay).toEqual({ ...first, replayed: true });

    const revisionTwo = snapshot({
      batchId: "7b0b8cb1-cd48-47ef-b676-c5a71d02a74b",
      revision: 2,
      total: "3000"
    });
    const higher = await ingestSnapshot(
      ingestCommand(context.uploadToken, revisionTwo),
      dependencies
    );
    expect(higher.summary.appliedBuckets).toBe(1);

    const staleBody = snapshot({
      batchId: "8b0b8cb1-cd48-47ef-b676-c5a71d02a74b",
      revision: 1
    });
    const stale = await ingestSnapshot(
      ingestCommand(context.uploadToken, staleBody),
      dependencies
    );
    expect(stale.summary.staleBuckets).toBe(1);

    const equalBody = snapshot({
      batchId: "9b0b8cb1-cd48-47ef-b676-c5a71d02a74b",
      revision: 2,
      total: "3000"
    });
    const equal = await ingestSnapshot(
      ingestCommand(context.uploadToken, equalBody),
      dependencies
    );
    expect(equal.summary.idempotentBuckets).toBe(1);
    expect(
      context.db.database.prepare(
        "SELECT revision, total_tokens AS total FROM usage_daily_current"
      ).get()
    ).toEqual({ revision: 2, total: 3000 });

    const conflictBody = snapshot({
      batchId: "ab0b8cb1-cd48-47ef-b676-c5a71d02a74b",
      revision: 2,
      total: "3001"
    });
    await expectDomainCode(
      ingestSnapshot(
        ingestCommand(context.uploadToken, conflictBody),
        dependencies
      ),
      "REVISION_CONFLICT"
    );
    expect(
      context.db.database.prepare(
        "SELECT COUNT(*) AS count FROM ingest_batches WHERE batch_id = ?"
      ).get("ab0b8cb1-cd48-47ef-b676-c5a71d02a74b")
    ).toEqual({ count: 0 });
  });

  it("aborts the whole batch when status changes after preflight", async () => {
    const context = await setup();
    context.db.beforeNextBatch = () => {
      context.db.database.prepare(`UPDATE installations
        SET status = 'paused', paused_at = ?
        WHERE installation_id = (
          SELECT installation_id FROM installations LIMIT 1
        )`).run(NOW);
    };
    await expectDomainCode(
      ingestSnapshot(
        ingestCommand(context.uploadToken, snapshot()),
        ingestDependencies(context)
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(
      context.db.database.prepare("SELECT COUNT(*) AS count FROM ingest_batches").get()
    ).toEqual({ count: 0 });
    expect(
      context.db.database.prepare("SELECT COUNT(*) AS count FROM usage_daily_current").get()
    ).toEqual({ count: 0 });
  });

  it("aborts the whole batch when the upload credential rotates after preflight", async () => {
    const context = await setup();
    context.db.beforeNextBatch = () => {
      context.db.database.prepare(`UPDATE installations SET
        upload_token_id = ?,
        upload_token_hmac = ?,
        upload_hmac_key_id = ?,
        credentials_rotated_at = ?
      WHERE installation_id = (
        SELECT installation_id FROM installations LIMIT 1
      )`).run(
        "rotatedtoken000001",
        new Uint8Array(32).fill(77),
        "pepper-v2",
        NOW
      );
    };
    await expectDomainCode(
      ingestSnapshot(
        ingestCommand(context.uploadToken, snapshot()),
        ingestDependencies(context)
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(
      context.db.database.prepare("SELECT COUNT(*) AS count FROM ingest_batches").get()
    ).toEqual({ count: 0 });
    expect(
      context.db.database.prepare("SELECT COUNT(*) AS count FROM usage_daily_current").get()
    ).toEqual({ count: 0 });
  });

  it("aborts on an authority race without partially applying usage", async () => {
    const context = await setup();
    context.db.beforeNextBatch = () => {
      const installationId = (
        context.db.database.prepare(
          "SELECT installation_id AS id FROM installations LIMIT 1"
        ).get() as { id: string }
      ).id;
      context.db.database.prepare(`INSERT INTO collector_window_bindings (
        installation_id, bucket_start, collector_kind, adapter_version,
        source_version, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        installationId,
        bucketStart(0),
        "tokentracker-bridge",
        "0.1.0",
        "0.79.8",
        NOW,
        "2026-08-14T00:00:00.000Z"
      );
    };
    await expectDomainCode(
      ingestSnapshot(
        ingestCommand(context.uploadToken, snapshot()),
        ingestDependencies(context)
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(
      context.db.database.prepare("SELECT COUNT(*) AS count FROM usage_daily_current").get()
    ).toEqual({ count: 0 });
    expect(
      context.db.database.prepare("SELECT COUNT(*) AS count FROM ingest_batches").get()
    ).toEqual({ count: 0 });
  });

  it("lets one concurrent higher revision win and rejects the stale preflight", async () => {
    const context = await setup();
    const dependencies = ingestDependencies(context);
    await ingestSnapshot(
      ingestCommand(context.uploadToken, snapshot()),
      dependencies
    );
    const revisionTwo = snapshot({
      batchId: "bb0b8cb1-cd48-47ef-b676-c5a71d02a74b",
      revision: 2,
      total: "2000"
    });
    const revisionThree = snapshot({
      batchId: "cb0b8cb1-cd48-47ef-b676-c5a71d02a74b",
      revision: 3,
      total: "3000"
    });
    context.db.beforeNextBatch = async () => {
      await ingestSnapshot(
        ingestCommand(context.uploadToken, revisionThree),
        dependencies
      );
    };
    await expectDomainCode(
      ingestSnapshot(
        ingestCommand(context.uploadToken, revisionTwo),
        dependencies
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(
      context.db.database.prepare(
        "SELECT revision, total_tokens AS total FROM usage_daily_current"
      ).get()
    ).toEqual({ revision: 3, total: 3000 });
    expect(
      context.db.database.prepare(
        "SELECT COUNT(*) AS count FROM ingest_batches WHERE batch_id = ?"
      ).get("bb0b8cb1-cd48-47ef-b676-c5a71d02a74b")
    ).toEqual({ count: 0 });
  });

  it("revokes upload first, replays deletion, then purges hot data and dirties", async () => {
    const context = await setup();
    await ingestSnapshot(
      ingestCommand(context.uploadToken, snapshot()),
      ingestDependencies(context)
    );
    const dependencies = {
      clock: context.clock,
      ids: context.ids,
      credentials: context.credentials,
      rateLimit: context.rateLimit,
      storage: context.storage,
      suppressionLedger: context.suppressionLedger
    };
    const first = await requestContributorDeletion(
      {
        bearerToken: context.deletionToken,
        idempotencyKey: DELETE_KEY,
        rateLimitKey: RATE_KEY
      },
      dependencies
    );
    const replay = await requestContributorDeletion(
      {
        bearerToken: context.deletionToken,
        idempotencyKey: DELETE_KEY,
        rateLimitKey: RATE_KEY
      },
      dependencies
    );
    expect(replay).toEqual(first);
    await expect(context.storage.listQueuedDeletionJobIds(1)).resolves.toEqual([
      first.jobId
    ]);
    const storedStatus = await context.storage.getDeletionJobStatus(first.jobId);
    expect(storedStatus).toMatchObject({
      jobId: first.jobId,
      state: "queued",
      finishedAt: null
    });
    expect(storedStatus).not.toHaveProperty("idempotencyKey");
    expect(storedStatus).not.toHaveProperty("replayCredential");
    await expect(
      context.storage.getDeletionJobStatus(`del_${"Z".repeat(22)}`)
    ).resolves.toBeNull();
    await expect(
      getContributorDeletionStatus(
        { bearerToken: first.statusToken, jobId: first.jobId },
        {
          clock: context.clock,
          credentials: context.credentials,
          storage: context.storage
        }
      )
    ).resolves.toMatchObject({
      jobId: first.jobId,
      status: "queued",
      finishedAt: null
    });
    const statusSecret = first.statusToken.split(".")[1];
    const boundStrings = context.db.boundValues.flat().filter(
      (value): value is string => typeof value === "string"
    );
    expect(boundStrings).not.toContain(first.statusToken);
    expect(JSON.stringify(boundStrings)).not.toContain(statusSecret);
    expect(context.suppressionLedger.entries).toHaveLength(2);
    expect(
      context.db.database.prepare(`SELECT
        status,
        upload_token_id AS uploadId,
        deletion_token_id AS deletionId
      FROM installations`).get()
    ).toEqual({ status: "deleting", uploadId: null, deletionId: null });
    expect(
      context.db.database.prepare("SELECT COUNT(*) AS count FROM deletion_jobs").get()
    ).toEqual({ count: 1 });

    await expectDomainCode(
      ingestSnapshot(
        ingestCommand(
          context.uploadToken,
          snapshot({ batchId: "db0b8cb1-cd48-47ef-b676-c5a71d02a74b" })
        ),
        ingestDependencies(context)
      ),
      "TOKEN_INVALID"
    );

    const completed = await completeContributorDeletion(
      { jobId: first.jobId },
      { clock: context.clock, storage: context.storage }
    );
    expect(completed.state).toBe("complete");
    for (const table of [
      "usage_daily_current",
      "collector_window_bindings",
      "ingest_batches",
      "consent_receipts",
      "share_cards"
    ]) {
      expect(
        context.db.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
      ).toEqual({ count: 0 });
    }
    expect(
      context.db.database.prepare(`SELECT
        status,
        upload_token_id AS uploadId,
        deletion_token_id AS deletionId
      FROM installations`).get()
    ).toEqual({ status: "deleted", uploadId: null, deletionId: null });
    expect(
      context.db.database.prepare(
        "SELECT state, finished_at AS finishedAt FROM deletion_jobs"
      ).get()
    ).toEqual({ state: "complete", finishedAt: NOW });
    expect(
      context.db.database.prepare(
        "SELECT reason, dirty_revision AS revision FROM aggregate_dirty"
      ).get()
    ).toEqual({ reason: "delete", revision: 2 });
    await expect(context.storage.listQueuedDeletionJobIds(100)).resolves.toEqual(
      []
    );
  });

  it.each(["queued", "running"] as const)(
    "removes a restored unexpired %s deletion job in the guarded purge batch",
    async (state) => {
      const context = await setup();
      const accepted = await requestContributorDeletion(
        {
          bearerToken: context.deletionToken,
          idempotencyKey: DELETE_KEY,
          rateLimitKey: RATE_KEY
        },
        {
          clock: context.clock,
          ids: context.ids,
          credentials: context.credentials,
          rateLimit: context.rateLimit,
          storage: context.storage,
          suppressionLedger: context.suppressionLedger
        }
      );
      if (state === "running") {
        context.db.database
          .prepare(
            "UPDATE deletion_jobs SET state = 'running', started_at = ? WHERE job_id = ?"
          )
          .run(NOW, accepted.jobId);
      }
      const installationId = (
        context.db.database
          .prepare(
            "SELECT installation_id AS installationId FROM installations"
          )
          .get() as { installationId: string }
      ).installationId;
      seedRestoredDeletionGuard(context, installationId);

      await expect(
        context.storage.purgeRestoredInstallation(installationId, NOW)
      ).resolves.toBe(true);
      expect(
        context.db.database.prepare("SELECT count(*) AS count FROM deletion_jobs").get()
      ).toEqual({ count: 0 });
      expect(
        context.db.database.prepare("SELECT count(*) AS count FROM mutation_guards").get()
      ).toEqual({ count: 0 });
      expect(
        context.db.database
          .prepare("SELECT count(*) AS count FROM mutation_guard_deletions")
          .get()
      ).toEqual({ count: 0 });
      expect(
        context.db.database.prepare(
          `SELECT status, upload_token_id AS uploadId,
            deletion_token_id AS deletionId FROM installations`
        ).get()
      ).toEqual({ status: "deleted", uploadId: null, deletionId: null });
    }
  );

  it("rolls the restored purge back if deletion-job credential removal fails", async () => {
    const context = await setup();
    await requestContributorDeletion(
      {
        bearerToken: context.deletionToken,
        idempotencyKey: DELETE_KEY,
        rateLimitKey: RATE_KEY
      },
      {
        clock: context.clock,
        ids: context.ids,
        credentials: context.credentials,
        rateLimit: context.rateLimit,
        storage: context.storage,
        suppressionLedger: context.suppressionLedger
      }
    );
    const installationId = (
      context.db.database
        .prepare("SELECT installation_id AS installationId FROM installations")
        .get() as { installationId: string }
    ).installationId;
    seedRestoredDeletionGuard(context, installationId);
    context.db.database.exec(`CREATE TRIGGER fail_restored_job_removal
      BEFORE DELETE ON deletion_jobs
      BEGIN
        SELECT RAISE(ABORT, 'forced restored job removal failure');
      END`);

    await expect(
      context.storage.purgeRestoredInstallation(installationId, NOW)
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(
      context.db.database.prepare("SELECT status FROM installations").get()
    ).toEqual({ status: "deleting" });
    expect(
      context.db.database.prepare(
        "SELECT state, count(*) AS count FROM deletion_jobs"
      ).get()
    ).toEqual({ state: "queued", count: 1 });
    expect(
      context.db.database.prepare("SELECT count(*) AS count FROM consent_receipts").get()
    ).toEqual({ count: 1 });
    expect(
      context.db.database.prepare("SELECT count(*) AS count FROM mutation_guards").get()
    ).toEqual({ count: 1 });
    expect(
      context.db.database
        .prepare("SELECT count(*) AS count FROM mutation_guard_deletions")
        .get()
    ).toEqual({ count: 1 });
  });

  it("enforces the queued deletion page bound before querying D1", async () => {
    const context = await setup();
    const queryCount = context.db.primarySessionCount;

    for (const limit of [0, 101, 1.5]) {
      await expect(
        context.storage.listQueuedDeletionJobIds(limit)
      ).rejects.toMatchObject({
        name: "D1MutationAdapterError",
        code: "INPUT_INVALID"
      });
    }
    expect(context.db.primarySessionCount).toBe(queryCount);
  });

  it("drains a queued job through the bounded maintenance processor", async () => {
    const context = await setup();
    const accepted = await requestContributorDeletion(
      {
        bearerToken: context.deletionToken,
        idempotencyKey: DELETE_KEY,
        rateLimitKey: RATE_KEY
      },
      {
        clock: context.clock,
        ids: context.ids,
        credentials: context.credentials,
        rateLimit: context.rateLimit,
        storage: context.storage,
        suppressionLedger: context.suppressionLedger
      }
    );
    const process = createD1DeletionMaintenanceProcessor(context.storage, {
      maxJobs: 1,
      now: () => new Date(NOW)
    });

    await expect(process()).resolves.toEqual({
      examinedJobs: 1,
      completedJobs: 1
    });
    expect(
      context.db.database.prepare(
        "SELECT status FROM installations"
      ).get()
    ).toEqual({ status: "deleted" });
    expect(
      context.db.database.prepare(
        "SELECT state, finished_at AS finishedAt FROM deletion_jobs WHERE job_id = ?"
      ).get(accepted.jobId)
    ).toEqual({ state: "complete", finishedAt: NOW });
  });

  it("prevents an ingest commit that races deletion", async () => {
    const context = await setup();
    const deletionDependencies = {
      clock: context.clock,
      ids: context.ids,
      credentials: context.credentials,
      rateLimit: context.rateLimit,
      storage: context.storage,
      suppressionLedger: context.suppressionLedger
    };
    context.db.beforeNextBatch = async () => {
      await requestContributorDeletion(
        {
          bearerToken: context.deletionToken,
          idempotencyKey: DELETE_KEY,
          rateLimitKey: RATE_KEY
        },
        deletionDependencies
      );
    };
    await expectDomainCode(
      ingestSnapshot(
        ingestCommand(context.uploadToken, snapshot()),
        ingestDependencies(context)
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(
      context.db.database.prepare("SELECT status FROM installations").get()
    ).toEqual({ status: "deleting" });
    expect(
      context.db.database.prepare("SELECT COUNT(*) AS count FROM usage_daily_current").get()
    ).toEqual({ count: 0 });
    expect(
      context.db.database.prepare("SELECT COUNT(*) AS count FROM ingest_batches").get()
    ).toEqual({ count: 0 });
  });

  it("returns fixed adapter errors without SQL or values", () => {
    const error = new D1MutationAdapterError("STALE_PREFLIGHT");
    expect(error.toJSON()).toEqual({
      name: "D1MutationAdapterError",
      code: "STALE_PREFLIGHT"
    });
    expect(JSON.stringify(error)).not.toContain("SELECT");
    expect(JSON.stringify(error)).not.toContain("token");
  });
});
