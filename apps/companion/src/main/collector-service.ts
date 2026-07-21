import { randomUUID } from "node:crypto";
import { dirname, isAbsolute } from "node:path";

import {
  CollectorCoreError,
  TOKSCALE_COLLECTOR_IDENTITY,
  createLocalScanCoordinator,
  createTokscaleDailyCollector,
  type LocalDailyScanResult,
} from "@tokenmonster/collector-core";
import type {
  CompleteDailyScanInput,
  LocalStore,
} from "@tokenmonster/local-store";

import type {
  CollectorClient,
  CollectorDay,
  CollectorScanErrorCode,
  CollectorScanRequest,
  CollectorScanResponse,
} from "../shared/ipc.js";
import { verifyPrivateCollectorDirectory } from "./private-directory.js";

const CLIENTS = new Set<CollectorClient>(["claude", "codex", "gemini", "grok"]);
const DAYS = new Set<CollectorDay>(["today", "previous"]);
const MAX_RESULT_ROWS = 1_000;

interface DailyScanExecutionPort {
  scanDaily(
    request: Readonly<{ client: CollectorClient; utcDate: string }>,
    at: Date,
  ): Promise<LocalDailyScanResult>;
}

export interface CompanionCollectorService {
  scan(input: unknown): Promise<CollectorScanResponse>;
  dispose(): void;
  quiesce(): Promise<void>;
}

interface CompanionCollectorServiceDependencies {
  readonly execution: DailyScanExecutionPort;
  readonly clock: () => Date;
  readonly onApplied: (at: string) => void;
  readonly recordCompleteScan?: (input: CompleteDailyScanInput) => void;
  readonly onFailure?: (code: CollectorScanErrorCode) => void;
  readonly unavailableErrorCode?: CollectorScanErrorCode;
  readonly dispose?: () => void;
}

interface TokscaleCollectorServiceOptions {
  readonly store: LocalStore;
  readonly configDir: string;
  readonly binaryPath?: string;
  readonly clock?: () => Date;
  readonly uuid?: () => string;
  readonly onApplied: (at: string) => void;
}

function strictScanRequest(input: unknown): CollectorScanRequest {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    ) {
      throw new Error("IPC_REQUEST_REJECTED");
    }
    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== 2 ||
      keys.some(
        (key) => typeof key !== "string" || !["client", "day"].includes(key),
      )
    ) {
      throw new Error("IPC_REQUEST_REJECTED");
    }
    const clientDescriptor = Object.getOwnPropertyDescriptor(input, "client");
    const dayDescriptor = Object.getOwnPropertyDescriptor(input, "day");
    if (
      clientDescriptor === undefined ||
      !("value" in clientDescriptor) ||
      dayDescriptor === undefined ||
      !("value" in dayDescriptor) ||
      typeof clientDescriptor.value !== "string" ||
      !CLIENTS.has(clientDescriptor.value as CollectorClient) ||
      typeof dayDescriptor.value !== "string" ||
      !DAYS.has(dayDescriptor.value as CollectorDay)
    ) {
      throw new Error("IPC_REQUEST_REJECTED");
    }
    return Object.freeze({
      client: clientDescriptor.value as CollectorClient,
      day: dayDescriptor.value as CollectorDay,
    });
  } catch {
    throw new Error("IPC_REQUEST_REJECTED");
  }
}

function scanUtcDate(day: CollectorDay, at: Date): string {
  const offset = day === "today" ? 0 : 86_400_000;
  return new Date(at.getTime() - offset).toISOString().slice(0, 10);
}

function boundedCount(input: unknown): input is number {
  return (
    typeof input === "number" &&
    Number.isSafeInteger(input) &&
    input >= 0 &&
    input <= MAX_RESULT_ROWS
  );
}

function sanitizeResult(
  result: LocalDailyScanResult,
  request: CollectorScanRequest,
  utcDate: string,
): CollectorScanResponse | null {
  try {
    const counts = [
      result.observedRows,
      result.appliedRows,
      result.insertedRows,
      result.updatedRows,
      result.metadataUpdatedRows,
      result.unchangedRows,
      result.inferredZeroRows,
    ];
    if (
      result.status !== "applied" ||
      result.complete !== true ||
      result.client !== request.client ||
      result.bucketStart !== `${utcDate}T00:00:00.000Z` ||
      counts.some((count) => !boundedCount(count)) ||
      result.insertedRows +
        result.updatedRows +
        result.metadataUpdatedRows +
        result.unchangedRows !==
        result.appliedRows ||
      result.observedRows > result.appliedRows ||
      result.inferredZeroRows > result.appliedRows ||
      result.cloudQueue.status !== "skipped" ||
      result.cloudQueue.reason !== "contribution-disabled"
    ) {
      return null;
    }
    return Object.freeze({
      kind: "applied" as const,
      client: request.client,
      day: request.day,
      bucketStart: result.bucketStart,
      observedRows: result.observedRows,
      appliedRows: result.appliedRows,
      insertedRows: result.insertedRows,
      updatedRows: result.updatedRows,
      inferredZeroRows: result.inferredZeroRows,
      sharing: "disabled" as const,
    });
  } catch {
    return null;
  }
}

