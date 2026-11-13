-- The folder tree under each linked folder, as the last successful sync saw it.
-- It lets a file's parent folder be shown as a path from its linked folder.
-- A folder reachable from two linked folders has one row under each, and
-- unlinking a folder removes its rows.
CREATE TABLE IF NOT EXISTS drive_folder_node (
  user_id VARCHAR(36) NOT NULL,
  root_folder_id VARCHAR(255) NOT NULL,
  folder_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parent_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(1024) NOT NULL,
  synced_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, root_folder_id, folder_id),
  INDEX drive_folder_node_folder (user_id, folder_id),
  FOREIGN KEY (user_id, root_folder_id) REFERENCES drive_folder(user_id, folder_id) ON DELETE CASCADE
);
