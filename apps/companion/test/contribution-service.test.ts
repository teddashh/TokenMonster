import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  EncryptedSecretSlot,
  SecretPersistence,
  SecretSlotStatus,
} from "@tokenmonster/secret-vault";
import {
  openLocalStore,
  type LocalStore,
  type ProjectedDailyAggregate,
} from "@tokenmonster/local-store";
import type { IngestSnapshotV1, TokenCountsV1 } from "@tokenmonster/contracts";

import {
  CONTRIBUTION_FIELD_ALLOWLIST,
  createContributionService,
  resolveContributionApiBaseUrl,
} from "../src/main/contribution-service.js";

const API = "https://api.tokenmonster.example";
const NOW = "2026-07-15T18:00:00.000Z";
const UPLOAD_TOKEN = `tm_u1_${"u".repeat(16)}.${"U".repeat(43)}`;
const DELETE_TOKEN = `tm_d1_${"d".repeat(16)}.${"D".repeat(43)}`;
const STATUS_TOKEN = `tm_s1_${"s".repeat(16)}.${"S".repeat(43)}`;
const JOB_ID = `del_${"j".repeat(22)}`;
const RECEIPT_ID = `cr_${"r".repeat(22)}`;
const IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
  "10000000-0000-4000-8000-000000000005",
] as const;

const TOKENS: TokenCountsV1 = Object.freeze({
  input: "1200",
  output: "500",
  cacheRead: "800",
  cacheWrite: "0",
  reasoning: "120",
  other: "0",
  total: "2500",
});

class TestSlot implements EncryptedSecretSlot {
  value: string | null = null;
  failSet = false;

  constructor(readonly persistence: SecretPersistence = "os-backed") {}

  private snapshot(): SecretSlotStatus {
    return Object.freeze({
      configured: this.value !== null,
      persistence: this.persistence,
      backend: this.persistence === "os-backed" ? "keychain" : "basic_text",
    });
  }

  initialize(): Promise<SecretSlotStatus> {
    return Promise.resolve(this.snapshot());
  }

  set(secret: string): Promise<SecretSlotStatus> {
    if (this.failSet) return Promise.reject(new Error("SLOT_WRITE_FAILED"));
    this.value = secret;
    return Promise.resolve(this.snapshot());
  }

  get(): string | null {
    return this.value;
  }

  clear(): Promise<SecretSlotStatus> {
    this.value = null;
    return Promise.resolve(this.snapshot());
  }

  status(): SecretSlotStatus {
    return this.snapshot();
  }
}

let store: LocalStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
}

function consentDocument() {
  return {
    contractVersion: 1,
    purpose: "contribution",
    revision: "contribution-2026-07-15",
    locale: "zh-TW",
    title: "自願分享匿名 Token 日彙總",
    summary: "只分享內容盲 UTC 日彙總。",
    fieldAllowlist: CONTRIBUTION_FIELD_ALLOWLIST,
    forbidden: [],
    retention: {
      identifiableCurrentBucketsMaximumDays: 30,
      disclosure: "Current buckets 最多保留 30 天；k≥20 後不可個別抽出。",
    },
    controls: {
      defaultEnabled: false,
      pauseStopsFutureUploadsButDoesNotDelete: true,
      deletionRemovesIdentifiableCurrentData: true,
      productAnalyticsIsSeparateAndDefaultOff: true,
    },
    previewRequirement: "必須預覽。",
    schemaExample: {},
  };
}

function enrollmentResponse() {
  return {
    contractVersion: 1,
    credentials: {
      uploadToken: UPLOAD_TOKEN,
      deletionToken: DELETE_TOKEN,
    },
    consentReceipt: {
      receiptId: RECEIPT_ID,
      purpose: "contribution",
      documentRevision: "contribution-2026-07-15",
      granted: true,
      acknowledgedAt: NOW,
      recordedAt: NOW,
    },
    acceptedSnapshotSchemaVersions: ["1"],
  };
}

function deletionAccepted() {
  return {
    contractVersion: 1,
    jobId: JOB_ID,
    statusToken: STATUS_TOKEN,
    status: "queued",
    requestedAt: NOW,
    anonymousHistoricalTotalsRetained: true,
  };
}

