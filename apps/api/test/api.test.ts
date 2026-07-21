import { describe, expect, it } from "vitest";
import {
  IngestSnapshotV1Schema,
  IngestSnapshotV2Schema,
  PERMANENT_SIDECAR_COLLECTOR_IDENTITY_V2
} from "@tokenmonster/contracts";

import {
  createTokenMonsterApi,
  type PublicTotalsSnapshot
} from "../src/index.js";

const verifiedSnapshot: PublicTotalsSnapshot = {
  allTimeTokens: "1234567890",
  todayUtcTokens: "345678",
  contributors: "421",
  generatedAt: "2026-07-15T18:23:00Z",
  dataRevision: "2026-07-15T18:23:00Z/184"
};

function createApp(
  snapshot: PublicTotalsSnapshot | null = verifiedSnapshot,
  allowedPublicOrigin = "https://tokenmonster.example"
) {
  return createTokenMonsterApi({
    readPublicTotals: async () => snapshot,
    createRequestId: () => "018f1f6c-7a4a-7f00-8000-123456789abc",
    now: () => new Date("2026-07-15T18:24:00.000Z"),
    allowedPublicOrigin
  });
}

describe("public API envelope", () => {
  it("serves health without probing a database", async () => {
    const response = await createApp().request("/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", contractVersion: 1 });
    expect(response.headers.get("x-contract-version")).toBe("1");
    expect(response.headers.get("x-request-id")).toBe(
      "018f1f6c-7a4a-7f00-8000-123456789abc"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("strict-transport-security")).toContain(
      "max-age=63072000"
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'"
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not reveal a stable identifier or secret in compatibility", async () => {
    const response = await createApp().request("/v1/compatibility");
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('"acceptedSnapshotSchemaVersions":["1","2"]');
    expect(text).toContain('"kind":"tokentracker-sidecar"');
    expect(text).toContain('"adapterVersion":"0.1.0"');
    expect(text).toContain('"sourceVersion":"0.80.0"');
    expect(text).toContain('"sourceVersion":"4.5.2"');
    expect(text).toContain('"kind":"tokentracker-bridge"');
    expect(text).not.toContain('"kind":"tokentracker-cli"');
    expect(text).not.toMatch(/enrollment|installationId|secret|tokenId/i);
  });

  it("returns RFC problem details for unknown routes", async () => {
    const response = await createApp().request("/v1/not-real");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json"
    );
    expect(body).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      requestId: "018f1f6c-7a4a-7f00-8000-123456789abc"
    });
  });
});

