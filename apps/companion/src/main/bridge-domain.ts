import {
  CHARACTER_IDS,
  CharacterIdSchema,
  getCharacterDefinition,
  getPlaceholderVisual,
  selectFixedLine,
  type CharacterId
} from "@tokenmonster/characters";
import { z } from "zod";

import type {
  ByokRuntimeStatus,
  CompanionBootstrap,
  ContributionRuntimeStatus,
  FixedInteractionResponse,
  LocalRuntimeStatus,
  MonsterRuntimeSummary
} from "../shared/ipc.js";

const FixedInteractionRequestSchema = z.strictObject({
  characterId: CharacterIdSchema,
  trigger: z.enum(["greeting", "idle"])
});

let selectedCharacterId: CharacterId = "chatgpt";

const DEFAULT_BYOK_STATUS: ByokRuntimeStatus = Object.freeze({
  configured: false,
  persistence: "memory-only",
  canPersist: false,
  backend: "unknown",
  provider: "OpenAI",
  model: "gpt-5.6-luna"
});

const DEFAULT_LOCAL_STATUS: LocalRuntimeStatus = Object.freeze({
  storage: "ready",
  state: "not-configured",
  dailyAggregateRows: 0,
  lastSuccessfulScanAt: null
});

const DEFAULT_CONTRIBUTION_STATUS: ContributionRuntimeStatus = Object.freeze({
  configured: false,
  secureStorage: "unavailable",
  state: "unavailable",
  enabled: false,
  canEnable: false,
  canDelete: false,
  outboxPending: 0,
  consentDocumentRevision: null,
  deletion: null
});

const DEFAULT_MONSTER_SUMMARY: MonsterRuntimeSummary = Object.freeze({
  characterId: "chatgpt",
  identityStatus: "learning",
  coverage: "insufficient",
  mood: "learning",
  moodLabel: "正在認識你的節奏",
  energy: "dormant",
  evolution: "awaiting-coverage",
  window: Object.freeze({
    from: "2020-01-01",
    to: "2020-01-28",
    timezone: "UTC"
  }),
  traits: Object.freeze([]),
  disclosure:
    "特質只根據這台裝置已成功收集的 28 個 UTC 日期彙總；未掃描的日期是 unavailable，不會被當成零用量，也不推測任務、專案或生產力。"
});

function bootstrap(
  byok: ByokRuntimeStatus,
  local: LocalRuntimeStatus,
  monster: MonsterRuntimeSummary,
  contribution: ContributionRuntimeStatus
): CompanionBootstrap {
  if (monster.characterId !== selectedCharacterId) {
    throw new Error("MONSTER_CHARACTER_MISMATCH");
  }
  return Object.freeze({
    contractVersion: 1,
    locale: "zh-TW",
    mode: byok.configured ? "byok-direct" : "local-only",
    selectedCharacterId,
    characters: Object.freeze(
      CHARACTER_IDS.map((characterId) => {
        const character = getCharacterDefinition(characterId);
        const visual = getPlaceholderVisual(characterId);
        return Object.freeze({
          id: character.id,
          alias: character.alias,
          glyph: visual.glyph,
          description: character.description,
          disclosure: character.disclosure["zh-TW"],
          theme: Object.freeze({ ...visual.theme })
        });
      })
    ),
    monster,
    collector: local,
    contribution,
    byok
  });
}

export function getCompanionBootstrap(
  byok: ByokRuntimeStatus = DEFAULT_BYOK_STATUS,
  local: LocalRuntimeStatus = DEFAULT_LOCAL_STATUS,
  monster: MonsterRuntimeSummary = DEFAULT_MONSTER_SUMMARY,
  contribution: ContributionRuntimeStatus = DEFAULT_CONTRIBUTION_STATUS
): CompanionBootstrap {
  return bootstrap(byok, local, monster, contribution);
}

export function selectCompanionCharacter(
  input: unknown,
  byok: ByokRuntimeStatus = DEFAULT_BYOK_STATUS,
  local: LocalRuntimeStatus = DEFAULT_LOCAL_STATUS,
  monster?: MonsterRuntimeSummary,
  contribution: ContributionRuntimeStatus = DEFAULT_CONTRIBUTION_STATUS
): CompanionBootstrap {
  selectedCharacterId = CharacterIdSchema.parse(input);
  const selectedMonster =
    monster ??
    Object.freeze({ ...DEFAULT_MONSTER_SUMMARY, characterId: selectedCharacterId });
  return bootstrap(byok, local, selectedMonster, contribution);
}

export function createFixedInteraction(
  input: unknown,
  seed: number,
  monster?: MonsterRuntimeSummary
): FixedInteractionResponse {
  const request = FixedInteractionRequestSchema.parse(input);
  if (monster !== undefined && monster.characterId !== request.characterId) {
    throw new Error("MONSTER_CHARACTER_MISMATCH");
  }
  const line = selectFixedLine({
    characterId: request.characterId,
    locale: "zh-TW",
    trigger: request.trigger,
    mood: monster?.mood ?? "learning",
    traits: monster?.traits.map(({ id }) => id) ?? [],
    seed
  });
  return Object.freeze({
    kind: "fixed-line",
    lineId: line.lineId,
    characterId: line.characterId,
    text: line.text
  });
}
