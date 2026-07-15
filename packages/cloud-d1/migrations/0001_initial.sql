-- Credentials are represented by a public lookup ID and a 32-byte
-- HMAC-SHA-256 verifier. Bearer secrets and server peppers never enter D1.
CREATE TABLE installations (
  installation_id TEXT NOT NULL PRIMARY KEY,
  upload_token_id TEXT UNIQUE,
  upload_token_hmac BLOB UNIQUE,
  upload_hmac_key_id TEXT,
  deletion_token_id TEXT UNIQUE,
  deletion_token_hmac BLOB UNIQUE,
  deletion_hmac_key_id TEXT,
  status TEXT NOT NULL,
  consent_document_revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  credentials_rotated_at TEXT NOT NULL,
  paused_at TEXT,
  deleting_at TEXT,
  deleted_at TEXT,
  receipt_expires_at TEXT,
  CHECK (length(installation_id) BETWEEN 16 AND 128),
  CHECK (upload_token_id IS NULL OR length(upload_token_id) BETWEEN 16 AND 32),
  CHECK (deletion_token_id IS NULL OR length(deletion_token_id) BETWEEN 16 AND 32),
  CHECK (upload_token_id IS NULL OR deletion_token_id IS NULL OR upload_token_id <> deletion_token_id),
  CHECK (upload_token_hmac IS NULL OR length(upload_token_hmac) = 32),
  CHECK (deletion_token_hmac IS NULL OR length(deletion_token_hmac) = 32),
  CHECK (upload_token_hmac IS NULL OR deletion_token_hmac IS NULL OR upload_token_hmac <> deletion_token_hmac),
  CHECK (upload_hmac_key_id IS NULL OR length(upload_hmac_key_id) BETWEEN 1 AND 32),
  CHECK (deletion_hmac_key_id IS NULL OR length(deletion_hmac_key_id) BETWEEN 1 AND 32),
  CHECK ((upload_token_id IS NULL) = (upload_token_hmac IS NULL)),
  CHECK ((upload_token_id IS NULL) = (upload_hmac_key_id IS NULL)),
  CHECK ((deletion_token_id IS NULL) = (deletion_token_hmac IS NULL)),
  CHECK ((deletion_token_id IS NULL) = (deletion_hmac_key_id IS NULL)),
  CHECK (status IN ('active', 'paused', 'deleting', 'deleted')),
  CHECK (length(consent_document_revision) BETWEEN 1 AND 128),
  CHECK (length(created_at) BETWEEN 20 AND 30 AND substr(created_at, -1) = 'Z'),
  CHECK (length(credentials_rotated_at) BETWEEN 20 AND 30 AND substr(credentials_rotated_at, -1) = 'Z'),
  CHECK (paused_at IS NULL OR (length(paused_at) BETWEEN 20 AND 30 AND substr(paused_at, -1) = 'Z')),
  CHECK (deleting_at IS NULL OR (length(deleting_at) BETWEEN 20 AND 30 AND substr(deleting_at, -1) = 'Z')),
  CHECK (deleted_at IS NULL OR (length(deleted_at) BETWEEN 20 AND 30 AND substr(deleted_at, -1) = 'Z')),
  CHECK (receipt_expires_at IS NULL OR (length(receipt_expires_at) BETWEEN 20 AND 30 AND substr(receipt_expires_at, -1) = 'Z')),
  CHECK (deleting_at IS NULL OR status IN ('deleting', 'deleted')),
  CHECK (status NOT IN ('deleting', 'deleted') OR deleting_at IS NOT NULL),
  CHECK (deleted_at IS NULL OR status = 'deleted'),
  CHECK (status <> 'deleted' OR deleted_at IS NOT NULL),
  CHECK (receipt_expires_at IS NULL OR status IN ('deleting', 'deleted')),
  CHECK (
    (status IN ('active', 'paused') AND upload_token_id IS NOT NULL AND deletion_token_id IS NOT NULL)
    OR (status IN ('deleting', 'deleted') AND upload_token_id IS NULL AND deletion_token_id IS NULL)
  )
) STRICT;

