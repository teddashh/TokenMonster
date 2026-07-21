import {
  CloudflareClock,
  CloudflareOpaqueIdGenerator,
  createCloudflareContributionPolicy,
  createCloudflareCredentialService,
  createNonReversibleRateLimitKeyDeriver,
  type CloudflareCredentialServiceConfig,
  type CloudflareRateLimitKeyConfig,
  type NonReversibleRateLimitKeyDeriver
} from "@tokenmonster/api-cloudflare";
import {
  enrollContributor,
  enrollContributorRecoverably,
  getContributorDeletionStatus,
  ingestSnapshot,
  pauseContribution,
  requestContributorDeletion,
  resumeContribution,
  type DeleteCommand,
  type DeletionStatusCommand,
  type EnrollmentCommand,
  type IngestCommand,
  type PauseCommand,
  type RateLimitPort,
  type RateLimitRoute,
  type RecoverableEnrollmentCommand,
  type ResumeCommand,
  type SuppressionLedgerPort
} from "@tokenmonster/api-domain";
import {
  createD1MutationStorage,
  createD1PublicTotalsReader,
  type D1DatabaseLike,
  type D1MutationDatabaseLike
} from "@tokenmonster/cloud-d1";
import { PERMANENT_SIDECAR_COLLECTOR_IDENTITY_V2 } from "@tokenmonster/contracts";

import {
  createTokenMonsterApi,
  type TokenMonsterApi,
  type TokenMonsterApiDependencies
} from "./index.js";

const CONSENT_REVISION = "contribution-2026-07-15";
const MAX_SECRET_CONFIG_BYTES = 8 * 1_024;
const EXACT_BEARER = /^Bearer ([^\s,]{32,512})$/u;
const EDGE_ADDRESS = /^(?:(?:[0-9]{1,3}\.){3}[0-9]{1,3}|[0-9A-Fa-f:]{2,64})$/u;

export interface CloudflareApiEnvironment {
  readonly TOKENMONSTER_DB?: unknown;
  readonly TOKENMONSTER_MUTATIONS_ENABLED?: unknown;
  readonly TOKENMONSTER_CREDENTIAL_CONFIG_JSON?: unknown;
  readonly TOKENMONSTER_RATE_KEY_CONFIG_JSON?: unknown;
  readonly TOKENMONSTER_ALLOWED_PUBLIC_ORIGIN?: unknown;
}

/**
 * These ports require durable, production-owned implementations. This
 * package intentionally provides no in-memory or process-local fallback.
 */
export interface CloudflareMutationRuntimePorts {
  readonly rateLimit?: RateLimitPort;
  readonly suppressionLedger?: SuppressionLedgerPort;
}

export interface CloudflareApiWorker {
  fetch(
    request: Request,
    env: CloudflareApiEnvironment,
    context?: unknown
  ): Promise<Response>;
}

type ParsedEnvironment = Readonly<{
  allowedPublicOrigin?: string;
  mutationConfig:
    | Readonly<{
        credentials: CloudflareCredentialServiceConfig;
        rateKeys: CloudflareRateLimitKeyConfig;
      }>
    | null;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownValue(
  env: CloudflareApiEnvironment,
  key: keyof CloudflareApiEnvironment
): unknown {
  try {
    return Object.hasOwn(env, key) ? env[key] : undefined;
  } catch {
    return undefined;
  }
}

function parseAllowedOrigin(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || input.length > 256) {
    throw new Error("invalid environment");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("invalid environment");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin !== input
  ) {
    throw new Error("invalid environment");
  }
  return url.origin;
}

