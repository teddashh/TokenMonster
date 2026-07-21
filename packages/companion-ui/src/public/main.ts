import {
  CHARACTERS_API_ENDPOINT,
  COLLECTOR_REFRESH_ENDPOINT,
  COLLECTOR_STATUS_ENDPOINT,
  COMPANION_API_ENDPOINT,
  parseCharactersSnapshot,
  parseCompanionCollectorStatus,
  parseCompanionSnapshot,
  type ByokChatMessage,
  type ByokStatusResponse,
  type CharacterAssetPackStatus,
  type CharacterConnectionState,
  type CharacterId,
  type CharacterLetterAccentId,
  type CharacterLetterTheme,
  type CharacterProfileResponse,
  type CharacterRosterEntry,
  type CharactersSnapshot,
  type CharacterThemeId,
  type CharacterUnlock,
  type CharacterVoiceLine,
  type CompanionCharacterId,
  type CompanionCollectorStatus,
  type CompanionErrorCode,
  type CompanionErrorSnapshot,
  type CompanionHealthySnapshot,
  type CompanionStarterSelection,
  type VoiceTrigger,
} from "./dto.js";
import {
  ByokRequestError,
  CharacterProgressionWriteError,
  applyCharacterSelection,
  applyCharacterWardrobe,
  clearByok,
  configureByok,
  readCharacterJson,
  requestByokChat,
  requestByokStatus,
  requestCharacterAssetPackStatus,
  requestCharacterInteraction,
  requestCharacterProfile,
  requestCharacterProgressionLockRepair,
  requestCharacterSelection,
  requestCharacterWardrobe,
  requestQuotaSnapshot,
  requestUiLocalePreference,
  saveUiLocalePreference,
  updateQuotaPlan,
  settleCharacterAssetPackConsent,
  requestUsageAnalytics,
} from "./api.js";
import { createAnalyticsPanel } from "./analytics-panel.js";
import {
  createCharacterImageFallbackTracker,
  createCharacterUnlockQueue,
  characterUnlockToastText,
  diffCharacterUnlocks,
} from "./character-state.js";
import {
  CHARACTER_PROFILE_FAILURE_RETRY_MS,
  CHARACTER_PROFILE_SUCCESS_REFRESH_MS,
  canShareCharacterProfile,
  characterRosterCardIdentity,
  createCharacterMutationGate,
  createCharacterProfileRequestGate,
  isCurrentCharacterInteraction,
  millisecondsUntilNextUtcDate,
  needsColdStartLetterFallback,
  presentedRosterCharacter,
  resolveCharacterStage,
  resolveCompanionView,
  selectedRosterCharacter,
  shouldPlayImmediateUnlockSparkles,
  shouldRenderAfterCharacterMutation,
  visibleCharacterRoster,
} from "./character-panel.js";
import { startContributionControl } from "./contribution-control.js";
import {
  createCharacterIdleAnimation,
  createPortraitStageStateMachine,
  enabledCharacterAnimationClasses,
  preloadCharacterImage,
  userPrefersReducedMotion,
  type PortraitTarget,
} from "./animation.js";
import { createVoicePlaybackGate } from "./voice.js";
import {
  applyHealthyUsageSnapshot,
  createUnavailableRetryBackoff,
  shouldAutomaticallyRetry,
} from "./usage-state.js";
import { createUsagePanel } from "./usage-panel.js";
import { createQuotaPanel } from "./quota-panel.js";
import {
  characterThemeLabel,
  characterThemeLockedLabel,
  characterThemeStageGreetingLabel,
  characterThemeUnavailableLabel,
  characterThemeWearLabel,
  characterUnlockExplanation,
} from "./wardrobe.js";
import { characterCollectionView } from "./collection.js";
import {
  presentCharacterProfile,
  type CharacterProfilePresentation,
} from "./character-profile.js";
import {
  renderLocalShareCard,
  saveLocalShareCardBlob,
  type LocalShareCardPalette,
} from "./share-card.js";
import { characterAssetPackControlMode } from "./asset-pack-control.js";
import {
  progressionLockRepairView,
  type ProgressionLockRepairState,
} from "./progression-lock-repair.js";
import {
  appendByokChatExchange,
  byokChatErrorText,
  isByokChatCharacter,
} from "./byok-chat.js";
import {
  readReminderStatus,
  reminderBridge,
  reminderStatusText,
  saveReminderSettings,
  sendReminderTest,
  type ReminderStatus,
} from "./reminder-control.js";
import {
  automaticUpdateBridge,
  automaticUpdateStatusText,
  readAutomaticUpdateStatus,
  requestAutomaticUpdateCheck,
  requestAutomaticUpdateInstall,
  saveAutomaticUpdatePreference,
  type AutomaticUpdateStatus,
} from "./automatic-update-control.js";
import {
  formatUiDate,
  formatUiNumber,
  getUiLocale,
  localizeDocument,
  observeLocalizedDocument,
  setUiLocale,
  uiLocaleFromSessionPath,
  uiLocaleSessionPath,
} from "./localization.js";

const MAX_RESPONSE_CHARACTERS = 65_536;
const REQUEST_TIMEOUT_MS = 8_000;
const REFRESH_REQUEST_TIMEOUT_MS = 100_000;
const ASSET_PACK_REQUEST_TIMEOUT_MS = 130_000;
const BYOK_CHAT_REQUEST_TIMEOUT_MS = 35_000;
const AUTOMATIC_UPDATE_ACTIVE_POLL_MS = 1_000;
const AUTOMATIC_UPDATE_ENABLED_POLL_MS = 5_000;
const ACTIVE_POLL_MS = 5_000;
const SETTLED_POLL_MS = 60_000;
const numberFormatter = Object.freeze({ format: formatUiNumber });
const timeFormatter = Object.freeze({
  format: (value: Date | number) =>
    formatUiDate(value, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
});

const LETTER_ACCENT_SYMBOLS = Object.freeze({
  "terminal-caret": "›",
  "steady-coin": "●",
  "dialogue-star": "✦",
  "open-book": "▱",
  "care-cross": "+",
  "new-leaf": "❧",
  "law-seal": "◆",
  "listening-knot": "∞",
  "home-heart": "♥",
  "task-check": "✓",
  "research-spark": "✧",
  "story-mark": "¶",
  "victory-chevron": "»",
  "shared-plate": "◉",
  "compass-point": "◆",
  "reflection-orbit": "◌",
  "question-ring": "?",
  "world-link": "◎",
  "signal-dot": "•",
  "celebration-star": "★",
} as const satisfies Readonly<Record<CharacterLetterAccentId, string>>);

function applyLetterThemePreview(
  element: HTMLElement,
  theme: CharacterLetterTheme | undefined,
): void {
  element.classList.toggle("letter-theme-preview", theme !== undefined);
  const style = element.style;
  if (theme === undefined) {
    for (const property of [
      "--letter-background",
      "--letter-foreground",
      "--letter-accent",
    ]) {
      style.removeProperty(property);
    }
    delete element.dataset["letterPattern"];
    delete element.dataset["letterDensity"];
    delete element.dataset["letterAccentSymbol"];
    delete element.dataset["letterAccentPlacement"];
    return;
  }
  style.setProperty("--letter-background", theme.palette.background);
  style.setProperty("--letter-foreground", theme.palette.foreground);
  style.setProperty("--letter-accent", theme.palette.accent);
  element.dataset["letterPattern"] = theme.pattern.id;
  element.dataset["letterDensity"] = theme.pattern.density;
  element.dataset["letterAccentSymbol"] =
    LETTER_ACCENT_SYMBOLS[theme.accent.id];
  element.dataset["letterAccentPlacement"] = theme.accent.placement;
}

const CHARACTER_VIEW = Object.freeze({
  chatgpt: Object.freeze({ glyph: "T", name: "ChatGPT" }),
  claude: Object.freeze({ glyph: "C", name: "Claude" }),
  gemini: Object.freeze({ glyph: "G", name: "Gemini" }),
  grok: Object.freeze({ glyph: "X", name: "Grok" }),
  deepseek: Object.freeze({ glyph: "D", name: "DeepSeek" }),
  qwen: Object.freeze({ glyph: "Q", name: "Qwen" }),
  mistral: Object.freeze({ glyph: "M", name: "Mistral" }),
  venice: Object.freeze({ glyph: "L", name: "Llama" }),
  sakana: Object.freeze({ glyph: "S", name: "Sakana" }),
  perplexity: Object.freeze({ glyph: "P", name: "Perplexity" }),
  glm: Object.freeze({ glyph: "G", name: "GLM" }),
} as const satisfies Readonly<
  Record<CharacterId, Readonly<{ glyph: string; name: string }>>
>);

const CHARACTER_SHARE_PALETTE = Object.freeze({
  chatgpt: Object.freeze({
    background: "#dbeee7",
    foreground: "#163e35",
    accent: "#3d8d74",
  }),
  claude: Object.freeze({
    background: "#f4dfd0",
    foreground: "#4a2d22",
    accent: "#c36f4c",
  }),
  gemini: Object.freeze({
    background: "#dfe7fb",
    foreground: "#243765",
    accent: "#5f73c7",
  }),
  grok: Object.freeze({
    background: "#e1e4e8",
    foreground: "#20252b",
    accent: "#697580",
  }),
  deepseek: Object.freeze({
    background: "#e4e0fb",
    foreground: "#2d275c",
    accent: "#6657c7",
  }),
  qwen: Object.freeze({
    background: "#f7dce9",
    foreground: "#5b203a",
    accent: "#b94e7d",
  }),
  mistral: Object.freeze({
    background: "#f8e8c8",
    foreground: "#553b16",
    accent: "#d2902f",
  }),
  venice: Object.freeze({
    background: "#d7eef0",
    foreground: "#16464c",
    accent: "#2e8d9b",
  }),
  sakana: Object.freeze({
    background: "#e6efd7",
    foreground: "#31461d",
    accent: "#78a847",
  }),
  perplexity: Object.freeze({
    background: "#dce8e8",
    foreground: "#273f41",
    accent: "#527579",
  }),
  glm: Object.freeze({
    background: "#efe0f2",
    foreground: "#4c2854",
    accent: "#9a58a8",
  }),
} as const satisfies Readonly<Record<CharacterId, LocalShareCardPalette>>);

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error("Required UI element is unavailable");
  return element;
}

function currentUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function startCompanionUi(): void {
  startContributionControl();
  const companionView = resolveCompanionView(window.location.search);
  document.documentElement.dataset["view"] = companionView;
  const statsDisclosure = requiredElement<HTMLDetailsElement>(
    "[data-stats-disclosure]",
  );
  statsDisclosure.open = companionView === "dashboard";
  const starterChoiceBackground = Object.freeze([
    requiredElement<HTMLElement>(".skip-link"),
    requiredElement<HTMLElement>(".site-header"),
    requiredElement<HTMLElement>(".character-stage"),
    requiredElement<HTMLElement>("[data-asset-pack-control]"),
    statsDisclosure,
    requiredElement<HTMLElement>(".site-footer"),
  ]);
  const statusElement = requiredElement<HTMLElement>("[data-status]");
  const companionLineElement = requiredElement<HTMLElement>(
    "[data-companion-line]",
  );
  const companionVisualElement = requiredElement<HTMLButtonElement>(
    "[data-companion-visual]",
  );
  const companionGlyphElement = requiredElement<HTMLElement>(
    "[data-companion-glyph]",
  );
  const letterLayerElement = requiredElement<HTMLElement>(
    "[data-letter-layer]",
  );
  const companionFaceElement = requiredElement<HTMLElement>(".companion-face");
  const dollImageElement = requiredElement<HTMLImageElement>(
    "[data-character-doll]",
  );
  const incomingDollImageElement = requiredElement<HTMLImageElement>(
    "[data-character-doll-incoming]",
  );
  const switchingElement = requiredElement<HTMLElement>(
    "[data-character-switching]",
  );
  const effectsElement = requiredElement<HTMLElement>(
    "[data-character-effects]",
  );
  const characterSpeechElement = requiredElement<HTMLElement>(
    "[data-character-speech]",
  );
  const characterTapHintElement = requiredElement<HTMLElement>(
    "[data-character-tap-hint]",
  );
  const companionTitleElement = requiredElement<HTMLElement>(
    "[data-companion-title]",
  );
  const characterReasonElement = requiredElement<HTMLElement>(
    "[data-character-reason]",
  );
  const characterHeadingElement = requiredElement<HTMLElement>(
    ".character-heading",
  );
  const progressionLockRepairButton = requiredElement<HTMLButtonElement>(
    "[data-progression-lock-repair]",
  );
  const rosterElement = requiredElement<HTMLElement>("[data-roster]");
  const wardrobeToggle = requiredElement<HTMLButtonElement>(
    "[data-wardrobe-toggle]",
  );
  const wardrobeDrawer = requiredElement<HTMLElement>("[data-wardrobe-drawer]");
  const wardrobeList = requiredElement<HTMLElement>("[data-wardrobe-list]");
  const characterProfileElement = requiredElement<HTMLElement>(
    "[data-character-profile]",
  );
  const profileMoodElement = requiredElement<HTMLElement>(
    "[data-profile-mood]",
  );
  const profileCoverageElement = requiredElement<HTMLElement>(
    "[data-profile-coverage]",
  );
  const profileSummaryElement = requiredElement<HTMLElement>(
    "[data-profile-summary]",
  );
  const profileTraitsElement = requiredElement<HTMLElement>(
    "[data-profile-traits]",
  );
  const profileReasonsElement = requiredElement<HTMLDetailsElement>(
    "[data-profile-reasons]",
  );
  const profileReasonListElement = requiredElement<HTMLUListElement>(
    "[data-profile-reason-list]",
  );
  const shareCardButton =
    requiredElement<HTMLButtonElement>("[data-share-card]");
  const shareCardActionElement = requiredElement<HTMLElement>(
    ".share-card-action",
  );
  const shareCardStatus = requiredElement<HTMLElement>(
    "[data-share-card-status]",
  );
  const shareCardHideTotal = requiredElement<HTMLInputElement>(
    "[data-share-card-hide-total]",
  );
  const byokPanel = requiredElement<HTMLElement>("[data-byok-panel]");
  const byokStatusElement = requiredElement<HTMLElement>("[data-byok-status]");
  const byokToggle = requiredElement<HTMLButtonElement>("[data-byok-toggle]");
  const byokDrawer = requiredElement<HTMLElement>("[data-byok-drawer]");
  const byokClose = requiredElement<HTMLButtonElement>("[data-byok-close]");
  const byokConfigureForm = requiredElement<HTMLFormElement>(
    "[data-byok-configure]",
  );
  const byokKeyInput = requiredElement<HTMLInputElement>("[data-byok-key]");
  const byokPersistInput = requiredElement<HTMLInputElement>(
    "[data-byok-persist]",
  );
  const byokConfigureSubmit = requiredElement<HTMLButtonElement>(
    "[data-byok-configure-submit]",
  );
  const byokConversation = requiredElement<HTMLElement>(
    "[data-byok-conversation]",
  );
  const byokTranscript = requiredElement<HTMLOListElement>(
    "[data-byok-transcript]",
  );
  const byokMessageForm = requiredElement<HTMLFormElement>(
    "[data-byok-message-form]",
  );
  const byokMessageInput = requiredElement<HTMLTextAreaElement>(
    "[data-byok-message]",
  );
  const byokSend = requiredElement<HTMLButtonElement>("[data-byok-send]");
  const byokClear = requiredElement<HTMLButtonElement>("[data-byok-clear]");
  const byokModalBackground = Object.freeze([
    characterHeadingElement,
    characterProfileElement,
    rosterElement,
    wardrobeToggle,
    wardrobeDrawer,
    shareCardActionElement,
  ]);
  const assetPackControl = requiredElement<HTMLElement>(
    "[data-asset-pack-control]",
  );
  const assetPackStatusElement = requiredElement<HTMLElement>(
    "[data-asset-pack-status]",
  );
  const assetPackDisclosure = requiredElement<HTMLElement>(
    "[data-asset-pack-disclosure]",
  );
  const assetPackButton = requiredElement<HTMLButtonElement>(
    "[data-asset-pack-button]",
  );
  const assetPackRevokeButton = requiredElement<HTMLButtonElement>(
    "[data-asset-pack-revoke]",
  );
  const voiceControls = requiredElement<HTMLElement>("[data-voice-controls]");
  const voiceToggle = requiredElement<HTMLButtonElement>("[data-voice-toggle]");
  const voiceHint = requiredElement<HTMLButtonElement>("[data-voice-hint]");
  const voiceAudio = requiredElement<HTMLAudioElement>("[data-voice-audio]");
  const toastElement = requiredElement<HTMLElement>("[data-unlock-toast]");
  const updatedElement = requiredElement<HTMLElement>("[data-updated]");
  const staleBadgeElement = requiredElement<HTMLElement>("[data-stale-badge]");
  const rescanButton = requiredElement<HTMLButtonElement>("[data-rescan]");
  const trendElement = requiredElement<HTMLElement>("[data-trend]");
  const trendEmptyElement = requiredElement<HTMLElement>("[data-trend-empty]");
  const trendAccessibleElement = requiredElement<HTMLOListElement>(
    "[data-trend-accessible]",
  );
  const analyticsElement = requiredElement<HTMLElement>("[data-analytics]");
  const quotaListElement = requiredElement<HTMLElement>("[data-quota-list]");
  const reminderPanel = requiredElement<HTMLElement>("[data-reminder-panel]");
  const reminderStatusElement = requiredElement<HTMLElement>(
    "[data-reminder-status]",
  );
  const reminderTestButton = requiredElement<HTMLButtonElement>(
    "[data-reminder-test]",
  );
  const reminderSettingsForm = requiredElement<HTMLFormElement>(
    "[data-reminder-settings]",
  );
  const reminderEnabledInput = requiredElement<HTMLInputElement>(
    "[data-reminder-enabled]",
  );
  const reminderTimeInput = requiredElement<HTMLInputElement>(
    "[data-reminder-time]",
  );
  const reminderQuietStartInput = requiredElement<HTMLInputElement>(
    "[data-reminder-quiet-start]",
  );
  const reminderQuietEndInput = requiredElement<HTMLInputElement>(
    "[data-reminder-quiet-end]",
  );
  const reminderSaveButton = requiredElement<HTMLButtonElement>(
    "[data-reminder-save]",
  );
  const automaticUpdatePanel = requiredElement<HTMLElement>(
    "[data-automatic-update-panel]",
  );
  const automaticUpdateStatusElement = requiredElement<HTMLElement>(
    "[data-automatic-update-status]",
  );
  const automaticUpdateEnabledInput = requiredElement<HTMLInputElement>(
    "[data-automatic-update-enabled]",
  );
  const automaticUpdateCheckButton = requiredElement<HTMLButtonElement>(
    "[data-automatic-update-check]",
  );
  const automaticUpdateInstallButton = requiredElement<HTMLButtonElement>(
    "[data-automatic-update-install]",
  );
  const metricElements = {
    today: requiredElement<HTMLElement>("[data-metric='today']"),
    last7Days: requiredElement<HTMLElement>("[data-metric='last7Days']"),
    last28Days: requiredElement<HTMLElement>("[data-metric='last28Days']"),
  };
  const localReminderBridge = reminderBridge(window.tokenMonsterCompanion);
  const localAutomaticUpdateBridge = automaticUpdateBridge(
    window.tokenMonsterCompanion,
  );
  const { clearTrend, renderTrend } = createUsagePanel({
    trend: trendElement,
    empty: trendEmptyElement,
    accessible: trendAccessibleElement,
  });
  const unavailableRetryBackoff = createUnavailableRetryBackoff();
  let lastGoodSnapshot: CompanionHealthySnapshot | undefined;
  let charactersSnapshot: CharactersSnapshot | undefined;
  let starterRecommendationId: CompanionCharacterId | undefined;
  let characterProfile: CharacterProfileResponse | undefined;
  let characterProfilePresentation: CharacterProfilePresentation | undefined;
  let latestTodayTokens = 0;
  let characterConnectionState: CharacterConnectionState = "other";
  let previousCharacterConnectionState: CharacterConnectionState = "other";
  let wardrobeOpen = false;
  let shareCardBusy = false;
  let shareCardAvailable = false;
  let byokStatus: ByokStatusResponse | undefined;
  let byokDrawerOpen = false;
  let byokBusy = false;
  let byokHistory: readonly ByokChatMessage[] = Object.freeze([]);
  let byokController: AbortController | undefined;
  let byokNotice: string | undefined;
  let byokConversationCharacterId: CharacterId | undefined;
  let byokRequestSequence = 0;
  let starterChoiceSheetActive = false;
  let reminderStatus: ReminderStatus | undefined;
  let reminderFormRevision: string | undefined;
  let reminderBusy = false;
  let reminderNotice: string | undefined;
  let automaticUpdateStatus: AutomaticUpdateStatus | undefined;
  let automaticUpdateFormRevision: string | undefined;
  let automaticUpdateBusy = false;
  let automaticUpdateNotice: string | undefined;
  let automaticUpdateRefreshTimer: number | undefined;
  let assetPackStatus: CharacterAssetPackStatus | undefined;
  let assetPackBusy = false;
  let assetPackController: AbortController | undefined;
  let assetPackRemovalConfirmationPending = false;
  let assetPackRemovalConfirmationTimer: number | undefined;
  let celebrationTimer: number | undefined;
  let characterRequestSequence = 0;
  let characterInteractionSequence = 0;
  let characterInteractionController: AbortController | undefined;
  let characterSelectionController: AbortController | undefined;
  let progressionLockRepairController: AbortController | undefined;
  let progressionLockRepairState: ProgressionLockRepairState = "hidden";
  let characterWardrobeController: AbortController | undefined;
  let characterProfileController: AbortController | undefined;
  let characterProfileRetryTimer: number | undefined;
  let characterProfileClockTimer: number | undefined;
  let characterProfileConnectionDegraded = false;
  let characterSpeechTimer: number | undefined;
  let characterTapTimer: number | undefined;
  let requestedStageKey: string | undefined;
  let entrancePending = false;
  let renderedLetterCharacterId: CharacterId | undefined;
  const reducedMotion = userPrefersReducedMotion();
  document.documentElement.classList.toggle("motion-enabled", !reducedMotion);
  const characterIdleAnimation = createCharacterIdleAnimation(
    companionVisualElement,
    document,
    reducedMotion,
  );
  characterIdleAnimation.start();
  const analyticsPanel = createAnalyticsPanel({
    root: analyticsElement,
    reducedMotion,
    load: (window, signal) => requestUsageAnalytics(window, signal),
  });
  const quotaPanel = createQuotaPanel({
    root: quotaListElement,
    load: (signal) => requestQuotaSnapshot(signal),
    update: (family, planId) => updateQuotaPlan(family, planId),
  });

  function syncReminderForm(status: ReminderStatus): void {
    reminderFormRevision = status.revision;
    reminderEnabledInput.checked = status.enabled;
    reminderTimeInput.value = status.dailySummaryTime;
    reminderQuietStartInput.value = status.quietHours.start;
    reminderQuietEndInput.value = status.quietHours.end;
  }

  function renderReminderControl(): void {
    if (localReminderBridge === null) {
      reminderPanel.hidden = true;
      return;
    }
    reminderPanel.hidden = false;
    const status = reminderStatus;
    const storageReady = status?.storage === "ready";
    const formDisabled = reminderBusy || !storageReady;
    reminderEnabledInput.disabled = formDisabled;
    reminderTimeInput.disabled = formDisabled;
    reminderQuietStartInput.disabled = formDisabled;
    reminderQuietEndInput.disabled = formDisabled;
    reminderSaveButton.disabled = formDisabled;
    reminderTestButton.disabled =
      reminderBusy || status?.notificationSupported !== true;
    reminderSaveButton.textContent = reminderBusy
      ? "正在處理…"
      : "儲存提醒設定";
    reminderTestButton.textContent = reminderBusy
      ? "正在處理…"
      : "先測試系統通知";
    reminderStatusElement.textContent =
      status === undefined
        ? (reminderNotice ?? "正在確認系統通知。")
        : reminderStatusText(status, reminderNotice);
  }

  async function loadReminderControl(syncForm = true): Promise<void> {
    if (localReminderBridge === null || reminderBusy) return;
    reminderBusy = true;
    reminderNotice = undefined;
    renderReminderControl();
    try {
      const next = await readReminderStatus(localReminderBridge);
      reminderStatus = next;
      if (syncForm) syncReminderForm(next);
    } catch {
      reminderNotice = "暫時無法讀取這台裝置的提醒設定。";
    } finally {
      reminderBusy = false;
      renderReminderControl();
    }
  }

  async function submitReminderSettings(): Promise<void> {
    const bridge = localReminderBridge;
    if (
      bridge === null ||
      reminderBusy ||
      reminderStatus?.storage !== "ready" ||
      reminderFormRevision === undefined
    ) {
      return;
    }
    if (!reminderSettingsForm.reportValidity()) return;
    const requestedEnabled = reminderEnabledInput.checked;
    reminderBusy = true;
    reminderNotice = "正在把設定保存在這台裝置。";
    renderReminderControl();
    try {
      const result = await saveReminderSettings(bridge, {
        expectedRevision: reminderFormRevision,
        enabled: requestedEnabled,
        dailySummaryTime: reminderTimeInput.value,
        quietHours: {
          start: reminderQuietStartInput.value,
          end: reminderQuietEndInput.value,
        },
      });
      reminderStatus = result.status;
      syncReminderForm(result.status);
      reminderNotice = result.ok
        ? requestedEnabled
          ? "提醒設定已儲存。"
          : "每日提醒已關閉。"
        : result.error === "conflict"
          ? "提醒設定已在另一個視窗更新；已重新載入最新設定，請確認後再儲存。"
          : result.error === "storage-unavailable"
          ? "本機提醒設定暫時無法儲存。"
          : result.error === "disposed"
            ? "提醒服務正在結束，這次沒有儲存。"
            : "設定格式不正確，這次沒有儲存。";
    } catch {
      reminderNotice = "提醒設定沒有儲存；請稍後再試。";
    } finally {
      reminderBusy = false;
      renderReminderControl();
    }
  }

  async function testReminderNotification(): Promise<void> {
    const bridge = localReminderBridge;
    if (
      bridge === null ||
      reminderBusy ||
      reminderStatus?.notificationSupported !== true
    ) {
      return;
    }
    reminderBusy = true;
    reminderNotice = "正在送出一則本機測試通知。";
    renderReminderControl();
    try {
      const result = await sendReminderTest(bridge);
      reminderStatus = result.status;
      reminderNotice =
        result.outcome === "shown"
          ? "測試通知已交給作業系統。"
          : result.outcome === "unsupported"
            ? "這個系統目前不支援通知。"
            : result.outcome === "disposed"
              ? "提醒服務正在結束，沒有送出測試。"
              : "作業系統沒有顯示這次測試通知。";
    } catch {
      reminderNotice = "測試通知沒有送出；請稍後再試。";
    } finally {
      reminderBusy = false;
      renderReminderControl();
    }
  }

  function syncAutomaticUpdatePreference(status: AutomaticUpdateStatus): void {
    automaticUpdateFormRevision = status.revision;
    automaticUpdateEnabledInput.checked = status.automaticChecksEnabled;
  }

  function automaticUpdateIsActive(status: AutomaticUpdateStatus): boolean {
    return (
      status.update.status === "checking" ||
      status.update.status === "available" ||
      status.update.status === "downloading"
    );
  }

  function clearAutomaticUpdateRefresh(): void {
    if (automaticUpdateRefreshTimer === undefined) return;
    window.clearTimeout(automaticUpdateRefreshTimer);
    automaticUpdateRefreshTimer = undefined;
  }

  function scheduleAutomaticUpdateRefresh(): void {
    clearAutomaticUpdateRefresh();
    const status = automaticUpdateStatus;
    if (
      localAutomaticUpdateBridge === null ||
      status === undefined ||
      document.visibilityState !== "visible" ||
      status.update.status === "ready"
    ) {
      return;
    }
    const delay = automaticUpdateIsActive(status)
      ? AUTOMATIC_UPDATE_ACTIVE_POLL_MS
      : status.automaticChecksEnabled
        ? AUTOMATIC_UPDATE_ENABLED_POLL_MS
        : undefined;
    if (delay === undefined) return;
    automaticUpdateRefreshTimer = window.setTimeout(() => {
      automaticUpdateRefreshTimer = undefined;
      void loadAutomaticUpdateControl(false);
    }, delay);
  }

  function renderAutomaticUpdateControl(): void {
    if (localAutomaticUpdateBridge === null) {
      automaticUpdatePanel.hidden = true;
      clearAutomaticUpdateRefresh();
      return;
    }
    automaticUpdatePanel.hidden = false;
    const status = automaticUpdateStatus;
    const phase = status?.update.status;
    const unsupported = phase === "unsupported";
    const active = status === undefined ? false : automaticUpdateIsActive(status);
    automaticUpdateEnabledInput.disabled =
      automaticUpdateBusy ||
      status?.preferenceStorage !== "ready" ||
      (unsupported && status?.automaticChecksEnabled !== true);
    automaticUpdateCheckButton.disabled =
      automaticUpdateBusy ||
      status === undefined ||
      unsupported ||
      active ||
      phase === "ready";
    automaticUpdateInstallButton.hidden = phase !== "ready";
    automaticUpdateInstallButton.disabled =
      automaticUpdateBusy || phase !== "ready";
    automaticUpdateCheckButton.textContent = active
      ? phase === "checking"
        ? "正在檢查…"
        : "正在下載…"
      : "手動檢查更新";
    automaticUpdateInstallButton.textContent = automaticUpdateBusy
      ? "正在準備重新啟動…"
      : "現在重新啟動並安裝";
    automaticUpdateStatusElement.textContent =
      status === undefined
        ? (automaticUpdateNotice ?? "正在讀取這台裝置的更新設定。")
        : automaticUpdateStatusText(status, automaticUpdateNotice);
  }

  async function loadAutomaticUpdateControl(syncPreference = true): Promise<void> {
    if (localAutomaticUpdateBridge === null || automaticUpdateBusy) return;
    automaticUpdateBusy = true;
    automaticUpdateNotice = undefined;
    renderAutomaticUpdateControl();
    try {
      const next = await readAutomaticUpdateStatus(localAutomaticUpdateBridge);
      automaticUpdateStatus = next;
      if (syncPreference) syncAutomaticUpdatePreference(next);
    } catch {
      automaticUpdateNotice = "暫時無法讀取這台裝置的更新狀態。";
    } finally {
      automaticUpdateBusy = false;
      renderAutomaticUpdateControl();
      scheduleAutomaticUpdateRefresh();
    }
  }

  async function updateAutomaticUpdatePreference(): Promise<void> {
    const bridge = localAutomaticUpdateBridge;
    const current = automaticUpdateStatus;
    if (
      bridge === null ||
      current === undefined ||
      current.preferenceStorage !== "ready" ||
      automaticUpdateFormRevision === undefined ||
      automaticUpdateBusy
    ) {
      return;
    }
    const requestedEnabled = automaticUpdateEnabledInput.checked;
    automaticUpdateBusy = true;
    automaticUpdateNotice = "正在把更新偏好保存在這台裝置。";
    renderAutomaticUpdateControl();
    try {
      const result = await saveAutomaticUpdatePreference(bridge, {
        expectedRevision: automaticUpdateFormRevision,
        automaticChecksEnabled: requestedEnabled,
      });
      automaticUpdateStatus = result.status;
      syncAutomaticUpdatePreference(result.status);
      automaticUpdateNotice = result.ok
        ? requestedEnabled
          ? "自動檢查已開啟；第一次檢查會稍後開始。"
          : automaticUpdateIsActive(result.status)
            ? "之後的自動檢查已關閉；目前已開始的下載仍會完成。"
            : "自動檢查已關閉。"
        : result.error === "conflict"
          ? "更新偏好已在另一個視窗變更；已重新載入最新設定。"
          : result.error === "storage-unavailable"
            ? "本機更新偏好暫時無法儲存；自動檢查保持關閉。"
            : result.error === "disposed"
              ? "更新服務正在結束，這次沒有儲存。"
              : "更新偏好格式不正確，這次沒有儲存。";
    } catch {
      automaticUpdateEnabledInput.checked = current.automaticChecksEnabled;
      automaticUpdateNotice = "更新偏好沒有儲存；請稍後再試。";
    } finally {
      automaticUpdateBusy = false;
      renderAutomaticUpdateControl();
      scheduleAutomaticUpdateRefresh();
    }
  }

  async function checkForAutomaticUpdate(): Promise<void> {
    const bridge = localAutomaticUpdateBridge;
    if (bridge === null || automaticUpdateBusy) return;
    automaticUpdateBusy = true;
    automaticUpdateNotice = "這次手動檢查由你明確啟動。";
    renderAutomaticUpdateControl();
    try {
      const result = await requestAutomaticUpdateCheck(bridge);
      automaticUpdateStatus = result.status;
      automaticUpdateNotice = result.ok
        ? "更新檢查已開始；若有新版會自動下載。"
        : result.code === "check-busy"
          ? "已有一個更新檢查或下載正在進行。"
          : result.code === "unsupported"
            ? "這個平台目前不支援應用程式內更新。"
            : result.code === "disposed"
              ? "更新服務正在結束。"
              : "這次無法開始更新檢查；稍後可再試。";
    } catch {
      automaticUpdateNotice = "這次無法開始更新檢查；稍後可再試。";
    } finally {
      automaticUpdateBusy = false;
      renderAutomaticUpdateControl();
      scheduleAutomaticUpdateRefresh();
    }
  }

  async function installAutomaticUpdate(): Promise<void> {
    const bridge = localAutomaticUpdateBridge;
    if (
      bridge === null ||
      automaticUpdateBusy ||
      automaticUpdateStatus?.update.status !== "ready"
    ) {
      return;
    }
    automaticUpdateBusy = true;
    automaticUpdateNotice = "正在安全關閉本機服務，接著會重新啟動並安裝。";
    renderAutomaticUpdateControl();
    let installStarted = false;
    try {
      const result = await requestAutomaticUpdateInstall(bridge);
      automaticUpdateStatus = result.status;
      installStarted = result.ok;
      automaticUpdateNotice = result.ok
        ? "正在重新啟動並安裝新版。"
        : result.code === "install-busy"
          ? "安裝程序已經開始。"
          : result.code === "not-ready"
            ? "新版尚未準備完成，這次不會重新啟動。"
            : "無法開始安裝；TokenMonster 會繼續保持開啟。";
    } catch {
      automaticUpdateNotice =
        "無法開始安裝；TokenMonster 會繼續保持開啟。";
    } finally {
      if (!installStarted) automaticUpdateBusy = false;
      renderAutomaticUpdateControl();
      if (!installStarted) scheduleAutomaticUpdateRefresh();
    }
  }

  const imageFallback = createCharacterImageFallbackTracker();
  const unlockQueue = createCharacterUnlockQueue();
  const characterMutationGate = createCharacterMutationGate();
  const characterProfileRequestGate = createCharacterProfileRequestGate();
  const voiceGate = createVoicePlaybackGate({
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  });

  function formatAssetPackSize(bytes: number): string {
    const mebibytes = bytes / (1_024 * 1_024);
    return mebibytes >= 1
      ? `${mebibytes.toFixed(1)} MB`
      : `${Math.ceil(bytes / 1_024)} KB`;
  }

  function clearAssetPackRemovalConfirmation(): void {
    assetPackRemovalConfirmationPending = false;
    if (assetPackRemovalConfirmationTimer !== undefined) {
      window.clearTimeout(assetPackRemovalConfirmationTimer);
      assetPackRemovalConfirmationTimer = undefined;
    }
  }

  function renderAssetPackControl(): void {
    const pack = assetPackStatus;
    if (pack === undefined || pack.phase === "unavailable") {
      clearAssetPackRemovalConfirmation();
      assetPackControl.hidden = true;
      assetPackButton.disabled = true;
      assetPackButton.hidden = true;
      assetPackRevokeButton.hidden = true;
      return;
    }
    const controlMode = characterAssetPackControlMode(pack);
    assetPackControl.hidden = false;
    assetPackDisclosure.textContent = `啟用時會一次下載約 ${formatAssetPackSize(pack.downloadBytes!)} 的完整固定素材包（${numberFormatter.format(pack.downloadBytes!)} bytes）。這個請求只取素材，不會傳送你的用量、目前角色、解鎖狀態或服裝選擇；之後可隨時移除並回到字母模式。`;
    assetPackButton.hidden = controlMode.primaryAction === null;
    assetPackButton.disabled =
      assetPackBusy || controlMode.primaryAction === "installing";
    assetPackRevokeButton.hidden = !controlMode.showRevoke;
    assetPackRevokeButton.disabled =
      assetPackBusy || pack.phase === "installing";
    assetPackRevokeButton.textContent = assetPackRemovalConfirmationPending
      ? "再按一次確認移除"
      : "取消啟用並清除素材";
    if (assetPackBusy || pack.phase === "installing") {
      assetPackStatusElement.textContent =
        "正在取得並驗證完整素材；完成前會維持字母模式。";
      assetPackButton.textContent = "正在下載完整素材包…";
      return;
    }
    if (pack.phase === "installed") {
      assetPackStatusElement.textContent =
        assetPackRemovalConfirmationPending
          ? "移除後會立即回到字母模式；若確定要刪除本機素材，請再按一次。"
          : "完整素材已驗證並保存在本機；角色圖現在可以離線顯示。";
      return;
    }
    assetPackButton.textContent = (() => {
      switch (controlMode.primaryAction) {
        case "repair":
          return "重新下載完整素材";
        case "cleanup":
          return "再次清除殘留素材";
        case "installing":
          return "正在下載完整素材包…";
        case "enable":
          return "啟用完整角色圖";
        case null:
          return "";
      }
    })();
    if (pack.phase === "repair-needed") {
      assetPackStatusElement.textContent =
        assetPackRemovalConfirmationPending
          ? "取消啟用會清除已下載的部分素材；若確定，請再按一次。"
          : pack.lastError === "local-state-unavailable"
          ? "已立即回到字母模式，但本機停用設定沒有保存；請在重啟前再試一次。"
          : pack.consented
            ? "你曾同意啟用，但本機素材不完整；不會自動重試。你可以重新取得完整包，或取消啟用並清除素材。"
            : "已回到字母模式，但部分素材暫時無法移除。關閉正在使用圖片的程式後，可在這裡再次清除。";
      return;
    }
    assetPackStatusElement.textContent = (() => {
      switch (pack.lastError) {
        case "download-failed":
          return "這次下載或驗證沒有完成；仍維持字母模式，可以稍後再試。";
        case "cache-unavailable":
          return "本機素材空間暫時無法使用；仍維持字母模式。";
        case "local-state-unavailable":
          return "本機啟用設定暫時無法保存；仍維持字母模式。";
        case null:
          return "目前使用零下載的字母模式；只有你按下啟用後才會取得素材。";
      }
    })();
  }

  function assetPackStatusChanged(
    previous: CharacterAssetPackStatus | undefined,
    next: CharacterAssetPackStatus,
  ): boolean {
    return (
      previous !== undefined &&
      (previous.phase !== next.phase ||
        previous.consented !== next.consented ||
        previous.enabled !== next.enabled ||
        previous.releaseId !== next.releaseId ||
        previous.lastError !== next.lastError)
    );
  }

  async function refreshAssetPackStatus(): Promise<boolean> {
    if (assetPackBusy) return false;
    assetPackController?.abort();
    const controller = new AbortController();
    assetPackController = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    try {
      const previous = assetPackStatus;
      const next = await requestCharacterAssetPackStatus(
        fetch,
        controller.signal,
      );
      assetPackStatus = next;
      if (assetPackStatusChanged(previous, next)) {
        clearAssetPackRemovalConfirmation();
        imageFallback.reset();
        void pollCharacters();
      }
      renderAssetPackControl();
      return true;
    } catch {
      if (assetPackStatus === undefined) assetPackControl.hidden = true;
      return false;
    } finally {
      window.clearTimeout(timeout);
      if (assetPackController === controller) {
        assetPackController = undefined;
      }
    }
  }

  async function mutateAssetPack(enabled: boolean): Promise<void> {
    const current = assetPackStatus;
    if (
      assetPackBusy ||
      current === undefined ||
      current.phase === "unavailable" ||
      current.phase === "installing"
    ) {
      return;
    }
    assetPackBusy = true;
    clearAssetPackRemovalConfirmation();
    renderAssetPackControl();
    assetPackController?.abort();
    const controller = new AbortController();
    assetPackController = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      ASSET_PACK_REQUEST_TIMEOUT_MS,
    );
    let requestFailed = false;
    try {
      const settlement = await settleCharacterAssetPackConsent(
        enabled,
        fetch,
        controller.signal,
      );
      assetPackStatus = settlement.status;
      requestFailed = !settlement.mutationObserved;
      imageFallback.reset();
      await pollCharacters();
    } catch {
      requestFailed = true;
    } finally {
      window.clearTimeout(timeout);
      if (assetPackController === controller) {
        assetPackController = undefined;
      }
      assetPackBusy = false;
      renderAssetPackControl();
      if (requestFailed) {
        assetPackStatusElement.textContent =
          "沒有確認這次素材設定已套用；已顯示目前狀態，請再試一次。";
      }
    }
  }

  interface StagePortraitTarget extends PortraitTarget {
    readonly character: CharacterRosterEntry;
    readonly celebrating: boolean;
  }

  function setSwitchingAffordance(switching: boolean): void {
    switchingElement.hidden = !switching;
    companionVisualElement.classList.toggle("is-switching", switching);
    companionVisualElement.setAttribute(
      "aria-busy",
      switching ? "true" : "false",
    );
  }

  function commitStageMetadata(character: CharacterRosterEntry): void {
    document.documentElement.dataset["character"] = character.characterId;
    companionTitleElement.textContent = `嗨，我是 ${character.displayName}。`;
    companionVisualElement.setAttribute(
      "aria-label",
      `點一下和 ${character.displayName} 夥伴打招呼`,
    );
    characterTapHintElement.textContent = `點一下和 ${character.displayName} 打招呼`;
  }

  function playSparkles(): void {
    if (reducedMotion) return;
    effectsElement.replaceChildren(
      ...Array.from({ length: 12 }, () => {
        const sparkle = document.createElement("span");
        sparkle.className = "character-sparkle";
        sparkle.setAttribute("aria-hidden", "true");
        return sparkle;
      }),
    );
    effectsElement.hidden = false;
    effectsElement.classList.remove("is-active");
    requestAnimationFrame(() => effectsElement.classList.add("is-active"));
    window.setTimeout(() => {
      effectsElement.hidden = true;
      effectsElement.replaceChildren();
    }, 900);
  }

  const stageSwitch = createPortraitStageStateMachine<StagePortraitTarget>(
    letterLayerElement,
    {
      preload: preloadCharacterImage,
      onSwitching: () => setSwitchingAffordance(true),
      onCommit: (target, previous) => {
        imageFallback.recordSuccess(
          target.character.characterId,
          target.imagePath,
        );
        renderedLetterCharacterId = undefined;
        requestedStageKey = `${target.character.characterId}:${target.imagePath}:${target.celebrating}`;
        commitStageMetadata(target.character);
        incomingDollImageElement.src = target.imagePath;
        incomingDollImageElement.hidden = false;
        const animationClasses =
          enabledCharacterAnimationClasses(reducedMotion);
        incomingDollImageElement.classList.toggle(
          "character-entering",
          animationClasses.includes("character-entering") &&
            (previous?.characterId !== target.characterId || entrancePending),
        );
        incomingDollImageElement.classList.toggle(
          "character-crossfade-in",
          animationClasses.includes("character-crossfade-in") &&
            previous?.characterId === target.characterId,
        );
        dollImageElement.classList.toggle(
          "character-crossfade-out",
          animationClasses.includes("character-crossfade-out") &&
            previous?.characterId === target.characterId &&
            !dollImageElement.hidden,
        );
        if (target.celebrating) playSparkles();
        const finish = (): void => {
          if (stageSwitch.current() !== target) return;
          dollImageElement.src = target.imagePath;
          dollImageElement.hidden = false;
          dollImageElement.className = "character-doll";
          incomingDollImageElement.hidden = true;
          incomingDollImageElement.removeAttribute("src");
          incomingDollImageElement.className =
            "character-doll character-doll-incoming";
          entrancePending = false;
          setSwitchingAffordance(false);
        };
        if (reducedMotion) finish();
        else window.setTimeout(finish, 360);
      },
      onError: (target) => {
        requestedStageKey = undefined;
        imageFallback.recordFailure(
          target.character.characterId,
          target.imagePath,
        );
        setSwitchingAffordance(false);
        // A cache miss is expected while shipping entry points are network
        // disabled. Preserve the selected character and try the same theme's
        // less-specific local candidate before settling on its letter fallback.
        renderCharacterStage();
      },
    },
  );

  function persistedSelectedCharacter(): CharacterRosterEntry | undefined {
    const snapshot = charactersSnapshot;
    if (snapshot === undefined) return undefined;
    return selectedRosterCharacter(snapshot);
  }

  function stageCharacter(): CharacterRosterEntry | undefined {
    const snapshot = charactersSnapshot;
    if (snapshot === undefined) return undefined;
    return presentedRosterCharacter(
      snapshot,
      unlockQueue.current()?.characterId,
    );
  }

  function effectiveCharacterProfileRequestState() {
    const state = characterProfileRequestGate.state(Date.now());
    return characterProfileConnectionDegraded
      ? ("unavailable" as const)
      : state;
  }

  function shareCardPalette(
    character: CharacterRosterEntry,
  ): LocalShareCardPalette {
    return character.visual.mode === "letter"
      ? Object.freeze({
          background: character.visual.background,
          foreground: character.visual.foreground,
          accent: character.visual.accent,
        })
      : CHARACTER_SHARE_PALETTE[character.characterId];
  }

  function activeThemeLabel(
    character: CharacterRosterEntry,
  ): string | undefined {
    if (character.activeThemeId === null) return undefined;
    if (character.visual.mode === "letter") {
      return character.visual.themes.find(
        (theme) => theme.themeId === character.activeThemeId,
      )?.displayName;
    }
    return characterThemeLabel(character.activeThemeId);
  }

  function updateShareCardAvailability(): void {
    const character = persistedSelectedCharacter();
    const celebrating = unlockQueue.current() !== undefined;
    const characterMutationPending = characterMutationGate.pending();
    const progressionRepairPending =
      progressionLockRepairState === "checking";
    const hasUsage =
      charactersSnapshot !== undefined && lastGoodSnapshot !== undefined;
    const profileRequestState = effectiveCharacterProfileRequestState();
    const hasCurrentProfile = canShareCharacterProfile(
      characterProfile,
      profileRequestState,
      currentUtcDate(),
    );
    const available =
      character !== undefined &&
      hasUsage &&
      hasCurrentProfile &&
      !celebrating &&
      !characterMutationPending &&
      !progressionRepairPending;
    shareCardButton.disabled = shareCardBusy || !available;
    shareCardHideTotal.disabled = shareCardBusy || !available;
    shareCardButton.textContent = shareCardBusy ? "正在製作…" : "儲存 PNG";
    if (!shareCardBusy) {
      if (!available) {
        if (celebrating) {
          shareCardStatus.textContent =
            "正在歡迎新夥伴；慶祝結束後再儲存夥伴卡。";
        } else if (characterMutationPending) {
          shareCardStatus.textContent =
            "正在套用你的角色選擇；完成後再儲存夥伴卡。";
        } else if (progressionRepairPending) {
          shareCardStatus.textContent =
            "正在安全檢查角色進度；完成後再儲存夥伴卡。";
        } else if (
          character === undefined &&
          charactersSnapshot !== undefined
        ) {
          shareCardStatus.textContent =
            "先選一位夥伴，才能把這次相遇存成圖片。";
        } else if (!hasUsage) {
          shareCardStatus.textContent =
            "本機用量整理完成後，就能把這次相遇存成圖片。";
        } else if (profileRequestState === "loading") {
          shareCardStatus.textContent =
            "正在整理今天的默契；完成後就能存成圖片。";
        } else if (characterProfileConnectionDegraded) {
          shareCardStatus.textContent =
            "本機服務恢復並更新今日默契後，就能存成圖片。";
        } else if (profileRequestState === "unavailable") {
          shareCardStatus.textContent =
            "今日默契暫時沒更新；我會在一分鐘後自動再試。";
        } else if (profileRequestState === "stale") {
          shareCardStatus.textContent =
            "今日默契已超過十五分鐘，更新完成後就能存成圖片。";
        } else {
          shareCardStatus.textContent =
            "正在等今天最新的默契側寫，完成後就能存成圖片。";
        }
      } else if (!shareCardAvailable) {
        shareCardStatus.textContent = shareCardHideTotal.checked
          ? "角色、今日默契與收藏會留在圖片上；28 日 Token 總量會隱藏。"
          : "角色、今日默契、收藏與近 28 日足跡會直接在本機繪成圖片。";
      }
    }
    shareCardAvailable = available;
  }

  function syncOverlayInertState(): void {
    for (const element of starterChoiceBackground) {
      element.inert = starterChoiceSheetActive || byokDrawerOpen;
    }
    for (const element of byokModalBackground) {
      element.inert = byokDrawerOpen;
    }
  }

  function resetByokConversation(closeDrawer: boolean): void {
    byokRequestSequence += 1;
    byokController?.abort();
    byokController = undefined;
    byokBusy = false;
    byokHistory = Object.freeze([]);
    byokNotice = undefined;
    byokMessageInput.value = "";
    if (closeDrawer) byokDrawerOpen = false;
  }

  function renderByokTranscript(): void {
    const fragment = document.createDocumentFragment();
    for (const message of byokHistory) {
      const item = document.createElement("li");
      item.dataset["role"] = message.role;
      item.textContent = message.text;
      fragment.append(item);
    }
    if (byokNotice !== undefined) {
      const notice = document.createElement("li");
      notice.dataset["role"] = "status";
      notice.textContent = byokNotice;
      fragment.append(notice);
    }
    byokTranscript.replaceChildren(fragment);
    byokTranscript.scrollTop = byokTranscript.scrollHeight;
  }

  function renderByokPanel(): void {
    const selected = persistedSelectedCharacter()?.characterId;
    if (selected !== byokConversationCharacterId) {
      resetByokConversation(false);
      byokConversationCharacterId = selected;
    }
    const available =
      byokStatus?.availability === "available" &&
      isByokChatCharacter(selected ?? null);
    byokPanel.hidden = !available;
    if (!available) {
      byokDrawerOpen = false;
      byokDrawer.hidden = true;
      syncOverlayInertState();
      return;
    }

    const status = byokStatus;
    if (status === undefined) return;
    byokToggle.disabled = byokBusy;
    byokToggle.setAttribute("aria-expanded", byokDrawerOpen ? "true" : "false");
    byokToggle.textContent = byokDrawerOpen ? "收起對話" : "打開對話";
    byokDrawer.hidden = !byokDrawerOpen;
    syncOverlayInertState();
    byokConfigureForm.hidden = status.configured;
    byokConversation.hidden = !status.configured;
    byokPersistInput.disabled = byokBusy || !status.canPersist;
    if (!status.canPersist) byokPersistInput.checked = false;
    byokKeyInput.disabled = byokBusy;
    byokConfigureSubmit.disabled = byokBusy;
    byokMessageInput.disabled = byokBusy;
    byokSend.disabled = byokBusy || byokMessageInput.value.trim().length === 0;
    byokClear.disabled = byokBusy;
    byokClose.disabled = false;
    byokStatusElement.textContent =
      byokNotice ??
      (status.configured
        ? status.persistence === "os-backed"
          ? "OpenAI key 已由作業系統安全儲存；對話只留在這個畫面。"
          : "OpenAI key 只留在這次執行的記憶體；關閉 TokenMonster 就會清除。"
        : status.canPersist
          ? "可用自己的 OpenAI key 即時對話；沒有 key 時仍使用本機固定台詞。"
          : "可用自己的 OpenAI key 即時對話；這個環境只會暫存在記憶體。");
    renderByokTranscript();
  }

  async function refreshByokStatus(): Promise<void> {
    const sequence = ++byokRequestSequence;
    const controller = new AbortController();
    byokController?.abort();
    byokController = controller;
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const status = await requestByokStatus(fetch, controller.signal);
      if (sequence !== byokRequestSequence) return;
      byokStatus = status;
    } catch {
      if (sequence !== byokRequestSequence) return;
      byokStatus = undefined;
    } finally {
      window.clearTimeout(timeout);
      if (byokController === controller) byokController = undefined;
      if (sequence === byokRequestSequence) renderByokPanel();
    }
  }

  async function submitByokConfiguration(): Promise<void> {
    if (byokBusy || byokStatus?.availability !== "available") return;
    const apiKey = byokKeyInput.value;
    byokKeyInput.value = "";
    const sequence = ++byokRequestSequence;
    const controller = new AbortController();
    byokController?.abort();
    byokController = controller;
    byokBusy = true;
    byokNotice = "正在本機設定 OpenAI key…";
    renderByokPanel();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const status = await configureByok(
        apiKey,
        byokPersistInput.checked,
        fetch,
        controller.signal,
      );
      if (sequence !== byokRequestSequence) return;
      byokStatus = status;
      byokNotice = "已設定完成。key 不會送到 TokenMonster 公開服務。";
    } catch (error) {
      if (sequence !== byokRequestSequence) return;
      byokNotice =
        error instanceof ByokRequestError && error.code === "invalid-key"
          ? "這把 key 的格式不完整，請重新貼上。"
          : "這次沒有保存 key；本機角色與固定台詞仍可使用。";
    } finally {
      window.clearTimeout(timeout);
      if (sequence === byokRequestSequence) {
        byokBusy = false;
        if (byokController === controller) byokController = undefined;
        renderByokPanel();
      }
    }
  }

  async function deleteByokKey(): Promise<void> {
    if (byokBusy || byokStatus?.configured !== true) return;
    const sequence = ++byokRequestSequence;
    const controller = new AbortController();
    byokController?.abort();
    byokController = controller;
    byokBusy = true;
    byokNotice = "正在刪除本機 OpenAI key…";
    renderByokPanel();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const status = await clearByok(fetch, controller.signal);
      if (sequence !== byokRequestSequence) return;
      byokStatus = status;
      byokHistory = Object.freeze([]);
      byokNotice = "本機 key 與這次對話都已清除。";
    } catch {
      if (sequence !== byokRequestSequence) return;
      byokNotice = "這次沒有刪除成功；請再試一次。";
    } finally {
      window.clearTimeout(timeout);
      if (sequence === byokRequestSequence) {
        byokBusy = false;
        if (byokController === controller) byokController = undefined;
        renderByokPanel();
      }
    }
  }

  async function sendByokMessage(): Promise<void> {
    const characterId = persistedSelectedCharacter()?.characterId ?? null;
    const message = byokMessageInput.value.trim();
    if (
      byokBusy ||
      byokStatus?.configured !== true ||
      !isByokChatCharacter(characterId) ||
      message.length === 0
    ) {
      return;
    }
    byokMessageInput.value = "";
    const sequence = ++byokRequestSequence;
    const controller = new AbortController();
    byokController?.abort();
    byokController = controller;
    byokBusy = true;
    byokNotice = "她正在透過 OpenAI 回覆…";
    renderByokPanel();
    const timeout = window.setTimeout(
      () => controller.abort(),
      BYOK_CHAT_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await requestByokChat(
        characterId,
        byokHistory,
        message,
        fetch,
        controller.signal,
      );
      if (sequence !== byokRequestSequence) return;
      if (response.status === "ok") {
        byokHistory = appendByokChatExchange(
          byokHistory,
          message,
          response.text,
        );
        byokNotice = undefined;
      } else {
        byokNotice = byokChatErrorText(response.error);
      }
    } catch {
      if (sequence !== byokRequestSequence) return;
      byokNotice = "即時對話暫時沒接上；角色與本機固定台詞都不受影響。";
    } finally {
      window.clearTimeout(timeout);
      if (sequence === byokRequestSequence) {
        byokBusy = false;
        if (byokController === controller) byokController = undefined;
        renderByokPanel();
      }
    }
  }

  function renderCharacterProfile(): void {
    const profile = characterProfile;
    const presentation = characterProfilePresentation;
    const requestState = effectiveCharacterProfileRequestState();
    if (profile === undefined || presentation === undefined) {
      if (requestState !== "unavailable" && requestState !== "stale") {
        characterProfileElement.hidden = true;
        return;
      }
      characterProfileElement.hidden = false;
      delete characterProfileElement.dataset["profileEnergy"];
      characterProfileElement.dataset["profileStatus"] = "unavailable";
      profileMoodElement.textContent = "今日默契暫時未更新";
      profileCoverageElement.textContent = characterProfileConnectionDegraded
        ? "本機服務恢復後自動更新"
        : requestState === "stale"
          ? "正在更新"
          : "一分鐘後自動再試";
      profileSummaryElement.textContent =
        "角色、收藏與本機用量仍可正常使用；側寫恢復後才會開放夥伴卡。";
      const waiting = document.createElement("span");
      waiting.className = "profile-trait";
      waiting.textContent = "等待本機側寫";
      profileTraitsElement.replaceChildren(waiting);
      profileReasonListElement.replaceChildren();
      profileReasonsElement.hidden = true;
      return;
    }

    const isCurrentDay = profile.window.toUtcDate === currentUtcDate();
    const degraded =
      requestState !== "ready" ||
      profile.freshness !== "fresh" ||
      !isCurrentDay;
    characterProfileElement.hidden = false;
    characterProfileElement.dataset["profileEnergy"] = profile.mood.energyBand;
    characterProfileElement.dataset["profileStatus"] = degraded
      ? "degraded"
      : "ready";
    profileMoodElement.textContent = presentation.mood.label;
    profileCoverageElement.textContent = (() => {
      if (requestState === "loading") {
        return `${presentation.stateLabel}・正在更新，先沿用最近側寫`;
      }
      if (requestState === "unavailable") {
        return `${presentation.stateLabel}・暫時無法更新，先沿用最近側寫`;
      }
      if (requestState === "stale") {
        return `${presentation.stateLabel}・超過十五分鐘，正在更新`;
      }
      return degraded
        ? `${presentation.stateLabel}・沿用最近側寫`
        : presentation.stateLabel;
    })();
    profileSummaryElement.textContent = `${presentation.mood.description} ${presentation.summary}`;

    const traitElements = presentation.traits.map((trait) => {
      const element = document.createElement("span");
      element.className = "profile-trait";
      element.textContent = trait.label;
      element.title = trait.description;
      return element;
    });
    if (traitElements.length === 0) {
      const learning = document.createElement("span");
      learning.className = "profile-trait";
      learning.textContent = "自然認識中";
      traitElements.push(learning);
    }
    profileTraitsElement.replaceChildren(...traitElements);

    const reasonLines = [
      ...new Set([
        ...presentation.reasonLines,
        presentation.evolution.description,
        degraded
          ? "這不是今天最新的側寫；更新成功前不會放進夥伴卡。"
          : presentation.freshnessNote,
        presentation.dataNote,
      ]),
    ];
    profileReasonListElement.replaceChildren(
      ...reasonLines.map((reason) => {
        const item = document.createElement("li");
        item.textContent = reason;
        return item;
      }),
    );
    profileReasonsElement.hidden = reasonLines.length === 0;
  }

  function scheduleCharacterProfileRefresh(delayMs: number): void {
    if (characterProfileRetryTimer !== undefined) {
      window.clearTimeout(characterProfileRetryTimer);
    }
    characterProfileRetryTimer = window.setTimeout(() => {
      characterProfileRetryTimer = undefined;
      void refreshCharacterProfile();
    }, delayMs);
  }

  function scheduleCharacterProfileClockBoundary(): void {
    if (characterProfileClockTimer !== undefined) {
      window.clearTimeout(characterProfileClockTimer);
    }
    characterProfileClockTimer = window.setTimeout(
      () => {
        characterProfileClockTimer = undefined;
        renderCharacterProfile();
        updateShareCardAvailability();
        void refreshCharacterProfile(true);
        scheduleCharacterProfileClockBoundary();
      },
      millisecondsUntilNextUtcDate(Date.now()) + 25,
    );
  }

  async function refreshCharacterProfile(force = false): Promise<void> {
    const attemptedAt = Date.now();
    const requestSequence = characterProfileRequestGate.begin(
      attemptedAt,
      force,
    );
    if (requestSequence === undefined) return;
    if (characterProfileRetryTimer !== undefined) {
      window.clearTimeout(characterProfileRetryTimer);
      characterProfileRetryTimer = undefined;
    }
    renderCharacterProfile();
    updateShareCardAvailability();
    characterProfileController?.abort();
    const controller = new AbortController();
    characterProfileController = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    try {
      const profile = await requestCharacterProfile(controller.signal);
      const currentAndFresh =
        profile.freshness === "fresh" &&
        profile.window.toUtcDate === currentUtcDate();
      const settled = currentAndFresh
        ? characterProfileRequestGate.succeed(requestSequence, Date.now())
        : characterProfileRequestGate.fail(requestSequence, Date.now());
      if (!settled) {
        return;
      }
      characterProfile = profile;
      characterProfilePresentation = presentCharacterProfile(profile);
      renderCharacterProfile();
      scheduleCharacterProfileRefresh(
        currentAndFresh
          ? CHARACTER_PROFILE_SUCCESS_REFRESH_MS
          : CHARACTER_PROFILE_FAILURE_RETRY_MS,
      );
    } catch {
      if (!characterProfileRequestGate.fail(requestSequence, Date.now())) {
        return;
      }
      renderCharacterProfile();
      scheduleCharacterProfileRefresh(CHARACTER_PROFILE_FAILURE_RETRY_MS);
    } finally {
      window.clearTimeout(timeout);
      if (characterProfileController === controller) {
        characterProfileController = undefined;
      }
      updateShareCardAvailability();
    }
  }

  async function saveLocalShareCard(): Promise<void> {
    if (shareCardBusy) return;
    const character = persistedSelectedCharacter();
    const roster = charactersSnapshot;
    const usage = lastGoodSnapshot;
    const profile = characterProfile;
    const profilePresentation = characterProfilePresentation;
    const profileRequestState = effectiveCharacterProfileRequestState();
    if (
      character === undefined ||
      roster === undefined ||
      usage === undefined ||
      profilePresentation === undefined ||
      unlockQueue.current() !== undefined ||
      characterMutationGate.pending() ||
      !canShareCharacterProfile(profile, profileRequestState, currentUtcDate())
    ) {
      updateShareCardAvailability();
      return;
    }
    const profileRequestSequence = characterProfileRequestGate.sequence();
    const characterMutationRevision = characterMutationGate.revision();
    const stageTarget = stageSwitch.current();
    const shareImage = (() => {
      if (
        character.visual.mode !== "doll" ||
        stageTarget?.characterId !== character.characterId
      ) {
        return undefined;
      }
      const element = [incomingDollImageElement, dollImageElement].find(
        (candidate) =>
          !candidate.hidden &&
          candidate.complete &&
          candidate.naturalWidth > 0 &&
          candidate.naturalHeight > 0 &&
          candidate.getAttribute("src") === stageTarget.imagePath,
      );
      return element === undefined
        ? undefined
        : Object.freeze({
            source: element as CanvasImageSource,
            naturalWidth: element.naturalWidth,
            naturalHeight: element.naturalHeight,
          });
    })();
    const sharedStagePath =
      shareImage === undefined || stageTarget === undefined
        ? null
        : stageTarget.imagePath;
    shareCardBusy = true;
    shareCardStatus.textContent = "正在本機繪製你的夥伴卡…";
    updateShareCardAvailability();
    let completionMessage: string | undefined;
    try {
      const themeLabel = activeThemeLabel(character);
      const blob = await renderLocalShareCard(
        {
          character: {
            displayName: character.displayName,
            glyph:
              character.visual.mode === "letter"
                ? character.visual.glyph
                : CHARACTER_VIEW[character.characterId].glyph,
            palette: shareCardPalette(character),
            ...(themeLabel === undefined ? {} : { themeLabel }),
          },
          collection: {
            unlocked: roster.characters.filter((entry) => entry.unlocked)
              .length,
            total: roster.characters.length,
          },
          usage28Days: shareCardHideTotal.checked
            ? { hidden: true }
            : { totalTokens: usage.totals.last28Days },
          mood: profilePresentation.shareCard.mood,
          traitLabels: profilePresentation.shareCard.traitLabels,
          evolution: profilePresentation.shareCard.evolution,
          attribution: profilePresentation.shareCard.attribution,
          generatedAt: usage.generatedAt,
        },
        shareImage === undefined ? {} : { characterImage: shareImage },
      );
      if (
        profileRequestSequence !== characterProfileRequestGate.sequence() ||
        characterMutationRevision !== characterMutationGate.revision() ||
        characterMutationGate.pending() ||
        unlockQueue.current() !== undefined ||
        roster !== charactersSnapshot ||
        usage !== lastGoodSnapshot ||
        persistedSelectedCharacter()?.characterId !== character.characterId ||
        persistedSelectedCharacter()?.activeThemeId !==
          character.activeThemeId ||
        (sharedStagePath !== null &&
          (stageSwitch.current()?.characterId !== character.characterId ||
            stageSwitch.current()?.imagePath !== sharedStagePath)) ||
        !canShareCharacterProfile(
          characterProfile,
          effectiveCharacterProfileRequestState(),
          currentUtcDate(),
        )
      ) {
        completionMessage = "角色或今日默契已更新，請再儲存一次夥伴卡。";
        return;
      }
      const saveResult = await saveLocalShareCardBlob(blob);
      completionMessage = (() => {
        switch (saveResult.status) {
          case "saved":
            return "已存檔；圖片只有角色、今日默契、收藏與彙總用量，不含對話內容。";
          case "cancelled":
            return "已取消儲存；夥伴卡沒有寫入檔案。";
          case "already-exists":
            return "同名夥伴卡已存在；請先移動舊檔或換個位置再試。";
          case "download-started":
            return "已交給瀏覽器下載；是否完成請查看瀏覽器下載清單。";
          case "failed":
            return "這次沒有存成圖片，請稍後再試；角色與用量仍保留在本機。";
        }
      })();
    } catch {
      completionMessage =
        "這次沒有存成圖片，請稍後再試；角色與用量仍保留在本機。";
    } finally {
      shareCardBusy = false;
      updateShareCardAvailability();
      if (completionMessage !== undefined) {
        shareCardStatus.textContent = completionMessage;
      }
    }
  }

  function clearCharacterSpeech(): void {
    if (characterSpeechTimer !== undefined) {
      window.clearTimeout(characterSpeechTimer);
      characterSpeechTimer = undefined;
    }
    characterSpeechElement.hidden = true;
    characterSpeechElement.textContent = "";
  }

  function invalidateCharacterInteraction(): void {
    characterInteractionSequence += 1;
    characterInteractionController?.abort();
    characterInteractionController = undefined;
    clearCharacterSpeech();
  }

  function showCharacterSpeech(text: string): void {
    clearCharacterSpeech();
    characterSpeechElement.textContent = text;
    characterSpeechElement.hidden = false;
    characterSpeechTimer = window.setTimeout(() => {
      characterSpeechTimer = undefined;
      characterSpeechElement.hidden = true;
      characterSpeechElement.textContent = "";
    }, 7_000);
  }

  function playCharacterTapFeedback(): void {
    if (characterTapTimer !== undefined) {
      window.clearTimeout(characterTapTimer);
    }
    companionVisualElement.classList.remove("is-tapped", "is-tapped-static");
    // Restart the short reaction even when taps arrive close together.
    void companionVisualElement.offsetWidth;
    const className = reducedMotion ? "is-tapped-static" : "is-tapped";
    companionVisualElement.classList.add(className);
    characterTapTimer = window.setTimeout(
      () => {
        characterTapTimer = undefined;
        companionVisualElement.classList.remove(className);
      },
      reducedMotion ? 220 : 440,
    );
  }

  async function interactWithSelectedCharacter(): Promise<void> {
    const character = persistedSelectedCharacter();
    if (
      character === undefined ||
      unlockQueue.current() !== undefined ||
      characterMutationGate.pending() ||
      progressionLockRepairState === "checking"
    ) {
      return;
    }
    playCharacterTapFeedback();
    if (characterInteractionController !== undefined) return;
    const requestSequence = characterInteractionSequence;
    const controller = new AbortController();
    characterInteractionController = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await requestCharacterInteraction(
        character.characterId,
        getUiLocale(),
        fetch,
        controller.signal,
      );
      if (
        !isCurrentCharacterInteraction(
          requestSequence,
          characterInteractionSequence,
          character.characterId,
          persistedSelectedCharacter()?.characterId,
          response.characterId,
        )
      ) {
        return;
      }
      if (response.outcome === "line") showCharacterSpeech(response.line.text);
    } catch {
      // The immediate local animation is still useful if persistence is busy.
    } finally {
      window.clearTimeout(timeout);
      if (characterInteractionController === controller) {
        characterInteractionController = undefined;
      }
    }
  }

  function setLetterStage(character?: CharacterRosterEntry): void {
    const isLetter = character?.visual.mode === "letter";
    const entering =
      isLetter && renderedLetterCharacterId !== character.characterId;
    const view =
      character === undefined
        ? CHARACTER_VIEW.chatgpt
        : CHARACTER_VIEW[character.characterId];
    companionGlyphElement.textContent = isLetter
      ? character.visual.glyph
      : view.glyph;
    const style = companionVisualElement.style;
    if (isLetter) {
      style.setProperty("--letter-background", character.visual.background);
      style.setProperty("--letter-foreground", character.visual.foreground);
      style.setProperty("--letter-accent", character.visual.accent);
      applyLetterThemePreview(
        companionFaceElement,
        character.visual.themes.find(
          (theme) =>
            theme.themeId === character.activeThemeId && theme.unlocked,
        ),
      );
    } else {
      style.removeProperty("--letter-background");
      style.removeProperty("--letter-foreground");
      style.removeProperty("--letter-accent");
      applyLetterThemePreview(companionFaceElement, undefined);
    }
    stageSwitch.cancel();
    requestedStageKey = undefined;
    dollImageElement.removeAttribute("src");
    dollImageElement.hidden = true;
    incomingDollImageElement.removeAttribute("src");
    incomingDollImageElement.hidden = true;
    letterLayerElement.hidden = false;
    setSwitchingAffordance(false);
    if (character !== undefined) {
      commitStageMetadata(character);
      if (isLetter) {
        const activeTheme = character.visual.themes.find(
          (theme) => theme.themeId === character.activeThemeId,
        );
        if (activeTheme !== undefined) {
          companionVisualElement.setAttribute(
            "aria-label",
            characterThemeStageGreetingLabel(
              character.displayName,
              activeTheme.themeId,
            ),
          );
        }
      }
      renderedLetterCharacterId = character.characterId;
      letterLayerElement.classList.toggle(
        "character-entering",
        !reducedMotion && entering,
      );
      if (entering) {
        window.setTimeout(
          () => letterLayerElement.classList.remove("character-entering"),
          360,
        );
      }
    } else {
      renderedLetterCharacterId = undefined;
    }
  }

  function playVoice(
    character: CharacterRosterEntry,
    trigger: VoiceTrigger,
  ): CharacterVoiceLine | undefined {
    if (charactersSnapshot?.voiceEnabled !== true) return undefined;
    const line = character.voiceLines.find(
      (candidate) => candidate.trigger === trigger,
    );
    if (
      line === undefined ||
      !voiceGate.allow(trigger, character.characterId, Date.now())
    ) {
      return undefined;
    }
    voiceAudio.pause();
    voiceAudio.currentTime = 0;
    voiceAudio.src = line.path;
    void voiceAudio.play().catch(() => undefined);
    return line;
  }

  function renderCharacterStage(): void {
    const character = stageCharacter();
    companionVisualElement.disabled =
      character === undefined ||
      unlockQueue.current() !== undefined ||
      characterMutationGate.pending() ||
      progressionLockRepairState === "checking";
    if (character === undefined) {
      setLetterStage();
      return;
    }
    if (character.visual.mode === "letter") {
      setLetterStage(character);
      return;
    }
    if (
      needsColdStartLetterFallback({
        dollHidden: Boolean(dollImageElement.hidden),
        incomingDollHidden: Boolean(incomingDollImageElement.hidden),
        renderedLetterCharacterId,
        targetCharacterId: character.characterId,
      })
    ) {
      // The DTO may describe a doll even when the fixed CDN is disabled or
      // unreachable. Prime a target-specific local letter before decoding so
      // cold start never leaves the HTML's default ChatGPT glyph on screen.
      setLetterStage(character);
    }
    const celebrating =
      unlockQueue.current()?.characterId === character.characterId;
    if (character.visual.mode !== "doll") return;
    const resolvedStage = resolveCharacterStage(
      character,
      characterConnectionState,
      latestTodayTokens,
      celebrating,
      (candidate) => imageFallback.canAttempt(character.characterId, candidate),
    );
    if (resolvedStage.mode === "letter") {
      setLetterStage(character);
      return;
    }
    const imagePath = resolvedStage.imagePath;
    const stageKey = `${character.characterId}:${imagePath}:${celebrating}`;
    if (requestedStageKey === stageKey) return;
    requestedStageKey = stageKey;
    void stageSwitch.transition({
      characterId: character.characterId,
      imagePath,
      character,
      celebrating,
    });
  }

  function renderProgressionLockRepair(): void {
    const view = progressionLockRepairView(progressionLockRepairState);
    progressionLockRepairButton.hidden = !view.showControl;
    progressionLockRepairButton.disabled = view.controlDisabled;
    progressionLockRepairButton.textContent = view.controlLabel;
    if (view.reasonOverride !== null) {
      characterReasonElement.textContent = view.reasonOverride;
    }
  }

  async function chooseCharacter(characterId: CharacterId): Promise<void> {
    // The gateway atomically accepts the first clean-install starter. Keep the
    // UI single-flight so a rapid second click never promises a different
    // latest-wins result that the server cannot commit.
    if (
      unlockQueue.current() !== undefined ||
      progressionLockRepairState === "checking"
    ) {
      return;
    }
    const mutation = characterMutationGate.beginWhenIdle("selection");
    if (mutation === undefined) return;
    characterSelectionController?.abort();
    const controller = new AbortController();
    characterSelectionController = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    invalidateCharacterInteraction();
    setSwitchingAffordance(true);
    companionVisualElement.disabled = true;
    characterTapHintElement.textContent = "正在換夥伴，完成後再打招呼";
    progressionLockRepairState = "hidden";
    renderProgressionLockRepair();
    characterReasonElement.textContent =
      "正在確認你選的夥伴；完成前先不接受另一個角色選擇。";
    renderRoster();
    renderWardrobe();
    updateShareCardAvailability();
    let failure: "store-busy" | "other" | undefined;
    try {
      const response = await requestCharacterSelection(
        characterId,
        fetch,
        controller.signal,
      );
      if (!characterMutationGate.isCurrent(mutation)) return;
      if (
        response.selection.characterId !== characterId ||
        charactersSnapshot === undefined
      ) {
        throw new Error("Invalid character selection response");
      }
      const candidate = applyCharacterSelection(charactersSnapshot, response);
      const target = candidate.characters.find(
        (character) =>
          character.characterId === characterId && character.unlocked,
      );
      if (target === undefined) throw new Error("Character unavailable");
      charactersSnapshot = candidate;
      entrancePending = true;
      requestedStageKey = undefined;
    } catch (error) {
      if (characterMutationGate.isCurrent(mutation)) {
        failure =
          error instanceof CharacterProgressionWriteError &&
          error.code === "store-busy"
            ? "store-busy"
            : "other";
        if (failure === "store-busy") {
          progressionLockRepairState = "available";
        }
      }
    } finally {
      window.clearTimeout(timeout);
      if (characterSelectionController === controller) {
        characterSelectionController = undefined;
      }
      const settled = characterMutationGate.finish(mutation);
      if (shouldRenderAfterCharacterMutation(settled)) {
        setSwitchingAffordance(false);
        renderCharacterPanel();
        if (settled.current && failure === "other") {
          characterReasonElement.textContent =
            "這次沒有換成功，原本的夥伴會繼續陪你。";
        }
      }
      if (settled.idle) void pollCharacters();
    }
  }

  async function repairProgressionLock(): Promise<void> {
    if (
      progressionLockRepairState === "checking" ||
      characterMutationGate.pending() ||
      unlockQueue.current() !== undefined
    ) {
      return;
    }
    const confirmed = window.confirm(
      "請保留這個視窗。若其他或舊版 TokenMonster 仍在執行，請先從其系統匣／選單列選「結束 TokenMonster」。確認只剩這個視窗後再繼續；修復只會移除舊版留下的鎖，不會重設角色進度。",
    );
    if (!confirmed) return;
    progressionLockRepairController?.abort();
    const controller = new AbortController();
    progressionLockRepairController = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    progressionLockRepairState = "checking";
    renderCharacterPanel();
    try {
      await requestCharacterProgressionLockRepair(fetch, controller.signal);
      progressionLockRepairState = "ready";
    } catch (error) {
      progressionLockRepairState =
        error instanceof CharacterProgressionWriteError &&
        error.code === "store-busy"
          ? "busy"
          : "failed";
    } finally {
      window.clearTimeout(timeout);
      if (progressionLockRepairController === controller) {
        progressionLockRepairController = undefined;
      }
      renderCharacterPanel();
    }
  }

  function renderRoster(): void {
    const fragment = document.createDocumentFragment();
    const allCharacters = charactersSnapshot?.characters ?? [];
    const celebrating = unlockQueue.current() !== undefined;
    const mutationPending = characterMutationGate.pending();
    const progressionRepairPending =
      progressionLockRepairState === "checking";
    const blocked = celebrating || mutationPending || progressionRepairPending;
    const roster =
      charactersSnapshot === undefined
        ? visibleCharacterRoster(allCharacters)
        : visibleCharacterRoster(charactersSnapshot);
    const initialChoiceMode =
      charactersSnapshot?.selection.characterId === null;
    document.documentElement.dataset["starterChoice"] = initialChoiceMode
      ? "pending"
      : "settled";
    starterChoiceSheetActive = initialChoiceMode && companionView === "pet";
    syncOverlayInertState();
    rosterElement.classList.toggle("is-initial-choice", initialChoiceMode);
    for (const character of roster.selectable) {
      const initialStarterChoice = character.isStarter && initialChoiceMode;
      const recommendedStarter =
        initialStarterChoice &&
        character.characterId === starterRecommendationId;
      const cardIdentity = characterRosterCardIdentity(
        character,
        initialStarterChoice,
      );
      const button = document.createElement("button");
      button.type = "button";
      button.className = [
        "roster-chip",
        ...(initialStarterChoice ? ["is-initial-choice"] : []),
        ...(recommendedStarter ? ["is-recommended"] : []),
      ].join(" ");
      button.dataset["characterId"] = character.characterId;
      button.setAttribute(
        "aria-pressed",
        charactersSnapshot?.selection.characterId === character.characterId
          ? "true"
          : "false",
      );
      const portrait = document.createElement("span");
      portrait.className = "roster-portrait";
      const glyph = document.createElement("span");
      glyph.className = "roster-glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = initialStarterChoice
        ? ([...cardIdentity.name][0] ?? "")
        : character.visual.mode === "letter"
          ? character.visual.glyph
          : CHARACTER_VIEW[character.characterId].glyph;
      portrait.append(glyph);
      if (character.visual.mode === "doll") {
        const avatar = document.createElement("img");
        avatar.alt = "";
        avatar.loading = "lazy";
        avatar.src = character.visual.avatarPath;
        avatar.addEventListener("load", () => {
          glyph.hidden = true;
        });
        avatar.addEventListener("error", () => {
          avatar.hidden = true;
          glyph.hidden = false;
        });
        portrait.append(avatar);
      }
      const name = document.createElement("span");
      name.className = "roster-name";
      name.textContent = cardIdentity.name;
      button.append(portrait, name);
      if (cardIdentity.taglineZhTw !== null) {
        const tagline = document.createElement("span");
        tagline.className = "roster-tagline";
        tagline.textContent = cardIdentity.taglineZhTw;
        button.append(tagline);
      }
      if (recommendedStarter) {
        const recommendation = document.createElement("span");
        recommendation.className = "roster-recommendation";
        recommendation.textContent = "依本機用量推薦";
        button.append(recommendation);
      }
      button.setAttribute(
        "aria-label",
        blocked
          ? celebrating
            ? `${cardIdentity.name} 暫時無法選擇，正在歡迎新夥伴。`
            : progressionRepairPending
              ? `${cardIdentity.name} 暫時無法選擇，正在安全檢查角色進度。`
              : `${cardIdentity.name} 暫時無法選擇，正在套用角色或服裝。`
          : initialStarterChoice
            ? `選擇 ${cardIdentity.name} 作為第一位夥伴${
                cardIdentity.taglineZhTw === null
                  ? ""
                  : `：${cardIdentity.taglineZhTw}`
              }${recommendedStarter ? "。依本機用量推薦，但仍由你決定" : ""}`
            : `選擇 ${character.displayName}`,
      );
      if (blocked) {
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
        button.title = celebrating
          ? "正在歡迎新夥伴；慶祝結束後就能繼續選擇。"
          : progressionRepairPending
            ? "安全檢查完成後就能繼續選擇。"
            : "正在套用角色或服裝；完成後就能繼續選擇。";
      } else {
        button.addEventListener("click", () => {
          void chooseCharacter(character.characterId);
        });
      }
      fragment.append(button);
    }
    if (roster.lockedCount > 0) {
      const collection = characterCollectionView(allCharacters);
      const lockedSummary = document.createElement("div");
      lockedSummary.className = "roster-locked-summary";
      const count = document.createElement("strong");
      count.textContent = `已遇見 ${numberFormatter.format(collection.unlockedCount)} / ${numberFormatter.format(collection.totalCount)} 位夥伴`;
      const next = document.createElement("span");
      next.textContent =
        collection.nextProgressPercent === null
          ? "日常使用會自然記下新的相遇。"
          : `下一次相遇進度 ${numberFormatter.format(collection.nextProgressPercent)}%`;
      lockedSummary.append(count, next);
      if (collection.nextProgressPercent !== null) {
        const progress = document.createElement("span");
        progress.className = "collection-progress";
        progress.setAttribute("role", "progressbar");
        progress.setAttribute("aria-label", "下一位夥伴的本機相遇進度");
        progress.setAttribute("aria-valuemin", "0");
        progress.setAttribute("aria-valuemax", "100");
        progress.setAttribute(
          "aria-valuenow",
          String(collection.nextProgressPercent),
        );
        const fill = document.createElement("span");
        fill.style.width = `${collection.nextProgressPercent}%`;
        progress.append(fill);
        lockedSummary.append(progress);
      }
      fragment.append(lockedSummary);
    }
    rosterElement.replaceChildren(fragment);
  }

  async function chooseTheme(
    characterId: CharacterId,
    themeId: CharacterThemeId,
  ): Promise<void> {
    if (
      unlockQueue.current() !== undefined ||
      progressionLockRepairState === "checking"
    ) {
      return;
    }
    const mutation = characterMutationGate.beginWhenIdle("wardrobe");
    if (mutation === undefined) return;
    characterWardrobeController?.abort();
    const controller = new AbortController();
    characterWardrobeController = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    characterReasonElement.textContent =
      "正在換上你選的服裝；完成前先不接受其他角色或服裝選擇。";
    renderRoster();
    renderWardrobe();
    renderCharacterStage();
    updateShareCardAvailability();
    let failed = false;
    try {
      const response = await requestCharacterWardrobe(
        characterId,
        themeId,
        fetch,
        controller.signal,
      );
      if (!characterMutationGate.isCurrent(mutation)) return;
      if (
        response.characterId !== characterId ||
        response.activeThemeId !== themeId ||
        charactersSnapshot === undefined
      ) {
        throw new Error("Invalid wardrobe response");
      }
      charactersSnapshot = applyCharacterWardrobe(charactersSnapshot, response);
    } catch {
      failed = characterMutationGate.isCurrent(mutation);
    } finally {
      window.clearTimeout(timeout);
      if (characterWardrobeController === controller) {
        characterWardrobeController = undefined;
      }
      const settled = characterMutationGate.finish(mutation);
      if (shouldRenderAfterCharacterMutation(settled)) {
        renderCharacterPanel();
        if (settled.current && failed) {
          characterReasonElement.textContent =
            "這套服裝暫時沒有換上，先保留現在的樣子。";
        }
      }
      if (settled.idle) void pollCharacters();
    }
  }

  function renderWardrobe(): void {
    const character = persistedSelectedCharacter();
    const celebrating = unlockQueue.current() !== undefined;
    const mutationPending = characterMutationGate.pending();
    const progressionRepairPending =
      progressionLockRepairState === "checking";
    const blocked = celebrating || mutationPending || progressionRepairPending;
    wardrobeToggle.setAttribute(
      "aria-expanded",
      wardrobeOpen && !blocked ? "true" : "false",
    );
    wardrobeToggle.disabled = blocked;
    wardrobeToggle.textContent = celebrating
      ? "歡迎新夥伴中"
      : mutationPending
        ? "正在套用角色或服裝"
        : progressionRepairPending
          ? "正在檢查角色進度"
        : wardrobeOpen
          ? "收起衣櫥"
          : "打開衣櫥";
    wardrobeToggle.title = celebrating
      ? "慶祝結束後就能繼續換衣服。"
      : mutationPending
        ? "角色選擇完成後就能繼續換衣服。"
        : progressionRepairPending
          ? "安全檢查完成後就能繼續換衣服。"
        : "";
    wardrobeDrawer.hidden = !wardrobeOpen || blocked;
    const fragment = document.createDocumentFragment();
    if (character?.visual.mode === "letter") {
      for (const theme of character.visual.themes) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "wardrobe-item wardrobe-letter-item";
        button.dataset["themeId"] = theme.themeId;
        button.setAttribute(
          "aria-pressed",
          theme.themeId === character.activeThemeId ? "true" : "false",
        );
        const preview = document.createElement("span");
        preview.className = "wardrobe-letter-preview";
        preview.setAttribute("aria-hidden", "true");
        preview.textContent = character.visual.glyph;
        applyLetterThemePreview(preview, theme);
        const label = document.createElement("span");
        label.textContent = theme.displayName;
        button.append(preview, label);
        if (theme.unlocked && !blocked) {
          button.setAttribute(
            "aria-label",
            characterThemeWearLabel(theme.themeId),
          );
          button.addEventListener("click", () => {
            void chooseTheme(character.characterId, theme.themeId);
          });
        } else if (theme.unlocked) {
          button.disabled = true;
          button.setAttribute("aria-disabled", "true");
          button.setAttribute(
            "aria-label",
            characterThemeUnavailableLabel(theme.themeId),
          );
        } else {
          button.classList.add("is-locked");
          button.disabled = true;
          button.title = "隨本機使用里程自然解鎖，不需要額外消耗 token。";
          button.setAttribute("aria-disabled", "true");
          button.setAttribute(
            "aria-label",
            characterThemeLockedLabel(theme.themeId),
          );
        }
        fragment.append(button);
      }
    } else if (character?.visual.mode === "doll") {
      for (const theme of character.visual.themes) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "wardrobe-item";
        button.dataset["themeId"] = theme.themeId;
        button.setAttribute(
          "aria-pressed",
          theme.themeId === character.activeThemeId ? "true" : "false",
        );
        const label = document.createElement("span");
        label.textContent = characterThemeLabel(theme.themeId);
        if (theme.unlocked && !blocked) {
          const image = document.createElement("img");
          image.src = theme.outfitPath;
          image.alt = "";
          image.loading = "lazy";
          image.addEventListener("error", () => {
            image.hidden = true;
          });
          button.append(image, label);
          button.setAttribute(
            "aria-label",
            characterThemeWearLabel(theme.themeId),
          );
          button.addEventListener("click", () => {
            void chooseTheme(character.characterId, theme.themeId);
          });
        } else if (theme.unlocked) {
          const image = document.createElement("img");
          image.src = theme.outfitPath;
          image.alt = "";
          image.loading = "lazy";
          button.append(image, label);
          button.disabled = true;
          button.setAttribute("aria-disabled", "true");
          button.setAttribute(
            "aria-label",
            characterThemeUnavailableLabel(theme.themeId),
          );
        } else {
          const explain = characterUnlockExplanation(character);
          const placeholder = document.createElement("span");
          placeholder.className = "wardrobe-placeholder";
          placeholder.setAttribute("aria-hidden", "true");
          placeholder.textContent = CHARACTER_VIEW[character.characterId].glyph;
          button.append(placeholder, label);
          button.classList.add("is-locked");
          button.disabled = true;
          button.title = explain;
          button.setAttribute("aria-disabled", "true");
          button.setAttribute(
            "aria-label",
            characterThemeLockedLabel(theme.themeId, explain),
          );
        }
        fragment.append(button);
      }
    }
    const hasThemes = fragment.childNodes.length > 0;
    wardrobeList.replaceChildren(fragment);
    wardrobeToggle.hidden = !hasThemes;
  }

  function renderVoiceControls(): void {
    const hasVoiceLines =
      charactersSnapshot?.voiceEnabled === true &&
      charactersSnapshot.characters.some(
        (character) => character.voiceLines.length > 0,
      );
    voiceControls.hidden = !hasVoiceLines;
    if (!hasVoiceLines) return;
    const enabled = voiceGate.isEnabled();
    voiceToggle.textContent = enabled ? "關閉角色語音" : "開啟角色語音";
    voiceToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
    voiceHint.hidden = enabled;
  }

  function triggerStageVoices(): void {
    const character = persistedSelectedCharacter();
    if (character === undefined || unlockQueue.current() !== undefined) return;
    if (playVoice(character, "greeting") !== undefined) return;
    if (characterConnectionState === "healthy") {
      playVoice(character, latestTodayTokens === 0 ? "quiet" : "active");
    }
  }

  function renderCharacterPanel(): void {
    const character = persistedSelectedCharacter();
    const celebration = unlockQueue.current();
    if (celebration !== undefined) {
      characterReasonElement.textContent =
        "正在歡迎新夥伴；慶祝結束後就能繼續打招呼、換衣與儲存夥伴卡。";
    } else if (character === undefined && charactersSnapshot !== undefined) {
      delete document.documentElement.dataset["character"];
      companionTitleElement.textContent = "選一位姊妹開始陪你。";
      companionVisualElement.setAttribute(
        "aria-label",
        "先從名單選一位 TokenMonster 夥伴",
      );
      characterTapHintElement.textContent = "先從名單選一位夥伴";
      const recommendation = charactersSnapshot.characters.find(
        (candidate) =>
          candidate.characterId === starterRecommendationId &&
          candidate.starterPersona !== null,
      )?.starterPersona ?? undefined;
      characterReasonElement.textContent =
        recommendation === undefined
          ? "四位都有不同個性，第一位由你親自選；之後也能隨時換。"
          : `依近 28 天本機用量，你可能和 ${recommendation.alias} 比較熟；這只是推薦，第一位夥伴仍由你親自選。`;
    } else if (character !== undefined) {
      characterReasonElement.textContent =
        charactersSnapshot?.selection.selectedBy === "manual"
          ? "這是你選的夥伴；想換人或換衣服都可以慢慢來。"
          : "先由她陪你；你隨時可以換，不需要多用 token。";
    }
    renderProgressionLockRepair();
    renderCharacterStage();
    if (celebration !== undefined) {
      characterTapHintElement.textContent = "正在歡迎新夥伴，稍後再打招呼";
      companionVisualElement.setAttribute(
        "aria-label",
        "正在歡迎新解鎖的 TokenMonster 夥伴",
      );
    }
    renderRoster();
    renderWardrobe();
    renderVoiceControls();
    renderCharacterProfile();
    renderByokPanel();
    updateShareCardAvailability();
    triggerStageVoices();
  }

  function showCurrentUnlock(): void {
    const unlock = unlockQueue.current();
    if (unlock === undefined) {
      toastElement.hidden = true;
      renderCharacterPanel();
      return;
    }
    const character = charactersSnapshot?.characters.find(
      (candidate) => candidate.characterId === unlock.characterId,
    );
    toastElement.textContent = characterUnlockToastText(unlock);
    toastElement.hidden = false;
    renderCharacterPanel();
    if (shouldPlayImmediateUnlockSparkles(stageCharacter())) playSparkles();
    const line =
      character === undefined ? undefined : playVoice(character, "unlock");
    celebrationTimer = window.setTimeout(
      () => {
        celebrationTimer = undefined;
        unlockQueue.finish();
        showCurrentUnlock();
      },
      Math.max(2_800, Math.min(line?.durationMs ?? 0, 5_000) + 300),
    );
  }

  function enqueueUnlocks(unlocks: readonly CharacterUnlock[]): void {
    const wasIdle = unlockQueue.current() === undefined;
    const current = unlockQueue.enqueue(unlocks);
    if (wasIdle && current !== undefined && celebrationTimer === undefined) {
      showCurrentUnlock();
    }
  }

  async function pollCharacters(): Promise<void> {
    const requestSequence = ++characterRequestSequence;
    const capturedMutationRevision = characterMutationGate.revision();
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetch(CHARACTERS_API_ENDPOINT, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Characters unavailable");
      const next = parseCharactersSnapshot(await readCharacterJson(response));
      if (requestSequence !== characterRequestSequence) return;
      if (!characterMutationGate.canAcceptRead(capturedMutationRevision)) {
        if (!characterMutationGate.pending()) void pollCharacters();
        return;
      }
      const unlocks = diffCharacterUnlocks(charactersSnapshot, next);
      if (
        charactersSnapshot !== undefined &&
        charactersSnapshot.selection.characterId !== next.selection.characterId
      ) {
        invalidateCharacterInteraction();
      }
      imageFallback.advancePoll();
      charactersSnapshot = next;
      renderCharacterPanel();
      enqueueUnlocks(unlocks);
    } catch {
      if (charactersSnapshot === undefined) setLetterStage();
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function renderCharacter(
    characterId: CompanionCharacterId,
    reason: string,
  ): void {
    if (charactersSnapshot !== undefined) {
      renderCharacterPanel();
      return;
    }
    const view = CHARACTER_VIEW[characterId];
    document.documentElement.dataset["character"] = characterId;
    companionGlyphElement.textContent = view.glyph;
    companionTitleElement.textContent = `嗨，我是 ${view.name} 姊姊。`;
    companionVisualElement.setAttribute(
      "aria-label",
      `TokenMonster ${view.name} 字母角色`,
    );
    characterTapHintElement.textContent = `點一下和 ${view.name} 打招呼`;
    characterReasonElement.textContent = reason;
  }

  function renderStarter(starter: CompanionStarterSelection): void {
    starterRecommendationId =
      starter.outcome === "selected" ? starter.characterId : undefined;
    if (charactersSnapshot !== undefined) {
      renderCharacterPanel();
      return;
    }
    if (starter.outcome === "selected") {
      delete document.documentElement.dataset["character"];
      companionGlyphElement.textContent = "T";
      companionTitleElement.textContent = "選一位姊妹開始陪你。";
      companionVisualElement.setAttribute(
        "aria-label",
        "TokenMonster 字母 T 夥伴",
      );
      characterTapHintElement.textContent = "先從名單選一位夥伴";
      characterReasonElement.textContent =
        "我整理了一個本機用量推薦；這只是參考，第一位夥伴仍由你親自選。";
      return;
    }
    delete document.documentElement.dataset["character"];
    companionGlyphElement.textContent = "T";
    companionTitleElement.textContent = "選一位姊妹開始陪你。";
    companionVisualElement.setAttribute(
      "aria-label",
      "TokenMonster 字母 T 夥伴",
    );
    characterTapHintElement.textContent = "先從名單選一位夥伴";
    characterReasonElement.textContent =
      starter.reason === "highest-provider-total-tie"
        ? "近 28 天有兩位並列，這次由你選；之後也能隨時換。"
        : "目前沒有足夠的 provider 分項，由你選；不需要多用 token。";
  }

  wardrobeToggle.addEventListener("click", () => {
    wardrobeOpen = !wardrobeOpen;
    renderWardrobe();
  });

  companionVisualElement.addEventListener("click", () => {
    void interactWithSelectedCharacter();
  });

  shareCardButton.addEventListener("click", () => {
    void saveLocalShareCard();
  });

  reminderSettingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitReminderSettings();
  });

  reminderTestButton.addEventListener("click", () => {
    void testReminderNotification();
  });

  automaticUpdateEnabledInput.addEventListener("change", () => {
    void updateAutomaticUpdatePreference();
  });

  automaticUpdateCheckButton.addEventListener("click", () => {
    void checkForAutomaticUpdate();
  });

  automaticUpdateInstallButton.addEventListener("click", () => {
    void installAutomaticUpdate();
  });

  byokToggle.addEventListener("click", () => {
    byokDrawerOpen = !byokDrawerOpen;
    if (!byokDrawerOpen) resetByokConversation(true);
    renderByokPanel();
    if (byokDrawerOpen) {
      (byokStatus?.configured === true
        ? byokMessageInput
        : byokKeyInput
      ).focus();
    }
  });

  byokClose.addEventListener("click", () => {
    resetByokConversation(true);
    renderByokPanel();
    byokToggle.focus();
  });

  byokConfigureForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitByokConfiguration();
  });

  byokMessageForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendByokMessage();
  });

  byokMessageInput.addEventListener("input", renderByokPanel);

  byokClear.addEventListener("click", () => {
    void deleteByokKey();
  });

  document.addEventListener("keydown", (event) => {
    if (!byokDrawerOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      resetByokConversation(true);
      renderByokPanel();
      byokToggle.focus();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...byokDrawer.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled])",
      ),
    ].filter((element) => element.closest("[hidden]") === null);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  progressionLockRepairButton.addEventListener("click", () => {
    void repairProgressionLock();
  });

  assetPackButton.addEventListener("click", () => {
    const pack = assetPackStatus;
    void mutateAssetPack(
      pack?.phase === "repair-needed" && !pack.consented
        ? false
        : pack?.phase !== "installed",
    );
  });

  assetPackRevokeButton.addEventListener("click", () => {
    const pack = assetPackStatus;
    if (
      pack === undefined ||
      !pack.consented ||
      pack.phase === "unavailable" ||
      pack.phase === "installing" ||
      assetPackBusy
    ) {
      return;
    }
    if (!assetPackRemovalConfirmationPending) {
      assetPackRemovalConfirmationPending = true;
      assetPackRemovalConfirmationTimer = window.setTimeout(() => {
        assetPackRemovalConfirmationPending = false;
        assetPackRemovalConfirmationTimer = undefined;
        renderAssetPackControl();
      }, 8_000);
      renderAssetPackControl();
      return;
    }
    clearAssetPackRemovalConfirmation();
    void mutateAssetPack(false);
  });

  shareCardHideTotal.addEventListener("change", () => {
    if (shareCardBusy || !shareCardAvailable) return;
    shareCardStatus.textContent = shareCardHideTotal.checked
      ? "角色、今日默契與收藏會留在圖片上；28 日 Token 總量會隱藏。"
      : "角色、今日默契、收藏與近 28 日足跡會直接在本機繪成圖片。";
  });

  document.addEventListener(
    "click",
    () => {
      voiceGate.arm();
      triggerStageVoices();
    },
    { capture: true, once: true },
  );

  function toggleVoice(): void {
    voiceGate.setEnabled(!voiceGate.isEnabled());
    if (!voiceGate.isEnabled()) {
      voiceAudio.pause();
      voiceAudio.removeAttribute("src");
    }
    renderVoiceControls();
    triggerStageVoices();
  }

  voiceToggle.addEventListener("click", toggleVoice);
  voiceHint.addEventListener("click", toggleVoice);

  let refreshTimer: number | undefined;
  let currentController: AbortController | undefined;
  let blockedByIncompatibility = false;

  function clearRefreshTimer(): void {
    if (refreshTimer === undefined) return;
    window.clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }

  function setRefreshTimer(delayMs: number): void {
    clearRefreshTimer();
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined;
      void pollCollector();
    }, delayMs);
  }

  function setMetricPlaceholders(): void {
    metricElements.today.textContent = "—";
    metricElements.last7Days.textContent = "—";
    metricElements.last28Days.textContent = "—";
  }

  function prepareRescan(label: string, enabled: boolean): void {
    rescanButton.textContent = label;
    rescanButton.disabled = !enabled;
  }

  function clearLastGoodDisplay(trendMessage: string): void {
    if (lastGoodSnapshot !== undefined) return;
    setMetricPlaceholders();
    clearTrend(trendMessage, false);
  }

  function updateCharacterConnection(
    nextState: CharacterConnectionState,
  ): void {
    previousCharacterConnectionState = characterConnectionState;
    characterConnectionState = nextState;
    renderCharacterStage();
    if (
      nextState === "refresh-failed" &&
      previousCharacterConnectionState !== "refresh-failed"
    ) {
      const character = persistedSelectedCharacter();
      if (character !== undefined) playVoice(character, "error");
    }
  }

  function setCharacterProfileConnectionDegraded(degraded: boolean): void {
    characterProfileConnectionDegraded = degraded;
    renderCharacterProfile();
    updateShareCardAvailability();
  }

  function showStarting(): void {
    document.documentElement.dataset["connection"] = "starting";
    statusElement.textContent = "正在啟動";
    companionLineElement.textContent = "本機用量服務正在準備，很快就好。";
    updatedElement.textContent = "";
    staleBadgeElement.hidden = true;
    prepareRescan("重新掃描", false);
    clearLastGoodDisplay("啟動完成後會顯示 UTC 每日趨勢。");
    updateCharacterConnection("other");
  }

  function showSyncing(status: CompanionCollectorStatus): void {
    document.documentElement.dataset["connection"] = "syncing";
    statusElement.textContent = "正在同步";
    companionLineElement.textContent =
      lastGoodSnapshot === undefined
        ? "我正在掃描支援的本機用量來源，先不把空白當成零。"
        : "我正在重新掃描；先保留上次整理好的用量。";
    updatedElement.textContent =
      lastGoodSnapshot === undefined
        ? ""
        : `上次更新於本機時間 ${timeFormatter.format(new Date(lastGoodSnapshot.generatedAt))}`;
    staleBadgeElement.hidden = true;
    prepareRescan("正在掃描", status.canRetry);
    clearLastGoodDisplay("掃描完成後會顯示 UTC 每日趨勢。");
    updateCharacterConnection("other");
  }

  function showRefreshFailed(status: CompanionCollectorStatus): void {
    document.documentElement.dataset["connection"] = "error";
    statusElement.textContent = "掃描未完成";
    companionLineElement.textContent =
      "第一次掃描沒有完成。可以再試一次，我也會繼續留在這裡。";
    updatedElement.textContent = `已嘗試 ${numberFormatter.format(status.consecutiveFailures)} 次`;
    staleBadgeElement.hidden = true;
    prepareRescan("再試一次", status.canRetry);
    setMetricPlaceholders();
    clearTrend("重新掃描成功後會顯示 UTC 每日趨勢。", false);
    updateCharacterConnection("refresh-failed");
    setCharacterProfileConnectionDegraded(true);
  }

  function showUnavailable(): void {
    document.documentElement.dataset["connection"] = "error";
    statusElement.textContent = "暫時中斷";
    companionLineElement.textContent = "本機用量服務暫時沒回應，我會稍後再試。";
    updatedElement.textContent =
      lastGoodSnapshot === undefined
        ? ""
        : `保留本機時間 ${timeFormatter.format(new Date(lastGoodSnapshot.generatedAt))} 的資料`;
    staleBadgeElement.hidden = lastGoodSnapshot === undefined;
    prepareRescan("立即重試", true);
    clearLastGoodDisplay("連線恢復後會顯示 UTC 每日趨勢。");
    updateCharacterConnection("other");
    setCharacterProfileConnectionDegraded(true);
  }

  function showIncompatible(): void {
    document.documentElement.dataset["connection"] = "error";
    statusElement.textContent = "需要更新";
    companionLineElement.textContent =
      "目前版本無法讀取用量。請重新啟動或更新 TokenMonster，再重新檢查。";
    updatedElement.textContent = "";
    staleBadgeElement.hidden = lastGoodSnapshot === undefined;
    prepareRescan("重新檢查", true);
    clearLastGoodDisplay("更新完成後會顯示 UTC 每日趨勢。");
    updateCharacterConnection("other");
    setCharacterProfileConnectionDegraded(true);
  }

  function handleUnavailable(): void {
    blockedByIncompatibility = false;
    showUnavailable();
    setRefreshTimer(unavailableRetryBackoff.nextDelayMs());
  }

  function handleIncompatible(): void {
    blockedByIncompatibility = true;
    clearRefreshTimer();
    showIncompatible();
  }

  function renderSnapshotData(snapshot: CompanionHealthySnapshot): void {
    applyHealthyUsageSnapshot(snapshot, {
      render: (healthySnapshot) => {
        lastGoodSnapshot = healthySnapshot;
        latestTodayTokens = healthySnapshot.totals.today;
        renderStarter(healthySnapshot.starter);
        metricElements.today.textContent = numberFormatter.format(
          healthySnapshot.totals.today,
        );
        metricElements.last7Days.textContent = numberFormatter.format(
          healthySnapshot.totals.last7Days,
        );
        metricElements.last28Days.textContent = numberFormatter.format(
          healthySnapshot.totals.last28Days,
        );
        renderTrend(healthySnapshot);
        updateShareCardAvailability();
      },
      refreshAnalytics: () => analyticsPanel.refreshInBackground(),
      refreshQuota: () => quotaPanel.refresh(),
    });
  }

  function showSettled(
    snapshot: CompanionHealthySnapshot,
    collector: CompanionCollectorStatus,
  ): void {
    blockedByIncompatibility = false;
    setCharacterProfileConnectionDegraded(collector.phase === "stale");
    unavailableRetryBackoff.reset();
    renderSnapshotData(snapshot);
    prepareRescan("重新掃描", collector.canRetry);
    if (collector.phase === "stale") {
      document.documentElement.dataset["connection"] = "stale";
      statusElement.textContent = "資料稍舊";
      companionLineElement.textContent =
        "這是上次成功整理的用量；這次掃描沒完成，你可以再試一次。";
      updatedElement.textContent = `上次成功於本機時間 ${timeFormatter.format(new Date(collector.lastSuccessAt!))}`;
      staleBadgeElement.hidden = false;
      updateCharacterConnection("stale");
      return;
    }
    staleBadgeElement.hidden = true;
    if (collector.phase === "ready-no-data") {
      document.documentElement.dataset["connection"] = "no-data";
      statusElement.textContent = "掃描完成";
      companionLineElement.textContent =
        "還沒找到支援的本機用量來源；這不是安靜的一天，你可以隨時重新掃描。";
    } else {
      document.documentElement.dataset["connection"] = "healthy";
      statusElement.textContent = "已連線";
      companionLineElement.textContent =
        snapshot.totals.today === 0
          ? "今天（UTC）還很安靜，我會在這裡陪你。"
          : "今天（UTC）的用量已經整理好了。";
    }
    updatedElement.textContent = `更新於本機時間 ${timeFormatter.format(new Date(collector.lastSuccessAt!))}`;
    updateCharacterConnection("healthy");
    triggerStageVoices();
  }

  async function readBoundedJson(response: Response): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";
    const declaredLength = Number(
      response.headers.get("content-length") ?? "0",
    );
    if (
      !contentType.toLowerCase().startsWith("application/json") ||
      (Number.isFinite(declaredLength) &&
        declaredLength > MAX_RESPONSE_CHARACTERS)
    ) {
      throw new TypeError("Invalid companion response");
    }
    const body = await response.text();
    if (body.length > MAX_RESPONSE_CHARACTERS) {
      throw new TypeError("Invalid companion response");
    }
    return JSON.parse(body) as unknown;
  }

  function handleApiError(error: CompanionErrorCode): void {
    if (shouldAutomaticallyRetry(error)) {
      handleUnavailable();
    } else {
      handleIncompatible();
    }
  }

  function parseCollectorPayload(
    value: unknown,
  ): CompanionCollectorStatus | CompanionErrorSnapshot {
    try {
      return parseCompanionCollectorStatus(value);
    } catch {
      const error = parseCompanionSnapshot(value);
      if (error.status !== "error") {
        throw new TypeError("Invalid collector response");
      }
      return error;
    }
  }

  async function readMetrics(
    controller: AbortController,
  ): Promise<CompanionHealthySnapshot | undefined> {
    const response = await fetch(COMPANION_API_ENDPOINT, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const payload = parseCompanionSnapshot(await readBoundedJson(response));
    if (payload.status === "error") {
      handleApiError(payload.error);
      return undefined;
    }
    if (!response.ok) {
      handleUnavailable();
      return undefined;
    }
    return payload;
  }

  async function applyCollectorStatus(
    collector: CompanionCollectorStatus,
    controller: AbortController,
    forceProfileRefresh = false,
  ): Promise<void> {
    if (collector.phase === "starting") {
      blockedByIncompatibility = false;
      showStarting();
      setRefreshTimer(ACTIVE_POLL_MS);
      return;
    }
    if (collector.phase === "syncing") {
      blockedByIncompatibility = false;
      showSyncing(collector);
      setRefreshTimer(ACTIVE_POLL_MS);
      return;
    }
    if (collector.phase === "refresh-failed") {
      blockedByIncompatibility = false;
      showRefreshFailed(collector);
      setRefreshTimer(SETTLED_POLL_MS);
      return;
    }
    const snapshot = await readMetrics(controller);
    if (snapshot === undefined) return;
    showSettled(snapshot, collector);
    await pollCharacters();
    void refreshAssetPackStatus();
    void refreshCharacterProfile(forceProfileRefresh);
    setRefreshTimer(SETTLED_POLL_MS);
  }

  async function pollCollector(): Promise<void> {
    clearRefreshTimer();
    currentController?.abort();
    const controller = new AbortController();
    currentController = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(COLLECTOR_STATUS_ENDPOINT, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const payload = parseCollectorPayload(await readBoundedJson(response));
      if ("status" in payload) {
        handleApiError(payload.error);
        return;
      }
      if (!response.ok) {
        handleUnavailable();
        return;
      }
      await applyCollectorStatus(payload, controller);
    } catch {
      if (!controller.signal.aborted || currentController === controller) {
        handleUnavailable();
      }
    } finally {
      window.clearTimeout(timeout);
      if (currentController === controller) currentController = undefined;
    }
  }

  async function requestRescan(): Promise<void> {
    clearRefreshTimer();
    currentController?.abort();
    unavailableRetryBackoff.reset();
    blockedByIncompatibility = false;
    showSyncing(
      Object.freeze({
        phase: "syncing",
        lastSuccessAt: lastGoodSnapshot?.generatedAt ?? null,
        consecutiveFailures: 0,
        canRetry: false,
      }),
    );
    const controller = new AbortController();
    currentController = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      REFRESH_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetch(COLLECTOR_REFRESH_ENDPOINT, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const payload = parseCollectorPayload(await readBoundedJson(response));
      if ("status" in payload) {
        handleApiError(payload.error);
        return;
      }
      await applyCollectorStatus(payload, controller, true);
    } catch {
      if (!controller.signal.aborted || currentController === controller) {
        handleUnavailable();
      }
    } finally {
      window.clearTimeout(timeout);
      if (currentController === controller) currentController = undefined;
    }
  }

  rescanButton.addEventListener("click", () => {
    if (!rescanButton.disabled) void requestRescan();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      clearAutomaticUpdateRefresh();
      return;
    }
    renderCharacterProfile();
    updateShareCardAvailability();
    scheduleCharacterProfileClockBoundary();
    void refreshAssetPackStatus();
    void refreshByokStatus();
    void loadReminderControl(false);
    void loadAutomaticUpdateControl(false);
    if (blockedByIncompatibility) return;
    void refreshCharacterProfile(
      characterProfile !== undefined &&
        characterProfile.window.toUtcDate !== currentUtcDate(),
    );
    void pollCollector();
  });

  showStarting();
  renderReminderControl();
  renderAutomaticUpdateControl();
  renderAssetPackControl();
  scheduleCharacterProfileClockBoundary();
  void refreshAssetPackStatus();
  void refreshByokStatus();
  void loadReminderControl();
  void loadAutomaticUpdateControl();
  void pollCharacters();
  void quotaPanel.refresh();
  void pollCollector();
}