function aggregate(
  bucketStart: string,
  overrides: Partial<ProjectedDailyAggregate> = {},
): ProjectedDailyAggregate {
  return {
    bucketStart,
    provider: "openai",
    modelFamily: "gpt-5",
    tool: "codex-cli",
    valueQuality: "exact",
    tokens: TOKENS,
    localCoverage: "complete",
    collector: {
      kind: "tokscale",
      adapterVersion: "0.1.0",
      sourceVersion: "4.5.2",
    },
    ...overrides,
  };
}

function completeDay(localStore: LocalStore, utcDate: string): void {
  for (const client of ["claude", "codex", "gemini", "grok"] as const) {
    localStore.recordCompleteDailyScan({ utcDate, client });
  }
}

function service(
  fetcher: typeof fetch,
  input: Readonly<{
    upload?: TestSlot;
    deletion?: TestSlot;
    status?: TestSlot;
    clock?: () => Date;
    uuid?: () => string;
    configuredBaseUrl?: unknown;
  }> = {},
) {
  if (store === null) throw new Error("TEST_STORE_MISSING");
  const upload = input.upload ?? new TestSlot();
  const deletion = input.deletion ?? new TestSlot();
  const status = input.status ?? new TestSlot();
  let idIndex = 0;
  const contribution = createContributionService({
    store,
    uploadCredential: upload,
    deletionCredential: deletion,
    statusCredential: status,
    configuredBaseUrl: Object.hasOwn(input, "configuredBaseUrl")
      ? input.configuredBaseUrl
      : API,
    allowedOrigins: [API],
    fetcher,
    clock: input.clock ?? (() => new Date(NOW)),
    uuid: input.uuid ?? (() => IDS[idIndex++] ?? IDS[IDS.length - 1]!),
  });
  return { contribution, upload, deletion, status };
}

function activeCredentialSlots(): {
  readonly upload: TestSlot;
  readonly deletion: TestSlot;
} {
  const upload = new TestSlot();
  const deletion = new TestSlot();
  upload.value = JSON.stringify({
    schemaVersion: 1,
    kind: "upload",
    token: UPLOAD_TOKEN,
    consentDocumentRevision: "contribution-2026-07-15",
  });
  deletion.value = JSON.stringify({
    schemaVersion: 1,
    kind: "deletion",
    token: DELETE_TOKEN,
    idempotencyKey: IDS[4],
  });
  return Object.freeze({ upload, deletion });
}

