import {
  DeletionAcceptedResponseV1Schema,
  DeletionStatusResponseV1Schema,
  EnrollmentResponseV1Schema,
  IngestReceiptV1Schema
} from "@tokenmonster/contracts";
import {
  ApiDomainError,
  type DeleteCommand,
  type DeleteResult,
  type DeletionStatusCommand,
  type DeletionStatusResult,
  type EnrollmentCommand,
  type EnrollmentResult,
  type IngestCommand,
  type IngestResult,
  type RateLimitRoute
} from "@tokenmonster/api-domain";
import { describe, expect, it, vi } from "vitest";

import {
  createTokenMonsterApi,
  type TokenMonsterApiDependencies
} from "../src/index.js";

const REQUEST_ID = "018f1f6c-7a4a-7f00-8000-123456789abc";
const ALLOWED_ORIGIN = "https://tokenmonster.example";
const RATE_KEY = "rate_AAAAAAAAAAAAAAAAAAAAAA";
const BATCH_ID = "018f1f6c-7a4a-7f00-8000-123456789abc";
const UPLOAD_TOKEN = `tm_u1_publicAAAAAAAAAAAAAAAA.${"U".repeat(43)}`;
const DELETION_TOKEN = `tm_d1_publicBBBBBBBBBBBBBBBB.${"D".repeat(43)}`;
const STATUS_TOKEN = `tm_s1_statusCCCCCCCCCCCCCCCC.${"S".repeat(43)}`;
const DELETION_JOB_ID = `del_${"B".repeat(22)}`;

function enrollmentRequest(): unknown {
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

function snapshot(): unknown {
  return {
    schemaVersion: "1",
    batchId: BATCH_ID,
    generatedAt: "2026-07-15T18:20:00.000Z",
    collector: {
      kind: "tokscale",
      adapterVersion: "0.1.0",
      sourceVersion: "4.5.2"
    },
    buckets: [
      {
        bucketStart: "2026-07-15T00:00:00.000Z",
        provider: "openai",
        modelFamily: "openai-codex",
        tool: "codex-cli",
        valueQuality: "exact",
        revision: 1,
        tokens: {
          input: "1",
          output: "0",
          cacheRead: "0",
          cacheWrite: "0",
          reasoning: "0",
          other: "0",
          total: "1"
        }
      }
    ]
  };
}

function enrollmentResult(): EnrollmentResult {
  return {
    contractVersion: 1,
    credentials: {
      uploadToken: UPLOAD_TOKEN,
      deletionToken: DELETION_TOKEN
    },
    consentReceipt: {
      receiptId: `cr_${"A".repeat(22)}`,
      purpose: "contribution",
      documentRevision: "contribution-2026-07-15",
      granted: true,
      acknowledgedAt: "2026-07-15T18:20:00.000Z",
      recordedAt: "2026-07-15T18:30:00.000Z"
    },
    acceptedSnapshotSchemaVersions: ["1"]
  };
}

function ingestResult(
  status: "accepted" | "quarantined" = "accepted"
): IngestResult {
  const quarantined = status === "quarantined" ? 1 : 0;
  return {
    contractVersion: 1,
    batchId: BATCH_ID,
    receivedAt: "2026-07-15T18:30:00.000Z",
    replayed: false,
    status,
    summary: {
      appliedBuckets: quarantined === 0 ? 1 : 0,
      staleBuckets: 0,
      idempotentBuckets: 0,
      quarantinedBuckets: quarantined
    }
  };
}

function deletionResult(): DeleteResult {
  return {
    contractVersion: 1,
    jobId: DELETION_JOB_ID,
    status: "queued",
    statusToken: STATUS_TOKEN,
    requestedAt: "2026-07-15T18:30:00.000Z",
    anonymousHistoricalTotalsRetained: true
  };
}

function deletionStatusResult(
  status: "queued" | "running" | "complete" | "failed" = "queued"
): DeletionStatusResult {
  return {
    contractVersion: 1,
    jobId: DELETION_JOB_ID,
    status,
    requestedAt: "2026-07-15T18:30:00.000Z",
    finishedAt:
      status === "complete" || status === "failed"
        ? "2026-07-15T18:31:00.000Z"
        : null,
    anonymousHistoricalTotalsRetained: true
  };
}

interface MutationHarness {
  readonly app: ReturnType<typeof createTokenMonsterApi>;
  readonly enrollmentCommands: EnrollmentCommand[];
  readonly ingestCommands: IngestCommand[];
  readonly deleteCommands: DeleteCommand[];
  readonly deletionStatusCommands: DeletionStatusCommand[];
  readonly rateScopes: RateLimitRoute[];
}

function createMutationHarness(
  overrides: Partial<TokenMonsterApiDependencies> = {}
): MutationHarness {
  const enrollmentCommands: EnrollmentCommand[] = [];
  const ingestCommands: IngestCommand[] = [];
  const deleteCommands: DeleteCommand[] = [];
  const deletionStatusCommands: DeletionStatusCommand[] = [];
  const rateScopes: RateLimitRoute[] = [];
  const app = createTokenMonsterApi({
    readPublicTotals: async () => null,
    createRequestId: () => REQUEST_ID,
    now: () => new Date("2026-07-15T18:30:00.000Z"),
    allowedPublicOrigin: ALLOWED_ORIGIN,
    deriveRateLimitKey: async (_request, scope) => {
      rateScopes.push(scope);
      return RATE_KEY;
    },
    enrollContributor: async (command) => {
      enrollmentCommands.push(command);
      return enrollmentResult();
    },
    ingestSnapshot: async (command) => {
      ingestCommands.push(command);
      return ingestResult();
    },
    requestContributorDeletion: async (command) => {
      deleteCommands.push(command);
      return deletionResult();
    },
    getContributorDeletionStatus: async (command) => {
      deletionStatusCommands.push(command);
      return deletionStatusResult();
    },
    ...overrides
  });
  return {
    app,
    enrollmentCommands,
    ingestCommands,
    deleteCommands,
    deletionStatusCommands,
    rateScopes
  };
}

function jsonHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    "Content-Type": "application/json; charset=UTF-8",
    Origin: ALLOWED_ORIGIN,
    ...extra
  };
}

