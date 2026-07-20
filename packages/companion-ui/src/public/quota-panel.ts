import {
  QUOTA_FAMILIES,
  QUOTA_PLAN_OPTIONS,
  type QuotaFamily,
  type QuotaFamilyEstimate,
  type QuotaSnapshot,
} from "./dto.js";
import { localizeUiText } from "./localization.js";

const FAMILY_LABELS = Object.freeze({
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
} as const satisfies Readonly<Record<QuotaFamily, string>>);

const QUOTA_PLAN_SAVED_FEEDBACK_MS = 3_000;

type QuotaPlanFeedback = Readonly<{
  family: QuotaFamily;
  state: "saving" | "saved" | "error";
}>;

const QUOTA_PLAN_FEEDBACK_TEXT = Object.freeze({
  saving: "正在儲存…",
  saved: "方案已更新。",
  error: "方案未更新，請再試一次。",
} as const satisfies Readonly<Record<QuotaPlanFeedback["state"], string>>);

export interface QuotaPanelOptions {
  readonly root: HTMLElement;
  readonly load: (signal: AbortSignal) => Promise<QuotaSnapshot>;
  readonly update: (
    family: QuotaFamily,
    planId: string | null,
  ) => Promise<QuotaSnapshot>;
}

function remainingPercent(entry: QuotaFamilyEstimate): number {
  if (entry.budgetTokens === null || entry.usedTokens >= entry.budgetTokens)
    return 0;
  return Math.max(
    0,
    Math.min(
      100,
      Math.round((1 - entry.usedTokens / entry.budgetTokens) * 100),
    ),
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
      statusText: null,
    });
  }
  const remaining = remainingPercent(entry);
  const exceeded = entry.usedTokens >= entry.budgetTokens;
  return Object.freeze({
    configured: true,
    exceeded,
    remainingPercent: remaining,
    statusText: localizeUiText(
      exceeded
        ? "已超過估算額度"
        : `約剩 ${remaining}%・視窗 ${entry.windowHours} 小時`,
    ),
  });
}

