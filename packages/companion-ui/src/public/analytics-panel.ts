import type { UsageAnalyticsSnapshot } from "./api.js";
import {
  USAGE_FAMILIES,
  USAGE_WINDOWS,
  type UsageFamily,
  type UsageFamilyDay,
  type UsageWindow
} from "./dto.js";
import { formatCompactTokenCount } from "./usage-panel.js";

export const USAGE_FAMILY_LABELS = Object.freeze({
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  xai: "xAI",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  mistral: "Mistral",
  venice: "Venice",
  sakana: "Sakana",
  perplexity: "Perplexity",
  glm: "GLM",
  other: "其他"
} as const satisfies Readonly<Record<UsageFamily, string>>);

const numberFormatter = new Intl.NumberFormat("zh-TW", {
  maximumFractionDigits: 0,
  useGrouping: true
});

export interface FamilyShare {
  readonly family: UsageFamily;
  readonly totalTokens: number;
  readonly percentage: number;
}

export interface AnalyticsWindowRequest {
  readonly id: number;
  readonly window: UsageWindow;
}

export interface AnalyticsWindowStateMachine {
  selectedWindow(): UsageWindow;
  select(window: UsageWindow): AnalyticsWindowRequest | undefined;
  refresh(): AnalyticsWindowRequest;
  isCurrent(request: AnalyticsWindowRequest): boolean;
}

export function createAnalyticsWindowStateMachine(
  initialWindow: UsageWindow = 28
): AnalyticsWindowStateMachine {
  let selectedWindow = initialWindow;
  let requestId = 0;

  function createRequest(): AnalyticsWindowRequest {
    requestId += 1;
    return Object.freeze({ id: requestId, window: selectedWindow });
  }

  return Object.freeze({
    selectedWindow: () => selectedWindow,
    select(window: UsageWindow): AnalyticsWindowRequest | undefined {
      if (window === selectedWindow) return undefined;
      selectedWindow = window;
      return createRequest();
    },
    refresh: createRequest,
    isCurrent: (request: AnalyticsWindowRequest) =>
      request.id === requestId && request.window === selectedWindow
  });
}

function addTokenCount(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new TypeError("Usage total exceeds safe integer range");
  }
  return total;
}

export function calculateFamilyShares(
  days: readonly UsageFamilyDay[]
): readonly FamilyShare[] {
  const totals = Object.fromEntries(
    USAGE_FAMILIES.map((family) => [family, 0])
  ) as Record<UsageFamily, number>;
  for (const day of days) {
    for (const family of USAGE_FAMILIES) {
      totals[family] = addTokenCount(totals[family], day.families[family]);
    }
  }

  const positive = USAGE_FAMILIES.map((family, order) => ({
    family,
    order,
    totalTokens: totals[family]
  }))
    .filter((entry) => entry.totalTokens > 0)
    .sort(
      (left, right) =>
        right.totalTokens - left.totalTokens || left.order - right.order
    );
  if (positive.length === 0) return Object.freeze([]);

  const windowTotal = positive.reduce(
    (total, entry) => addTokenCount(total, entry.totalTokens),
    0
  );
  const withRemainders = positive.map((entry) => {
    const exact = (entry.totalTokens / windowTotal) * 100;
    const percentage = Math.floor(exact);
    return { ...entry, percentage, remainder: exact - percentage };
  });
  let remaining =
    100 - withRemainders.reduce((total, entry) => total + entry.percentage, 0);
  for (const entry of [...withRemainders].sort(
    (left, right) =>
      right.remainder - left.remainder || left.order - right.order
  )) {
    if (remaining === 0) break;
    entry.percentage += 1;
    remaining -= 1;
  }

  return Object.freeze(
    withRemainders.map((entry) =>
      Object.freeze({
        family: entry.family,
        totalTokens: entry.totalTokens,
        percentage: entry.percentage
      })
    )
  );
}

export function shouldRenderAnalyticsEmpty(
  days: readonly UsageFamilyDay[]
): boolean {
  return days.every((day) =>
    USAGE_FAMILIES.every((family) => day.families[family] === 0)
  );
}

export function enabledAnalyticsMotionClasses(
  reducedMotion: boolean
): readonly string[] {
  return reducedMotion
    ? Object.freeze([])
    : Object.freeze(["analytics-bars-motion"]);
}

export interface AnalyticsPanelOptions {
  readonly root: HTMLElement;
  readonly reducedMotion: boolean;
  readonly load: (
    window: UsageWindow,
    signal: AbortSignal
  ) => Promise<UsageAnalyticsSnapshot>;
}

export interface AnalyticsPanel {
  refresh(): Promise<void>;
  refreshInBackground(): Promise<void>;
  selectedWindow(): UsageWindow;
}

function requiredChild<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) {
    throw new Error("Required analytics element is unavailable");
  }
  return element;
}

