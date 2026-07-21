import { isAbsolute, join } from "node:path";

import type { CompanionContributionController } from "@tokenmonster/companion-gateway";
import {
  createContributionService,
  createContributionSyncScheduler,
  refreshSidecarContributionProjection,
  type ContributionCredentialHost,
  type ContributionSyncResult,
} from "@tokenmonster/contribution-runtime";
import { openLocalStore, type LocalStore } from "@tokenmonster/local-store";
import type { TokenTrackerAdapter } from "@tokenmonster/token-tracker-adapter";

export const TOKENMONSTER_CONTRIBUTION_API_ORIGIN =
  "https://api.tokenmonster.app" as const;

export interface CliContributionRuntimeOptions {
  readonly credentialHost: ContributionCredentialHost;
  readonly stateDirectory: string;
  readonly adapter: TokenTrackerAdapter;
  readonly clock?: () => Date;
}

export interface CliContributionRuntime {
  readonly controller: CompanionContributionController;
  close(): Promise<void>;
}

function validOptions(value: unknown): value is CliContributionRuntimeOptions {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).some(
      (key) =>
        key !== "credentialHost" &&
        key !== "stateDirectory" &&
        key !== "adapter" &&
        key !== "clock",
    )
  ) {
    return false;
  }
  const options = value as Partial<CliContributionRuntimeOptions>;
  return (
    typeof options.credentialHost?.openCredentialSlots === "function" &&
    typeof options.stateDirectory === "string" &&
    options.stateDirectory.length > 0 &&
    options.stateDirectory.length <= 4_096 &&
    isAbsolute(options.stateDirectory) &&
    !options.stateDirectory.includes("\0") &&
    typeof options.adapter?.getDailyContentBlindFootprint === "function" &&
    (options.clock === undefined || typeof options.clock === "function")
  );
}

export async function createCliContributionRuntime(
  options: CliContributionRuntimeOptions,
): Promise<CliContributionRuntime> {
  if (!validOptions(options)) {
    throw new TypeError("Invalid CLI contribution runtime options");
  }
  const clock = options.clock ?? (() => new Date());
  const credentialDirectory = join(options.stateDirectory, "contribution-v2");
  const slots = options.credentialHost.openCredentialSlots(credentialDirectory);
  let store: LocalStore | null = null;
  let disposed = false;
  const operations = new Set<Promise<unknown>>();
  const trackOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    if (disposed) {
      return Promise.reject(new Error("CONTRIBUTION_RUNTIME_CLOSING"));
    }
    let tracked!: Promise<T>;
    tracked = Promise.resolve()
      .then(operation)
      .finally(() => operations.delete(tracked));
    operations.add(tracked);
    return tracked;
  };
  try {
    store = await openLocalStore({
      path: join(options.stateDirectory, "contribution-v2.sqlite"),
      clock,
    });
    const contribution = createContributionService({
      store,
      ...slots,
      configuredBaseUrl: TOKENMONSTER_CONTRIBUTION_API_ORIGIN,
      clock,
    });
    await contribution.initialize();

    const syncWithProjection = (): Promise<ContributionSyncResult> =>
      trackOperation(async () => {
        try {
          await refreshSidecarContributionProjection(
            options.adapter,
            store!,
            clock(),
          );
        } catch {
          return Object.freeze({
            ok: false,
            code: "local-service-error" as const,
            uploadedBatches: 0,
            status: contribution.status(),
          });
        }
        return contribution.sync();
      });
    const scheduler = createContributionSyncScheduler({
      contribution: Object.freeze({
        status: contribution.status,
        sync: syncWithProjection,
      }),
    });
    scheduler.start();

    const controller: CompanionContributionController = Object.freeze({
      status: contribution.status,
      preparePreview: () =>
        trackOperation(async () => {
          await refreshSidecarContributionProjection(
            options.adapter,
            store!,
            clock(),
          );
          return contribution.preparePreview();
        }),
      enable: (previewId: string) =>
        trackOperation(async () => {
          const result = await contribution.enable(previewId);
          if (result.status.enabled) scheduler.wake();
          return result;
        }),
      stop: () =>
        trackOperation(async () => {
          scheduler.pause();
          // Stop is a hard local scheduling boundary even when vault or network
          // cleanup fails. Only an explicit enable/recover-active may wake it.
          return contribution.stop();
        }),
      requestDeletion: () =>
        trackOperation(async () => {
          scheduler.pause();
          // A delete invocation is a hard local stop even when secure storage or
          // the remote response fails. Only a later explicit enable may wake it.
          return contribution.requestDeletion();
        }),
      recover: () =>
        trackOperation(async () => {
          const result = await contribution.recover();
          if (result.status.enabled) scheduler.wake();
          else scheduler.pause();
          return result;
        }),
    });

    return Object.freeze({
      controller,
      async close(): Promise<void> {
        if (disposed) return;
        disposed = true;
        scheduler.dispose();
        contribution.dispose();
        const quiescence = contribution.quiesce();
        while (operations.size > 0) {
          await Promise.allSettled([...operations]);
        }
        await quiescence;
        store?.close();
        store = null;
      },
    });
  } catch (error) {
    store?.close();
    throw error;
  }
}
