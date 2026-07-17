import type { QuotaPlan, QuotaWindow } from "./quota-catalog.js";

const HOUR_MS = 3_600_000;

export function quotaWindowStart(now: Date, window: QuotaWindow): Date {
  if (window.kind === "rolling") {
    return new Date(now.getTime() - window.hours * HOUR_MS);
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// TokenTracker exposes daily family buckets only. Until a finer local route is
// available, rolling plans are compared against a linearly day-scaled budget;
// no hourly usage is inferred or fabricated.
export function dailyEquivalentBudget(plan: QuotaPlan): number {
  return Math.round(plan.budgetTokens * (24 / plan.window.hours));
}

export function remainingQuotaPercent(
  usedTokens: number,
  budgetTokens: number
): number {
  if (usedTokens >= budgetTokens) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - usedTokens / budgetTokens) * 100)));
}
