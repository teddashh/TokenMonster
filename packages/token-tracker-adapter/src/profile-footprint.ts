import {
  DailyContentBlindFootprintV1Schema,
  type DailyContentBlindFootprintV1,
  type DailyDimensionAggregateV1,
  type MonsterCharacterIdV1,
  type MonsterModelFamilyV1,
  type MonsterProviderV1,
  type MonsterTokenCountsV1,
  type MonsterToolV1
} from "@tokenmonster/monster-engine";

import { TokenTrackerAdapterError } from "./errors.js";
import type {
  UpstreamPersonalDailyResponse,
  UpstreamPersonalModelBreakdownResponse
} from "./schemas.js";

const RECONCILED_TOKEN_FIELDS = [
  "total_tokens",
  "billable_total_tokens",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "reasoning_output_tokens"
] as const;

type ReconciledTokenField = (typeof RECONCILED_TOKEN_FIELDS)[number];
type ReconciledTokenTotals = Record<ReconciledTokenField, number>;

interface CanonicalTokenTotals extends ReconciledTokenTotals {
  other_tokens: number;
}

interface NormalizedDimension {
  readonly provider: MonsterProviderV1;
  readonly modelFamily: MonsterModelFamilyV1;
  readonly tool: MonsterToolV1;
}

// These source IDs are collector/tool attestations only. In 0.80.0 a tool can
// call a custom provider without changing its source bucket, so provider and
// model family must remain unavailable (`other`) for profile derivation.
const NORMALIZED_SOURCE_DIMENSIONS = Object.freeze({
  codex: Object.freeze({
    provider: "other",
    modelFamily: "other",
    tool: "codex-cli"
  }),
  claude: Object.freeze({
    provider: "other",
    modelFamily: "other",
    tool: "claude-code"
  }),
  gemini: Object.freeze({
    provider: "other",
    modelFamily: "other",
    tool: "gemini-cli"
  }),
  grok: Object.freeze({
    provider: "other",
    modelFamily: "other",
    tool: "grok-build"
  })
} as const satisfies Readonly<Record<string, NormalizedDimension>>);

const OTHER_DIMENSION = Object.freeze({
  provider: "other",
  modelFamily: "other",
  tool: "other"
} as const satisfies NormalizedDimension);

const DIMENSION_ORDER = Object.freeze([
  "other|other|codex-cli",
  "other|other|claude-code",
  "other|other|gemini-cli",
  "other|other|grok-build",
  "other|other|other"
]);

function incompatible(): never {
  throw new TokenTrackerAdapterError("incompatible-schema");
}

function emptyTotals(): ReconciledTokenTotals {
  return {
    total_tokens: 0,
    billable_total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0
  };
}

function emptyCanonicalTotals(): CanonicalTokenTotals {
  return { ...emptyTotals(), other_tokens: 0 };
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) incompatible();
  return result;
}

function addTotals(
  target: ReconciledTokenTotals,
  source: Readonly<Record<ReconciledTokenField, number>>
): void {
  for (const field of RECONCILED_TOKEN_FIELDS) {
    target[field] = checkedAdd(target[field], source[field]);
  }
}

function addCanonicalTotals(
  target: CanonicalTokenTotals,
  source: Readonly<CanonicalTokenTotals>
): void {
  addTotals(target, source);
  target.other_tokens = checkedAdd(target.other_tokens, source.other_tokens);
}

function assertCanonicalConservation(
  totals: Readonly<CanonicalTokenTotals>
): void {
  const componentTotal = checkedAdd(
    checkedAdd(
      checkedAdd(totals.input_tokens, totals.output_tokens),
      checkedAdd(
        totals.cached_input_tokens,
        totals.cache_creation_input_tokens
      )
    ),
    totals.other_tokens
  );
  if (
    totals.total_tokens !== componentTotal ||
    totals.reasoning_output_tokens > totals.output_tokens
  ) {
    incompatible();
  }
}

