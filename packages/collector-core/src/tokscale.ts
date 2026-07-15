import { isAbsolute } from "node:path";

import {
  COLLECTOR_TOKSCALE_VERSION,
  CollectorTokscaleError,
  TOKSCALE_SOURCE_VERSION,
  collectTokscaleDailySnapshot,
  collectTokscaleDailySnapshotFromPinnedBinary
} from "@tokenmonster/collector-tokscale";
import type { CollectorIdentityV1 } from "@tokenmonster/contracts";

import { collectorCoreFailure } from "./errors.js";
import type {
  DailyCollectorPort,
  DailyCollectorScanRequest,
  TokscaleDailyCollectorOptions
} from "./types.js";

export const TOKSCALE_COLLECTOR_IDENTITY: CollectorIdentityV1 = Object.freeze({
  kind: "tokscale",
  adapterVersion: COLLECTOR_TOKSCALE_VERSION,
  sourceVersion: TOKSCALE_SOURCE_VERSION
});

export function createTokscaleDailyCollector(
  options: TokscaleDailyCollectorOptions
): DailyCollectorPort {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.configDir !== "string" ||
    options.configDir.length === 0 ||
    (options.binaryPath !== undefined &&
      (typeof options.binaryPath !== "string" ||
        options.binaryPath.length < 1 ||
        options.binaryPath.length > 4_096 ||
        options.binaryPath.includes("\0") ||
        !isAbsolute(options.binaryPath)))
  ) {
    return collectorCoreFailure("DEPENDENCY_INVALID");
  }
  const configDir = options.configDir;
  const binaryPath = options.binaryPath;
  return Object.freeze({
    identity: TOKSCALE_COLLECTOR_IDENTITY,
    async scanDaily(input: DailyCollectorScanRequest): Promise<unknown> {
      try {
        const collectionInput = {
          client: input.client,
          utcDate: input.utcDate,
          configDir,
          batchId: input.projectionBatchId,
          generatedAt: input.generatedAt,
          revision: input.projectionRevision
        };
        const snapshot =
          binaryPath === undefined
            ? await collectTokscaleDailySnapshot(collectionInput)
            : await collectTokscaleDailySnapshotFromPinnedBinary(
                collectionInput,
                binaryPath
              );
        return Object.freeze({ status: "complete" as const, snapshot });
      } catch (error: unknown) {
        if (
          error instanceof CollectorTokscaleError &&
          error.code === "no-usage"
        ) {
          return Object.freeze({
            status: "complete" as const,
            snapshot: null
          });
        }
        throw error;
      }
    }
  });
}
