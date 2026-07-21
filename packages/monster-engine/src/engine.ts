import {
  ContentBlindFootprintV1Schema,
  DEFAULT_MONSTER_RULES_V1,
  MONSTER_CLI_TOOLS_V1,
  MONSTER_ENGINE_VERSION_V1,
  MonsterDerivationV1Schema,
  MonsterRulesV1Schema,
  MonsterStateV1Schema,
  type ContentBlindFootprintV1,
  type FootprintWindowV1,
  type MonsterCoverageBandV1,
  type MonsterDerivationV1,
  type MonsterExplanationInputV1,
  type MonsterExplanationStateValueV1,
  type MonsterExplanationV1,
  type MonsterMoodIdV1,
  type MonsterReasonCodeV1,
  type MonsterStateV1,
  type MonsterTemplateIdV1,
  type MonsterTraitIdV1,
  type MonsterValueBandV1,
} from "./schemas.js";

const BASIS_POINTS = 10_000n;

/** Rules are constants in v0.1. Any change requires an engine version bump. */
export const MONSTER_THRESHOLDS_V1 = Object.freeze({
  minimumObservedDays: 14,
  minimumActiveDays: 7,
  minimumHourlyObservedDays: 7,
  cliFocusedShareBps: 7_000,
  materialToolShareBps: 500,
  materialProviderShareBps: 1_000,
  providerFocusedShareBps: 8_500,
  cacheCoverageBps: 7_000,
  cacheSavvyShareBps: 3_000,
  outputHeavyShareBps: 4_500,
  nightOrientedShareBps: 4_000,
  quietRelativeActivityBps: 5_000,
  livelyRelativeActivityBps: 15_000,
  evidenceLossGraceDays: 7,
});

const CLI_TOOLS = new Set<string>(MONSTER_CLI_TOOLS_V1);
interface FootprintMetrics {
  readonly observedDays: number;
  readonly activeDays: number;
  readonly dailyTotals: readonly (bigint | null)[];
  readonly total: bigint;
  readonly cli: bigint;
  readonly byTool: ReadonlyMap<string, bigint>;
  readonly byProvider: ReadonlyMap<string, bigint>;
  readonly input: bigint;
  readonly output: bigint;
  readonly cacheRead: bigint;
  readonly cacheEligibleInput: bigint;
  readonly cacheEligibleRead: bigint;
  readonly cacheCoveredTotal: bigint;
  readonly hourlyObservedDays: number;
  readonly hourlyTimeIsExact: boolean;
  readonly hourlyTotal: bigint;
  readonly hourlyNight: bigint;
}

interface TraitSelection {
  readonly id: MonsterTraitIdV1;
  readonly reasonCode: MonsterReasonCodeV1;
  readonly templateId: MonsterTemplateIdV1;
  readonly inputs: readonly MonsterExplanationInputV1[];
}

interface OptionalTraitSelection extends TraitSelection {
  readonly marginBps: number;
  readonly priority: number;
}

function addToMap(map: Map<string, bigint>, key: string, value: bigint): void {
  map.set(key, (map.get(key) ?? 0n) + value);
}

function cappedRatioBps(
  numerator: bigint,
  denominator: bigint,
  cap = 10_000,
): number {
  if (denominator <= 0n || numerator <= 0n) {
    return 0;
  }
  const capBigInt = BigInt(cap);
  const rounded = (numerator * BASIS_POINTS + denominator / 2n) / denominator;
  return Number(rounded > capBigInt ? capBigInt : rounded);
}

function metricCoverageBand(
  observedDays: number,
  activeDays: number,
): MonsterCoverageBandV1 {
  if (
    observedDays < MONSTER_THRESHOLDS_V1.minimumObservedDays ||
    activeDays < MONSTER_THRESHOLDS_V1.minimumActiveDays
  ) {
    return "insufficient";
  }
  if (observedDays < 21 || activeDays < 14) {
    return "partial";
  }
  if (observedDays < 28) {
    return "good";
  }
  return "full";
}

function ratioCoverageBand(
  ratioBps: number,
  minimumBps: number,
): MonsterCoverageBandV1 {
  if (ratioBps < minimumBps) {
    return "insufficient";
  }
  if (ratioBps < 8_500) {
    return "partial";
  }
  if (ratioBps < 10_000) {
    return "good";
  }
  return "full";
}