describe("consent document", () => {
  it("exposes an immutable allowlist and the anonymous-history boundary", async () => {
    const response = await createApp().request(
      "/v1/consent-documents/current?purpose=contribution&locale=zh-TW"
    );
    const body = (await response.json()) as {
      revision: string;
      fieldAllowlist: string[];
      forbidden: string[];
      summary: string;
      retention: { disclosure: string };
      controls: { defaultEnabled: boolean };
      schemaExample: unknown;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(body.revision).toBe("contribution-2026-07-15");
    expect(body.fieldAllowlist).toContain("buckets.tokens.total");
    expect(body.forbidden).toContain("prompt");
    expect(body.summary).toContain("背景同步");
    expect(body.retention.disclosure).toContain("20");
    expect(body.retention.disclosure).toContain("無法再個別抽出或刪除");
    expect(body.controls.defaultEnabled).toBe(false);
    expect(IngestSnapshotV2Schema.parse(body.schemaExample).collector).toEqual(
      PERMANENT_SIDECAR_COLLECTOR_IDENTITY_V2
    );
    expect(IngestSnapshotV1Schema.safeParse(body.schemaExample).success).toBe(
      false
    );
  });

  it("rejects unsupported purposes and locales", async () => {
    const badPurpose = await createApp().request(
      "/v1/consent-documents/current?purpose=analytics"
    );
    const badLocale = await createApp().request(
      "/v1/consent-documents/current?purpose=contribution&locale=fr"
    );

    expect(badPurpose.status).toBe(400);
    expect(badLocale.status).toBe(400);
  });
});

describe("public totals", () => {
  it("returns verified decimal strings, fixed wording and conditional caching", async () => {
    const app = createApp();
    const first = await app.request("/v1/public/totals", {
      headers: { Origin: "https://tokenmonster.example" }
    });
    const etag = first.headers.get("etag");
    const body = (await first.json()) as Record<string, unknown>;

    expect(first.status).toBe(200);
    expect(body).toMatchObject({
      contractVersion: 1,
      allTimeTokens: "1234567890",
      todayUtcTokens: "345678",
      contributors: "421",
      disclaimer: "只包含自願匿名分享者，不代表全球所有 AI 使用量。"
    });
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(first.headers.get("access-control-allow-origin")).toBe(
      "https://tokenmonster.example"
    );
    expect(first.headers.get("access-control-expose-headers")).toContain(
      "ETag"
    );

    const cached = await app.request("/v1/public/totals", {
      headers: { "If-None-Match": etag ?? "" }
    });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");

    for (const ifNoneMatch of [
      `W/${etag ?? ""}`,
      `"other", W/${etag ?? ""}`,
      "*"
    ]) {
      const conditional = await app.request("/v1/public/totals", {
        headers: { "If-None-Match": ifNoneMatch }
      });
      expect(conditional.status, ifNoneMatch).toBe(304);
    }
  });

  it("fails closed instead of inventing a counter", async () => {
    const response = await createApp(null).request("/v1/public/totals");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      code: "PUBLIC_TOTALS_UNAVAILABLE",
      status: 503
    });
    expect(JSON.stringify(body)).not.toMatch(/allTimeTokens|contributors/);
  });

  it("rejects malformed or overflowing projections", async () => {
    const overflow = {
      ...verifiedSnapshot,
      allTimeTokens: "9223372036854775808"
    };
    const malformed = {
      ...verifiedSnapshot,
      contributors: "00421"
    };

    expect(
      (await createApp(overflow).request("/v1/public/totals")).status
    ).toBe(503);
    expect(
      (await createApp(malformed).request("/v1/public/totals")).status
    ).toBe(503);

    const impossibleToday = {
      ...verifiedSnapshot,
      todayUtcTokens: "1234567891"
    };
    expect(
      (await createApp(impossibleToday).request("/v1/public/totals")).status
    ).toBe(503);

    const missingField = { ...verifiedSnapshot } as Record<string, unknown>;
    delete missingField["dataRevision"];
    const invalidReader = createTokenMonsterApi({
      readPublicTotals: async () => missingField,
      createRequestId: () => "018f1f6c-7a4a-7f00-8000-123456789abc",
      now: () => new Date("2026-07-15T18:24:00.000Z")
    });
    expect((await invalidReader.request("/v1/public/totals")).status).toBe(503);

    const futureProjection = {
      ...verifiedSnapshot,
      generatedAt: "2026-07-15T18:30:00Z"
    };
    expect(
      (await createApp(futureProjection).request("/v1/public/totals")).status
    ).toBe(503);

    const staleProjection = {
      ...verifiedSnapshot,
      generatedAt: "2026-07-15T18:13:59Z"
    };
    expect(
      (await createApp(staleProjection).request("/v1/public/totals")).status
    ).toBe(503);
  });

  it("rejects inherited fields and never spreads an unknown projection", async () => {
    const inheritedRevision = Object.create({
      dataRevision: verifiedSnapshot.dataRevision
    }) as Record<string, unknown>;
    Object.assign(inheritedRevision, {
      allTimeTokens: verifiedSnapshot.allTimeTokens,
      todayUtcTokens: verifiedSnapshot.todayUtcTokens,
      contributors: verifiedSnapshot.contributors,
      generatedAt: verifiedSnapshot.generatedAt,
      prompt: "must-never-leak"
    });
    const app = createTokenMonsterApi({
      readPublicTotals: async () => inheritedRevision,
      createRequestId: () => "018f1f6c-7a4a-7f00-8000-123456789abc",
      now: () => new Date("2026-07-15T18:24:00.000Z")
    });

    const response = await app.request("/v1/public/totals");
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).not.toContain("must-never-leak");
    expect(body).not.toContain("prompt");
  });

  it("does not grant CORS to an unapproved origin", async () => {
    const response = await createApp().request("/v1/public/totals", {
      headers: { Origin: "https://attacker.example" }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("supports only the allowlisted public conditional-GET preflight", async () => {
    const app = createApp();
    const allowed = await app.request("/v1/public/totals", {
      method: "OPTIONS",
      headers: {
        Origin: "https://tokenmonster.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "If-None-Match"
      }
    });

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://tokenmonster.example"
    );
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET");
    expect(allowed.headers.get("access-control-allow-headers")).toContain(
      "If-None-Match"
    );

    const mutation = await app.request("/v1/public/totals", {
      method: "OPTIONS",
      headers: {
        Origin: "https://tokenmonster.example",
        "Access-Control-Request-Method": "POST"
      }
    });
    const unapproved = await app.request("/v1/public/totals", {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example",
        "Access-Control-Request-Method": "GET"
      }
    });

    expect(mutation.status).toBe(400);
    expect(unapproved.status).toBe(404);
    expect(unapproved.headers.get("access-control-allow-origin")).toBeNull();
  });
});