function familyClass(family: UsageFamily): string {
  return `family-${family}`;
}

function formatDate(utcDate: string): string {
  return `${utcDate.slice(5, 7)}/${utcDate.slice(8, 10)}`;
}

export function createAnalyticsPanel(
  options: AnalyticsPanelOptions
): AnalyticsPanel {
  const root = options.root;
  const buttons = [
    ...root.querySelectorAll<HTMLButtonElement>("[data-analytics-window]")
  ];
  const loading = requiredChild<HTMLElement>(root, "[data-analytics-loading]");
  const empty = requiredChild<HTMLElement>(root, "[data-analytics-empty]");
  const error = requiredChild<HTMLElement>(root, "[data-analytics-error]");
  const content = requiredChild<HTMLElement>(root, "[data-analytics-content]");
  const retry = requiredChild<HTMLButtonElement>(root, "[data-analytics-retry]");
  const summary = requiredChild<HTMLElement>(root, "[data-analytics-summary]");
  const chart = requiredChild<HTMLElement>(root, "[data-family-chart]");
  const legend = requiredChild<HTMLElement>(root, "[data-family-legend]");
  const shares = requiredChild<HTMLElement>(root, "[data-family-shares]");
  const models = requiredChild<HTMLElement>(root, "[data-top-models]");
  const accessible = requiredChild<HTMLTableSectionElement>(
    root,
    "[data-family-accessible]"
  );
  const state = createAnalyticsWindowStateMachine();
  let controller: AbortController | undefined;

  function setView(view: "loading" | "empty" | "error" | "content"): void {
    loading.hidden = view !== "loading";
    empty.hidden = view !== "empty";
    error.hidden = view !== "error";
    content.hidden = view !== "content";
    root.setAttribute("aria-busy", view === "loading" ? "true" : "false");
  }

  function updateButtons(): void {
    const selectedWindow = state.selectedWindow();
    for (const button of buttons) {
      button.setAttribute(
        "aria-pressed",
        button.dataset["analyticsWindow"] === String(selectedWindow)
          ? "true"
          : "false"
      );
    }
  }

  function renderLegend(familyShares: readonly FamilyShare[]): void {
    legend.replaceChildren(
      ...familyShares.map((share) => {
        const item = document.createElement("li");
        const chip = document.createElement("span");
        chip.classList.add("family-chip", familyClass(share.family));
        chip.setAttribute("aria-hidden", "true");
        item.append(chip, USAGE_FAMILY_LABELS[share.family]);
        return item;
      })
    );
  }

  function renderAccessibleTable(days: readonly UsageFamilyDay[]): void {
    const rows = days.map((day) => {
      const row = document.createElement("tr");
      const date = document.createElement("th");
      date.scope = "row";
      date.textContent = day.utcDate;
      row.append(date);
      for (const family of USAGE_FAMILIES) {
        const value = document.createElement("td");
        value.textContent = numberFormatter.format(day.families[family]);
        row.append(value);
      }
      return row;
    });
    accessible.replaceChildren(...rows);
  }

  function renderChart(days: readonly UsageFamilyDay[]): void {
    const dayTotals = days.map((day) =>
      USAGE_FAMILIES.reduce(
        (total, family) => addTokenCount(total, day.families[family]),
        0
      )
    );
    const maxDayTotal = Math.max(...dayTotals);
    const plot = document.createElement("div");
    plot.className = "family-chart-plot";
    plot.classList.add(...enabledAnalyticsMotionClasses(options.reducedMotion));
    for (const [index, day] of days.entries()) {
      const column = document.createElement("div");
      column.className = "family-day-column";
      column.setAttribute("aria-hidden", "true");
      const bar = document.createElement("div");
      bar.className = "family-day-bar";
      bar.title = `${day.utcDate}：${numberFormatter.format(
        dayTotals[index] ?? 0
      )} tokens`;
      for (const family of USAGE_FAMILIES) {
        const familyTokens = day.families[family];
        if (familyTokens === 0) continue;
        const segment = document.createElement("span");
        segment.classList.add("family-day-segment", familyClass(family));
        segment.style.height = `${(familyTokens / maxDayTotal) * 100}%`;
        segment.title = `${USAGE_FAMILY_LABELS[family]}：${numberFormatter.format(
          familyTokens
        )} tokens`;
        bar.append(segment);
      }
      column.append(bar);
      plot.append(column);
    }
    const range = document.createElement("div");
    range.className = "family-chart-range";
    const first = document.createElement("span");
    first.textContent = formatDate(days[0]!.utcDate);
    const last = document.createElement("span");
    last.textContent = formatDate(days.at(-1)!.utcDate);
    range.append(first, last);
    chart.replaceChildren(plot, range);
  }

  function renderShares(familyShares: readonly FamilyShare[]): void {
    shares.replaceChildren(
      ...familyShares.map((share) => {
        const item = document.createElement("li");
        const identity = document.createElement("span");
        identity.className = "family-share-identity";
        const chip = document.createElement("span");
        chip.classList.add("family-chip", familyClass(share.family));
        chip.setAttribute("aria-hidden", "true");
        identity.append(chip, USAGE_FAMILY_LABELS[share.family]);
        const value = document.createElement("span");
        value.className = "family-share-value";
        value.textContent = `${numberFormatter.format(share.totalTokens)} · ${share.percentage}%`;
        item.append(identity, value);
        return item;
      })
    );
  }

  function renderModels(snapshot: UsageAnalyticsSnapshot): void {
    if (snapshot.models.models.length === 0) {
      const message = document.createElement("p");
      message.className = "analytics-model-empty";
      message.textContent = "目前沒有可列出的模型明細。";
      models.replaceChildren(message);
      return;
    }
    models.replaceChildren(
      ...snapshot.models.models.map((model) => {
        const row = document.createElement("li");
        const identity = document.createElement("span");
        identity.className = "model-identity";
        const chip = document.createElement("span");
        chip.classList.add("family-chip", familyClass(model.family));
        chip.setAttribute("aria-label", USAGE_FAMILY_LABELS[model.family]);
        const name = document.createElement("code");
        name.textContent = model.model;
        name.title = model.model;
        identity.append(chip, name);

        const usage = document.createElement("span");
        usage.className = "model-usage";
        const total = document.createElement("strong");
        total.textContent = formatCompactTokenCount(model.totalTokens);
        total.title = `${numberFormatter.format(model.totalTokens)} tokens`;
        usage.append(total);
        const splitParts: string[] = [];
        if (model.inputTokens !== undefined) {
          splitParts.push(`輸入 ${formatCompactTokenCount(model.inputTokens)}`);
        }
        if (model.outputTokens !== undefined) {
          splitParts.push(`輸出 ${formatCompactTokenCount(model.outputTokens)}`);
        }
        if (splitParts.length > 0) {
          const split = document.createElement("small");
          split.textContent = splitParts.join(" · ");
          usage.append(split);
        }
        row.append(identity, usage);
        return row;
      })
    );
  }

  function renderSnapshot(snapshot: UsageAnalyticsSnapshot): void {
    if (shouldRenderAnalyticsEmpty(snapshot.families.days)) {
      chart.replaceChildren();
      legend.replaceChildren();
      shares.replaceChildren();
      models.replaceChildren();
      accessible.replaceChildren();
      summary.textContent = `近 ${snapshot.families.window} 天沒有 token 用量可分析。`;
      setView("empty");
      return;
    }
    const familyShares = calculateFamilyShares(snapshot.families.days);
    const totalTokens = familyShares.reduce(
      (total, share) => addTokenCount(total, share.totalTokens),
      0
    );
    renderChart(snapshot.families.days);
    renderAccessibleTable(snapshot.families.days);
    renderLegend(familyShares);
    renderShares(familyShares);
    renderModels(snapshot);
    setSummary(
      `近 ${snapshot.families.window} 天共 ${numberFormatter.format(totalTokens)} tokens，來自 ${familyShares.length} 個供應商家族。`
    );
    setView("content");
  }

  // The summary is an aria-live region; identical rewrites still trigger
  // screen-reader announcements, so only mutate on actual text changes.
  function setSummary(text: string): void {
    if (summary.textContent !== text) summary.textContent = text;
  }

  async function execute(
    request: AnalyticsWindowRequest,
    background: boolean
  ): Promise<void> {
    controller?.abort();
    controller = new AbortController();
    const requestController = controller;
    updateButtons();
    if (!background) {
      setSummary(`正在整理近 ${request.window} 天的各家分析。`);
      setView("loading");
    }
    try {
      const snapshot = await options.load(
        request.window,
        requestController.signal
      );
      if (!state.isCurrent(request)) return;
      renderSnapshot(snapshot);
    } catch {
      if (!state.isCurrent(request) || requestController.signal.aborted) return;
      // Background refreshes must not blank out data the user is reading;
      // the next poll retries anyway.
      if (background && !content.hidden) return;
      setSummary(`近 ${request.window} 天的各家分析暫時無法載入。`);
      setView("error");
    } finally {
      if (controller === requestController) controller = undefined;
    }
  }

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const window = Number(button.dataset["analyticsWindow"]);
      if (!USAGE_WINDOWS.some((candidate) => candidate === window)) return;
      const request = state.select(window as UsageWindow);
      if (request !== undefined) void execute(request, false);
    });
  }
  retry.addEventListener("click", () => void execute(state.refresh(), false));
  updateButtons();

  return Object.freeze({
    refresh: () => execute(state.refresh(), false),
    refreshInBackground: () => execute(state.refresh(), true),
    selectedWindow: state.selectedWindow
  });
}