export function renderQuotaSnapshot(
  root: HTMLElement,
  snapshot: QuotaSnapshot,
): void {
  root.replaceChildren(
    ...QUOTA_FAMILIES.map((family) => {
      const entry = snapshot.families.find(
        (candidate) => candidate.family === family,
      )!;
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
      select.append(new Option(localizeUiText("未設定"), ""));
      for (const plan of QUOTA_PLAN_OPTIONS[family]) {
        select.append(new Option(localizeUiText(plan.labelZh), plan.planId));
      }
      select.value = entry.planId ?? "";
      heading.append(label, select);
      row.append(heading);

      const planFeedback = document.createElement("p");
      planFeedback.className = "quota-plan-feedback";
      planFeedback.dataset["quotaPlanFeedback"] = family;
      planFeedback.setAttribute("role", "status");
      planFeedback.setAttribute("aria-live", "polite");
      planFeedback.setAttribute("aria-atomic", "true");
      planFeedback.hidden = true;
      row.append(planFeedback);

      const view = quotaRowView(entry);
      if (view.configured) {
        const status = document.createElement("p");
        status.className = "quota-status";
        status.textContent = view.statusText;
        const track = document.createElement("div");
        track.className = "quota-track";
        track.setAttribute("role", "progressbar");
        track.setAttribute(
          "aria-label",
          localizeUiText(`${FAMILY_LABELS[family]} 剩餘估算`),
        );
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
    }),
  );
}

export function createQuotaPanel(options: QuotaPanelOptions): Readonly<{
  refresh(): Promise<void>;
}> {
  let currentRequest = 0;
  let currentController: AbortController | undefined;
  let mutationPending = false;
  let lastSnapshot: QuotaSnapshot | undefined;
  let refreshNotice: HTMLElement | undefined;
  let planFeedback: QuotaPlanFeedback | undefined;
  let planFeedbackRevision = 0;
  let planFeedbackTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const applyPlanFeedback = (): void => {
    const feedback = planFeedback;
    for (const element of options.root.querySelectorAll<HTMLElement>(
      "[data-quota-plan-feedback]",
    )) {
      const active =
        feedback !== undefined &&
        element.dataset["quotaPlanFeedback"] === feedback.family;
      element.hidden = !active;
      element.textContent = active
        ? localizeUiText(QUOTA_PLAN_FEEDBACK_TEXT[feedback.state])
        : "";
      if (active) element.dataset["feedbackState"] = feedback.state;
      else delete element.dataset["feedbackState"];
    }
  };
  const setPlanFeedback = (next: QuotaPlanFeedback): void => {
    planFeedbackRevision += 1;
    const revision = planFeedbackRevision;
    if (planFeedbackTimer !== undefined) {
      globalThis.clearTimeout(planFeedbackTimer);
      planFeedbackTimer = undefined;
    }
    planFeedback = next;
    applyPlanFeedback();
    if (next.state !== "saved") return;
    planFeedbackTimer = globalThis.setTimeout(() => {
      if (revision !== planFeedbackRevision) return;
      planFeedbackTimer = undefined;
      planFeedback = undefined;
      applyPlanFeedback();
    }, QUOTA_PLAN_SAVED_FEEDBACK_MS);
  };
  const render = (snapshot: QuotaSnapshot): void => {
    renderQuotaSnapshot(options.root, snapshot);
    lastSnapshot = snapshot;
    refreshNotice = undefined;
    delete options.root.dataset["refreshState"];
    applyPlanFeedback();
  };
  const showStaleRefreshNotice = (): void => {
    options.root.dataset["refreshState"] = "stale";
    if (refreshNotice !== undefined) return;
    refreshNotice = document.createElement("p");
    refreshNotice.className = "quota-refresh-notice";
    refreshNotice.setAttribute("role", "status");
    refreshNotice.setAttribute("aria-live", "polite");
    refreshNotice.textContent = localizeUiText(
      "暫時未更新，顯示上次成功的額度估算。",
    );
    options.root.append(refreshNotice);
  };
  const refresh = async (): Promise<void> => {
    // A plan mutation returns an authoritative snapshot and is followed by a
    // fresh read. Do not replace its disabled controls with an interactive
    // stale snapshot while the write is still in flight.
    if (mutationPending) return;
    const request = ++currentRequest;
    currentController?.abort();
    const controller = new AbortController();
    currentController = controller;
    try {
      const snapshot = await options.load(controller.signal);
      if (request === currentRequest) render(snapshot);
    } catch {
      if (request === currentRequest && lastSnapshot === undefined) {
        options.root.textContent = localizeUiText(
          "剩餘額度估算暫時載入不了。",
        );
      } else if (request === currentRequest) {
        showStaleRefreshNotice();
      }
    } finally {
      if (currentController === controller) currentController = undefined;
    }
  };
  options.root.addEventListener("change", (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement)) return;
    const family = select.dataset["quotaPlan"];
    if (!QUOTA_FAMILIES.some((candidate) => candidate === family)) return;
    if (mutationPending) return;
    const quotaFamily = family as QuotaFamily;
    const planId = select.value === "" ? null : select.value;
    mutationPending = true;
    ++currentRequest;
    currentController?.abort();
    currentController = undefined;
    for (const control of options.root.querySelectorAll<HTMLSelectElement>(
      "select[data-quota-plan]",
    )) {
      control.disabled = true;
    }
    setPlanFeedback({ family: quotaFamily, state: "saving" });
    void options
      .update(quotaFamily, planId)
      .then((snapshot) => {
        render(snapshot);
        setPlanFeedback({ family: quotaFamily, state: "saved" });
      })
      .catch(() => {
        if (lastSnapshot !== undefined) render(lastSnapshot);
        setPlanFeedback({ family: quotaFamily, state: "error" });
      })
      .finally(() => {
        mutationPending = false;
        void refresh();
      });
  });
  return Object.freeze({ refresh });
}
