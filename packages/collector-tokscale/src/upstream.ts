import { z } from "zod";

import { CollectorTokscaleError } from "./errors.js";

const SafeUpstreamCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const UpstreamEntrySchema = z.looseObject({
  client: z.string().min(1).max(64),
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(512),
  input: SafeUpstreamCountSchema,
  output: SafeUpstreamCountSchema,
  cacheRead: SafeUpstreamCountSchema,
  cacheWrite: SafeUpstreamCountSchema,
  reasoning: SafeUpstreamCountSchema
});

const UpstreamReportSchema = z.looseObject({
  groupBy: z.literal("client,provider,model"),
  entries: z.array(UpstreamEntrySchema).max(10_000)
});

export interface ProjectedUpstreamEntry {
  readonly client: string;
  readonly provider: string;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
}

export interface ProjectedUpstreamReport {
  readonly entries: readonly ProjectedUpstreamEntry[];
}

export function parseAndProjectUpstreamReport(
  rawStdout: string
): ProjectedUpstreamReport {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawStdout) as unknown;
  } catch {
    throw new CollectorTokscaleError(
      "invalid-upstream-json",
      "Tokscale did not return valid JSON."
    );
  }

  const parsed = UpstreamReportSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new CollectorTokscaleError(
      "unexpected-upstream-data",
      "Tokscale JSON did not match the audited v4.5.2 report shape."
    );
  }

  return {
    entries: parsed.data.entries.map((entry) => ({
      client: entry.client,
      provider: entry.provider,
      model: entry.model,
      input: entry.input,
      output: entry.output,
      cacheRead: entry.cacheRead,
      cacheWrite: entry.cacheWrite,
      reasoning: entry.reasoning
    }))
  };
}