function responseSurface(response: Response, body: string): string {
  return JSON.stringify({
    body,
    headers: [...response.headers.entries()]
  });
}

describe("mutation success contracts", () => {
  it("creates enrollment once with a strict 201 contract and no mutation CORS", async () => {
    const context = createMutationHarness();
    const requestBody = enrollmentRequest();
    const response = await context.app.request("/v1/enrollments", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(requestBody)
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(EnrollmentResponseV1Schema.parse(body)).toEqual(enrollmentResult());
    expect(context.enrollmentCommands).toEqual([
      { body: requestBody, rateLimitKey: RATE_KEY }
    ]);
    expect(context.rateScopes).toEqual(["enrollment"]);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(response.headers.get("x-contract-version")).toBe("1");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("passes only exact auth/idempotency/rate inputs to ingest and returns 200", async () => {
    const context = createMutationHarness();
    const requestSnapshot = snapshot();
    const response = await context.app.request(
      "/v1/me/ingest-snapshots",
      {
        method: "POST",
        headers: jsonHeaders({
          Authorization: `Bearer ${UPLOAD_TOKEN}`,
          "Idempotency-Key": BATCH_ID
        }),
        body: JSON.stringify(requestSnapshot)
      }
    );
    const text = await response.text();
    const body = JSON.parse(text) as unknown;

    expect(response.status).toBe(200);
    expect(IngestReceiptV1Schema.parse(body)).toEqual(ingestResult());
    expect(context.ingestCommands).toEqual([
      {
        bearerToken: UPLOAD_TOKEN,
        idempotencyKey: BATCH_ID,
        snapshot: requestSnapshot,
        rateLimitKey: RATE_KEY
      }
    ]);
    expect(context.rateScopes).toEqual(["ingest"]);
    expect(context.ingestCommands[0]?.rateLimitKey).not.toBe(UPLOAD_TOKEN);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(responseSurface(response, text)).not.toContain(UPLOAD_TOKEN);
  });

  it("uses 202 only for a contract-valid quarantined ingest receipt", async () => {
    const context = createMutationHarness({
      ingestSnapshot: async () => ingestResult("quarantined")
    });
    const response = await context.app.request(
      "/v1/me/ingest-snapshots",
      {
        method: "POST",
        headers: jsonHeaders({
          Authorization: `Bearer ${UPLOAD_TOKEN}`,
          "Idempotency-Key": BATCH_ID
        }),
        body: JSON.stringify(snapshot())
      }
    );

    expect(response.status).toBe(202);
    expect(IngestReceiptV1Schema.safeParse(await response.json()).success).toBe(
      true
    );
  });

  it("accepts deletion with a deletion-scoped command and a strict 202 contract", async () => {
    const context = createMutationHarness();
    const response = await context.app.request("/v1/me/data", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${DELETION_TOKEN}`,
        "Idempotency-Key": "delete_AAAAAAAAAAAAAAAAAAAAAA",
        Origin: ALLOWED_ORIGIN
      }
    });
    const text = await response.text();
    const body = JSON.parse(text) as unknown;

    expect(response.status).toBe(202);
    expect(DeletionAcceptedResponseV1Schema.parse(body)).toEqual(
      deletionResult()
    );
    expect(context.deleteCommands).toEqual([
      {
        bearerToken: DELETION_TOKEN,
        idempotencyKey: "delete_AAAAAAAAAAAAAAAAAAAAAA",
        rateLimitKey: RATE_KEY
      }
    ]);
    expect(context.rateScopes).toEqual(["delete"]);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(responseSurface(response, text)).not.toContain(DELETION_TOKEN);
  });

  it("returns an authenticated deletion status without rate or CORS state", async () => {
    const context = createMutationHarness();
    const response = await context.app.request(
      `/v1/deletions/${DELETION_JOB_ID}`,
      {
        headers: {
          Authorization: `Bearer ${STATUS_TOKEN}`,
          Origin: ALLOWED_ORIGIN
        }
      }
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(DeletionStatusResponseV1Schema.parse(JSON.parse(text))).toEqual(
      deletionStatusResult()
    );
    expect(context.deletionStatusCommands).toEqual([
      { bearerToken: STATUS_TOKEN, jobId: DELETION_JOB_ID }
    ]);
    expect(context.rateScopes).toEqual([]);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(responseSurface(response, text)).not.toContain(STATUS_TOKEN);
  });
});

describe("bounded strict request parsing", () => {
  it("rejects an oversized declared Content-Length before deriving or executing", async () => {
    const context = createMutationHarness();
    const response = await context.app.request("/v1/enrollments", {
      method: "POST",
      headers: jsonHeaders({ "Content-Length": "65537" }),
      body: "{}"
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(413);
    expect(body).toMatchObject({
      type: "about:blank",
      status: 413,
      code: "BODY_TOO_LARGE",
      requestId: REQUEST_ID
    });
    expect(context.rateScopes).toEqual([]);
    expect(context.enrollmentCommands).toEqual([]);
  });

  it("caps the bytes actually read when Content-Length is absent or false", async () => {
    const context = createMutationHarness();
    const tooLarge = JSON.stringify({ padding: "x".repeat(65_536) });
    const response = await context.app.request(
      "/v1/me/ingest-snapshots",
      {
        method: "POST",
        headers: jsonHeaders({
          Authorization: `Bearer ${UPLOAD_TOKEN}`,
          "Content-Length": "1",
          "Idempotency-Key": BATCH_ID
        }),
        body: tooLarge
      }
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "BODY_TOO_LARGE" });
    expect(context.ingestCommands).toEqual([]);
  });

  it("caps chunk count even when a stream stays below the byte limit", async () => {
    const context = createMutationHarness();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 1_025; index += 1) {
          controller.enqueue(new Uint8Array([0x20]));
        }
        controller.close();
      }
    });
    const request = new Request("https://worker.test/v1/enrollments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half"
    } as RequestInit & { duplex: "half" });
    const response = await context.app.fetch(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "BODY_TOO_LARGE" });
    expect(context.enrollmentCommands).toEqual([]);
  });

  it.each([
    ["missing content type", undefined, JSON.stringify(enrollmentRequest())],
    ["wrong content type", "text/plain", JSON.stringify(enrollmentRequest())],
    ["malformed JSON", "application/json", "{\"contractVersion\":"],
    ["empty JSON body", "application/json", ""]
  ])("rejects %s as SCHEMA_INVALID", async (_name, contentType, body) => {
    const context = createMutationHarness();
    const headers: Record<string, string> = {};
    if (contentType !== undefined) {
      headers["Content-Type"] = contentType;
    }
    const response = await context.app.request("/v1/enrollments", {
      method: "POST",
      headers,
      body
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "SCHEMA_INVALID" });
    expect(context.enrollmentCommands).toEqual([]);
  });

  it("rejects any deletion body instead of silently ignoring it", async () => {
    const context = createMutationHarness();
    const response = await context.app.request("/v1/me/data", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${DELETION_TOKEN}`,
        "Idempotency-Key": "delete_AAAAAAAAAAAAAAAAAAAAAA",
        "Content-Type": "application/json"
      },
      body: "{}"
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "SCHEMA_INVALID" });
    expect(context.deleteCommands).toEqual([]);
  });

  it("requires a canonical status path with no query or declared body", async () => {
    const context = createMutationHarness();
    const request = (path: string, headers: Record<string, string> = {}) =>
      context.app.request(path, {
        headers: {
          Authorization: `Bearer ${STATUS_TOKEN}`,
          ...headers
        }
      });

    for (const response of [
      await request("/v1/deletions/not-a-job"),
      await request(`/v1/deletions/${DELETION_JOB_ID}?detail=true`),
      await request(`/v1/deletions/${DELETION_JOB_ID}`, {
        "Content-Length": "1"
      })
    ]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "SCHEMA_INVALID" });
    }
    expect(context.deletionStatusCommands).toEqual([]);
  });
});

