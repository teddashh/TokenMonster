import type {
  RateLimitDecision,
  RateLimitPort,
  RateLimitRequest,
  SuppressionLedgerEntry,
  SuppressionLedgerPort
} from "@tokenmonster/api-domain";
import {
  DeletionAcceptedResponseV1Schema,
  DeletionStatusResponseV1Schema,
  EnrollmentResponseV1Schema,
  EnrollmentResponseV2Schema,
  IngestReceiptV1Schema,
  PauseResponseV1Schema,
  ResumeResponseV1Schema
} from "@tokenmonster/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCloudflareApiWorker,
  type CloudflareApiEnvironment,
  type CloudflareMutationRuntimePorts
} from "../src/index.js";
import { CloudflareSqliteD1 } from "./cloudflare-sqlite-d1.js";

function base64Url(byte: number): string {
  const bytes = new Uint8Array(32).fill(byte);
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function key(keyId: string, byte: number): Readonly<{
  keyId: string;
  secret: string;
}> {
  return Object.freeze({ keyId, secret: base64Url(byte) });
}

const credentialConfig = Object.freeze({
  currentPepper: key("credential-v1", 1),
  deletionStatusDerivationKey: key("status-v1", 2),
  suppressionKey: key("suppression-v1", 3)
});

const rateKeyConfig = Object.freeze({
  enrollmentEdgeKey: key("rate-enrollment-v1", 4),
  ingestTokenKey: key("rate-ingest-v1", 5),
  deletionTokenKey: key("rate-deletion-v1", 6)
});

const V2_CREDENTIALS = Object.freeze({
  uploadToken: `tm_u2_${"u".repeat(24)}.${"U".repeat(43)}`,
  deletionToken: `tm_d2_${"d".repeat(24)}.${"D".repeat(42)}E`,
  recoveryToken: `tm_r2_${"r".repeat(24)}.${"R".repeat(42)}I`
});

class RecordingRateLimit implements RateLimitPort {
  readonly requests: RateLimitRequest[] = [];

  async consume(request: RateLimitRequest): Promise<RateLimitDecision> {
    this.requests.push(Object.freeze({ ...request }));
    return Object.freeze({ allowed: true });
  }
}

class RecordingSuppressionLedger implements SuppressionLedgerPort {
  readonly entries: SuppressionLedgerEntry[] = [];

  async record(entry: SuppressionLedgerEntry): Promise<void> {
    this.entries.push(Object.freeze({ ...entry }));
  }

  async listActive(at: string): Promise<readonly SuppressionLedgerEntry[]> {
    return Object.freeze(
      this.entries.filter(
        (entry) => Date.parse(entry.expiresAt) > Date.parse(at)
      )
    );
  }
}

const databases: CloudflareSqliteD1[] = [];

function databaseWithPublicProjection(): CloudflareSqliteD1 {
  const db = new CloudflareSqliteD1();
  databases.push(db);
  db.database.prepare(`INSERT INTO public_totals_cache (
    scope,
    day_or_all,
    all_time_tokens,
    today_utc_tokens,
    contributors,
    generated_at,
    data_revision
  ) VALUES ('global', 'all', ?, ?, ?, ?, ?)`).run(
    "100",
    "10",
    "2",
    new Date().toISOString(),
    "worker-composition-test-1"
  );
  return db;
}

function validEnvironment(db: CloudflareSqliteD1): CloudflareApiEnvironment {
  return Object.freeze({
    TOKENMONSTER_DB: db,
    TOKENMONSTER_MUTATIONS_ENABLED: "true",
    TOKENMONSTER_CREDENTIAL_CONFIG_JSON: JSON.stringify(credentialConfig),
    TOKENMONSTER_RATE_KEY_CONFIG_JSON: JSON.stringify(rateKeyConfig),
    TOKENMONSTER_ALLOWED_PUBLIC_ORIGIN: "https://tokenmonster.example"
  });
}

function runtimePorts(): Readonly<{
  ports: Required<CloudflareMutationRuntimePorts>;
  rateLimit: RecordingRateLimit;
  suppressionLedger: RecordingSuppressionLedger;
}> {
  const rateLimit = new RecordingRateLimit();
  const suppressionLedger = new RecordingSuppressionLedger();
  return Object.freeze({
    ports: Object.freeze({ rateLimit, suppressionLedger }),
    rateLimit,
    suppressionLedger
  });
}

function enrollmentBody(): unknown {
  return {
    contractVersion: 1,
    consent: {
      purpose: "contribution",
      documentRevision: "contribution-2026-07-15",
      granted: true,
      acknowledgedAt: new Date(Date.now() - 60_000).toISOString()
    }
  };
}

function recoverableEnrollmentBody(): unknown {
  return {
    contractVersion: 2,
    credentials: V2_CREDENTIALS,
    consent: {
      purpose: "contribution",
      documentRevision: "contribution-2026-07-15",
      granted: true,
      acknowledgedAt: new Date(Date.now() - 60_000).toISOString()
    }
  };
}

function ingestBody(batchId: string, sidecar = false): unknown {
  const now = new Date();
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ).toISOString();
  return {
    schemaVersion: sidecar ? "2" : "1",
    batchId,
    generatedAt: now.toISOString(),
    collector: {
      kind: sidecar ? "tokentracker-sidecar" : "tokscale",
      adapterVersion: "0.1.0",
      sourceVersion: sidecar ? "0.80.0" : "4.5.2"
    },
    buckets: [
      {
        bucketStart: day,
        provider: "openai",
        modelFamily: "openai-codex",
        tool: "codex-cli",
        valueQuality: "exact",
        revision: 1,
        tokens: {
          input: "10",
          output: "2",
          cacheRead: "3",
          cacheWrite: "0",
          reasoning: "1",
          other: "0",
          total: "15"
        }
      }
    ]
  };
}

