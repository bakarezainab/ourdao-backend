-- compat: backward-compatible
-- Issue #499: attribute quarantined failures to their source contract.
ALTER TABLE failed_events ADD COLUMN IF NOT EXISTS contract_id TEXT;

UPDATE failed_events AS f
   SET contract_id = e.contract_id
  FROM events AS e
 WHERE e.id = f.event_id
   AND f.contract_id IS NULL;

CREATE INDEX IF NOT EXISTS failed_events_contract_id_idx ON failed_events (contract_id);
