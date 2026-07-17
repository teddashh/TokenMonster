import {
  QUOTA_FAMILIES,
  QUOTA_PLAN_OPTIONS,
  type QuotaFamily,
  type QuotaFamilyEstimate,
  type QuotaSnapshot
} from "./dto.js";

const FAMILY_LABELS = Object.freeze({
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI"
} as const satisfies Readonly<Record<QuotaFamily, string>>);

export interface QuotaPanelOptions {
  readonly root: HTMLElement;
  readonly load: () => Promise<QuotaSnapshot>;
  readonly update: (family: QuotaFamily, planId: string | null) => Promise<QuotaSnapshot>;
}

function remainingPercent(entry: QuotaFamilyEstimate): number {
  if (entry.budgetTokens === null || entry.usedTokens >= entry.budgetTokens) return 0;
  return Math.max(
    0,
    Math.min(100, Math.round((1 - entry.usedTokens / entry.budgetTokens) * 100))
  );
}

export function quotaRowView(entry: QuotaFamilyEstimate): Readonly<{
  readonly configured: boolean;
  readonly exceeded: boolean;
  readonly remainingPercent: number;
  readonly statusText: string | null;
}> {
  if (entry.planId === null || entry.budgetTokens === null) {
    return Object.freeze({
      configured: false,
      exceeded: false,
      remainingPercent: 0,
      statusText: null
    });
  }
  const remaining = remainingPercent(entry);
  const exceeded = entry.usedTokens >= entry.budgetTokens;
  return Object.freeze({
    configured: true,
    exceeded,
    remainingPercent: remaining,
    statusText: exceeded
      ? "已超過估算額度"
      : `約剩 ${remaining}%・視窗 ${entry.windowHours} 小時`
  });
}

export function renderQuotaSnapshot(root: HTMLElement, snapshot: QuotaSnapshot): void {
  root.replaceChildren(
    ...QUOTA_FAMILIES.map((family) => {
      const entry = snapshot.families.find((candidate) => candidate.family === family)!;
      const row = document.createElement("div");
      row.className = "quota-row";
      row.dataset["quotaFamily"] = family;

      const heading = document.createElement("div");
      heading.className = "quota-row-heading";
      const label = document.createElement("label");
      label.textContent = FAMILY_LABELS[family];
      label.htmlFor = `quota-plan-${family}`;
      const select = document.createElement("select");
      select.id = `quota-plan-${family}`;
      select.dataset["quotaPlan"] = family;
      select.append(new Option("未設定", ""));
      for (const plan of QUOTA_PLAN_OPTIONS[family]) {
        select.append(new Option(plan.labelZh, plan.planId));
      }
      select.value = entry.planId ?? "";
      heading.append(label, select);
      row.append(heading);

      const view = quotaRowView(entry);
      if (view.configured) {
        const status = document.createElement("p");
        status.className = "quota-status";
        status.textContent = view.statusText;
        const track = document.createElement("div");
        track.className = "quota-track";
        track.setAttribute("role", "progressbar");
        track.setAttribute("aria-label", `${FAMILY_LABELS[family]} 剩餘估算`);
        track.setAttribute("aria-valuemin", "0");
        track.setAttribute("aria-valuemax", "100");
        track.setAttribute("aria-valuenow", String(view.remainingPercent));
        const bar = document.createElement("span");
        bar.className = "quota-bar";
        bar.style.width = `${view.remainingPercent}%`;
        track.append(bar);
        row.append(status, track);
      }
      return row;
    })
  );
}

export function createQuotaPanel(options: QuotaPanelOptions): Readonly<{
  refresh(): Promise<void>;
}> {
  let currentRequest = 0;
  const refresh = async (): Promise<void> => {
    const request = ++currentRequest;
    try {
      const snapshot = await options.load();
      if (request === currentRequest) renderQuotaSnapshot(options.root, snapshot);
    } catch {
      if (request === currentRequest) {
        options.root.textContent = "剩餘額度估算暫時載入不了。";
      }
    }
  };
  options.root.addEventListener("change", (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement)) return;
    const family = select.dataset["quotaPlan"];
    if (!QUOTA_FAMILIES.some((candidate) => candidate === family)) return;
    select.disabled = true;
    void options
      .update(family as QuotaFamily, select.value === "" ? null : select.value)
      .then(() => refresh())
      .catch(() => refresh());
  });
  return Object.freeze({ refresh });
}