function canonicalizeModelTotals(
  source: string,
  raw: Readonly<Record<ReconciledTokenField, number>>
): CanonicalTokenTotals {
  if (!Object.hasOwn(NORMALIZED_SOURCE_DIMENSIONS, source)) {
    const componentFloor = checkedAdd(
      checkedAdd(raw.input_tokens, raw.output_tokens),
      checkedAdd(raw.cached_input_tokens, raw.cache_creation_input_tokens)
    );
    if (
      raw.total_tokens < componentFloor ||
      raw.reasoning_output_tokens > raw.total_tokens
    ) {
      incompatible();
    }
    return {
      ...emptyTotals(),
      billable_total_tokens: raw.billable_total_tokens,
      total_tokens: raw.total_tokens,
      other_tokens: raw.total_tokens
    };
  }

  const baseTotal = checkedAdd(
    checkedAdd(raw.input_tokens, raw.output_tokens),
    checkedAdd(raw.cached_input_tokens, raw.cache_creation_input_tokens)
  );
  let canonicalOutput = raw.output_tokens;
  let unclassifiedRemainder = 0;

  // The exact pin has two incompatible reasoning conventions. Gemini records
  // thoughts additively and keeps max(reported, computed), while Codex reports
  // reasoning as an output subset; Claude/Grok emit no reasoning. Decide at
  // the model row before source aggregation so a mixed day remains provable.
  if (source === "gemini") {
    const geminiComputedTotal = checkedAdd(
      baseTotal,
      raw.reasoning_output_tokens
    );
    if (raw.total_tokens < geminiComputedTotal) incompatible();
    canonicalOutput = checkedAdd(
      raw.output_tokens,
      raw.reasoning_output_tokens
    );
    unclassifiedRemainder = raw.total_tokens - geminiComputedTotal;
  } else {
    if (
      raw.total_tokens !== baseTotal ||
      raw.reasoning_output_tokens > raw.output_tokens ||
      ((source === "claude" || source === "grok") &&
        raw.reasoning_output_tokens !== 0)
    ) {
      incompatible();
    }
  }

  // 0.80.0 has no cache-coverage bit. Preserve any reported cache-read tokens
  // as unclassified total instead of upgrading an ambiguous zero to observed
  // cache coverage (notably Grok's fixed-ratio estimator).
  const canonical: CanonicalTokenTotals = {
    total_tokens: raw.total_tokens,
    billable_total_tokens: raw.billable_total_tokens,
    input_tokens: raw.input_tokens,
    output_tokens: canonicalOutput,
    cached_input_tokens: 0,
    cache_creation_input_tokens: raw.cache_creation_input_tokens,
    reasoning_output_tokens: raw.reasoning_output_tokens,
    other_tokens: checkedAdd(
      raw.cached_input_tokens,
      unclassifiedRemainder
    )
  };
  assertCanonicalConservation(canonical);
  return canonical;
}

function assertEqualTotals(
  left: Readonly<Record<ReconciledTokenField, number>>,
  right: Readonly<Record<ReconciledTokenField, number>>
): void {
  if (RECONCILED_TOKEN_FIELDS.some((field) => left[field] !== right[field])) {
    incompatible();
  }
}

function assertDailyRows(response: UpstreamPersonalDailyResponse): void {
  let previousDate = "";
  for (const row of response.data) {
    if (
      row.day < response.from ||
      row.day > response.to ||
      (previousDate !== "" && row.day <= previousDate)
    ) {
      incompatible();
    }
    previousDate = row.day;
    if (
      row.total_tokens === 0 &&
      (RECONCILED_TOKEN_FIELDS.some((field) => row[field] !== 0) ||
        Object.values(row.models ?? {}).some((total) => total !== 0))
    ) {
      incompatible();
    }
  }
}

export function personalActiveUtcDates(
  response: UpstreamPersonalDailyResponse
): readonly string[] {
  assertDailyRows(response);
  return Object.freeze(
    response.data
      .filter((row) => row.total_tokens > 0)
      .map((row) => row.day)
  );
}

function normalizedDimension(source: string): NormalizedDimension {
  if (Object.hasOwn(NORMALIZED_SOURCE_DIMENSIONS, source)) {
    return NORMALIZED_SOURCE_DIMENSIONS[
      source as keyof typeof NORMALIZED_SOURCE_DIMENSIONS
    ];
  }
  return OTHER_DIMENSION;
}

function dimensionKey(dimension: NormalizedDimension): string {
  return [dimension.provider, dimension.modelFamily, dimension.tool].join("|");
}

function assertDailyModelTotals(
  dailyModels: Readonly<Record<string, number>> | undefined,
  breakdownModels: ReadonlyMap<string, number>
): void {
  if (
    dailyModels === undefined ||
    Object.keys(dailyModels).length !== breakdownModels.size
  ) {
    incompatible();
  }
  for (const [model, total] of Object.entries(dailyModels)) {
    if (breakdownModels.get(model) !== total) incompatible();
  }
}

