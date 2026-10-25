CREATE DATABASE IF NOT EXISTS personal_cloud
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE personal_cloud;

CREATE TABLE IF NOT EXISTS cloud_users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  username VARCHAR(320) NOT NULL,
  password_hash VARCHAR(180) CHARACTER SET ascii NOT NULL,
  storage_quota_bytes BIGINT UNSIGNED NOT NULL DEFAULT 107374182400,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY cloud_users_username_uq (username)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cloud_folders (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  parent_scope CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000')) STORED,
  name VARCHAR(80) NOT NULL,
  tags JSON NOT NULL DEFAULT (JSON_ARRAY()),
  deleted_at DATETIME(3) NULL,
  is_pinned TINYINT(1) NOT NULL DEFAULT 0,
  pin_order INT UNSIGNED NOT NULL DEFAULT 0,
  active_name VARCHAR(80) GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN name ELSE NULL END) STORED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY cloud_folders_owner_parent_name_uq (owner_id, parent_scope, active_name),
  KEY cloud_folders_parent_idx (owner_id, parent_id, name),
  KEY cloud_folders_pinned_idx (owner_id, is_pinned, pin_order),
  KEY cloud_folders_trash_idx (owner_id, deleted_at, updated_at),
  CONSTRAINT cloud_folders_owner_fk
    FOREIGN KEY (owner_id) REFERENCES cloud_users (id) ON DELETE CASCADE,
  CONSTRAINT cloud_folders_parent_fk
    FOREIGN KEY (parent_id) REFERENCES cloud_folders (id),
  CONSTRAINT cloud_folders_name_length CHECK (CHAR_LENGTH(TRIM(name)) BETWEEN 1 AND 80)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cloud_files (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  folder_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  folder_scope CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (COALESCE(folder_id, '00000000-0000-0000-0000-000000000000')) STORED,
  name VARCHAR(180) NOT NULL,
  mime_type VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
  size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  tags JSON NOT NULL DEFAULT (JSON_ARRAY()),
  deleted_at DATETIME(3) NULL,
  active_name VARCHAR(180) GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN name ELSE NULL END) STORED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY cloud_files_owner_folder_name_uq (owner_id, folder_scope, active_name),
  KEY cloud_files_folder_idx (owner_id, folder_id, name),
  KEY cloud_files_trash_idx (owner_id, deleted_at, updated_at),
  CONSTRAINT cloud_files_owner_fk
    FOREIGN KEY (owner_id) REFERENCES cloud_users (id) ON DELETE CASCADE,
  CONSTRAINT cloud_files_folder_fk
    FOREIGN KEY (folder_id) REFERENCES cloud_folders (id),
  CONSTRAINT cloud_files_name_length CHECK (CHAR_LENGTH(TRIM(name)) BETWEEN 1 AND 180)
) ENGINE=InnoDB;

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
