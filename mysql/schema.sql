CREATE DATABASE IF NOT EXISTS personal_cloud
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE personal_cloud;

CREATE TABLE IF NOT EXISTS cloud_users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  email VARCHAR(320) NOT NULL,
  password_hash VARCHAR(180) CHARACTER SET ascii NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY cloud_users_email_uq (email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cloud_folders (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  parent_scope CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000')) STORED,
  name VARCHAR(80) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY cloud_folders_owner_parent_name_uq (owner_id, parent_scope, name),
  KEY cloud_folders_parent_idx (owner_id, parent_id, name),
  CONSTRAINT cloud_folders_owner_fk
    FOREIGN KEY (owner_id) REFERENCES cloud_users (id) ON DELETE CASCADE,
  CONSTRAINT cloud_folders_parent_fk
    FOREIGN KEY (parent_id) REFERENCES cloud_folders (id) ON DELETE CASCADE,
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
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY cloud_files_owner_folder_name_uq (owner_id, folder_scope, name),
  KEY cloud_files_folder_idx (owner_id, folder_id, name),
  CONSTRAINT cloud_files_owner_fk
    FOREIGN KEY (owner_id) REFERENCES cloud_users (id) ON DELETE CASCADE,
  CONSTRAINT cloud_files_folder_fk
    FOREIGN KEY (folder_id) REFERENCES cloud_folders (id) ON DELETE SET NULL,
  CONSTRAINT cloud_files_name_length CHECK (CHAR_LENGTH(TRIM(name)) BETWEEN 1 AND 180)
) ENGINE=InnoDB;
