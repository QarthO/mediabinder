CREATE TABLE IF NOT EXISTS catalog (
 id VARCHAR(36) PRIMARY KEY,
 display_name VARCHAR(255) NOT NULL, tags JSON NOT NULL, created_at DATETIME(3) NOT NULL,
 cataloged_at DATETIME(3) NULL, sha256 CHAR(64) NULL, merged_into VARCHAR(36) NULL,
 INDEX catalog_hash (sha256), INDEX catalog_merged (merged_into)
);
INSERT IGNORE INTO catalog(id,display_name,tags,created_at,cataloged_at)
 SELECT m.id,m.display_name,m.tags,m.created_at,
 CASE WHEN JSON_LENGTH(m.tags)>0 OR m.display_name<>REGEXP_REPLACE(m.raw_name,'\\.[^.]+$','')
 OR EXISTS(SELECT 1 FROM set_member s WHERE s.media_id=m.id)
 OR EXISTS(SELECT 1 FROM post p WHERE p.media_id=m.id) THEN NOW(3) ELSE NULL END FROM media m;
ALTER TABLE media ADD COLUMN catalog_id VARCHAR(36) NULL, ADD INDEX media_catalog_owner(catalog_id,user_id,available);
UPDATE media SET catalog_id=id WHERE catalog_id IS NULL;
ALTER TABLE media ADD CONSTRAINT media_catalog_fk FOREIGN KEY(catalog_id) REFERENCES catalog(id);
CREATE TABLE IF NOT EXISTS catalog_identity (
 identity_key VARCHAR(330) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 catalog_id VARCHAR(36) NOT NULL,
 FOREIGN KEY(catalog_id) REFERENCES catalog(id), INDEX identity_catalog(catalog_id)
);
CREATE TABLE IF NOT EXISTS catalog_set_member (
 set_id VARCHAR(36) NOT NULL, catalog_id VARCHAR(36) NOT NULL,
 PRIMARY KEY(set_id,catalog_id),
 FOREIGN KEY(set_id) REFERENCES media_set(id) ON DELETE CASCADE,
 FOREIGN KEY(catalog_id) REFERENCES catalog(id)
);
INSERT IGNORE INTO catalog_set_member SELECT set_id,media_id FROM set_member;
ALTER TABLE post ADD COLUMN catalog_id VARCHAR(36) NULL, ADD INDEX post_catalog(catalog_id),
 ADD CONSTRAINT post_catalog_fk FOREIGN KEY(catalog_id) REFERENCES catalog(id);
UPDATE post SET catalog_id=media_id WHERE media_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS catalog_tag (
 name VARCHAR(50) PRIMARY KEY, color CHAR(7) NOT NULL
);
INSERT IGNORE INTO catalog_tag(name,color) SELECT name,MIN(color) FROM tag_definition GROUP BY name;
