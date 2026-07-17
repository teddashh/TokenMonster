import {
  CHARACTERS_API_ENDPOINT,
  COLLECTOR_REFRESH_ENDPOINT,
  COLLECTOR_STATUS_ENDPOINT,
  COMPANION_API_ENDPOINT,
  parseCharactersSnapshot,
  parseCompanionCollectorStatus,
  parseCompanionSnapshot,
  type CharacterConnectionState,
  type CharacterId,
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
  type VoiceTrigger
} from "./dto.js";
import {
  applyCharacterSelection,
  applyCharacterWardrobe,
  readCharacterJson,
  requestCharacterSelection,
  requestCharacterWardrobe,
  requestUsageAnalytics
} from "./api.js";
import { createAnalyticsPanel } from "./analytics-panel.js";
import {
  createCharacterImageFallbackTracker,
  createCharacterUnlockQueue,
  characterUnlockToastText,
  diffCharacterUnlocks
} from "./character-state.js";
import {
  isGlmLetterCharacter,
  resolveStageImagePath
} from "./character-panel.js";
import {
  createPortraitSwitchStateMachine,
  enabledCharacterAnimationClasses,
  preloadCharacterImage,
  userPrefersReducedMotion,
  type PortraitTarget
} from "./animation.js";
import { createVoicePlaybackGate } from "./voice.js";
import {
  createUnavailableRetryBackoff,
  shouldAutomaticallyRetry
} from "./usage-state.js";
import { createUsagePanel } from "./usage-panel.js";
import {
  CHARACTER_THEME_LABELS,
  characterUnlockExplanation
} from "./wardrobe.js";

const MAX_RESPONSE_CHARACTERS = 65_536;
const REQUEST_TIMEOUT_MS = 8_000;
const REFRESH_REQUEST_TIMEOUT_MS = 100_000;
const ACTIVE_POLL_MS = 5_000;
const SETTLED_POLL_MS = 60_000;
const numberFormatter = new Intl.NumberFormat("zh-TW", {
  maximumFractionDigits: 0,
  useGrouping: true
});
const timeFormatter = new Intl.DateTimeFormat("zh-TW", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

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
  glm: Object.freeze({ glyph: "Z", name: "GLM" })
} as const satisfies Readonly<
  Record<CharacterId, Readonly<{ glyph: string; name: string }>>
>);

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error("Required UI element is unavailable");
  return element;
}

