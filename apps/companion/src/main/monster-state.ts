import type { CharacterId } from "@tokenmonster/characters";
import type {
  StoredDailyAggregate,
  LocalStore,
} from "@tokenmonster/local-store";
import {
  deriveMonsterState,
  type ContentBlindFootprintV1,
  type MonsterStateV1,
  type MonsterTraitIdV1,
} from "@tokenmonster/monster-engine";

import type { MonsterRuntimeSummary, MonsterTraitId } from "../shared/ipc.js";

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 28;
const MAX_FOOTPRINT_ROWS = 1_000;
// Monster analytics have one continuity timeline. The chosen letter character
// is presentation only and must never create a fresh analytical identity.
const ANALYTICAL_STATE_CHARACTER_ID: CharacterId = "chatgpt";
const DISCLOSURE =
  "特質只根據這台裝置已成功收集的 28 個 UTC 日期彙總；未掃描的日期是 unavailable，不會被當成零用量，也不推測任務、專案或生產力。";

const TRAIT_COPY: Readonly<
  Record<MonsterTraitIdV1, Readonly<{ label: string; reason: string }>>
> = Object.freeze({
  "cli-focused": Object.freeze({
    label: "CLI 專注型",
    reason: "已收集足跡主要來自核准的 CLI 工具。",
  }),
  "tool-focused": Object.freeze({
    label: "工具專注型",
    reason: "已收集足跡集中在一個主要工具類別。",
  }),
  "multi-tool": Object.freeze({
    label: "多工具切換型",
    reason: "至少兩個工具類別在已收集足跡中占有實質比例。",
  }),
  "provider-focused": Object.freeze({
    label: "供應商專注型",
    reason: "已收集足跡主要集中在一個供應商類別。",
  }),
  "multi-provider": Object.freeze({
    label: "多供應商型",
    reason: "至少兩個供應商類別在已收集足跡中占有實質比例。",
  }),
  "cache-savvy": Object.freeze({
    label: "Cache 節奏型",
    reason: "有足夠 cache 觀測覆蓋，且 cache-read 比例達到固定門檻。",
  }),
  "output-heavy": Object.freeze({
    label: "輸出導向型",
    reason: "輸出 Token 在可比較的輸入／輸出足跡中占較高比例。",
  }),
  "night-oriented": Object.freeze({
    label: "深夜節奏型",
    reason: "只有具時區與 DST 品質的本機小時資料達門檻才會出現。",
  }),
  balanced: Object.freeze({
    label: "平衡探索型",
    reason: "目前供應商分布未達專注或多供應商的固定門檻。",
  }),
});

const MOOD_LABELS: Readonly<Record<MonsterStateV1["mood"]["id"], string>> =
  Object.freeze({
    learning: "正在認識你的節奏",
    unknown: "今天的足跡尚未完整",
    resting: "今天在休息",
    quiet: "今天比較安靜",
    steady: "今天節奏穩定",
    lively: "今天很有精神",
  });

function utcDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function windowAt(now: Date): Readonly<{
  from: string;
  to: string;
  timezone: "UTC";
}> {
  const toTimestamp = Date.parse(
    `${now.toISOString().slice(0, 10)}T00:00:00.000Z`,
  );
  return Object.freeze({
    from: utcDate(toTimestamp - (WINDOW_DAYS - 1) * DAY_MS),
    to: utcDate(toTimestamp),
    timezone: "UTC" as const,
  });
}

function fallbackSummary(
  characterId: CharacterId,
  now: Date,
): MonsterRuntimeSummary {
  return Object.freeze({
    characterId,
    identityStatus: "learning" as const,
    coverage: "insufficient" as const,
    mood: "learning" as const,
    moodLabel: MOOD_LABELS.learning,
    energy: "dormant" as const,
    evolution: "awaiting-coverage" as const,
    window: windowAt(now),
    traits: Object.freeze([]),
    disclosure: DISCLOSURE,
  });
}

function footprintRows(
  store: LocalStore,
  window: ReturnType<typeof windowAt>,
): readonly StoredDailyAggregate[] {
  const fromInclusive = `${window.from}T00:00:00.000Z`;
  const toExclusive = new Date(
    Date.parse(`${window.to}T00:00:00.000Z`) + DAY_MS,
  ).toISOString();
  const rows = store.listDailyAggregates({
    fromInclusive,
    toExclusive,
    limit: MAX_FOOTPRINT_ROWS,
  });
  if (rows.length >= MAX_FOOTPRINT_ROWS) {
    throw new Error("MONSTER_FOOTPRINT_TOO_LARGE");
  }
  return rows;
}

