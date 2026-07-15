-- Additive, mapping-free audit evidence for the day-level anonymous
-- compactor. NULL means "legacy unknown" for rows completed before this
-- migration; runtime readers must never coerce it to zero.
ALTER TABLE compaction_runs ADD COLUMN deleted_binding_count INTEGER
  CHECK (deleted_binding_count IS NULL OR deleted_binding_count >= 0);
ALTER TABLE compaction_runs ADD COLUMN deleted_batch_receipt_count INTEGER
  CHECK (deleted_batch_receipt_count IS NULL OR deleted_batch_receipt_count >= 0);
ALTER TABLE compaction_runs ADD COLUMN deleted_quarantine_event_count INTEGER
  CHECK (deleted_quarantine_event_count IS NULL OR deleted_quarantine_event_count >= 0);
ALTER TABLE compaction_runs ADD COLUMN input_tokens INTEGER
  CHECK (input_tokens IS NULL OR input_tokens >= 0);
ALTER TABLE compaction_runs ADD COLUMN output_tokens INTEGER
  CHECK (output_tokens IS NULL OR output_tokens >= 0);
ALTER TABLE compaction_runs ADD COLUMN cache_read_tokens INTEGER
  CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0);
ALTER TABLE compaction_runs ADD COLUMN cache_write_tokens INTEGER
  CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0);
ALTER TABLE compaction_runs ADD COLUMN reasoning_tokens INTEGER
  CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0);
ALTER TABLE compaction_runs ADD COLUMN other_tokens INTEGER
  CHECK (other_tokens IS NULL OR other_tokens >= 0);
ALTER TABLE compaction_runs ADD COLUMN total_tokens INTEGER
  CHECK (total_tokens IS NULL OR total_tokens >= 0);

-- A dropped/small cohort may retain only content-free operation counts. Its
-- token totals and receipt breakdown must not be moved into an audit table.
-- A newly completed rolled row, on the other hand, must carry internally
-- consistent evidence for the mapping-free anonymous output. Legacy rows
-- that existed before this additive migration remain NULL/unknown.
CREATE TRIGGER compaction_runs_private_shape_insert
BEFORE INSERT ON compaction_runs
BEGIN
  SELECT RAISE(ABORT, 'TM_COMPACTION_PRIVATE_SHAPE')
  WHERE NOT (
      NEW.status = 'completed'
      AND NEW.k_gate_result = 'rolled_up'
      AND NEW.eligible_cohort_count >= 20
    )
    AND (
      NEW.deleted_binding_count IS NOT NULL
      OR NEW.deleted_batch_receipt_count IS NOT NULL
      OR NEW.deleted_quarantine_event_count IS NOT NULL
      OR NEW.input_tokens IS NOT NULL
      OR NEW.output_tokens IS NOT NULL
      OR NEW.cache_read_tokens IS NOT NULL
      OR NEW.cache_write_tokens IS NOT NULL
      OR NEW.reasoning_tokens IS NOT NULL
      OR NEW.other_tokens IS NOT NULL
      OR NEW.total_tokens IS NOT NULL
    );
  SELECT RAISE(ABORT, 'TM_COMPACTION_ROLLUP_AUDIT')
  WHERE NEW.status = 'completed'
    AND NEW.k_gate_result = 'rolled_up'
    AND (
      NEW.eligible_cohort_count < 20
      OR NEW.deleted_binding_count IS NULL
      OR NEW.deleted_batch_receipt_count IS NULL
      OR NEW.deleted_quarantine_event_count IS NULL
      OR NEW.input_tokens IS NULL
      OR NEW.output_tokens IS NULL
      OR NEW.cache_read_tokens IS NULL
      OR NEW.cache_write_tokens IS NULL
      OR NEW.reasoning_tokens IS NULL
      OR NEW.other_tokens IS NULL
      OR NEW.total_tokens IS NULL
      OR NEW.reasoning_tokens > NEW.output_tokens
      OR NEW.total_tokens <> NEW.input_tokens + NEW.output_tokens
        + NEW.cache_read_tokens + NEW.cache_write_tokens + NEW.other_tokens
    );
END;