export function startCompanionUi(): void {
  const statusElement = requiredElement<HTMLElement>("[data-status]");
  const companionLineElement = requiredElement<HTMLElement>(
    "[data-companion-line]"
  );
  const companionVisualElement = requiredElement<HTMLElement>(
    "[data-companion-visual]"
  );
  const companionGlyphElement = requiredElement<HTMLElement>(
    "[data-companion-glyph]"
  );
  const letterLayerElement = requiredElement<HTMLElement>(
    "[data-letter-layer]"
  );
  const dollImageElement = requiredElement<HTMLImageElement>(
    "[data-character-doll]"
  );
  const incomingDollImageElement = requiredElement<HTMLImageElement>(
    "[data-character-doll-incoming]"
  );
  const switchingElement = requiredElement<HTMLElement>(
    "[data-character-switching]"
  );
  const effectsElement = requiredElement<HTMLElement>(
    "[data-character-effects]"
  );
  const companionTitleElement = requiredElement<HTMLElement>(
    "[data-companion-title]"
  );
  const characterReasonElement = requiredElement<HTMLElement>(
    "[data-character-reason]"
  );
  const rosterElement = requiredElement<HTMLElement>("[data-roster]");
  const wardrobeToggle = requiredElement<HTMLButtonElement>(
    "[data-wardrobe-toggle]"
  );
  const wardrobeDrawer = requiredElement<HTMLElement>(
    "[data-wardrobe-drawer]"
  );
  const wardrobeList = requiredElement<HTMLElement>("[data-wardrobe-list]");
  const voiceControls = requiredElement<HTMLElement>("[data-voice-controls]");
  const voiceToggle = requiredElement<HTMLButtonElement>("[data-voice-toggle]");
  const voiceHint = requiredElement<HTMLButtonElement>("[data-voice-hint]");
  const voiceAudio = requiredElement<HTMLAudioElement>("[data-voice-audio]");
  const toastElement = requiredElement<HTMLElement>("[data-unlock-toast]");
  const updatedElement = requiredElement<HTMLElement>("[data-updated]");
  const staleBadgeElement = requiredElement<HTMLElement>(
    "[data-stale-badge]"
  );
  const rescanButton = requiredElement<HTMLButtonElement>("[data-rescan]");
  const trendElement = requiredElement<HTMLElement>("[data-trend]");
  const trendEmptyElement = requiredElement<HTMLElement>("[data-trend-empty]");
  const trendAccessibleElement = requiredElement<HTMLOListElement>(
    "[data-trend-accessible]"
  );
  const analyticsElement = requiredElement<HTMLElement>("[data-analytics]");
  const metricElements = {
    today: requiredElement<HTMLElement>("[data-metric='today']"),
    last7Days: requiredElement<HTMLElement>("[data-metric='last7Days']"),
    last28Days: requiredElement<HTMLElement>("[data-metric='last28Days']")
  };
  const { clearTrend, renderTrend } = createUsagePanel({
    trend: trendElement,
    empty: trendEmptyElement,
    accessible: trendAccessibleElement
  });
  const unavailableRetryBackoff = createUnavailableRetryBackoff();
  let lastGoodSnapshot: CompanionHealthySnapshot | undefined;
  let charactersSnapshot: CharactersSnapshot | undefined;
  let latestTodayTokens = 0;
  let characterConnectionState: CharacterConnectionState = "other";
  let previousCharacterConnectionState: CharacterConnectionState = "other";
  let wardrobeOpen = false;
  let celebrationTimer: number | undefined;
  let characterRequestSequence = 0;
  let characterSelectionSequence = 0;
  let requestedStageKey: string | undefined;
  let entrancePending = false;
  let renderedLetterCharacterId: CharacterId | undefined;
  const reducedMotion = userPrefersReducedMotion();
  document.documentElement.classList.toggle("motion-enabled", !reducedMotion);
  const analyticsPanel = createAnalyticsPanel({
    root: analyticsElement,
    reducedMotion,
    load: (window, signal) => requestUsageAnalytics(window, signal)
  });
  const imageFallback = createCharacterImageFallbackTracker();
  const unlockQueue = createCharacterUnlockQueue();
  const voiceGate = createVoicePlaybackGate({
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value)
  });

  interface StagePortraitTarget extends PortraitTarget {
    readonly character: CharacterRosterEntry;
    readonly celebrating: boolean;
  }

  function setSwitchingAffordance(switching: boolean): void {
    switchingElement.hidden = !switching;
    companionVisualElement.classList.toggle("is-switching", switching);
    companionVisualElement.setAttribute("aria-busy", switching ? "true" : "false");
  }

  function commitStageMetadata(character: CharacterRosterEntry): void {
    document.documentElement.dataset["character"] = character.characterId;
    companionTitleElement.textContent = `嗨，我是 ${character.displayName}。`;
    companionVisualElement.setAttribute(
      "aria-label",
      `TokenMonster ${character.displayName} 夥伴`
    );
  }

  function playSparkles(): void {
    if (reducedMotion) return;
    effectsElement.replaceChildren(
      ...Array.from({ length: 12 }, () => {
        const sparkle = document.createElement("span");
        sparkle.className = "character-sparkle";
        sparkle.setAttribute("aria-hidden", "true");
        return sparkle;
      })
    );
    effectsElement.hidden = false;
    effectsElement.classList.remove("is-active");
    requestAnimationFrame(() => effectsElement.classList.add("is-active"));
    window.setTimeout(() => {
      effectsElement.hidden = true;
      effectsElement.replaceChildren();
    }, 900);
  }

  const stageSwitch = createPortraitSwitchStateMachine<StagePortraitTarget>({
    preload: preloadCharacterImage,
    onSwitching: () => setSwitchingAffordance(true),
    onCommit: (target, previous) => {
      imageFallback.recordSuccess(target.character.characterId, target.imagePath);
      renderedLetterCharacterId = undefined;
      requestedStageKey = `${target.character.characterId}:${target.imagePath}:${target.celebrating}`;
      commitStageMetadata(target.character);
      letterLayerElement.hidden = true;
      incomingDollImageElement.src = target.imagePath;
      incomingDollImageElement.hidden = false;
      const animationClasses = enabledCharacterAnimationClasses(reducedMotion);
      incomingDollImageElement.classList.toggle(
        "character-entering",
        animationClasses.includes("character-entering") &&
          (previous?.characterId !== target.characterId || entrancePending)
      );
      incomingDollImageElement.classList.toggle(
        "character-crossfade-in",
        animationClasses.includes("character-crossfade-in") &&
          previous?.characterId === target.characterId
      );
      dollImageElement.classList.toggle(
        "character-crossfade-out",
        animationClasses.includes("character-crossfade-out") &&
          previous?.characterId === target.characterId &&
          !dollImageElement.hidden
      );
      dollImageElement.classList.remove("character-idle");
      if (target.celebrating) playSparkles();
      const finish = (): void => {
        if (stageSwitch.current() !== target) return;
        dollImageElement.src = target.imagePath;
        dollImageElement.hidden = false;
        dollImageElement.className = "character-doll";
        dollImageElement.classList.toggle(
          "character-idle",
          animationClasses.includes("character-idle")
        );
        incomingDollImageElement.hidden = true;
        incomingDollImageElement.removeAttribute("src");
        incomingDollImageElement.className = "character-doll character-doll-incoming";
        entrancePending = false;
        setSwitchingAffordance(false);
      };
      if (reducedMotion) finish();
      else window.setTimeout(finish, 360);
    },
    onError: (target) => {
      requestedStageKey = undefined;
      imageFallback.recordFailure(target.character.characterId, target.imagePath);
      setSwitchingAffordance(false);
      characterReasonElement.textContent =
        "這次沒有換成功，原本的夥伴會繼續陪你。";
    }
  });

  function selectedCharacter(): CharacterRosterEntry | undefined {
    const snapshot = charactersSnapshot;
    if (snapshot === undefined) return undefined;
    const celebration = unlockQueue.current();
    if (celebration !== undefined) {
      const celebratingCharacter = snapshot.characters.find(
        (character) =>
          character.characterId === celebration.characterId &&
          character.unlocked
      );
      if (celebratingCharacter !== undefined) return celebratingCharacter;
    }
    const selectedId = snapshot.selection.characterId;
    return (
      snapshot.characters.find(
        (character) => character.characterId === selectedId && character.unlocked
      ) ??
      snapshot.characters.find(
        (character) => character.isStarter && character.unlocked
      ) ??
      snapshot.characters.find((character) => character.unlocked)
    );
  }

  function setLetterStage(character?: CharacterRosterEntry): void {
    const isGlmLetter = character !== undefined && isGlmLetterCharacter(character);
    const entering =
      isGlmLetter && renderedLetterCharacterId !== character.characterId;
    const view = character === undefined ? CHARACTER_VIEW.chatgpt : CHARACTER_VIEW.glm;
    companionGlyphElement.textContent =
      isGlmLetter && character.visual.mode === "letter"
        ? character.visual.glyph
        : view.glyph;
    const style = companionVisualElement.style;
    if (isGlmLetter && character.visual.mode === "letter") {
      style.setProperty("--letter-background", character.visual.background);
      style.setProperty("--letter-foreground", character.visual.foreground);
      style.setProperty("--letter-accent", character.visual.accent);
    } else {
      style.removeProperty("--letter-background");
      style.removeProperty("--letter-foreground");
      style.removeProperty("--letter-accent");
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
      renderedLetterCharacterId = character.characterId;
      letterLayerElement.classList.toggle("character-letter-idle", !reducedMotion);
      letterLayerElement.classList.toggle(
        "character-entering",
        !reducedMotion && entering
      );
      if (entering) {
        window.setTimeout(
          () => letterLayerElement.classList.remove("character-entering"),
          360
        );
      }
    } else {
      renderedLetterCharacterId = undefined;
    }
  }

  function playVoice(
    character: CharacterRosterEntry,
    trigger: VoiceTrigger
  ): CharacterVoiceLine | undefined {
    if (charactersSnapshot?.voiceEnabled !== true) return undefined;
    const line = character.voiceLines.find(
      (candidate) => candidate.trigger === trigger
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
    const character = selectedCharacter();
    if (character === undefined) {
      setLetterStage();
      return;
    }
    if (isGlmLetterCharacter(character)) {
      setLetterStage(character);
      return;
    }
    const celebrating =
      unlockQueue.current()?.characterId === character.characterId;
    const imagePath = resolveStageImagePath(
      character,
      characterConnectionState,
      latestTodayTokens,
      celebrating
    );
    if (character.visual.mode !== "doll" || imagePath === undefined) return;
    const stageKey = `${character.characterId}:${imagePath}:${celebrating}`;
    if (
      requestedStageKey === stageKey ||
      !imageFallback.canAttempt(character.characterId, imagePath)
    ) {
      return;
    }
    requestedStageKey = stageKey;
    if (dollImageElement.hidden && letterLayerElement.hidden === false) {
      letterLayerElement.hidden = true;
    }
    void stageSwitch.transition({
      characterId: character.characterId,
      imagePath,
      character,
      celebrating
    });
  }

  async function chooseCharacter(characterId: CharacterId): Promise<void> {
    const selectionSequence = ++characterSelectionSequence;
    let failedImage:
      | Readonly<{ characterId: CharacterId; imagePath: string }>
      | undefined;
    setSwitchingAffordance(true);
    try {
      const response = await requestCharacterSelection(characterId);
      if (selectionSequence !== characterSelectionSequence) return;
      if (
        response.selection.characterId !== characterId ||
        charactersSnapshot === undefined
      ) {
        throw new Error("Invalid character selection response");
      }
      const candidate = applyCharacterSelection(charactersSnapshot, response);
      const target = candidate.characters.find(
        (character) =>
          character.characterId === characterId && character.unlocked
      );
      if (target === undefined) throw new Error("Character unavailable");
      if (target.visual.mode === "doll") {
        const imagePath = resolveStageImagePath(
          target,
          characterConnectionState,
          latestTodayTokens,
          false
        );
        if (imagePath === undefined) throw new Error("Character image unavailable");
        failedImage = { characterId, imagePath };
        await preloadCharacterImage(imagePath);
      } else if (!isGlmLetterCharacter(target)) {
        throw new Error("Invalid letter character");
      }
      if (selectionSequence !== characterSelectionSequence) return;
      charactersSnapshot = candidate;
      entrancePending = true;
      requestedStageKey = undefined;
      renderCharacterPanel();
    } catch {
      if (selectionSequence !== characterSelectionSequence) return;
      if (failedImage !== undefined) {
        imageFallback.recordFailure(
          failedImage.characterId,
          failedImage.imagePath
        );
      }
      setSwitchingAffordance(false);
      characterReasonElement.textContent =
        "這次沒有換成功，原本的夥伴會繼續陪你。";
    }
  }

  function renderRoster(): void {
    const fragment = document.createDocumentFragment();
    for (const character of charactersSnapshot?.characters ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "roster-chip";
      button.dataset["characterId"] = character.characterId;
      button.setAttribute(
        "aria-pressed",
        charactersSnapshot?.selection.characterId === character.characterId
          ? "true"
          : "false"
      );
      const portrait = document.createElement("span");
      portrait.className = "roster-portrait";
      const glyph = document.createElement("span");
      glyph.className = "roster-glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = CHARACTER_VIEW[character.characterId].glyph;
      portrait.append(glyph);
      if (character.unlocked && character.visual.mode === "doll") {
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
      if (!character.unlocked && character.progress !== null) {
        const ring = document.createElement("span");
        ring.className = "progress-ring";
        ring.style.setProperty(
          "--progress-turn",
          `${character.progress.value}turn`
        );
        ring.setAttribute("aria-hidden", "true");
        portrait.append(ring);
      }
      const name = document.createElement("span");
      name.className = "roster-name";
      name.textContent = character.displayName;
      button.append(portrait, name);
      if (character.unlocked) {
        button.setAttribute("aria-label", `選擇 ${character.displayName}`);
        button.addEventListener("click", () => {
          void chooseCharacter(character.characterId);
        });
      } else {
        const explain = characterUnlockExplanation(character);
        const accessibleExplain = document.createElement("span");
        accessibleExplain.className = "visually-hidden";
        accessibleExplain.textContent = explain;
        button.append(accessibleExplain);
        button.title = explain;
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
        button.setAttribute(
          "aria-label",
          `${character.displayName} 尚未解鎖。${explain}`
        );
      }
      fragment.append(button);
    }
    rosterElement.replaceChildren(fragment);
  }

  async function chooseTheme(
    characterId: CharacterId,
    themeId: CharacterThemeId
  ): Promise<void> {
    try {
      const response = await requestCharacterWardrobe(characterId, themeId);
      if (charactersSnapshot === undefined) return;
      charactersSnapshot = applyCharacterWardrobe(
        charactersSnapshot,
        response
      );
      renderCharacterPanel();
    } catch {
      characterReasonElement.textContent =
        "這套服裝暫時沒有換上，先保留現在的樣子。";
    }
  }

  function renderWardrobe(): void {
    wardrobeToggle.setAttribute("aria-expanded", wardrobeOpen ? "true" : "false");
    wardrobeToggle.textContent = wardrobeOpen ? "收起衣櫥" : "打開衣櫥";
    wardrobeDrawer.hidden = !wardrobeOpen;
    const character = selectedCharacter();
    const fragment = document.createDocumentFragment();
    if (character?.visual.mode === "doll") {
      for (const theme of character.visual.themes) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "wardrobe-item";
        button.dataset["themeId"] = theme.themeId;
        button.setAttribute(
          "aria-pressed",
          theme.themeId === character.activeThemeId ? "true" : "false"
        );
        const label = document.createElement("span");
        label.textContent = CHARACTER_THEME_LABELS[theme.themeId];
        if (theme.unlocked) {
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
            `換上${CHARACTER_THEME_LABELS[theme.themeId]}服裝`
          );
          button.addEventListener("click", () => {
            void chooseTheme(character.characterId, theme.themeId);
          });
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
            `${CHARACTER_THEME_LABELS[theme.themeId]}服裝尚未解鎖。${explain}`
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
        (character) => character.voiceLines.length > 0
      );
    voiceControls.hidden = !hasVoiceLines;
    if (!hasVoiceLines) return;
    const enabled = voiceGate.isEnabled();
    voiceToggle.textContent = enabled ? "關閉角色語音" : "開啟角色語音";
    voiceToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
    voiceHint.hidden = enabled;
  }

  function triggerStageVoices(): void {
    const character = selectedCharacter();
    if (character === undefined || unlockQueue.current() !== undefined) return;
    if (playVoice(character, "greeting") !== undefined) return;
    if (characterConnectionState === "healthy") {
      playVoice(character, latestTodayTokens === 0 ? "quiet" : "active");
    }
  }

  function renderCharacterPanel(): void {
    const character = selectedCharacter();
    if (character !== undefined) {
      characterReasonElement.textContent =
        charactersSnapshot?.selection.selectedBy === "manual"
          ? "這是你選的夥伴；想換人或換衣服都可以慢慢來。"
          : "先由她陪你；你隨時可以換，不需要多用 token。";
    }
    renderCharacterStage();
    renderRoster();
    renderWardrobe();
    renderVoiceControls();
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
      (candidate) => candidate.characterId === unlock.characterId
    );
    toastElement.textContent = characterUnlockToastText(unlock);
    toastElement.hidden = false;
    renderCharacterPanel();
    const line =
      character === undefined ? undefined : playVoice(character, "unlock");
    celebrationTimer = window.setTimeout(
      () => {
        celebrationTimer = undefined;
        unlockQueue.finish();
        showCurrentUnlock();
      },
      Math.max(2_800, Math.min(line?.durationMs ?? 0, 5_000) + 300)
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
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(CHARACTERS_API_ENDPOINT, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error("Characters unavailable");
      const next = parseCharactersSnapshot(await readCharacterJson(response));
      if (requestSequence !== characterRequestSequence) return;
      const unlocks = diffCharacterUnlocks(charactersSnapshot, next);
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
    reason: string
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
      `TokenMonster ${view.name} 字母角色`
    );
    characterReasonElement.textContent = reason;
  }

  function renderStarter(starter: CompanionStarterSelection): void {
    if (charactersSnapshot !== undefined) {
      renderCharacterPanel();
      return;
    }
    if (starter.outcome === "selected") {
      renderCharacter(
        starter.characterId,
        "依近 28 天的本機使用分布先由她陪你；你隨時可以換。"
      );
      return;
    }
    delete document.documentElement.dataset["character"];
    companionGlyphElement.textContent = "T";
    companionTitleElement.textContent = "選一位姊妹開始陪你。";
    companionVisualElement.setAttribute(
      "aria-label",
      "TokenMonster 字母 T 夥伴"
    );
    characterReasonElement.textContent =
      starter.reason === "highest-provider-total-tie"
        ? "近 28 天有兩位並列，這次由你選；之後也能隨時換。"
        : "目前沒有足夠的 provider 分項，由你選；不需要多用 token。";
  }

  wardrobeToggle.addEventListener("click", () => {
    wardrobeOpen = !wardrobeOpen;
    renderWardrobe();
  });

  document.addEventListener(
    "click",
    () => {
      voiceGate.arm();
      triggerStageVoices();
    },
    { capture: true, once: true }
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

  function prepareRescan(
    label: string,
    enabled: boolean
  ): void {
    rescanButton.textContent = label;
    rescanButton.disabled = !enabled;
  }

  function clearLastGoodDisplay(trendMessage: string): void {
    if (lastGoodSnapshot !== undefined) return;
    setMetricPlaceholders();
    clearTrend(trendMessage, false);
  }

  function updateCharacterConnection(
    nextState: CharacterConnectionState
  ): void {
    previousCharacterConnectionState = characterConnectionState;
    characterConnectionState = nextState;
    renderCharacterStage();
    if (
      nextState === "refresh-failed" &&
      previousCharacterConnectionState !== "refresh-failed"
    ) {
      const character = selectedCharacter();
      if (character !== undefined) playVoice(character, "error");
    }
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
  }

  function showUnavailable(): void {
    document.documentElement.dataset["connection"] = "error";
    statusElement.textContent = "暫時中斷";
    companionLineElement.textContent =
      "本機用量服務暫時沒回應，我會稍後再試。";
    updatedElement.textContent =
      lastGoodSnapshot === undefined
        ? ""
        : `保留本機時間 ${timeFormatter.format(new Date(lastGoodSnapshot.generatedAt))} 的資料`;
    staleBadgeElement.hidden = lastGoodSnapshot === undefined;
    prepareRescan("立即重試", true);
    clearLastGoodDisplay("連線恢復後會顯示 UTC 每日趨勢。");
    updateCharacterConnection("other");
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
    lastGoodSnapshot = snapshot;
    latestTodayTokens = snapshot.totals.today;
    renderStarter(snapshot.starter);
    metricElements.today.textContent = numberFormatter.format(
      snapshot.totals.today
    );
    metricElements.last7Days.textContent = numberFormatter.format(
      snapshot.totals.last7Days
    );
    metricElements.last28Days.textContent = numberFormatter.format(
      snapshot.totals.last28Days
    );
    renderTrend(snapshot);
    void analyticsPanel.refreshInBackground();
  }

  function showSettled(
    snapshot: CompanionHealthySnapshot,
    collector: CompanionCollectorStatus
  ): void {
    blockedByIncompatibility = false;
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
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (
    !contentType.toLowerCase().startsWith("application/json") ||
    (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_CHARACTERS)
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
    value: unknown
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
    controller: AbortController
  ): Promise<CompanionHealthySnapshot | undefined> {
    const response = await fetch(COMPANION_API_ENDPOINT, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: controller.signal
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
    controller: AbortController
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
    setRefreshTimer(SETTLED_POLL_MS);
  }

  async function pollCollector(): Promise<void> {
    clearRefreshTimer();
    currentController?.abort();
    const controller = new AbortController();
    currentController = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(COLLECTOR_STATUS_ENDPOINT, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: controller.signal
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
        canRetry: false
      })
    );
    const controller = new AbortController();
    currentController = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      REFRESH_REQUEST_TIMEOUT_MS
    );
    try {
      const response = await fetch(COLLECTOR_REFRESH_ENDPOINT, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      const payload = parseCollectorPayload(await readBoundedJson(response));
      if ("status" in payload) {
        handleApiError(payload.error);
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

  rescanButton.addEventListener("click", () => {
    if (!rescanButton.disabled) void requestRescan();
  });

  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      !blockedByIncompatibility
    ) {
      void pollCollector();
    }
  });

  showStarting();
  void pollCharacters();
  void pollCollector();
}

if (typeof document !== "undefined") startCompanionUi();
