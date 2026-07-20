import {
  DeletionAcceptedResponseV1Schema,
  DeletionStatusResponseV1Schema,
  EnrollmentResponseV1Schema,
  EnrollmentResponseV2Schema,
  IngestReceiptV1Schema,
  PauseResponseV1Schema,
  ResumeResponseV1Schema,
  serializeContributionApiV1,
  serializeContributionEnrollmentV2
} from "@tokenmonster/contracts";
import {
  ApiDomainError,
  isApiDomainError,
  type DeleteCommand,
  type DeleteResult,
  type DeletionStatusCommand,
  type DeletionStatusResult,
  type EnrollmentCommand,
  type EnrollmentResult,
  type IngestCommand,
  type IngestResult,
  type PauseCommand,
  type PauseResult,
  type RateLimitRoute,
  type RecoverableEnrollmentCommand,
  type RecoverableEnrollmentResult,
  type ResumeCommand,
  type ResumeResult
} from "@tokenmonster/api-domain";
import type { Context, Hono } from "hono";

const MAX_MUTATION_BODY_BYTES = 64 * 1_024;
const MAX_MUTATION_BODY_CHUNKS = 1_024;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const AUTHORIZATION_PATTERN_BY_SCOPE = Object.freeze({
  upload:
    /^Bearer ((?:tm_u1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}|tm_u2_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]))$/u,
  deletion:
    /^Bearer ((?:tm_d1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}|tm_d2_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]))$/u,
  "deletion-status":
    /^Bearer (tm_s1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43})$/u
});
const CONTENT_LENGTH_PATTERN = /^\d+$/u;
const DELETION_JOB_ID_PATTERN = /^del_[A-Za-z0-9_-]{22}$/u;

export type MutationApiEnvironment = {
  Variables: {
    requestId: string;
  };
};

export type DeriveRateLimitKey = (
  request: Request,
  scope: RateLimitRoute
) => string | Promise<string>;

/**
 * These callbacks are the HTTP adapter's application boundary. A production
 * deploy adapter binds each callback to the matching api-domain use case and
 * its storage/crypto/rate-limit ports. Raw requests never enter domain code.
 */
export interface TokenMonsterMutationDependencies {
  readonly deriveRateLimitKey?: DeriveRateLimitKey;
  readonly enrollContributor?: (
    command: EnrollmentCommand
  ) => Promise<EnrollmentResult>;
  readonly enrollContributorRecoverably?: (
    command: RecoverableEnrollmentCommand
  ) => Promise<RecoverableEnrollmentResult>;
  readonly ingestSnapshot?: (command: IngestCommand) => Promise<IngestResult>;
  readonly pauseContribution?: (command: PauseCommand) => Promise<PauseResult>;
  readonly resumeContribution?: (
    command: ResumeCommand
  ) => Promise<ResumeResult>;
  readonly requestContributorDeletion?: (
    command: DeleteCommand
  ) => Promise<DeleteResult>;
  readonly getContributorDeletionStatus?: (
    command: DeletionStatusCommand
  ) => Promise<DeletionStatusResult>;
}

interface MutationProblemDetails {
  readonly type: "about:blank";
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  readonly requestId: string;
  readonly retryAfterSeconds?: number;
}

class BodyTooLargeError extends Error {
  override readonly name = "BodyTooLargeError";
}

function sanitizedRequestId(context: Context<MutationApiEnvironment>): string {
  const value = context.get("requestId");
  return SAFE_REQUEST_ID.test(value) ? value : "unavailable";
}

function fixedProblem(
  context: Context<MutationApiEnvironment>,
  input: Readonly<{
    title: string;
    status: number;
    detail: string;
    code: string;
    retryAfterSeconds?: number;
  }>
): Response {
  const base: MutationProblemDetails = {
    type: "about:blank",
    title: input.title,
    status: input.status,
    detail: input.detail,
    code: input.code,
    requestId: sanitizedRequestId(context),
    ...(input.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: input.retryAfterSeconds })
  };
  const headers = new Headers({
    "Content-Type": "application/problem+json; charset=UTF-8"
  });
  if (input.retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(input.retryAfterSeconds));
  }
  return new Response(JSON.stringify(base), {
    status: input.status,
    headers
  });
}

