CREATE TABLE IF NOT EXISTS drive_sync_run (
 user_id VARCHAR(36) PRIMARY KEY, run_id VARCHAR(36) NOT NULL,
 origin VARCHAR(16) NOT NULL, status VARCHAR(16) NOT NULL, phase VARCHAR(16) NOT NULL,
 folders_scanned INT NOT NULL DEFAULT 0, files_found INT NOT NULL DEFAULT 0,
 files_saved INT NOT NULL DEFAULT 0, files_total INT NOT NULL DEFAULT 0,
 item_count INT NULL, error VARCHAR(1000) NULL,
 started_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, finished_at DATETIME(3) NULL
);
