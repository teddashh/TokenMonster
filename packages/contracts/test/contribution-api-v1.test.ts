import { describe, expect, it } from "vitest";

import {
  ConsentUpdateRequestV1Schema,
  ContributionCredentialPairV1Schema,
  CredentialRotationResponseV1Schema,
  DeletionAcceptedResponseV1Schema,
  DeletionStatusResponseV1Schema,
  EnrollmentRequestV1Schema,
  EnrollmentResponseV1Schema,
  IngestReceiptV1Schema,
  PauseResponseV1Schema,
  ResumeRequestV1Schema,
  ResumeResponseV1Schema,
  parseEnrollmentRequestV1,
  serializeContributionApiV1
} from "../src/index.js";

const ACKNOWLEDGED_AT = "2026-07-15T18:20:00Z";
const RECORDED_AT = "2026-07-15T18:20:01.000Z";
const UPLOAD_TOKEN = `tm_u1_${"u".repeat(16)}.${"U".repeat(43)}`;
const DELETION_TOKEN = `tm_d1_${"d".repeat(16)}.${"D".repeat(43)}`;
const STATUS_TOKEN = `tm_s1_${"s".repeat(16)}.${"S".repeat(43)}`;

function consent(granted: boolean = true): Record<string, unknown> {
  return {
    purpose: "contribution",
    documentRevision: "contribution-2026-07-15",
    granted,
    acknowledgedAt: ACKNOWLEDGED_AT
  };
}

function consentReceipt(granted: boolean = true): Record<string, unknown> {
  return {
    receiptId: `cr_${"r".repeat(22)}`,
    ...consent(granted),
    recordedAt: RECORDED_AT
  };
}

describe("contribution enrollment wire contracts", () => {
  it("accepts a strict affirmative enrollment and round-trips it", () => {
    const input = { contractVersion: 1, consent: consent() };
    const parsed = parseEnrollmentRequestV1(input);
    expect(JSON.parse(serializeContributionApiV1(EnrollmentRequestV1Schema, parsed)))
      .toEqual(parsed);
  });

  it("rejects false consent, a wrong purpose, and unknown fields", () => {
    expect(
      EnrollmentRequestV1Schema.safeParse({
        contractVersion: 1,
        consent: consent(false)
      }).success
    ).toBe(false);
    expect(
      EnrollmentRequestV1Schema.safeParse({
        contractVersion: 1,
        consent: { ...consent(), purpose: "analytics" }
      }).success
    ).toBe(false);
    expect(
      EnrollmentRequestV1Schema.safeParse({
        contractVersion: 1,
        consent: consent(),
        email: "must-not-be-collected@example.test"
      }).success
    ).toBe(false);
  });

  it.each([
    "contribution-latest",
    "contribution-2026-02-30",
    "contribution-2019-12-31",
    "analytics-2026-07-15"
  ])("rejects invalid immutable consent revision %s", (documentRevision) => {
    expect(
      EnrollmentRequestV1Schema.safeParse({
        contractVersion: 1,
        consent: { ...consent(), documentRevision }
      }).success
    ).toBe(false);
  });

  it.each([
    "2019-12-31T23:59:59Z",
    "2100-01-01T00:00:00Z",
    "2026-02-30T12:00:00Z",
    "2026-07-15T18:20:00+00:00",
    "2026-07-15 18:20:00Z"
  ])("rejects a malformed acknowledgement timestamp %s", (acknowledgedAt) => {
    expect(
      EnrollmentRequestV1Schema.safeParse({
        contractVersion: 1,
        consent: { ...consent(), acknowledgedAt }
      }).success
    ).toBe(false);
  });

  it("accepts a one-time enrollment response without a stable installation id", () => {
    const response = {
      contractVersion: 1,
      credentials: {
        uploadToken: UPLOAD_TOKEN,
        deletionToken: DELETION_TOKEN
      },
      consentReceipt: consentReceipt(),
      acceptedSnapshotSchemaVersions: ["1"]
    };
    const parsed = EnrollmentResponseV1Schema.parse(response);
    expect(JSON.stringify(parsed)).not.toMatch(/installation|enrollmentId/i);
  });

  it("preserves the published V1 response shape for old credential parsers", () => {
    const base = {
      contractVersion: 1,
      credentials: {
        uploadToken: UPLOAD_TOKEN,
        deletionToken: DELETION_TOKEN
      },
      consentReceipt: consentReceipt()
    };
    expect(
      EnrollmentResponseV1Schema.parse({
        ...base,
        acceptedSnapshotSchemaVersions: ["1"]
      }).acceptedSnapshotSchemaVersions
    ).toEqual(["1"]);
    expect(
      EnrollmentResponseV1Schema.safeParse({
        ...base,
        acceptedSnapshotSchemaVersions: ["1", "2"]
      }).success
    ).toBe(false);
  });

  it("enforces credential role prefixes and 256-bit secret encodings", () => {
    expect(
      ContributionCredentialPairV1Schema.safeParse({
        uploadToken: UPLOAD_TOKEN,
        deletionToken: DELETION_TOKEN
      }).success
    ).toBe(true);
    expect(
      ContributionCredentialPairV1Schema.safeParse({
        uploadToken: DELETION_TOKEN,
        deletionToken: UPLOAD_TOKEN
      }).success
    ).toBe(false);
    expect(
      ContributionCredentialPairV1Schema.safeParse({
        uploadToken: `${UPLOAD_TOKEN}x`,
        deletionToken: DELETION_TOKEN
      }).success
    ).toBe(false);
  });

  it("allows a consent event to revoke contribution without weakening enrollment", () => {
    expect(
      ConsentUpdateRequestV1Schema.safeParse({
        contractVersion: 1,
        consent: consent(false)
      }).success
    ).toBe(true);
    expect(
      ResumeRequestV1Schema.safeParse({
        contractVersion: 1,
        consent: consent(false)
      }).success
    ).toBe(false);
  });

  it("requires credentials rotation to return only a fresh typed pair", () => {
    expect(
      CredentialRotationResponseV1Schema.safeParse({
        contractVersion: 1,
        credentials: {
          uploadToken: UPLOAD_TOKEN,
          deletionToken: DELETION_TOKEN
        },
        rotatedAt: RECORDED_AT,
        oldToken: "must-not-be-returned"
      }).success
    ).toBe(false);
  });
});

