import { afterEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";

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
  CONTRIBUTION_CREDENTIAL_OPERATION_TIMEOUT_MS,
  CONTRIBUTION_FIELD_ALLOWLIST,
  createContributionService,
  resolveContributionApiBaseUrl,
} from "../src/contribution-service.js";

const API = "https://api.tokenmonster.example";
const NOW = "2026-07-15T18:00:00.000Z";
const UPLOAD_TOKEN = `tm_u1_${"u".repeat(16)}.${"U".repeat(43)}`;
const DELETE_TOKEN = `tm_d1_${"d".repeat(16)}.${"D".repeat(43)}`;
const STATUS_TOKEN = `tm_s1_${"s".repeat(16)}.${"S".repeat(43)}`;
const V2_UPLOAD_TOKEN = `tm_u2_${"u".repeat(24)}.${"U".repeat(43)}`;
const V2_DELETE_TOKEN = `tm_d2_${"d".repeat(24)}.${"D".repeat(42)}E`;
const V2_RECOVERY_TOKEN = `tm_r2_${"r".repeat(24)}.${"R".repeat(42)}I`;
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
  failClear = false;
  failGet = false;

  constructor(readonly persistence: SecretPersistence = "os-backed") {}

  private snapshot(): SecretSlotStatus {
    return Object.freeze({
      configured: this.value !== null,
      persistence: this.persistence,
      activePersistence:
        this.value !== null && this.persistence === "os-backed"
          ? "os-backed"
          : "memory-only",
      backend: this.persistence === "os-backed" ? "keychain" : "basic_text",
    });
  }

  initialize(
    _options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<SecretSlotStatus> {
    return Promise.resolve(this.snapshot());
  }

  set(
    secret: string,
    _options?: Readonly<{ persist?: boolean; signal?: AbortSignal }>,
  ): Promise<SecretSlotStatus> {
    if (this.failSet) return Promise.reject(new Error("SLOT_WRITE_FAILED"));
    this.value = secret;
    return Promise.resolve(this.snapshot());
  }

  get(): string | null {
    if (this.failGet) throw new Error("SLOT_READ_FAILED");
    return this.value;
  }

  clear(
    _options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<SecretSlotStatus> {
    if (this.failClear) return Promise.reject(new Error("SLOT_CLEAR_FAILED"));
    this.value = null;
    return Promise.resolve(this.snapshot());
  }

  status(): SecretSlotStatus {
    return this.snapshot();
  }
}

class HangingSetSlot extends TestSlot {
  observedSignal: AbortSignal | undefined;
  complete: (() => void) | undefined;

  override set(
    secret: string,
    options?: Readonly<{ persist?: boolean; signal?: AbortSignal }>,
  ): Promise<SecretSlotStatus> {
    this.observedSignal = options?.signal;
    return new Promise<SecretSlotStatus>((resolve) => {
      this.complete = () => {
        if (options?.signal?.aborted !== true) this.value = secret;
        resolve(this.status());
      };
    });
  }
}

class HangingInitializeSlot extends TestSlot {
  observedSignal: AbortSignal | undefined;
  complete: (() => void) | undefined;
  initializeCalls = 0;

  override initialize(
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<SecretSlotStatus> {
    this.initializeCalls += 1;
    this.observedSignal = options?.signal;
    return new Promise<SecretSlotStatus>((resolve) => {
      this.complete = () => resolve(this.status());
    });
  }
}

class MissingActivePersistenceSlot extends TestSlot {
  override initialize(): Promise<SecretSlotStatus> {
    const { activePersistence: _activePersistence, ...incomplete } =
      this.status();
    return Promise.resolve(incomplete as SecretSlotStatus);
  }
}

class InvalidSecretTypeSlot extends TestSlot {
  override get(): string | null {
    return 123 as unknown as string;
  }
}

class DowngradingSetSlot extends TestSlot {
  private downgraded = false;

  override set(secret: string): Promise<SecretSlotStatus> {
    this.value = secret;
    this.downgraded = true;
    return Promise.resolve(this.status());
  }

  override status(): SecretSlotStatus {
    if (!this.downgraded) return super.status();
    return Object.freeze({
      configured: true,
      persistence: "os-backed",
      activePersistence: "memory-only",
      backend: "keychain",
    });
  }
}

class StatusDowngradingSlot extends TestSlot {
  downgraded = false;

  override status(): SecretSlotStatus {
    const current = super.status();
    if (!this.downgraded || this.value === null) return current;
    return Object.freeze({
      ...current,
      activePersistence: "memory-only",
    });
  }
}

class DishonestClearSlot extends TestSlot {
  private claimedCleared = false;

  override clear(): Promise<SecretSlotStatus> {
    this.claimedCleared = true;
    return Promise.resolve(this.status());
  }

  override status(): SecretSlotStatus {
    if (!this.claimedCleared) return super.status();
    return Object.freeze({
      configured: false,
      persistence: "os-backed",
      activePersistence: "memory-only",
      backend: "keychain",
    });
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

function problem(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json; charset=UTF-8" },
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
    contractVersion: 2,
    status: "active",
    consentReceipt: {
      receiptId: RECEIPT_ID,
      purpose: "contribution",
      documentRevision: "contribution-2026-07-15",
      granted: true,
      acknowledgedAt: NOW,
      recordedAt: NOW,
    },
    acceptedSnapshotSchemaVersions: ["1", "2"],
  };
}

function pauseResponse() {
  return {
    contractVersion: 1,
    status: "paused",
    pausedAt: NOW,
    futureUploadsBlocked: true,
    identifiableCurrentDataRetained: true,
    anonymousHistoricalTotalsRetained: true,
  };
}

function resumeResponse(
  documentRevision = "contribution-2026-07-15",
  acknowledgedAt = NOW,
) {
  return {
    contractVersion: 1,
    status: "active",
    resumedAt: NOW,
    consentReceipt: {
      receiptId: RECEIPT_ID,
      purpose: "contribution",
      documentRevision,
      granted: true,
      acknowledgedAt,
      recordedAt: NOW,
    },
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
    pending?: TestSlot;
    clock?: () => Date;
    uuid?: () => string;
    configuredBaseUrl?: unknown;
  }> = {},
) {
  if (store === null) throw new Error("TEST_STORE_MISSING");
  const upload = input.upload ?? new TestSlot();
  const deletion = input.deletion ?? new TestSlot();
  const status = input.status ?? new TestSlot();
  const pending = input.pending ?? new TestSlot();
  const encodedCredentialParts = [
    "u".repeat(24),
    "U".repeat(43),
    "d".repeat(24),
    `${"D".repeat(42)}E`,
    "r".repeat(24),
    `${"R".repeat(42)}I`,
  ];
  let credentialPartIndex = 0;
  let idIndex = 0;
  const contribution = createContributionService({
    store,
    uploadCredential: upload,
    deletionCredential: deletion,
    statusCredential: status,
    pendingEnrollmentCredential: pending,
    configuredBaseUrl: Object.hasOwn(input, "configuredBaseUrl")
      ? input.configuredBaseUrl
      : API,
    allowedOrigins: [API],
    fetcher,
    clock: input.clock ?? (() => new Date(NOW)),
    uuid: input.uuid ?? (() => IDS[idIndex++] ?? IDS[IDS.length - 1]!),
    credentialBytes: (size) => {
      const encoded = encodedCredentialParts[credentialPartIndex++];
      if (encoded === undefined)
        throw new Error("TEST_CREDENTIAL_BYTES_EXHAUSTED");
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.byteLength !== size)
        throw new Error("TEST_CREDENTIAL_SIZE_DRIFT");
      return bytes;
    },
  });
  return { contribution, upload, deletion, status, pending };
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
  it("bounds a hung credential initialization and remains zero-network", async () => {
    vi.useFakeTimers();
    try {
      store = await openLocalStore({ path: ":memory:" });
      const hanging = new HangingInitializeSlot();
      const fetcher = vi.fn<typeof fetch>();
      const instance = service(fetcher, { pending: hanging });
      const initializing = instance.contribution.initialize();
      await vi.advanceTimersByTimeAsync(
        CONTRIBUTION_CREDENTIAL_OPERATION_TIMEOUT_MS,
      );
      await initializing;

      expect(hanging.observedSignal?.aborted).toBe(true);
      expect(instance.contribution.status()).toMatchObject({
        secureStorage: "unavailable",
        state: "unavailable",
        enabled: false,
        canRecover: false,
      });
      expect(fetcher).not.toHaveBeenCalled();
      hanging.complete?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it("single-flights initialization and quiesces the underlying credential operation", async () => {
    store = await openLocalStore({ path: ":memory:" });
    const hanging = new HangingInitializeSlot();
    const fetcher = vi.fn<typeof fetch>();
    const instance = service(fetcher, { pending: hanging });

    const first = instance.contribution.initialize();
    const second = instance.contribution.initialize();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(hanging.initializeCalls).toBe(1);

    let quiesced = false;
    const closing = instance.contribution.quiesce().then(() => {
      quiesced = true;
    });
    await Promise.resolve();
    expect(hanging.observedSignal?.aborted).toBe(true);
    expect(quiesced).toBe(false);

    hanging.complete?.();
    await Promise.all([first, second, closing]);
    expect(quiesced).toBe(true);
    expect(instance.contribution.status()).toMatchObject({
      secureStorage: "unavailable",
      state: "unavailable",
      enabled: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("aborts a hung credential write, releases busy, and blocks a late commit", async () => {
    vi.useFakeTimers();
    try {
      store = await openLocalStore({
        path: ":memory:",
        clock: () => new Date(NOW),
      });
      const pending = new HangingSetSlot();
      const fetcher = vi.fn<typeof fetch>(async () => json(consentDocument()));
      const instance = service(fetcher, { pending });
      await instance.contribution.initialize();
      const preview = await instance.contribution.preparePreview();
      const enabling = instance.contribution.enable(preview.previewId);
      await vi.advanceTimersByTimeAsync(
        CONTRIBUTION_CREDENTIAL_OPERATION_TIMEOUT_MS,
      );

      await expect(enabling).resolves.toMatchObject({
        ok: false,
        code: "secure-storage-failed",
        status: {
          secureStorage: "unavailable",
          state: "unavailable",
          enabled: false,
          canRecover: false,
        },
      });
      expect(pending.observedSignal?.aborted).toBe(true);
      expect(pending.value).toBeNull();
      await expect(instance.contribution.recover()).resolves.toMatchObject({
        ok: false,
        code: "secure-storage-unavailable",
      });
      pending.complete?.();
      await Promise.resolve();
      expect(pending.value).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("quiesces a timed-out credential write only after its host operation settles", async () => {
    vi.useFakeTimers();
    try {
      store = await openLocalStore({
        path: ":memory:",
        clock: () => new Date(NOW),
      });
      const pending = new HangingSetSlot();
      const fetcher = vi.fn<typeof fetch>(async () => json(consentDocument()));
      const instance = service(fetcher, { pending });
      await instance.contribution.initialize();
      const preview = await instance.contribution.preparePreview();
      const enabling = instance.contribution.enable(preview.previewId);
      await vi.advanceTimersByTimeAsync(
        CONTRIBUTION_CREDENTIAL_OPERATION_TIMEOUT_MS,
      );
      await expect(enabling).resolves.toMatchObject({
        ok: false,
        code: "secure-storage-failed",
      });

      let quiesced = false;
      const closing = instance.contribution.quiesce().then(() => {
        quiesced = true;
      });
      await Promise.resolve();
      expect(pending.observedSignal?.aborted).toBe(true);
      expect(quiesced).toBe(false);
      expect(pending.value).toBeNull();

      pending.complete?.();
      await closing;
      expect(quiesced).toBe(true);
      expect(pending.value).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed for missing/non-HTTPS/non-allowlisted API configuration", () => {
    expect(resolveContributionApiBaseUrl(undefined, [API])).toBeNull();
    expect(
      resolveContributionApiBaseUrl("http://api.tokenmonster.example", [API]),
    ).toBeNull();
    expect(
      resolveContributionApiBaseUrl("https://attacker.example", [API]),
    ).toBeNull();
    expect(resolveContributionApiBaseUrl(`${API}/v1`, [API])).toBeNull();
    expect(
      resolveContributionApiBaseUrl(`${API}?next=https://attacker.example`, [
        API,
      ]),
    ).toBeNull();
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

  it.each([
    ["incomplete snapshot", () => new MissingActivePersistenceSlot()],
    ["non-string secret", () => new InvalidSecretTypeSlot()],
  ])(
    "rejects a native initialization with %s before network",
    async (_case, slot) => {
      store = await openLocalStore({ path: ":memory:" });
      const fetcher = vi.fn<typeof fetch>();
      const instance = service(fetcher, {
        pending: slot(),
      });

      await instance.contribution.initialize();

      expect(instance.contribution.status()).toMatchObject({
        secureStorage: "unavailable",
        state: "unavailable",
        enabled: false,
        canEnable: false,
        canRecover: false,
      });
      await expect(instance.contribution.preparePreview()).rejects.toThrow(
        "secure-storage-unavailable",
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("hard-pauses when a credential getter becomes unavailable", async () => {
    store = await openLocalStore({ path: ":memory:" });
    const pending = new TestSlot();
    const fetcher = vi.fn<typeof fetch>();
    const instance = service(fetcher, { pending });
    await instance.contribution.initialize();

    pending.failGet = true;
    expect(instance.contribution.status()).toMatchObject({
      secureStorage: "unavailable",
      state: "unavailable",
      enabled: false,
      canRecover: false,
    });
    await expect(instance.contribution.recover()).resolves.toMatchObject({
      ok: false,
      code: "secure-storage-unavailable",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fences an in-flight sync when a credential getter fails before ingest", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    store.upsertDailyAggregate(aggregate("2026-07-14T00:00:00.000Z"));
    completeDay(store, "2026-07-14");
    const consentStarted = deferred<void>();
    const consentResponse = deferred<Response>();
    const paths: string[] = [];
    const observed: { signal: AbortSignal | null } = { signal: null };
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path !== "/v1/consent-documents/current") {
        throw new Error("UNEXPECTED_REQUEST");
      }
      observed.signal = request.signal;
      consentStarted.resolve();
      return consentResponse.promise;
    });
    const pending = new TestSlot();
    const instance = service(fetcher, {
      ...activeCredentialSlots(),
      pending,
    });
    await instance.contribution.initialize();

    const syncing = instance.contribution.sync();
    await consentStarted.promise;
    pending.failGet = true;
    expect(instance.contribution.status()).toMatchObject({
      secureStorage: "unavailable",
      state: "unavailable",
      enabled: false,
    });
    expect(observed.signal?.aborted).toBe(true);
    consentResponse.resolve(json(consentDocument()));

    await expect(syncing).resolves.toMatchObject({
      ok: false,
      code: "secure-storage-unavailable",
      uploadedBatches: 0,
      status: {
        secureStorage: "unavailable",
        state: "unavailable",
        enabled: false,
      },
    });
    expect(paths).toEqual(["/v1/consent-documents/current"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("blocks sync when an active credential status downgrades after initialization", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    store.upsertDailyAggregate(aggregate("2026-07-14T00:00:00.000Z"));
    completeDay(store, "2026-07-14");
    const active = activeCredentialSlots();
    const upload = new StatusDowngradingSlot();
    upload.value = active.upload.value;
    const fetcher = vi.fn<typeof fetch>();
    const instance = service(fetcher, {
      upload,
      deletion: active.deletion,
    });
    await instance.contribution.initialize();
    expect(instance.contribution.status()).toMatchObject({
      secureStorage: "os-backed",
      state: "active",
      enabled: true,
    });

    upload.downgraded = true;
    expect(instance.contribution.status()).toMatchObject({
      secureStorage: "unavailable",
      state: "unavailable",
      enabled: false,
    });
    await expect(instance.contribution.sync()).resolves.toMatchObject({
      ok: false,
      code: "secure-storage-unavailable",
      uploadedBatches: 0,
      status: {
        secureStorage: "unavailable",
        state: "unavailable",
        enabled: false,
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("hard-pauses when a credential write silently downgrades to RAM", async () => {
    store = await openLocalStore({ path: ":memory:" });
    const pending = new DowngradingSetSlot();
    const fetcher = vi.fn<typeof fetch>(async () => json(consentDocument()));
    const instance = service(fetcher, { pending });
    await instance.contribution.initialize();
    const preview = await instance.contribution.preparePreview();

    await expect(
      instance.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({
      ok: false,
      code: "secure-storage-failed",
      status: {
        secureStorage: "unavailable",
        state: "unavailable",
        enabled: false,
        canRecover: false,
      },
    });
    await expect(instance.contribution.recover()).resolves.toMatchObject({
      ok: false,
      code: "secure-storage-unavailable",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).pathname).toBe(
      "/v1/consent-documents/current",
    );
    expect(store.getDiagnosticSummary().counts.cloudOutboxEntries).toBe(0);
  });

  it("does not delete remotely when a credential clear lies about completion", async () => {
    store = await openLocalStore({ path: ":memory:" });
    const upload = new DishonestClearSlot();
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

    await expect(
      instance.contribution.requestDeletion(),
    ).resolves.toMatchObject({
      ok: false,
      code: "secure-storage-failed",
      status: {
        secureStorage: "unavailable",
        state: "unavailable",
        enabled: false,
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.getDiagnosticSummary().counts.cloudOutboxEntries).toBe(0);
  });

  it("fails closed when the atomic pending-enrollment slot is not OS-backed", async () => {
    store = await openLocalStore({ path: ":memory:" });
    const fetcher = vi.fn<typeof fetch>();
    const instance = service(fetcher, {
      pending: new TestSlot("memory-only"),
    });
    await instance.contribution.initialize();

    expect(instance.contribution.status()).toMatchObject({
      secureStorage: "unavailable",
      state: "unavailable",
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
    await expect(
      instance.contribution.requestDeletion(),
    ).resolves.toMatchObject({
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

  it("fails upload closed without stranding an independent deletion credential", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const upload = new TestSlot();
    const deletion = new TestSlot();
    upload.value = "{malformed-upload-credential";
    deletion.value = JSON.stringify({
      schemaVersion: 1,
      kind: "deletion",
      token: DELETE_TOKEN,
      idempotencyKey: IDS[4],
    });
    const requests: Request[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      if (request.url.endsWith("/v1/me/data")) {
        return json(deletionAccepted(), 202);
      }
      throw new Error("UNEXPECTED_REQUEST");
    });
    const instance = service(fetcher, { upload, deletion });
    await instance.contribution.initialize();

    expect(instance.contribution.status()).toMatchObject({
      state: "stopped",
      enabled: false,
      canEnable: false,
      canDelete: true,
    });
    await expect(instance.contribution.sync()).resolves.toMatchObject({
      ok: false,
      code: "not-enabled",
    });
    await expect(
      instance.contribution.requestDeletion(),
    ).resolves.toMatchObject({
      ok: true,
      code: "deletion-requested",
      status: { state: "deletion-pending", canDelete: false },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("Authorization")).toBe(
      `Bearer ${DELETE_TOKEN}`,
    );
    expect(instance.upload.value).toBeNull();
    expect(instance.deletion.value).toBeNull();
    expect(instance.status.value).toContain(STATUS_TOKEN);
  });

  it("does no network work when an active contributor has no due payload", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
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
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
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

  it("stops on stale consent, drops unseen queue entries, and resumes only with the new receipt", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    store.upsertDailyAggregate(aggregate("2026-07-14T00:00:00.000Z"));
    completeDay(store, "2026-07-14");
    const paths: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/v1/consent-documents/current") {
        return json({
          ...consentDocument(),
          revision: "contribution-2026-07-16",
        });
      }
      if (path === "/v1/me/pause") return json(pauseResponse());
      if (path === "/v1/me/resume") {
        return json(resumeResponse("contribution-2026-07-16"));
      }
      throw new Error("UNEXPECTED_REQUEST");
    });
    const instance = service(fetcher, activeCredentialSlots());
    await instance.contribution.initialize();

    await expect(instance.contribution.sync()).resolves.toMatchObject({
      ok: false,
      code: "consent-stale",
      uploadedBatches: 0,
      status: {
        state: "stopped",
        enabled: false,
        canEnable: true,
        outboxPending: 0,
      },
    });
    expect(store.getDiagnosticSummary().counts.cloudOutboxEntries).toBe(0);
    expect(instance.upload.value).toContain('"lifecycle":"pause-pending"');

    const preview = await instance.contribution.preparePreview();
    await expect(
      instance.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({
      ok: true,
      code: "resumed",
      status: {
        state: "active",
        enabled: true,
        consentDocumentRevision: "contribution-2026-07-16",
        outboxPending: 1,
      },
    });
    expect(paths).toEqual([
      "/v1/consent-documents/current",
      "/v1/me/pause",
      "/v1/consent-documents/current",
      "/v1/me/pause",
      "/v1/me/resume",
    ]);
  });

  it("stops when ingest rejects consent after a matching consent read", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    store.upsertDailyAggregate(aggregate("2026-07-14T00:00:00.000Z"));
    completeDay(store, "2026-07-14");
    const paths: string[] = [];
    let consentReads = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/v1/consent-documents/current") {
        consentReads += 1;
        return json({
          ...consentDocument(),
          revision:
            consentReads === 1
              ? "contribution-2026-07-15"
              : "contribution-2026-07-16",
        });
      }
      if (path === "/v1/me/ingest-snapshots") {
        return problem(
          {
            type: "about:blank",
            title: "Current consent required",
            status: 403,
            detail:
              "The current contribution consent document must be acknowledged.",
            code: "CONSENT_REQUIRED",
            requestId: "request_12345678",
          },
          403,
        );
      }
      if (path === "/v1/me/pause") return json(pauseResponse());
      if (path === "/v1/me/resume") {
        return json(resumeResponse("contribution-2026-07-16"));
      }
      throw new Error("UNEXPECTED_REQUEST");
    });
    const instance = service(fetcher, activeCredentialSlots());
    await instance.contribution.initialize();

    await expect(instance.contribution.sync()).resolves.toMatchObject({
      ok: false,
      code: "consent-stale",
      uploadedBatches: 0,
      status: {
        state: "stopped",
        enabled: false,
        canEnable: true,
        outboxPending: 0,
      },
    });
    expect(store.getDiagnosticSummary().counts.cloudOutboxEntries).toBe(0);
    expect(instance.upload.value).toContain('"lifecycle":"pause-pending"');

    await expect(instance.contribution.sync()).resolves.toMatchObject({
      ok: false,
      code: "not-enabled",
      uploadedBatches: 0,
    });
    await expect(instance.contribution.enable(IDS[0])).resolves.toMatchObject({
      ok: false,
      code: "preview-expired",
    });
    expect(paths).toEqual([
      "/v1/consent-documents/current",
      "/v1/me/ingest-snapshots",
      "/v1/me/pause",
    ]);

    const preview = await instance.contribution.preparePreview();
    await expect(
      instance.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({
      ok: true,
      code: "resumed",
      status: {
        state: "active",
        enabled: true,
        consentDocumentRevision: "contribution-2026-07-16",
        outboxPending: 1,
      },
    });
    expect(paths).toEqual([
      "/v1/consent-documents/current",
      "/v1/me/ingest-snapshots",
      "/v1/me/pause",
      "/v1/consent-documents/current",
      "/v1/me/pause",
      "/v1/me/resume",
    ]);
  });

  it("aborts an in-flight background upload before hard local stop completes", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    store.upsertDailyAggregate(aggregate("2026-07-14T00:00:00.000Z"));
    completeDay(store, "2026-07-14");
    const ingestStarted = deferred<void>();
    const observed: { signal: AbortSignal | null } = { signal: null };
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("consent-documents")) {
        return json(consentDocument());
      }
      if (request.url.endsWith("/v1/me/pause")) {
        return json(pauseResponse());
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
    expect(instance.upload.value).toContain('"lifecycle":"paused"');
    expect(instance.upload.value).toContain(UPLOAD_TOKEN);
    expect(instance.deletion.value).toContain(DELETE_TOKEN);
  });

  it("aborts an in-flight upload and removes upload authority before cloud deletion", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    store.upsertDailyAggregate(aggregate("2026-07-14T00:00:00.000Z"));
    completeDay(store, "2026-07-14");
    const ingestStarted = deferred<void>();
    const observed: { signal: AbortSignal | null } = { signal: null };
    const paths: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      paths.push(new URL(request.url).pathname);
      if (request.url.includes("consent-documents")) {
        return json(consentDocument());
      }
      if (request.url.endsWith("/v1/me/data")) {
        expect(instance.upload.value).toBeNull();
        return json(deletionAccepted(), 202);
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
    const deleting = instance.contribution.requestDeletion();
    const [syncResult, deletionResult] = await Promise.all([syncing, deleting]);

    expect(observed.signal?.aborted).toBe(true);
    expect(syncResult).toMatchObject({ ok: false, uploadedBatches: 0 });
    expect(deletionResult).toMatchObject({
      ok: true,
      code: "deletion-requested",
      status: {
        state: "deletion-pending",
        enabled: false,
        canEnable: false,
        canDelete: false,
        canRecover: true,
        outboxPending: 0,
      },
    });
    expect(paths.at(-1)).toBe("/v1/me/data");
    expect(instance.upload.value).toBeNull();
    expect(instance.deletion.value).toBeNull();
  });

  it.each(["stop", "delete"] as const)(
    "rejects a queued %s operation before quiesce releases the local store",
    async (action) => {
      store = await openLocalStore({
        path: ":memory:",
        clock: () => new Date(NOW),
      });
      store.upsertDailyAggregate(aggregate("2026-07-14T00:00:00.000Z"));
      completeDay(store, "2026-07-14");
      const ingestStarted = deferred<void>();
      const paths: string[] = [];
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        paths.push(new URL(request.url).pathname);
        if (request.url.includes("consent-documents")) {
          return json(consentDocument());
        }
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
      const queued =
        action === "stop"
          ? instance.contribution.stop()
          : instance.contribution.requestDeletion();

      await instance.contribution.quiesce();
      store.close();
      store = null;
      await expect(queued).resolves.toMatchObject({
        ok: false,
        code: "local-service-error",
      });
      await expect(syncing).resolves.toMatchObject({ ok: false });
      expect(paths).not.toContain("/v1/me/pause");
      expect(paths).not.toContain("/v1/me/data");
    },
  );

  it("resumes the same enrollment only after a fresh preview and affirmative consent", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const requests: Request[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      if (request.url.endsWith("/v1/me/pause")) return json(pauseResponse());
      if (request.url.includes("consent-documents"))
        return json(consentDocument());
      if (request.url.endsWith("/v1/me/resume")) return json(resumeResponse());
      throw new Error("UNEXPECTED_REQUEST");
    });
    const first = service(fetcher, activeCredentialSlots());
    await first.contribution.initialize();

    await expect(first.contribution.stop()).resolves.toMatchObject({
      ok: true,
      code: "stopped",
      status: { state: "stopped", enabled: false, canEnable: true },
    });
    expect(first.upload.value).toContain('"lifecycle":"paused"');

    const restarted = service(fetcher, {
      upload: first.upload,
      deletion: first.deletion,
      status: first.status,
    });
    await restarted.contribution.initialize();
    expect(restarted.contribution.status()).toMatchObject({
      state: "stopped",
      enabled: false,
      canEnable: true,
    });
    await expect(restarted.contribution.enable(IDS[0])).resolves.toMatchObject({
      ok: false,
      code: "preview-expired",
      status: { state: "stopped" },
    });

    const preview = await restarted.contribution.preparePreview();
    const resumed = await restarted.contribution.enable(preview.previewId);
    expect(resumed).toMatchObject({
      ok: true,
      code: "resumed",
      status: { state: "active", enabled: true },
    });
    expect(restarted.upload.value).toContain('"lifecycle":"active"');
    expect(restarted.upload.value).toContain(UPLOAD_TOKEN);
    expect(restarted.deletion.value).toBe(first.deletion.value);

    const pause = requests.find((request) =>
      request.url.endsWith("/v1/me/pause"),
    );
    const resume = requests.find((request) =>
      request.url.endsWith("/v1/me/resume"),
    );
    expect(pause?.headers.get("Authorization")).toBe(`Bearer ${UPLOAD_TOKEN}`);
    expect(await pause?.text()).toBe("");
    expect(resume?.headers.get("Authorization")).toBe(`Bearer ${UPLOAD_TOKEN}`);
    expect(await resume?.json()).toEqual({
      contractVersion: 1,
      consent: {
        purpose: "contribution",
        documentRevision: "contribution-2026-07-15",
        granted: true,
        acknowledgedAt: NOW,
      },
    });
    expect(
      requests.some((request) => request.url.endsWith("/v2/enrollments")),
    ).toBe(false);
  });

  it("rejects a resume receipt that does not echo the exact acknowledgement instant", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/me/pause")) return json(pauseResponse());
      if (url.includes("consent-documents")) return json(consentDocument());
      if (url.endsWith("/v1/me/resume")) {
        return json(
          resumeResponse("contribution-2026-07-15", "2026-07-15T18:00:00.001Z"),
        );
      }
      throw new Error("UNEXPECTED_REQUEST");
    });
    const instance = service(fetcher, activeCredentialSlots());
    await instance.contribution.initialize();
    await instance.contribution.stop();
    const preview = await instance.contribution.preparePreview();

    await expect(
      instance.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({
      ok: false,
      code: "contract-mismatch",
      status: { state: "stopped", enabled: false },
    });
    expect(instance.upload.value).toContain('"lifecycle":"resume-pending"');
  });

  it("requires stopped queue cleanup before preview/resume and enqueues only the freshly previewed batch", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    store.upsertDailyAggregate(aggregate("2026-07-14T00:00:00.000Z"));
    completeDay(store, "2026-07-14");
    const oldSnapshot: IngestSnapshotV1 = {
      schemaVersion: "1",
      batchId: IDS[4],
      generatedAt: "2026-07-14T12:00:00.000Z",
      collector: {
        kind: "tokscale",
        adapterVersion: "0.1.0",
        sourceVersion: "4.5.2",
      },
      buckets: [
        {
          bucketStart: "2026-07-13T00:00:00.000Z",
          provider: "openai",
          modelFamily: "old-unpreviewed",
          tool: "codex-cli",
          valueQuality: "exact",
          revision: 1,
          tokens: TOKENS,
        },
      ],
    };
    store.enqueueCloudSnapshot(oldSnapshot, {
      nextAttemptAt: NOW,
      expiresAt: "2026-08-12T00:00:00.000Z",
    });
    const originalClearOutbox = store.clearCloudOutbox.bind(store);
    let failCleanup = true;
    const clearOutbox = vi
      .spyOn(store, "clearCloudOutbox")
      .mockImplementation(() => {
        if (failCleanup) throw new Error("OUTBOX_CLEAR_FAILED");
        return originalClearOutbox();
      });
    const paths: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/v1/me/pause") return json(pauseResponse());
      if (path === "/v1/consent-documents/current") {
        return json(consentDocument());
      }
      if (path === "/v1/me/resume") return json(resumeResponse());
      throw new Error("UNEXPECTED_REQUEST");
    });
    const instance = service(fetcher, activeCredentialSlots());
    await instance.contribution.initialize();

    await expect(instance.contribution.stop()).resolves.toMatchObject({
      ok: true,
      code: "stopped",
      status: { state: "stopped", outboxPending: 1 },
    });
    await expect(instance.contribution.preparePreview()).rejects.toThrow(
      "local-service-error",
    );
    expect(paths).toEqual(["/v1/me/pause"]);
    expect(store.getDiagnosticSummary().counts.cloudOutboxEntries).toBe(1);

    failCleanup = false;
    const preview = await instance.contribution.preparePreview();
    expect(preview.payload).not.toBeNull();
    const previewBatchId = preview.payload!.batchId;
    expect(previewBatchId).not.toBe(oldSnapshot.batchId);
    await expect(
      instance.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({
      ok: true,
      code: "resumed",
      status: { state: "active", outboxPending: 1 },
    });
    const queued = store.listDueCloudSnapshots({ now: NOW, limit: 10 });
    expect(queued.map((entry) => entry.snapshot.batchId)).toEqual([
      previewBatchId,
    ]);
    expect(paths).toEqual([
      "/v1/me/pause",
      "/v1/consent-documents/current",
      "/v1/me/resume",
    ]);
    clearOutbox.mockRestore();
  });

  it("stays locally stopped across a lost pause response and confirms pause before resume", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const paths: string[] = [];
    let pauseAttempts = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      paths.push(new URL(request.url).pathname);
      if (request.url.endsWith("/v1/me/pause")) {
        pauseAttempts += 1;
        if (pauseAttempts === 1) throw new TypeError("PAUSE_RESPONSE_LOST");
        return json(pauseResponse());
      }
      if (request.url.includes("consent-documents"))
        return json(consentDocument());
      if (request.url.endsWith("/v1/me/resume")) return json(resumeResponse());
      throw new Error("UNEXPECTED_REQUEST");
    });
    const first = service(fetcher, activeCredentialSlots());
    await first.contribution.initialize();

    await expect(first.contribution.stop()).resolves.toMatchObject({
      ok: true,
      code: "pause-pending",
      status: { state: "stopped", enabled: false, outboxPending: 0 },
    });
    expect(first.upload.value).toContain('"lifecycle":"pause-pending"');
    await expect(first.contribution.sync()).resolves.toMatchObject({
      ok: false,
      code: "not-enabled",
    });

    const restarted = service(fetcher, {
      upload: first.upload,
      deletion: first.deletion,
      status: first.status,
    });
    await restarted.contribution.initialize();
    const preview = await restarted.contribution.preparePreview();
    await expect(
      restarted.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({
      ok: true,
      code: "resumed",
      status: { state: "active" },
    });
    expect(paths.filter((path) => path === "/v1/me/pause")).toHaveLength(2);
    expect(paths).toContain("/v1/me/resume");
    expect(paths).not.toContain("/v2/enrollments");
  });

  it("retries resume with the same preview after a lost response without re-enrolling", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    let resumeAttempts = 0;
    let remoteState: "active" | "paused" = "active";
    const paths: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      paths.push(new URL(request.url).pathname);
      if (request.url.endsWith("/v1/me/pause")) {
        remoteState = "paused";
        return json(pauseResponse());
      }
      if (request.url.includes("consent-documents"))
        return json(consentDocument());
      if (request.url.endsWith("/v1/me/resume")) {
        resumeAttempts += 1;
        remoteState = "active";
        if (resumeAttempts === 1) throw new TypeError("RESUME_RESPONSE_LOST");
        return json(resumeResponse());
      }
      throw new Error("UNEXPECTED_REQUEST");
    });
    const instance = service(fetcher, activeCredentialSlots());
    await instance.contribution.initialize();
    await instance.contribution.stop();
    const preview = await instance.contribution.preparePreview();

    await expect(
      instance.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({
      ok: false,
      code: "network-error",
      status: { state: "stopped", enabled: false },
    });
    expect(remoteState).toBe("active");
    expect(instance.upload.value).toContain('"lifecycle":"resume-pending"');
    await expect(
      instance.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({
      ok: true,
      code: "resumed",
      status: { state: "active", enabled: true },
    });
    expect(remoteState).toBe("active");
    expect(paths.filter((path) => path === "/v1/me/resume")).toHaveLength(2);
    expect(paths.filter((path) => path === "/v1/me/pause")).toHaveLength(2);
    expect(paths).not.toContain("/v2/enrollments");
  });

  it("reconciles a response-lost resume to remote pause after restart and stop", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    let remoteState: "active" | "paused" = "active";
    let loseResumeResponse = true;
    const paths: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      paths.push(new URL(request.url).pathname);
      if (request.url.endsWith("/v1/me/pause")) {
        remoteState = "paused";
        return json(pauseResponse());
      }
      if (request.url.includes("consent-documents"))
        return json(consentDocument());
      if (request.url.endsWith("/v1/me/resume")) {
        remoteState = "active";
        if (loseResumeResponse) {
          loseResumeResponse = false;
          throw new TypeError("RESPONSE_LOST_AFTER_REMOTE_RESUME");
        }
        return json(resumeResponse());
      }
      throw new Error("UNEXPECTED_REQUEST");
    });
    const first = service(fetcher, activeCredentialSlots());
    await first.contribution.initialize();
    await first.contribution.stop();
    const preview = await first.contribution.preparePreview();
    await expect(
      first.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({
      ok: false,
      code: "network-error",
      status: { state: "stopped", enabled: false },
    });
    expect(remoteState).toBe("active");
    expect(first.upload.value).toContain('"lifecycle":"resume-pending"');

    const restarted = service(fetcher, {
      upload: first.upload,
      deletion: first.deletion,
      status: first.status,
    });
    await restarted.contribution.initialize();
    await expect(restarted.contribution.stop()).resolves.toMatchObject({
      ok: true,
      code: "stopped",
      status: { state: "stopped", enabled: false },
    });
    expect(remoteState).toBe("paused");
    expect(restarted.upload.value).toContain('"lifecycle":"paused"');
    expect(paths.filter((path) => path === "/v1/me/pause")).toHaveLength(2);
    expect(paths.filter((path) => path === "/v1/me/resume")).toHaveLength(1);
  });

  it("previews only closed, four-client-complete UTC days and applies the exact 30-day boundary", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    store.upsertDailyAggregate(aggregate("2026-06-15T00:00:00.000Z"));
    store.upsertDailyAggregate(
      aggregate("2026-06-16T00:00:00.000Z", { tool: "claude-code" }),
    );
    store.upsertDailyAggregate(
      aggregate("2026-07-14T00:00:00.000Z", { tool: "gemini-cli" }),
    );
    store.upsertDailyAggregate(
      aggregate("2026-07-15T00:00:00.000Z", { tool: "grok-build" }),
    );
    for (const date of [
      "2026-06-15",
      "2026-06-16",
      "2026-07-14",
      "2026-07-15",
    ]) {
      completeDay(store, date);
    }
    const fetcher = vi.fn<typeof fetch>(async () => json(consentDocument()));
    const instance = service(fetcher);
    await instance.contribution.initialize();

    const preview = await instance.contribution.preparePreview();
    expect(
      preview.payload?.buckets.map(({ bucketStart }) => bucketStart),
    ).toEqual(["2026-06-16T00:00:00.000Z", "2026-07-14T00:00:00.000Z"]);
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
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
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
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(now),
    });
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
        String(input).endsWith("/v2/enrollments"),
      ),
    ).toBe(false);
  });

  it("uses one exact safe-text contract for consent title, summary, and retention disclosure", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    let document = consentDocument();
    const fetcher = vi.fn<typeof fetch>(async () => json(document));
    const instance = service(fetcher);
    await instance.contribution.initialize();

    for (const disclosureLength of [2_049, 4_000]) {
      document = {
        ...consentDocument(),
        title: "T".repeat(200),
        summary: "S".repeat(2_000),
        retention: {
          ...consentDocument().retention,
          disclosure: "R".repeat(disclosureLength),
        },
      };
      await expect(
        instance.contribution.preparePreview(),
      ).resolves.toMatchObject({
        document: {
          title: "T".repeat(200),
          summary: "S".repeat(2_000),
          retentionDisclosure: "R".repeat(disclosureLength),
        },
      });
    }

    for (const invalidDocument of [
      { ...consentDocument(), title: "T".repeat(201) },
      { ...consentDocument(), summary: "S".repeat(2_001) },
      {
        ...consentDocument(),
        retention: {
          ...consentDocument().retention,
          disclosure: "R".repeat(4_001),
        },
      },
      { ...consentDocument(), title: "unsafe\u0000title" },
      { ...consentDocument(), summary: "unsafe\u001fsummary" },
      {
        ...consentDocument(),
        retention: {
          ...consentDocument().retention,
          disclosure: "unsafe\u007fdisclosure",
        },
      },
    ]) {
      document = invalidDocument;
      await expect(instance.contribution.preparePreview()).rejects.toThrow(
        "contract-mismatch",
      );
    }
  });

  it("enrolls after exact preview, separates scoped secrets, and sends one idempotent snapshot", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    store.upsertDailyAggregate(aggregate("2026-07-14T00:00:00.000Z"));
    completeDay(store, "2026-07-14");
    const calls: Request[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      calls.push(request.clone());
      if (request.url.includes("consent-documents"))
        return json(consentDocument());
      if (request.url.endsWith("/v2/enrollments"))
        return json(enrollmentResponse(), 201);
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
    expect(instance.upload.value).toContain(V2_UPLOAD_TOKEN);
    expect(instance.upload.value).not.toContain(V2_DELETE_TOKEN);
    expect(instance.deletion.value).toContain('"kind":"deletion"');
    expect(instance.deletion.value).toContain(V2_DELETE_TOKEN);
    expect(instance.deletion.value).not.toContain(V2_UPLOAD_TOKEN);
    expect(instance.pending.value).toBeNull();
    expect(JSON.stringify(instance.contribution.status())).not.toContain("tm_");

    const synced = await instance.contribution.sync();
    expect(synced).toMatchObject({
      ok: true,
      code: "uploaded",
      uploadedBatches: 1,
    });
    const ingest = calls.find((request) =>
      request.url.endsWith("/v1/me/ingest-snapshots"),
    );
    expect(ingest?.headers.get("Authorization")).toBe(
      `Bearer ${V2_UPLOAD_TOKEN}`,
    );
    const wire = (await ingest?.clone().json()) as IngestSnapshotV1;
    expect(ingest?.headers.get("Idempotency-Key")).toBe(wire.batchId);
    expect(store.getDiagnosticSummary().counts.cloudOutboxEntries).toBe(0);
    expect(store.getDiagnosticSummary().counts.cloudMirrorEntries).toBe(1);
  });

  it("retains one complete pending bundle when the first active-slot write fails", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const upload = new TestSlot();
    upload.failSet = true;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(consentDocument()))
      .mockResolvedValueOnce(json(enrollmentResponse(), 201));
    const instance = service(fetcher, { upload });
    await instance.contribution.initialize();
    const preview = await instance.contribution.preparePreview();
    const result = await instance.contribution.enable(preview.previewId);

    expect(result).toMatchObject({
      ok: false,
      code: "secure-storage-failed",
      status: { enabled: false, canEnable: false },
    });
    expect(instance.upload.value).toBeNull();
    expect(instance.deletion.value).toBeNull();
    expect(instance.status.value).toBeNull();
    expect(instance.pending.value).toContain(V2_UPLOAD_TOKEN);
    expect(instance.pending.value).toContain(V2_DELETE_TOKEN);
    expect(instance.pending.value).toContain(V2_RECOVERY_TOKEN);
    expect(fetcher).toHaveBeenCalledTimes(2);

    upload.failSet = false;
    const restarted = service(
      vi.fn<typeof fetch>(async () => json(enrollmentResponse(), 201)),
      {
        upload,
        deletion: instance.deletion,
        status: instance.status,
        pending: instance.pending,
      },
    );
    await restarted.contribution.initialize();
    expect(restarted.contribution.status()).toMatchObject({
      state: "active",
      enabled: true,
    });
    expect(restarted.pending.value).toBeNull();
  });

  it("retries the byte-identical pending enrollment after response loss and restart", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const bodies: string[] = [];
    const firstFetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("consent-documents"))
        return json(consentDocument());
      bodies.push(await request.text());
      throw new TypeError("ENROLLMENT_RESPONSE_LOST");
    });
    const first = service(firstFetcher);
    await first.contribution.initialize();
    const preview = await first.contribution.preparePreview();
    await expect(
      first.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({
      ok: false,
      code: "network-error",
      status: { state: "unavailable", enabled: false, canEnable: false },
    });
    expect(first.pending.value).toContain(V2_RECOVERY_TOKEN);
    expect(first.upload.value).toBeNull();
    expect(first.deletion.value).toBeNull();

    const replayFetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      bodies.push(await request.text());
      return json(enrollmentResponse(), 201);
    });
    const restarted = service(replayFetcher, {
      upload: first.upload,
      deletion: first.deletion,
      status: first.status,
      pending: first.pending,
    });
    await restarted.contribution.initialize();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(restarted.contribution.status()).toMatchObject({
      state: "active",
      enabled: true,
    });
    expect(restarted.pending.value).toBeNull();
  });

  it("explicitly recovers a durable ambiguous enrollment without creating new credentials", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const enrollmentBodies: string[] = [];
    let enrollmentAttempts = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("consent-documents")) {
        return json(consentDocument());
      }
      enrollmentBodies.push(await request.text());
      enrollmentAttempts += 1;
      if (enrollmentAttempts === 1) {
        throw new TypeError("ENROLLMENT_RESPONSE_LOST");
      }
      return json(enrollmentResponse(), 201);
    });
    const instance = service(fetcher);
    await instance.contribution.initialize();
    const preview = await instance.contribution.preparePreview();

    await expect(
      instance.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({
      ok: false,
      code: "network-error",
      status: { state: "unavailable", enabled: false },
    });
    const pendingBeforeRecovery = instance.pending.value;
    expect(instance.contribution.status().canRecover).toBe(true);

    await expect(instance.contribution.recover()).resolves.toMatchObject({
      ok: true,
      code: "enabled",
      status: { state: "active", enabled: true },
    });
    expect(enrollmentBodies).toHaveLength(2);
    expect(enrollmentBodies[1]).toBe(enrollmentBodies[0]);
    expect(pendingBeforeRecovery).toContain(V2_RECOVERY_TOKEN);
    expect(instance.pending.value).toBeNull();
    expect(instance.contribution.status().canRecover).toBe(false);
  });

  it("does not advertise recovery for a malformed pending authority", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const pending = new TestSlot();
    pending.value = "{malformed-pending-authority";
    const fetcher = vi.fn<typeof fetch>();
    const instance = service(fetcher, { pending });

    await instance.contribution.initialize();
    expect(instance.contribution.status()).toMatchObject({
      state: "unavailable",
      canRecover: false,
    });
    await expect(instance.contribution.recover()).resolves.toMatchObject({
      ok: false,
      code: "local-service-error",
      status: { canRecover: false },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("clears an expired no-record pending attempt and requires a new preview", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const firstFetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("consent-documents"))
        return json(consentDocument());
      throw new TypeError("AMBIGUOUS_FIRST_ATTEMPT");
    });
    const first = service(firstFetcher);
    await first.contribution.initialize();
    const preview = await first.contribution.preparePreview();
    await first.contribution.enable(preview.previewId);
    expect(first.pending.value).toContain(V2_RECOVERY_TOKEN);

    const paths: string[] = [];
    const definitive = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/v2/enrollments") {
        return problem(
          {
            type: "about:blank",
            title: "Consent acknowledgement expired",
            status: 400,
            detail:
              "A fresh contribution preview and acknowledgement are required.",
            code: "ACKNOWLEDGEMENT_EXPIRED",
            requestId: "request_AAAAAAAAAAAAAAAA",
          },
          400,
        );
      }
      return json(consentDocument());
    });
    const restarted = service(definitive, {
      upload: first.upload,
      deletion: first.deletion,
      status: first.status,
      pending: first.pending,
    });
    await restarted.contribution.initialize();
    expect(restarted.pending.value).toBeNull();
    expect(restarted.contribution.status()).toMatchObject({
      state: "off",
      enabled: false,
      canEnable: true,
    });
    expect(paths).toEqual(["/v2/enrollments"]);

    await restarted.contribution.preparePreview();
    expect(paths).toEqual(["/v2/enrollments", "/v1/consent-documents/current"]);
  });

  it("clears a definitive first-attempt rejection without requiring restart", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const paths: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/v2/enrollments") {
        return problem(
          {
            type: "about:blank",
            title: "Consent acknowledgement expired",
            status: 400,
            detail:
              "A fresh contribution preview and acknowledgement are required.",
            code: "ACKNOWLEDGEMENT_EXPIRED",
            requestId: "request_AAAAAAAAAAAAAAAA",
          },
          400,
        );
      }
      return json(consentDocument());
    });
    const instance = service(fetcher);
    await instance.contribution.initialize();
    const preview = await instance.contribution.preparePreview();

    await expect(
      instance.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({
      ok: false,
      code: "consent-stale",
      status: { state: "off", enabled: false, canEnable: true },
    });
    expect(instance.pending.value).toBeNull();
    await expect(
      instance.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({ ok: false, code: "preview-expired" });

    await instance.contribution.preparePreview();
    expect(paths).toEqual([
      "/v1/consent-documents/current",
      "/v2/enrollments",
      "/v1/consent-documents/current",
    ]);
  });

  it("recovers after crashing between upload and deletion slot writes", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const deletion = new TestSlot();
    deletion.failSet = true;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(consentDocument()))
      .mockResolvedValueOnce(json(enrollmentResponse(), 201));
    const first = service(fetcher, { deletion });
    await first.contribution.initialize();
    const preview = await first.contribution.preparePreview();
    await expect(
      first.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({
      ok: false,
      code: "secure-storage-failed",
      status: { state: "unavailable", enabled: false },
    });
    expect(first.upload.value).toContain(V2_UPLOAD_TOKEN);
    expect(first.deletion.value).toBeNull();
    expect(first.pending.value).toContain(V2_RECOVERY_TOKEN);

    deletion.failSet = false;
    const recoveryFetcher = vi.fn<typeof fetch>(async () =>
      json(enrollmentResponse(), 201),
    );
    const restarted = service(recoveryFetcher, {
      upload: first.upload,
      deletion,
      status: first.status,
      pending: first.pending,
    });
    await restarted.contribution.initialize();
    expect(restarted.contribution.status()).toMatchObject({
      state: "active",
      enabled: true,
      canRecover: false,
    });
    expect(recoveryFetcher).toHaveBeenCalledTimes(1);
    expect(restarted.upload.value).toContain(V2_UPLOAD_TOKEN);
    expect(restarted.deletion.value).toContain(V2_DELETE_TOKEN);
    expect(restarted.pending.value).toBeNull();
    expect(restarted.contribution.status()).toMatchObject({ state: "active" });
  });

  it("retains recovery authority when post-deletion-write cleanup fails", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const status = new TestSlot();
    status.failClear = true;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(consentDocument()))
      .mockResolvedValueOnce(json(enrollmentResponse(), 201));
    const first = service(fetcher, { status });
    await first.contribution.initialize();
    const preview = await first.contribution.preparePreview();
    await expect(
      first.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({
      ok: false,
      code: "secure-storage-failed",
      status: {
        secureStorage: "unavailable",
        state: "unavailable",
        enabled: false,
      },
    });
    expect(first.upload.value).toContain(V2_UPLOAD_TOKEN);
    expect(first.deletion.value).toContain(V2_DELETE_TOKEN);
    expect(first.pending.value).toContain(V2_RECOVERY_TOKEN);

    status.failClear = false;
    const noNetwork = vi.fn<typeof fetch>();
    const restarted = service(noNetwork, {
      upload: first.upload,
      deletion: first.deletion,
      status,
      pending: first.pending,
    });
    await restarted.contribution.initialize();
    expect(noNetwork).not.toHaveBeenCalled();
    expect(restarted.pending.value).toBeNull();
    expect(restarted.contribution.status()).toMatchObject({ state: "active" });
  });

  it("clears a matching pending bundle last and retries that clear after restart", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const pending = new TestSlot();
    pending.failClear = true;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(consentDocument()))
      .mockResolvedValueOnce(json(enrollmentResponse(), 201));
    const first = service(fetcher, { pending });
    await first.contribution.initialize();
    const preview = await first.contribution.preparePreview();
    await expect(
      first.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({
      ok: false,
      code: "secure-storage-failed",
      status: {
        secureStorage: "unavailable",
        state: "unavailable",
        enabled: false,
      },
    });
    expect(first.pending.value).toContain(V2_RECOVERY_TOKEN);

    pending.failClear = false;
    const noNetwork = vi.fn<typeof fetch>();
    const restarted = service(noNetwork, {
      upload: first.upload,
      deletion: first.deletion,
      status: first.status,
      pending,
    });
    await restarted.contribution.initialize();
    expect(noNetwork).not.toHaveBeenCalled();
    expect(restarted.pending.value).toBeNull();
    expect(restarted.contribution.status()).toMatchObject({ state: "active" });
  });

  it("reports a recovered matching enrollment as stopped when its durable upload is paused", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const pending = new TestSlot();
    pending.failClear = true;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("consent-documents")) return json(consentDocument());
      if (url.endsWith("/v2/enrollments"))
        return json(enrollmentResponse(), 201);
      if (url.endsWith("/v1/me/pause")) return json(pauseResponse());
      throw new Error("UNEXPECTED_REQUEST");
    });
    const instance = service(fetcher, { pending });
    await instance.contribution.initialize();
    const preview = await instance.contribution.preparePreview();
    await expect(
      instance.contribution.enable(preview.previewId),
    ).resolves.toMatchObject({
      ok: false,
      code: "secure-storage-failed",
      status: {
        secureStorage: "unavailable",
        state: "unavailable",
        canRecover: false,
      },
    });

    const durableUpload = JSON.parse(instance.upload.value ?? "null") as Record<
      string,
      unknown
    > | null;
    if (durableUpload === null) throw new Error("UPLOAD_AUTHORITY_MISSING");
    instance.upload.value = JSON.stringify({
      ...durableUpload,
      lifecycle: "paused",
    });
    pending.failClear = false;
    const noNetwork = vi.fn<typeof fetch>();
    const restarted = service(noNetwork, {
      upload: instance.upload,
      deletion: instance.deletion,
      status: instance.status,
      pending,
    });
    await restarted.contribution.initialize();
    expect(noNetwork).not.toHaveBeenCalled();
    expect(restarted.pending.value).toBeNull();
    expect(restarted.contribution.status()).toMatchObject({
      state: "stopped",
      enabled: false,
      canRecover: false,
    });
  });

  it("retries the exact queued ingest body and batch id after a network failure", async () => {
    let now = new Date(NOW);
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(now),
    });
    store.upsertDailyAggregate(aggregate("2026-07-14T00:00:00.000Z"));
    completeDay(store, "2026-07-14");
    const ingestAttempts: {
      idempotencyKey: string;
      body: string;
    }[] = [];
    let ingestCount = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("consent-documents"))
        return json(consentDocument());
      if (request.url.endsWith("/v2/enrollments"))
        return json(enrollmentResponse(), 201);
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
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
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
      if (request.url.includes("consent-documents"))
        return json(consentDocument());
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

  it("pauses while preserving upload and deletion authority, then stores only the deletion status credential", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("consent-documents")) return json(consentDocument());
      if (url.endsWith("/v2/enrollments"))
        return json(enrollmentResponse(), 201);
      if (url.endsWith("/v1/me/pause")) return json(pauseResponse());
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
    expect(stopped.status).toMatchObject({
      state: "stopped",
      enabled: false,
      canDelete: true,
    });
    expect(instance.upload.value).toContain('"lifecycle":"paused"');
    expect(instance.upload.value).toContain(V2_UPLOAD_TOKEN);
    expect(instance.deletion.value).toContain(V2_DELETE_TOKEN);

    const requested = await instance.contribution.requestDeletion();
    expect(requested.status).toMatchObject({
      state: "deletion-pending",
      canDelete: false,
    });
    expect(instance.deletion.value).toBeNull();
    expect(instance.status.value).toContain(STATUS_TOKEN);
    expect(instance.status.value).not.toContain(V2_DELETE_TOKEN);
    const complete = await instance.contribution.refreshDeletionStatus();
    expect(complete.status).toMatchObject({ state: "deletion-complete" });
  });

  it("removes upload authority before best-effort outbox cleanup and still tracks accepted deletion", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const slots = activeCredentialSlots();
    const events: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/v1/me/data")) {
        expect(slots.upload.value).toBeNull();
        return json(deletionAccepted(), 202);
      }
      if (request.url.endsWith(`/v1/deletions/${JOB_ID}`)) {
        return json({
          contractVersion: 1,
          jobId: JOB_ID,
          status: "running",
          requestedAt: NOW,
          finishedAt: null,
          anonymousHistoricalTotalsRetained: true,
        });
      }
      throw new Error("UNEXPECTED_REQUEST");
    });
    const instance = service(fetcher, slots);
    await instance.contribution.initialize();
    const originalUploadClear = slots.upload.clear.bind(slots.upload);
    const uploadClear = vi
      .spyOn(slots.upload, "clear")
      .mockImplementation(async (options) => {
        events.push("upload-clear");
        return originalUploadClear(options);
      });
    const outboxClear = vi
      .spyOn(store, "clearCloudOutbox")
      .mockImplementation(() => {
        events.push("outbox-clear");
        throw new Error("OUTBOX_CLEAR_FAILED");
      });

    await expect(
      instance.contribution.requestDeletion(),
    ).resolves.toMatchObject({
      ok: true,
      code: "deletion-requested",
      status: {
        state: "deletion-pending",
        enabled: false,
        canEnable: false,
        canRecover: true,
      },
    });
    expect(events.slice(0, 2)).toEqual(["upload-clear", "outbox-clear"]);
    expect(slots.upload.value).toBeNull();
    expect(slots.deletion.value).toBeNull();
    expect(instance.status.value).toContain(STATUS_TOKEN);

    await expect(
      instance.contribution.refreshDeletionStatus(),
    ).resolves.toMatchObject({
      ok: true,
      code: "deletion-status-updated",
      status: {
        state: "deletion-pending",
        deletion: { status: "running" },
        canRecover: true,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    uploadClear.mockRestore();
    outboxClear.mockRestore();
  });

  it("recovers after remote deletion acceptance outlives local authority cleanup", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const slots = activeCredentialSlots();
    slots.upload.failClear = true;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/me/data")) return json(deletionAccepted(), 202);
      if (url.endsWith(`/v1/deletions/${JOB_ID}`)) {
        return json({
          contractVersion: 1,
          jobId: JOB_ID,
          status: "complete",
          requestedAt: NOW,
          finishedAt: "2026-07-15T18:05:00.000Z",
          anonymousHistoricalTotalsRetained: true,
        });
      }
      throw new Error("UNEXPECTED_REQUEST");
    });
    const first = service(fetcher, slots);
    await first.contribution.initialize();

    await expect(first.contribution.requestDeletion()).resolves.toMatchObject({
      ok: false,
      code: "secure-storage-failed",
    });
    expect(fetcher).not.toHaveBeenCalled();

    slots.upload.failClear = false;
    const restarted = service(fetcher, {
      upload: first.upload,
      deletion: first.deletion,
      status: first.status,
      pending: first.pending,
    });
    await restarted.contribution.initialize();
    await expect(
      restarted.contribution.requestDeletion(),
    ).resolves.toMatchObject({
      ok: true,
      code: "deletion-requested",
      status: { state: "deletion-pending", canRecover: true },
    });
    await expect(restarted.contribution.recover()).resolves.toMatchObject({
      ok: true,
      code: "deletion-status-updated",
      status: {
        state: "deletion-complete",
        canEnable: true,
        canRecover: false,
      },
    });
  });

  it("normalizes a rejected deletion-status write and retries only after restart", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const slots = activeCredentialSlots();
    const status = new TestSlot();
    status.failSet = true;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/v1/me/data")) {
        return json(deletionAccepted(), 202);
      }
      throw new Error("UNEXPECTED_REQUEST");
    });
    const first = service(fetcher, { ...slots, status });
    await first.contribution.initialize();

    await expect(first.contribution.requestDeletion()).resolves.toMatchObject({
      ok: false,
      code: "secure-storage-failed",
      status: {
        secureStorage: "unavailable",
        state: "unavailable",
        enabled: false,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.upload.value).toBeNull();
    expect(first.deletion.value).not.toBeNull();
    expect(status.value).toBeNull();

    status.failSet = false;
    const restarted = service(fetcher, {
      upload: first.upload,
      deletion: first.deletion,
      status,
      pending: first.pending,
    });
    await restarted.contribution.initialize();
    await expect(
      restarted.contribution.requestDeletion(),
    ).resolves.toMatchObject({
      ok: true,
      code: "deletion-requested",
      status: { state: "deletion-pending", canRecover: true },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries legacy terminal deletion cleanup before allowing a fresh opt-in", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
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
      nextAttemptAt: NOW,
      expiresAt: "2026-08-13T00:00:00.000Z",
    });
    store.recordAcceptedCloudSnapshot(snapshot, {
      contractVersion: 1,
      batchId: snapshot.batchId,
      receivedAt: NOW,
      replayed: false,
      status: "accepted",
      summary: {
        appliedBuckets: 1,
        staleBuckets: 0,
        idempotentBuckets: 0,
        quarantinedBuckets: 0,
      },
    });
    const slots = activeCredentialSlots();
    const status = new TestSlot();
    status.value = JSON.stringify({
      schemaVersion: 1,
      kind: "deletion-status",
      token: STATUS_TOKEN,
      jobId: JOB_ID,
      status: "complete",
      requestedAt: NOW,
      finishedAt: "2026-07-15T18:05:00.000Z",
    });
    const originalClearMirror = store.clearCloudMirror.bind(store);
    let failMirrorCleanup = true;
    const clearMirror = vi
      .spyOn(store, "clearCloudMirror")
      .mockImplementation((input) => {
        if (failMirrorCleanup) {
          failMirrorCleanup = false;
          throw new Error("MIRROR_CLEAR_FAILED");
        }
        return originalClearMirror(input);
      });
    const noNetwork = vi.fn<typeof fetch>();
    const instance = service(noNetwork, { ...slots, status });

    await instance.contribution.initialize();
    expect(instance.contribution.status()).toMatchObject({
      state: "deletion-complete",
      enabled: false,
      canEnable: false,
      canRecover: true,
    });
    expect(store.getDiagnosticSummary().counts).toMatchObject({
      cloudOutboxEntries: 0,
      cloudMirrorEntries: 1,
    });

    await expect(instance.contribution.recover()).resolves.toMatchObject({
      ok: true,
      code: "deletion-status-updated",
      status: {
        state: "deletion-complete",
        canEnable: true,
        canRecover: false,
      },
    });
    expect(store.getDiagnosticSummary().counts).toMatchObject({
      cloudOutboxEntries: 0,
      cloudMirrorEntries: 0,
    });
    expect(slots.upload.value).toBeNull();
    expect(slots.deletion.value).toBeNull();
    expect(noNetwork).not.toHaveBeenCalled();
    clearMirror.mockRestore();
  });

  it("persists and reuses one deletion idempotency key after an accepted response is lost", async () => {
    store = await openLocalStore({
      path: ":memory:",
      clock: () => new Date(NOW),
    });
    const deletionKeys: string[] = [];
    let deletionAttempts = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("consent-documents"))
        return json(consentDocument());
      if (request.url.endsWith("/v2/enrollments"))
        return json(enrollmentResponse(), 201);
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

    await expect(
      instance.contribution.requestDeletion(),
    ).resolves.toMatchObject({
      ok: false,
      code: "network-error",
      status: {
        state: "stopped",
        enabled: false,
        canEnable: false,
        canDelete: true,
      },
    });
    expect(instance.upload.value).toBeNull();
    expect(instance.deletion.value).toContain(V2_DELETE_TOKEN);
    const callsBeforeRestartedSync = fetcher.mock.calls.length;
    const restarted = service(fetcher, {
      upload: instance.upload,
      deletion: instance.deletion,
      status: instance.status,
      uuid: () => IDS[4],
    });
    await restarted.contribution.initialize();
    expect(restarted.contribution.status()).toMatchObject({
      state: "stopped",
      enabled: false,
      canEnable: false,
      canDelete: true,
    });
    await expect(restarted.contribution.sync()).resolves.toMatchObject({
      ok: false,
      code: "not-enabled",
      uploadedBatches: 0,
    });
    expect(fetcher).toHaveBeenCalledTimes(callsBeforeRestartedSync);
    await expect(
      restarted.contribution.requestDeletion(),
    ).resolves.toMatchObject({
      ok: true,
      code: "deletion-requested",
      status: { state: "deletion-pending" },
    });
    expect(deletionKeys).toHaveLength(2);
    expect(deletionKeys[0]).toBe(deletionKeys[1]);
    expect(deletionKeys[0]).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
