import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  createD1PublicTotalsReader,
  type D1BindValue,
  type D1DatabaseLike,
  type D1PreparedStatementLike
} from "../src/index.js";

const VALID_ROW = Object.freeze({
  allTimeTokens: "1234567890",
  todayUtcTokens: "345678",
  contributors: "421",
  generatedAt: "2026-07-15T18:23:00Z",
  dataRevision: "2026-07-15T18:23:00Z/184"
});

class FakeStatement implements D1PreparedStatementLike {
  readonly boundValues: D1BindValue[] = [];

  constructor(private readonly row: unknown) {}

  bind(...values: readonly D1BindValue[]): D1PreparedStatementLike {
    this.boundValues.push(...values);
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    return this.row as T | null;
  }
}

class FakeDatabase implements D1DatabaseLike {
  readonly preparedQueries: string[] = [];
  readonly statement: FakeStatement;

  constructor(row: unknown) {
    this.statement = new FakeStatement(row);
  }

  prepare(query: string): D1PreparedStatementLike {
    this.preparedQueries.push(query);
    return this.statement;
  }
}

class SqliteStatementAdapter implements D1PreparedStatementLike {
  private readonly values: Array<null | number | string> = [];

  constructor(
    private readonly statement: ReturnType<DatabaseSync["prepare"]>
  ) {}

  bind(...values: readonly D1BindValue[]): D1PreparedStatementLike {
    for (const value of values) {
      if (value instanceof ArrayBuffer) {
        throw new TypeError("This test adapter only expects scalar bindings.");
      }
      this.values.push(value);
    }
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.statement.get(...this.values) ?? null) as T | null;
  }
}

class SqliteDatabaseAdapter implements D1DatabaseLike {
  constructor(private readonly db: DatabaseSync) {}

  prepare(query: string): D1PreparedStatementLike {
    return new SqliteStatementAdapter(this.db.prepare(query));
  }
}

describe("createD1PublicTotalsReader", () => {
  it("uses one fixed prepared query and binds the global projection key", async () => {
    const db = new FakeDatabase(VALID_ROW);
    const readPublicTotals = createD1PublicTotalsReader(db);

    await expect(readPublicTotals()).resolves.toEqual(VALID_ROW);
    expect(db.preparedQueries).toHaveLength(1);
    expect(db.preparedQueries[0]).toContain("FROM public_totals_cache");
    expect(db.preparedQueries[0]).toContain(
      "WHERE scope = ?1 AND day_or_all = ?2"
    );
    expect(db.statement.boundValues).toEqual(["global", "all"]);
  });

  it("returns null when no global projection has been rebuilt", async () => {
    const db = new FakeDatabase(null);
    await expect(createD1PublicTotalsReader(db)()).resolves.toBeNull();
  });

  it("roundtrips the fixed query against the migrated SQLite projection", async () => {
    const db = new DatabaseSync(":memory:", {
      enableForeignKeyConstraints: true
    });
    try {
      db.exec(
        readFileSync(
          new URL("../migrations/0001_initial.sql", import.meta.url),
          "utf8"
        )
      );
      db.prepare(`INSERT INTO public_totals_cache (
        scope, day_or_all, all_time_tokens, today_utc_tokens, contributors,
        generated_at, data_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        "global",
        "all",
        VALID_ROW.allTimeTokens,
        VALID_ROW.todayUtcTokens,
        VALID_ROW.contributors,
        VALID_ROW.generatedAt,
        VALID_ROW.dataRevision
      );

      const reader = createD1PublicTotalsReader(
        new SqliteDatabaseAdapter(db)
      );
      await expect(reader()).resolves.toEqual(VALID_ROW);
    } finally {
      db.close();
    }
  });

  it.each([
    ["a numeric D1 value", { ...VALID_ROW, allTimeTokens: 1234567890 }],
    ["a leading-zero decimal", { ...VALID_ROW, todayUtcTokens: "0345678" }],
    [
      "an int64 overflow",
      { ...VALID_ROW, allTimeTokens: "9223372036854775808" }
    ],
    ["today above all-time", { ...VALID_ROW, allTimeTokens: "9", todayUtcTokens: "10" }],
    ["contributors above total", { ...VALID_ROW, allTimeTokens: "9", contributors: "10" }],
    ["an invalid timestamp", { ...VALID_ROW, generatedAt: "not-a-time" }],
    ["a control character", { ...VALID_ROW, dataRevision: "revision\n1" }],
    ["an extra field", { ...VALID_ROW, installationId: "not-public" }],
    [
      "a missing field",
      {
        allTimeTokens: VALID_ROW.allTimeTokens,
        todayUtcTokens: VALID_ROW.todayUtcTokens,
        contributors: VALID_ROW.contributors,
        generatedAt: VALID_ROW.generatedAt
      }
    ]
  ])("fails closed without logging for %s", async (_name, row) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const db = new FakeDatabase(row);
      await expect(createD1PublicTotalsReader(db)()).resolves.toBeNull();
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it("rejects an expected field inherited through the prototype", async () => {
    const inheritedRevision = Object.create({
      dataRevision: VALID_ROW.dataRevision
    }) as Record<string, unknown>;
    Object.assign(inheritedRevision, {
      allTimeTokens: VALID_ROW.allTimeTokens,
      todayUtcTokens: VALID_ROW.todayUtcTokens,
      contributors: VALID_ROW.contributors,
      generatedAt: VALID_ROW.generatedAt,
      prompt: "must-never-cross-the-port"
    });

    await expect(
      createD1PublicTotalsReader(new FakeDatabase(inheritedRevision))()
    ).resolves.toBeNull();
  });
});
