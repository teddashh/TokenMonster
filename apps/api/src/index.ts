import { Hono, type Context } from "hono";
import { PERMANENT_SIDECAR_COLLECTOR_IDENTITY_V2 } from "@tokenmonster/contracts";

import {
  registerMutationRoutes,
  type MutationApiEnvironment,
  type TokenMonsterMutationDependencies
} from "./mutation-routes.js";

const CONTRACT_VERSION = "1";
const CONSENT_REVISION = "contribution-2026-07-15";
const PUBLIC_LABEL = "TokenMonster 貢獻者已分享的 Token 總量";
const PUBLIC_DISCLAIMER =
  "只包含自願匿名分享者，不代表全球所有 AI 使用量。";
const MAX_PUBLIC_TOTALS_AGE_MS = 10 * 60 * 1_000;
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,18})$/;
const ISO_INSTANT_PATTERN =
  /^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/;
const PUBLIC_TOTALS_FIELDS = [
  "allTimeTokens",
  "contributors",
  "dataRevision",
  "generatedAt",
  "todayUtcTokens"
] as const;
const PUBLIC_TOTALS_FIELD_SET = new Set<string>(PUBLIC_TOTALS_FIELDS);

type ApiEnvironment = MutationApiEnvironment;

export interface PublicTotalsSnapshot {
  readonly allTimeTokens: string;
  readonly todayUtcTokens: string;
  readonly contributors: string;
  readonly generatedAt: string;
  readonly dataRevision: string;
}

export interface TokenMonsterApiDependencies
  extends TokenMonsterMutationDependencies {
  readonly readPublicTotals: () => Promise<unknown>;
  readonly createRequestId: () => string;
  readonly now: () => Date;
  readonly allowedPublicOrigin?: string;
}

export interface PublicTotalsResponse extends PublicTotalsSnapshot {
  readonly contractVersion: 1;
  readonly label: typeof PUBLIC_LABEL;
  readonly disclaimer: typeof PUBLIC_DISCLAIMER;
}

interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  readonly requestId: string;
}

type ProblemStatus = 400 | 404 | 500 | 503;

function defaultRequestId(): string {
  return crypto.randomUUID();
}

function canonicalUnsignedInt64(value: string): boolean {
  return DECIMAL_PATTERN.test(value) && BigInt(value) <= MAX_SIGNED_INT64;
}

function canonicalInstant(value: string): boolean {
  if (!ISO_INSTANT_PATTERN.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  const canonical = new Date(timestamp).toISOString();
  return canonical === value || canonical.replace(".000Z", "Z") === value;
}

function validDataRevision(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validPublicTotals(
  value: unknown,
  now: Date
): value is PublicTotalsSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  const actualFields = Object.keys(value);
  if (
    actualFields.length !== PUBLIC_TOTALS_FIELDS.length ||
    actualFields.some((field) => !PUBLIC_TOTALS_FIELD_SET.has(field)) ||
    PUBLIC_TOTALS_FIELDS.some((field) => !Object.hasOwn(value, field)) ||
    typeof value["allTimeTokens"] !== "string" ||
    typeof value["todayUtcTokens"] !== "string" ||
    typeof value["contributors"] !== "string" ||
    typeof value["generatedAt"] !== "string"
  ) {
    return false;
  }

  const countsAreValid =
    canonicalUnsignedInt64(value["allTimeTokens"]) &&
    canonicalUnsignedInt64(value["todayUtcTokens"]) &&
    canonicalUnsignedInt64(value["contributors"]);
  if (!countsAreValid) {
    return false;
  }

  const generatedAt = Date.parse(value["generatedAt"]);
  return (
    BigInt(value["todayUtcTokens"]) <= BigInt(value["allTimeTokens"]) &&
    BigInt(value["contributors"]) <= BigInt(value["allTimeTokens"]) &&
    canonicalInstant(value["generatedAt"]) &&
    Number.isFinite(now.getTime()) &&
    generatedAt >= now.getTime() - MAX_PUBLIC_TOTALS_AGE_MS &&
    generatedAt <= now.getTime() + 5 * 60 * 1_000 &&
    validDataRevision(value["dataRevision"])
  );
}

async function responseEtag(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `"${hex}"`;
}

function ifNoneMatchIncludes(
  headerValue: string | undefined,
  currentEtag: string
): boolean {
  if (headerValue === undefined) {
    return false;
  }
  if (headerValue.trim() === "*") {
    return true;
  }
  const candidates = headerValue.match(/(?:W\/)?"[^"]*"/gu);
  if (candidates === null) {
    return false;
  }
  return candidates.some(
    (candidate) => candidate.replace(/^W\//u, "") === currentEtag
  );
}

function problem(
  context: Context<ApiEnvironment>,
  status: ProblemStatus,
  code: string,
  title: string,
  detail: string
): Response {
  const body: ProblemDetails = {
    type: `urn:tokenmonster:problem:${code.toLowerCase()}`,
    title,
    status,
    detail,
    code,
    requestId: context.get("requestId")
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/problem+json; charset=UTF-8"
    }
  });
}

