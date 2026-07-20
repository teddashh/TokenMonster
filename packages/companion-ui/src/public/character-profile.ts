import type {
  CharacterProfileEnergyBand,
  CharacterProfileEvolutionEvent,
  CharacterProfileMoodId,
  CharacterProfileReasonCode,
  CharacterProfileResponse,
  CharacterProfileTraitId,
} from "./dto.js";
import { getUiLocale, localizeUiText } from "./localization.js";

interface LabelAndDescription {
  readonly label: string;
  readonly description: string;
}

const TRAIT_PRESENTATIONS = {
  "cli-focused": {
    label: "CLI 專注型",
    description: "她發現你常在命令列裡，把想法一步步變成行動。",
  },
  "tool-focused": {
    label: "工具專注型",
    description: "你近期常回到熟悉的工具，使用節奏很一致。",
  },
  "multi-tool": {
    label: "多工具切換型",
    description: "你會在不同工具之間自然切換，找到適合當下的方式。",
  },
  "cache-savvy": {
    label: "Cache 節奏型",
    description: "你的近期用量裡，快取的使用節奏相對明顯。",
  },
  "output-heavy": {
    label: "輸出導向型",
    description: "你的近期互動較常讓夥伴把回答完整展開。",
  },
  "night-oriented": {
    label: "深夜節奏型",
    description: "有足夠的本機時段資料顯示，你較常在夜間出現。",
  },
} as const satisfies Readonly<
  Record<CharacterProfileTraitId, LabelAndDescription>
>;

const MOOD_PRESENTATIONS = {
  learning: {
    label: "認識中",
    description: "她還在安靜認識你的日常節奏。",
  },
  unknown: {
    label: "最近節奏未確認",
    description: "最近一個完整 UTC 日的資料還不可用，所以她不會替你猜測。",
  },
  resting: {
    label: "最近在休息",
    description: "最近一個完整 UTC 日沒有記錄到使用；休息也是很自然的節奏。",
  },
  quiet: {
    label: "輕聲陪伴",
    description: "最近一個完整 UTC 日比你自己的近期節奏安靜一些。",
  },
  steady: {
    label: "穩穩同行",
    description: "最近一個完整 UTC 日接近你自己的近期使用節奏。",
  },
  lively: {
    label: "活力同行",
    description: "最近一個完整 UTC 日比你自己的近期使用節奏活躍一些。",
  },
} as const satisfies Readonly<
  Record<CharacterProfileMoodId, LabelAndDescription>
>;

const ENERGY_LABELS = {
  dormant: "安靜",
  low: "柔和",
  medium: "穩定",
  high: "活躍",
} as const satisfies Readonly<Record<CharacterProfileEnergyBand, string>>;

const EVOLUTION_PRESENTATIONS = {
  "awaiting-coverage": {
    label: "還在認識你",
    description: "資料會隨平常使用自然補齊，不需要刻意增加用量。",
  },
  "initial-profile": {
    label: "初次側寫完成",
    description: "她第一次整理出你的近期使用節奏。",
  },
  "coverage-complete": {
    label: "側寫逐漸清楚",
    description: "可用日資料已足以讓近期輪廓成形。",
  },
  "identity-shift": {
    label: "節奏有新變化",
    description: "近期自然使用的樣子改變了，側寫也跟著調整。",
  },
  "weekly-review": {
    label: "本週側寫更新",
    description: "她完成了這一週的例行整理。",
  },
  "no-change": {
    label: "近期節奏穩定",
    description: "這次整理沒有發現需要改寫的主要特質。",
  },
} as const satisfies Readonly<
  Record<CharacterProfileEvolutionEvent, LabelAndDescription>
>;

