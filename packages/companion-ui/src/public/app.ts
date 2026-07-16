export const COMPANION_API_ENDPOINT = "/api/companion" as const;
export const COLLECTOR_STATUS_ENDPOINT = "/api/companion/status" as const;
export const COLLECTOR_REFRESH_ENDPOINT = "/api/companion/refresh" as const;

export const COMPANION_ERROR_CODES = [
  "sidecar-unavailable",
  "sidecar-incompatible"
] as const;

export type CompanionErrorCode = (typeof COMPANION_ERROR_CODES)[number];

export const COMPANION_CHARACTER_IDS = [
  "chatgpt",
  "claude",
  "gemini",
  "grok"
] as const;

export type CompanionCharacterId = (typeof COMPANION_CHARACTER_IDS)[number];

export const COMPANION_PROVIDER_FAMILIES = [
  "openai",
  "anthropic",
  "google",
  "xai"
] as const;

export type CompanionProviderFamily =
  (typeof COMPANION_PROVIDER_FAMILIES)[number];

export type CompanionStarterSelection =
  | Readonly<{
      outcome: "selected";
      selectedBy: "manual";
      characterId: CompanionCharacterId;
    }>
  | Readonly<{
      outcome: "selected";
      selectedBy: "unique-provider-total";
      characterId: CompanionCharacterId;
      providerFamily: CompanionProviderFamily;
    }>
  | Readonly<{
      outcome: "user-choice-required";
      reason: "no-positive-provider-data" | "highest-provider-total-tie";
      tiedProviderFamilies: readonly CompanionProviderFamily[];
    }>;

export interface CompanionDailyPoint {
  readonly utcDate: string;
  readonly totalTokens: number;
}

export interface CompanionHealthySnapshot {
  readonly status: "healthy";
  readonly generatedAt: string;
  readonly starter: CompanionStarterSelection;
  readonly totals: Readonly<{
    today: number;
    last7Days: number;
    last28Days: number;
  }>;
  readonly daily: readonly CompanionDailyPoint[];
}

export interface CompanionErrorSnapshot {
  readonly status: "error";
  readonly error: CompanionErrorCode;
}

export type CompanionSnapshot =
  | CompanionHealthySnapshot
  | CompanionErrorSnapshot;

export const COMPANION_COLLECTOR_PHASES = [
  "starting",
  "syncing",
  "ready",
  "ready-no-data",
  "refresh-failed",
  "stale"
] as const;

export type CompanionCollectorPhase =
  (typeof COMPANION_COLLECTOR_PHASES)[number];

export interface CompanionCollectorStatus {
  readonly phase: CompanionCollectorPhase;
  readonly lastSuccessAt: string | null;
  readonly consecutiveFailures: number;
  readonly canRetry: boolean;
}

const UTC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length &&
    [...expectedKeys].sort().every((key, index) => keys[index] === key)
  );
}

function isSafeTokenCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function parseUtcDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !UTC_DATE_PATTERN.test(value)) {
    return undefined;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

function parseGeneratedAt(value: unknown): string | undefined {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) {
    return undefined;
  }
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function utcDateOffset(utcDate: string, days: number): string {
  const timestamp = Date.parse(`${utcDate}T00:00:00.000Z`);
  return new Date(timestamp + days * 86_400_000).toISOString().slice(0, 10);
}

function checkedAdd(left: number, right: number): number | undefined {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : undefined;
}

function isCompanionErrorCode(value: unknown): value is CompanionErrorCode {
  return (
    value === "sidecar-unavailable" || value === "sidecar-incompatible"
  );
}

function isCompanionCharacterId(
  value: unknown
): value is CompanionCharacterId {
  return COMPANION_CHARACTER_IDS.some((candidate) => candidate === value);
}

function isCompanionProviderFamily(
  value: unknown
): value is CompanionProviderFamily {
  return COMPANION_PROVIDER_FAMILIES.some((candidate) => candidate === value);
}

const CHARACTER_BY_PROVIDER = Object.freeze({
  openai: "chatgpt",
  anthropic: "claude",
  google: "gemini",
  xai: "grok"
} as const satisfies Readonly<
  Record<CompanionProviderFamily, CompanionCharacterId>
>);

function parseStarterSelection(
  value: unknown
): CompanionStarterSelection | undefined {
  if (!isRecord(value) || typeof value["outcome"] !== "string") {
    return undefined;
  }
  if (value["outcome"] === "selected") {
    const selectedBy = value["selectedBy"];
    const characterId = value["characterId"];
    if (!isCompanionCharacterId(characterId)) return undefined;
    if (
      selectedBy === "manual" &&
      hasExactKeys(value, ["outcome", "selectedBy", "characterId"])
    ) {
      return Object.freeze({ outcome: "selected", selectedBy, characterId });
    }
    const providerFamily = value["providerFamily"];
    if (
      selectedBy === "unique-provider-total" &&
      hasExactKeys(value, [
        "outcome",
        "selectedBy",
        "characterId",
        "providerFamily"
      ]) &&
      isCompanionProviderFamily(providerFamily) &&
      CHARACTER_BY_PROVIDER[providerFamily] === characterId
    ) {
      return Object.freeze({
        outcome: "selected",
        selectedBy,
        characterId,
        providerFamily
      });
    }
    return undefined;
  }
  if (
    value["outcome"] !== "user-choice-required" ||
    !hasExactKeys(value, ["outcome", "reason", "tiedProviderFamilies"]) ||
    !Array.isArray(value["tiedProviderFamilies"])
  ) {
    return undefined;
  }
  const reason = value["reason"];
  const tiedProviderFamilies = value["tiedProviderFamilies"];
  if (
    !tiedProviderFamilies.every(isCompanionProviderFamily) ||
    new Set(tiedProviderFamilies).size !== tiedProviderFamilies.length ||
    !tiedProviderFamilies.every(
      (providerFamily, index) =>
        COMPANION_PROVIDER_FAMILIES.indexOf(providerFamily) >
        (index === 0
          ? -1
          : COMPANION_PROVIDER_FAMILIES.indexOf(
              tiedProviderFamilies[index - 1]!
            ))
    ) ||
    (reason === "no-positive-provider-data" &&
      tiedProviderFamilies.length !== 0) ||
    (reason === "highest-provider-total-tie" &&
      tiedProviderFamilies.length < 2)
  ) {
    return undefined;
  }
  if (
    reason !== "no-positive-provider-data" &&
    reason !== "highest-provider-total-tie"
  ) {
    return undefined;
  }
  return Object.freeze({
    outcome: "user-choice-required",
    reason,
    tiedProviderFamilies: Object.freeze([...tiedProviderFamilies])
  });
}

function parseErrorSnapshot(
  value: Record<string, unknown>
): CompanionErrorSnapshot | undefined {
  if (!hasExactKeys(value, ["status", "error"])) return undefined;
  const error = value["error"];
  if (!isCompanionErrorCode(error)) return undefined;
  return Object.freeze({ status: "error", error });
}

function parseHealthySnapshot(
  value: Record<string, unknown>
): CompanionHealthySnapshot | undefined {
  if (
    !hasExactKeys(value, [
      "status",
      "generatedAt",
      "starter",
      "totals",
      "daily"
    ])
  ) {
    return undefined;
  }

  const generatedAt = parseGeneratedAt(value["generatedAt"]);
  const starter = parseStarterSelection(value["starter"]);
  const totals = value["totals"];
  const daily = value["daily"];
  if (
    generatedAt === undefined ||
    starter === undefined ||
    !isRecord(totals) ||
    !hasExactKeys(totals, ["today", "last7Days", "last28Days"]) ||
    !isSafeTokenCount(totals["today"]) ||
    !isSafeTokenCount(totals["last7Days"]) ||
    !isSafeTokenCount(totals["last28Days"]) ||
    !Array.isArray(daily) ||
    daily.length > 28
  ) {
    return undefined;
  }

  const todayUtcDate = generatedAt.slice(0, 10);
  const firstUtcDate = utcDateOffset(todayUtcDate, -27);
  const firstSevenDayUtcDate = utcDateOffset(todayUtcDate, -6);
  const points: CompanionDailyPoint[] = [];
  let previousUtcDate = "";
  let todayTotal = 0;
  let sevenDayTotal = 0;
  let twentyEightDayTotal = 0;

  for (const candidate of daily) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["utcDate", "totalTokens"])
    ) {
      return undefined;
    }
    const utcDate = parseUtcDate(candidate["utcDate"]);
    const totalTokens = candidate["totalTokens"];
    if (
      utcDate === undefined ||
      !isSafeTokenCount(totalTokens) ||
      utcDate < firstUtcDate ||
      utcDate > todayUtcDate ||
      (previousUtcDate !== "" && utcDate <= previousUtcDate)
    ) {
      return undefined;
    }

    const nextTwentyEightDayTotal = checkedAdd(
      twentyEightDayTotal,
      totalTokens
    );
    if (nextTwentyEightDayTotal === undefined) return undefined;
    twentyEightDayTotal = nextTwentyEightDayTotal;

    if (utcDate >= firstSevenDayUtcDate) {
      const nextSevenDayTotal = checkedAdd(sevenDayTotal, totalTokens);
      if (nextSevenDayTotal === undefined) return undefined;
      sevenDayTotal = nextSevenDayTotal;
    }
    if (utcDate === todayUtcDate) todayTotal = totalTokens;

    previousUtcDate = utcDate;
    points.push(Object.freeze({ utcDate, totalTokens }));
  }

  if (
    totals["today"] !== todayTotal ||
    totals["last7Days"] !== sevenDayTotal ||
    totals["last28Days"] !== twentyEightDayTotal
  ) {
    return undefined;
  }

  return Object.freeze({
    status: "healthy",
    generatedAt,
    starter,
    totals: Object.freeze({
      today: totals["today"],
      last7Days: totals["last7Days"],
      last28Days: totals["last28Days"]
    }),
    daily: Object.freeze(points)
  });
}

