-- Infrastructure alerts belong to Administrators only: a sales manager cannot fix a backup.
-- New installs have created these rules that way for a while, but installs whose rules
-- predate it still send them to Sales Managers as well. Move only the rules still on that
-- old default; a rule set to anything else was chosen by hand and stays as it is.
UPDATE "NotificationRule"
SET "audience" = 'administrators'
WHERE "event" IN ('backup_failed', 'backup_missed', 'backup_verify_failed', 'data_integrity_failed', 'component_down', 'component_recovered')
  AND "audience" = 'admins';