const REASON_TEXT = {
  IDENTITY_LEARNING_COVERAGE_28D: "可用日期還不足，夥伴先保持「認識中」。",
  IDENTITY_LEARNING_EVIDENCE_28D:
    "近期資料還無法證明穩定特質，夥伴會保持「認識中」而不替你猜測。",
  IDENTITY_READY_COVERAGE_28D:
    "已有足夠的本機日資料，可以整理出目前的使用節奏。",
  IDENTITY_HELD_SAME_WINDOW:
    "同一個 28 天區間沿用已確認的側寫，避免重整時跳動。",
  IDENTITY_HELD_EVIDENCE_GRACE_7D:
    "近期證據暫時不足；夥伴最多保留七個自然日的既有側寫，之後會回到認識中。",
  IDENTITY_PROVISIONAL_DAILY_LIMIT:
    "新的趨勢會分次反映，避免一天內讓側寫大幅跳動。",
  TRAIT_CLI_FOCUS_28D: "近 28 天的工具使用較集中在命令列介面。",
  TRAIT_TOOL_FOCUS_28D: "近 28 天的使用較集中在一種工具介面。",
  TRAIT_MULTI_TOOL_28D: "近 28 天自然地使用了多種工具介面。",
  TRAIT_CACHE_SAVVY_28D: "本機資料顯示，快取用量在已觀察區間中較明顯。",
  TRAIT_OUTPUT_HEAVY_28D: "本機資料顯示，輸出在已觀察用量中的占比較高。",
  TRAIT_NIGHT_ORIENTED_LOCAL_28D:
    "有足夠的本機時段資料顯示，使用較常落在夜間。",
  TRAIT_HELD_SAME_WINDOW: "同一個資料區間先維持已確認的特質，避免重整時跳動。",
  TRAIT_HELD_EVIDENCE_GRACE_7D:
    "目前先短暫保留已確認的特質；證據沒有恢復時不會一直沿用。",
  TRAIT_HELD_DAILY_LIMIT: "特質變化會分次反映，讓夥伴的個性保持連續。",
  MOOD_LEARNING_COVERAGE_28D: "資料仍在自然累積，今天先以認識中的狀態陪你。",
  MOOD_TODAY_UNAVAILABLE:
    "最近一個完整 UTC 日的本機資料不可用，所以不推測你的節奏。",
  MOOD_RESTING_TODAY: "最近一個完整 UTC 日沒有記錄到使用；休息也很正常。",
  MOOD_RELATIVE_ACTIVITY_LOW:
    "最近一個完整 UTC 日的使用比你自己的近期節奏安靜。",
  MOOD_RELATIVE_ACTIVITY_STABLE:
    "最近一個完整 UTC 日的使用接近你自己的近期節奏。",
  MOOD_RELATIVE_ACTIVITY_HIGH:
    "最近一個完整 UTC 日的使用比你自己的近期節奏活躍。",
  EVOLUTION_AWAITING_COVERAGE:
    "夥伴會等待自然累積的可用日資料，不需要特別做什麼。",
  EVOLUTION_INITIAL_PROFILE: "這是她第一次完成你的近期側寫。",
  EVOLUTION_COVERAGE_COMPLETE: "可用資料已足以讓側寫從認識中成形。",
  EVOLUTION_IDENTITY_SHIFT: "近期使用節奏改變，側寫也跟著調整。",
  EVOLUTION_WEEKLY_REVIEW: "這次是七個自然日後的例行側寫整理。",
  EVOLUTION_NO_CHANGE: "這次整理後，主要特質維持不變。",
} as const satisfies Readonly<Record<CharacterProfileReasonCode, string>>;

export interface CharacterProfileTraitPresentation {
  readonly id: CharacterProfileTraitId;
  readonly label: string;
  readonly description: string;
}

export interface CharacterProfilePresentation {
  readonly heading: string;
  readonly stateLabel: string;
  readonly summary: string;
  readonly freshnessLabel: string;
  readonly freshnessNote: string;
  readonly windowLabel: string;
  readonly mood: Readonly<{
    id: CharacterProfileMoodId;
    label: string;
    description: string;
    energyLabel: string;
  }>;
  readonly traits: readonly CharacterProfileTraitPresentation[];
  readonly evolution: Readonly<{
    event: CharacterProfileEvolutionEvent;
    label: string;
    description: string;
  }>;
  readonly reasonLines: readonly string[];
  readonly dataNote: string;
  readonly shareCard: Readonly<{
    mood: string;
    traitLabels: readonly string[];
    evolution: string;
    attribution: string;
  }>;
}

export function characterProfileTraitLabel(
  traitId: CharacterProfileTraitId,
): string {
  return localizeUiText(TRAIT_PRESENTATIONS[traitId].label);
}

export function characterProfileMoodLabel(
  moodId: CharacterProfileMoodId,
): string {
  return localizeUiText(MOOD_PRESENTATIONS[moodId].label);
}