CREATE TABLE consent_receipts (
  event_id TEXT NOT NULL PRIMARY KEY,
  installation_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  document_revision TEXT NOT NULL,
  granted INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES installations(installation_id) ON DELETE CASCADE,
  CHECK (length(event_id) BETWEEN 16 AND 128),
  CHECK (purpose = 'contribution'),
  CHECK (length(document_revision) BETWEEN 1 AND 128),
  CHECK (granted IN (0, 1)),
  CHECK (length(occurred_at) BETWEEN 20 AND 30 AND substr(occurred_at, -1) = 'Z'),
  CHECK (length(recorded_at) BETWEEN 20 AND 30 AND substr(recorded_at, -1) = 'Z'),
  CHECK (length(expires_at) BETWEEN 20 AND 30 AND substr(expires_at, -1) = 'Z'),
  CHECK (expires_at > occurred_at)
) STRICT;

CREATE TABLE collector_window_bindings (
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
  CHECK (collector_kind IN ('tokscale', 'tokentracker-bridge')),
  CHECK (length(adapter_version) BETWEEN 1 AND 64),
  CHECK (length(source_version) BETWEEN 1 AND 64),
  CHECK (length(created_at) BETWEEN 20 AND 30 AND substr(created_at, -1) = 'Z'),
  CHECK (length(expires_at) BETWEEN 20 AND 30 AND substr(expires_at, -1) = 'Z'),
  CHECK (expires_at > bucket_start)
) STRICT;

CREATE TABLE ingest_batches (
  installation_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  payload_hash BLOB NOT NULL,
  status TEXT NOT NULL,
  bucket_count INTEGER NOT NULL,
  applied_bucket_count INTEGER NOT NULL,
  stale_bucket_count INTEGER NOT NULL,
  idempotent_bucket_count INTEGER NOT NULL,
  quarantined_bucket_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, batch_id),
  FOREIGN KEY (installation_id) REFERENCES installations(installation_id) ON DELETE CASCADE,
  CHECK (length(batch_id) BETWEEN 16 AND 128),
  CHECK (length(payload_hash) = 32),
  CHECK (status IN ('accepted', 'partially_quarantined', 'quarantined')),
  CHECK (bucket_count BETWEEN 1 AND 30),
  CHECK (applied_bucket_count BETWEEN 0 AND 30),
  CHECK (stale_bucket_count BETWEEN 0 AND 30),
  CHECK (idempotent_bucket_count BETWEEN 0 AND 30),
  CHECK (quarantined_bucket_count BETWEEN 0 AND 30),
  CHECK (
    applied_bucket_count + stale_bucket_count + idempotent_bucket_count + quarantined_bucket_count
    = bucket_count
  ),
  CHECK (
    (status = 'accepted' AND quarantined_bucket_count = 0)
    OR (status = 'partially_quarantined' AND quarantined_bucket_count BETWEEN 1 AND bucket_count - 1)
    OR (status = 'quarantined' AND quarantined_bucket_count = bucket_count)
  ),
  CHECK (length(created_at) BETWEEN 20 AND 30 AND substr(created_at, -1) = 'Z'),
  CHECK (length(expires_at) BETWEEN 20 AND 30 AND substr(expires_at, -1) = 'Z'),
  CHECK (expires_at > created_at)
) STRICT;

