import type {
  RateLimitDecision,
  SuppressionLedgerEntry
} from "@tokenmonster/api-domain";
import { DurableObject } from "cloudflare:workers";

import {
  TokenMonsterRateLimitDurableController,
  TokenMonsterSuppressionLedgerDurableController
} from "./durable-mutation-ports.js";

/** Deploy this export as a new SQLite-backed Durable Object class. */
export class TokenMonsterRateLimitDurableObject extends DurableObject<unknown> {
  readonly #controller: TokenMonsterRateLimitDurableController;

  constructor(
    context: ConstructorParameters<typeof DurableObject>[0],
    environment: unknown
  ) {
    super(context, environment);
    this.#controller = new TokenMonsterRateLimitDurableController(
      context,
      environment
    );
  }

  async consume(input: unknown): Promise<RateLimitDecision> {
    return await this.#controller.consume(input);
  }
}

/** Deploy this export as a separate new SQLite-backed Durable Object class. */
export class TokenMonsterSuppressionLedgerDurableObject extends DurableObject<unknown> {
  readonly #controller: TokenMonsterSuppressionLedgerDurableController;

  constructor(
    context: ConstructorParameters<typeof DurableObject>[0],
    environment: unknown
  ) {
    super(context, environment);
    this.#controller = new TokenMonsterSuppressionLedgerDurableController(
      context,
      environment
    );
  }

  async record(input: unknown): Promise<Readonly<{ ok: true }>> {
    return await this.#controller.record(input);
  }

  async listActive(
    input: unknown
  ): Promise<readonly SuppressionLedgerEntry[]> {
    return await this.#controller.listActive(input);
  }
}