export function characterProfileEvolutionLabel(
  event: CharacterProfileEvolutionEvent,
): string {
  return localizeUiText(EVOLUTION_PRESENTATIONS[event].label);
}

export function characterProfileReasonText(
  reasonCode: CharacterProfileReasonCode,
): string {
  return localizeUiText(REASON_TEXT[reasonCode]);
}

export function presentCharacterProfile(
  profile: CharacterProfileResponse,
): CharacterProfilePresentation {
  const traits = Object.freeze(
    profile.identity.traitIds.map((id) => {
      const presentation = TRAIT_PRESENTATIONS[id];
      return Object.freeze({
        id,
        label: localizeUiText(presentation.label),
        description: localizeUiText(presentation.description),
      });
    }),
  );
  const rawMoodPresentation = MOOD_PRESENTATIONS[profile.mood.id];
  const moodPresentation = Object.freeze({
    label: localizeUiText(rawMoodPresentation.label),
    description: localizeUiText(rawMoodPresentation.description),
  });
  const rawEvolutionPresentation =
    EVOLUTION_PRESENTATIONS[profile.evolution.event];
  const evolutionPresentation = Object.freeze({
    label: localizeUiText(rawEvolutionPresentation.label),
    description: localizeUiText(rawEvolutionPresentation.description),
  });
  const traitLabels = Object.freeze(traits.map((trait) => trait.label));
  const learning = profile.identity.status === "learning";
  const evidenceGrace = profile.reasons.some(
    (reason) => reason.reasonCode === "IDENTITY_HELD_EVIDENCE_GRACE_7D",
  );
  const summary = localizeUiText(learning
    ? "夥伴還在從自然使用中認識你的節奏；照平常方式使用就好，不需要刻意增加用量。"
    : evidenceGrace
      ? "近期可用證據暫時不足；既有側寫只會短暫保留，沒有恢復時會自動回到認識中。"
      : profile.identity.provisional
        ? "夥伴已看見新的節奏，但會分次調整側寫，避免一天內突然改變。"
        : "這是依最近 28 個 UTC 日的可用本機資料整理出的使用節奏，不是效率或能力評分。");
  const freshnessLabel = localizeUiText(
    profile.freshness === "fresh" ? "最新本機側寫" : "最近一次可用側寫",
  );
  const freshnessNote = localizeUiText(
    profile.freshness === "fresh"
      ? "依目前可用的本機日資料整理。"
      : "本機資料暫時無法更新；恢復後會自動重算。",
  );
  const shareAttributionReason =
    profile.reasons.find((reason) => reason.subject === "trait") ??
    profile.reasons.find((reason) => reason.subject === "mood") ??
    profile.reasons[0];
  const localizedShareAttribution =
    shareAttributionReason === undefined
      ? localizeUiText("依最近 28 個 UTC 日的可用本機資料整理。")
      : localizeUiText(REASON_TEXT[shareAttributionReason.reasonCode]);
  const shareAttribution =
    getUiLocale() === "en" && [...localizedShareAttribution].length > 80
      ? "Based on available content-blind local usage evidence."
      : localizedShareAttribution;

  return Object.freeze({
    heading: localizeUiText("夥伴側寫"),
    stateLabel: localizeUiText(learning ? "認識中" : "側寫已成形"),
    summary,
    freshnessLabel,
    freshnessNote,
    windowLabel: localizeUiText(
      `${profile.window.fromUtcDate} 至 ${profile.window.toUtcDate}（UTC）`,
    ),
    mood: Object.freeze({
      id: profile.mood.id,
      label: moodPresentation.label,
      description: moodPresentation.description,
      energyLabel: localizeUiText(ENERGY_LABELS[profile.mood.energyBand]),
    }),
    traits,
    evolution: Object.freeze({
      event: profile.evolution.event,
      label: evolutionPresentation.label,
      description: evolutionPresentation.description,
    }),
    reasonLines: Object.freeze(
      profile.reasons.map((reason) =>
        localizeUiText(REASON_TEXT[reason.reasonCode]),
      ),
    ),
    dataNote: localizeUiText(
      "只根據本機可用日的無內容彙總估算；短期狀態只比較完整 UTC 日，缺少的日期不會被當成零用量。",
    ),
    shareCard: Object.freeze({
      mood: moodPresentation.label,
      traitLabels,
      evolution: evolutionPresentation.label,
      attribution: shareAttribution,
    }),
  });
}