async function startLocalizedCompanionUi(): Promise<void> {
  const selector = requiredElement<HTMLSelectElement>("[data-ui-locale]");
  const notice = requiredElement<HTMLElement>("[data-ui-locale-notice]");
  const sessionLocale = uiLocaleFromSessionPath(window.location.pathname);
  let revision = 0;
  let persistentStorageReady = false;
  try {
    const preference = await requestUiLocalePreference(
      fetch,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
    revision = preference.revision;
    persistentStorageReady = true;
    setUiLocale(sessionLocale ?? preference.locale);
  } catch {
    setUiLocale(sessionLocale ?? "zh-TW");
    notice.textContent =
      "語言偏好暫時無法儲存；這次視窗仍可切換，重新啟動後會回到繁體中文。";
  }
  selector.value = getUiLocale();
  selector.disabled = false;
  localizeDocument();
  observeLocalizedDocument();

  selector.addEventListener("change", () => {
    void (async () => {
      const requestedLocale = selector.value === "en" ? "en" : "zh-TW";
      selector.disabled = true;
      notice.textContent = "正在把語言偏好保存在這台裝置。";
      if (persistentStorageReady) {
        try {
          const preference = await saveUiLocalePreference(
            requestedLocale,
            revision,
            fetch,
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          );
          revision = preference.revision;
          window.location.replace("/");
          return;
        } catch {
          // A committed CAS response may be lost. Re-read before falling back
          // to a session-only locale so a 409 never becomes a false failure.
          try {
            const recovered = await requestUiLocalePreference(
              fetch,
              AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            );
            revision = recovered.revision;
            if (recovered.locale === requestedLocale) {
              window.location.replace("/");
              return;
            }
          } catch {
            persistentStorageReady = false;
          }
        }
      }
      // A fixed authenticated document route carries only this tab's
      // content-free locale. Navigating to a distinct path forces a complete
      // render, so cached chart labels and Intl-formatted values cannot retain
      // the previous locale when preference persistence is unavailable.
      window.location.replace(
        uiLocaleSessionPath(requestedLocale, window.location.search),
      );
    })();
  });

  startCompanionUi();
  document.documentElement.dataset["localeReady"] = "true";
}

if (typeof document !== "undefined") void startLocalizedCompanionUi();
