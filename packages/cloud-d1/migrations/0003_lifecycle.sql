-- Additive upgrade support for pause/resume lifecycle operations. Triggers
-- strengthen the installation status/timestamp relation without rebuilding
-- the foreign-key-connected mutation guard graph.
CREATE INDEX IF NOT EXISTS consent_receipts_installation_revision_idx
  ON consent_receipts(
    installation_id,
    document_revision,
    granted,
    recorded_at DESC,
    event_id DESC
  );

CREATE TRIGGER IF NOT EXISTS installations_pause_state_insert
BEFORE INSERT ON installations
WHEN
  (NEW.status = 'paused' AND NEW.paused_at IS NULL)
  OR (
    NEW.paused_at IS NOT NULL
    AND NEW.status NOT IN ('paused', 'deleting', 'deleted')
  )
BEGIN
  SELECT RAISE(ABORT, 'TM_INSTALLATION_PAUSE_STATE');
END;

CREATE TRIGGER IF NOT EXISTS installations_pause_state_update
BEFORE UPDATE OF status, paused_at ON installations
WHEN
  (NEW.status = 'paused' AND NEW.paused_at IS NULL)
  OR (
    NEW.paused_at IS NOT NULL
    AND NEW.status NOT IN ('paused', 'deleting', 'deleted')
  )
BEGIN
  SELECT RAISE(ABORT, 'TM_INSTALLATION_PAUSE_STATE');
END;
