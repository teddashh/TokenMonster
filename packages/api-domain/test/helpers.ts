import type {
  AuthorityBindingRecord,
  Clock,
  ConsentReceiptRecord,
  ContributionPolicy,
  CredentialCandidate,
  CredentialScope,
  CredentialService,
  CurrentUsageRowRecord,
  DeletionRequestRecord,
  DeletionStoragePort,
  DeletionStatusStoragePort,
  DeletionStatusRecord,
  DeletionTransactionPort,
  EnrollmentStoragePort,
  IngestBatchReceiptRecord,
  IngestStoragePort,
  IngestTransactionPort,
  InstallationRecord,
  IssuedCredential,
  LifecycleStoragePort,
  LifecycleTransactionPort,
  OpaqueIdGenerator,
  OpaqueIdKind,
  PresentedCredential,
  RateLimitDecision,
  RateLimitPort,
  RateLimitRequest,
  RecoverableEnrollmentRecord,
  RecoverableEnrollmentStoragePort,
  StoredCredential,
  SuppressionLedgerEntry,
  SuppressionLedgerPort
} from "../src/index.js";

const SCOPE_PREFIX: Readonly<Record<CredentialScope, "u" | "d" | "s" | "r">> = {
  upload: "u",
  deletion: "d",
  "deletion-status": "s",
  "enrollment-recovery": "r"
};

function cloneMap<K, V>(source: ReadonlyMap<K, V>): Map<K, V> {
  return new Map(source);
}

export class FixedClock implements Clock {
  constructor(public value = new Date("2026-07-15T18:30:00.000Z")) {}

  now(): Date {
    return new Date(this.value);
  }
}

export class DeterministicIds implements OpaqueIdGenerator {
  private index = 0;

  generate(kind: OpaqueIdKind): string {
    this.index += 1;
    const body = String(this.index).padStart(22, "A");
    if (kind === "installation") return `ins_${body}`;
    if (kind === "consent-event") return `cr_${body}`;
    return `del_${body}`;
  }
}

export class MockCredentialService implements CredentialService {
  private index = 0;
  readonly issuedByToken = new Map<string, StoredCredential>();
  failWith: Error | null = null;
  forceDuplicate = false;
  mismatchStatusOnReplay = false;
  private readonly statusIssueCounts = new Map<string, number>();

  async issue(scope: "upload" | "deletion"): Promise<IssuedCredential> {
    if (this.failWith !== null) throw this.failWith;
    this.index += 1;
    const suffix = this.forceDuplicate ? 1 : this.index;
    const publicTokenId = `public${String(suffix).padStart(16, "A")}`;
    const secret = String.fromCharCode(64 + ((suffix - 1) % 26) + 1).repeat(43);
    const prefix = SCOPE_PREFIX[scope];
    const bearerToken = `tm_${prefix}1_${publicTokenId}.${secret}`;
    const hmacDigest = String.fromCharCode(97 + ((suffix - 1) % 26)).repeat(43);
    const stored: StoredCredential = Object.freeze({
      scope,
      publicTokenId,
      hmacDigest,
      hmacKeyId: "pepper-v1"
    });
    this.issuedByToken.set(bearerToken, stored);
    return Object.freeze({ bearerToken, entropyBits: 256 as const, stored });
  }