function hourlyCoverageBand(observedDays: number): MonsterCoverageBandV1 {
  if (observedDays < MONSTER_THRESHOLDS_V1.minimumHourlyObservedDays) {
    return "insufficient";
  }
  if (observedDays < 14) {
    return "partial";
  }
  if (observedDays < 28) {
    return "good";
  }
  return "full";
}

function aggregateMetrics(
  footprint: ContentBlindFootprintV1,
): FootprintMetrics {
  const byTool = new Map<string, bigint>();
  const byProvider = new Map<string, bigint>();
  const dailyTotals: Array<bigint | null> = [];
  let observedDays = 0;
  let activeDays = 0;
  let total = 0n;
  let cli = 0n;
  let input = 0n;
  let output = 0n;
  let cacheRead = 0n;
  let cacheEligibleInput = 0n;
  let cacheEligibleRead = 0n;
  let cacheCoveredTotal = 0n;

  for (const day of footprint.days) {
    let dailyTotal = 0n;
    if (day.coverage === "observed") {
      observedDays += 1;
    }

    for (const aggregate of day.aggregates) {
      const aggregateTotal = BigInt(aggregate.tokens.total);
      dailyTotal += aggregateTotal;
      total += aggregateTotal;
      input += BigInt(aggregate.tokens.input);
      output += BigInt(aggregate.tokens.output);
      cacheRead += BigInt(aggregate.tokens.cacheRead);
      addToMap(byTool, aggregate.tool, aggregateTotal);
      addToMap(byProvider, aggregate.provider, aggregateTotal);
      if (CLI_TOOLS.has(aggregate.tool)) {
        cli += aggregateTotal;
      }
      if (aggregate.cacheReadAvailability === "observed") {
        cacheEligibleInput += BigInt(aggregate.tokens.input);
        cacheEligibleRead += BigInt(aggregate.tokens.cacheRead);
        cacheCoveredTotal += aggregateTotal;
      }
    }

    dailyTotals.push(day.coverage === "observed" ? dailyTotal : null);
    if (day.coverage === "observed" && dailyTotal > 0n) {
      activeDays += 1;
    }
  }

  let hourlyTotal = 0n;
  let hourlyNight = 0n;
  const hourlyObservedDays = footprint.localHourlyRhythm?.observedDays ?? 0;
  const hourlyTimeIsExact =
    footprint.localHourlyRhythm?.timeQuality === "exact-iana-local" &&
    footprint.localHourlyRhythm.dstQuality === "timezone-aware";
  for (const hour of footprint.localHourlyRhythm?.hours ?? []) {
    const hourTotal = BigInt(hour.tokens);
    hourlyTotal += hourTotal;
    if (hour.hour >= 22 || hour.hour < 6) {
      hourlyNight += hourTotal;
    }
  }

  return {
    observedDays,
    activeDays,
    dailyTotals,
    total,
    cli,
    byTool,
    byProvider,
    input,
    output,
    cacheRead,
    cacheEligibleInput,
    cacheEligibleRead,
    cacheCoveredTotal,
    hourlyObservedDays,
    hourlyTimeIsExact,
    hourlyTotal,
    hourlyNight,
  };
}

function countMaterialDimensions(
  dimensions: ReadonlyMap<string, bigint>,
  total: bigint,
  minimumShareBps: number,
): number {
  let count = 0;
  for (const value of dimensions.values()) {
    if (cappedRatioBps(value, total) >= minimumShareBps) {
      count += 1;
    }
  }
  return count;
}

function largestDimensionShareBps(
  dimensions: ReadonlyMap<string, bigint>,
  total: bigint,
): number {
  let largest = 0n;
  for (const value of dimensions.values()) {
    if (value > largest) {
      largest = value;
    }
  }
  return cappedRatioBps(largest, total);
}

function explanationInput(
  metric: MonsterExplanationInputV1["metric"],
  valueBand: MonsterValueBandV1,
  coverage: MonsterCoverageBandV1,
): MonsterExplanationInputV1 {
  return { metric, valueBand, coverage };
}

