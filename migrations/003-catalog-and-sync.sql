CREATE TABLE IF NOT EXISTS tag_definition (
 user_id VARCHAR(36) NOT NULL, name VARCHAR(50) NOT NULL, color CHAR(7) NOT NULL,
 PRIMARY KEY(user_id,name)
);
INSERT IGNORE INTO tag_definition(user_id,name,color)
 SELECT t.user_id, j.name, ELT(1+FLOOR(RAND()*10),'#7dd3fc','#c4b5fd','#fda4af','#86efac','#fcd34d','#67e8f9','#f0abfc','#fdba74','#a5b4fc','#5eead4')
 FROM (SELECT user_id,tags FROM media UNION ALL SELECT user_id,tags FROM media_set) t,
 JSON_TABLE(t.tags,'$[*]' COLUMNS(name VARCHAR(50) PATH '$')) j;
CREATE TABLE IF NOT EXISTS media_location (
 media_id VARCHAR(36) PRIMARY KEY, parent_ids JSON NOT NULL,
 FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS drive_watch (
 id VARCHAR(64) PRIMARY KEY, user_id VARCHAR(36) NOT NULL, scope VARCHAR(255) NOT NULL,
 token_hash CHAR(64) NOT NULL, resource_id VARCHAR(255) NULL,
 callback_url VARCHAR(2048) NOT NULL, expires_at DATETIME(3) NOT NULL,
 last_message DECIMAL(65,0) NOT NULL DEFAULT 0,
 INDEX watch_owner(user_id,scope,expires_at)
);
CREATE TABLE IF NOT EXISTS drive_sync_state (
 user_id VARCHAR(36) PRIMARY KEY, requested BIGINT NOT NULL DEFAULT 0,
 completed BIGINT NOT NULL DEFAULT 0, attempts INT NOT NULL DEFAULT 0,
 next_attempt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 last_error VARCHAR(1000) NULL,
 watch_next_check DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 watch_error VARCHAR(1000) NULL
);