/** Strictly validates the only aggregate DTO accepted by the browser UI. */
export function parseCompanionSnapshot(value: unknown): CompanionSnapshot {
  if (!isRecord(value) || typeof value["status"] !== "string") {
    throw new TypeError("Invalid companion response");
  }
  const parsed =
    value["status"] === "healthy"
      ? parseHealthySnapshot(value)
      : value["status"] === "error"
        ? parseErrorSnapshot(value)
        : undefined;
  if (parsed === undefined) throw new TypeError("Invalid companion response");
  return parsed;
}

function isCompanionCollectorPhase(
  value: unknown
): value is CompanionCollectorPhase {
  return COMPANION_COLLECTOR_PHASES.some((phase) => phase === value);
}

/** Strictly validates the content-blind collector DTO accepted by the UI. */
export function parseCompanionCollectorStatus(
  value: unknown
): CompanionCollectorStatus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "phase",
      "lastSuccessAt",
      "consecutiveFailures",
      "canRetry"
    ])
  ) {
    throw new TypeError("Invalid collector response");
  }
  const phase = value["phase"];
  const lastSuccessAt = value["lastSuccessAt"];
  const consecutiveFailures = value["consecutiveFailures"];
  const canRetry = value["canRetry"];
  if (
    !isCompanionCollectorPhase(phase) ||
    (lastSuccessAt !== null &&
      parseGeneratedAt(lastSuccessAt) === undefined) ||
    !isSafeTokenCount(consecutiveFailures) ||
    typeof canRetry !== "boolean" ||
    ((phase === "ready" || phase === "ready-no-data") &&
      (lastSuccessAt === null || consecutiveFailures !== 0)) ||
    (phase === "refresh-failed" &&
      (lastSuccessAt !== null || consecutiveFailures < 1)) ||
    (phase === "stale" &&
      (lastSuccessAt === null || consecutiveFailures < 1))
  ) {
    throw new TypeError("Invalid collector response");
  }
  return Object.freeze({
    phase,
    lastSuccessAt: lastSuccessAt as string | null,
    consecutiveFailures,
    canRetry
  });
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MAX_RESPONSE_CHARACTERS = 65_536;
const REQUEST_TIMEOUT_MS = 8_000;
const REFRESH_REQUEST_TIMEOUT_MS = 100_000;
const ACTIVE_POLL_MS = 5_000;
const SETTLED_POLL_MS = 60_000;
const UNAVAILABLE_RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;

