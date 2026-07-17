import type { TokenMonsterUsageFamily } from "@tokenmonster/token-tracker-adapter";

export type QuotaCatalogFamily = Extract<
  TokenMonsterUsageFamily,
  "anthropic" | "openai" | "google" | "xai"
>;

export interface QuotaWindow {
  readonly kind: "rolling" | "utc-day";
  readonly hours: number;
}

export interface QuotaPlan {
  readonly planId: string;
  readonly family: QuotaCatalogFamily;
  readonly labelZh: string;
  readonly window: QuotaWindow;
  readonly budgetTokens: number;
}

export const QUOTA_CATALOG_FAMILIES = Object.freeze([
  "anthropic",
  "openai",
  "google",
  "xai"
] as const satisfies readonly QuotaCatalogFamily[]);

export const QUOTA_PLAN_CATALOG = Object.freeze([
  // Community estimate only; this is not an Anthropic contractual allowance.
  Object.freeze({
    planId: "claude-pro",
    family: "anthropic",
    labelZh: "Claude Pro",
    window: Object.freeze({ kind: "rolling", hours: 5 }),
    budgetTokens: 1_000_000
  }),
  // Community estimate only; this is not an Anthropic contractual allowance.
  Object.freeze({
    planId: "claude-max-5x",
    family: "anthropic",
    labelZh: "Claude Max 5x",
    window: Object.freeze({ kind: "rolling", hours: 5 }),
    budgetTokens: 5_000_000
  }),
  // Community estimate only; this is not an Anthropic contractual allowance.
  Object.freeze({
    planId: "claude-max-20x",
    family: "anthropic",
    labelZh: "Claude Max 20x",
    window: Object.freeze({ kind: "rolling", hours: 5 }),
    budgetTokens: 20_000_000
  }),
  // Community estimate only; this is not an OpenAI contractual allowance.
  Object.freeze({
    planId: "chatgpt-plus",
    family: "openai",
    labelZh: "ChatGPT Plus",
    window: Object.freeze({ kind: "rolling", hours: 5 }),
    budgetTokens: 400_000
  }),
  // Community estimate only; this is not an OpenAI contractual allowance.
  Object.freeze({
    planId: "chatgpt-pro",
    family: "openai",
    labelZh: "ChatGPT Pro",
    window: Object.freeze({ kind: "rolling", hours: 5 }),
    budgetTokens: 4_000_000
  }),
  // Community estimate only; this is not a Google contractual allowance.
  Object.freeze({
    planId: "gemini-free",
    family: "google",
    labelZh: "Gemini 免費版",
    window: Object.freeze({ kind: "utc-day", hours: 24 }),
    budgetTokens: 100_000
  }),
  // Community estimate only; this is not a Google contractual allowance.
  Object.freeze({
    planId: "gemini-ai-pro",
    family: "google",
    labelZh: "Google AI Pro",
    window: Object.freeze({ kind: "utc-day", hours: 24 }),
    budgetTokens: 1_000_000
  }),
  // Community estimate only; this is not an xAI contractual allowance.
  Object.freeze({
    planId: "supergrok",
    family: "xai",
    labelZh: "SuperGrok",
    window: Object.freeze({ kind: "rolling", hours: 2 }),
    budgetTokens: 500_000
  })
] as const satisfies readonly QuotaPlan[]);

export function plansForFamily(
  family: QuotaCatalogFamily
): readonly QuotaPlan[] {
  return QUOTA_PLAN_CATALOG.filter((plan) => plan.family === family);
}

export function findQuotaPlan(
  family: QuotaCatalogFamily,
  planId: string
): QuotaPlan | undefined {
  return QUOTA_PLAN_CATALOG.find(
    (plan) => plan.family === family && plan.planId === planId
  );
}

export function isQuotaCatalogFamily(
  value: unknown
): value is QuotaCatalogFamily {
  return QUOTA_CATALOG_FAMILIES.some((family) => family === value);
}
