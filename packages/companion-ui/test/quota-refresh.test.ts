import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyHealthyUsageSnapshot,
  createQuotaPanel,
  parseQuotaSnapshot,
  type CompanionHealthySnapshot,
  type QuotaSnapshot,
} from "../src/public/app.js";

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  className = "";
  disabled = false;
  hidden = false;
  textContent: string | null = "";
  value = "";
  private readonly listeners = new Map<
    string,
    (event: { target: unknown }) => void
  >();

  constructor(readonly tagName: string) {}

  addEventListener(
    name: string,
    listener: (event: { target: unknown }) => void,
  ): void {
    this.listeners.set(name, listener);
  }

  dispatch(name: string, target: unknown): void {
    this.listeners.get(name)?.({ target });
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matchesSelector = (element: FakeElement): boolean => {
      if (selector === "select[data-quota-plan]") {
        return (
          element.tagName === "select" &&
          element.dataset["quotaPlan"] !== undefined
        );
      }
      if (selector === "[data-quota-plan-feedback]") {
        return element.dataset["quotaPlanFeedback"] !== undefined;
      }
      return false;
    };
    const matches: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      if (matchesSelector(element)) matches.push(element);
      for (const child of element.children) visit(child);
    };
    visit(this);
    return matches;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeOption extends FakeElement {
  constructor(text = "", value = "") {
    super("option");
    this.textContent = text;
    this.value = value;
  }
}

class FakeSelect extends FakeElement {
  constructor() {
    super("select");
  }
}

function quotaResponse(
  openAiUsedTokens: number,
  openAiPlanId: "chatgpt-plus" | "chatgpt-pro" = "chatgpt-plus",
): unknown {
  return {
    status: "ok",
    generatedAt: "2026-07-17T12:00:00.000Z",
    families: [
      {
        family: "anthropic",
        planId: null,
        windowHours: 24,
        windowKind: "utc-day",
        usedTokens: 10,
        budgetTokens: null,
        estimate: true,
      },
      {
        family: "openai",
        planId: openAiPlanId,
        windowHours: 24,
        windowKind: "utc-day",
        usedTokens: openAiUsedTokens,
        budgetTokens:
          openAiPlanId === "chatgpt-plus" ? 1_920_000 : 19_200_000,
        estimate: true,
      },
      {
        family: "google",
        planId: null,
        windowHours: 24,
        windowKind: "utc-day",
        usedTokens: 0,
        budgetTokens: null,
        estimate: true,
      },
      {
        family: "xai",
        planId: null,
        windowHours: 24,
        windowKind: "utc-day",
        usedTokens: 0,
        budgetTokens: null,
        estimate: true,
      },
    ],
  };
}

function findByClass(
  root: FakeElement,
  className: string,
): FakeElement | undefined {
  if (root.className === className) return root;
  for (const child of root.children) {
    const match = findByClass(child, className);
    if (match !== undefined) return match;
  }
  return undefined;
}

function openAiRow(root: FakeElement): FakeElement {
  const row = root.children.find(
    (candidate) => candidate.dataset["quotaFamily"] === "openai",
  );
  if (row === undefined) throw new Error("OpenAI quota row was not rendered");
  return row;
}

function openAiSelect(root: FakeElement): FakeSelect {
  return openAiRow(root).children[0]?.children[1] as FakeSelect;
}