export interface UnavailableRetryBackoff {
  nextDelayMs(): number;
  reset(): void;
}

export function createUnavailableRetryBackoff(): UnavailableRetryBackoff {
  let failureIndex = 0;
  return Object.freeze({
    nextDelayMs(): number {
      const delay =
        UNAVAILABLE_RETRY_DELAYS_MS[
          Math.min(failureIndex, UNAVAILABLE_RETRY_DELAYS_MS.length - 1)
        ] ?? 60_000;
      failureIndex += 1;
      return delay;
    },
    reset(): void {
      failureIndex = 0;
    }
  });
}

export function shouldAutomaticallyRetry(error: CompanionErrorCode): boolean {
  return error === "sidecar-unavailable";
}

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
  grok: Object.freeze({ glyph: "X", name: "Grok" })
} as const satisfies Readonly<
  Record<CompanionCharacterId, Readonly<{ glyph: string; name: string }>>
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
  const companionTitleElement = requiredElement<HTMLElement>(
    "[data-companion-title]"
  );
  const characterReasonElement = requiredElement<HTMLElement>(
    "[data-character-reason]"
  );
  const characterButtons = [
    ...document.querySelectorAll<HTMLButtonElement>("[data-character-id]")
  ];
  if (characterButtons.length !== COMPANION_CHARACTER_IDS.length) {
    throw new Error("Required character choices are unavailable");
  }
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
  const metricElements = {
    today: requiredElement<HTMLElement>("[data-metric='today']"),
    last7Days: requiredElement<HTMLElement>("[data-metric='last7Days']"),
    last28Days: requiredElement<HTMLElement>("[data-metric='last28Days']")
  };
  const unavailableRetryBackoff = createUnavailableRetryBackoff();
  let manualCharacterId: CompanionCharacterId | undefined;
  let lastGoodSnapshot: CompanionHealthySnapshot | undefined;

  function renderCharacter(
    characterId: CompanionCharacterId,
    reason: string
  ): void {
    const view = CHARACTER_VIEW[characterId];
    document.documentElement.dataset["character"] = characterId;
    companionGlyphElement.textContent = view.glyph;
    companionTitleElement.textContent = `嗨，我是 ${view.name} 姊姊。`;
    companionVisualElement.setAttribute(
      "aria-label",
      `TokenMonster ${view.name} 字母角色`
    );
    characterReasonElement.textContent = reason;
    for (const button of characterButtons) {
      button.setAttribute(
        "aria-pressed",
        button.dataset["characterId"] === characterId ? "true" : "false"
      );
    }
  }

  function renderStarter(starter: CompanionStarterSelection): void {
    if (manualCharacterId !== undefined) {
      renderCharacter(
        manualCharacterId,
        "這是你選的陪伴角色；本機用量不會限制你換人。"
      );
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
    for (const button of characterButtons) {
      button.setAttribute("aria-pressed", "false");
    }
    characterReasonElement.textContent =
      starter.reason === "highest-provider-total-tie"
        ? "近 28 天有兩位並列，這次由你選；之後也能隨時換。"
        : "目前沒有足夠的 provider 分項，由你選；不需要多用 token。";
  }

  for (const button of characterButtons) {
    const characterId = button.dataset["characterId"];
    if (!isCompanionCharacterId(characterId)) {
      throw new Error("Invalid character choice");
    }
    button.addEventListener("click", () => {
      manualCharacterId = characterId;
      renderCharacter(
        characterId,
        "這是你選的陪伴角色；本機用量不會限制你換人。"
      );
    });
  }

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

  function showStarting(): void {
    document.documentElement.dataset["connection"] = "starting";
    statusElement.textContent = "正在啟動";
    companionLineElement.textContent = "本機用量服務正在準備，很快就好。";
    updatedElement.textContent = "";
    staleBadgeElement.hidden = true;
    prepareRescan("重新掃描", false);
    clearLastGoodDisplay("啟動完成後會顯示 UTC 每日趨勢。");
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

function formatDate(utcDate: string): string {
  return `${utcDate.slice(5, 7)}/${utcDate.slice(8, 10)}`;
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(
  name: K
): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NAMESPACE, name);
}

function clearTrend(message: string, healthy: boolean): void {
  trendElement.replaceChildren();
  trendAccessibleElement.replaceChildren();
  trendEmptyElement.textContent = message;
  trendEmptyElement.hidden = false;
  trendElement.hidden = true;
  trendElement.dataset["healthy"] = healthy ? "true" : "false";
}

function renderAccessibleTrend(points: readonly CompanionDailyPoint[]): void {
  const fragment = document.createDocumentFragment();
  for (const point of points) {
    const item = document.createElement("li");
    item.textContent = `UTC ${point.utcDate}：${numberFormatter.format(point.totalTokens)} tokens`;
    fragment.append(item);
  }
  trendAccessibleElement.replaceChildren(fragment);
}

function renderTrend(snapshot: CompanionHealthySnapshot): void {
  const points = snapshot.daily;
  if (points.length === 0) {
    clearTrend("目前還沒有 UTC 每日用量紀錄。", true);
    return;
  }

  const width = 720;
  const height = 220;
  const plotTop = 18;
  const plotBottom = 176;
  const plotHeight = plotBottom - plotTop;
  const columnWidth = width / 28;
  const barWidth = Math.max(6, columnWidth - 8);
  const maxTokens = Math.max(...points.map((point) => point.totalTokens));
  const todayUtcDate = snapshot.generatedAt.slice(0, 10);
  const todayTimestamp = Date.parse(`${todayUtcDate}T00:00:00.000Z`);
  const firstTimestamp = todayTimestamp - 27 * 86_400_000;

  const svg = createSvgElement("svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    `最近 28 個 UTC 日的每日 token 趨勢，共 ${numberFormatter.format(snapshot.totals.last28Days)} tokens。`
  );
  svg.classList.add("trend-chart");

  const baseline = createSvgElement("line");
  baseline.setAttribute("x1", "0");
  baseline.setAttribute("x2", String(width));
  baseline.setAttribute("y1", String(plotBottom));
  baseline.setAttribute("y2", String(plotBottom));
  baseline.classList.add("trend-baseline");
  svg.append(baseline);

  for (const point of points) {
    const pointTimestamp = Date.parse(`${point.utcDate}T00:00:00.000Z`);
    const dayIndex = Math.round(
      (pointTimestamp - firstTimestamp) / 86_400_000
    );
    const barHeight =
      maxTokens === 0 ? 0 : (point.totalTokens / maxTokens) * plotHeight;
    const bar = createSvgElement("rect");
    bar.setAttribute(
      "x",
      String(dayIndex * columnWidth + (columnWidth - barWidth) / 2)
    );
    bar.setAttribute("y", String(plotBottom - barHeight));
    bar.setAttribute("width", String(barWidth));
    bar.setAttribute("height", String(barHeight));
    bar.setAttribute("rx", "4");
    bar.classList.add("trend-bar");
    const title = createSvgElement("title");
    title.textContent = `${point.utcDate}：${numberFormatter.format(point.totalTokens)} tokens`;
    bar.append(title);
    svg.append(bar);
  }

  const firstLabel = createSvgElement("text");
  firstLabel.setAttribute("x", "0");
  firstLabel.setAttribute("y", "210");
  firstLabel.classList.add("trend-label");
  firstLabel.textContent = formatDate(
    new Date(firstTimestamp).toISOString().slice(0, 10)
  );
  const lastLabel = createSvgElement("text");
  lastLabel.setAttribute("x", String(width));
  lastLabel.setAttribute("y", "210");
  lastLabel.setAttribute("text-anchor", "end");
  lastLabel.classList.add("trend-label");
  lastLabel.textContent = formatDate(todayUtcDate);
  svg.append(firstLabel, lastLabel);

  trendElement.replaceChildren(svg);
  renderAccessibleTrend(points);
  trendEmptyElement.hidden = true;
  trendElement.hidden = false;
  trendElement.dataset["healthy"] = "true";
}

  function renderSnapshotData(snapshot: CompanionHealthySnapshot): void {
    lastGoodSnapshot = snapshot;
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
  void pollCollector();
}

if (typeof document !== "undefined") startCompanionUi();
