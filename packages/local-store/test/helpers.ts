import { randomUUID } from "node:crypto";

import type {
  IngestReceiptV1,
  IngestSnapshotV1,
  TokenCountsV1
} from "@tokenmonster/contracts";
import type { MonsterStateV1 } from "@tokenmonster/monster-engine";

import type {
  LocalCompanionConfigV1,
  ProjectedDailyAggregate
} from "../src/index.js";

export const NOW = "2026-07-15T18:00:00.000Z";

export function fixedClock(): () => Date {
  return () => new Date(NOW);
}

export const BASE_TOKENS: TokenCountsV1 = Object.freeze({
  input: "1200",
  output: "500",
  cacheRead: "800",
  cacheWrite: "0",
  reasoning: "120",
  other: "0",
  total: "2500"
});

export function dailyAggregate(
  overrides: Partial<ProjectedDailyAggregate> = {}
): ProjectedDailyAggregate {
  return {
    bucketStart: "2026-07-15T00:00:00.000Z",
    provider: "openai",
    modelFamily: "gpt-5",
    tool: "codex-cli",
    valueQuality: "exact",
    tokens: BASE_TOKENS,
    localCoverage: "complete",
    collector: {
      kind: "tokscale",
      adapterVersion: "0.1.0",
      sourceVersion: "4.5.2"
    },
    ...overrides
  };
}

export function zeroTokens(): TokenCountsV1 {
  return {
    input: "0",
    output: "0",
    cacheRead: "0",
    cacheWrite: "0",
    reasoning: "0",
    other: "0",
    total: "0"
  };
}

export function validConfig(): LocalCompanionConfigV1 {
  return {
    schemaVersion: "1",
    locale: "zh-TW",
    timezone: "America/New_York",
    selectedCharacterId: "chatgpt",
    collectionIntervalMinutes: 30,
    startAtLogin: false,
    animationsEnabled: true
  };
}

export function learningMonsterState(
  overrides: Partial<MonsterStateV1> = {}
): MonsterStateV1 {
  return {
    schemaVersion: "1",
    engineVersion: "0.1.0",
    characterId: "chatgpt",
    window: {
      from: "2026-06-18",
      to: "2026-07-15",
      timezone: "America/New_York"
    },
    identityStatus: "learning",
    coverageBand: "insufficient",
    identityExplanationId: "monster-v1:2026-07-15:identity:0",
    identityContinuity: {
      schemaVersion: "1",
      lastIdentityReviewDate: "2026-07-15",
      provisional: true
    },
    traits: [],
    mood: {
      id: "learning",
      explanationId: "monster-v1:2026-07-15:mood:0"
    },
    evolution: {
      cadence: "event",
      event: "awaiting-coverage",
      explanationId: "monster-v1:2026-07-15:evolution:0"
    },
    appearance: {
      energyBand: "dormant"
    },
    ...overrides
  };
}

export function ingestSnapshot(
  overrides: Partial<IngestSnapshotV1> = {}
): IngestSnapshotV1 {
  return {
    schemaVersion: "1",
    batchId: randomUUID(),
    generatedAt: NOW,
    collector: {
      kind: "tokscale",
      adapterVersion: "0.1.0",
      sourceVersion: "4.5.2"
    },
    buckets: [
      {
        bucketStart: "2026-07-15T00:00:00.000Z",
        provider: "openai",
        modelFamily: "gpt-5",
        tool: "codex-cli",
        valueQuality: "exact",
        revision: 1,
        tokens: BASE_TOKENS
      }
    ],
    ...overrides
  };
}

export function ingestReceipt(
  snapshot: IngestSnapshotV1,
  overrides: Partial<IngestReceiptV1> = {}
): IngestReceiptV1 {
  return {
    contractVersion: 1,
    batchId: snapshot.batchId,
    receivedAt: NOW,
    replayed: false,
    status: "accepted",
    summary: {
      appliedBuckets: snapshot.buckets.length,
      staleBuckets: 0,
      idempotentBuckets: 0,
      quarantinedBuckets: 0
    },
    ...overrides
  };
}