function consentDocument(locale: "zh-TW" | "en") {
  const isChinese = locale === "zh-TW";
  return {
    contractVersion: 1,
    purpose: "contribution",
    revision: CONSENT_REVISION,
    locale,
    title: isChinese
      ? "自願分享匿名 Token 日彙總"
      : "Voluntary anonymous daily token contribution",
    summary: isChinese
      ? "只有你明確選擇加入並確認背景同步後，companion 才會上傳下列 UTC 日彙總。TokenMonster 不上傳 prompt、response、檔案路徑或 API key。"
      : "Only after you explicitly opt in and confirm background sync, the companion uploads the UTC daily aggregates below. TokenMonster does not upload prompts, responses, file paths, or API keys.",
    fieldAllowlist: [
      "schemaVersion",
      "batchId",
      "generatedAt",
      "collector.kind",
      "collector.adapterVersion",
      "collector.sourceVersion",
      "buckets.bucketStart",
      "buckets.provider",
      "buckets.modelFamily",
      "buckets.tool",
      "buckets.valueQuality",
      "buckets.revision",
      "buckets.tokens.input",
      "buckets.tokens.output",
      "buckets.tokens.cacheRead",
      "buckets.tokens.cacheWrite",
      "buckets.tokens.reasoning",
      "buckets.tokens.other",
      "buckets.tokens.total"
    ],
    forbidden: [
      "prompt",
      "response",
      "message content",
      "file or repository path",
      "email or account identifier",
      "API key or authorization header",
      "session or event identifier",
      "local hourly activity"
    ],
    retention: {
      identifiableCurrentBucketsMaximumDays: 30,
      disclosure: isChinese
        ? "可識別的 current buckets 最多保留 30 天。只有達到至少 20 位活躍安裝的 coarse cohort 才會混入無 enrollment mapping 的匿名歷史總數；混入後無法再個別抽出或刪除。未達門檻的過期資料會刪除。"
        : "Identifiable current buckets are retained for at most 30 days. Only coarse cohorts with at least 20 active installations may be merged into anonymous historical totals without enrollment mappings; after that, an individual's contribution cannot be extracted or deleted. Expired data below the threshold is deleted."
    },
    controls: {
      defaultEnabled: false,
      pauseStopsFutureUploadsButDoesNotDelete: true,
      deletionRemovesIdentifiableCurrentData: true,
      productAnalyticsIsSeparateAndDefaultOff: true
    },
    previewRequirement: isChinese
      ? "啟用背景同步前，companion 必須以你的實際本地資料顯示將送出的 payload preview。"
      : "Before enabling background contribution sync, the companion must preview the payload made from your actual local data.",
    schemaExample: {
      schemaVersion: "2",
      batchId: "018f1f6c-7a4a-7f00-8000-123456789abc",
      generatedAt: "2026-07-15T18:20:00Z",
      collector: PERMANENT_SIDECAR_COLLECTOR_IDENTITY_V2,
      buckets: [
        {
          bucketStart: "2026-07-15T00:00:00.000Z",
          provider: "other",
          modelFamily: "all",
          tool: "all",
          valueQuality: "exact",
          revision: 1,
          tokens: {
            input: "1200",
            output: "400",
            cacheRead: "300",
            cacheWrite: "0",
            reasoning: "100",
            other: "0",
            total: "1900"
          }
        }
      ]
    }
  } as const;
}