function openAiPlanFeedback(root: FakeElement): FakeElement {
  const feedback = findByClass(openAiRow(root), "quota-plan-feedback");
  if (feedback === undefined) {
    throw new Error("OpenAI quota plan feedback was not rendered");
  }
  return feedback;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function installFakeDom(): FakeElement {
  vi.stubGlobal("document", {
    createElement: (tagName: string) =>
      tagName === "select" ? new FakeSelect() : new FakeElement(tagName),
  });
  vi.stubGlobal("Option", FakeOption);
  vi.stubGlobal("HTMLSelectElement", FakeSelect);
  return new FakeElement("div");
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({
    promise,
    resolve: (value: T) => resolvePromise!(value),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("quota refresh after usage updates", () => {
  it("refreshes dependent panels only after a healthy snapshot renders", () => {
    const snapshot: CompanionHealthySnapshot = {
      status: "healthy",
      generatedAt: "2026-07-17T12:00:00.000Z",
      starter: {
        outcome: "user-choice-required",
        reason: "no-positive-provider-data",
        tiedProviderFamilies: [],
      },
      totals: { today: 1, last7Days: 2, last28Days: 3 },
      daily: [],
    };
    const events: string[] = [];
    applyHealthyUsageSnapshot(snapshot, {
      render: (value) => events.push(`render:${value.totals.today}`),
      refreshAnalytics: () => {
        events.push("analytics");
      },
      refreshQuota: () => {
        events.push("quota");
      },
    });

    expect(events).toEqual(["render:1", "analytics", "quota"]);

    const refreshQuota = vi.fn();
    expect(() =>
      applyHealthyUsageSnapshot(snapshot, {
        render: () => {
          throw new Error("render failed");
        },
        refreshAnalytics: vi.fn(),
        refreshQuota,
      }),
    ).toThrow("render failed");
    expect(refreshQuota).not.toHaveBeenCalled();
  });

  it("re-renders the remaining percentage when refreshed totals change", async () => {
    const snapshots: QuotaSnapshot[] = [
      parseQuotaSnapshot(quotaResponse(729_600)),
      parseQuotaSnapshot(quotaResponse(960_000)),
    ];
    const root = installFakeDom();
    const panel = createQuotaPanel({
      root: root as unknown as HTMLElement,
      load: async () => snapshots.shift()!,
      update: async () => {
        throw new Error("Plan updates are outside this test");
      },
    });

    await panel.refresh();
    const firstRow = openAiRow(root);
    expect(findByClass(firstRow, "quota-status")?.textContent).toBe(
      "約剩 62%・視窗 24 小時",
    );
    expect(
      findByClass(firstRow, "quota-track")?.attributes.get("aria-valuenow"),
    ).toBe("62");

    await panel.refresh();
    const refreshedRow = openAiRow(root);
    expect(findByClass(refreshedRow, "quota-status")?.textContent).toBe(
      "約剩 50%・視窗 24 小時",
    );
    expect(
      findByClass(refreshedRow, "quota-track")?.attributes.get("aria-valuenow"),
    ).toBe("50");
  });

  it("does not let a slower old refresh overwrite a newer percentage", async () => {
    const olderSnapshot = deferred<QuotaSnapshot>();
    const newerSnapshot = parseQuotaSnapshot(quotaResponse(960_000));
    const root = installFakeDom();
    const signals: AbortSignal[] = [];
    let loadCount = 0;
    const panel = createQuotaPanel({
      root: root as unknown as HTMLElement,
      load: (signal) => {
        signals.push(signal);
        loadCount += 1;
        return loadCount === 1
          ? olderSnapshot.promise
          : Promise.resolve(newerSnapshot);
      },
      update: async () => {
        throw new Error("Plan updates are outside this test");
      },
    });

    const olderRefresh = panel.refresh();
    await panel.refresh();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(findByClass(openAiRow(root), "quota-status")?.textContent).toBe(
      "約剩 50%・視窗 24 小時",
    );

    olderSnapshot.resolve(parseQuotaSnapshot(quotaResponse(729_600)));
    await olderRefresh;
    expect(findByClass(openAiRow(root), "quota-status")?.textContent).toBe(
      "約剩 50%・視窗 24 小時",
    );
  });

  it("keeps the last good quota panel on a transient background failure", async () => {
    const initialSnapshot = parseQuotaSnapshot(quotaResponse(729_600));
    const recoveredSnapshot = parseQuotaSnapshot(quotaResponse(960_000));
    let loadCount = 0;
    const root = installFakeDom();
    const panel = createQuotaPanel({
      root: root as unknown as HTMLElement,
      load: async () => {
        loadCount += 1;
        if (loadCount === 1) return initialSnapshot;
        if (loadCount === 2) throw new Error("transient failure");
        return recoveredSnapshot;
      },
      update: async () => {
        throw new Error("Plan updates are outside this test");
      },
    });

    await panel.refresh();
    await panel.refresh();
    expect(findByClass(openAiRow(root), "quota-status")?.textContent).toBe(
      "約剩 62%・視窗 24 小時",
    );
    expect(findByClass(root, "quota-refresh-notice")).toMatchObject({
      textContent: "暫時未更新，顯示上次成功的額度估算。",
    });
    expect(root.dataset["refreshState"]).toBe("stale");

    await panel.refresh();
    expect(findByClass(openAiRow(root), "quota-status")?.textContent).toBe(
      "約剩 50%・視窗 24 小時",
    );
    expect(findByClass(root, "quota-refresh-notice")).toBeUndefined();
    expect(root.dataset["refreshState"]).toBeUndefined();
  });

  it("announces a row-level save and keeps success visible through its confirming refresh", async () => {
    vi.useFakeTimers();
    const initialSnapshot = parseQuotaSnapshot(quotaResponse(729_600));
    const updatedSnapshot = parseQuotaSnapshot(
      quotaResponse(960_000, "chatgpt-pro"),
    );
    const planUpdate = deferred<QuotaSnapshot>();
    const confirmingRefresh = deferred<QuotaSnapshot>();
    let loadCount = 0;
    const root = installFakeDom();
    const panel = createQuotaPanel({
      root: root as unknown as HTMLElement,
      load: () => {
        loadCount += 1;
        return loadCount === 1
          ? Promise.resolve(initialSnapshot)
          : confirmingRefresh.promise;
      },
      update: () => planUpdate.promise,
    });

    await panel.refresh();
    const select = openAiSelect(root);
    select.value = "chatgpt-pro";
    root.dispatch("change", select);

    const saving = openAiPlanFeedback(root);
    expect(saving.hidden).toBe(false);
    expect(saving.textContent).toBe("正在儲存…");
    expect(saving.dataset["feedbackState"]).toBe("saving");
    expect(saving.attributes.get("role")).toBe("status");
    expect(saving.attributes.get("aria-live")).toBe("polite");
    expect(saving.attributes.get("aria-atomic")).toBe("true");

    planUpdate.resolve(updatedSnapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadCount).toBe(2);
    expect(openAiSelect(root).value).toBe("chatgpt-pro");
    expect(openAiPlanFeedback(root)).toMatchObject({
      hidden: false,
      textContent: "方案已更新。",
    });
    expect(openAiPlanFeedback(root).dataset["feedbackState"]).toBe("saved");

    confirmingRefresh.resolve(updatedSnapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(openAiPlanFeedback(root).textContent).toBe("方案已更新。");

    await vi.advanceTimersByTimeAsync(2_999);
    expect(openAiPlanFeedback(root).hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(openAiPlanFeedback(root)).toMatchObject({
      hidden: true,
      textContent: "",
    });
  });

  it("restores the saved plan and keeps row-level failure visible across background refreshes", async () => {
    const initialSnapshot = parseQuotaSnapshot(quotaResponse(729_600));
    const refreshedSnapshot = parseQuotaSnapshot(quotaResponse(960_000));
    let loadCount = 0;
    const root = installFakeDom();
    const panel = createQuotaPanel({
      root: root as unknown as HTMLElement,
      load: async () => {
        loadCount += 1;
        return loadCount === 1 ? initialSnapshot : refreshedSnapshot;
      },
      update: async () => {
        throw new Error("local plan save failed");
      },
    });

    await panel.refresh();
    const select = openAiSelect(root);
    select.value = "chatgpt-pro";
    root.dispatch("change", select);
    expect(openAiPlanFeedback(root).textContent).toBe("正在儲存…");

    await flushMicrotasks();
    expect(loadCount).toBe(2);
    expect(openAiSelect(root).value).toBe("chatgpt-plus");
    expect(findByClass(openAiRow(root), "quota-status")?.textContent).toBe(
      "約剩 50%・視窗 24 小時",
    );
    expect(openAiPlanFeedback(root)).toMatchObject({
      hidden: false,
      textContent: "方案未更新，請再試一次。",
    });
    expect(openAiPlanFeedback(root).dataset["feedbackState"]).toBe("error");

    await panel.refresh();
    expect(openAiPlanFeedback(root).textContent).toBe(
      "方案未更新，請再試一次。",
    );
  });

  it("keeps background refreshes and a second change out of an in-flight plan update", async () => {
    vi.useFakeTimers();
    const staleRefresh = deferred<QuotaSnapshot>();
    const planUpdate = deferred<QuotaSnapshot>();
    const initialSnapshot = parseQuotaSnapshot(quotaResponse(729_600));
    const updatedSnapshot = parseQuotaSnapshot(quotaResponse(960_000));
    const signals: AbortSignal[] = [];
    const update = vi.fn(() => planUpdate.promise);
    let loadCount = 0;
    const root = installFakeDom();
    const panel = createQuotaPanel({
      root: root as unknown as HTMLElement,
      load: (signal) => {
        signals.push(signal);
        loadCount += 1;
        if (loadCount === 1) return Promise.resolve(initialSnapshot);
        if (loadCount === 2) return staleRefresh.promise;
        return Promise.resolve(updatedSnapshot);
      },
      update,
    });

    await panel.refresh();
    const staleRequest = panel.refresh();
    const select = openAiRow(root).children[0]?.children[1] as FakeSelect;
    select.value = "chatgpt-pro";
    root.dispatch("change", select);

    expect(select.disabled).toBe(true);
    const googleSelect = root.children[2]?.children[0]?.children[1];
    expect(googleSelect?.disabled).toBe(true);
    expect(signals[1]?.aborted).toBe(true);
    expect(openAiPlanFeedback(root).textContent).toBe("正在儲存…");
    await panel.refresh();
    expect(loadCount).toBe(2);

    googleSelect!.value = "gemini-advanced";
    root.dispatch("change", googleSelect);
    expect(update).toHaveBeenCalledTimes(1);

    staleRefresh.resolve(parseQuotaSnapshot(quotaResponse(100_000)));
    await staleRequest;
    expect(openAiPlanFeedback(root).textContent).toBe("正在儲存…");
    expect(findByClass(openAiRow(root), "quota-status")?.textContent).toBe(
      "約剩 62%・視窗 24 小時",
    );

    planUpdate.resolve(updatedSnapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadCount).toBe(3);
    expect(openAiPlanFeedback(root).textContent).toBe("方案已更新。");
    expect(findByClass(openAiRow(root), "quota-status")?.textContent).toBe(
      "約剩 50%・視窗 24 小時",
    );
  });
});
