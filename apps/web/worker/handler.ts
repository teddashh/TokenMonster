import {
  createCloudflareApiWorker,
  createCloudflareDurableMutationPorts,
  type CloudflareApiEnvironment,
  type CloudflareDurableObjectNamespaceLike,
  type CloudflareMutationRuntimePorts,
  type CloudflareApiWorker,
} from "@tokenmonster/api";
import {
  createD1AnonymousCompactionProcessor,
  createD1DeletionMaintenanceProcessor,
  createD1MutationStorage,
  createD1PublicProjectionRebuilder,
  createD1RetentionMaintenanceProcessor,
  createD1RetentionMaintenanceStorage,
  type D1MutationDatabaseLike,
} from "@tokenmonster/cloud-d1";
import {
  PUBLIC_RELEASE_ENDPOINT,
  publicReleaseFromEnvironment,
} from "../src/public-release.js";

export interface TokenMonsterWorkerEnvironment
  extends CloudflareApiEnvironment {
  readonly TOKENMONSTER_DB?: D1MutationDatabaseLike;
  readonly TOKENMONSTER_RATE_LIMIT_DO?: unknown;
  readonly TOKENMONSTER_SUPPRESSION_LEDGER_DO?: unknown;
  readonly TOKENMONSTER_PUBLIC_RELEASE_JSON?: unknown;
}

export interface TokenMonsterScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
}

export interface TokenMonsterExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

function projectionDatabase(input: unknown): D1MutationDatabaseLike | null {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      typeof (input as { prepare?: unknown }).prepare !== "function" ||
      typeof (input as { batch?: unknown }).batch !== "function" ||
      typeof (input as { withSession?: unknown }).withSession !== "function"
    ) {
      return null;
    }
    return input as D1MutationDatabaseLike;
  } catch {
    return null;
  }
}

function durableNamespace(
  input: unknown,
): CloudflareDurableObjectNamespaceLike | null {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      typeof (input as { getByName?: unknown }).getByName !== "function"
    ) {
      return null;
    }
    return input as CloudflareDurableObjectNamespaceLike;
  } catch {
    return null;
  }
}

function durableMutationPorts(
  environment: TokenMonsterWorkerEnvironment,
): Required<CloudflareMutationRuntimePorts> | null {
  try {
    const rateLimit = durableNamespace(
      environment.TOKENMONSTER_RATE_LIMIT_DO,
    );
    const suppression = durableNamespace(
      environment.TOKENMONSTER_SUPPRESSION_LEDGER_DO,
    );
    return rateLimit === null || suppression === null
      ? null
      : createCloudflareDurableMutationPorts(rateLimit, suppression);
  } catch {
    return null;
  }
}

const mutationDisabledWorker = createCloudflareApiWorker();
const environmentWorkers = new WeakMap<object, CloudflareApiWorker>();

function apiWorkerFor(
  environment: TokenMonsterWorkerEnvironment,
): CloudflareApiWorker {
  if (environment === null || typeof environment !== "object") {
    return mutationDisabledWorker;
  }
  const cached = environmentWorkers.get(environment);
  if (cached !== undefined) return cached;
  const ports = durableMutationPorts(environment);
  const worker =
    ports === null ? mutationDisabledWorker : createCloudflareApiWorker(ports);
  environmentWorkers.set(environment, worker);
  return worker;
}

async function runScheduledMaintenance(
  database: D1MutationDatabaseLike,
  scheduledTime: number,
): Promise<void> {
  const storage = createD1MutationStorage(database);
  const processDeletions = createD1DeletionMaintenanceProcessor(storage, {
    maxJobs: 25,
    now: () => new Date(scheduledTime),
  });
  const compactAnonymousDay = createD1AnonymousCompactionProcessor(database, {
    now: () => new Date(scheduledTime),
  });
  const rebuildProjection = createD1PublicProjectionRebuilder(database, {
    now: () => new Date(scheduledTime),
  });
  const enforceRetention = createD1RetentionMaintenanceProcessor(
    createD1RetentionMaintenanceStorage(database, {
      preserveCompactionInputs: true,
    }),
    {
      maxRecords: 100,
      now: () => new Date(scheduledTime),
    },
  );
  let failed = false;
  let deletionSucceeded = false;
  try {
    await processDeletions();
    deletionSucceeded = true;
  } catch {
    failed = true;
  }
  // A failed deletion page may leave a contributor's revocation pending.
  // Do not irreversibly anonymize that contributor's raw day until deletion
  // has had a successful pass. Other bounded maintenance remains safe.
  if (deletionSucceeded) {
    try {
      await compactAnonymousDay();
    } catch {
      failed = true;
    }
  }
  try {
    await enforceRetention();
  } catch {
    failed = true;
  }
  try {
    await rebuildProjection();
  } catch {
    failed = true;
  }
  if (failed) throw new Error("scheduled cloud maintenance failed");
}

export const tokenMonsterWorker = Object.freeze({
  fetch(
    request: Request,
    environment: TokenMonsterWorkerEnvironment = {},
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === PUBLIC_RELEASE_ENDPOINT) {
      if (url.search !== "") {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (request.method !== "GET") {
        return Promise.resolve(
          new Response(null, { status: 405, headers: { Allow: "GET" } }),
        );
      }
      if (
        !Object.prototype.hasOwnProperty.call(
          environment,
          "TOKENMONSTER_PUBLIC_RELEASE_JSON",
        )
      ) {
        return Promise.resolve(
          Response.json(
            { error: "PUBLIC_RELEASE_NOT_CONFIGURED" },
            {
              status: 404,
              headers: {
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
              },
            },
          ),
        );
      }
      try {
        const release = publicReleaseFromEnvironment(environment);
        return Promise.resolve(
          Response.json(release, {
            status: 200,
            headers: {
              "Cache-Control": "public, max-age=60",
              "X-Content-Type-Options": "nosniff",
            },
          }),
        );
      } catch {
        return Promise.resolve(
          Response.json(
            { error: "PUBLIC_RELEASE_UNAVAILABLE" },
            {
              status: 503,
              headers: {
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
              },
            },
          ),
        );
      }
    }
    return apiWorkerFor(environment).fetch(request, environment);
  },

  scheduled(
    controller: TokenMonsterScheduledController,
    environment: TokenMonsterWorkerEnvironment,
    context: TokenMonsterExecutionContext,
  ): void {
    const database = projectionDatabase(environment.TOKENMONSTER_DB);
    if (database === null) return;
    context.waitUntil(
      runScheduledMaintenance(database, controller.scheduledTime),
    );
  },
});

export default tokenMonsterWorker;
