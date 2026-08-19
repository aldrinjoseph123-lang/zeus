-- Renamed in the previous migration to backup.retainDaily/Weekly/Monthly.
-- The old row was never deleted, so it kept surviving alongside the new keys
-- and rendering unlabeled in Settings (no entry in SETTING_DEFAULTS anymore).
DELETE FROM "Setting" WHERE "key" = 'backup.retainLocal';