function selectTraits(
  metrics: FootprintMetrics,
  coverage: MonsterCoverageBandV1,
): readonly TraitSelection[] {
  const traits: TraitSelection[] = [];
  const cliShareBps = cappedRatioBps(metrics.cli, metrics.total);
  const toolCount = countMaterialDimensions(
    metrics.byTool,
    metrics.total,
    MONSTER_THRESHOLDS_V1.materialToolShareBps,
  );
  const materialCliToolCount = Array.from(metrics.byTool.entries()).filter(
    ([tool, value]) =>
      CLI_TOOLS.has(tool) &&
      cappedRatioBps(value, metrics.total) >=
        MONSTER_THRESHOLDS_V1.materialToolShareBps,
  ).length;
  const topToolShareBps = largestDimensionShareBps(
    metrics.byTool,
    metrics.total,
  );

  if (toolCoverageIsComplete(metrics)) {
    if (toolCount >= 2 && materialCliToolCount >= 2) {
      traits.push({
        id: "multi-tool",
        reasonCode: "TRAIT_MULTI_TOOL_28D",
        templateId: "monster.trait.multiTool.v1",
        inputs: [explanationInput("tool-diversity", "diverse", coverage)],
      });
    } else if (cliShareBps >= MONSTER_THRESHOLDS_V1.cliFocusedShareBps) {
      traits.push({
        id: "cli-focused",
        reasonCode: "TRAIT_CLI_FOCUS_28D",
        templateId: "monster.trait.cliFocused.v1",
        inputs: [explanationInput("cli-share", "high", coverage)],
      });
    } else if (toolCount >= 2) {
      traits.push({
        id: "multi-tool",
        reasonCode: "TRAIT_MULTI_TOOL_28D",
        templateId: "monster.trait.multiTool.v1",
        inputs: [explanationInput("tool-diversity", "diverse", coverage)],
      });
    } else {
      traits.push({
        id: "tool-focused",
        reasonCode: "TRAIT_TOOL_FOCUS_28D",
        templateId: "monster.trait.toolFocused.v1",
        inputs: [
          explanationInput(
            "top-tool-share",
            topToolShareBps >= 8_500 ? "high" : "concentrated",
            coverage,
          ),
        ],
      });
    }
  }

  if (providerCoverageIsComplete(metrics)) {
    const providerCount = countMaterialDimensions(
      metrics.byProvider,
      metrics.total,
      MONSTER_THRESHOLDS_V1.materialProviderShareBps,
    );
    const topProviderShareBps = largestDimensionShareBps(
      metrics.byProvider,
      metrics.total,
    );
    if (providerCount >= 2) {
      traits.push({
        id: "multi-provider",
        reasonCode: "TRAIT_MULTI_PROVIDER_28D",
        templateId: "monster.trait.multiProvider.v1",
        inputs: [explanationInput("provider-diversity", "diverse", coverage)],
      });
    } else if (
      topProviderShareBps >= MONSTER_THRESHOLDS_V1.providerFocusedShareBps
    ) {
      traits.push({
        id: "provider-focused",
        reasonCode: "TRAIT_PROVIDER_FOCUS_28D",
        templateId: "monster.trait.providerFocused.v1",
        inputs: [explanationInput("top-provider-share", "high", coverage)],
      });
    } else {
      traits.push({
        id: "balanced",
        reasonCode: "TRAIT_BALANCED_FALLBACK_28D",
        templateId: "monster.trait.balanced.v1",
        inputs: [explanationInput("top-provider-share", "balanced", coverage)],
      });
    }
  }

  const optional: OptionalTraitSelection[] = [];
  const cacheCoverageBps = cappedRatioBps(
    metrics.cacheCoveredTotal,
    metrics.total,
  );
  const cacheShareBps = cappedRatioBps(
    metrics.cacheEligibleRead,
    metrics.cacheEligibleInput + metrics.cacheEligibleRead,
  );
  if (
    cacheCoverageBps >= MONSTER_THRESHOLDS_V1.cacheCoverageBps &&
    cacheShareBps >= MONSTER_THRESHOLDS_V1.cacheSavvyShareBps
  ) {
    optional.push({
      id: "cache-savvy",
      reasonCode: "TRAIT_CACHE_SAVVY_28D",
      templateId: "monster.trait.cacheSavvy.v1",
      inputs: [
        explanationInput(
          "cache-share",
          "high",
          ratioCoverageBand(
            cacheCoverageBps,
            MONSTER_THRESHOLDS_V1.cacheCoverageBps,
          ),
        ),
        explanationInput(
          "cache-observation",
          "available",
          ratioCoverageBand(
            cacheCoverageBps,
            MONSTER_THRESHOLDS_V1.cacheCoverageBps,
          ),
        ),
      ],
      marginBps: cacheShareBps - MONSTER_THRESHOLDS_V1.cacheSavvyShareBps,
      priority: 0,
    });
  }

  const outputShareBps = cappedRatioBps(metrics.output, metrics.total);
  if (outputShareBps >= MONSTER_THRESHOLDS_V1.outputHeavyShareBps) {
    optional.push({
      id: "output-heavy",
      reasonCode: "TRAIT_OUTPUT_HEAVY_28D",
      templateId: "monster.trait.outputHeavy.v1",
      inputs: [explanationInput("output-share", "high", coverage)],
      marginBps: outputShareBps - MONSTER_THRESHOLDS_V1.outputHeavyShareBps,
      priority: 1,
    });
  }

  const nightShareBps = cappedRatioBps(
    metrics.hourlyNight,
    metrics.hourlyTotal,
  );
  if (
    metrics.hourlyObservedDays >=
      MONSTER_THRESHOLDS_V1.minimumHourlyObservedDays &&
    metrics.hourlyTimeIsExact &&
    metrics.hourlyTotal > 0n &&
    nightShareBps >= MONSTER_THRESHOLDS_V1.nightOrientedShareBps
  ) {
    optional.push({
      id: "night-oriented",
      reasonCode: "TRAIT_NIGHT_ORIENTED_LOCAL_28D",
      templateId: "monster.trait.nightOriented.v1",
      inputs: [
        explanationInput(
          "local-night-share",
          "high",
          hourlyCoverageBand(metrics.hourlyObservedDays),
        ),
        explanationInput(
          "local-hour-coverage",
          "available",
          hourlyCoverageBand(metrics.hourlyObservedDays),
        ),
        explanationInput(
          "local-hour-quality",
          "available",
          hourlyCoverageBand(metrics.hourlyObservedDays),
        ),
      ],
      marginBps: nightShareBps - MONSTER_THRESHOLDS_V1.nightOrientedShareBps,
      priority: 2,
    });
  }

  optional.sort(
    (left, right) =>
      right.marginBps - left.marginBps || left.priority - right.priority,
  );
  const dominantOptional = optional[0];
  if (dominantOptional !== undefined) {
    traits.push(dominantOptional);
  }

  return traits;
}

