-- Widen the durable collector authority to the permanent TokenTracker sidecar.
-- SQLite cannot alter a CHECK constraint in place, so the three affected
-- tables are rebuilt while retaining every V1 row and foreign-key relation.

DROP TRIGGER mutation_guard_authorities_assert;
DROP TRIGGER mutation_guard_usage_assert;

CREATE TABLE collector_window_bindings_v2 (
  installation_id TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  collector_kind TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  source_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, bucket_start),
  FOREIGN KEY (installation_id) REFERENCES installations(installation_id) ON DELETE CASCADE,
  CHECK (
    length(bucket_start) = 24
    AND bucket_start GLOB '20[2-9][0-9]-[0-1][0-9]-[0-3][0-9]T00:00:00.000Z'
  ),
  CHECK (collector_kind IN ('tokscale', 'tokentracker-bridge', 'tokentracker-sidecar')),
  CHECK (length(adapter_version) BETWEEN 1 AND 64),
  CHECK (length(source_version) BETWEEN 1 AND 64),
  CHECK (length(created_at) BETWEEN 20 AND 30 AND substr(created_at, -1) = 'Z'),
  CHECK (length(expires_at) BETWEEN 20 AND 30 AND substr(expires_at, -1) = 'Z'),
  CHECK (expires_at > bucket_start)
) STRICT;

INSERT INTO collector_window_bindings_v2 (
  installation_id, bucket_start, collector_kind, adapter_version,
  source_version, created_at, expires_at
)
SELECT
  installation_id, bucket_start, collector_kind, adapter_version,
  source_version, created_at, expires_at
FROM collector_window_bindings;

CREATE TABLE usage_daily_current_v2 (
  installation_id TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_family TEXT NOT NULL,
  tool TEXT NOT NULL,
  value_quality TEXT NOT NULL,
  revision INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  other_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  collector_kind TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  source_version TEXT NOT NULL,
  row_hash BLOB NOT NULL,
  quarantine_status TEXT NOT NULL,
  quarantine_reason_code TEXT,
  quarantined_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, bucket_start, provider, model_family, tool),
  FOREIGN KEY (installation_id) REFERENCES installations(installation_id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id, bucket_start)
    REFERENCES collector_window_bindings_v2(installation_id, bucket_start) ON DELETE CASCADE,
  CHECK (
    length(bucket_start) = 24
    AND bucket_start GLOB '20[2-9][0-9]-[0-1][0-9]-[0-3][0-9]T00:00:00.000Z'
  ),
  CHECK (provider IN ('anthropic', 'google', 'openai', 'openrouter', 'xai', 'other')),
  CHECK (
    length(model_family) BETWEEN 1 AND 64
    AND model_family = lower(model_family)
    AND model_family NOT GLOB '*[^a-z0-9._-]*'
    AND substr(model_family, 1, 1) GLOB '[a-z0-9]'
    AND substr(model_family, -1) GLOB '[a-z0-9]'
  ),
  CHECK (
    length(tool) BETWEEN 1 AND 64
    AND tool = lower(tool)
    AND tool NOT GLOB '*[^a-z0-9._-]*'
    AND substr(tool, 1, 1) GLOB '[a-z0-9]'
    AND substr(tool, -1) GLOB '[a-z0-9]'
  ),
  CHECK (value_quality IN ('exact', 'estimated')),
  CHECK (revision BETWEEN 1 AND 9007199254740991),
  CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
  CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
  CHECK (cache_read_tokens BETWEEN 0 AND 9007199254740991),
  CHECK (cache_write_tokens BETWEEN 0 AND 9007199254740991),
  CHECK (reasoning_tokens BETWEEN 0 AND 9007199254740991),
  CHECK (other_tokens BETWEEN 0 AND 9007199254740991),
  CHECK (total_tokens BETWEEN 0 AND 9007199254740991),
  CHECK (reasoning_tokens <= output_tokens),
  CHECK (
    total_tokens = input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + other_tokens
  ),
  CHECK (collector_kind IN ('tokscale', 'tokentracker-bridge', 'tokentracker-sidecar')),
  CHECK (length(adapter_version) BETWEEN 1 AND 64),
  CHECK (length(source_version) BETWEEN 1 AND 64),
  CHECK (length(row_hash) = 32),
  CHECK (quarantine_status IN ('accepted', 'quarantined')),
  CHECK (
    (quarantine_status = 'accepted' AND quarantine_reason_code IS NULL AND quarantined_at IS NULL)
    OR (
      quarantine_status = 'quarantined'
      AND length(quarantine_reason_code) BETWEEN 1 AND 64
      AND quarantined_at IS NOT NULL
    )
  ),
  CHECK (quarantined_at IS NULL OR (length(quarantined_at) BETWEEN 20 AND 30 AND substr(quarantined_at, -1) = 'Z')),
  CHECK (length(created_at) BETWEEN 20 AND 30 AND substr(created_at, -1) = 'Z'),
  CHECK (length(updated_at) BETWEEN 20 AND 30 AND substr(updated_at, -1) = 'Z'),
  CHECK (length(expires_at) BETWEEN 20 AND 30 AND substr(expires_at, -1) = 'Z'),
  CHECK (expires_at > bucket_start)
) STRICT;