function mutationErrorResponse(
  context: Context<MutationApiEnvironment>,
  error: unknown
): Response {
  if (error instanceof BodyTooLargeError) {
    return fixedProblem(context, {
      title: "Request body too large",
      status: 413,
      detail: "Mutation request bodies are limited to 65536 bytes.",
      code: "BODY_TOO_LARGE"
    });
  }

  const domainError = isApiDomainError(error)
    ? error
    : new ApiDomainError("SERVICE_UNAVAILABLE");
  const details = domainError.toProblemDetails(
    sanitizedRequestId(context)
  );
  return fixedProblem(context, {
    title: details.title,
    status: details.status,
    detail: details.detail,
    code: details.code,
    ...(details.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: details.retryAfterSeconds })
  });
}

function requireDependency<T>(dependency: T | undefined): T {
  if (dependency === undefined) {
    throw new ApiDomainError("SERVICE_UNAVAILABLE");
  }
  return dependency;
}

function assertDeclaredBodySize(request: Request): void {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength === null) {
    return;
  }
  const normalized = contentLength.trim();
  if (!CONTENT_LENGTH_PATTERN.test(normalized)) {
    throw new ApiDomainError("SCHEMA_INVALID");
  }
  const significantDigits = normalized.replace(/^0+/u, "") || "0";
  if (
    significantDigits.length > String(MAX_MUTATION_BODY_BYTES).length ||
    Number(significantDigits) > MAX_MUTATION_BODY_BYTES
  ) {
    throw new BodyTooLargeError();
  }
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const body = request.body;
  if (body === null) {
    return new Uint8Array();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (result.value.byteLength === 0) {
        void reader.cancel().catch(() => undefined);
        throw new ApiDomainError("SCHEMA_INVALID");
      }
      chunkCount += 1;
      if (chunkCount > MAX_MUTATION_BODY_CHUNKS) {
        void reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      if (result.value.byteLength > MAX_MUTATION_BODY_BYTES - total) {
        void reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(result.value);
      total += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validJsonContentType(value: string | null): boolean {
  if (value === null) {
    return false;
  }
  const segments = value.split(";").map((segment) => segment.trim());
  const mediaType = segments.shift()?.toLowerCase();
  if (mediaType !== "application/json") {
    return false;
  }
  if (segments.length === 0) {
    return true;
  }
  return (
    segments.length === 1 &&
    /^charset\s*=\s*(?:"utf-8"|utf-8)$/iu.test(segments[0] ?? "")
  );
}

async function readStrictJson(request: Request): Promise<unknown> {
  if (!validJsonContentType(request.headers.get("Content-Type"))) {
    throw new ApiDomainError("SCHEMA_INVALID");
  }
  const bytes = await readBoundedBody(request);
  if (bytes.byteLength === 0) {
    throw new ApiDomainError("SCHEMA_INVALID");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiDomainError("SCHEMA_INVALID");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiDomainError("SCHEMA_INVALID");
  }
}

async function assertEmptyBody(request: Request): Promise<void> {
  const contentLength = request.headers.get("Content-Length");
  if (
    contentLength !== null &&
    (contentLength.trim().replace(/^0+/u, "") || "0") !== "0"
  ) {
    throw new ApiDomainError("SCHEMA_INVALID");
  }
  if ((await readBoundedBody(request)).byteLength !== 0) {
    throw new ApiDomainError("SCHEMA_INVALID");
  }
}

function parseDeletionStatusJobId(
  context: Context<MutationApiEnvironment>,
  request: Request
): string {
  const jobId = context.req.param("jobId");
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new ApiDomainError("SCHEMA_INVALID");
  }
  if (
    typeof jobId !== "string" ||
    !DELETION_JOB_ID_PATTERN.test(jobId) ||
    url.pathname !== `/v1/deletions/${jobId}` ||
    url.search !== "" ||
    url.href !== `${url.origin}/v1/deletions/${jobId}`
  ) {
    throw new ApiDomainError("SCHEMA_INVALID");
  }
  return jobId;
}

function assertFixedMutationTarget(request: Request, pathname: string): void {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new ApiDomainError("SCHEMA_INVALID");
  }
  if (
    url.pathname !== pathname ||
    url.search !== "" ||
    url.href !== `${url.origin}${pathname}`
  ) {
    throw new ApiDomainError("SCHEMA_INVALID");
  }
}

function assertSecureFixedMutationTarget(
  request: Request,
  pathname: string
): void {
  assertFixedMutationTarget(request, pathname);
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new ApiDomainError("SCHEMA_INVALID");
  }
  if (url.protocol !== "https:") {
    throw new ApiDomainError("SCHEMA_INVALID");
  }
}

