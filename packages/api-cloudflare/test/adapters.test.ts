import { describe, expect, it } from "vitest";

import {
  CloudflareClock,
  CloudflareOpaqueIdGenerator,
  createCloudflareContributionPolicy,
  createNonReversibleRateLimitKeyDeriver,
  type WebCryptoPort
} from "../src/index.js";
import { key, rateConfig, signFailingWebCrypto } from "./helpers.js";

describe("Cloudflare opaque IDs and clock", () => {
  it("generates exact 22-character random bodies without collisions", () => {
    const ids = new CloudflareOpaqueIdGenerator();
    const installations = new Set<string>();
    const consentEvents = new Set<string>();
    const deletionJobs = new Set<string>();

    for (let index = 0; index < 512; index += 1) {
      installations.add(ids.generate("installation"));
      consentEvents.add(ids.generate("consent-event"));
      deletionJobs.add(ids.generate("deletion-job"));
    }

    expect(installations.size).toBe(512);
    expect(consentEvents.size).toBe(512);
    expect(deletionJobs.size).toBe(512);
    expect([...installations].every((id) => /^ins_[A-Za-z0-9_-]{22}$/.test(id))).toBe(
      true
    );
    expect([...consentEvents].every((id) => /^cr_[A-Za-z0-9_-]{22}$/.test(id))).toBe(
      true
    );
    expect([...deletionJobs].every((id) => /^del_[A-Za-z0-9_-]{22}$/.test(id))).toBe(
      true
    );
  });

  it("fails with fixed errors for invalid kinds or failed randomness", () => {
    const ids = new CloudflareOpaqueIdGenerator();
    expect(() => ids.generate("unknown" as "installation")).toThrowError(
      expect.objectContaining({ code: "INPUT_INVALID" })
    );
    const failed = new CloudflareOpaqueIdGenerator({
      getRandomValues: () => {
        throw new Error("raw-runtime-canary");
      },
      subtle: globalThis.crypto.subtle
    } as WebCryptoPort);
    expect(() => failed.generate("installation")).toThrowError(
      expect.objectContaining({
        code: "CRYPTO_OPERATION_FAILED",
        message: "The Web Crypto operation failed."
      })
    );
  });

  it("returns an independent current Date", () => {
    const clock = new CloudflareClock();
    const before = Date.now();
    const first = clock.now();
    const second = clock.now();
    const after = Date.now();

    expect(first).toBeInstanceOf(Date);
    expect(first.getTime()).toBeGreaterThanOrEqual(before);
    expect(second.getTime()).toBeLessThanOrEqual(after);
    expect(second).not.toBe(first);
  });
});

