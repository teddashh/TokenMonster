import {
  NormalizedPublicIdSchema,
  ProviderKindV1Schema
} from "@tokenmonster/contracts";
import { z } from "zod";

import { canonicalizeJson } from "./canonical-json.js";
import { UsageDomainError } from "./errors.js";
import { AuthenticatedEnrollmentSchema } from "./validation.js";
import type {
  AnonymousRollupKey,
  CanonicalAuthorityKey,
  CanonicalBatchReceiptKey,
  CanonicalUsageKey
} from "./types.js";

const BucketStartSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(Date.parse(value)).toISOString() === value,
    "Expected a real UTC calendar day."
  );

const UsageKeyInputSchema = AuthenticatedEnrollmentSchema.extend({
  bucketStart: BucketStartSchema,
  provider: ProviderKindV1Schema,
  modelFamily: NormalizedPublicIdSchema,
  tool: NormalizedPublicIdSchema
}).strict();

const AuthorityKeyInputSchema = AuthenticatedEnrollmentSchema.extend({
  bucketStart: BucketStartSchema
}).strict();

const ReceiptKeyInputSchema = AuthenticatedEnrollmentSchema.extend({
  batchId: z.uuid()
}).strict();

const RollupKeyInputSchema = z.strictObject({
  periodStart: BucketStartSchema,
  periodEnd: BucketStartSchema,
  scope: z.literal("all"),
  compactionVersion: z.literal("1")
});

function parseKeyInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
  label: string
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new UsageDomainError(
      "STATE_INVALID",
      `Cannot create an invalid canonical ${label} key.`
    );
  }
  return parsed.data;
}

export function canonicalUsageKey(input: unknown): CanonicalUsageKey {
  return canonicalizeJson(parseKeyInput(UsageKeyInputSchema, input, "usage"));
}

export function canonicalAuthorityKey(input: unknown): CanonicalAuthorityKey {
  return canonicalizeJson(
    parseKeyInput(AuthorityKeyInputSchema, input, "authority")
  );
}

export function canonicalBatchReceiptKey(
  input: unknown
): CanonicalBatchReceiptKey {
  return canonicalizeJson(
    parseKeyInput(ReceiptKeyInputSchema, input, "batch receipt")
  );
}

export function canonicalAnonymousRollupKey(
  input: unknown
): AnonymousRollupKey {
  return canonicalizeJson(
    parseKeyInput(RollupKeyInputSchema, input, "anonymous rollup")
  );
}