function buildFootprint(store: LocalStore, now: Date): ContentBlindFootprintV1 {
  const window = windowAt(now);
  const rowsByDate = new Map<string, StoredDailyAggregate[]>();
  for (const row of footprintRows(store, window)) {
    if (row.localCoverage !== "complete") continue;
    const date = row.bucketStart.slice(0, 10);
    const current = rowsByDate.get(date) ?? [];
    current.push(row);
    rowsByDate.set(date, current);
  }
  const start = Date.parse(`${window.from}T00:00:00.000Z`);
  return {
    schemaVersion: "1",
    characterId: ANALYTICAL_STATE_CHARACTER_ID,
    window,
    days: Array.from({ length: WINDOW_DAYS }, (_, index) => {
      const localDate = utcDate(start + index * DAY_MS);
      const rows = rowsByDate.get(localDate) ?? [];
      const completeScan = store.getCompleteDailyScanCoverage({
        utcDate: localDate,
      }).complete;
      return {
        localDate,
        coverage: completeScan ? "observed" : "unavailable",
        aggregates: completeScan
          ? rows.map((row) => ({
              provider: row.provider,
              modelFamily: row.modelFamily,
              tool: row.tool,
              valueQuality: row.valueQuality,
              cacheReadAvailability:
                row.collector.kind === "tokscale" ||
                row.tokens.cacheRead !== "0"
                  ? "observed"
                  : "unavailable",
              tokens: { ...row.tokens },
            }))
          : [],
      };
    }),
  } as ContentBlindFootprintV1;
}

function usablePreviousState(
  state: MonsterStateV1,
  nextWindow: ContentBlindFootprintV1["window"],
): MonsterStateV1 | null {
  if (
    state.characterId !== ANALYTICAL_STATE_CHARACTER_ID ||
    state.window.timezone !== "UTC" ||
    nextWindow.timezone !== "UTC"
  ) {
    return null;
  }
  const nextTo = Date.parse(`${nextWindow.to}T00:00:00.000Z`);
  const previousTo = Date.parse(`${state.window.to}T00:00:00.000Z`);
  return previousTo === nextTo || previousTo === nextTo - DAY_MS ? state : null;
}

function summaryFromState(
  state: MonsterStateV1,
  presentationCharacterId: CharacterId,
): MonsterRuntimeSummary {
  return Object.freeze({
    characterId: presentationCharacterId,
    identityStatus: state.identityStatus,
    coverage: state.coverageBand,
    mood: state.mood.id,
    moodLabel: MOOD_LABELS[state.mood.id],
    energy: state.appearance.energyBand,
    evolution: state.evolution.event,
    window: Object.freeze({
      from: state.window.from,
      to: state.window.to,
      timezone: "UTC" as const,
    }),
    traits: Object.freeze(
      state.traits.map(({ id }) => {
        const copy = TRAIT_COPY[id];
        return Object.freeze({
          id: id as MonsterTraitId,
          label: copy.label,
          reason: copy.reason,
        });
      }),
    ),
    disclosure: DISCLOSURE,
  });
}

export function deriveLocalMonsterSummary(
  store: LocalStore,
  characterId: CharacterId,
  now: Date = new Date(),
): MonsterRuntimeSummary {
  const safeNow =
    now instanceof Date && Number.isFinite(now.getTime())
      ? new Date(now.getTime())
      : new Date("2020-01-28T00:00:00.000Z");
  try {
    const footprint = buildFootprint(store, safeNow);
    const stored = store.getMonsterSnapshot(ANALYTICAL_STATE_CHARACTER_ID);
    const previous =
      stored === null
        ? null
        : usablePreviousState(stored.state, footprint.window);
    const derivation = deriveMonsterState(footprint, previous);
    const stateUnchanged =
      stored !== null &&
      JSON.stringify(stored.state) === JSON.stringify(derivation.state);
    const revision =
      stored === null
        ? 1
        : stateUnchanged
          ? stored.asOfRevision
          : stored.asOfRevision + 1;
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error("MONSTER_REVISION_EXHAUSTED");
    }
    store.upsertMonsterSnapshot({
      state: derivation.state,
      asOfRevision: revision,
    });
    return summaryFromState(derivation.state, characterId);
  } catch {
    return fallbackSummary(characterId, safeNow);
  }
}