async function publicTotals(
  worker: ReturnType<typeof createCloudflareApiWorker>,
  env: CloudflareApiEnvironment
): Promise<Response> {
  return worker.fetch(
    new Request("https://api.tokenmonster.example/v1/public/totals"),
    env
  );
}

async function enrollment(
  worker: ReturnType<typeof createCloudflareApiWorker>,
  env: CloudflareApiEnvironment
): Promise<Response> {
  return worker.fetch(
    new Request("https://api.tokenmonster.example/v1/enrollments", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.8",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(enrollmentBody())
    }),
    env
  );
}

async function recoverableEnrollment(
  worker: ReturnType<typeof createCloudflareApiWorker>,
  env: CloudflareApiEnvironment,
  body: unknown = recoverableEnrollmentBody()
): Promise<Response> {
  return worker.fetch(
    new Request("https://api.tokenmonster.example/v2/enrollments", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.8",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }),
    env
  );
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Cloudflare Worker composition gates", () => {
  it("keeps mutations production-disabled without durable runtime ports", async () => {
    const db = databaseWithPublicProjection();
    const env = validEnvironment(db);
    const worker = createCloudflareApiWorker();

    const fakeUpload = `tm_u1_${"A".repeat(22)}.${"B".repeat(43)}`;
    const fakeDeletion = `tm_d1_${"C".repeat(22)}.${"D".repeat(43)}`;
    const mutations = [
      await enrollment(worker, env),
      await recoverableEnrollment(worker, env),
      await worker.fetch(
        new Request(
          "https://api.tokenmonster.example/v1/me/ingest-snapshots",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${fakeUpload}`,
              "Content-Type": "application/json",
              "Idempotency-Key": "018f1f6c-7a4a-7f00-8000-123456789abc"
            },
            body: JSON.stringify(
              ingestBody("018f1f6c-7a4a-7f00-8000-123456789abc")
            )
          }
        ),
        env
      ),
      await worker.fetch(
        new Request("https://api.tokenmonster.example/v1/me/pause", {
          method: "POST",
          headers: { Authorization: `Bearer ${fakeUpload}` }
        }),
        env
      ),
      await worker.fetch(
        new Request("https://api.tokenmonster.example/v1/me/resume", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${fakeUpload}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(enrollmentBody())
        }),
        env
      ),
      await worker.fetch(
        new Request("https://api.tokenmonster.example/v1/me/data", {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${fakeDeletion}`,
            "Idempotency-Key": "delete_request_AAAAAAAAAAAA"
          }
        }),
        env
      )
    ];
    for (const mutation of mutations) {
      const text = await mutation.text();
      expect(mutation.status).toBe(503);
      expect(JSON.parse(text)).toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        status: 503
      });
      expect(text).not.toContain(fakeUpload);
      expect(text).not.toContain(fakeDeletion);
    }

    const publicResponse = await publicTotals(worker, env);
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.json()).toMatchObject({
      allTimeTokens: "100",
      contributors: "2"
    });
  });

  it("fails closed for malformed flags, missing peppers, and invalid credential config", async () => {
    const db = databaseWithPublicProjection();
    const runtime = runtimePorts();
    const malformedSecret = "do-not-reflect-this-secret";
    const environments: CloudflareApiEnvironment[] = [
      {
        ...validEnvironment(db),
        TOKENMONSTER_MUTATIONS_ENABLED: "TRUE"
      },
      {
        TOKENMONSTER_DB: db,
        TOKENMONSTER_MUTATIONS_ENABLED: "true",
        TOKENMONSTER_RATE_KEY_CONFIG_JSON: JSON.stringify(rateKeyConfig)
      },
      {
        ...validEnvironment(db),
        TOKENMONSTER_CREDENTIAL_CONFIG_JSON: JSON.stringify({
          ...credentialConfig,
          unexpected: malformedSecret
        })
      },
      {
        ...validEnvironment(db),
        TOKENMONSTER_CREDENTIAL_CONFIG_JSON: "{not-json"
      },
      {
        ...validEnvironment(db),
        TOKENMONSTER_RATE_KEY_CONFIG_JSON: JSON.stringify({
          ...rateKeyConfig,
          enrollmentEdgeKey: key(
            "rate-enrollment-v2",
            1
          )
        })
      }
    ];

    for (const env of environments) {
      const worker = createCloudflareApiWorker(runtime.ports);
      const mutation = await enrollment(worker, env);
      const mutationText = await mutation.text();
      expect(mutation.status).toBe(503);
      expect(JSON.parse(mutationText)).toMatchObject({
        code: "SERVICE_UNAVAILABLE"
      });
      expect(mutationText).not.toContain(malformedSecret);

      const publicResponse = await publicTotals(worker, env);
      expect(publicResponse.status).toBe(200);
      expect(runtime.rateLimit.requests).toHaveLength(0);
      expect(runtime.suppressionLedger.entries).toHaveLength(0);
    }
  });

  it("requires a real D1-shaped binding before enabling mutations", async () => {
    const runtime = runtimePorts();
    const env: CloudflareApiEnvironment = {
      ...validEnvironment(databaseWithPublicProjection()),
      TOKENMONSTER_DB: Object.freeze({ prepare: () => null })
    };
    const worker = createCloudflareApiWorker(runtime.ports);

    const response = await enrollment(worker, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "SERVICE_UNAVAILABLE"
    });
    expect(runtime.rateLimit.requests).toHaveLength(0);
  });
});

