CREATE TABLE IF NOT EXISTS drive_folder (
  user_id VARCHAR(36) NOT NULL,
  folder_id VARCHAR(255) NOT NULL,
  folder_name VARCHAR(255) NOT NULL,
  last_synced_at DATETIME(3) NULL,
  PRIMARY KEY (user_id, folder_id)
);
CREATE TABLE IF NOT EXISTS media_source (
  user_id VARCHAR(36) NOT NULL,
  folder_id VARCHAR(255) NOT NULL,
  media_id VARCHAR(36) NOT NULL,
  PRIMARY KEY (user_id, folder_id, media_id),
  FOREIGN KEY (user_id, folder_id) REFERENCES drive_folder(user_id, folder_id) ON DELETE CASCADE,
  FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
  INDEX media_source_media (media_id)
);
INSERT IGNORE INTO drive_folder (user_id, folder_id, folder_name, last_synced_at)
  SELECT user_id, folder_id, COALESCE(folder_name, folder_id), last_synced_at FROM drive_source WHERE folder_id IS NOT NULL;
INSERT IGNORE INTO media_source (user_id, folder_id, media_id)
  SELECT m.user_id, s.folder_id, m.id FROM media m JOIN drive_source s ON s.user_id=m.user_id WHERE m.available=TRUE AND s.folder_id IS NOT NULL;