describe("companion contribution service", () => {
  it("fails closed for missing/non-HTTPS/non-allowlisted API configuration", () => {
    expect(resolveContributionApiBaseUrl(undefined, [API])).toBeNull();
    expect(resolveContributionApiBaseUrl("http://api.tokenmonster.example", [API])).toBeNull();
    expect(resolveContributionApiBaseUrl("https://attacker.example", [API])).toBeNull();
    expect(resolveContributionApiBaseUrl(`${API}/v1`, [API])).toBeNull();
    expect(resolveContributionApiBaseUrl(`${API}?next=https://attacker.example`, [API])).toBeNull();
    expect(resolveContributionApiBaseUrl(`${API}/`, [API])).toBe(API);
  });

  it("blocks enrollment before any network call without durable OS-backed storage", async () => {
    store = await openLocalStore({ path: ":memory:" });
    const fetcher = vi.fn<typeof fetch>();
    const instance = service(fetcher, { upload: new TestSlot("memory-only") });
    await instance.contribution.initialize();

    expect(instance.contribution.status()).toMatchObject({
      secureStorage: "unavailable",
      canEnable: false,
      enabled: false,
    });
    await expect(instance.contribution.preparePreview()).rejects.toThrow(
      "secure-storage-unavailable",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never reports active or performs contribution network when initialization is unsafe", async () => {
    store = await openLocalStore({ path: ":memory:" });
    const upload = new TestSlot("memory-only");
    const deletion = new TestSlot();
    upload.value = JSON.stringify({
      schemaVersion: 1,
      kind: "upload",
      token: UPLOAD_TOKEN,
      consentDocumentRevision: "contribution-2026-07-15",
    });
    deletion.value = JSON.stringify({
      schemaVersion: 1,
      kind: "deletion",
      token: DELETE_TOKEN,
      idempotencyKey: IDS[4],
    });
    const fetcher = vi.fn<typeof fetch>();
    const instance = service(fetcher, { upload, deletion });
    await instance.contribution.initialize();

    expect(instance.contribution.status()).toMatchObject({
      state: "unavailable",
      enabled: false,
      canDelete: false,
    });
    await expect(instance.contribution.sync()).resolves.toMatchObject({
      ok: false,
      code: "secure-storage-unavailable",
    });
    await expect(instance.contribution.requestDeletion()).resolves.toMatchObject({
      ok: false,
      code: "secure-storage-unavailable",
    });
    expect(fetcher).not.toHaveBeenCalled();

    const configuredUpload = new TestSlot();
    const configuredDeletion = new TestSlot();
    configuredUpload.value = upload.value;
    configuredDeletion.value = deletion.value;
    const noBaseFetcher = vi.fn<typeof fetch>();
    const withoutBase = service(noBaseFetcher, {
      upload: configuredUpload,
      deletion: configuredDeletion,
      configuredBaseUrl: null,
    });
    await withoutBase.contribution.initialize();
    expect(withoutBase.contribution.status()).toMatchObject({
      configured: false,
      state: "unavailable",
      enabled: false,
      canDelete: false,
    });
    await expect(withoutBase.contribution.sync()).resolves.toMatchObject({
      ok: false,
      code: "api-not-configured",
    });
    expect(noBaseFetcher).not.toHaveBeenCalled();
  });

  it("does no network work when an active contributor has no due payload", async () => {
    store = await openLocalStore({ path: ":memory:", clock: () => new Date(NOW) });
    const fetcher = vi.fn<typeof fetch>();
    const instance = service(fetcher, activeCredentialSlots());
    await instance.contribution.initialize();

    await expect(instance.contribution.sync()).resolves.toMatchObject({
      ok: true,
      code: "nothing-due",
      uploadedBatches: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does no network work while the exact retry body is not yet due", async () => {
    store = await openLocalStore({ path: ":memory:", clock: () => new Date(NOW) });
    const snapshot: IngestSnapshotV1 = {
      schemaVersion: "1",
      batchId: IDS[0],
      generatedAt: NOW,
      collector: {
        kind: "tokscale",
        adapterVersion: "0.1.0",
        sourceVersion: "4.5.2",
      },
      buckets: [
        {
          bucketStart: "2026-07-14T00:00:00.000Z",
          provider: "openai",
          modelFamily: "gpt-5",
          tool: "codex-cli",
          valueQuality: "exact",
          revision: 1,
          tokens: TOKENS,
        },
      ],
    };
    store.enqueueCloudSnapshot(snapshot, {
      nextAttemptAt: "2026-07-15T18:15:00.000Z",
      expiresAt: "2026-08-13T00:00:00.000Z",
    });
    const fetcher = vi.fn<typeof fetch>();
    const instance = service(fetcher, activeCredentialSlots());
    await instance.contribution.initialize();

    await expect(instance.contribution.sync()).resolves.toMatchObject({
      ok: true,
      code: "nothing-due",
      uploadedBatches: 0,
      status: { outboxPending: 1 },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("checks current consent before a due upload and preserves the queue when stale", async () => {
    store = await openLocalStore({ path: ":memory:", clock: () => new Date(NOW) });
    store.upsertDailyAggregate(aggregate("2026-07-14T00:00:00.000Z"));
    completeDay(store, "2026-07-14");
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({
        ...consentDocument(),
        revision: "contribution-2026-07-16",
      }),
    );
    const instance = service(fetcher, activeCredentialSlots());
    await instance.contribution.initialize();

    await expect(instance.contribution.sync()).resolves.toMatchObject({
      ok: false,
      code: "consent-stale",
      uploadedBatches: 0,
      status: { outboxPending: 1 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("consent-documents");
    expect(store.getDiagnosticSummary().counts.cloudOutboxEntries).toBe(1);
  });

  it("aborts an in-flight background upload before hard local stop completes", async () => {
    store = await openLocalStore({ path: ":memory:", clock: () => new Date(NOW) });
    store.upsertDailyAggregate(aggregate("2026-07-14T00:00:00.000Z"));
    completeDay(store, "2026-07-14");
    const ingestStarted = deferred<void>();
    const observed: { signal: AbortSignal | null } = { signal: null };
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("consent-documents")) {
        return json(consentDocument());
      }
      observed.signal = request.signal;
      ingestStarted.resolve();
      return await new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const instance = service(fetcher, activeCredentialSlots());
    await instance.contribution.initialize();

    const syncing = instance.contribution.sync();
    await ingestStarted.promise;
    const stopped = await instance.contribution.stop();
    const syncResult = await syncing;

    expect(observed.signal?.aborted).toBe(true);
    expect(syncResult).toMatchObject({ ok: false, uploadedBatches: 0 });
    expect(stopped).toMatchObject({
      ok: true,
      code: "stopped",
      status: { state: "stopped", enabled: false, outboxPending: 0 },
    });
    expect(instance.upload.value).toBeNull();
    expect(instance.deletion.value).toContain(DELETE_TOKEN);
  });

  it("previews only closed, four-client-complete UTC days and applies the exact 30-day boundary", async () => {
    store = await openLocalStore({ path: ":memory:", clock: () => new Date(NOW) });
    store.upsertDailyAggregate(aggregate("2026-06-15T00:00:00.000Z"));
    store.upsertDailyAggregate(aggregate("2026-06-16T00:00:00.000Z", { tool: "claude-code" }));
    store.upsertDailyAggregate(aggregate("2026-07-14T00:00:00.000Z", { tool: "gemini-cli" }));
    store.upsertDailyAggregate(aggregate("2026-07-15T00:00:00.000Z", { tool: "grok-build" }));
    for (const date of ["2026-06-15", "2026-06-16", "2026-07-14", "2026-07-15"]) {
      completeDay(store, date);
    }
    const fetcher = vi.fn<typeof fetch>(async () => json(consentDocument()));
    const instance = service(fetcher);
    await instance.contribution.initialize();

    const preview = await instance.contribution.preparePreview();
    expect(preview.payload?.buckets.map(({ bucketStart }) => bucketStart)).toEqual([
      "2026-06-16T00:00:00.000Z",
      "2026-07-14T00:00:00.000Z",
    ]);
    const serialized = JSON.stringify(preview.payload);
    expect(serialized).not.toMatch(
      /prompt|response|source.?code|filename|project.?path|api.?key|oauth|hourly|raw.?log/i,
    );

    const enabledFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(consentDocument()))
      .mockResolvedValueOnce(json(enrollmentResponse(), 201));
    const enabled = service(enabledFetch);
    await enabled.contribution.initialize();
    const nextPreview = await enabled.contribution.preparePreview();
    await enabled.contribution.enable(nextPreview.previewId);
    const queued = store.listDueCloudSnapshots({ now: NOW, limit: 10 });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.expiresAt).toBe("2026-07-16T00:00:00.000Z");
  });

  it("treats coverage as day-atomic and skips a complete-ledger day containing any partial row", async () => {
    store = await openLocalStore({ path: ":memory:", clock: () => new Date(NOW) });
    store.upsertDailyAggregate(aggregate("2026-07-14T00:00:00.000Z"));
    store.upsertDailyAggregate(
      aggregate("2026-07-14T00:00:00.000Z", {
        tool: "claude-code",
        localCoverage: "partial",
      }),
    );
    completeDay(store, "2026-07-14");
    const fetcher = vi.fn<typeof fetch>(async () => json(consentDocument()));
    const instance = service(fetcher);
    await instance.contribution.initialize();

    const preview = await instance.contribution.preparePreview();
    expect(preview.payload).toBeNull();
    expect(preview.eligibleBucketCount).toBe(0);
  });

  it("expires a consent preview at the displayed boundary and after a local clock rollback", async () => {
    let now = new Date(NOW);
    store = await openLocalStore({ path: ":memory:", clock: () => new Date(now) });
    const fetcher = vi.fn<typeof fetch>(async () => json(consentDocument()));
    const instance = service(fetcher, { clock: () => new Date(now) });
    await instance.contribution.initialize();

    const boundaryPreview = await instance.contribution.preparePreview();
    now = new Date("2026-07-15T18:10:00.000Z");
    await expect(
      instance.contribution.enable(boundaryPreview.previewId),
    ).resolves.toMatchObject({ ok: false, code: "preview-expired" });

    now = new Date(NOW);
    const rollbackPreview = await instance.contribution.preparePreview();
    now = new Date("2026-07-15T17:59:59.999Z");
    await expect(
      instance.contribution.enable(rollbackPreview.previewId),
    ).resolves.toMatchObject({ ok: false, code: "preview-expired" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.some(([input]) =>
        String(input).endsWith("/v1/enrollments"),
      ),
    ).toBe(false);
  });

  it("enrolls after exact preview, separates scoped secrets, and sends one idempotent snapshot", async () => {
    store = await openLocalStore({ path: ":memory:", clock: () => new Date(NOW) });
    store.upsertDailyAggregate(aggregate("2026-07-14T00:00:00.000Z"));
    completeDay(store, "2026-07-14");
    const calls: Request[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      calls.push(request.clone());
      if (request.url.includes("consent-documents")) return json(consentDocument());
      if (request.url.endsWith("/v1/enrollments")) return json(enrollmentResponse(), 201);
      const snapshot = (await request.json()) as IngestSnapshotV1;
      return json({
        contractVersion: 1,
        batchId: snapshot.batchId,
        receivedAt: NOW,
        replayed: false,
        status: "accepted",
        summary: {
          appliedBuckets: snapshot.buckets.length,
          staleBuckets: 0,
          idempotentBuckets: 0,
          quarantinedBuckets: 0,
        },
      });
    });
    const instance = service(fetcher);
    await instance.contribution.initialize();
    const preview = await instance.contribution.preparePreview();
    const enrolled = await instance.contribution.enable(preview.previewId);

    expect(enrolled).toMatchObject({ ok: true, code: "enabled" });
    expect(instance.upload.value).toContain('"kind":"upload"');
    expect(instance.upload.value).toContain(UPLOAD_TOKEN);
    expect(instance.upload.value).not.toContain(DELETE_TOKEN);
    expect(instance.deletion.value).toContain('"kind":"deletion"');
    expect(instance.deletion.value).toContain(DELETE_TOKEN);
    expect(instance.deletion.value).not.toContain(UPLOAD_TOKEN);
    expect(JSON.stringify(instance.contribution.status())).not.toContain("tm_");

    const synced = await instance.contribution.sync();
    expect(synced).toMatchObject({ ok: true, code: "uploaded", uploadedBatches: 1 });
    const ingest = calls.find((request) => request.url.endsWith("/v1/me/ingest-snapshots"));
    expect(ingest?.headers.get("Authorization")).toBe(`Bearer ${UPLOAD_TOKEN}`);
    const wire = (await ingest?.clone().json()) as IngestSnapshotV1;
    expect(ingest?.headers.get("Idempotency-Key")).toBe(wire.batchId);
    expect(store.getDiagnosticSummary().counts.cloudOutboxEntries).toBe(0);
    expect(store.getDiagnosticSummary().counts.cloudMirrorEntries).toBe(1);
  });

  it("best-effort deletes a server enrollment and exposes no active state after a partial slot write", async () => {
    store = await openLocalStore({ path: ":memory:", clock: () => new Date(NOW) });
    const upload = new TestSlot();
    upload.failSet = true;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(consentDocument()))
      .mockResolvedValueOnce(json(enrollmentResponse(), 201))
      .mockResolvedValueOnce(json(deletionAccepted(), 202));
    const instance = service(fetcher, { upload });
    await instance.contribution.initialize();
    const preview = await instance.contribution.preparePreview();
    const result = await instance.contribution.enable(preview.previewId);

    expect(result).toMatchObject({
      ok: false,
      code: "secure-storage-failed",
      status: { state: "off", enabled: false },
    });
    expect(instance.upload.value).toBeNull();
    expect(instance.deletion.value).toBeNull();
    expect(instance.status.value).toBeNull();
    const cleanup = fetcher.mock.calls[2];
    expect(String(cleanup?.[0])).toContain("/v1/me/data");
    expect(new Headers(cleanup?.[1]?.headers).get("Authorization")).toBe(
      `Bearer ${DELETE_TOKEN}`,
    );
  });

  it("retries the exact queued ingest body and batch id after a network failure", async () => {
    let now = new Date(NOW);
    store = await openLocalStore({ path: ":memory:", clock: () => new Date(now) });
    store.upsertDailyAggregate(aggregate("2026-07-14T00:00:00.000Z"));
    completeDay(store, "2026-07-14");
    const ingestAttempts: {
      idempotencyKey: string;
      body: string;
    }[] = [];
    let ingestCount = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("consent-documents")) return json(consentDocument());
      if (request.url.endsWith("/v1/enrollments")) return json(enrollmentResponse(), 201);
      if (request.url.endsWith("/v1/me/ingest-snapshots")) {
        const body = await request.text();
        ingestAttempts.push(
          Object.freeze({
            idempotencyKey: request.headers.get("Idempotency-Key") ?? "",
            body,
          }),
        );
        ingestCount += 1;
        if (ingestCount === 1) throw new TypeError("NETWORK_DOWN");
        const snapshot = JSON.parse(body) as IngestSnapshotV1;
        return json({
          contractVersion: 1,
          batchId: snapshot.batchId,
          receivedAt: now.toISOString(),
          replayed: true,
          status: "accepted",
          summary: {
            appliedBuckets: 0,
            staleBuckets: 0,
            idempotentBuckets: snapshot.buckets.length,
            quarantinedBuckets: 0,
          },
        });
      }
      throw new Error("UNEXPECTED_REQUEST");
    });
    const instance = service(fetcher, { clock: () => new Date(now) });
    await instance.contribution.initialize();
    const preview = await instance.contribution.preparePreview();
    await instance.contribution.enable(preview.previewId);

    await expect(instance.contribution.sync()).resolves.toMatchObject({
      ok: false,
      code: "network-error",
      uploadedBatches: 0,
    });
    now = new Date("2026-07-15T18:02:00.000Z");
    await expect(instance.contribution.sync()).resolves.toMatchObject({
      ok: true,
      code: "uploaded",
      uploadedBatches: 1,
    });
    expect(ingestAttempts).toHaveLength(2);
    expect(ingestAttempts[0]).toEqual(ingestAttempts[1]);
    expect(ingestAttempts[0]?.idempotencyKey).toBe(
      (JSON.parse(ingestAttempts[0]?.body ?? "{}") as IngestSnapshotV1).batchId,
    );
  });

  it("turns an accepted row missing from a later complete scan into a higher-revision absolute zero", async () => {
    store = await openLocalStore({ path: ":memory:", clock: () => new Date(NOW) });
    const accepted: IngestSnapshotV1 = {
      schemaVersion: "1",
      batchId: IDS[0],
      generatedAt: "2026-07-14T12:00:00.000Z",
      collector: {
        kind: "tokscale",
        adapterVersion: "0.1.0",
        sourceVersion: "4.5.2",
      },
      buckets: [
        {
          bucketStart: "2026-07-14T00:00:00.000Z",
          provider: "openai",
          modelFamily: "gpt-5",
          tool: "codex-cli",
          valueQuality: "exact",
          revision: 1,
          tokens: TOKENS,
        },
      ],
    };
    store.recordAcceptedCloudSnapshot(accepted, {
      contractVersion: 1,
      batchId: accepted.batchId,
      receivedAt: "2026-07-14T12:00:01.000Z",
      replayed: false,
      status: "accepted",
      summary: {
        appliedBuckets: 1,
        staleBuckets: 0,
        idempotentBuckets: 0,
        quarantinedBuckets: 0,
      },
    });
    completeDay(store, "2026-07-14");
    const upload = new TestSlot();
    const deletion = new TestSlot();
    upload.value = JSON.stringify({
      schemaVersion: 1,
      kind: "upload",
      token: UPLOAD_TOKEN,
      consentDocumentRevision: "contribution-2026-07-15",
    });
    deletion.value = JSON.stringify({
      schemaVersion: 1,
      kind: "deletion",
      token: DELETE_TOKEN,
      idempotencyKey: IDS[4],
    });
    const sent: IngestSnapshotV1[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("consent-documents")) return json(consentDocument());
      const snapshot = (await request.json()) as IngestSnapshotV1;
      sent.push(snapshot);
      return json({
        contractVersion: 1,
        batchId: snapshot.batchId,
        receivedAt: NOW,
        replayed: false,
        status: "accepted",
        summary: {
          appliedBuckets: snapshot.buckets.length,
          staleBuckets: 0,
          idempotentBuckets: 0,
          quarantinedBuckets: 0,
        },
      });
    });
    const instance = service(fetcher, { upload, deletion });
    await instance.contribution.initialize();

    await expect(instance.contribution.sync()).resolves.toMatchObject({
      ok: true,
      code: "uploaded",
    });
    expect(sent[0]?.buckets).toEqual([
      {
        ...accepted.buckets[0],
        revision: 2,
        tokens: {
          input: "0",
          output: "0",
          cacheRead: "0",
          cacheWrite: "0",
          reasoning: "0",
          other: "0",
          total: "0",
        },
      },
    ]);
  });

  it("hard-stops locally while preserving deletion authority, then stores only the status credential", async () => {
    store = await openLocalStore({ path: ":memory:", clock: () => new Date(NOW) });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("consent-documents")) return json(consentDocument());
      if (url.endsWith("/v1/enrollments")) return json(enrollmentResponse(), 201);
      if (url.endsWith("/v1/me/data")) return json(deletionAccepted(), 202);
      return json({
        contractVersion: 1,
        jobId: JOB_ID,
        status: "complete",
        requestedAt: NOW,
        finishedAt: "2026-07-15T18:05:00.000Z",
        anonymousHistoricalTotalsRetained: true,
      });
    });
    const instance = service(fetcher);
    await instance.contribution.initialize();
    const preview = await instance.contribution.preparePreview();
    await instance.contribution.enable(preview.previewId);

    const stopped = await instance.contribution.stop();
    expect(stopped.status).toMatchObject({ state: "stopped", enabled: false, canDelete: true });
    expect(instance.upload.value).toBeNull();
    expect(instance.deletion.value).toContain(DELETE_TOKEN);

    const requested = await instance.contribution.requestDeletion();
    expect(requested.status).toMatchObject({ state: "deletion-pending", canDelete: false });
    expect(instance.deletion.value).toBeNull();
    expect(instance.status.value).toContain(STATUS_TOKEN);
    expect(instance.status.value).not.toContain(DELETE_TOKEN);
    const complete = await instance.contribution.refreshDeletionStatus();
    expect(complete.status).toMatchObject({ state: "deletion-complete" });
  });

  it("persists and reuses one deletion idempotency key after an accepted response is lost", async () => {
    store = await openLocalStore({ path: ":memory:", clock: () => new Date(NOW) });
    const deletionKeys: string[] = [];
    let deletionAttempts = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("consent-documents")) return json(consentDocument());
      if (request.url.endsWith("/v1/enrollments")) return json(enrollmentResponse(), 201);
      if (request.url.endsWith("/v1/me/data")) {
        deletionKeys.push(request.headers.get("Idempotency-Key") ?? "");
        deletionAttempts += 1;
        if (deletionAttempts === 1) {
          throw new TypeError("RESPONSE_LOST_AFTER_ACCEPT");
        }
        return json(deletionAccepted(), 202);
      }
      throw new Error("UNEXPECTED_REQUEST");
    });
    const instance = service(fetcher);
    await instance.contribution.initialize();
    const preview = await instance.contribution.preparePreview();
    await instance.contribution.enable(preview.previewId);

    await expect(instance.contribution.requestDeletion()).resolves.toMatchObject({
      ok: false,
      code: "network-error",
      status: { state: "active", canDelete: true },
    });
    const restarted = service(fetcher, {
      upload: instance.upload,
      deletion: instance.deletion,
      status: instance.status,
      uuid: () => IDS[4],
    });
    await restarted.contribution.initialize();
    await expect(restarted.contribution.requestDeletion()).resolves.toMatchObject({
      ok: true,
      code: "deletion-requested",
      status: { state: "deletion-pending" },
    });
    expect(deletionKeys).toHaveLength(2);
    expect(deletionKeys[0]).toBe(deletionKeys[1]);
    expect(deletionKeys[0]).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
