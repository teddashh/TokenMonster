export const LOCAL_STORE_SCHEMA_VERSION = 4;

export interface LocalStoreMigration {
  readonly version: number;
  readonly sql: string;
  readonly tablesAfterMigration: readonly string[];
}

const BASE_TABLES = [
  "app_meta",
  "collector_authority",
  "local_config",
  "monster_state",
  "usage_daily",
] as const;

const VERSION_2_TABLES = [...BASE_TABLES, "cloud_outbox"] as const;

const VERSION_3_TABLES = [...VERSION_2_TABLES, "cloud_mirror"] as const;

const VERSION_4_TABLES = [...VERSION_3_TABLES, "complete_scan_ledger"] as const;

const TOKEN_CHECKS = `
  CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
  CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
  CHECK (cache_read_tokens BETWEEN 0 AND 9007199254740991),
  CHECK (cache_write_tokens BETWEEN 0 AND 9007199254740991),
  CHECK (reasoning_tokens BETWEEN 0 AND 9007199254740991),
  CHECK (other_tokens BETWEEN 0 AND 9007199254740991),
  CHECK (total_tokens BETWEEN 0 AND 9007199254740991),
  CHECK (reasoning_tokens <= output_tokens),
  CHECK (
    total_tokens = input_tokens + output_tokens + cache_read_tokens +
      cache_write_tokens + other_tokens
  )`;

