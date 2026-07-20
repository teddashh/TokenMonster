-- V2 enrollment credentials are generated and durably stored by the trusted
-- native client before the request. D1 retains only public lookup IDs and
-- HMAC-SHA-256 verifiers; raw bearer secrets never enter cloud storage.
CREATE TABLE recoverable_enrollments (
  recovery_token_id TEXT NOT NULL PRIMARY KEY,
  recovery_token_hmac BLOB NOT NULL UNIQUE,
  recovery_hmac_key_id TEXT NOT NULL,
  installation_id TEXT NOT NULL UNIQUE,
  consent_event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES installations(installation_id) ON DELETE CASCADE,
  FOREIGN KEY (consent_event_id) REFERENCES consent_receipts(event_id) ON DELETE CASCADE,
  CHECK (length(recovery_token_id) = 24),
  CHECK (recovery_token_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  CHECK (length(recovery_token_hmac) = 32),
  CHECK (length(recovery_hmac_key_id) BETWEEN 1 AND 32),
  CHECK (length(created_at) BETWEEN 20 AND 30 AND substr(created_at, -1) = 'Z')
) STRICT;