function publicReadPath(path: string): boolean {
  return (
    path === "/healthz" ||
    path === "/v1/compatibility" ||
    path === "/v1/public/totals" ||
    path === "/v1/consent-documents/current"
  );
}

function allowedCorsRequestHeaders(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") {
    return true;
  }
  const allowlist = new Set(["accept", "if-none-match"]);
  return value
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter((header) => header.length > 0)
    .every((header) => allowlist.has(header));
}

export function createTokenMonsterApi(
  overrides: Partial<TokenMonsterApiDependencies> = {}
) {
  const dependencies: TokenMonsterApiDependencies = {
    readPublicTotals: overrides.readPublicTotals ?? (async () => null),
    createRequestId: overrides.createRequestId ?? defaultRequestId,
    now: overrides.now ?? (() => new Date()),
    ...(overrides.allowedPublicOrigin === undefined
      ? {}
      : { allowedPublicOrigin: overrides.allowedPublicOrigin })
  };
  const app = new Hono<ApiEnvironment>();

  app.use("*", async (context, next) => {
    const requestId = dependencies.createRequestId();
    context.set("requestId", requestId);
    await next();

    context.header("X-Request-Id", requestId);
    context.header("X-Contract-Version", CONTRACT_VERSION);
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Frame-Options", "DENY");
    context.header("Referrer-Policy", "no-referrer");
    context.header(
      "Content-Security-Policy",
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    context.header(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains"
    );
    context.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=()"
    );
    context.header("Cache-Control", context.res.headers.get("Cache-Control") ?? "no-store");

    const origin = context.req.header("Origin");
    if (
      dependencies.allowedPublicOrigin !== undefined &&
      publicReadPath(context.req.path)
    ) {
      context.header("Vary", "Origin", { append: true });
      if (origin === dependencies.allowedPublicOrigin) {
        context.header("Access-Control-Allow-Origin", origin);
        context.header(
          "Access-Control-Expose-Headers",
          "ETag, X-Contract-Version, X-Request-Id"
        );
      }
    }
  });

  app.options("*", (context) => {
    const origin = context.req.header("Origin");
    if (
      dependencies.allowedPublicOrigin === undefined ||
      origin !== dependencies.allowedPublicOrigin ||
      !publicReadPath(context.req.path)
    ) {
      return problem(
        context,
        404,
        "NOT_FOUND",
        "Not found",
        "The requested resource does not exist."
      );
    }
    if (
      context.req.header("Access-Control-Request-Method") !== "GET" ||
      !allowedCorsRequestHeaders(
        context.req.header("Access-Control-Request-Headers")
      )
    ) {
      return problem(
        context,
        400,
        "CORS_PREFLIGHT_INVALID",
        "Invalid CORS preflight",
        "Only public GET requests with allowlisted headers are supported."
      );
    }
    context.header("Access-Control-Allow-Methods", "GET");
    context.header("Access-Control-Allow-Headers", "Accept, If-None-Match");
    context.header("Access-Control-Max-Age", "600");
    return context.body(null, 204);
  });

  app.get("/healthz", (context) =>
    context.json({ status: "ok", contractVersion: 1 })
  );

  app.get("/v1/compatibility", (context) => {
    context.header("Cache-Control", "public, max-age=300");
    return context.json({
      contractVersion: 1,
      acceptedSnapshotSchemaVersions: ["1", "2"],
      minimumCompanionVersion: "0.1.0-alpha.1",
      recommendedCompanionVersion: "0.1.0-alpha.1",
      collectors: [
        {
          ...PERMANENT_SIDECAR_COLLECTOR_IDENTITY_V2,
          required: true
        },
        {
          kind: "tokscale",
          sourceVersion: "4.5.2",
          required: false,
          status: "migration-only"
        },
        {
          kind: "tokentracker-bridge",
          sourceVersion: "0.79.8",
          required: false,
          status: "planned"
        }
      ],
      signedConfigRevision: null,
      sunsetAt: null
    });
  });

  app.get("/v1/consent-documents/current", (context) => {
    if (context.req.query("purpose") !== "contribution") {
      return problem(
        context,
        400,
        "PURPOSE_INVALID",
        "Unsupported consent purpose",
        "purpose must be contribution."
      );
    }
    const localeQuery = context.req.query("locale");
    if (
      localeQuery !== undefined &&
      localeQuery !== "zh-TW" &&
      localeQuery !== "en"
    ) {
      return problem(
        context,
        400,
        "LOCALE_INVALID",
        "Unsupported locale",
        "locale must be zh-TW or en."
      );
    }
    const locale = localeQuery ?? "zh-TW";
    context.header("Cache-Control", "public, max-age=3600");
    return context.json(consentDocument(locale));
  });

  app.get("/v1/public/totals", async (context) => {
    const snapshot = await dependencies.readPublicTotals();
    if (snapshot === null || !validPublicTotals(snapshot, dependencies.now())) {
      return problem(
        context,
        503,
        "PUBLIC_TOTALS_UNAVAILABLE",
        "Public totals unavailable",
        "No verified public projection is available yet."
      );
    }

    const response: PublicTotalsResponse = {
      contractVersion: 1,
      label: PUBLIC_LABEL,
      disclaimer: PUBLIC_DISCLAIMER,
      allTimeTokens: snapshot.allTimeTokens,
      todayUtcTokens: snapshot.todayUtcTokens,
      contributors: snapshot.contributors,
      generatedAt: snapshot.generatedAt,
      dataRevision: snapshot.dataRevision
    };
    const etag = await responseEtag(response);
    context.header("ETag", etag);
    context.header(
      "Cache-Control",
      "public, max-age=30, stale-while-revalidate=300"
    );
    if (ifNoneMatchIncludes(context.req.header("If-None-Match"), etag)) {
      return context.body(null, 304);
    }
    return context.json(response);
  });

  registerMutationRoutes(app, overrides);

  app.notFound((context) =>
    problem(
      context,
      404,
      "NOT_FOUND",
      "Not found",
      "The requested resource does not exist."
    )
  );

  app.onError((_error, context) =>
    problem(
      context,
      500,
      "INTERNAL_ERROR",
      "Internal server error",
      "The request could not be completed."
    )
  );

  return app;
}

export type TokenMonsterApi = ReturnType<typeof createTokenMonsterApi>;

export type {
  DeriveRateLimitKey,
  TokenMonsterMutationDependencies
} from "./mutation-routes.js";
export {
  cloudflareApiWorker,
  composeCloudflareTokenMonsterApi,
  createCloudflareApiWorker,
  type CloudflareApiEnvironment,
  type CloudflareApiWorker,
  type CloudflareMutationRuntimePorts
} from "./cloudflare-worker.js";
export {
  CLOUDFLARE_RATE_LIMIT_POLICIES,
  TokenMonsterRateLimitDurableController,
  TokenMonsterSuppressionLedgerDurableController,
  createCloudflareDurableMutationPorts,
  type CloudflareDurableObjectNamespaceLike,
  type CloudflareDurableObjectStateLike,
  type CloudflareDurableStorageLike,
  type CloudflareDurableTransactionLike
} from "./durable-mutation-ports.js";
