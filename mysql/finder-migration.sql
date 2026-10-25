USE personal_cloud;

ALTER TABLE cloud_users
  ADD COLUMN storage_quota_bytes BIGINT UNSIGNED NOT NULL DEFAULT 107374182400;

ALTER TABLE cloud_folders
  DROP INDEX cloud_folders_owner_parent_name_uq,
  ADD COLUMN tags JSON NOT NULL DEFAULT (JSON_ARRAY()),
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN active_name VARCHAR(80) GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN name ELSE NULL END) STORED,
  ADD UNIQUE KEY cloud_folders_owner_parent_name_uq (owner_id, parent_scope, active_name),
  ADD KEY cloud_folders_trash_idx (owner_id, deleted_at, updated_at);

ALTER TABLE cloud_files
  DROP INDEX cloud_files_owner_folder_name_uq,
  ADD COLUMN tags JSON NOT NULL DEFAULT (JSON_ARRAY()),
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN active_name VARCHAR(180) GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN name ELSE NULL END) STORED,
  ADD UNIQUE KEY cloud_files_owner_folder_name_uq (owner_id, folder_scope, active_name),
  ADD KEY cloud_files_trash_idx (owner_id, deleted_at, updated_at);

CREATE TABLE IF NOT EXISTS cloud_shares (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  file_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  folder_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  token CHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  permission ENUM('read', 'edit') NOT NULL DEFAULT 'read',
  password_hash VARCHAR(180) CHARACTER SET ascii NULL,
  expires_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY cloud_shares_token_uq (token),
  KEY cloud_shares_file_idx (owner_id, file_id),
  KEY cloud_shares_folder_idx (owner_id, folder_id),
  CONSTRAINT cloud_shares_owner_fk
    FOREIGN KEY (owner_id) REFERENCES cloud_users (id) ON DELETE CASCADE,
  CONSTRAINT cloud_shares_file_fk
    FOREIGN KEY (file_id) REFERENCES cloud_files (id) ON DELETE CASCADE,
  CONSTRAINT cloud_shares_folder_fk
    FOREIGN KEY (folder_id) REFERENCES cloud_folders (id) ON DELETE CASCADE,
  CONSTRAINT cloud_shares_node_check CHECK ((file_id IS NULL) <> (folder_id IS NULL))
) ENGINE=InnoDB;