export const LOCAL_STORE_MIGRATIONS: readonly LocalStoreMigration[] = [
  {
    version: 1,
    tablesAfterMigration: BASE_TABLES,
    sql: `
      CREATE TABLE app_meta (
        key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
        value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 256),
        updated_at TEXT NOT NULL CHECK (length(updated_at) = 24)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE usage_daily (
        bucket_start TEXT NOT NULL CHECK (length(bucket_start) = 24),
        provider TEXT NOT NULL CHECK (
          provider IN ('anthropic', 'google', 'openai', 'openrouter', 'xai', 'other')
        ),
        model_family TEXT NOT NULL CHECK (length(model_family) BETWEEN 1 AND 64),
        tool TEXT NOT NULL CHECK (length(tool) BETWEEN 1 AND 64),
        value_quality TEXT NOT NULL CHECK (value_quality IN ('exact', 'estimated')),
        revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        other_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        local_coverage TEXT NOT NULL CHECK (
          local_coverage IN ('complete', 'partial', 'unknown')
        ),
        collector_kind TEXT NOT NULL CHECK (
          collector_kind IN ('tokscale', 'tokentracker-bridge')
        ),
        adapter_version TEXT NOT NULL CHECK (length(adapter_version) BETWEEN 5 AND 64),
        source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 5 AND 64),
        updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
        PRIMARY KEY (bucket_start, provider, model_family, tool),
        ${TOKEN_CHECKS}
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX usage_daily_bucket_start_idx
        ON usage_daily (bucket_start);

      CREATE TABLE collector_authority (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        kind TEXT NOT NULL CHECK (kind IN ('tokscale', 'tokentracker-bridge')),
        state TEXT NOT NULL CHECK (
          state IN ('stopped', 'starting', 'running', 'stopping', 'degraded', 'switch-preview')
        ),
        adapter_version TEXT NOT NULL CHECK (length(adapter_version) BETWEEN 5 AND 64),
        source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 5 AND 64),
        updated_at TEXT NOT NULL CHECK (length(updated_at) = 24)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE monster_state (
        character_id TEXT PRIMARY KEY CHECK (
          character_id IN ('chatgpt', 'claude', 'gemini', 'grok')
        ),
        engine_version TEXT NOT NULL CHECK (length(engine_version) BETWEEN 5 AND 64),
        state_json TEXT NOT NULL CHECK (
          json_valid(state_json) AND length(state_json) <= 65536
        ),
        as_of_revision INTEGER NOT NULL CHECK (
          as_of_revision BETWEEN 1 AND 9007199254740991
        ),
        updated_at TEXT NOT NULL CHECK (length(updated_at) = 24)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE local_config (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version TEXT NOT NULL CHECK (schema_version = '1'),
        config_json TEXT NOT NULL CHECK (
          json_valid(config_json) AND length(config_json) <= 4096
        ),
        updated_at TEXT NOT NULL CHECK (length(updated_at) = 24)
      ) STRICT, WITHOUT ROWID;

      INSERT INTO app_meta (key, value, updated_at)
      VALUES ('schema_version', '1', '2020-01-01T00:00:00.000Z');
    `,
  },
  {
    version: 2,
    tablesAfterMigration: VERSION_2_TABLES,
    sql: `
      CREATE TABLE cloud_outbox (
        batch_id TEXT PRIMARY KEY CHECK (length(batch_id) = 36),
        generated_at TEXT NOT NULL CHECK (length(generated_at) = 24),
        payload_json TEXT NOT NULL CHECK (
          json_valid(payload_json) AND length(payload_json) <= 65536
        ),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (
          attempts BETWEEN 0 AND 1000000
        ),
        next_attempt_at TEXT NOT NULL CHECK (length(next_attempt_at) = 24),
        expires_at TEXT NOT NULL CHECK (length(expires_at) = 24),
        last_error_code TEXT CHECK (
          last_error_code IS NULL OR last_error_code IN (
            'network', 'timeout', 'rate-limited', 'server-unavailable', 'clock-skew'
          )
        ),
        created_at TEXT NOT NULL CHECK (length(created_at) = 24)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX cloud_outbox_due_idx
        ON cloud_outbox (next_attempt_at, expires_at);
    `,
  },
  {
    version: 3,
    tablesAfterMigration: VERSION_3_TABLES,
    sql: `
      CREATE TABLE cloud_mirror (
        bucket_start TEXT NOT NULL CHECK (length(bucket_start) = 24),
        provider TEXT NOT NULL CHECK (
          provider IN ('anthropic', 'google', 'openai', 'openrouter', 'xai', 'other')
        ),
        model_family TEXT NOT NULL CHECK (length(model_family) BETWEEN 1 AND 64),
        tool TEXT NOT NULL CHECK (length(tool) BETWEEN 1 AND 64),
        value_quality TEXT NOT NULL CHECK (value_quality IN ('exact', 'estimated')),
        revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        other_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        collector_kind TEXT NOT NULL CHECK (
          collector_kind IN ('tokscale', 'tokentracker-bridge')
        ),
        adapter_version TEXT NOT NULL CHECK (length(adapter_version) BETWEEN 5 AND 64),
        source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 5 AND 64),
        receipt_batch_id TEXT NOT NULL CHECK (length(receipt_batch_id) = 36),
        receipt_received_at TEXT NOT NULL CHECK (length(receipt_received_at) = 24),
        updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
        PRIMARY KEY (bucket_start, provider, model_family, tool),
        ${TOKEN_CHECKS}
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX cloud_mirror_bucket_start_idx
        ON cloud_mirror (bucket_start);
    `,
  },
  {
    version: 4,
    tablesAfterMigration: VERSION_4_TABLES,
    sql: `
      CREATE TABLE complete_scan_ledger (
        utc_date TEXT NOT NULL CHECK (
          length(utc_date) = 10 AND
          utc_date GLOB '20[2-9][0-9]-[01][0-9]-[0-3][0-9]'
        ),
        client TEXT NOT NULL CHECK (
          client IN ('claude', 'codex', 'gemini', 'grok')
        ),
        completed_at TEXT NOT NULL CHECK (length(completed_at) = 24),
        PRIMARY KEY (utc_date, client)
      ) STRICT, WITHOUT ROWID;
    `,
  },
] as const;

export function expectedTablesForSchemaVersion(
  version: number,
): readonly string[] {
  if (version === 0) return [];
  const migration = LOCAL_STORE_MIGRATIONS.find(
    (candidate) => candidate.version === version,
  );
  return migration?.tablesAfterMigration ?? [];
}
