CREATE TABLE IF NOT EXISTS workspace (
 id INT PRIMARY KEY, owner_id VARCHAR(36) NULL UNIQUE, folder_id VARCHAR(255) NULL, folder_name VARCHAR(255) NULL,
 last_synced_at DATETIME(3) NULL
);
INSERT IGNORE INTO workspace (id) VALUES (1);
CREATE TABLE IF NOT EXISTS media (
 id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36) NOT NULL, drive_id VARCHAR(255) NOT NULL,
 display_name VARCHAR(255) NOT NULL, raw_name VARCHAR(255) NOT NULL, mime_type VARCHAR(127) NOT NULL,
 tags JSON NOT NULL, created_at DATETIME(3) NOT NULL, uploaded_at DATETIME(3) NOT NULL,
 size BIGINT UNSIGNED NOT NULL DEFAULT 0, width INT NULL, height INT NULL, duration_ms BIGINT NULL,
 available BOOLEAN NOT NULL DEFAULT TRUE, synced_at DATETIME(3) NOT NULL,
 UNIQUE KEY drive_owner (user_id, drive_id), INDEX owner_uploaded (user_id, uploaded_at)
);
CREATE TABLE IF NOT EXISTS media_set (
 id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36) NOT NULL, display_name VARCHAR(255) NOT NULL,
 raw_name VARCHAR(255) NOT NULL, tags JSON NOT NULL, created_at DATETIME(3) NOT NULL,
 uploaded_at DATETIME(3) NULL, INDEX owner_created (user_id, created_at)
);
CREATE TABLE IF NOT EXISTS set_member (
 set_id VARCHAR(36) NOT NULL, media_id VARCHAR(36) NOT NULL, PRIMARY KEY (set_id, media_id),
 FOREIGN KEY (set_id) REFERENCES media_set(id) ON DELETE CASCADE,
 FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS post (
 id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36) NOT NULL,
 media_id VARCHAR(36) NULL, set_id VARCHAR(36) NULL,
 platform VARCHAR(100) NOT NULL, url VARCHAR(2048) NOT NULL, external_id VARCHAR(255) NOT NULL DEFAULT '',
 created_at DATETIME(3) NOT NULL,
 CHECK ((media_id IS NULL) <> (set_id IS NULL)),
 FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
 FOREIGN KEY (set_id) REFERENCES media_set(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS drive_source (
 user_id VARCHAR(36) PRIMARY KEY, folder_id VARCHAR(255) NULL, folder_name VARCHAR(255) NULL,
 last_synced_at DATETIME(3) NULL
);