CREATE TABLE usage_daily_current (
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
    REFERENCES collector_window_bindings(installation_id, bucket_start) ON DELETE CASCADE,
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
  CHECK (collector_kind IN ('tokscale', 'tokentracker-bridge')),
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

-- This table intentionally has no installation, batch, credential, row hash,
-- or reversible contributor mapping.
CREATE TABLE anonymous_rollups (
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  scope TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_family TEXT NOT NULL,
  tool TEXT NOT NULL,
  compaction_version TEXT NOT NULL,
  eligible_cohort_count INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  other_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (
    period_start,
    period_end,
    scope,
    provider,
    model_family,
    tool,
    compaction_version
  ),
  CHECK (length(period_start) = 10 AND period_start GLOB '20[2-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  CHECK (length(period_end) = 10 AND period_end GLOB '20[2-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  CHECK (period_end > period_start),
  CHECK (scope = 'all'),
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
  CHECK (length(compaction_version) BETWEEN 1 AND 32),
  CHECK (eligible_cohort_count >= 20),
  CHECK (input_tokens >= 0),
  CHECK (output_tokens >= 0),
  CHECK (cache_read_tokens >= 0),
  CHECK (cache_write_tokens >= 0),
  CHECK (reasoning_tokens >= 0),
  CHECK (other_tokens >= 0),
  CHECK (total_tokens >= 0),
  CHECK (reasoning_tokens <= output_tokens),
  CHECK (
    total_tokens = input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + other_tokens
  ),
  CHECK (length(created_at) BETWEEN 20 AND 30 AND substr(created_at, -1) = 'Z')
) STRICT;

CREATE TABLE compaction_runs (
  run_id TEXT NOT NULL PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  compaction_version TEXT NOT NULL,
  status TEXT NOT NULL,
  input_row_count INTEGER NOT NULL,
  output_row_count INTEGER NOT NULL,
  eligible_cohort_count INTEGER NOT NULL,
  k_gate_result TEXT,
  checksum BLOB,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK (length(run_id) BETWEEN 16 AND 128),
  CHECK (length(period_start) = 10 AND period_start GLOB '20[2-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  CHECK (length(period_end) = 10 AND period_end GLOB '20[2-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  CHECK (period_end > period_start),
  CHECK (length(compaction_version) BETWEEN 1 AND 32),
  CHECK (status IN ('running', 'completed', 'failed')),
  CHECK (input_row_count >= 0),
  CHECK (output_row_count >= 0),
  CHECK (eligible_cohort_count >= 0),
  CHECK (k_gate_result IS NULL OR k_gate_result IN ('rolled_up', 'coarsened', 'dropped')),
  CHECK (checksum IS NULL OR length(checksum) = 32),
  CHECK (length(started_at) BETWEEN 20 AND 30 AND substr(started_at, -1) = 'Z'),
  CHECK (finished_at IS NULL OR (length(finished_at) BETWEEN 20 AND 30 AND substr(finished_at, -1) = 'Z')),
  CHECK (
    (status = 'running' AND finished_at IS NULL AND k_gate_result IS NULL AND checksum IS NULL)
    OR (status = 'completed' AND finished_at IS NOT NULL AND k_gate_result IS NOT NULL AND checksum IS NOT NULL)
    OR (status = 'failed' AND finished_at IS NOT NULL)
  )
) STRICT;

-- Presence of this single row is the complete, rebuildable global public
-- projection. Counts are canonical signed-int64-safe decimal strings.
CREATE TABLE public_totals_cache (
  scope TEXT NOT NULL,
  day_or_all TEXT NOT NULL,
  all_time_tokens TEXT NOT NULL,
  today_utc_tokens TEXT NOT NULL,
  contributors TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  data_revision TEXT NOT NULL,
  PRIMARY KEY (scope, day_or_all),
  CHECK (scope = 'global'),
  CHECK (day_or_all = 'all'),
  CHECK (
    length(all_time_tokens) BETWEEN 1 AND 19
    AND all_time_tokens NOT GLOB '*[^0-9]*'
    AND (all_time_tokens = '0' OR substr(all_time_tokens, 1, 1) <> '0')
    AND (length(all_time_tokens) < 19 OR all_time_tokens <= '9223372036854775807')
  ),
  CHECK (
    length(today_utc_tokens) BETWEEN 1 AND 19
    AND today_utc_tokens NOT GLOB '*[^0-9]*'
    AND (today_utc_tokens = '0' OR substr(today_utc_tokens, 1, 1) <> '0')
    AND (length(today_utc_tokens) < 19 OR today_utc_tokens <= '9223372036854775807')
  ),
  CHECK (
    length(contributors) BETWEEN 1 AND 19
    AND contributors NOT GLOB '*[^0-9]*'
    AND (contributors = '0' OR substr(contributors, 1, 1) <> '0')
    AND (length(contributors) < 19 OR contributors <= '9223372036854775807')
  ),
  CHECK (CAST(today_utc_tokens AS INTEGER) <= CAST(all_time_tokens AS INTEGER)),
  CHECK (CAST(contributors AS INTEGER) <= CAST(all_time_tokens AS INTEGER)),
  CHECK (length(generated_at) BETWEEN 20 AND 30 AND substr(generated_at, -1) = 'Z'),
  CHECK (length(data_revision) BETWEEN 1 AND 128)
) STRICT;

CREATE TABLE share_cards (
  share_id TEXT NOT NULL PRIMARY KEY,
  installation_id TEXT NOT NULL,
  character_asset_id TEXT NOT NULL,
  trait_ids_json TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL,
  coarse_time_window TEXT NOT NULL,
  token_band TEXT,
  token_total TEXT,
  locale TEXT NOT NULL,
  theme TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (installation_id) REFERENCES installations(installation_id) ON DELETE CASCADE,
  CHECK (length(share_id) BETWEEN 32 AND 128),
  CHECK (
    length(character_asset_id) BETWEEN 1 AND 96
    AND character_asset_id = lower(character_asset_id)
    AND character_asset_id NOT GLOB '*[^a-z0-9._-]*'
  ),
  CHECK (
    length(trait_ids_json) BETWEEN 5 AND 512
    AND json_valid(trait_ids_json)
    AND json_type(trait_ids_json) = 'array'
    AND json_array_length(trait_ids_json) BETWEEN 2 AND 3
  ),
  CHECK (
    length(reason_codes_json) BETWEEN 3 AND 512
    AND json_valid(reason_codes_json)
    AND json_type(reason_codes_json) = 'array'
    AND json_array_length(reason_codes_json) BETWEEN 1 AND 8
  ),
  CHECK (coarse_time_window IN ('day', '7-days', '28-days', 'all-time')),
  CHECK (token_band IS NULL OR token_band IN ('small', 'medium', 'large', 'very-large')),
  CHECK (
    token_total IS NULL
    OR (
      length(token_total) BETWEEN 1 AND 19
      AND token_total NOT GLOB '*[^0-9]*'
      AND (token_total = '0' OR substr(token_total, 1, 1) <> '0')
      AND (length(token_total) < 19 OR token_total <= '9223372036854775807')
    )
  ),
  CHECK (locale IN ('zh-TW', 'en')),
  CHECK (theme IN ('light', 'dark')),
  CHECK (length(created_at) BETWEEN 20 AND 30 AND substr(created_at, -1) = 'Z'),
  CHECK (length(expires_at) BETWEEN 20 AND 30 AND substr(expires_at, -1) = 'Z'),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR (length(revoked_at) BETWEEN 20 AND 30 AND substr(revoked_at, -1) = 'Z' AND revoked_at >= created_at))
) STRICT;

CREATE TABLE security_rate_events (
  event_id TEXT NOT NULL PRIMARY KEY,
  route_class TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  rate_key_hmac BLOB NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (length(event_id) BETWEEN 16 AND 128),
  CHECK (route_class IN ('enrollment', 'ingest', 'credentials', 'consent', 'control', 'delete', 'public', 'share')),
  CHECK (length(reason_code) BETWEEN 1 AND 64),
  CHECK (length(rate_key_hmac) = 32),
  CHECK (length(created_at) BETWEEN 20 AND 30 AND substr(created_at, -1) = 'Z'),
  CHECK (length(expires_at) BETWEEN 20 AND 30 AND substr(expires_at, -1) = 'Z'),
  CHECK (expires_at > created_at)
) STRICT;

CREATE TABLE quarantine_events (
  event_id TEXT NOT NULL PRIMARY KEY,
  installation_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  bucket_index INTEGER NOT NULL,
  reason_code TEXT NOT NULL,
  decision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (installation_id, batch_id)
    REFERENCES ingest_batches(installation_id, batch_id) ON DELETE CASCADE,
  CHECK (length(event_id) BETWEEN 16 AND 128),
  CHECK (bucket_index BETWEEN 0 AND 29),
  CHECK (length(reason_code) BETWEEN 1 AND 64),
  CHECK (decision IN ('pending', 'quarantined', 'released', 'rejected')),
  CHECK (length(created_at) BETWEEN 20 AND 30 AND substr(created_at, -1) = 'Z'),
  CHECK (decided_at IS NULL OR (length(decided_at) BETWEEN 20 AND 30 AND substr(decided_at, -1) = 'Z')),
  CHECK (expires_at > created_at),
  CHECK (
    (decision = 'pending' AND decided_at IS NULL)
    OR (decision <> 'pending' AND decided_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE deletion_jobs (
  job_id TEXT NOT NULL PRIMARY KEY,
  installation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status_token_id TEXT NOT NULL UNIQUE,
  status_token_hmac BLOB NOT NULL UNIQUE,
  status_hmac_key_id TEXT NOT NULL,
  replay_token_id TEXT NOT NULL UNIQUE,
  replay_token_hmac BLOB NOT NULL UNIQUE,
  replay_hmac_key_id TEXT NOT NULL,
  state TEXT NOT NULL,
  anonymous_historical_totals_retained INTEGER NOT NULL,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  expires_at TEXT NOT NULL,
  failure_code TEXT,
  FOREIGN KEY (installation_id) REFERENCES installations(installation_id) ON DELETE CASCADE,
  UNIQUE (installation_id, idempotency_key),
  CHECK (length(job_id) BETWEEN 16 AND 128),
  CHECK (length(installation_id) BETWEEN 16 AND 128),
  CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  CHECK (length(status_token_id) BETWEEN 16 AND 32),
  CHECK (length(status_token_hmac) = 32),
  CHECK (length(status_hmac_key_id) BETWEEN 1 AND 32),
  CHECK (length(replay_token_id) BETWEEN 16 AND 32),
  CHECK (length(replay_token_hmac) = 32),
  CHECK (length(replay_hmac_key_id) BETWEEN 1 AND 32),
  CHECK (status_token_id <> replay_token_id),
  CHECK (status_token_hmac <> replay_token_hmac),
  CHECK (state IN ('queued', 'running', 'complete', 'failed')),
  CHECK (anonymous_historical_totals_retained IN (0, 1)),
  CHECK (length(requested_at) BETWEEN 20 AND 30 AND substr(requested_at, -1) = 'Z'),
  CHECK (started_at IS NULL OR (length(started_at) BETWEEN 20 AND 30 AND substr(started_at, -1) = 'Z')),
  CHECK (finished_at IS NULL OR (length(finished_at) BETWEEN 20 AND 30 AND substr(finished_at, -1) = 'Z')),
  CHECK (length(expires_at) BETWEEN 20 AND 30 AND substr(expires_at, -1) = 'Z'),
  CHECK (expires_at > requested_at),
  CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 64),
  CHECK (
    (state = 'queued' AND started_at IS NULL AND finished_at IS NULL AND failure_code IS NULL)
    OR (state = 'running' AND started_at IS NOT NULL AND finished_at IS NULL AND failure_code IS NULL)
    OR (state = 'complete' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND failure_code IS NULL)
    OR (state = 'failed' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND failure_code IS NOT NULL)
  )
) STRICT;

-- Presence of the singleton row marks the public projection dirty. Runtime
-- writers upsert it in the same D1 batch as their canonical mutation.
CREATE TABLE aggregate_dirty (
  singleton_key INTEGER NOT NULL PRIMARY KEY,
  dirty_since TEXT NOT NULL,
  reason TEXT NOT NULL,
  dirty_revision INTEGER NOT NULL,
  CHECK (singleton_key = 1),
  CHECK (length(dirty_since) BETWEEN 20 AND 30 AND substr(dirty_since, -1) = 'Z'),
  CHECK (reason IN ('ingest', 'compaction', 'delete', 'migration')),
  CHECK (dirty_revision >= 1)
) STRICT;

-- Optimistic mutation guards close the gap between a primary preflight read
-- and D1's atomic batch commit. Every expectation row is inserted and checked
-- inside the same batch as its writes; any mismatch aborts the entire batch.
-- Normal batches delete their random request row last, cascading all
-- expectations. expires_at exists only for defense-in-depth cleanup.
CREATE TABLE mutation_guards (
  request_id TEXT NOT NULL PRIMARY KEY,
  operation TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (length(request_id) BETWEEN 16 AND 128),
  CHECK (operation IN ('enrollment', 'ingest', 'begin-delete', 'complete-delete', 'restore-purge')),
  CHECK (length(expires_at) BETWEEN 20 AND 30 AND substr(expires_at, -1) = 'Z')
) STRICT;

CREATE TABLE mutation_guard_installations (
  request_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  expected_exists INTEGER NOT NULL,
  expected_status TEXT,
  expected_consent_document_revision TEXT,
  expected_upload_token_id TEXT,
  expected_upload_token_hmac BLOB,
  expected_upload_hmac_key_id TEXT,
  expected_deletion_token_id TEXT,
  expected_deletion_token_hmac BLOB,
  expected_deletion_hmac_key_id TEXT,
  PRIMARY KEY (request_id, installation_id),
  FOREIGN KEY (request_id) REFERENCES mutation_guards(request_id) ON DELETE CASCADE,
  CHECK (length(installation_id) BETWEEN 16 AND 128),
  CHECK (expected_exists IN (0, 1)),
  CHECK (
    (expected_exists = 0
      AND expected_status IS NULL
      AND expected_consent_document_revision IS NULL
      AND expected_upload_token_id IS NULL
      AND expected_upload_token_hmac IS NULL
      AND expected_upload_hmac_key_id IS NULL
      AND expected_deletion_token_id IS NULL
      AND expected_deletion_token_hmac IS NULL
      AND expected_deletion_hmac_key_id IS NULL)
    OR (expected_exists = 1
      AND expected_status IN ('active', 'paused', 'deleting', 'deleted')
      AND length(expected_consent_document_revision) BETWEEN 1 AND 128)
  )
) STRICT;

CREATE TRIGGER mutation_guard_installations_assert
BEFORE INSERT ON mutation_guard_installations
BEGIN
  SELECT RAISE(ABORT, 'TM_GUARD_INSTALLATION')
  WHERE
    (NEW.expected_exists = 0 AND EXISTS (
      SELECT 1 FROM installations
      WHERE installation_id = NEW.installation_id
    ))
    OR
    (NEW.expected_exists = 1 AND NOT EXISTS (
      SELECT 1 FROM installations
      WHERE installation_id = NEW.installation_id
        AND status = NEW.expected_status
        AND consent_document_revision = NEW.expected_consent_document_revision
        AND upload_token_id IS NEW.expected_upload_token_id
        AND upload_token_hmac IS NEW.expected_upload_token_hmac
        AND upload_hmac_key_id IS NEW.expected_upload_hmac_key_id
        AND deletion_token_id IS NEW.expected_deletion_token_id
        AND deletion_token_hmac IS NEW.expected_deletion_token_hmac
        AND deletion_hmac_key_id IS NEW.expected_deletion_hmac_key_id
    ));
END;

CREATE TABLE mutation_guard_batches (
  request_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  expected_exists INTEGER NOT NULL,
  expected_payload_hash BLOB,
  expected_applied_bucket_count INTEGER,
  expected_stale_bucket_count INTEGER,
  expected_idempotent_bucket_count INTEGER,
  expected_quarantined_bucket_count INTEGER,
  expected_created_at TEXT,
  PRIMARY KEY (request_id, installation_id, batch_id),
  FOREIGN KEY (request_id) REFERENCES mutation_guards(request_id) ON DELETE CASCADE,
  CHECK (expected_exists IN (0, 1)),
  CHECK (
    (expected_exists = 0
      AND expected_payload_hash IS NULL
      AND expected_applied_bucket_count IS NULL
      AND expected_stale_bucket_count IS NULL
      AND expected_idempotent_bucket_count IS NULL
      AND expected_quarantined_bucket_count IS NULL
      AND expected_created_at IS NULL)
    OR (expected_exists = 1
      AND length(expected_payload_hash) = 32
      AND expected_applied_bucket_count BETWEEN 0 AND 30
      AND expected_stale_bucket_count BETWEEN 0 AND 30
      AND expected_idempotent_bucket_count BETWEEN 0 AND 30
      AND expected_quarantined_bucket_count BETWEEN 0 AND 30
      AND expected_created_at IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER mutation_guard_batches_assert
BEFORE INSERT ON mutation_guard_batches
BEGIN
  SELECT RAISE(ABORT, 'TM_GUARD_BATCH')
  WHERE
    (NEW.expected_exists = 0 AND EXISTS (
      SELECT 1 FROM ingest_batches
      WHERE installation_id = NEW.installation_id AND batch_id = NEW.batch_id
    ))
    OR
    (NEW.expected_exists = 1 AND NOT EXISTS (
      SELECT 1 FROM ingest_batches
      WHERE installation_id = NEW.installation_id
        AND batch_id = NEW.batch_id
        AND payload_hash = NEW.expected_payload_hash
        AND applied_bucket_count = NEW.expected_applied_bucket_count
        AND stale_bucket_count = NEW.expected_stale_bucket_count
        AND idempotent_bucket_count = NEW.expected_idempotent_bucket_count
        AND quarantined_bucket_count = NEW.expected_quarantined_bucket_count
        AND created_at = NEW.expected_created_at
    ));
END;

CREATE TABLE mutation_guard_authorities (
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
      AND expected_collector_kind IN ('tokscale', 'tokentracker-bridge')
      AND expected_adapter_version IS NOT NULL
      AND expected_source_version IS NOT NULL)
  )
) STRICT;

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

CREATE TABLE mutation_guard_usage (
  request_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_family TEXT NOT NULL,
  tool TEXT NOT NULL,
  expected_exists INTEGER NOT NULL,
  expected_revision INTEGER,
  expected_row_hash BLOB,
  PRIMARY KEY (
    request_id,
    installation_id,
    bucket_start,
    provider,
    model_family,
    tool
  ),
  FOREIGN KEY (request_id) REFERENCES mutation_guards(request_id) ON DELETE CASCADE,
  CHECK (expected_exists IN (0, 1)),
  CHECK (
    (expected_exists = 0 AND expected_revision IS NULL AND expected_row_hash IS NULL)
    OR (expected_exists = 1
      AND expected_revision BETWEEN 1 AND 9007199254740991
      AND length(expected_row_hash) = 32)
  )
) STRICT;

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

CREATE TABLE mutation_guard_deletions (
  request_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  expected_exists INTEGER NOT NULL,
  expected_job_id TEXT,
  expected_state TEXT,
  expected_status_token_id TEXT,
  expected_status_token_hmac BLOB,
  expected_status_hmac_key_id TEXT,
  expected_replay_token_id TEXT,
  expected_replay_token_hmac BLOB,
  expected_replay_hmac_key_id TEXT,
  expected_anonymous_historical_totals_retained INTEGER,
  expected_requested_at TEXT,
  expected_finished_at TEXT,
  expected_expires_at TEXT,
  PRIMARY KEY (request_id, installation_id, idempotency_key),
  FOREIGN KEY (request_id) REFERENCES mutation_guards(request_id) ON DELETE CASCADE,
  CHECK (expected_exists IN (0, 1)),
  CHECK (
    (expected_exists = 0
      AND expected_job_id IS NULL
      AND expected_state IS NULL
      AND expected_status_token_id IS NULL
      AND expected_status_token_hmac IS NULL
      AND expected_status_hmac_key_id IS NULL
      AND expected_replay_token_id IS NULL
      AND expected_replay_token_hmac IS NULL
      AND expected_replay_hmac_key_id IS NULL
      AND expected_anonymous_historical_totals_retained IS NULL
      AND expected_requested_at IS NULL
      AND expected_finished_at IS NULL
      AND expected_expires_at IS NULL)
    OR (expected_exists = 1
      AND expected_job_id IS NOT NULL
      AND expected_state IN ('queued', 'running', 'complete', 'failed')
      AND length(expected_status_token_id) BETWEEN 16 AND 32
      AND length(expected_status_token_hmac) = 32
      AND length(expected_status_hmac_key_id) BETWEEN 1 AND 32
      AND length(expected_replay_token_id) BETWEEN 16 AND 32
      AND length(expected_replay_token_hmac) = 32
      AND length(expected_replay_hmac_key_id) BETWEEN 1 AND 32
      AND expected_anonymous_historical_totals_retained = 1
      AND expected_requested_at IS NOT NULL
      AND expected_expires_at IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER mutation_guard_deletions_assert
BEFORE INSERT ON mutation_guard_deletions
BEGIN
  SELECT RAISE(ABORT, 'TM_GUARD_DELETION')
  WHERE
    (NEW.expected_exists = 0 AND EXISTS (
      SELECT 1 FROM deletion_jobs
      WHERE installation_id = NEW.installation_id
        AND idempotency_key = NEW.idempotency_key
    ))
    OR
    (NEW.expected_exists = 1 AND NOT EXISTS (
      SELECT 1 FROM deletion_jobs
      WHERE installation_id = NEW.installation_id
        AND idempotency_key = NEW.idempotency_key
        AND job_id = NEW.expected_job_id
        AND state = NEW.expected_state
        AND status_token_id = NEW.expected_status_token_id
        AND status_token_hmac = NEW.expected_status_token_hmac
        AND status_hmac_key_id = NEW.expected_status_hmac_key_id
        AND replay_token_id = NEW.expected_replay_token_id
        AND replay_token_hmac = NEW.expected_replay_token_hmac
        AND replay_hmac_key_id = NEW.expected_replay_hmac_key_id
        AND anonymous_historical_totals_retained = NEW.expected_anonymous_historical_totals_retained
        AND requested_at = NEW.expected_requested_at
        AND finished_at IS NEW.expected_finished_at
        AND expires_at = NEW.expected_expires_at
    ));
END;

CREATE INDEX consent_receipts_installation_occurred_idx
  ON consent_receipts(installation_id, occurred_at);
CREATE INDEX consent_receipts_expires_idx
  ON consent_receipts(expires_at, event_id);
CREATE INDEX collector_window_bindings_expires_idx
  ON collector_window_bindings(expires_at);
CREATE INDEX ingest_batches_created_idx
  ON ingest_batches(created_at);
CREATE INDEX ingest_batches_expires_idx
  ON ingest_batches(expires_at, installation_id, batch_id);
CREATE INDEX usage_daily_current_bucket_quarantine_idx
  ON usage_daily_current(bucket_start, quarantine_status);
CREATE INDEX usage_daily_current_installation_bucket_revision_idx
  ON usage_daily_current(installation_id, bucket_start, revision);
CREATE INDEX usage_daily_current_expires_idx
  ON usage_daily_current(expires_at, installation_id, bucket_start);
CREATE INDEX anonymous_rollups_period_idx
  ON anonymous_rollups(period_start, period_end);
CREATE INDEX compaction_runs_finished_idx
  ON compaction_runs(finished_at);
CREATE INDEX share_cards_expires_revoked_idx
  ON share_cards(expires_at, revoked_at);
CREATE INDEX share_cards_revoked_idx
  ON share_cards(revoked_at, share_id);
CREATE INDEX security_rate_events_created_idx
  ON security_rate_events(created_at);
CREATE INDEX security_rate_events_expires_idx
  ON security_rate_events(expires_at, event_id);
CREATE INDEX quarantine_events_expires_idx
  ON quarantine_events(expires_at);
CREATE INDEX deletion_jobs_state_expires_idx
  ON deletion_jobs(state, expires_at);
CREATE INDEX deletion_jobs_expires_idx
  ON deletion_jobs(expires_at, job_id);
CREATE INDEX deletion_jobs_replay_idx
  ON deletion_jobs(replay_token_id, expires_at);
CREATE INDEX installations_receipt_expires_idx
  ON installations(receipt_expires_at, status, installation_id);
CREATE INDEX mutation_guards_expires_idx
  ON mutation_guards(expires_at);
