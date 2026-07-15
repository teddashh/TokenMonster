import type { ContributionPolicy } from "@tokenmonster/api-domain";
import type { CollectorIdentityV1 } from "@tokenmonster/contracts";

import { asStrictRecord } from "./config.js";
import {
  CloudflareAdapterError,
  sanitizeConfigFailure
} from "./errors.js";

const CONSENT_REVISION_PATTERN =
  /^contribution-(20\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface SupportedCollectorConfig {
  readonly kind: CollectorIdentityV1["kind"];
  readonly adapterVersion: string;
  readonly sourceVersion: string;
}

export interface CloudflareContributionPolicyConfig {
  readonly currentConsentDocumentRevision: string;
  readonly supportedCollectors: readonly SupportedCollectorConfig[];
}

function isValidConsentRevision(value: string): boolean {
  if (!CONSENT_REVISION_PATTERN.test(value)) return false;
  const date = value.slice("contribution-".length);
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed) &&
    parsed >= Date.parse("2020-01-01T00:00:00.000Z") &&
    parsed < Date.parse("2100-01-01T00:00:00.000Z") &&
    new Date(parsed).toISOString().slice(0, 10) === date
  );
}

function collectorKey(input: SupportedCollectorConfig): string {
  return `${input.kind}\u0000${input.adapterVersion}\u0000${input.sourceVersion}`;
}

function parsePolicyConfig(input: unknown): CloudflareContributionPolicyConfig {
  const record = asStrictRecord(input, [
    "currentConsentDocumentRevision",
    "supportedCollectors"
  ]);
  const revision = record["currentConsentDocumentRevision"];
  const collectors = record["supportedCollectors"];
  if (
    typeof revision !== "string" ||
    !isValidConsentRevision(revision) ||
    !Array.isArray(collectors) ||
    collectors.length < 1 ||
    collectors.length > 8
  ) {
    throw new CloudflareAdapterError("CONFIG_INVALID");
  }
  const parsed = collectors.map((collector) => {
    const entry = asStrictRecord(collector, [
      "kind",
      "adapterVersion",
      "sourceVersion"
    ]);
    const kind = entry["kind"];
    const adapterVersion = entry["adapterVersion"];
    const sourceVersion = entry["sourceVersion"];
    if (
      (kind !== "tokscale" && kind !== "tokentracker-bridge") ||
      typeof adapterVersion !== "string" ||
      !SEMVER_PATTERN.test(adapterVersion) ||
      typeof sourceVersion !== "string" ||
      !SEMVER_PATTERN.test(sourceVersion)
    ) {
      throw new CloudflareAdapterError("CONFIG_INVALID");
    }
    return Object.freeze({ kind, adapterVersion, sourceVersion });
  });
  if (new Set(parsed.map(collectorKey)).size !== parsed.length) {
    throw new CloudflareAdapterError("CONFIG_INVALID");
  }
  return Object.freeze({
    currentConsentDocumentRevision: revision,
    supportedCollectors: Object.freeze(parsed)
  });
}

class WorkerContributionPolicy implements ContributionPolicy {
  readonly currentConsentDocumentRevision: string;
  readonly #supportedCollectors: ReadonlySet<string>;

  constructor(config: CloudflareContributionPolicyConfig) {
    this.currentConsentDocumentRevision =
      config.currentConsentDocumentRevision;
    this.#supportedCollectors = new Set(
      config.supportedCollectors.map(collectorKey)
    );
  }

  isCollectorSupported(collector: CollectorIdentityV1): boolean {
    try {
      if (
        typeof collector !== "object" ||
        collector === null ||
        Reflect.ownKeys(collector).length !== 3 ||
        (collector.kind !== "tokscale" &&
          collector.kind !== "tokentracker-bridge") ||
        typeof collector.adapterVersion !== "string" ||
        typeof collector.sourceVersion !== "string"
      ) {
        return false;
      }
      return this.#supportedCollectors.has(collectorKey(collector));
    } catch {
      return false;
    }
  }
}

export function createCloudflareContributionPolicy(
  input: unknown
): ContributionPolicy {
  try {
    return Object.freeze(
      new WorkerContributionPolicy(parsePolicyConfig(input))
    );
  } catch (error: unknown) {
    sanitizeConfigFailure(error);
  }
}