  async acceptPresentedV2(
    scope: "upload" | "deletion" | "enrollment-recovery",
    bearerToken: string
  ): Promise<StoredCredential> {
    if (this.failWith !== null) throw this.failWith;
    const prefix = SCOPE_PREFIX[scope];
    const match = new RegExp(
      `^tm_${prefix}2_([A-Za-z0-9_-]{24})\\.([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$`
    ).exec(bearerToken);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error("invalid presented credential");
    }
    const stored: StoredCredential = Object.freeze({
      scope,
      publicTokenId: match[1],
      hmacDigest: `${prefix}${match[2].slice(1)}`,
      hmacKeyId: "pepper-v2"
    });
    this.issuedByToken.set(bearerToken, stored);
    return stored;
  }

  async issueDeletionStatus(jobId: string): Promise<IssuedCredential> {
    if (this.failWith !== null) throw this.failWith;
    const previousCount = this.statusIssueCounts.get(jobId) ?? 0;
    this.statusIssueCounts.set(jobId, previousCount + 1);
    const jobBody = jobId.slice("del_".length);
    const publicTokenId = `status${jobBody.slice(0, 16)}`;
    const seed = [...jobId].reduce(
      (total, character) => total + character.charCodeAt(0),
      0
    );
    const secret = String.fromCharCode(65 + (seed % 26)).repeat(43);
    const bearerToken = `tm_s1_${publicTokenId}.${secret}`;
    const digestOffset =
      this.mismatchStatusOnReplay && previousCount > 0 ? 1 : 0;
    const hmacDigest = String.fromCharCode(
      97 + ((seed + digestOffset) % 26)
    ).repeat(43);
    const stored: StoredCredential = Object.freeze({
      scope: "deletion-status",
      publicTokenId,
      hmacDigest,
      hmacKeyId: "pepper-v1"
    });
    this.issuedByToken.set(bearerToken, stored);
    return Object.freeze({ bearerToken, entropyBits: 256 as const, stored });
  }

  async inspect(bearerToken: string): Promise<PresentedCredential | null> {
    const match = /^tm_(?:[uds]1|[udr]2)_([A-Za-z0-9_-]{16,32})\./.exec(
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
    const actual = this.issuedByToken.get(bearerToken);
    return (
      actual !== undefined &&
      actual.scope === expected.scope &&
      actual.publicTokenId === expected.publicTokenId &&
      actual.hmacDigest === expected.hmacDigest &&
      actual.hmacKeyId === expected.hmacKeyId
    );
  }

  async deriveSuppressionMarker(installationId: string): Promise<string> {
    const character = installationId.charCodeAt(installationId.length - 1) % 26;
    return String.fromCharCode(65 + character).repeat(43);
  }
}

export class MutablePolicy implements ContributionPolicy {
  currentConsentDocumentRevision = "contribution-2026-07-15";

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
        (collector.kind === "tokentracker-bridge" &&
          collector.sourceVersion === "0.79.8") ||
        (collector.kind === "tokentracker-sidecar" &&
          collector.sourceVersion === "0.80.0"))
    );
  }
}

export class AllowRateLimit implements RateLimitPort {
  readonly requests: RateLimitRequest[] = [];
  decision: RateLimitDecision = Object.freeze({ allowed: true });

  async consume(request: RateLimitRequest): Promise<RateLimitDecision> {
    this.requests.push(Object.freeze({ ...request }));
    return this.decision;
  }
}

type Backup = Readonly<{
  installations: Map<string, InstallationRecord>;
  consentReceipts: Map<string, ConsentReceiptRecord>;
  rows: Map<string, CurrentUsageRowRecord>;
  authorities: Map<string, AuthorityBindingRecord>;
  batches: Map<string, IngestBatchReceiptRecord>;
  deletionRequests: Map<string, DeletionRequestRecord>;
  jobs: Map<string, DeletionRequestRecord>;
  recoverableEnrollments: Map<string, RecoverableEnrollmentRecord>;
}>;