describe("Cloudflare Worker production-shaped mutation composition", () => {
  it("creates, recovers, rotates, ingests, and deletes with client-owned V2 credentials", async () => {
    const db = databaseWithPublicProjection();
    const env = validEnvironment(db);
    const runtime = runtimePorts();
    const worker = createCloudflareApiWorker(runtime.ports);
    const requestBody = recoverableEnrollmentBody();

    const firstResponse = await recoverableEnrollment(worker, env, requestBody);
    const firstText = await firstResponse.text();
    const first = EnrollmentResponseV2Schema.parse(JSON.parse(firstText));
    expect(firstResponse.status).toBe(201);
    expect(firstText).not.toMatch(/tm_[udr]2_/u);

    const replayResponse = await recoverableEnrollment(worker, env, requestBody);
    expect(replayResponse.status).toBe(201);
    expect(await replayResponse.json()).toEqual(first);
    expect(
      db.database.prepare(
        "SELECT COUNT(*) AS count FROM recoverable_enrollments"
      ).get()
    ).toEqual({ count: 1 });

    const rotatedEnv: CloudflareApiEnvironment = {
      ...env,
      TOKENMONSTER_CREDENTIAL_CONFIG_JSON: JSON.stringify({
        ...credentialConfig,
        currentPepper: key("credential-v2", 7),
        previousPepper: credentialConfig.currentPepper
      })
    };
    const rotatedReplay = await recoverableEnrollment(
      worker,
      rotatedEnv,
      requestBody
    );
    expect(rotatedReplay.status).toBe(201);
    expect(await rotatedReplay.json()).toEqual(first);

    const batchId = "718f1f6c-7a4a-7f00-8000-123456789abc";
    const ingest = await worker.fetch(
      new Request(
        "https://api.tokenmonster.example/v1/me/ingest-snapshots",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${V2_CREDENTIALS.uploadToken}`,
            "Content-Type": "application/json",
            "Idempotency-Key": batchId
          },
          body: JSON.stringify(ingestBody(batchId, true))
        }
      ),
      rotatedEnv
    );
    expect(ingest.status, await ingest.clone().text()).toBe(200);
    expect(IngestReceiptV1Schema.safeParse(await ingest.json()).success).toBe(
      true
    );

    const deletion = await worker.fetch(
      new Request("https://api.tokenmonster.example/v1/me/data", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${V2_CREDENTIALS.deletionToken}`,
          "Idempotency-Key": "recoverable_delete_0001"
        }
      }),
      rotatedEnv
    );
    expect(deletion.status).toBe(202);
    expect(
      DeletionAcceptedResponseV1Schema.safeParse(await deletion.json()).success
    ).toBe(true);
    const surface = JSON.stringify(runtime.rateLimit.requests);
    expect(surface).not.toContain(V2_CREDENTIALS.uploadToken);
    expect(surface).not.toContain(V2_CREDENTIALS.deletionToken);
    expect(surface).not.toContain(V2_CREDENTIALS.recoveryToken);
  });

  it("routes enrollment, pause, blocked ingest, resume, ingest, and deletion through domain and D1", async () => {
    const db = databaseWithPublicProjection();
    const env = validEnvironment(db);
    const runtime = runtimePorts();
    const worker = createCloudflareApiWorker(runtime.ports);

    const publicBefore = await publicTotals(worker, env);
    expect(publicBefore.status).toBe(200);
    expect(runtime.rateLimit.requests).toHaveLength(0);

    const enrollmentResponse = await enrollment(worker, env);
    const enrollmentJson = EnrollmentResponseV1Schema.parse(
      await enrollmentResponse.json()
    );
    expect(enrollmentResponse.status).toBe(201);
    expect(
      enrollmentResponse.headers.get("access-control-allow-origin")
    ).toBeNull();

    const batchId = "018f1f6c-7a4a-7f00-8000-123456789abc";
    const ingestResponse = await worker.fetch(
      new Request(
        "https://api.tokenmonster.example/v1/me/ingest-snapshots",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${enrollmentJson.credentials.uploadToken}`,
            "Content-Type": "application/json",
            "Idempotency-Key": batchId
          },
          body: JSON.stringify(ingestBody(batchId, true))
        }
      ),
      env
    );
    const ingestJson = IngestReceiptV1Schema.parse(await ingestResponse.json());
    expect(ingestResponse.status).toBe(200);
    expect(ingestJson.summary.appliedBuckets).toBe(1);

    const wrongScopePause = await worker.fetch(
      new Request("https://api.tokenmonster.example/v1/me/pause", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${enrollmentJson.credentials.deletionToken}`
        }
      }),
      env
    );
    const wrongScopeText = await wrongScopePause.text();
    expect(wrongScopePause.status).toBe(401);
    expect(JSON.parse(wrongScopeText)).toMatchObject({ code: "TOKEN_INVALID" });
    expect(wrongScopeText).not.toContain(
      enrollmentJson.credentials.deletionToken
    );

    const pauseResponse = await worker.fetch(
      new Request("https://api.tokenmonster.example/v1/me/pause", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${enrollmentJson.credentials.uploadToken}`
        }
      }),
      env
    );
    expect(pauseResponse.status).toBe(200);
    expect(PauseResponseV1Schema.parse(await pauseResponse.json())).toMatchObject({
      status: "paused",
      futureUploadsBlocked: true,
      identifiableCurrentDataRetained: true
    });

    const blockedBatchId = "118f1f6c-7a4a-7f00-8000-123456789abc";
    const blockedIngest = await worker.fetch(
      new Request(
        "https://api.tokenmonster.example/v1/me/ingest-snapshots",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${enrollmentJson.credentials.uploadToken}`,
            "Content-Type": "application/json",
            "Idempotency-Key": blockedBatchId
          },
          body: JSON.stringify(ingestBody(blockedBatchId, true))
        }
      ),
      env
    );
    expect(blockedIngest.status).toBe(403);
    expect(await blockedIngest.json()).toMatchObject({
      code: "INSTALLATION_PAUSED"
    });

    const resumeResponse = await worker.fetch(
      new Request("https://api.tokenmonster.example/v1/me/resume", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${enrollmentJson.credentials.uploadToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(enrollmentBody())
      }),
      env
    );
    expect(resumeResponse.status).toBe(200);
    expect(ResumeResponseV1Schema.parse(await resumeResponse.json())).toMatchObject({
      status: "active",
      consentReceipt: {
        purpose: "contribution",
        documentRevision: "contribution-2026-07-15",
        granted: true
      }
    });

    const resumedBatchId = "218f1f6c-7a4a-7f00-8000-123456789abc";
    const resumedIngest = await worker.fetch(
      new Request(
        "https://api.tokenmonster.example/v1/me/ingest-snapshots",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${enrollmentJson.credentials.uploadToken}`,
            "Content-Type": "application/json",
            "Idempotency-Key": resumedBatchId
          },
          body: JSON.stringify(ingestBody(resumedBatchId, true))
        }
      ),
      env
    );
    expect(resumedIngest.status).toBe(200);
    expect(
      IngestReceiptV1Schema.parse(await resumedIngest.json()).summary
        .idempotentBuckets
    ).toBe(1);

    const deletionKey = "delete_request_AAAAAAAAAAAA";
    const deletionResponse = await worker.fetch(
      new Request("https://api.tokenmonster.example/v1/me/data", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${enrollmentJson.credentials.deletionToken}`,
          "Idempotency-Key": deletionKey
        }
      }),
      env
    );
    const deletionJson = DeletionAcceptedResponseV1Schema.parse(
      await deletionResponse.json()
    );
    expect(deletionResponse.status).toBe(202);
    expect(deletionJson.status).toBe("queued");
    expect(runtime.suppressionLedger.entries).toHaveLength(1);

    const deletionStatusResponse = await worker.fetch(
      new Request(
        `https://api.tokenmonster.example/v1/deletions/${deletionJson.jobId}`,
        {
          headers: {
            Authorization: `Bearer ${deletionJson.statusToken}`
          }
        }
      ),
      env
    );
    expect(deletionStatusResponse.status).toBe(200);
    expect(
      DeletionStatusResponseV1Schema.parse(
        await deletionStatusResponse.json()
      )
    ).toMatchObject({
      jobId: deletionJson.jobId,
      status: "queued",
      finishedAt: null
    });

    expect(runtime.rateLimit.requests.map(({ route }) => route)).toEqual([
      "enrollment",
      "ingest",
      "lifecycle",
      "ingest",
      "lifecycle",
      "ingest",
      "delete"
    ]);
    expect(
      runtime.rateLimit.requests.map(({ subjectKey }) =>
        subjectKey.slice(0, 6)
      )
    ).toEqual([
      "rl_e1_",
      "rl_i1_",
      "rl_i1_",
      "rl_i1_",
      "rl_i1_",
      "rl_i1_",
      "rl_d1_"
    ]);
    const rateSurface = JSON.stringify(runtime.rateLimit.requests);
    expect(rateSurface).not.toContain("203.0.113.8");
    expect(rateSurface).not.toContain(enrollmentJson.credentials.uploadToken);
    expect(rateSurface).not.toContain(
      enrollmentJson.credentials.deletionToken
    );

    expect(
      db.database.prepare(`SELECT
        status,
        upload_token_id AS uploadId,
        deletion_token_id AS deletionId
      FROM installations`).get()
    ).toEqual({ status: "deleting", uploadId: null, deletionId: null });
    expect(
      db.database.prepare("SELECT COUNT(*) AS count FROM usage_daily_current").get()
    ).toEqual({ count: 1 });
    expect(
      db.database.prepare("SELECT COUNT(*) AS count FROM consent_receipts").get()
    ).toEqual({ count: 2 });
    expect(
      db.database.prepare("SELECT COUNT(*) AS count FROM deletion_jobs").get()
    ).toEqual({ count: 1 });
  });
});
