/// <reference types="node" />

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type {
  D1MutationBindValue,
  D1MutationDatabaseLike,
  D1MutationPreparedStatementLike,
  D1MutationResultLike,
  D1MutationSessionLike
} from "@tokenmonster/cloud-d1";

const MIGRATION_SQL = readFileSync(
  new URL(
    "../../../packages/cloud-d1/migrations/0001_initial.sql",
    import.meta.url
  ),
  "utf8"
);

type SqlValue = null | number | string | Uint8Array;

function sqliteValues(
  values: readonly D1MutationBindValue[]
): readonly SqlValue[] {
  return values.map((value) =>
    value instanceof ArrayBuffer ? new Uint8Array(value) : value
  );
}

class PreparedStatement implements D1MutationPreparedStatementLike {
  constructor(
    readonly owner: CloudflareSqliteD1,
    readonly query: string,
    readonly values: readonly D1MutationBindValue[] = []
  ) {}

  bind(
    ...values: readonly D1MutationBindValue[]
  ): D1MutationPreparedStatementLike {
    this.owner.boundValues.push(Object.freeze([...values]));
    return new PreparedStatement(this.owner, this.query, values);
  }

  async first<T = unknown>(): Promise<T | null> {
    const row = this.owner.database
      .prepare(this.query)
      .get(...sqliteValues(this.values));
    return (row ?? null) as T | null;
  }

  async all<T = unknown>(): Promise<Readonly<{ results: readonly T[] }>> {
    const results = this.owner.database
      .prepare(this.query)
      .all(...sqliteValues(this.values)) as T[];
    return Object.freeze({ results: Object.freeze(results) });
  }

  async run(): Promise<unknown> {
    return this.runSync();
  }

  runSync(): unknown {
    return this.owner.database
      .prepare(this.query)
      .run(...sqliteValues(this.values));
  }
}

export class CloudflareSqliteD1
  implements D1MutationDatabaseLike, D1MutationSessionLike
{
  readonly database = new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: true
  });
  readonly boundValues: Array<readonly D1MutationBindValue[]> = [];

  constructor() {
    this.database.exec(MIGRATION_SQL);
  }

  prepare(query: string): D1MutationPreparedStatementLike {
    return new PreparedStatement(this, query);
  }

  withSession(constraint: "first-primary"): D1MutationSessionLike {
    if (constraint !== "first-primary") throw new Error("invalid session");
    return this;
  }

  async batch(
    statements: D1MutationPreparedStatementLike[]
  ): Promise<readonly D1MutationResultLike[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (
          !(statement instanceof PreparedStatement) ||
          statement.owner !== this
        ) {
          throw new Error("foreign statement");
        }
        statement.runSync();
        return Object.freeze({ success: true });
      });
      this.database.exec("COMMIT");
      return Object.freeze(results);
    } catch (error: unknown) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}
