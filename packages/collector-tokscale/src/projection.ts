import {
  IngestSnapshotV1Schema,
  MAX_TOKEN_COUNT_V1,
  type IngestSnapshotV1,
  type ProviderKindV1
} from "@tokenmonster/contracts";
import { z } from "zod";

import {
  COLLECTOR_TOKSCALE_VERSION,
  TOKSCALE_SOURCE_VERSION
} from "./constants.js";
import { CollectorTokscaleError } from "./errors.js";
import {
  currentUtcDate,
  parseCollectionUtcDate,
  parseTier1Client,
  toolScopeForTier1Client,
  type Tier1Client
} from "./policy.js";
import {
  parseAndProjectUpstreamReport,
  type ProjectedUpstreamEntry
} from "./upstream.js";

const ProjectionInputSchema = z.strictObject({
  client: z.unknown(),
  utcDate: z.unknown(),
  batchId: z.uuid(),
  generatedAt: z.string(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
});

export interface ProjectionInput {
  readonly client: unknown;
  readonly utcDate: unknown;
  readonly batchId: string;
  readonly generatedAt: string;
  readonly revision: number;
}

const MAX_TOKEN_COUNT = BigInt(MAX_TOKEN_COUNT_V1);

interface Aggregate {
  provider: ProviderKindV1;
  modelFamily: string;
  tool: string;
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
  reasoning: bigint;
}

function normalizeProvider(rawProvider: string): ProviderKindV1 {
  const provider = rawProvider.trim().toLowerCase();
  if (
    provider === "anthropic" ||
    provider === "claude" ||
    provider === "amazon-bedrock" ||
    provider === "aws-bedrock"
  ) {
    return "anthropic";
  }
  if (
    provider === "google" ||
    provider === "google-ai" ||
    provider === "gemini" ||
    provider === "vertex-ai" ||
    provider === "google-vertex"
  ) {
    return "google";
  }
  if (
    provider === "openai" ||
    provider === "azure-openai" ||
    provider === "codex"
  ) {
    return "openai";
  }
  if (provider === "openrouter") {
    return "openrouter";
  }
  if (provider === "xai" || provider === "x-ai" || provider === "grok") {
    return "xai";
  }
  return "other";
}

function normalizeModelFamily(
  provider: ProviderKindV1,
  rawModel: string
): string {
  const model = rawModel.trim().toLowerCase();

  if (provider === "anthropic") {
    if (model.includes("opus")) return "claude-opus";
    if (model.includes("sonnet")) return "claude-sonnet";
    if (model.includes("haiku")) return "claude-haiku";
    return "anthropic-other";
  }

  if (provider === "google") {
    if (model.includes("flash")) return "gemini-flash";
    if (model.includes("pro")) return "gemini-pro";
    return "google-other";
  }

  if (provider === "openai") {
    if (model.includes("codex")) return "openai-codex";
    if (model.includes("gpt-5")) return "gpt-5";
    if (model.includes("gpt-4o")) return "gpt-4o";
    if (model.includes("gpt-4")) return "gpt-4";
    if (/(^|[^a-z0-9])o1([^a-z0-9]|$)/u.test(model)) return "o1";
    if (/(^|[^a-z0-9])o3([^a-z0-9]|$)/u.test(model)) return "o3";
    if (/(^|[^a-z0-9])o4([^a-z0-9]|$)/u.test(model)) return "o4";
    return "openai-other";
  }

  if (provider === "xai") {
    if (model.includes("grok")) return "grok";
    return "xai-other";
  }

  if (provider === "openrouter") {
    return "openrouter-other";
  }

  return "other";
}

function checkedAdd(current: bigint, increment: number): bigint {
  const result = current + BigInt(increment);
  if (result > MAX_TOKEN_COUNT) {
    throw new CollectorTokscaleError(
      "token-overflow",
      "A normalized aggregate exceeds Number.MAX_SAFE_INTEGER."
    );
  }
  return result;
}

function addEntry(
  aggregate: Aggregate,
  entry: ProjectedUpstreamEntry,
  client: Tier1Client
): void {
  if (entry.client !== client) {
    throw new CollectorTokscaleError(
      "unexpected-upstream-data",
      "Tokscale returned data for a client outside the fixed filter."
    );
  }

  if (client !== "codex" && entry.reasoning > 0) {
    throw new CollectorTokscaleError(
      "unsupported-reasoning",
      "Non-Codex reasoning semantics are not supported by this adapter version."
    );
  }

  if (client === "codex" && entry.reasoning > entry.output) {
    throw new CollectorTokscaleError(
      "unexpected-upstream-data",
      "Codex reasoning must be an informational subset of output."
    );
  }

  aggregate.input = checkedAdd(aggregate.input, entry.input);
  aggregate.output = checkedAdd(aggregate.output, entry.output);
  aggregate.cacheRead = checkedAdd(aggregate.cacheRead, entry.cacheRead);
  aggregate.cacheWrite = checkedAdd(aggregate.cacheWrite, entry.cacheWrite);
  aggregate.reasoning = checkedAdd(aggregate.reasoning, entry.reasoning);
}

function normalizeEntries(
  entries: readonly ProjectedUpstreamEntry[],
  client: Tier1Client
): Aggregate[] {
  const tool = toolScopeForTier1Client(client);
  const aggregates = new Map<string, Aggregate>();

  for (const entry of entries) {
    const provider = normalizeProvider(entry.provider);
    const modelFamily = normalizeModelFamily(provider, entry.model);
    const key = [provider, modelFamily, tool].join("|");
    let aggregate = aggregates.get(key);
    if (aggregate === undefined) {
      aggregate = {
        provider,
        modelFamily,
        tool,
        input: 0n,
        output: 0n,
        cacheRead: 0n,
        cacheWrite: 0n,
        reasoning: 0n
      };
      aggregates.set(key, aggregate);
    }
    addEntry(aggregate, entry, client);
  }

  return [...aggregates.values()].sort((left, right) =>
    [left.provider, left.modelFamily, left.tool]
      .join("|")
      .localeCompare([right.provider, right.modelFamily, right.tool].join("|"))
  );
}

export function projectTokscaleJsonToIngestSnapshotV1(
  rawStdout: string,
  input: ProjectionInput,
  now: Date = new Date()
): IngestSnapshotV1 {
  const parsedInput = ProjectionInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new CollectorTokscaleError(
      "invalid-input",
      "Projection metadata is invalid."
    );
  }

  const client = parseTier1Client(parsedInput.data.client);
  const utcDate = parseCollectionUtcDate(parsedInput.data.utcDate, now);
  if (!parsedInput.data.generatedAt.startsWith(currentUtcDate(now) + "T")) {
    throw new CollectorTokscaleError(
      "invalid-input",
      "generatedAt must describe the current UTC day."
    );
  }

  const upstream = parseAndProjectUpstreamReport(rawStdout);
  const aggregates = normalizeEntries(upstream.entries, client);
  if (aggregates.length === 0) {
    throw new CollectorTokscaleError(
      "no-usage",
      "Tokscale returned no non-zero usage for the requested UTC day."
    );
  }

  const candidate = {
    schemaVersion: "1",
    batchId: parsedInput.data.batchId,
    generatedAt: parsedInput.data.generatedAt,
    collector: {
      kind: "tokscale",
      adapterVersion: COLLECTOR_TOKSCALE_VERSION,
      sourceVersion: TOKSCALE_SOURCE_VERSION
    },
    buckets: aggregates.map((aggregate) => {
      const total =
        aggregate.input +
        aggregate.output +
        aggregate.cacheRead +
        aggregate.cacheWrite;
      if (total > MAX_TOKEN_COUNT) {
        throw new CollectorTokscaleError(
          "token-overflow",
          "A normalized token total exceeds Number.MAX_SAFE_INTEGER."
        );
      }

      return {
        bucketStart: utcDate + "T00:00:00.000Z",
        provider: aggregate.provider,
        modelFamily: aggregate.modelFamily,
        tool: aggregate.tool,
        valueQuality: "exact",
        revision: parsedInput.data.revision,
        tokens: {
          input: aggregate.input.toString(),
          output: aggregate.output.toString(),
          cacheRead: aggregate.cacheRead.toString(),
          cacheWrite: aggregate.cacheWrite.toString(),
          reasoning: aggregate.reasoning.toString(),
          other: "0",
          total: total.toString()
        }
      };
    })
  };

  const result = IngestSnapshotV1Schema.safeParse(candidate);
  if (!result.success) {
    throw new CollectorTokscaleError(
      "unexpected-upstream-data",
      "Projected Tokscale data failed the public ingest contract."
    );
  }
  return result.data;
}
