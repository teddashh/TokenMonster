import { UsageDomainError } from "./errors.js";
import type {
  PublicAggregateProjection,
  PublicTokenLedger,
  UsageDomainState
} from "./types.js";

const TOKEN_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "other",
  "total"
] as const;
const MAIN_TOKEN_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "other"
] as const;
const PUBLIC_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/;

export type TokenLedgerLike = Readonly<
  Record<(typeof TOKEN_FIELDS)[number], string>
>;

function parseLedger(ledger: TokenLedgerLike): Record<(typeof TOKEN_FIELDS)[number], bigint> {
  const parsed = Object.fromEntries(
    TOKEN_FIELDS.map((field) => {
      const value = ledger[field];
      if (!PUBLIC_DECIMAL_PATTERN.test(value)) {
        throw new UsageDomainError(
          "STATE_INVALID",
          "A public aggregate source contains a non-canonical token count."
        );
      }
      return [field, BigInt(value)];
    })
  ) as Record<(typeof TOKEN_FIELDS)[number], bigint>;

  const computedTotal = MAIN_TOKEN_FIELDS.reduce(
    (sum, field) => sum + parsed[field],
    0n
  );
  if (computedTotal !== parsed.total || parsed.reasoning > parsed.output) {
    throw new UsageDomainError(
      "STATE_INVALID",
      "A public aggregate source violates the disjoint token ledger."
    );
  }
  return parsed;
}

export function sumTokenLedgers(
  ledgers: Iterable<TokenLedgerLike>
): PublicTokenLedger {
  const sums: Record<(typeof TOKEN_FIELDS)[number], bigint> = {
    input: 0n,
    output: 0n,
    cacheRead: 0n,
    cacheWrite: 0n,
    reasoning: 0n,
    other: 0n,
    total: 0n
  };
  for (const ledger of ledgers) {
    const parsed = parseLedger(ledger);
    for (const field of TOKEN_FIELDS) sums[field] += parsed[field];
  }
  return Object.freeze({
    input: sums.input.toString(),
    output: sums.output.toString(),
    cacheRead: sums.cacheRead.toString(),
    cacheWrite: sums.cacheWrite.toString(),
    reasoning: sums.reasoning.toString(),
    other: sums.other.toString(),
    total: sums.total.toString()
  });
}

export function projectPublicAggregate(
  state: UsageDomainState
): PublicAggregateProjection {
  const current = sumTokenLedgers(
    [...state.rows.values()].map(({ tokens }) => tokens)
  );
  const anonymous = sumTokenLedgers(
    [...state.anonymousRollups.values()].map(({ tokens }) => tokens)
  );
  const allTime = sumTokenLedgers([current, anonymous]);
  const currentTotalsByEnrollment = new Map<string, bigint>();
  for (const { enrollmentId, tokens } of state.rows.values()) {
    currentTotalsByEnrollment.set(
      enrollmentId,
      (currentTotalsByEnrollment.get(enrollmentId) ?? 0n) + BigInt(tokens.total)
    );
  }
  const activeEnrollmentCount = [...currentTotalsByEnrollment.values()].filter(
    (total) => total > 0n
  ).length;
  return Object.freeze({
    current,
    anonymous,
    allTime,
    activeCurrentContributors: BigInt(activeEnrollmentCount).toString()
  });
}
