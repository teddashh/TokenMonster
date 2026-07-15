import type {
  RateLimitDecision,
  RateLimitPort,
  RateLimitRequest,
  SuppressionLedgerEntry,
  SuppressionLedgerPort
} from "@tokenmonster/api-domain";
import {
  DeletionAcceptedResponseV1Schema,
  EnrollmentResponseV1Schema,
  IngestReceiptV1Schema
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

function ingestBody(batchId: string): unknown {
  const now = new Date();
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ).toISOString();
  return {
    schemaVersion: "1",
    batchId,
    generatedAt: now.toISOString(),
    collector: {
      kind: "tokscale",
      adapterVersion: "0.1.0",
      sourceVersion: "4.5.2"
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
  it("routes enrollment, ingest, and deletion through existing domain and D1 adapters", async () => {
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
          body: JSON.stringify(ingestBody(batchId))
        }
      ),
      env
    );
    const ingestJson = IngestReceiptV1Schema.parse(await ingestResponse.json());
    expect(ingestResponse.status).toBe(200);
    expect(ingestJson.summary.appliedBuckets).toBe(1);

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

    expect(runtime.rateLimit.requests.map(({ route }) => route)).toEqual([
      "enrollment",
      "ingest",
      "delete"
    ]);
    expect(
      runtime.rateLimit.requests.map(({ subjectKey }) =>
        subjectKey.slice(0, 6)
      )
    ).toEqual(["rl_e1_", "rl_i1_", "rl_d1_"]);
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
      db.database.prepare("SELECT COUNT(*) AS count FROM deletion_jobs").get()
    ).toEqual({ count: 1 });
  });
});