describe("authentication, idempotency and sanitized failures", () => {
  it.each([
    undefined,
    `Basic ${UPLOAD_TOKEN}`,
    `bearer ${UPLOAD_TOKEN}`,
    `Bearer  ${UPLOAD_TOKEN}`,
    `Bearer ${UPLOAD_TOKEN},Bearer other`
  ])("rejects a non-exact Authorization value", async (authorization) => {
    const context = createMutationHarness();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Idempotency-Key": BATCH_ID
    };
    if (authorization !== undefined) {
      headers["Authorization"] = authorization;
    }
    const response = await context.app.request(
      "/v1/me/ingest-snapshots",
      {
        method: "POST",
        headers,
        body: JSON.stringify(snapshot())
      }
    );
    const text = await response.text();

    expect(response.status).toBe(401);
    expect(JSON.parse(text)).toMatchObject({ code: "TOKEN_INVALID" });
    expect(responseSurface(response, text)).not.toContain(UPLOAD_TOKEN);
    expect(context.rateScopes).toEqual([]);
    expect(context.ingestCommands).toEqual([]);
  });

  it("maps a domain scope rejection without reflecting the presented token", async () => {
    const execute = vi.fn(async (_command: IngestCommand) => {
      throw new ApiDomainError("TOKEN_INVALID");
    });
    const context = createMutationHarness({ ingestSnapshot: execute });
    const response = await context.app.request(
      "/v1/me/ingest-snapshots",
      {
        method: "POST",
        headers: jsonHeaders({
          Authorization: `Bearer ${DELETION_TOKEN}`,
          "Idempotency-Key": BATCH_ID
        }),
        body: JSON.stringify(snapshot())
      }
    );
    const text = await response.text();

    expect(execute).toHaveBeenCalledOnce();
    expect(response.status).toBe(401);
    expect(JSON.parse(text)).toMatchObject({ code: "TOKEN_INVALID" });
    expect(responseSurface(response, text)).not.toContain(DELETION_TOKEN);
  });

  it("requires exact status bearer syntax and sanitizes status output", async () => {
    const invalidAuthorization = createMutationHarness();
    const missingBearer = await invalidAuthorization.app.request(
      `/v1/deletions/${DELETION_JOB_ID}`
    );
    expect(missingBearer.status).toBe(401);
    expect(await missingBearer.json()).toMatchObject({ code: "TOKEN_INVALID" });
    expect(invalidAuthorization.deletionStatusCommands).toEqual([]);

    const canary = "prompt=STATUS_OUTPUT_MUST_NOT_ESCAPE";
    const invalid = {
      ...deletionStatusResult(),
      prompt: canary
    } as unknown as DeletionStatusResult;
    const invalidOutput = createMutationHarness({
      getContributorDeletionStatus: async () => invalid
    });
    const response = await invalidOutput.app.request(
      `/v1/deletions/${DELETION_JOB_ID}`,
      { headers: { Authorization: `Bearer ${STATUS_TOKEN}` } }
    );
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(responseSurface(response, text)).not.toContain(canary);
    expect(responseSurface(response, text)).not.toContain(STATUS_TOKEN);
  });

  it("passes a missing or mismatched Idempotency-Key to domain for rejection", async () => {
    const execute = vi.fn(async (command: IngestCommand) => {
      throw new ApiDomainError(
        command.idempotencyKey === ""
          ? "IDEMPOTENCY_KEY_INVALID"
          : "IDEMPOTENCY_KEY_MISMATCH"
      );
    });
    const context = createMutationHarness({ ingestSnapshot: execute });
    const request = (idempotencyKey?: string) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${UPLOAD_TOKEN}`,
        "Content-Type": "application/json"
      };
      if (idempotencyKey !== undefined) {
        headers["Idempotency-Key"] = idempotencyKey;
      }
      return context.app.request("/v1/me/ingest-snapshots", {
        method: "POST",
        headers,
        body: JSON.stringify(snapshot())
      });
    };

    const missing = await request();
    const mismatch = await request("wrong-idempotency-key");

    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_INVALID"
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_MISMATCH"
    });
    expect(execute.mock.calls[0]?.[0].idempotencyKey).toBe("");
    expect(execute.mock.calls[1]?.[0].idempotencyKey).toBe(
      "wrong-idempotency-key"
    );
  });

  it("passes the deletion Idempotency-Key verbatim for domain validation", async () => {
    const execute = vi.fn(async (command: DeleteCommand) => {
      if (command.idempotencyKey === "") {
        throw new ApiDomainError("IDEMPOTENCY_KEY_INVALID");
      }
      return deletionResult();
    });
    const context = createMutationHarness({
      requestContributorDeletion: execute
    });
    const request = (idempotencyKey?: string) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${DELETION_TOKEN}`
      };
      if (idempotencyKey !== undefined) {
        headers["Idempotency-Key"] = idempotencyKey;
      }
      return context.app.request("/v1/me/data", {
        method: "DELETE",
        headers
      });
    };

    const missing = await request();
    const accepted = await request("delete_BBBBBBBBBBBBBBBBBBBBBB");

    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_INVALID"
    });
    expect(accepted.status).toBe(202);
    expect(execute.mock.calls[0]?.[0].idempotencyKey).toBe("");
    expect(execute.mock.calls[1]?.[0].idempotencyKey).toBe(
      "delete_BBBBBBBBBBBBBBBBBBBBBB"
    );
  });

  it("maps domain retry metadata into problem details and Retry-After", async () => {
    const context = createMutationHarness({
      ingestSnapshot: async () => {
        throw new ApiDomainError("RATE_LIMITED", 73);
      }
    });
    const response = await context.app.request(
      "/v1/me/ingest-snapshots",
      {
        method: "POST",
        headers: jsonHeaders({
          Authorization: `Bearer ${UPLOAD_TOKEN}`,
          "Idempotency-Key": BATCH_ID
        }),
        body: JSON.stringify(snapshot())
      }
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("73");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toMatchObject({
      type: "about:blank",
      status: 429,
      code: "RATE_LIMITED",
      retryAfterSeconds: 73,
      requestId: REQUEST_ID
    });
  });

  it("sanitizes unexpected callback and rate-key failures", async () => {
    const canary = `prompt=PRIVATE:${UPLOAD_TOKEN}`;
    const callbackFailure = createMutationHarness({
      ingestSnapshot: async () => {
        throw new Error(canary);
      }
    });
    const rateFailure = createMutationHarness({
      deriveRateLimitKey: async () => {
        throw new Error(canary);
      }
    });
    const request = (app: ReturnType<typeof createTokenMonsterApi>) =>
      app.request("/v1/me/ingest-snapshots", {
        method: "POST",
        headers: jsonHeaders({
          Authorization: `Bearer ${UPLOAD_TOKEN}`,
          "Idempotency-Key": BATCH_ID
        }),
        body: JSON.stringify(snapshot())
      });

    for (const response of [
      await request(callbackFailure.app),
      await request(rateFailure.app)
    ]) {
      const text = await response.text();
      expect(response.status).toBe(503);
      expect(JSON.parse(text)).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      expect(responseSurface(response, text)).not.toContain(canary);
      expect(responseSurface(response, text)).not.toContain(UPLOAD_TOKEN);
    }
  });

  it("fails closed when mutation callbacks or rate-key derivation are absent", async () => {
    const empty = createTokenMonsterApi({
      createRequestId: () => REQUEST_ID
    });
    const missingDeriver = createTokenMonsterApi({
      createRequestId: () => REQUEST_ID,
      enrollContributor: async () => enrollmentResult()
    });
    const request = (app: ReturnType<typeof createTokenMonsterApi>) =>
      app.request("/v1/enrollments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enrollmentRequest())
      });

    for (const response of [await request(empty), await request(missingDeriver)]) {
      expect(response.status).toBe(503);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await response.json()).toMatchObject({
        code: "SERVICE_UNAVAILABLE"
      });
    }
  });

  it("rejects domain output that is not exactly the public contract", async () => {
    const canary = "prompt=OUTPUT_SHOULD_NOT_ESCAPE";
    const invalid = {
      ...enrollmentResult(),
      prompt: canary
    } as unknown as EnrollmentResult;
    const context = createMutationHarness({
      enrollContributor: async () => invalid
    });
    const response = await context.app.request("/v1/enrollments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(enrollmentRequest())
    });
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(responseSurface(response, text)).not.toContain(canary);
  });

  it("never grants CORS to mutation preflights", async () => {
    const context = createMutationHarness();
    const response = await context.app.request("/v1/enrollments", {
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization, Idempotency-Key"
      }
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
    expect(response.headers.get("access-control-allow-headers")).toBeNull();
  });
});
