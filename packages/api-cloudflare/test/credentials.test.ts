import {
  DeletionAcceptedResponseV1Schema,
  EnrollmentResponseV1Schema
} from "@tokenmonster/contracts";
import { describe, expect, it } from "vitest";

import {
  CloudflareAdapterError,
  CloudflareOpaqueIdGenerator,
  createCloudflareCredentialService
} from "../src/index.js";
import {
  credentialConfig,
  key,
  secret,
  signFailingWebCrypto,
  trackedWebCrypto
} from "./helpers.js";

describe("Cloudflare credential service", () => {
  it("issues contract-exact, independently random upload and deletion tokens", async () => {
    const service = await createCloudflareCredentialService(credentialConfig());
    const uploadIds = new Set<string>();
    const deletionIds = new Set<string>();
    const bearerSecrets = new Set<string>();

    for (let index = 0; index < 128; index += 1) {
      const [upload, deletion] = await Promise.all([
        service.issue("upload"),
        service.issue("deletion")
      ]);
      expect(upload.entropyBits).toBe(256);
      expect(deletion.entropyBits).toBe(256);
      expect(upload.bearerToken).toMatch(
        /^tm_u1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}$/
      );
      expect(deletion.bearerToken).toMatch(
        /^tm_d1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}$/
      );
      uploadIds.add(upload.stored.publicTokenId);
      deletionIds.add(deletion.stored.publicTokenId);
      bearerSecrets.add(upload.bearerToken.split(".")[1] ?? "");
      bearerSecrets.add(deletion.bearerToken.split(".")[1] ?? "");
      expect(Object.keys(upload.stored).sort()).toEqual([
        "hmacDigest",
        "hmacKeyId",
        "publicTokenId",
        "scope"
      ]);
      expect(JSON.stringify(upload.stored)).not.toContain(
        upload.bearerToken.split(".")[1]
      );
      expect(JSON.stringify(upload)).not.toContain(upload.bearerToken);
      expect(await service.verify(upload.bearerToken, upload.stored)).toBe(true);
      expect(await service.verify(deletion.bearerToken, deletion.stored)).toBe(
        true
      );
    }

    expect(uploadIds.size).toBe(128);
    expect(deletionIds.size).toBe(128);
    expect(bearerSecrets.size).toBe(256);
    for (const publicId of [...uploadIds, ...deletionIds]) {
      expect(publicId).toMatch(/^[A-Za-z0-9_-]{16,32}$/);
    }
  });

  it("inspect only extracts a public ID and does not authenticate", async () => {
    const tracked = trackedWebCrypto();
    const service = await createCloudflareCredentialService(
      credentialConfig(),
      tracked.port
    );
    const issued = await service.issue("upload");
    const publicId = issued.stored.publicTokenId;
    const forged = `tm_u1_${publicId}.${"A".repeat(43)}`;

    expect(await service.inspect(forged)).toEqual({ publicTokenId: publicId });
    expect(tracked.verifyCalls()).toBe(0);
    expect(await service.verify(forged, issued.stored)).toBe(false);
    expect(await service.inspect(`tm_x1_${publicId}.${"A".repeat(43)}`)).toBeNull();
    expect(await service.inspect("not-a-token")).toBeNull();
  });

  it("verifies with crypto.subtle.verify and enforces credential scope", async () => {
    const tracked = trackedWebCrypto();
    const service = await createCloudflareCredentialService(
      credentialConfig(),
      tracked.port
    );
    const upload = await service.issue("upload");

    expect(await service.verify(upload.bearerToken, upload.stored)).toBe(true);
    expect(tracked.verifyCalls()).toBe(1);
    expect(
      await service.verify(upload.bearerToken.replace("tm_u1_", "tm_d1_"), {
        ...upload.stored,
        scope: "deletion"
      })
    ).toBe(false);
    expect(tracked.verifyCalls()).toBe(2);
    expect(
      await service.verify(upload.bearerToken, {
        ...upload.stored,
        publicTokenId: `A${upload.stored.publicTokenId.slice(1)}`
      })
    ).toBe(false);
    expect(tracked.verifyCalls()).toBe(2);
  });

  it("supports a current and previous pepper rotation window", async () => {
    const pepperV1 = key("credential-v1", 1);
    const pepperV2 = key("credential-v2", 2);
    const oldService = await createCloudflareCredentialService(
      credentialConfig(pepperV1)
    );
    const oldCredential = await oldService.issue("upload");
    const rotatingService = await createCloudflareCredentialService(
      credentialConfig(pepperV2, pepperV1)
    );
    const newCredential = await rotatingService.issue("upload");

    expect(await rotatingService.verify(oldCredential.bearerToken, oldCredential.stored)).toBe(
      true
    );
    expect(newCredential.stored.hmacKeyId).toBe("credential-v2");
    expect(await rotatingService.verify(newCredential.bearerToken, newCredential.stored)).toBe(
      true
    );
  });

  it("accepts canonical client-owned V2 credentials and binds role plus version into each verifier", async () => {
    const pepperV1 = key("credential-v1", 1);
    const pepperV2 = key("credential-v2", 2);
    const first = await createCloudflareCredentialService(
      credentialConfig(pepperV1)
    );
    const uploadToken = `tm_u2_${"u".repeat(24)}.${"U".repeat(43)}`;
    const deletionToken = `tm_d2_${"d".repeat(24)}.${"D".repeat(42)}E`;
    const recoveryToken = `tm_r2_${"r".repeat(24)}.${"R".repeat(42)}I`;
    const [upload, deletion, recovery] = await Promise.all([
      first.acceptPresentedV2("upload", uploadToken),
      first.acceptPresentedV2("deletion", deletionToken),
      first.acceptPresentedV2("enrollment-recovery", recoveryToken)
    ]);

    expect(JSON.stringify({ upload, deletion, recovery })).not.toContain(
      uploadToken.split(".")[1]
    );
    expect(await first.verify(uploadToken, upload)).toBe(true);
    expect(await first.verify(deletionToken, deletion)).toBe(true);
    expect(await first.verify(recoveryToken, recovery)).toBe(true);
    expect(
      await first.verify(uploadToken.replace("tm_u2_", "tm_u1_"), upload)
    ).toBe(false);
    expect(
      await first.verify(uploadToken.replace("tm_u2_", "tm_d2_"), deletion)
    ).toBe(false);

    const rotating = await createCloudflareCredentialService(
      credentialConfig(pepperV2, pepperV1)
    );
    expect(await rotating.verify(uploadToken, upload)).toBe(true);
    expect(await rotating.verify(deletionToken, deletion)).toBe(true);
    expect(await rotating.verify(recoveryToken, recovery)).toBe(true);
    expect(
      (await rotating.acceptPresentedV2("upload", uploadToken)).hmacKeyId
    ).toBe("credential-v2");
  });

  it("rejects non-canonical or role-substituted V2 bearer encodings", async () => {
    const service = await createCloudflareCredentialService(credentialConfig());
    await expect(
      service.acceptPresentedV2(
        "upload",
        `tm_u2_${"u".repeat(24)}.${"A".repeat(42)}B`
      )
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      service.acceptPresentedV2(
        "enrollment-recovery",
        `tm_u2_${"u".repeat(24)}.${"A".repeat(43)}`
      )
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("rejects a verifier created under a wrong pepper even when the key ID matches", async () => {
    const correct = await createCloudflareCredentialService(
      credentialConfig(key("credential-v1", 1))
    );
    const wrong = await createCloudflareCredentialService(
      credentialConfig(key("credential-v1", 99))
    );
    const issued = await correct.issue("deletion");

    expect(await wrong.verify(issued.bearerToken, issued.stored)).toBe(false);
  });

  it("derives a job-bound deletion status credential byte-identically across replay and pepper rotation", async () => {
    const firstService = await createCloudflareCredentialService(
      credentialConfig(key("credential-v1", 1))
    );
    const rotatedService = await createCloudflareCredentialService(
      credentialConfig(
        key("credential-v2", 2),
        key("credential-v1", 1)
      )
    );
    const jobId = `del_${"A".repeat(22)}`;
    const first = await firstService.issueDeletionStatus(jobId);
    const replay = await firstService.issueDeletionStatus(jobId);
    const afterRotation = await rotatedService.issueDeletionStatus(jobId);
    const another = await firstService.issueDeletionStatus(
      `del_${"B".repeat(22)}`
    );

    expect(replay).toEqual(first);
    expect(afterRotation).toEqual(first);
    expect(replay.bearerToken).toBe(first.bearerToken);
    expect(afterRotation.bearerToken).toBe(first.bearerToken);
    expect(another).not.toEqual(first);
    expect(first.bearerToken).toMatch(
      /^tm_s1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}$/
    );
    expect(first.stored.hmacKeyId).toBe("deletion-status-v1");
    expect(await firstService.verify(first.bearerToken, first.stored)).toBe(
      true
    );
    await expect(
      firstService.issueDeletionStatus("del_not-valid")
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("derives deterministic, non-identifier suppression markers with an independent key", async () => {
    const service = await createCloudflareCredentialService(credentialConfig());
    const installationId = `ins_${"C".repeat(22)}`;
    const first = await service.deriveSuppressionMarker(installationId);
    const second = await service.deriveSuppressionMarker(installationId);

    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain(installationId);
    await expect(
      service.deriveSuppressionMarker("ins_invalid")
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("produces outputs accepted by the contribution response schemas", async () => {
    const service = await createCloudflareCredentialService(credentialConfig());
    const ids = new CloudflareOpaqueIdGenerator();
    const [upload, deletion] = await Promise.all([
      service.issue("upload"),
      service.issue("deletion")
    ]);
    const timestamp = "2026-07-15T18:30:00.000Z";
    const enrollment = {
      contractVersion: 1,
      credentials: {
        uploadToken: upload.bearerToken,
        deletionToken: deletion.bearerToken
      },
      consentReceipt: {
        receiptId: ids.generate("consent-event"),
        purpose: "contribution",
        documentRevision: "contribution-2026-07-15",
        granted: true,
        acknowledgedAt: timestamp,
        recordedAt: timestamp
      },
      acceptedSnapshotSchemaVersions: ["1"]
    };
    const jobId = ids.generate("deletion-job");
    const status = await service.issueDeletionStatus(jobId);
    const deletionResponse = {
      contractVersion: 1,
      jobId,
      statusToken: status.bearerToken,
      status: "queued",
      requestedAt: timestamp,
      anonymousHistoricalTotalsRetained: true
    };

    expect(EnrollmentResponseV1Schema.safeParse(enrollment).success).toBe(true);
    expect(
      DeletionAcceptedResponseV1Schema.safeParse(deletionResponse).success
    ).toBe(true);
  });

  it("rejects unknown fields, duplicate purpose keys, and non-canonical key material", async () => {
    await expect(
      createCloudflareCredentialService({
        ...credentialConfig(),
        unexpected: true
      })
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      createCloudflareCredentialService({
        ...credentialConfig(),
        currentPepper: {
          ...key("credential-v2", 2),
          unexpected: true
        }
      })
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      createCloudflareCredentialService({
        ...credentialConfig(),
        suppressionKey: key("credential-v2", 2)
      })
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      createCloudflareCredentialService({
        ...credentialConfig(),
        currentPepper: { keyId: "credential-v2", secret: `${secret(2)}A` }
      })
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("does not expose secret configuration through service or error serialization", async () => {
    const config = credentialConfig();
    const service = await createCloudflareCredentialService(config);
    const serialized = JSON.stringify(service);

    expect(serialized).toBe('{"name":"CloudflareCredentialService"}');
    expect(serialized).not.toContain(config.currentPepper.secret);
    const canary = "credential-canary-that-must-not-escape";
    let caught: unknown;
    try {
      await createCloudflareCredentialService({
        ...config,
        currentPepper: { keyId: "credential-v2", secret: canary }
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CloudflareAdapterError);
    expect(JSON.stringify(caught)).not.toContain(canary);
    expect(String(caught)).not.toContain(canary);
  });

  it("sanitizes Web Crypto failures without exposing the platform exception", async () => {
    const canary = "raw-crypto-platform-canary";
    const service = await createCloudflareCredentialService(
      credentialConfig(),
      signFailingWebCrypto(canary)
    );
    let caught: unknown;
    try {
      await service.issue("upload");
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "CRYPTO_OPERATION_FAILED",
      message: "The Web Crypto operation failed."
    });
    expect(JSON.stringify(caught)).not.toContain(canary);
    expect(String(caught)).not.toContain(canary);
  });
});