CREATE TRIGGER compaction_runs_private_shape_update
BEFORE UPDATE ON compaction_runs
BEGIN
  SELECT RAISE(ABORT, 'TM_COMPACTION_PRIVATE_SHAPE')
  WHERE NOT (
      NEW.status = 'completed'
      AND NEW.k_gate_result = 'rolled_up'
      AND NEW.eligible_cohort_count >= 20
    )
    AND (
      NEW.deleted_binding_count IS NOT NULL
      OR NEW.deleted_batch_receipt_count IS NOT NULL
      OR NEW.deleted_quarantine_event_count IS NOT NULL
      OR NEW.input_tokens IS NOT NULL
      OR NEW.output_tokens IS NOT NULL
      OR NEW.cache_read_tokens IS NOT NULL
      OR NEW.cache_write_tokens IS NOT NULL
      OR NEW.reasoning_tokens IS NOT NULL
      OR NEW.other_tokens IS NOT NULL
      OR NEW.total_tokens IS NOT NULL
    );
  SELECT RAISE(ABORT, 'TM_COMPACTION_ROLLUP_AUDIT')
  WHERE NEW.status = 'completed'
    AND NEW.k_gate_result = 'rolled_up'
    AND (
      NEW.eligible_cohort_count < 20
      OR NEW.deleted_binding_count IS NULL
      OR NEW.deleted_batch_receipt_count IS NULL
      OR NEW.deleted_quarantine_event_count IS NULL
      OR NEW.input_tokens IS NULL
      OR NEW.output_tokens IS NULL
      OR NEW.cache_read_tokens IS NULL
      OR NEW.cache_write_tokens IS NULL
      OR NEW.reasoning_tokens IS NULL
      OR NEW.other_tokens IS NULL
      OR NEW.total_tokens IS NULL
      OR NEW.reasoning_tokens > NEW.output_tokens
      OR NEW.total_tokens <> NEW.input_tokens + NEW.output_tokens
        + NEW.cache_read_tokens + NEW.cache_write_tokens + NEW.other_tokens
    );
END;

CREATE TRIGGER compaction_runs_day_all_shape_insert
BEFORE INSERT ON compaction_runs
WHEN NEW.compaction_version = 'day-all-v1'
BEGIN
  SELECT RAISE(ABORT, 'TM_COMPACTION_DAY_SHAPE')
  WHERE date(NEW.period_start) IS NULL
    OR date(NEW.period_end) IS NULL
    OR NEW.period_start <> date(NEW.period_start)
    OR NEW.period_end <> date(NEW.period_end)
    OR NEW.period_end <> date(NEW.period_start, '+1 day');
END;

CREATE TRIGGER compaction_runs_day_all_shape_update
BEFORE UPDATE ON compaction_runs
WHEN OLD.compaction_version = 'day-all-v1'
  OR NEW.compaction_version = 'day-all-v1'
BEGIN
  SELECT RAISE(ABORT, 'TM_COMPACTION_IMMUTABLE');
END;

CREATE TRIGGER compaction_runs_day_all_delete
BEFORE DELETE ON compaction_runs
WHEN OLD.compaction_version = 'day-all-v1'
BEGIN
  SELECT RAISE(ABORT, 'TM_COMPACTION_IMMUTABLE');
END;

CREATE TRIGGER anonymous_rollups_day_all_shape_insert
BEFORE INSERT ON anonymous_rollups
WHEN NEW.compaction_version = 'day-all-v1'
BEGIN
  SELECT RAISE(ABORT, 'TM_COMPACTION_DAY_SHAPE')
  WHERE date(NEW.period_start) IS NULL
    OR date(NEW.period_end) IS NULL
    OR NEW.period_start <> date(NEW.period_start)
    OR NEW.period_end <> date(NEW.period_end)
    OR NEW.period_end <> date(NEW.period_start, '+1 day')
    OR NEW.scope <> 'all'
    OR NEW.provider <> 'other'
    OR NEW.model_family <> 'all'
    OR NEW.tool <> 'all';
END;

CREATE TRIGGER anonymous_rollups_day_all_shape_update
BEFORE UPDATE ON anonymous_rollups
WHEN OLD.compaction_version = 'day-all-v1'
  OR NEW.compaction_version = 'day-all-v1'
BEGIN
  SELECT RAISE(ABORT, 'TM_COMPACTION_IMMUTABLE');
END;

CREATE TRIGGER anonymous_rollups_day_all_delete
BEFORE DELETE ON anonymous_rollups
WHEN OLD.compaction_version = 'day-all-v1'
BEGIN
  SELECT RAISE(ABORT, 'TM_COMPACTION_IMMUTABLE');
END;

-- A completed day is immutable. This closes an ingest-preflight race after
-- the compactor has removed that day's authority binding and source rows.
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