function compareRelativeActivity(
  metrics: FootprintMetrics,
  latestDayCompleteness: ContentBlindFootprintV1["latestDayCompleteness"],
): "unavailable" | "inactive" | "low" | "stable" | "high" {
  const latestIndex =
    metrics.dailyTotals.length - (latestDayCompleteness === "complete" ? 1 : 2);
  const latest = metrics.dailyTotals[latestIndex] ?? null;
  if (latest === null) {
    return "unavailable";
  }
  if (latest === 0n) {
    return "inactive";
  }

  let priorSum = 0n;
  let priorObservedDays = 0n;
  for (let index = 0; index < latestIndex; index += 1) {
    const value = metrics.dailyTotals[index];
    if (value !== undefined && value !== null) {
      priorSum += value;
      priorObservedDays += 1n;
    }
  }
  if (priorSum === 0n || priorObservedDays === 0n) {
    return "stable";
  }

  const scaledLatest = latest * priorObservedDays * BASIS_POINTS;
  if (
    scaledLatest >=
    priorSum * BigInt(MONSTER_THRESHOLDS_V1.livelyRelativeActivityBps)
  ) {
    return "high";
  }
  if (
    scaledLatest <
    priorSum * BigInt(MONSTER_THRESHOLDS_V1.quietRelativeActivityBps)
  ) {
    return "low";
  }
  return "stable";
}