describe("ingest and lifecycle response contracts", () => {
  function ingestReceipt() {
    return {
      contractVersion: 1,
      batchId: "550e8400-e29b-41d4-a716-446655440000",
      receivedAt: RECORDED_AT,
      replayed: false,
      status: "accepted",
      summary: {
        appliedBuckets: 1,
        staleBuckets: 0,
        idempotentBuckets: 0,
        quarantinedBuckets: 0
      }
    };
  }

  it("accepts a fully accounted accepted ingest receipt", () => {
    expect(IngestReceiptV1Schema.parse(ingestReceipt()).summary.appliedBuckets)
      .toBe(1);
  });

  it("rejects empty, over-counted, and status-inconsistent receipts", () => {
    const empty = ingestReceipt();
    empty.summary.appliedBuckets = 0;
    expect(IngestReceiptV1Schema.safeParse(empty).success).toBe(false);

    const overCounted = ingestReceipt();
    overCounted.summary.appliedBuckets = 30;
    overCounted.summary.staleBuckets = 1;
    expect(IngestReceiptV1Schema.safeParse(overCounted).success).toBe(false);

    const inconsistent = ingestReceipt();
    inconsistent.summary.quarantinedBuckets = 1;
    expect(IngestReceiptV1Schema.safeParse(inconsistent).success).toBe(false);
  });

  it("makes pause semantics explicit and immutable", () => {
    const response = {
      contractVersion: 1,
      status: "paused",
      pausedAt: RECORDED_AT,
      futureUploadsBlocked: true,
      identifiableCurrentDataRetained: true,
      anonymousHistoricalTotalsRetained: true
    };
    expect(PauseResponseV1Schema.safeParse(response).success).toBe(true);
    expect(
      PauseResponseV1Schema.safeParse({
        ...response,
        identifiableCurrentDataRetained: false
      }).success
    ).toBe(false);
  });

  it("binds resume to a fresh affirmative contribution receipt", () => {
    expect(
      ResumeResponseV1Schema.safeParse({
        contractVersion: 1,
        status: "active",
        resumedAt: RECORDED_AT,
        consentReceipt: consentReceipt()
      }).success
    ).toBe(true);
  });

  it("accepts an opaque deletion job and one-time status credential", () => {
    const response = {
      contractVersion: 1,
      jobId: `del_${"j".repeat(22)}`,
      statusToken: STATUS_TOKEN,
      status: "queued",
      requestedAt: RECORDED_AT,
      anonymousHistoricalTotalsRetained: true
    };
    const parsed = DeletionAcceptedResponseV1Schema.parse(response);
    expect(parsed.jobId).not.toContain("installation");
  });

  it.each([
    ["queued", null, true],
    ["running", null, true],
    ["complete", "2026-07-15T18:21:00Z", true],
    ["failed", "2026-07-15T18:21:00Z", true],
    ["complete", null, false],
    ["running", "2026-07-15T18:21:00Z", false]
  ])(
    "validates deletion state %s and terminal timestamp coupling",
    (status, finishedAt, expected) => {
      expect(
        DeletionStatusResponseV1Schema.safeParse({
          contractVersion: 1,
          jobId: `del_${"j".repeat(22)}`,
          status,
          requestedAt: RECORDED_AT,
          finishedAt,
          anonymousHistoricalTotalsRetained: true
        }).success
      ).toBe(expected);
    }
  );

  it("recursively rejects privacy canaries at strict wire boundaries", () => {
    const canary = "PRIVATE-PROMPT-CANARY";
    const body = {
      contractVersion: 1,
      consent: { ...consent(), prompt: canary }
    };
    const result = EnrollmentRequestV1Schema.safeParse(body);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).not.toContain(canary);
    }
  });
});
