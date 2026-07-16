import type {
  CompanionDailyPoint,
  CompanionHealthySnapshot
} from "./dto.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const numberFormatter = new Intl.NumberFormat("zh-TW", {
  maximumFractionDigits: 0
});
const compactNumberFormatter = new Intl.NumberFormat("zh-TW", {
  notation: "compact",
  maximumFractionDigits: 1
});

export function formatCompactTokenCount(value: number): string {
  return compactNumberFormatter.format(value);
}

export interface UsagePanelElements {
  readonly trend: HTMLElement;
  readonly empty: HTMLElement;
  readonly accessible: HTMLOListElement;
}

export interface UsagePanel {
  clearTrend(message: string, healthy: boolean): void;
  renderTrend(snapshot: CompanionHealthySnapshot): void;
}

export function createUsagePanel(elements: UsagePanelElements): UsagePanel {
  const trendElement = elements.trend;
  const trendEmptyElement = elements.empty;
  const trendAccessibleElement = elements.accessible;

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

    return Object.freeze({ clearTrend, renderTrend });
}