function moodFor(
  ready: boolean,
  relativeActivity: ReturnType<typeof compareRelativeActivity>,
): {
  readonly mood: MonsterMoodIdV1;
  readonly reasonCode: MonsterReasonCodeV1;
  readonly templateId: MonsterTemplateIdV1;
  readonly valueBand: MonsterValueBandV1;
  readonly energyBand: MonsterStateV1["appearance"]["energyBand"];
} {
  if (!ready) {
    return {
      mood: "learning",
      reasonCode: "MOOD_LEARNING_COVERAGE_28D",
      templateId: "monster.mood.learning.v1",
      valueBand: "insufficient",
      energyBand: "dormant",
    };
  }
  if (relativeActivity === "unavailable") {
    return {
      mood: "unknown",
      reasonCode: "MOOD_TODAY_UNAVAILABLE",
      templateId: "monster.mood.unknown.v1",
      valueBand: "unavailable",
      energyBand: "dormant",
    };
  }
  if (relativeActivity === "inactive") {
    return {
      mood: "resting",
      reasonCode: "MOOD_RESTING_TODAY",
      templateId: "monster.mood.resting.v1",
      valueBand: "inactive",
      energyBand: "dormant",
    };
  }
  if (relativeActivity === "low") {
    return {
      mood: "quiet",
      reasonCode: "MOOD_RELATIVE_ACTIVITY_LOW",
      templateId: "monster.mood.quiet.v1",
      valueBand: "below-baseline",
      energyBand: "low",
    };
  }
  if (relativeActivity === "high") {
    return {
      mood: "lively",
      reasonCode: "MOOD_RELATIVE_ACTIVITY_HIGH",
      templateId: "monster.mood.lively.v1",
      valueBand: "above-baseline",
      energyBand: "high",
    };
  }
  return {
    mood: "steady",
    reasonCode: "MOOD_RELATIVE_ACTIVITY_STABLE",
    templateId: "monster.mood.steady.v1",
    valueBand: "near-baseline",
    energyBand: "medium",
  };
}

function traitIds(state: MonsterStateV1 | null): readonly MonsterTraitIdV1[] {
  return state?.traits.map((trait) => trait.id) ?? [];
}

function providerCoverageIsComplete(metrics: FootprintMetrics): boolean {
  return (metrics.byProvider.get("other") ?? 0n) === 0n;
}

function toolCoverageIsComplete(metrics: FootprintMetrics): boolean {
  return (metrics.byTool.get("other") ?? 0n) === 0n;
}