function mappedErrorCode(error: unknown): CollectorScanErrorCode {
  if (!(error instanceof CollectorCoreError)) return "local-service-error";
  switch (error.code) {
    case "SCAN_IN_PROGRESS":
      return "busy";
    case "AUTHORITY_MISMATCH":
    case "AUTHORITY_NOT_RUNNING":
    case "COLLECTOR_IDENTITY_MISMATCH":
      return "authority-conflict";
    case "COLLECTOR_FAILED":
    case "COLLECTOR_INCOMPLETE":
      return "collector-unavailable";
    case "COLLECTOR_OUTPUT_INVALID":
      return "invalid-output";
    case "LOCAL_APPLY_FAILED":
    case "LOCAL_SCOPE_TOO_LARGE":
      return "storage-error";
    case "CLOCK_INVALID":
    case "DEPENDENCY_INVALID":
    case "OUTBOX_READ_FAILED":
    case "OUTBOX_RETRY_FAILED":
    case "SCAN_REQUEST_INVALID":
      return "local-service-error";
    default:
      return "local-service-error";
  }
}

export function createCompanionCollectorService(
  dependencies: CompanionCollectorServiceDependencies,
): CompanionCollectorService {
  let disposed = false;
  const activeScans = new Set<Promise<CollectorScanResponse>>();
  let quiescence: Promise<void> | null = null;

  const stoppedResponse = (
    request: CollectorScanRequest,
  ): CollectorScanResponse =>
    Object.freeze({
      kind: "error",
      client: request.client,
      day: request.day,
      errorCode: "local-service-error",
    });

  const runScan = async (
    request: CollectorScanRequest,
  ): Promise<CollectorScanResponse> => {
    if (dependencies.unavailableErrorCode !== undefined) {
      return Object.freeze({
        kind: "error",
        client: request.client,
        day: request.day,
        errorCode: dependencies.unavailableErrorCode,
      });
    }
    let at: Date;
    try {
      const candidate = dependencies.clock();
      if (
        !(candidate instanceof Date) ||
        !Number.isFinite(candidate.getTime())
      ) {
        throw new Error("CLOCK_INVALID");
      }
      at = new Date(candidate.getTime());
    } catch {
      return stoppedResponse(request);
    }
    const utcDate = scanUtcDate(request.day, at);
    try {
      const rawResult = await dependencies.execution.scanDaily(
        { client: request.client, utcDate },
        at,
      );
      if (disposed) return stoppedResponse(request);
      const result = sanitizeResult(rawResult, request, utcDate);
      if (result === null) {
        try {
          dependencies.onFailure?.("invalid-output");
        } catch {
          // Health degradation must not reflect a local storage exception.
        }
        return Object.freeze({
          kind: "error",
          client: request.client,
          day: request.day,
          errorCode: "invalid-output",
        });
      }
      try {
        dependencies.recordCompleteScan?.({
          utcDate,
          client: request.client,
        });
      } catch {
        try {
          dependencies.onFailure?.("storage-error");
        } catch {
          // The fixed storage error remains authoritative.
        }
        return Object.freeze({
          kind: "error",
          client: request.client,
          day: request.day,
          errorCode: "storage-error",
        });
      }
      try {
        dependencies.onApplied(at.toISOString());
      } catch {
        // The local aggregate is already committed; a RAM-only UI timestamp
        // must not turn a successful absolute scan into a false failure.
      }
      return result;
    } catch (error: unknown) {
      if (disposed) return stoppedResponse(request);
      const errorCode = mappedErrorCode(error);
      try {
        dependencies.onFailure?.(errorCode);
      } catch {
        // The fixed scan error remains authoritative.
      }
      return Object.freeze({
        kind: "error",
        client: request.client,
        day: request.day,
        errorCode,
      });
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    try {
      dependencies.dispose?.();
    } catch {
      // Shutdown deliberately exposes no local paths or runtime exception.
    }
  };

  return Object.freeze({
    async scan(input: unknown): Promise<CollectorScanResponse> {
      const request = strictScanRequest(input);
      if (disposed) return stoppedResponse(request);
      const operation = runScan(request);
      activeScans.add(operation);
      try {
        return await operation;
      } finally {
        activeScans.delete(operation);
      }
    },
    dispose,
    quiesce(): Promise<void> {
      dispose();
      quiescence ??= (async () => {
        while (activeScans.size > 0) {
          await Promise.allSettled([...activeScans]);
        }
      })();
      return quiescence;
    },
  });
}

function sameTokscaleAuthority(
  authority: ReturnType<LocalStore["getCollectorAuthority"]>,
): boolean {
  return (
    authority !== null &&
    authority.kind === TOKSCALE_COLLECTOR_IDENTITY.kind &&
    authority.adapterVersion === TOKSCALE_COLLECTOR_IDENTITY.adapterVersion &&
    authority.sourceVersion === TOKSCALE_COLLECTOR_IDENTITY.sourceVersion
  );
}

function prepareTokscaleAuthority(
  store: LocalStore,
  configDirIsValid: boolean,
): CollectorScanErrorCode | null {
  try {
    const current = store.getCollectorAuthority();
    if (current !== null && !sameTokscaleAuthority(current)) {
      store.setCollectorAuthority({
        kind: current.kind,
        adapterVersion: current.adapterVersion,
        sourceVersion: current.sourceVersion,
        state: "degraded",
      });
      return "authority-conflict";
    }
    if (!configDirIsValid) {
      if (current !== null) {
        store.setCollectorAuthority({
          ...TOKSCALE_COLLECTOR_IDENTITY,
          state: "degraded",
        });
      }
      return "local-service-error";
    }
    store.setCollectorAuthority({
      ...TOKSCALE_COLLECTOR_IDENTITY,
      state: "running",
    });
    return null;
  } catch {
    return "storage-error";
  }
}

function stopTokscaleAuthority(store: LocalStore): void {
  const current = store.getCollectorAuthority();
  if (!sameTokscaleAuthority(current)) return;
  store.setCollectorAuthority({
    ...TOKSCALE_COLLECTOR_IDENTITY,
    state: "stopped",
  });
}

function degradeTokscaleAuthority(store: LocalStore): void {
  try {
    const current = store.getCollectorAuthority();
    if (
      current === null ||
      !sameTokscaleAuthority(current) ||
      current.state !== "running"
    ) {
      return;
    }
    store.setCollectorAuthority({
      ...TOKSCALE_COLLECTOR_IDENTITY,
      state: "degraded",
    });
  } catch {
    // The caller will expose only a fixed storage/service error.
  }
}

export function createTokscaleCollectorService(
  options: TokscaleCollectorServiceOptions,
): CompanionCollectorService {
  const clock = options.clock ?? (() => new Date());
  const uuid = options.uuid ?? randomUUID;
  const configDirIsValid =
    typeof options.configDir === "string" &&
    options.configDir.length >= 1 &&
    options.configDir.length <= 4_096 &&
    !options.configDir.includes("\0") &&
    isAbsolute(options.configDir);
  const binaryPathIsValid =
    options.binaryPath === undefined ||
    (typeof options.binaryPath === "string" &&
      options.binaryPath.length >= 1 &&
      options.binaryPath.length <= 4_096 &&
      !options.binaryPath.includes("\0") &&
      isAbsolute(options.binaryPath));
  const authorityError = prepareTokscaleAuthority(
    options.store,
    configDirIsValid && binaryPathIsValid,
  );
  if (authorityError !== null) {
    return createCompanionCollectorService({
      execution: {
        async scanDaily(): Promise<LocalDailyScanResult> {
          throw new Error("COLLECTOR_UNAVAILABLE");
        },
      },
      clock,
      onApplied: options.onApplied,
      unavailableErrorCode: authorityError ?? "local-service-error",
    });
  }

  let scanClock = new Date(0);
  try {
    const coordinator = createLocalScanCoordinator({
      collector: createTokscaleDailyCollector({
        configDir: options.configDir,
        ...(options.binaryPath === undefined
          ? {}
          : { binaryPath: options.binaryPath }),
      }),
      store: options.store,
      contribution: {
        readContributionState: () => Object.freeze({ status: "disabled" }),
      },
      clock: () => new Date(scanClock.getTime()),
      uuid,
    });
    return createCompanionCollectorService({
      execution: {
        async scanDaily(request, at): Promise<LocalDailyScanResult> {
          const configRoot = dirname(dirname(options.configDir));
          if (
            !(await verifyPrivateCollectorDirectory(
              configRoot,
              options.configDir,
            ))
          ) {
            degradeTokscaleAuthority(options.store);
            throw new CollectorCoreError("COLLECTOR_FAILED");
          }
          scanClock = new Date(at.getTime());
          return await coordinator.scanDaily(request);
        },
      },
      clock,
      onApplied: options.onApplied,
      recordCompleteScan: (input) => {
        options.store.recordCompleteDailyScan(input);
      },
      onFailure: (code) => {
        if (
          code === "collector-unavailable" ||
          code === "invalid-output" ||
          code === "storage-error"
        ) {
          degradeTokscaleAuthority(options.store);
        }
      },
      dispose: () => stopTokscaleAuthority(options.store),
    });
  } catch {
    degradeTokscaleAuthority(options.store);
    return createCompanionCollectorService({
      execution: {
        async scanDaily(): Promise<LocalDailyScanResult> {
          throw new Error("COLLECTOR_UNAVAILABLE");
        },
      },
      clock,
      onApplied: options.onApplied,
      unavailableErrorCode: "local-service-error",
      dispose: () => stopTokscaleAuthority(options.store),
    });
  }
}