export class MemoryMutationStore
  implements
    EnrollmentStoragePort,
    IngestStoragePort,
    DeletionStoragePort,
    DeletionStatusStoragePort,
    LifecycleStoragePort,
    RecoverableEnrollmentStoragePort
{
  installations = new Map<string, InstallationRecord>();
  consentReceipts = new Map<string, ConsentReceiptRecord>();
  rows = new Map<string, CurrentUsageRowRecord>();
  authorities = new Map<string, AuthorityBindingRecord>();
  batches = new Map<string, IngestBatchReceiptRecord>();
  deletionRequests = new Map<string, DeletionRequestRecord>();
  jobs = new Map<string, DeletionRequestRecord>();
  recoverableEnrollments = new Map<string, RecoverableEnrollmentRecord>();
  dirtyCount = 0;
  failCreateWith: Error | null = null;

  async createEnrollmentAtomically(input: {
    readonly installation: InstallationRecord;
    readonly consentReceipt: ConsentReceiptRecord;
  }): Promise<void> {
    if (this.failCreateWith !== null) throw this.failCreateWith;
    if (this.installations.has(input.installation.installationId)) {
      throw new Error("collision");
    }
    this.installations.set(input.installation.installationId, input.installation);
    this.consentReceipts.set(input.consentReceipt.eventId, input.consentReceipt);
  }

  async findRecoverableEnrollment(
    recoveryPublicTokenId: string
  ): Promise<RecoverableEnrollmentRecord | null> {
    return this.recoverableEnrollments.get(recoveryPublicTokenId) ?? null;
  }

  async createRecoverableEnrollmentAtomically(input: {
    readonly installation: InstallationRecord;
    readonly consentReceipt: ConsentReceiptRecord;
    readonly recoveryCredential: StoredCredential;
  }): Promise<void> {
    if (this.failCreateWith !== null) throw this.failCreateWith;
    const allCredentialIds = [
      ...[...this.installations.values()].flatMap((installation) => [
        installation.uploadCredential?.publicTokenId,
        installation.deletionCredential?.publicTokenId
      ]),
      ...this.recoverableEnrollments.keys()
    ];
    if (
      this.installations.has(input.installation.installationId) ||
      allCredentialIds.includes(
        input.installation.uploadCredential?.publicTokenId
      ) ||
      allCredentialIds.includes(
        input.installation.deletionCredential?.publicTokenId
      ) ||
      allCredentialIds.includes(input.recoveryCredential.publicTokenId)
    ) {
      throw new Error("collision");
    }
    const record: RecoverableEnrollmentRecord = Object.freeze({
      installation: input.installation,
      consentReceipt: input.consentReceipt,
      recoveryCredential: input.recoveryCredential
    });
    this.installations.set(input.installation.installationId, input.installation);
    this.consentReceipts.set(input.consentReceipt.eventId, input.consentReceipt);
    this.recoverableEnrollments.set(
      input.recoveryCredential.publicTokenId,
      record
    );
  }

  async findCredentialCandidate(
    scope: CredentialScope,
    publicTokenId: string
  ): Promise<CredentialCandidate | null> {
    for (const installation of this.installations.values()) {
      const credential =
        scope === "upload"
          ? installation.uploadCredential
          : scope === "deletion"
            ? installation.deletionCredential
            : null;
      if (credential?.publicTokenId === publicTokenId) {
        return Object.freeze({
          installationId: installation.installationId,
          credential
        });
      }
    }
    if (scope === "deletion" || scope === "deletion-status") {
      for (const request of this.jobs.values()) {
        const credential =
          scope === "deletion"
            ? request.replayCredential
            : request.statusCredential;
        if (credential.publicTokenId === publicTokenId) {
          return Object.freeze({
            installationId: request.installationId,
            credential
          });
        }
      }
    }
    return null;
  }

  async getDeletionJobStatus(
    jobId: string
  ): Promise<DeletionStatusRecord | null> {
    const request = this.jobs.get(jobId);
    return request === undefined
      ? null
      : Object.freeze({
          installationId: request.installationId,
          jobId: request.jobId,
          state: request.state,
          statusCredential: request.statusCredential,
          requestedAt: request.requestedAt,
          finishedAt: request.completedAt,
          expiresAt: request.expiresAt,
          anonymousHistoricalTotalsRetained:
            request.anonymousHistoricalTotalsRetained
        });
  }

  async withIngestTransaction<T>(
    installationId: string,
    operation: (transaction: IngestTransactionPort) => Promise<T>
  ): Promise<T> {
    const backup = this.backup();
    const transaction: IngestTransactionPort = {
      findCredentialCandidate: async (scope, publicTokenId) =>
        this.findCredentialCandidate(scope, publicTokenId),
      getInstallation: async () => this.installations.get(installationId) ?? null,
      getBatchReceipt: async (batchId) =>
        this.batches.get(`${installationId}|${batchId}`) ?? null,
      getAuthorityBinding: async (bucketStart) =>
        this.authorities.get(`${installationId}|${bucketStart}`) ?? null,
      getUsageRow: async (key) => this.rows.get(key) ?? null,
      putAuthorityBinding: async (binding) => {
        this.authorities.set(
          `${installationId}|${binding.bucketStart}`,
          binding
        );
      },
      putUsageRow: async (row) => {
        this.rows.set(row.key, row);
      },
      putBatchReceipt: async (receipt) => {
        this.batches.set(`${installationId}|${receipt.batchId}`, receipt);
      },
      markAggregateDirty: async () => {
        this.dirtyCount += 1;
      }
    };
    try {
      return await operation(transaction);
    } catch (error: unknown) {
      this.restore(backup);
      throw error;
    }
  }

  async withDeletionTransaction<T>(
    installationId: string,
    operation: (transaction: DeletionTransactionPort) => Promise<T>
  ): Promise<T> {
    const backup = this.backup();
    const transaction: DeletionTransactionPort = {
      findCredentialCandidate: async (scope, publicTokenId) =>
        this.findCredentialCandidate(scope, publicTokenId),
      getInstallation: async () => this.installations.get(installationId) ?? null,
      getDeletionRequest: async (idempotencyKey) =>
        this.deletionRequests.get(`${installationId}|${idempotencyKey}`) ?? null,
      beginDeletion: async ({ request, at }) => {
        const installation = this.installations.get(installationId);
        if (installation === undefined) throw new Error("missing installation");
        this.deletionRequests.set(
          `${installationId}|${request.idempotencyKey}`,
          request
        );
        this.jobs.set(request.jobId, request);
        this.installations.set(
          installationId,
          Object.freeze({
            ...installation,
            status: "deleting" as const,
            uploadCredential: null,
            deletingAt: at
          })
        );
      }
    };
    try {
      return await operation(transaction);
    } catch (error: unknown) {
      this.restore(backup);
      throw error;
    }
  }

  async withLifecycleTransaction<T>(
    installationId: string,
    operation: (transaction: LifecycleTransactionPort) => Promise<T>
  ): Promise<T> {
    const backup = this.backup();
    const transaction: LifecycleTransactionPort = {
      findCredentialCandidate: async (scope, publicTokenId) =>
        this.findCredentialCandidate(scope, publicTokenId),
      getInstallation: async () =>
        this.installations.get(installationId) ?? null,
      getLatestGrantedConsentReceipt: async (documentRevision) =>
        [...this.consentReceipts.values()]
          .filter(
            (receipt) =>
              receipt.installationId === installationId &&
              receipt.documentRevision === documentRevision
          )
          .sort((left, right) =>
            left.recordedAt === right.recordedAt
              ? right.eventId.localeCompare(left.eventId)
              : right.recordedAt.localeCompare(left.recordedAt)
          )[0] ?? null,
      pause: async (at) => {
        const installation = this.installations.get(installationId);
        if (installation === undefined) throw new Error("missing installation");
        this.installations.set(
          installationId,
          Object.freeze({
            ...installation,
            status: "paused" as const,
            pausedAt: at
          })
        );
      },
      resume: async ({ consentReceipt }) => {
        const installation = this.installations.get(installationId);
        if (installation === undefined) throw new Error("missing installation");
        this.installations.set(
          installationId,
          Object.freeze({
            ...installation,
            status: "active" as const,
            consentDocumentRevision: consentReceipt.documentRevision,
            pausedAt: null
          })
        );
        this.consentReceipts.set(consentReceipt.eventId, consentReceipt);
      }
    };
    try {
      return await operation(transaction);
    } catch (error: unknown) {
      this.restore(backup);
      throw error;
    }
  }

  async completeDeletionAtomically(input: {
    readonly jobId: string;
    readonly completedAt: string;
  }): Promise<DeletionRequestRecord> {
    const existing = this.jobs.get(input.jobId);
    if (existing === undefined) throw new Error("missing deletion job");
    if (existing.state === "complete") return existing;
    const completed: DeletionRequestRecord = Object.freeze({
      ...existing,
      state: "complete" as const,
      completedAt: input.completedAt
    });
    this.jobs.set(input.jobId, completed);
    this.deletionRequests.set(
      `${existing.installationId}|${existing.idempotencyKey}`,
      completed
    );
    for (const [key, row] of this.rows) {
      if (row.installationId === existing.installationId) this.rows.delete(key);
    }
    for (const [key, binding] of this.authorities) {
      if (binding.installationId === existing.installationId) {
        this.authorities.delete(key);
      }
    }
    for (const [key, receipt] of this.batches) {
      if (receipt.installationId === existing.installationId) {
        this.batches.delete(key);
      }
    }
    for (const [key, receipt] of this.consentReceipts) {
      if (receipt.installationId === existing.installationId) {
        this.consentReceipts.delete(key);
      }
    }
    for (const [key, record] of this.recoverableEnrollments) {
      if (record.installation.installationId === existing.installationId) {
        this.recoverableEnrollments.delete(key);
      }
    }
    const installation = this.installations.get(existing.installationId);
    if (installation !== undefined) {
      this.installations.set(
        existing.installationId,
        Object.freeze({
          ...installation,
          status: "deleted" as const,
          uploadCredential: null,
          deletionCredential: null,
          deletedAt: input.completedAt
        })
      );
    }
    this.dirtyCount += 1;
    return completed;
  }

  async *listRestoredInstallationIds(): AsyncIterable<string> {
    for (const installationId of this.installations.keys()) {
      yield installationId;
    }
  }

  async purgeRestoredInstallation(
    installationId: string,
    _at: string
  ): Promise<boolean> {
    const installation = this.installations.get(installationId);
    if (installation === undefined) return false;
    this.installations.delete(installationId);
    for (const [key, row] of this.rows) {
      if (row.installationId === installationId) this.rows.delete(key);
    }
    for (const [key, binding] of this.authorities) {
      if (binding.installationId === installationId) this.authorities.delete(key);
    }
    for (const [key, receipt] of this.batches) {
      if (receipt.installationId === installationId) this.batches.delete(key);
    }
    for (const [key, receipt] of this.consentReceipts) {
      if (receipt.installationId === installationId) {
        this.consentReceipts.delete(key);
      }
    }
    for (const [key, record] of this.recoverableEnrollments) {
      if (record.installation.installationId === installationId) {
        this.recoverableEnrollments.delete(key);
      }
    }
    this.dirtyCount += 1;
    return true;
  }

  setStatus(status: InstallationRecord["status"]): void {
    const installation = [...this.installations.values()][0];
    if (installation === undefined) throw new Error("not enrolled");
    this.installations.set(
      installation.installationId,
      Object.freeze({ ...installation, status })
    );
  }

  backup(): Backup {
    return Object.freeze({
      installations: cloneMap(this.installations),
      consentReceipts: cloneMap(this.consentReceipts),
      rows: cloneMap(this.rows),
      authorities: cloneMap(this.authorities),
      batches: cloneMap(this.batches),
      deletionRequests: cloneMap(this.deletionRequests),
      jobs: cloneMap(this.jobs),
      recoverableEnrollments: cloneMap(this.recoverableEnrollments)
    });
  }

  restore(backup: Backup): void {
    this.installations = cloneMap(backup.installations);
    this.consentReceipts = cloneMap(backup.consentReceipts);
    this.rows = cloneMap(backup.rows);
    this.authorities = cloneMap(backup.authorities);
    this.batches = cloneMap(backup.batches);
    this.deletionRequests = cloneMap(backup.deletionRequests);
    this.jobs = cloneMap(backup.jobs);
    this.recoverableEnrollments = cloneMap(backup.recoverableEnrollments);
  }
}