function parseBoundedJson(input: unknown): unknown {
  if (
    typeof input !== "string" ||
    input.length < 2 ||
    input.length > MAX_SECRET_CONFIG_BYTES ||
    new TextEncoder().encode(input).byteLength > MAX_SECRET_CONFIG_BYTES
  ) {
    throw new Error("invalid environment");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw new Error("invalid environment");
  }
  if (!isRecord(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw new Error("invalid environment");
  }
  return parsed;
}

function parseEnvironment(env: CloudflareApiEnvironment): ParsedEnvironment {
  if (!isRecord(env)) throw new Error("invalid environment");
  const allowedPublicOrigin = parseAllowedOrigin(
    ownValue(env, "TOKENMONSTER_ALLOWED_PUBLIC_ORIGIN")
  );
  const mutationFlag = ownValue(env, "TOKENMONSTER_MUTATIONS_ENABLED");
  if (
    mutationFlag !== undefined &&
    mutationFlag !== "false" &&
    mutationFlag !== "true"
  ) {
    throw new Error("invalid environment");
  }
  if (mutationFlag !== "true") {
    return Object.freeze({
      ...(allowedPublicOrigin === undefined ? {} : { allowedPublicOrigin }),
      mutationConfig: null
    });
  }
  const credentials = parseBoundedJson(
    ownValue(env, "TOKENMONSTER_CREDENTIAL_CONFIG_JSON")
  ) as CloudflareCredentialServiceConfig;
  const rateKeys = parseBoundedJson(
    ownValue(env, "TOKENMONSTER_RATE_KEY_CONFIG_JSON")
  ) as CloudflareRateLimitKeyConfig;
  return Object.freeze({
    ...(allowedPublicOrigin === undefined ? {} : { allowedPublicOrigin }),
    mutationConfig: Object.freeze({ credentials, rateKeys })
  });
}

function asPublicDatabase(input: unknown): D1DatabaseLike | null {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      typeof (input as { prepare?: unknown }).prepare !== "function"
    ) {
      return null;
    }
    return input as D1DatabaseLike;
  } catch {
    return null;
  }
}