function reconcileActiveDay(
  daily: UpstreamPersonalDailyResponse["data"][number],
  breakdown: UpstreamPersonalModelBreakdownResponse
): readonly DailyDimensionAggregateV1[] {
  if (
    breakdown.from !== daily.day ||
    breakdown.to !== daily.day ||
    breakdown.sources.length === 0
  ) {
    incompatible();
  }

  const seenSources = new Set<string>();
  const sourceGrandTotal = emptyTotals();
  const canonicalGrandTotal = emptyCanonicalTotals();
  const modelsByName = new Map<string, number>();
  const totalsByDimension = new Map<string, CanonicalTokenTotals>();
  const dimensionsByKey = new Map<string, NormalizedDimension>();

  for (const source of breakdown.sources) {
    if (seenSources.has(source.source)) incompatible();
    seenSources.add(source.source);

    const modelTotal = emptyTotals();
    const canonicalSourceTotal = emptyCanonicalTotals();
    const seenModels = new Set<string>();
    for (const model of source.models) {
      if (seenModels.has(model.model)) incompatible();
      seenModels.add(model.model);
      addTotals(modelTotal, model.totals);
      addCanonicalTotals(
        canonicalSourceTotal,
        canonicalizeModelTotals(source.source, model.totals)
      );
      modelsByName.set(
        model.model,
        checkedAdd(
          modelsByName.get(model.model) ?? 0,
          model.totals.total_tokens
        )
      );
    }
    assertEqualTotals(modelTotal, source.totals);
    if (
      canonicalSourceTotal.total_tokens !== source.totals.total_tokens ||
      canonicalSourceTotal.billable_total_tokens !==
        source.totals.billable_total_tokens
    ) {
      incompatible();
    }
    assertCanonicalConservation(canonicalSourceTotal);
    addTotals(sourceGrandTotal, source.totals);
    addCanonicalTotals(canonicalGrandTotal, canonicalSourceTotal);

    const dimension = normalizedDimension(source.source);
    const key = dimensionKey(dimension);
    const dimensionTotals =
      totalsByDimension.get(key) ?? emptyCanonicalTotals();
    addCanonicalTotals(dimensionTotals, canonicalSourceTotal);
    totalsByDimension.set(key, dimensionTotals);
    dimensionsByKey.set(key, dimension);
  }

  assertEqualTotals(sourceGrandTotal, daily);
  if (
    canonicalGrandTotal.total_tokens !== daily.total_tokens ||
    canonicalGrandTotal.billable_total_tokens !== daily.billable_total_tokens
  ) {
    incompatible();
  }
  assertCanonicalConservation(canonicalGrandTotal);
  assertDailyModelTotals(daily.models, modelsByName);

  return Object.freeze(
    DIMENSION_ORDER.flatMap((key) => {
      const totals = totalsByDimension.get(key);
      const dimension = dimensionsByKey.get(key);
      if (
        totals === undefined ||
        dimension === undefined ||
        totals.total_tokens === 0
      ) {
        return [];
      }
      const tokens: MonsterTokenCountsV1 = Object.freeze({
        input: String(totals.input_tokens),
        output: String(totals.output_tokens),
        cacheRead: String(totals.cached_input_tokens),
        cacheWrite: String(totals.cache_creation_input_tokens),
        reasoning: String(totals.reasoning_output_tokens),
        other: String(totals.other_tokens),
        total: String(totals.total_tokens)
      });
      return [
        Object.freeze({
          ...dimension,
          valueQuality: "estimated",
          cacheReadAvailability: "unavailable",
          tokens
        } as const satisfies DailyDimensionAggregateV1)
      ];
    })
  );
}

function eachUtcDate(fromUtcDate: string, toUtcDate: string): readonly string[] {
  const from = Date.parse(`${fromUtcDate}T00:00:00.000Z`);
  const to = Date.parse(`${toUtcDate}T00:00:00.000Z`);
  const dates: string[] = [];
  for (let timestamp = from; timestamp <= to; timestamp += 86_400_000) {
    dates.push(new Date(timestamp).toISOString().slice(0, 10));
  }
  return dates;
}

function freezeFootprint(
  footprint: DailyContentBlindFootprintV1
): DailyContentBlindFootprintV1 {
  Object.freeze(footprint.window);
  for (const day of footprint.days) {
    for (const aggregate of day.aggregates) {
      Object.freeze(aggregate.tokens);
      Object.freeze(aggregate);
    }
    Object.freeze(day.aggregates);
    Object.freeze(day);
  }
  Object.freeze(footprint.days);
  return Object.freeze(footprint);
}

export function projectDailyContentBlindFootprint(
  characterId: MonsterCharacterIdV1,
  daily: UpstreamPersonalDailyResponse,
  breakdownByUtcDate: ReadonlyMap<
    string,
    UpstreamPersonalModelBreakdownResponse
  >
): DailyContentBlindFootprintV1 {
  assertDailyRows(daily);
  const dailyByDate = new Map(daily.data.map((row) => [row.day, row]));
  const days = eachUtcDate(daily.from, daily.to).map((utcDate) => {
    const row = dailyByDate.get(utcDate);
    if (row === undefined || row.total_tokens === 0) {
      return {
        localDate: utcDate,
        coverage: "unavailable",
        aggregates: []
      } as const;
    }
    const breakdown = breakdownByUtcDate.get(utcDate);
    if (breakdown === undefined) incompatible();
    return {
      localDate: utcDate,
      coverage: "observed",
      aggregates: reconcileActiveDay(row, breakdown)
    } as const;
  });
  if (breakdownByUtcDate.size !== personalActiveUtcDates(daily).length) {
    incompatible();
  }

  const parsed = DailyContentBlindFootprintV1Schema.safeParse({
    schemaVersion: "1",
    characterId,
    window: {
      from: daily.from,
      to: daily.to,
      timezone: "UTC"
    },
    days
  });
  if (!parsed.success) incompatible();
  return freezeFootprint(parsed.data);
}
