-- Shared-folder mode: the Drive permission MediaBinder created when it shared a
-- folder with its service account, so unlinking can remove that access again.
ALTER TABLE drive_folder ADD COLUMN share_permission_id VARCHAR(255) NULL;
