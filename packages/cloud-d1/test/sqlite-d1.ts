import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type {
  D1MutationBindValue,
  D1MutationDatabaseLike,
  D1MutationPreparedStatementLike,
  D1MutationResultLike,
  D1MutationSessionLike
} from "../src/index.js";

const MIGRATION_SQL = ["0001_initial.sql", "0002_compaction_audit.sql"]
  .map((name) =>
    readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")
  )
  .join("\n");

type SqlValue = null | number | string | Uint8Array;

function sqliteValues(
  values: readonly D1MutationBindValue[]
): readonly SqlValue[] {
  return values.map((value) =>
    value instanceof ArrayBuffer ? new Uint8Array(value) : value
  );
}

class SqliteD1Statement implements D1MutationPreparedStatementLike {
  constructor(
    readonly owner: SqliteD1Database,
    readonly query: string,
    readonly values: readonly D1MutationBindValue[] = []
  ) {}

  bind(
    ...values: readonly D1MutationBindValue[]
  ): D1MutationPreparedStatementLike {
    this.owner.boundValues.push(Object.freeze([...values]));
    return new SqliteD1Statement(this.owner, this.query, values);
  }

  async first<T = unknown>(): Promise<T | null> {
    const result = this.owner.database
      .prepare(this.query)
      .get(...sqliteValues(this.values));
    return (result ?? null) as T | null;
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

export class SqliteD1Database
  implements D1MutationDatabaseLike, D1MutationSessionLike
{
  readonly database = new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: true
  });
  readonly boundValues: Array<readonly D1MutationBindValue[]> = [];
  primarySessionCount = 0;
  batchCount = 0;
  beforeNextBatch: (() => Promise<void> | void) | null = null;

  constructor() {
    this.database.exec(MIGRATION_SQL);
  }

  prepare(query: string): D1MutationPreparedStatementLike {
    return new SqliteD1Statement(this, query);
  }

  withSession(constraint: "first-primary"): D1MutationSessionLike {
    if (constraint !== "first-primary") throw new Error("wrong consistency");
    this.primarySessionCount += 1;
    return this;
  }

  async batch(
    statements: D1MutationPreparedStatementLike[]
  ): Promise<readonly D1MutationResultLike[]> {
    this.batchCount += 1;
    const hook = this.beforeNextBatch;
    this.beforeNextBatch = null;
    await hook?.();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (
          !(statement instanceof SqliteD1Statement) ||
          statement.owner !== this
        ) {
          throw new Error("foreign statement");
        }
        const result = statement.runSync() as Readonly<{ changes: number }>;
        return Object.freeze({
          success: true,
          meta: Object.freeze({ changes: result.changes })
        });
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error: unknown) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}