INSERT INTO usage_daily_current_v2 (
  installation_id, bucket_start, provider, model_family, tool, value_quality,
  revision, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, reasoning_tokens, other_tokens, total_tokens,
  collector_kind, adapter_version, source_version, row_hash,
  quarantine_status, quarantine_reason_code, quarantined_at, created_at,
  updated_at, expires_at
)
SELECT
  installation_id, bucket_start, provider, model_family, tool, value_quality,
  revision, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, reasoning_tokens, other_tokens, total_tokens,
  collector_kind, adapter_version, source_version, row_hash,
  quarantine_status, quarantine_reason_code, quarantined_at, created_at,
  updated_at, expires_at
FROM usage_daily_current;

DROP TABLE usage_daily_current;
DROP TABLE collector_window_bindings;
ALTER TABLE collector_window_bindings_v2 RENAME TO collector_window_bindings;
ALTER TABLE usage_daily_current_v2 RENAME TO usage_daily_current;

CREATE INDEX collector_window_bindings_expires_idx
  ON collector_window_bindings(expires_at);
CREATE INDEX usage_daily_current_bucket_quarantine_idx
  ON usage_daily_current(bucket_start, quarantine_status);
CREATE INDEX usage_daily_current_installation_bucket_revision_idx
  ON usage_daily_current(installation_id, bucket_start, revision);
CREATE INDEX usage_daily_current_expires_idx
  ON usage_daily_current(expires_at, installation_id, bucket_start);

CREATE TABLE mutation_guard_authorities_v2 (
  request_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  expected_exists INTEGER NOT NULL,
  expected_collector_kind TEXT,
  expected_adapter_version TEXT,
  expected_source_version TEXT,
  PRIMARY KEY (request_id, installation_id, bucket_start),
  FOREIGN KEY (request_id) REFERENCES mutation_guards(request_id) ON DELETE CASCADE,
  CHECK (expected_exists IN (0, 1)),
  CHECK (
    (expected_exists = 0
      AND expected_collector_kind IS NULL
      AND expected_adapter_version IS NULL
      AND expected_source_version IS NULL)
    OR (expected_exists = 1
      AND expected_collector_kind IN ('tokscale', 'tokentracker-bridge', 'tokentracker-sidecar')
      AND expected_adapter_version IS NOT NULL
      AND expected_source_version IS NOT NULL)
  )
) STRICT;

INSERT INTO mutation_guard_authorities_v2 (
  request_id, installation_id, bucket_start, expected_exists,
  expected_collector_kind, expected_adapter_version, expected_source_version
)
SELECT
  request_id, installation_id, bucket_start, expected_exists,
  expected_collector_kind, expected_adapter_version, expected_source_version
FROM mutation_guard_authorities;

DROP TABLE mutation_guard_authorities;
ALTER TABLE mutation_guard_authorities_v2 RENAME TO mutation_guard_authorities;

