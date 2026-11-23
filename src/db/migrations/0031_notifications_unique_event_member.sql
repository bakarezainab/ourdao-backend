-- compat: backward-compatible
-- #271 — prevent duplicate notifications created for identical event_id on concurrent worker replay

-- Add unique constraint on (event_id, address) to prevent duplicate notifications
-- from the same event to the same member during replay
CREATE UNIQUE INDEX IF NOT EXISTS notifications_event_id_address_uniq ON notifications (event_id, address) WHERE event_id IS NOT NULL;