function equalTraits(
  left: readonly MonsterTraitIdV1[],
  right: readonly MonsterTraitIdV1[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

const MILLISECONDS_PER_LOCAL_DATE = 86_400_000;

function localDateNumber(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

function localDateDifference(from: string, to: string): number {
  return (
    (localDateNumber(to) - localDateNumber(from)) / MILLISECONDS_PER_LOCAL_DATE
  );
}

function validatePreviousWindow(
  current: FootprintWindowV1,
  previous: MonsterStateV1 | null,
): { readonly sameWindow: boolean } {
  if (previous === null) {
    return { sameWindow: false };
  }
  if (previous.window.timezone !== current.timezone) {
    throw new Error(
      "Previous monster state timezone is incompatible with the current footprint.",
    );
  }

  const fromAdvance = localDateDifference(previous.window.from, current.from);
  const toAdvance = localDateDifference(previous.window.to, current.to);
  if (
    fromAdvance !== toAdvance ||
    !Number.isInteger(toAdvance) ||
    toAdvance < 0 ||
    toAdvance > 1
  ) {
    throw new Error(
      "Previous monster state must use the same footprint window or the immediately preceding contiguous local-day window.",
    );
  }
  return { sameWindow: toAdvance === 0 };
}

function advanceAtMostOneTrait(
  previous: readonly MonsterTraitIdV1[],
  candidate: readonly MonsterTraitIdV1[],
): readonly MonsterTraitIdV1[] {
  const firstDifference = Array.from(
    { length: Math.max(previous.length, candidate.length) },
    (_, index) => index,
  ).find((index) => previous[index] !== candidate[index]);
  if (firstDifference === undefined) {
    return previous;
  }

  const next = [...previous];
  const candidateTrait = candidate[firstDifference];
  if (candidateTrait === undefined) {
    next.splice(firstDifference, 1);
  } else if (next.indexOf(candidateTrait, firstDifference + 1) !== -1) {
    // Candidate lists contain only unique traits. When the desired trait is
    // already present in a later semantic slot, removing the obsolete current
    // slot is the sole daily edit. Replacing it would create a duplicate and
    // compacting the previous list before comparison could silently remove
    // several visible traits at once.
    next.splice(firstDifference, 1);
  } else if (firstDifference >= next.length) {
    next.push(candidateTrait);
  } else {
    next[firstDifference] = candidateTrait;
  }
  return next;
}

function makeExplanation(
  window: FootprintWindowV1,
  subject: MonsterExplanationV1["subject"],
  ordinal: number,
  reasonCode: MonsterReasonCodeV1,
  templateId: MonsterTemplateIdV1,
  inputs: readonly MonsterExplanationInputV1[],
  before: MonsterExplanationStateValueV1 | null,
  after: MonsterExplanationStateValueV1,
): MonsterExplanationV1 {
  return {
    explanationId: `monster-v1:${window.to}:${subject}:${ordinal}`,
    engineVersion: MONSTER_ENGINE_VERSION_V1,
    subject,
    reasonCode,
    window,
    inputs: [...inputs],
    before,
    after,
    templateId,
  };
}

/**
 * Pure, deterministic derivation. It performs runtime parsing so untrusted
 * local collector data cannot expand the content-blind input boundary.
 */
export function deriveMonsterState(
  footprintInput: unknown,
  previousInput: unknown,
  configInput: unknown = DEFAULT_MONSTER_RULES_V1,
): MonsterDerivationV1 {
  const footprint = ContentBlindFootprintV1Schema.parse(footprintInput);
  const previous =
    previousInput === null ? null : MonsterStateV1Schema.parse(previousInput);
  MonsterRulesV1Schema.parse(configInput);
  const previousWindow = validatePreviousWindow(footprint.window, previous);

  const metrics = aggregateMetrics(footprint);
  const metricCoverage = metricCoverageBand(
    metrics.observedDays,
    metrics.activeDays,
  );
  const dayCoverageReady = metricCoverage !== "insufficient";
  const selectedTraits = dayCoverageReady
    ? selectTraits(metrics, metricCoverage)
    : [];
  const traitEvidenceReady = selectedTraits.length > 0;
  const candidateReady = dayCoverageReady && traitEvidenceReady;
  const candidateTraitIds = selectedTraits.map((trait) => trait.id);
  const previousTraitIds = traitIds(previous);

  let identityStatus: MonsterStateV1["identityStatus"] = candidateReady
    ? "ready"
    : "learning";
  let visibleTraitIds: readonly MonsterTraitIdV1[] = candidateTraitIds;
  let evidenceLossStartedDate: string | null = null;
  if (previous?.identityStatus === "ready" && !candidateReady) {
    const graceStarted =
      previous.identityContinuity.evidenceLossStartedDate ??
      footprint.window.to;
    if (
      localDateDifference(graceStarted, footprint.window.to) <
      MONSTER_THRESHOLDS_V1.evidenceLossGraceDays
    ) {
      identityStatus = "ready";
      visibleTraitIds = previousTraitIds;
      evidenceLossStartedDate = graceStarted;
    }
  } else if (previous !== null && previousWindow.sameWindow) {
    identityStatus = previous.identityStatus;
    visibleTraitIds = previousTraitIds;
  } else if (previous?.identityStatus === "ready") {
    identityStatus = "ready";
    visibleTraitIds = candidateReady
      ? advanceAtMostOneTrait(previousTraitIds, candidateTraitIds)
      : previousTraitIds;
  }
  if (identityStatus === "ready" && visibleTraitIds.length === 0) {
    identityStatus = "learning";
    visibleTraitIds = [];
    evidenceLossStartedDate = null;
  }

  const coverage: MonsterCoverageBandV1 =
    identityStatus === "ready" ? metricCoverage : "insufficient";

  const provisional =
    (identityStatus === "ready") !== candidateReady ||
    (identityStatus === "ready" &&
      !equalTraits(visibleTraitIds, candidateTraitIds));
  const explanations: MonsterExplanationV1[] = [];

  let identityReason: MonsterReasonCodeV1;
  let identityTemplate: MonsterTemplateIdV1;
  const identityInputs: MonsterExplanationInputV1[] = [
    explanationInput(
      "observed-days",
      dayCoverageReady ? "available" : "insufficient",
      metricCoverage,
    ),
    explanationInput(
      "active-days",
      dayCoverageReady ? "available" : "insufficient",
      metricCoverage,
    ),
  ];
  if (identityStatus === "learning" && !dayCoverageReady) {
    identityReason = "IDENTITY_LEARNING_COVERAGE_28D";
    identityTemplate = "monster.identity.learning.v1";
  } else if (identityStatus === "learning" && !traitEvidenceReady) {
    identityReason = "IDENTITY_LEARNING_EVIDENCE_28D";
    identityTemplate = "monster.identity.learningEvidence.v1";
    identityInputs.push(
      explanationInput("trait-structure", "unavailable", "insufficient"),
    );
  } else if (evidenceLossStartedDate !== null) {
    identityReason = "IDENTITY_HELD_EVIDENCE_GRACE_7D";
    identityTemplate = "monster.identity.heldEvidenceGrace.v1";
    identityInputs.push(explanationInput("trait-structure", "held", coverage));
  } else if (previous !== null && previousWindow.sameWindow) {
    identityReason = "IDENTITY_HELD_SAME_WINDOW";
    identityTemplate = "monster.identity.heldSameWindow.v1";
    identityInputs.push(explanationInput("trait-structure", "held", coverage));
  } else if (provisional) {
    identityReason = "IDENTITY_PROVISIONAL_DAILY_LIMIT";
    identityTemplate = "monster.identity.provisionalDailyLimit.v1";
    identityInputs.push(
      explanationInput("trait-structure", "provisional", coverage),
    );
  } else {
    identityReason = "IDENTITY_READY_COVERAGE_28D";
    identityTemplate = "monster.identity.ready.v1";
  }

  const identityExplanation = makeExplanation(
    footprint.window,
    "identity",
    0,
    identityReason,
    identityTemplate,
    identityInputs,
    previous?.identityStatus ?? null,
    identityStatus,
  );
  explanations.push(identityExplanation);

  const traits = visibleTraitIds.map((traitId, index) => {
    const candidate = selectedTraits.find(
      (selection) => selection.id === traitId,
    );
    let trait: TraitSelection;
    if (evidenceLossStartedDate !== null) {
      trait = {
        id: traitId,
        reasonCode: "TRAIT_HELD_EVIDENCE_GRACE_7D",
        templateId: "monster.trait.heldEvidenceGrace.v1",
        inputs: [explanationInput("trait-structure", "held", coverage)],
      };
    } else if (previous !== null && previousWindow.sameWindow) {
      trait = {
        id: traitId,
        reasonCode: "TRAIT_HELD_SAME_WINDOW",
        templateId: "monster.trait.heldSameWindow.v1",
        inputs: [explanationInput("trait-structure", "held", coverage)],
      };
    } else if (candidate?.id !== traitId) {
      trait = {
        id: traitId,
        reasonCode: "TRAIT_HELD_DAILY_LIMIT",
        templateId: "monster.trait.heldDailyLimit.v1",
        inputs: [explanationInput("trait-structure", "provisional", coverage)],
      };
    } else {
      trait = candidate;
    }

    const explanation = makeExplanation(
      footprint.window,
      "trait",
      index + 1,
      trait.reasonCode,
      trait.templateId,
      trait.inputs,
      previousTraitIds.includes(traitId)
        ? traitId
        : (previousTraitIds[index] ?? null),
      trait.id,
    );
    explanations.push(explanation);
    return { id: trait.id, explanationId: explanation.explanationId };
  });

  const relativeActivity = compareRelativeActivity(
    metrics,
    footprint.latestDayCompleteness,
  );
  const moodSelection = moodFor(identityStatus === "ready", relativeActivity);
  const moodExplanation = makeExplanation(
    footprint.window,
    "mood",
    0,
    moodSelection.reasonCode,
    moodSelection.templateId,
    [
      explanationInput(
        "relative-daily-activity",
        moodSelection.valueBand,
        coverage,
      ),
    ],
    previous?.mood.id ?? null,
    moodSelection.mood,
  );
  explanations.push(moodExplanation);

  const nextTraitIds = traits.map((trait) => trait.id);
  let evolution: MonsterStateV1["evolution"]["event"];
  let evolutionReason: MonsterReasonCodeV1;
  let evolutionTemplate: MonsterTemplateIdV1;
  let evolutionBand: MonsterValueBandV1;
  const identityChanged =
    previous !== null &&
    (previous.identityStatus !== identityStatus ||
      !equalTraits(previousTraitIds, nextTraitIds));
  const daysSinceIdentityReview =
    previous === null
      ? 0
      : localDateDifference(
          previous.identityContinuity.lastIdentityReviewDate,
          footprint.window.to,
        );

  if (identityStatus === "learning") {
    evolution = "awaiting-coverage";
    evolutionReason = "EVOLUTION_AWAITING_COVERAGE";
    evolutionTemplate = "monster.evolution.awaitingCoverage.v1";
    evolutionBand = "insufficient";
  } else if (previous !== null && previousWindow.sameWindow) {
    evolution = "no-change";
    evolutionReason = "EVOLUTION_NO_CHANGE";
    evolutionTemplate = "monster.evolution.noChange.v1";
    evolutionBand = "held";
  } else if (identityStatus === "ready" && previous === null) {
    evolution = "initial-profile";
    evolutionReason = "EVOLUTION_INITIAL_PROFILE";
    evolutionTemplate = "monster.evolution.initialProfile.v1";
    evolutionBand = "initial";
  } else if (
    identityStatus === "ready" &&
    previous?.identityStatus === "learning"
  ) {
    evolution = "coverage-complete";
    evolutionReason = "EVOLUTION_COVERAGE_COMPLETE";
    evolutionTemplate = "monster.evolution.coverageComplete.v1";
    evolutionBand = "changed";
  } else if (identityChanged) {
    evolution = "identity-shift";
    evolutionReason = "EVOLUTION_IDENTITY_SHIFT";
    evolutionTemplate = "monster.evolution.identityShift.v1";
    evolutionBand = "changed";
  } else if (
    identityStatus === "ready" &&
    !provisional &&
    daysSinceIdentityReview === 7
  ) {
    evolution = "weekly-review";
    evolutionReason = "EVOLUTION_WEEKLY_REVIEW";
    evolutionTemplate = "monster.evolution.weeklyReview.v1";
    evolutionBand = "stable";
  } else {
    evolution = "no-change";
    evolutionReason = "EVOLUTION_NO_CHANGE";
    evolutionTemplate = "monster.evolution.noChange.v1";
    evolutionBand = "stable";
  }

  let lastIdentityReviewDate =
    previous?.identityContinuity.lastIdentityReviewDate ?? footprint.window.to;
  const enteredEvidenceLossGrace =
    evidenceLossStartedDate !== null &&
    previous?.identityContinuity.evidenceLossStartedDate === null;
  if (
    previous === null ||
    enteredEvidenceLossGrace ||
    (!previousWindow.sameWindow &&
      evidenceLossStartedDate === null &&
      (identityChanged || provisional || evolution === "weekly-review"))
  ) {
    lastIdentityReviewDate = footprint.window.to;
  }

  const evolutionExplanation = makeExplanation(
    footprint.window,
    "evolution",
    0,
    evolutionReason,
    evolutionTemplate,
    [explanationInput("trait-structure", evolutionBand, coverage)],
    previous?.evolution.event ?? null,
    evolution,
  );
  explanations.push(evolutionExplanation);

  const state: MonsterStateV1 = {
    schemaVersion: "1",
    engineVersion: MONSTER_ENGINE_VERSION_V1,
    characterId: footprint.characterId,
    window: footprint.window,
    identityStatus,
    coverageBand: coverage,
    identityExplanationId: identityExplanation.explanationId,
    identityContinuity: {
      schemaVersion: "1",
      lastIdentityReviewDate,
      evidenceLossStartedDate,
      provisional,
    },
    traits,
    mood: {
      id: moodSelection.mood,
      explanationId: moodExplanation.explanationId,
    },
    evolution: {
      cadence:
        evolution === "weekly-review"
          ? "weekly"
          : evolution === "no-change"
            ? "none"
            : "event",
      event: evolution,
      explanationId: evolutionExplanation.explanationId,
    },
    appearance: { energyBand: moodSelection.energyBand },
  };

  return MonsterDerivationV1Schema.parse({ state, explanations });
}
