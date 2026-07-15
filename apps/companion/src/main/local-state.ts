import type {
  LocalCompanionConfigV1,
  LocalStore
} from "@tokenmonster/local-store";
import type { CharacterId } from "@tokenmonster/characters";

import type { LocalRuntimeStatus } from "../shared/ipc.js";
import type { ContributionActionResult } from "../shared/ipc.js";

export async function stopContributionForLocalSourceReset(
  contribution: Readonly<{ stop(): Promise<ContributionActionResult> }>
): Promise<void> {
  const result = await contribution.stop();
  if (
    !result.ok ||
    result.status.enabled ||
    result.status.outboxPending !== 0 ||
    result.status.state === "active"
  ) {
    throw new Error("CONTRIBUTION_STOP_FAILED");
  }
}

export function resolveCompanionTimezone(input: unknown): string {
  if (typeof input === "string" && input.length >= 1 && input.length <= 64) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: input }).format(0);
      return input;
    } catch {
      // UTC is the content-free fallback when the host timezone is unusable.
    }
  }
  return "UTC";
}

export function initializeLocalConfig(
  store: LocalStore,
  hostTimezone: unknown
): LocalCompanionConfigV1 {
  const existing = store.getConfig();
  if (existing !== null) return existing;
  return store.saveConfig({
    schemaVersion: "1",
    locale: "zh-TW",
    timezone: resolveCompanionTimezone(hostTimezone),
    selectedCharacterId: "chatgpt",
    collectionIntervalMinutes: 30,
    startAtLogin: false,
    animationsEnabled: true
  });
}

export function saveSelectedCharacter(
  store: LocalStore,
  characterId: CharacterId
): LocalCompanionConfigV1 {
  const existing = initializeLocalConfig(store, "UTC");
  return store.saveConfig({ ...existing, selectedCharacterId: characterId });
}

export function localRuntimeStatus(
  store: LocalStore,
  lastSuccessfulScanAt: string | null
): LocalRuntimeStatus {
  const diagnostic = store.getDiagnosticSummary();
  const authority = diagnostic.collectorAuthority;
  const state =
    authority.configured === false
      ? ("not-configured" as const)
      : authority.state === "running"
        ? ("running" as const)
        : authority.state === "degraded"
          ? ("degraded" as const)
          : ("stopped" as const);
  return Object.freeze({
    storage: "ready" as const,
    state,
    dailyAggregateRows: diagnostic.counts.dailyAggregates,
    lastSuccessfulScanAt
  });
}
