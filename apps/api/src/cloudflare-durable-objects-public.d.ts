import type {
  RateLimitDecision,
  SuppressionLedgerEntry
} from "@tokenmonster/api-domain";

/** RPC surface of the deploy-only rate-limit Durable Object class. */
export declare class TokenMonsterRateLimitDurableObject {
  consume(input: unknown): Promise<RateLimitDecision>;
}

/** RPC surface of the independent suppression-ledger Durable Object class. */
export declare class TokenMonsterSuppressionLedgerDurableObject {
  record(input: unknown): Promise<Readonly<{ ok: true }>>;
  listActive(input: unknown): Promise<readonly SuppressionLedgerEntry[]>;
}