describe("Cloudflare contribution policy", () => {
  const config = {
    currentConsentDocumentRevision: "contribution-2026-07-15",
    supportedCollectors: [
      {
        kind: "tokscale",
        adapterVersion: "0.1.0",
        sourceVersion: "4.5.2"
      },
      {
        kind: "tokentracker-bridge",
        adapterVersion: "0.1.0",
        sourceVersion: "0.79.8"
      },
      {
        kind: "tokentracker-sidecar",
        adapterVersion: "0.1.0",
        sourceVersion: "0.80.0"
      }
    ]
  } as const;

  it("accepts only the exact reviewed collector identities", () => {
    const policy = createCloudflareContributionPolicy(config);

    expect(policy.currentConsentDocumentRevision).toBe(
      "contribution-2026-07-15"
    );
    expect(policy.isCollectorSupported(config.supportedCollectors[0])).toBe(true);
    expect(policy.isCollectorSupported(config.supportedCollectors[2])).toBe(true);
    expect(
      policy.isCollectorSupported({
        ...config.supportedCollectors[0],
        sourceVersion: "4.5.3"
      })
    ).toBe(false);
    expect(
      policy.isCollectorSupported({
        ...config.supportedCollectors[2],
        sourceVersion: "0.80.1"
      })
    ).toBe(false);
    expect(
      policy.isCollectorSupported({
        ...config.supportedCollectors[2],
        adapterVersion: "0.1.1"
      })
    ).toBe(false);
  });

  it("strictly rejects unknown fields, invalid dates, and duplicate entries", () => {
    expect(() =>
      createCloudflareContributionPolicy({ ...config, unexpected: true })
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() =>
      createCloudflareContributionPolicy({
        ...config,
        currentConsentDocumentRevision: "contribution-2026-02-30"
      })
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() =>
      createCloudflareContributionPolicy({
        ...config,
        supportedCollectors: [
          config.supportedCollectors[0],
          config.supportedCollectors[0]
        ]
      })
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() =>
      createCloudflareContributionPolicy({
        ...config,
        supportedCollectors: [
          { ...config.supportedCollectors[0], unexpected: true }
        ]
      })
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() =>
      createCloudflareContributionPolicy({
        ...config,
        supportedCollectors: [
          {
            kind: "tokentracker-cli",
            adapterVersion: "0.1.0",
            sourceVersion: "0.80.0"
          }
        ]
      })
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() =>
      createCloudflareContributionPolicy({
        ...config,
        supportedCollectors: [
          {
            kind: "tokentracker-sidecar",
            adapterVersion: "latest",
            sourceVersion: "0.80.0"
          }
        ]
      })
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});

describe("non-reversible Cloudflare rate-limit keys", () => {
  it("derives deterministic, route-separated keys without returning raw edge or bearer input", async () => {
    const deriver = await createNonReversibleRateLimitKeyDeriver(rateConfig());
    const edge = "203.0.113.0/24";
    const upload = `tm_u1_${"A".repeat(24)}.${"B".repeat(42)}A`;
    const deletion = `tm_d1_${"C".repeat(24)}.${"D".repeat(42)}A`;
    const enrollmentKey = await deriver.deriveEnrollmentEdgeKey(edge);
    const ingestKey = await deriver.deriveIngestTokenKey(upload);
    const deletionKey = await deriver.deriveDeletionTokenKey(deletion);

    expect(enrollmentKey).toMatch(/^rl_e1_[A-Za-z0-9_-]{43}$/);
    expect(ingestKey).toMatch(/^rl_i1_[A-Za-z0-9_-]{43}$/);
    expect(deletionKey).toMatch(/^rl_d1_[A-Za-z0-9_-]{43}$/);
    expect(await deriver.deriveEnrollmentEdgeKey(edge)).toBe(enrollmentKey);
    expect(new Set([enrollmentKey, ingestKey, deletionKey]).size).toBe(3);
    expect(`${enrollmentKey}${ingestKey}${deletionKey}`).not.toContain(edge);
    expect(`${enrollmentKey}${ingestKey}${deletionKey}`).not.toContain(upload);
    expect(`${enrollmentKey}${ingestKey}${deletionKey}`).not.toContain(deletion);
  });

  it("accepts canonical V2 role credentials without changing rate-key classes", async () => {
    const deriver = await createNonReversibleRateLimitKeyDeriver(rateConfig());
    const upload = `tm_u2_${"u".repeat(24)}.${"U".repeat(43)}`;
    const deletion = `tm_d2_${"d".repeat(24)}.${"D".repeat(42)}E`;

    expect(await deriver.deriveIngestTokenKey(upload)).toMatch(/^rl_i1_/u);
    expect(await deriver.deriveDeletionTokenKey(deletion)).toMatch(/^rl_d1_/u);
    await expect(
      deriver.deriveIngestTokenKey(
        `tm_u2_${"u".repeat(24)}.${"A".repeat(42)}B`
      )
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("uses independent HMAC purpose keys", async () => {
    const initialConfig = rateConfig();
    const rotatedConfig = {
      ...initialConfig,
      ingestTokenKey: key("rate-ingest-v2", 83)
    };
    const first = await createNonReversibleRateLimitKeyDeriver(initialConfig);
    const rotated = await createNonReversibleRateLimitKeyDeriver(rotatedConfig);
    const edge = "198.51.100.0/24";
    const upload = `tm_u1_${"E".repeat(24)}.${"F".repeat(42)}A`;
    const deletion = `tm_d1_${"G".repeat(24)}.${"H".repeat(42)}A`;

    expect(await first.deriveEnrollmentEdgeKey(edge)).toBe(
      await rotated.deriveEnrollmentEdgeKey(edge)
    );
    expect(await first.deriveDeletionTokenKey(deletion)).toBe(
      await rotated.deriveDeletionTokenKey(deletion)
    );
    expect(await first.deriveIngestTokenKey(upload)).not.toBe(
      await rotated.deriveIngestTokenKey(upload)
    );
  });

  it("rejects raw-input mistakes, unknown config, and reused purpose keys", async () => {
    const deriver = await createNonReversibleRateLimitKeyDeriver(rateConfig());
    const deletion = `tm_d1_${"I".repeat(24)}.${"J".repeat(42)}A`;

    await expect(deriver.deriveEnrollmentEdgeKey(" edge ")).rejects.toMatchObject({
      code: "INPUT_INVALID"
    });
    await expect(deriver.deriveIngestTokenKey(deletion)).rejects.toMatchObject({
      code: "INPUT_INVALID"
    });
    await expect(
      createNonReversibleRateLimitKeyDeriver({
        ...rateConfig(),
        unexpected: true
      })
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const reused = key("shared-rate-key", 91);
    await expect(
      createNonReversibleRateLimitKeyDeriver({
        enrollmentEdgeKey: reused,
        ingestTokenKey: reused,
        deletionTokenKey: key("rate-delete", 92)
      })
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("serializes no key material", async () => {
    const config = rateConfig();
    const deriver = await createNonReversibleRateLimitKeyDeriver(config);
    const serialized = JSON.stringify(deriver);

    expect(serialized).toBe(
      '{"name":"NonReversibleRateLimitKeyDeriver"}'
    );
    for (const value of Object.values(config)) {
      expect(serialized).not.toContain(value.secret);
    }
  });

  it("sanitizes rate-key Web Crypto failures", async () => {
    const canary = "raw-rate-crypto-canary";
    const deriver = await createNonReversibleRateLimitKeyDeriver(
      rateConfig(),
      signFailingWebCrypto(canary)
    );
    let caught: unknown;
    try {
      await deriver.deriveEnrollmentEdgeKey("203.0.113.0/24");
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "CRYPTO_OPERATION_FAILED",
      message: "The Web Crypto operation failed."
    });
    expect(String(caught)).not.toContain(canary);
  });
});
