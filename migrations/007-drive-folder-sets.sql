-- Sets that follow a first-level Drive subfolder of a linked folder. The column
-- ties a set to the subfolder's Drive ID so renaming either side never makes a
-- duplicate; the table records each (subfolder, media) pairing once applied, so
-- a photo the user removed from the set isn't added back by the next sync.
ALTER TABLE media_set
  ADD COLUMN drive_folder_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD UNIQUE INDEX media_set_drive_folder (user_id, drive_folder_id);
CREATE TABLE IF NOT EXISTS drive_folder_set_applied (
  user_id VARCHAR(36) NOT NULL,
  folder_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  media_id VARCHAR(36) NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, folder_id, media_id),
  FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
);
