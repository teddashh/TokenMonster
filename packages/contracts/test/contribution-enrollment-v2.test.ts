import { describe, expect, it } from "vitest";

import {
  EnrollmentRequestV2Schema,
  EnrollmentResponseV2Schema,
  RecoverableEnrollmentCredentialsV2Schema
} from "../src/index.js";

const NOW = "2026-07-15T18:30:00.000Z";
const PUBLIC = Object.freeze({
  upload: "u".repeat(24),
  deletion: "d".repeat(24),
  recovery: "r".repeat(24)
});
const credentials = Object.freeze({
  uploadToken: `tm_u2_${PUBLIC.upload}.${"U".repeat(43)}`,
  deletionToken: `tm_d2_${PUBLIC.deletion}.${"D".repeat(42)}E`,
  recoveryToken: `tm_r2_${PUBLIC.recovery}.${"R".repeat(42)}I`
});

describe("recoverable contribution enrollment V2", () => {
  it("accepts three independent client-owned 256-bit credentials", () => {
    expect(
      EnrollmentRequestV2Schema.parse({
        contractVersion: 2,
        credentials,
        consent: {
          purpose: "contribution",
          documentRevision: "contribution-2026-07-15",
          granted: true,
          acknowledgedAt: NOW
        }
      })
    ).toMatchObject({ contractVersion: 2, credentials });
  });

  it("rejects role/version drift, short secrets, shared IDs, and extra fields", () => {
    for (const candidate of [
      { ...credentials, uploadToken: credentials.uploadToken.replace("tm_u2_", "tm_u1_") },
      { ...credentials, deletionToken: `tm_d2_${PUBLIC.deletion}.short` },
      {
        ...credentials,
        deletionToken: `tm_d2_${PUBLIC.deletion}.${"D".repeat(42)}B`
      },
      {
        ...credentials,
        recoveryToken: `tm_r2_${PUBLIC.upload}.${"R".repeat(42)}I`
      },
      {
        ...credentials,
        recoveryToken: `tm_r2_${PUBLIC.recovery}.${"U".repeat(43)}`
      },
      { ...credentials, metadata: "forbidden" }
    ]) {
      expect(RecoverableEnrollmentCredentialsV2Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("returns no bearer or stable installation identifier", () => {
    const parsed = EnrollmentResponseV2Schema.parse({
      contractVersion: 2,
      status: "active",
      consentReceipt: {
        receiptId: `cr_${"c".repeat(22)}`,
        purpose: "contribution",
        documentRevision: "contribution-2026-07-15",
        granted: true,
        acknowledgedAt: NOW,
        recordedAt: NOW
      },
      acceptedSnapshotSchemaVersions: ["1", "2"]
    });
    expect(JSON.stringify(parsed)).not.toMatch(/tm_[udr]2_|installation/i);
  });
});