function asMutationDatabase(input: unknown): D1MutationDatabaseLike | null {
  try {
    if (
      asPublicDatabase(input) === null ||
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

function validRuntimePorts(
  input: CloudflareMutationRuntimePorts
): input is Required<CloudflareMutationRuntimePorts> {
  try {
    return (
      typeof input.rateLimit === "object" &&
      input.rateLimit !== null &&
      typeof input.rateLimit.consume === "function" &&
      typeof input.suppressionLedger === "object" &&
      input.suppressionLedger !== null &&
      typeof input.suppressionLedger.record === "function" &&
      typeof input.suppressionLedger.listActive === "function"
    );
  } catch {
    return false;
  }
}

function assertAllPurposeKeysDistinct(
  input: NonNullable<ParsedEnvironment["mutationConfig"]>
): void {
  const keys = [
    input.credentials.currentPepper,
    ...(input.credentials.previousPepper === undefined
      ? []
      : [input.credentials.previousPepper]),
    input.credentials.deletionStatusDerivationKey,
    input.credentials.suppressionKey,
    input.rateKeys.enrollmentEdgeKey,
    input.rateKeys.ingestTokenKey,
    input.rateKeys.deletionTokenKey
  ];
  if (
    new Set(keys.map(({ keyId }) => keyId)).size !== keys.length ||
    new Set(keys.map(({ secret }) => secret)).size !== keys.length
  ) {
    throw new Error("key separation invalid");
  }
}

function bearerFromRequest(request: Request): string {
  const value = request.headers.get("Authorization");
  const match = value === null ? null : EXACT_BEARER.exec(value);
  if (match?.[1] === undefined) throw new Error("invalid request");
  return match[1];
}

function createRateKeyBoundary(
  deriver: NonReversibleRateLimitKeyDeriver
): NonNullable<TokenMonsterApiDependencies["deriveRateLimitKey"]> {
  return async (request: Request, scope: RateLimitRoute): Promise<string> => {
    if (scope === "enrollment") {
      const edgeInput = request.headers.get("CF-Connecting-IP");
      if (edgeInput === null || !EDGE_ADDRESS.test(edgeInput)) {
        throw new Error("missing edge identity");
      }
      return deriver.deriveEnrollmentEdgeKey(edgeInput);
    }
    const bearer = bearerFromRequest(request);
    return scope === "delete"
      ? deriver.deriveDeletionTokenKey(bearer)
      : deriver.deriveIngestTokenKey(bearer);
  };
}

async function mutationDependencies(
  env: CloudflareApiEnvironment,
  parsed: ParsedEnvironment,
  runtimePorts: CloudflareMutationRuntimePorts
): Promise<Pick<
  TokenMonsterApiDependencies,
  | "deriveRateLimitKey"
  | "enrollContributor"
  | "enrollContributorRecoverably"
  | "getContributorDeletionStatus"
  | "ingestSnapshot"
  | "pauseContribution"
  | "requestContributorDeletion"
  | "resumeContribution"
> | null> {
  if (parsed.mutationConfig === null || !validRuntimePorts(runtimePorts)) {
    return null;
  }
  const database = asMutationDatabase(ownValue(env, "TOKENMONSTER_DB"));
  if (database === null) return null;
  try {
    assertAllPurposeKeysDistinct(parsed.mutationConfig);
    const credentials = await createCloudflareCredentialService(
      parsed.mutationConfig.credentials
    );
    const rateKeyDeriver = await createNonReversibleRateLimitKeyDeriver(
      parsed.mutationConfig.rateKeys
    );
    const policy = createCloudflareContributionPolicy({
      currentConsentDocumentRevision: CONSENT_REVISION,
      supportedCollectors: [
        {
          kind: "tokscale",
          adapterVersion: "0.1.0",
          sourceVersion: "4.5.2"
        },
        PERMANENT_SIDECAR_COLLECTOR_IDENTITY_V2
      ]
    });
    const clock = Object.freeze(new CloudflareClock());
    const ids = Object.freeze(new CloudflareOpaqueIdGenerator());
    const storage = createD1MutationStorage(database);
    const deriveRateLimitKey = createRateKeyBoundary(rateKeyDeriver);
    return Object.freeze({
      deriveRateLimitKey,
      enrollContributor: (command: EnrollmentCommand) =>
        enrollContributor(command, {
          clock,
          ids,
          credentials,
          policy,
          rateLimit: runtimePorts.rateLimit,
          storage
        }),
      enrollContributorRecoverably: (command: RecoverableEnrollmentCommand) =>
        enrollContributorRecoverably(command, {
          clock,
          ids,
          credentials,
          policy,
          rateLimit: runtimePorts.rateLimit,
          storage
        }),
      ingestSnapshot: (command: IngestCommand) =>
        ingestSnapshot(command, {
          clock,
          credentials,
          policy,
          rateLimit: runtimePorts.rateLimit,
          storage
        }),
      pauseContribution: (command: PauseCommand) =>
        pauseContribution(command, {
          clock,
          credentials,
          rateLimit: runtimePorts.rateLimit,
          storage
        }),
      resumeContribution: (command: ResumeCommand) =>
        resumeContribution(command, {
          clock,
          ids,
          credentials,
          policy,
          rateLimit: runtimePorts.rateLimit,
          storage
        }),
      getContributorDeletionStatus: (command: DeletionStatusCommand) =>
        getContributorDeletionStatus(command, {
          clock,
          credentials,
          storage
        }),
      requestContributorDeletion: (command: DeleteCommand) =>
        requestContributorDeletion(command, {
          clock,
          ids,
          credentials,
          rateLimit: runtimePorts.rateLimit,
          storage,
          suppressionLedger: runtimePorts.suppressionLedger
        })
    });
  } catch {
    return null;
  }
}

function unavailablePublicReader(): Promise<null> {
  return Promise.resolve(null);
}

export async function composeCloudflareTokenMonsterApi(
  env: CloudflareApiEnvironment,
  runtimePorts: CloudflareMutationRuntimePorts = {}
): Promise<TokenMonsterApi> {
  const database = asPublicDatabase(ownValue(env, "TOKENMONSTER_DB"));
  const readFromD1 =
    database === null ? unavailablePublicReader : createD1PublicTotalsReader(database);
  const readPublicTotals = async (): Promise<unknown> => {
    try {
      return await readFromD1();
    } catch {
      return null;
    }
  };

  let parsed: ParsedEnvironment;
  let mutations: Awaited<ReturnType<typeof mutationDependencies>> = null;
  try {
    parsed = parseEnvironment(env);
    mutations = await mutationDependencies(env, parsed, runtimePorts);
  } catch {
    parsed = Object.freeze({ mutationConfig: null });
  }

  return createTokenMonsterApi({
    readPublicTotals,
    ...(parsed.allowedPublicOrigin === undefined
      ? {}
      : { allowedPublicOrigin: parsed.allowedPublicOrigin }),
    ...(mutations ?? {})
  });
}

/**
 * Returns a Worker-shaped handler. The default has no durable quota or
 * suppression ports, so mutation routes remain disabled until the deploy
 * composition explicitly supplies both ports and enables the strict env gate.
 */
export function createCloudflareApiWorker(
  runtimePorts: CloudflareMutationRuntimePorts = {}
): CloudflareApiWorker {
  const apps = new WeakMap<object, Promise<TokenMonsterApi>>();
  return Object.freeze({
    async fetch(
      request: Request,
      env: CloudflareApiEnvironment
    ): Promise<Response> {
      if (!isRecord(env)) {
        const app = await composeCloudflareTokenMonsterApi({});
        return app.fetch(request);
      }
      let pending = apps.get(env);
      if (pending === undefined) {
        pending = composeCloudflareTokenMonsterApi(env, runtimePorts);
        apps.set(env, pending);
      }
      const app = await pending;
      return app.fetch(request);
    }
  });
}

export const cloudflareApiWorker = createCloudflareApiWorker();

export default cloudflareApiWorker;