export class MemorySuppressionLedger implements SuppressionLedgerPort {
  readonly entries = new Map<string, SuppressionLedgerEntry>();

  async record(entry: SuppressionLedgerEntry): Promise<void> {
    this.entries.set(entry.suppressionMarker, Object.freeze({ ...entry }));
  }

  async listActive(at: string): Promise<readonly SuppressionLedgerEntry[]> {
    return [...this.entries.values()].filter(
      ({ expiresAt }) => Date.parse(expiresAt) > Date.parse(at)
    );
  }
}

export function enrollmentBody(
  overrides: Readonly<Record<string, unknown>> = {}
): unknown {
  return {
    contractVersion: 1,
    consent: {
      purpose: "contribution",
      documentRevision: "contribution-2026-07-15",
      granted: true,
      acknowledgedAt: "2026-07-15T18:20:00.000Z"
    },
    ...overrides
  };
}

export function snapshot(
  overrides: Readonly<Record<string, unknown>> = {}
): unknown {
  return {
    schemaVersion: "1",
    batchId: "6b0b8cb1-cd48-47ef-b676-c5a71d02a74b",
    generatedAt: "2026-07-15T18:22:04.000Z",
    collector: {
      kind: "tokscale",
      adapterVersion: "0.1.0",
      sourceVersion: "4.5.2"
    },
    buckets: [
      {
        bucketStart: "2026-07-15T00:00:00.000Z",
        provider: "openai",
        modelFamily: "gpt-5",
        tool: "codex-cli",
        valueQuality: "exact",
        revision: 1,
        tokens: {
          input: "1200",
          output: "500",
          cacheRead: "800",
          cacheWrite: "0",
          reasoning: "120",
          other: "0",
          total: "2500"
        }
      }
    ],
    ...overrides
  };
}

export function sidecarSnapshot(
  overrides: Readonly<Record<string, unknown>> = {}
): unknown {
  return snapshot({
    schemaVersion: "2",
    collector: {
      kind: "tokentracker-sidecar",
      adapterVersion: "0.1.0",
      sourceVersion: "0.80.0"
    },
    ...overrides
  });
}

export const RATE_KEY = "rate_key_AAAAAAAA";
export const DELETE_KEY = "delete_request_AAAAAAAA";