CREATE TRIGGER mutation_guard_authorities_assert
BEFORE INSERT ON mutation_guard_authorities
BEGIN
  SELECT RAISE(ABORT, 'TM_GUARD_AUTHORITY')
  WHERE
    (NEW.expected_exists = 0 AND EXISTS (
      SELECT 1 FROM collector_window_bindings
      WHERE installation_id = NEW.installation_id AND bucket_start = NEW.bucket_start
    ))
    OR
    (NEW.expected_exists = 1 AND NOT EXISTS (
      SELECT 1 FROM collector_window_bindings
      WHERE installation_id = NEW.installation_id
        AND bucket_start = NEW.bucket_start
        AND collector_kind = NEW.expected_collector_kind
        AND adapter_version = NEW.expected_adapter_version
        AND source_version = NEW.expected_source_version
    ));
END;

CREATE TRIGGER mutation_guard_usage_assert
BEFORE INSERT ON mutation_guard_usage
BEGIN
  SELECT RAISE(ABORT, 'TM_GUARD_USAGE')
  WHERE
    (NEW.expected_exists = 0 AND EXISTS (
      SELECT 1 FROM usage_daily_current
      WHERE installation_id = NEW.installation_id
        AND bucket_start = NEW.bucket_start
        AND provider = NEW.provider
        AND model_family = NEW.model_family
        AND tool = NEW.tool
    ))
    OR
    (NEW.expected_exists = 1 AND NOT EXISTS (
      SELECT 1 FROM usage_daily_current
      WHERE installation_id = NEW.installation_id
        AND bucket_start = NEW.bucket_start
        AND provider = NEW.provider
        AND model_family = NEW.model_family
        AND tool = NEW.tool
        AND revision = NEW.expected_revision
        AND row_hash = NEW.expected_row_hash
    ));
END;

-- Recreate the completed-day closure triggers that belonged to the rebuilt
-- collector and usage tables.
CREATE TRIGGER collector_window_bindings_compacted_day_insert
BEFORE INSERT ON collector_window_bindings
BEGIN
  SELECT RAISE(ABORT, 'TM_COMPACTED_DAY_CLOSED')
  WHERE EXISTS (
    SELECT 1 FROM compaction_runs
    WHERE period_start = substr(NEW.bucket_start, 1, 10)
      AND compaction_version = 'day-all-v1'
      AND status = 'completed'
      AND k_gate_result IN ('rolled_up', 'dropped')
  );
END;

CREATE TRIGGER collector_window_bindings_compacted_day_update
BEFORE UPDATE ON collector_window_bindings
BEGIN
  SELECT RAISE(ABORT, 'TM_COMPACTED_DAY_CLOSED')
  WHERE EXISTS (
    SELECT 1 FROM compaction_runs
    WHERE period_start = substr(NEW.bucket_start, 1, 10)
      AND compaction_version = 'day-all-v1'
      AND status = 'completed'
      AND k_gate_result IN ('rolled_up', 'dropped')
  );
END;

CREATE TRIGGER usage_daily_current_compacted_day_insert
BEFORE INSERT ON usage_daily_current
BEGIN
  SELECT RAISE(ABORT, 'TM_COMPACTED_DAY_CLOSED')
  WHERE EXISTS (
    SELECT 1 FROM compaction_runs
    WHERE period_start = substr(NEW.bucket_start, 1, 10)
      AND compaction_version = 'day-all-v1'
      AND status = 'completed'
      AND k_gate_result IN ('rolled_up', 'dropped')
  );
END;

CREATE TRIGGER usage_daily_current_compacted_day_update
BEFORE UPDATE ON usage_daily_current
BEGIN
  SELECT RAISE(ABORT, 'TM_COMPACTED_DAY_CLOSED')
  WHERE EXISTS (
    SELECT 1 FROM compaction_runs
    WHERE period_start = substr(NEW.bucket_start, 1, 10)
      AND compaction_version = 'day-all-v1'
      AND status = 'completed'
      AND k_gate_result IN ('rolled_up', 'dropped')
  );
END;