function parseBearerAuthorization(
  request: Request,
  scope: keyof typeof AUTHORIZATION_PATTERN_BY_SCOPE
): string {
  const value = request.headers.get("Authorization");
  const match =
    value === null
      ? null
      : AUTHORIZATION_PATTERN_BY_SCOPE[scope].exec(value);
  if (match?.[1] === undefined) {
    throw new ApiDomainError("TOKEN_INVALID");
  }
  return match[1];
}

function contractResponse(
  body: string,
  status: number
): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8"
    }
  });
}

export function registerMutationRoutes(
  app: Hono<MutationApiEnvironment>,
  supplied: TokenMonsterMutationDependencies
): void {
  const dependencies: TokenMonsterMutationDependencies = Object.freeze({
    ...(supplied.deriveRateLimitKey === undefined
      ? {}
      : { deriveRateLimitKey: supplied.deriveRateLimitKey }),
    ...(supplied.enrollContributor === undefined
      ? {}
      : { enrollContributor: supplied.enrollContributor }),
    ...(supplied.enrollContributorRecoverably === undefined
      ? {}
      : {
          enrollContributorRecoverably:
            supplied.enrollContributorRecoverably
        }),
    ...(supplied.ingestSnapshot === undefined
      ? {}
      : { ingestSnapshot: supplied.ingestSnapshot }),
    ...(supplied.pauseContribution === undefined
      ? {}
      : { pauseContribution: supplied.pauseContribution }),
    ...(supplied.resumeContribution === undefined
      ? {}
      : { resumeContribution: supplied.resumeContribution }),
    ...(supplied.requestContributorDeletion === undefined
      ? {}
      : {
          requestContributorDeletion: supplied.requestContributorDeletion
        }),
    ...(supplied.getContributorDeletionStatus === undefined
      ? {}
      : {
          getContributorDeletionStatus:
            supplied.getContributorDeletionStatus
        })
  });

  app.post("/v1/enrollments", async (context) => {
    try {
      const request = context.req.raw;
      assertDeclaredBodySize(request);
      assertFixedMutationTarget(request, "/v1/enrollments");
      const deriveRateLimitKey = requireDependency(
        dependencies.deriveRateLimitKey
      );
      const execute = requireDependency(dependencies.enrollContributor);
      const rateLimitKey = await deriveRateLimitKey(request, "enrollment");
      const body = await readStrictJson(request);
      const result = await execute({ body, rateLimitKey });
      return contractResponse(
        serializeContributionApiV1(EnrollmentResponseV1Schema, result),
        201
      );
    } catch (error: unknown) {
      return mutationErrorResponse(context, error);
    }
  });

  app.post("/v2/enrollments", async (context) => {
    try {
      const request = context.req.raw;
      assertDeclaredBodySize(request);
      assertSecureFixedMutationTarget(request, "/v2/enrollments");
      const deriveRateLimitKey = requireDependency(
        dependencies.deriveRateLimitKey
      );
      const execute = requireDependency(
        dependencies.enrollContributorRecoverably
      );
      const rateLimitKey = await deriveRateLimitKey(request, "enrollment");
      const body = await readStrictJson(request);
      const result = await execute({ body, rateLimitKey });
      return contractResponse(
        serializeContributionEnrollmentV2(
          EnrollmentResponseV2Schema,
          result
        ),
        201
      );
    } catch (error: unknown) {
      return mutationErrorResponse(context, error);
    }
  });

  app.post("/v1/me/ingest-snapshots", async (context) => {
    try {
      const request = context.req.raw;
      assertDeclaredBodySize(request);
      assertFixedMutationTarget(request, "/v1/me/ingest-snapshots");
      const bearerToken = parseBearerAuthorization(request, "upload");
      const deriveRateLimitKey = requireDependency(
        dependencies.deriveRateLimitKey
      );
      const execute = requireDependency(dependencies.ingestSnapshot);
      const rateLimitKey = await deriveRateLimitKey(request, "ingest");
      const snapshot = await readStrictJson(request);
      const result = await execute({
        bearerToken,
        idempotencyKey: request.headers.get("Idempotency-Key") ?? "",
        snapshot,
        rateLimitKey
      });
      const parsed = IngestReceiptV1Schema.parse(result);
      return contractResponse(
        serializeContributionApiV1(IngestReceiptV1Schema, parsed),
        parsed.status === "quarantined" ? 202 : 200
      );
    } catch (error: unknown) {
      return mutationErrorResponse(context, error);
    }
  });

  app.post("/v1/me/pause", async (context) => {
    try {
      const request = context.req.raw;
      assertDeclaredBodySize(request);
      assertFixedMutationTarget(request, "/v1/me/pause");
      const bearerToken = parseBearerAuthorization(request, "upload");
      const deriveRateLimitKey = requireDependency(
        dependencies.deriveRateLimitKey
      );
      const execute = requireDependency(dependencies.pauseContribution);
      const rateLimitKey = await deriveRateLimitKey(request, "lifecycle");
      await assertEmptyBody(request);
      const result = await execute({ bearerToken, rateLimitKey });
      return contractResponse(
        serializeContributionApiV1(PauseResponseV1Schema, result),
        200
      );
    } catch (error: unknown) {
      return mutationErrorResponse(context, error);
    }
  });

  app.post("/v1/me/resume", async (context) => {
    try {
      const request = context.req.raw;
      assertDeclaredBodySize(request);
      assertFixedMutationTarget(request, "/v1/me/resume");
      const bearerToken = parseBearerAuthorization(request, "upload");
      const deriveRateLimitKey = requireDependency(
        dependencies.deriveRateLimitKey
      );
      const execute = requireDependency(dependencies.resumeContribution);
      const rateLimitKey = await deriveRateLimitKey(request, "lifecycle");
      const body = await readStrictJson(request);
      const result = await execute({ bearerToken, body, rateLimitKey });
      const parsed = ResumeResponseV1Schema.parse(result);
      if (parsed.consentReceipt.granted !== true) {
        throw new ApiDomainError("SERVICE_UNAVAILABLE");
      }
      return contractResponse(
        serializeContributionApiV1(ResumeResponseV1Schema, parsed),
        200
      );
    } catch (error: unknown) {
      return mutationErrorResponse(context, error);
    }
  });

  app.delete("/v1/me/data", async (context) => {
    try {
      const request = context.req.raw;
      assertDeclaredBodySize(request);
      assertFixedMutationTarget(request, "/v1/me/data");
      const bearerToken = parseBearerAuthorization(request, "deletion");
      const deriveRateLimitKey = requireDependency(
        dependencies.deriveRateLimitKey
      );
      const execute = requireDependency(
        dependencies.requestContributorDeletion
      );
      const rateLimitKey = await deriveRateLimitKey(request, "delete");
      await assertEmptyBody(request);
      const result = await execute({
        bearerToken,
        idempotencyKey: request.headers.get("Idempotency-Key") ?? "",
        rateLimitKey
      });
      return contractResponse(
        serializeContributionApiV1(DeletionAcceptedResponseV1Schema, result),
        202
      );
    } catch (error: unknown) {
      return mutationErrorResponse(context, error);
    }
  });

  app.get("/v1/deletions/:jobId", async (context) => {
    try {
      const request = context.req.raw;
      assertDeclaredBodySize(request);
      const bearerToken = parseBearerAuthorization(
        request,
        "deletion-status"
      );
      const jobId = parseDeletionStatusJobId(context, request);
      await assertEmptyBody(request);
      const execute = requireDependency(
        dependencies.getContributorDeletionStatus
      );
      const result = await execute({ bearerToken, jobId });
      return contractResponse(
        serializeContributionApiV1(DeletionStatusResponseV1Schema, result),
        200
      );
    } catch (error: unknown) {
      return mutationErrorResponse(context, error);
    }
  });
}
